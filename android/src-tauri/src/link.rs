//! The link with the computer: the router, the bridge channel on it, and the
//! exchange of what each side wrote.
//!
//! The phone keeps the archive whole (archive.rs): what is done here is
//! written here at once, whether the computer is there or not. The link
//! carries the rows that came out of it to the computer, and the computer's
//! here: one request (`sync`) takes this phone's rows and how far it has
//! received, and brings back the computer's; what the computer writes
//! meanwhile arrives by itself, as the event `sync`. The first exchange,
//! asked from zero, is the first copy. Rules and conflicts: replica.js.
//!
//! The link is kept open for as long as the app is: when it falls, it is
//! opened again, and every time it opens the rows written meanwhile go.
//!
//! Three ways, the same channel on each (bridge-client): I2P, always; when
//! the computer allows it and the two are on the same local network, a
//! connection straight to the computer's private address; and, when the
//! computer allows it and the networks in between let it open, a way
//! straight across the internet (IPv6, or through the routers of IPv4). A
//! faster way carries everything while it lasts. Where the computer was on
//! the local network is kept, so that it is found there the next time even
//! with I2P down.
//!
//! What only the computer has (the containers and files of the chats, the
//! Code projects) is asked of it (proxy.rs). A request costs a second or two
//! on I2P, whatever its size, so those readings are answered from the
//! phone's copy at once and brought up to date with one request for all of
//! them (`snapshot`): the tags of the copies go, only what differs comes
//! back, and the page is told which things to show again (`refreshed`).

use crate::archive::Archive;
use crate::router;
use crate::store::{Kept, Store};
use crate::vault;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use bridge_client::{ConnState, Error as BridgeError, Identity, Phone, PhoneConfig, Sam, Via};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// The computer, as the archive names the device it exchanges rows with.
const PEER: &str = "computer";

/// A request that did not go: its code and words, as the page reads them (remote.js).
#[derive(Debug, Clone, serde::Serialize)]
pub struct Refusal {
    pub code: String,
    pub message: String,
}

impl Refusal {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Refusal { code: code.into(), message: message.into() }
    }
    fn offline() -> Self {
        Refusal::new("offline", "Il computer non è raggiungibile.")
    }
    /// Whether the request did not reach the computer.
    pub fn unreached(&self) -> bool {
        matches!(self.code.as_str(), "offline" | "closed" | "timeout" | "unreachable" | "router")
    }
}

impl From<BridgeError> for Refusal {
    fn from(error: BridgeError) -> Self {
        match error {
            BridgeError::Remote { code, message } => Refusal { code, message },
            BridgeError::NotConnected | BridgeError::NotPaired => Refusal::offline(),
            BridgeError::Closed => Refusal::new("closed", "Il collegamento con il computer si è chiuso."),
            BridgeError::Timeout(what) => Refusal::new("timeout", format!("Il computer non ha risposto in tempo ({what}).")),
            BridgeError::Unreachable(what) => Refusal::new("unreachable", format!("Il computer non è raggiungibile: {what}")),
            BridgeError::Router(what) => Refusal::new("router", format!("Router I2P: {what}")),
            BridgeError::Code(what) => Refusal::new("bad_code", format!("Codice di accoppiamento non valido: {what}")),
            BridgeError::Channel(what) => Refusal::new("channel", format!("Il canale cifrato non è valido: {what}")),
            BridgeError::Io(error) => Refusal::new("io", error.to_string()),
        }
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub paired: bool,
    pub device_id: String,
    pub desktop: String,
    pub state: ConnState,
    /// Which way the link goes now: the local network, or I2P.
    pub via: Via,
    /// Rows written here that the computer does not have yet.
    pub queued: usize,
    pub error: String,
}

pub struct Link {
    app: AppHandle,
    pub store: Arc<Store>,
    pub archive: Arc<Archive>,
    data_dir: PathBuf,
    phone: Mutex<Option<Phone<Sam>>>,
    /// The pairing, once read: it is kept sealed (vault.rs), and asked for at every request.
    identity: Mutex<Option<Option<Identity>>>,
    error: Mutex<String>,
    wake: tokio::sync::Notify,
    /// The exchange of rows with the computer, one at a time.
    syncing: tokio::sync::Mutex<()>,
    sync_asked: AtomicBool,
    queued: AtomicUsize,
    /// The copies known to be as the computer has them, since the link last opened.
    fresh: Mutex<HashSet<String>>,
    refreshing: tokio::sync::Mutex<()>,
    refresh_asked: AtomicBool,
}

/// How many copies one snapshot asks about (the computer answers 120 at most).
const SNAPSHOT_MOST: usize = 120;

fn packed(value: &Value) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let _ = encoder.write_all(value.to_string().as_bytes());
    encoder.finish().unwrap_or_default()
}

fn unpacked(bytes: &[u8]) -> Option<Value> {
    let mut text = String::new();
    flate2::read::GzDecoder::new(bytes).read_to_string(&mut text).ok()?;
    serde_json::from_str(&text).ok()
}

impl Link {
    pub fn new(app: AppHandle, store: Arc<Store>, archive: Arc<Archive>, data_dir: PathBuf) -> Arc<Self> {
        Arc::new(Link {
            app,
            store,
            archive,
            data_dir,
            phone: Mutex::new(None),
            identity: Mutex::new(None),
            error: Mutex::new(String::new()),
            wake: tokio::sync::Notify::new(),
            syncing: tokio::sync::Mutex::new(()),
            sync_asked: AtomicBool::new(false),
            queued: AtomicUsize::new(0),
            fresh: Mutex::new(HashSet::new()),
            refreshing: tokio::sync::Mutex::new(()),
            refresh_asked: AtomicBool::new(false),
        })
    }

    /// Who this phone is for the computer it is paired with. A pairing that cannot be opened (sealed by
    /// another phone: the app's files were copied here) is no pairing.
    pub fn identity(&self) -> Option<Identity> {
        let mut known = self.identity.lock().unwrap();
        if let Some(identity) = known.as_ref() {
            return identity.clone();
        }
        let found = self.store.get("identity").and_then(|kept| {
            let plain = vault::open(&kept)?;
            let identity: Identity = serde_json::from_str(&plain).ok()?;
            // Kept before the pairing was sealed: sealed now.
            if !vault::sealed(&kept) {
                self.store.set("identity", Some(&vault::seal(&plain)));
            }
            Some(identity)
        });
        *known = Some(found.clone());
        found
    }

    pub fn paired(&self) -> bool {
        self.identity().is_some()
    }

    fn phone(&self) -> Option<Phone<Sam>> {
        self.phone.lock().unwrap().clone()
    }

    pub fn info(&self) -> Info {
        let identity = self.identity();
        let state = self.phone().map(|p| *p.state().borrow()).unwrap_or(ConnState::Offline);
        let via = self.phone().map(|p| *p.via().borrow()).unwrap_or(Via::None);
        Info {
            paired: identity.is_some(),
            device_id: identity.and_then(|i| i.device_id).unwrap_or_default(),
            desktop: self.store.get("desktop_name").unwrap_or_default(),
            state,
            via,
            queued: self.queued.load(Ordering::SeqCst),
            error: self.error.lock().unwrap().clone(),
        }
    }

    fn tell_state(&self) {
        let _ = self.app.emit("remote-state", self.info());
    }

    fn fail(&self, message: String) {
        *self.error.lock().unwrap() = message;
        self.tell_state();
    }

    /// The router, then the phone on it: made once, kept for the life of the app.
    async fn ready(self: &Arc<Self>) -> Result<Phone<Sam>, Refusal> {
        if let Some(phone) = self.phone() {
            return Ok(phone);
        }
        let store = self.store.clone();
        let dir = self.data_dir.clone();
        let (host, port) = tokio::task::spawn_blocking(move || router::start(&store, &dir))
            .await
            .map_err(|e| Refusal::new("router", e.to_string()))?
            .map_err(|message| Refusal::new("router", message))?;
        let phone = Phone::new(Sam::tcp(host, port), self.identity(), PhoneConfig::default());
        // Where the computer was on the local network the last time: tried there too, from now on.
        if let Some(known) = self.store.get("lan_known").and_then(|text| serde_json::from_str::<Vec<(String, u16)>>(&text).ok()) {
            phone.set_lan(known);
        }
        *self.phone.lock().unwrap() = Some(phone.clone());
        self.follow(&phone);
        if self.identity().is_some() {
            phone.watch_lan();
        }
        Ok(phone)
    }

    /// What the phone hears goes to the page; its state too.
    fn follow(self: &Arc<Self>, phone: &Phone<Sam>) {
        let mut events = phone.events();
        let link = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(event) => link.heard(event.name, event.data, event.body),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        // Events were lost: the rows among them are asked for again.
                        link.sync_soon();
                    }
                    Err(_) => break,
                }
            }
        });
        let mut via = phone.via();
        let link = self.clone();
        tauri::async_runtime::spawn(async move {
            while via.changed().await.is_ok() {
                link.tell_state();
            }
        });
        let mut state = phone.state();
        let link = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let now = *state.borrow_and_update();
                link.tell_state();
                if now == ConnState::Online {
                    // What happened while away is not known: no copy is taken as good.
                    link.fresh.lock().unwrap().clear();
                    let link = link.clone();
                    tauri::async_runtime::spawn(async move {
                        link.sync().await;
                        link.refresh().await;
                    });
                }
                if state.changed().await.is_err() {
                    break;
                }
            }
        });
    }

    fn heard(self: &Arc<Self>, name: String, data: Value, body: Vec<u8>) {
        if name == "welcome" {
            if let Some(desktop) = data.pointer("/desktop/name").and_then(Value::as_str) {
                self.store.set("desktop_name", Some(desktop));
            }
        }
        // Where the computer is on the local network, as it just said: kept for the next time.
        if name == "lan.known" {
            let list: Vec<(String, u16)> = data
                .get("addresses")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|item| Some((item.get("host")?.as_str()?.to_string(), u16::try_from(item.get("port")?.as_u64()?).ok()?)))
                .collect();
            self.store.set("lan_known", if list.is_empty() { None } else { serde_json::to_string(&list).ok() }.as_deref());
            return;
        }
        // Rows the computer wrote: written here as they are, then shown.
        if name == "sync" {
            let link = self.clone();
            tauri::async_runtime::spawn(async move {
                let mut answer = data;
                answer["rows"] = unpacked(&body).and_then(|value| value.get("rows").cloned()).unwrap_or_else(|| json!([]));
                let _one = link.syncing.lock().await;
                let took = link.archive.answered(PEER, answer).await;
                drop(_one);
                match took {
                    Ok(took) => {
                        link.tell_rows(&took);
                        // Rows before these never arrived, or the computer's archive is another one: asked from where this phone is.
                        if took.get("gap").and_then(Value::as_bool) == Some(true) || took.get("reset").and_then(Value::as_bool) == Some(true) {
                            link.sync_soon();
                        }
                    }
                    Err(failure) => eprintln!("[link] sync: {}", failure.message),
                }
            });
            return;
        }
        let body = if body.is_empty() { Value::Null } else { Value::String(B64.encode(&body)) };
        let _ = self.app.emit("remote-event", json!({ "name": name, "data": data, "body": body }));
    }

    /// What the computer's rows changed here, for the page to show again (resources/js/sync.js).
    fn tell_rows(&self, took: &Value) {
        let changes = took.get("changes").cloned().unwrap_or_else(|| json!([]));
        if changes.as_array().is_some_and(|list| !list.is_empty()) {
            let _ = self.app.emit("remote-event", json!({ "name": "rows", "data": { "changes": changes }, "body": Value::Null }));
        }
    }

    /// Keeps the link open: tries until it opens, then the phone keeps it and opens it again when it falls.
    pub fn keep(self: &Arc<Self>) {
        let link = self.clone();
        tauri::async_runtime::spawn(async move {
            let waits = [5u64, 10, 20, 40, 60];
            let mut attempt = 0usize;
            // The user asked to try now: the I2P channel is opened again even if an attempt of its own is under way.
            let mut asked = false;
            loop {
                if link.identity().is_none() {
                    // Not paired: the router is started anyway, so that it has found the network
                    // by the time the user has the computer's code in front of the camera (it lasts 3 minutes).
                    if let Err(refusal) = link.ready().await {
                        link.fail(refusal.message);
                    }
                    link.wake.notified().await;
                    continue;
                }
                match link.ready().await {
                    Ok(phone) => {
                        phone.watch_lan();
                        // The I2P channel open, or being opened again by the phone itself after a fall: left to it.
                        // (The local network's channel, when there is one, does not stand in for it.)
                        if phone.network_up() || (phone.network_kept() && !asked) {
                            attempt = 0;
                            asked = link.wake_after(Duration::from_secs(30)).await;
                            // At its own pace, whatever was missed: the two archives are brought in line again.
                            if link.online() {
                                link.sync().await;
                            }
                            continue;
                        }
                        match phone.connect().await {
                            Ok(_) => {
                                attempt = 0;
                                link.error.lock().unwrap().clear();
                                link.tell_state();
                            }
                            Err(error) => link.fail(Refusal::from(error).message),
                        }
                    }
                    Err(refusal) => link.fail(refusal.message),
                }
                let wait = waits[attempt.min(waits.len() - 1)];
                attempt += 1;
                asked = link.wake_after(Duration::from_secs(wait)).await;
            }
        });
    }

    /// Waits, or less if woken: says whether it was woken.
    async fn wake_after(&self, wait: Duration) -> bool {
        tokio::time::timeout(wait, self.wake.notified()).await.is_ok()
    }

    /// Tried again now (the user asked, or the phone found its network again).
    pub fn retry(&self) {
        self.wake.notify_waiters();
    }

    /// Pairs with the computer that shows `code`. What is in this phone's archive stays, and
    /// becomes one with the computer's at the first exchange.
    pub async fn pair(self: &Arc<Self>, code: &str, name: &str) -> Result<Info, Refusal> {
        let phone = self.ready().await?;
        let identity = phone.pair(code, name).await?;
        let text = serde_json::to_string(&identity).map_err(|e| Refusal::new("failed", e.to_string()))?;
        self.store.forget_copies();
        self.store.set("identity", Some(&vault::seal(&text)));
        *self.identity.lock().unwrap() = Some(Some(identity.clone()));
        if let Some(welcome) = phone.welcome() {
            self.store.set("desktop_name", Some(&welcome.desktop.name));
        }
        self.retry();
        self.tell_state();
        Ok(self.info())
    }

    /// Unpaired: the archive stays on the phone, which goes on by itself; the computer's copies and the pairing go.
    pub async fn forget(&self) {
        if let Some(phone) = self.phone() {
            phone.close().await;
        }
        *self.phone.lock().unwrap() = None;
        self.store.forget_all();
        *self.identity.lock().unwrap() = Some(None);
        self.archive.forget(PEER).await;
        self.queued.store(0, Ordering::SeqCst);
        self.tell_state();
    }

    /// A request to the computer: its page, or its service (`api`, `sync`, `snapshot`).
    pub async fn call(&self, method: &str, params: Value, body: Option<Vec<u8>>) -> Result<(Value, Vec<u8>), Refusal> {
        let phone = self.phone().ok_or_else(Refusal::offline)?;
        if *phone.state().borrow() != ConnState::Online {
            return Err(Refusal::offline());
        }
        let timeout = if method == "api" { Duration::from_secs(600) } else { Duration::from_secs(120) };
        Ok(phone.call_with_timeout(method, params, body, timeout).await?)
    }

    pub fn online(&self) -> bool {
        self.phone().map(|p| *p.state().borrow() == ConnState::Online).unwrap_or(false)
    }

    /* ---------------------------------------------------------------- */
    /* The rows                                                           */
    /* ---------------------------------------------------------------- */

    /// Something was written here: it goes to the computer in a moment, with whatever else is written meanwhile.
    pub fn sync_soon(self: &Arc<Self>) {
        if !self.paired() || self.sync_asked.swap(true, Ordering::SeqCst) {
            return;
        }
        let link = self.clone();
        // On I2P what is written in the next moment goes in the same request; on the local network a request costs nothing.
        let local = self.phone().is_some_and(|phone| matches!(*phone.via().borrow(), Via::Lan));
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(if local { 15 } else { 120 })).await;
            link.sync_asked.store(false, Ordering::SeqCst);
            link.sync().await;
        });
    }

    async fn count_waiting(&self) {
        let rows = if self.paired() { self.archive.waiting(PEER).await } else { 0 };
        if self.queued.swap(rows, Ordering::SeqCst) != rows {
            self.tell_state();
        }
    }

    /// The exchange with the computer, until neither side has more: this phone's rows go, the computer's come.
    pub async fn sync(&self) {
        if !self.paired() {
            return;
        }
        let _one = self.syncing.lock().await;
        for _ in 0..500 {
            if !self.online() {
                break;
            }
            let Ok(mut head) = self.archive.offer(PEER).await else { break };
            let rows = head.as_object_mut().and_then(|offer| offer.remove("rows")).unwrap_or_else(|| json!([]));
            let sending = head.get("more").and_then(Value::as_bool) == Some(true);
            let body = packed(&json!({ "rows": rows }));
            let Ok((mut answer, bytes)) = self.call("sync", head, Some(body)).await else { break };
            answer["rows"] = unpacked(&bytes).and_then(|value| value.get("rows").cloned()).unwrap_or_else(|| json!([]));
            let Ok(took) = self.archive.answered(PEER, answer).await else { break };
            self.tell_rows(&took);
            let again = |key: &str| took.get(key).and_then(Value::as_bool) == Some(true);
            if !sending && !again("more") && !again("reset") && !again("gap") && self.archive.waiting(PEER).await == 0 {
                break;
            }
        }
        drop(_one);
        self.count_waiting().await;
    }

    /// What this phone wrote reaches the computer before something is asked of it that needs it there
    /// (a message, before the turn that answers it).
    pub async fn flush(&self) {
        if self.paired() && self.online() && self.archive.waiting(PEER).await > 0 {
            self.sync().await;
        }
    }

    /// After a write of the page: counted as waiting, and sent.
    pub fn written(self: &Arc<Self>) {
        if !self.paired() {
            return;
        }
        let link = self.clone();
        tauri::async_runtime::spawn(async move { link.count_waiting().await });
        self.sync_soon();
    }

    /* ---------------------------------------------------------------- */
    /* The copies of what only the computer has                           */
    /* ---------------------------------------------------------------- */

    pub fn is_fresh(&self, key: &str) -> bool {
        self.fresh.lock().unwrap().contains(key)
    }

    pub fn mark_fresh(&self, key: &str) {
        self.fresh.lock().unwrap().insert(key.to_string());
    }

    /// The copies are checked in a moment, all in one request however many asked.
    pub fn refresh_soon(self: &Arc<Self>) {
        if self.refresh_asked.swap(true, Ordering::SeqCst) {
            return;
        }
        let link = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            link.refresh_asked.store(false, Ordering::SeqCst);
            link.refresh().await;
        });
    }

    /// One request for every copy not known to be good: their tags go, what
    /// differs comes back and replaces them, and the page is told what to show again.
    pub async fn refresh(&self) {
        let _one = self.refreshing.lock().await;
        let asked: Vec<(String, Option<String>)> = self.store.tags(SNAPSHOT_MOST).into_iter().filter(|(key, _)| !self.is_fresh(key)).collect();
        if asked.is_empty() {
            return;
        }
        let items: Vec<Value> = asked.iter().map(|(path, tag)| json!({ "path": path, "tag": tag })).collect();
        let Ok((_, bytes)) = self.call("snapshot", json!({ "items": items }), None).await else { return };
        let Some(answer) = unpacked(&bytes) else { return };
        let mut changed = Vec::new();
        for item in answer.get("items").and_then(Value::as_array).into_iter().flatten() {
            let Some(path) = item.get("path").and_then(Value::as_str) else { continue };
            if item.get("same").and_then(Value::as_bool) == Some(true) {
                self.mark_fresh(path);
            } else if let Some(data) = item.get("data") {
                let content_type = item.get("type").and_then(Value::as_str).unwrap_or("application/json; charset=utf-8").to_string();
                let tag = item.get("tag").and_then(Value::as_str).map(str::to_string);
                self.store.keep(path, &Kept { status: 200, content_type, body: serde_json::to_vec(data).unwrap_or_default(), tag });
                self.mark_fresh(path);
                changed.push(path.to_string());
            } else if item.get("status").and_then(Value::as_u64) == Some(404) {
                // Gone from the computer: the copy goes too.
                self.store.forget(path);
                changed.push(path.to_string());
            }
        }
        if !changed.is_empty() {
            let _ = self.app.emit("remote-event", json!({ "name": "refreshed", "data": { "paths": changed }, "body": Value::Null }));
        }
    }
}
