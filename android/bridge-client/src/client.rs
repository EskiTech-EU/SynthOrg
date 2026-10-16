//! The phone: pairs with a desktop, keeps a channel to it open, asks it things
//! and hears its events. Follows `Phone` in `computer/scripts/bridge-phone.js`,
//! plus what an app needs on top: keepalive pings, reconnection, a
//! connection state to show.
//!
//! The network is behind [`Network`]: [`crate::sam::Sam`] on the phone, a
//! plain TCP socket in the tests.
//!
//! Which way to the desktop. The channel over the network (I2P) is how the
//! phone finds the desktop across the internet, and the only way there: no
//! server of anyone's in between, no way opened through the routers. One
//! faster way is tried beside it, only if the desktop allows it (its `lan`
//! setting, off unless the user turns it on), a second channel with the same
//! handshake and the same keys: on the same local network, a connection
//! straight to the desktop's private address. The address is asked of the
//! desktop over the channel the phone has (`lan.offer`) and kept: the next
//! time the phone is on that network it finds the desktop there even with
//! I2P down. Requests go the faster way while it lasts; the I2P channel
//! stays as the one to fall back to.

use crate::code;
use crate::error::{Error, Result};
use crate::noise::{Keypair, Kind};
use crate::wire::{self, ChannelReader, ChannelWriter};
use data_encoding::HEXLOWER;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{broadcast, oneshot, watch};
use tokio::task::JoinHandle;

/* ------------------------------------------------------------------ */
/* The network                                                          */
/* ------------------------------------------------------------------ */

/// Where the phone's streams come from.
pub trait Network: Send + Sync + 'static {
    type Session: NetSession;
    /// A new place on the network, able to read the desktop's hidden address
    /// with `reader_key`. On I2P: a fresh destination and a session on it.
    fn session(&self, reader_key: [u8; 32]) -> impl Future<Output = Result<Self::Session>> + Send;
}

/// A stream the channel runs on: from the network, or the local one.
pub trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}
type Pipe = Box<dyn Io>;

pub trait NetSession: Send + Sync + 'static {
    type Stream: AsyncRead + AsyncWrite + Unpin + Send + 'static;
    /// A stream to `address`. `Error::Unreachable` is retried by the caller.
    fn connect(&self, address: &str) -> impl Future<Output = Result<Self::Stream>> + Send;
    /// The session ended on its own (the router closed it).
    fn is_closed(&self) -> bool;
}

/* ------------------------------------------------------------------ */
/* What the app keeps and sees                                          */
/* ------------------------------------------------------------------ */

/// What the phone keeps between one use and the next. The same JSON as the
/// Node reference client's `identity.json` (hex keys, camelCase), so the two
/// can share one. It holds private keys: store it encrypted.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    /// The phone's static X25519 private key, hex.
    pub static_key: String,
    /// The X25519 private key the desktop's leaseset is read with, hex.
    pub reader_key: String,
    pub desktop: PairedDesktop,
    /// The id the desktop gave this phone (from `welcome`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDesktop {
    /// `<56 chars>.b32.i2p`
    pub address: String,
    /// The desktop's static X25519 public key, hex.
    pub public_key: String,
}

impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Identity")
            .field("desktop", &self.desktop)
            .field("device_id", &self.device_id)
            .finish_non_exhaustive()
    }
}

impl Identity {
    fn static_keypair(&self) -> Result<Keypair> {
        Ok(Keypair::from_private(hex32(&self.static_key)?))
    }
    fn reader(&self) -> Result<[u8; 32]> {
        hex32(&self.reader_key)
    }
    fn desktop_key(&self) -> Result<[u8; 32]> {
        hex32(&self.desktop.public_key)
    }
}

fn hex32(text: &str) -> Result<[u8; 32]> {
    HEXLOWER
        .decode(text.to_ascii_lowercase().as_bytes())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| Error::Code("bad key in identity".into()))
}

/// The first message after the handshake.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Welcome {
    pub protocol: u32,
    /// True on the channel opened by the pairing itself.
    pub paired: bool,
    pub device: WelcomeDevice,
    pub desktop: WelcomeDesktop,
    /// Whether the desktop's page is there to answer requests (all but `ping`).
    pub page: bool,
    pub keepalive_ms: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WelcomeDevice {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WelcomeDesktop {
    pub name: String,
    pub version: String,
}

/// An event from the desktop (`{"t":"evt","name":...,"data":...}`) and its body bytes.
/// `welcome` is delivered here too, at every (re)connection.
#[derive(Clone, Debug)]
pub struct Event {
    pub name: String,
    pub data: Value,
    pub body: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnState {
    Offline,
    Connecting,
    Online,
}

/// Which way the requests go now.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Via {
    None,
    I2p,
    /// The local network both are on.
    Lan,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Pick {
    Best,
    Network,
    Lan,
}

#[derive(Clone, Debug)]
pub struct PhoneConfig {
    /// Sent to the desktop in the third handshake message.
    pub platform: String,
    /// STREAM CONNECT tries while the address is looked up (CANT_REACH_PEER).
    pub tries: u32,
    /// The same, while pairing: enough to cover the code's three minutes.
    pub pairing_tries: u32,
    pub retry: Duration,
    /// Time for handshake plus `welcome` on one stream, and how many streams.
    pub handshake_timeout: Duration,
    pub handshake_attempts: u32,
    pub call_timeout: Duration,
    /// Used when `welcome` gives no keepaliveMs.
    pub keepalive: Duration,
    /// Waits before reconnection attempts; the last repeats.
    pub reconnect: Vec<Duration>,
    /// Events buffered for a slow receiver before the oldest are dropped.
    pub event_capacity: usize,
    /// Whether to look for the desktop on the local network at all.
    pub lan: bool,
    /// Time for a connection on the local network to open, and for the handshake on it.
    pub lan_timeout: Duration,
    /// A ping on the local channel this often: a phone that left the network notices within two of them.
    pub lan_keepalive: Duration,
    /// Waits between attempts on the local network that failed; the last repeats.
    pub lan_retry: Vec<Duration>,
}

impl Default for PhoneConfig {
    fn default() -> Self {
        // The numbers of scripts/bridge-phone.js and docs/ponte-telefono.md.
        PhoneConfig {
            platform: "android".into(),
            tries: 6,
            pairing_tries: 40,
            retry: Duration::from_secs(4),
            handshake_timeout: Duration::from_secs(40),
            handshake_attempts: 3,
            call_timeout: Duration::from_secs(120),
            keepalive: Duration::from_secs(45),
            reconnect: vec![Duration::from_secs(1), Duration::from_secs(5), Duration::from_secs(15), Duration::from_secs(30), Duration::from_secs(60)],
            event_capacity: 1024,
            lan: true,
            lan_timeout: Duration::from_secs(3),
            lan_keepalive: Duration::from_secs(8),
            lan_retry: vec![Duration::from_secs(5), Duration::from_secs(15), Duration::from_secs(30), Duration::from_secs(60)],
        }
    }
}

/* ------------------------------------------------------------------ */
/* The phone                                                            */
/* ------------------------------------------------------------------ */

type Writer = Arc<tokio::sync::Mutex<ChannelWriter<Pipe>>>;
type Answer = Result<(Value, Vec<u8>)>;

struct Inner<N: Network> {
    network: N,
    config: PhoneConfig,
    identity: Mutex<Option<Identity>>,
    session: tokio::sync::Mutex<Option<Arc<N::Session>>>,
    writer: Mutex<Option<Writer>>,
    /// The channel on the local network, while there is one.
    lan: Mutex<Option<Writer>>,
    /// Where the desktop was on the local network the last time it said: `(host, port)`.
    lan_known: Mutex<Vec<(String, u16)>>,
    /// Each call waiting, and whether it went the local way.
    pending: Mutex<HashMap<u64, (oneshot::Sender<Answer>, bool)>>,
    next_id: AtomicU64,
    events: broadcast::Sender<Event>,
    state: watch::Sender<ConnState>,
    via: watch::Sender<Via>,
    welcome: Mutex<Option<Welcome>>,
    last_error: Mutex<Option<String>>,
    supervisor: Mutex<Option<JoinHandle<()>>>,
    lan_task: Mutex<Option<JoinHandle<()>>>,
    /// The desktop allows the local way again: tried now, not at the next wait's end.
    lan_wake: tokio::sync::Notify,
}

/// The phone's side of the bridge. Cheap to clone; clones share one connection.
pub struct Phone<N: Network> {
    inner: Arc<Inner<N>>,
}

impl<N: Network> Clone for Phone<N> {
    fn clone(&self) -> Self {
        Phone { inner: self.inner.clone() }
    }
}

#[derive(Serialize)]
struct Request<'a> {
    t: &'static str,
    id: u64,
    method: &'a str,
    params: &'a Value,
}

#[derive(Serialize)]
struct Hello<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
    platform: &'a str,
}

impl<N: Network> Phone<N> {
    /// `identity` is what was kept from an earlier pairing, if any.
    pub fn new(network: N, identity: Option<Identity>, config: PhoneConfig) -> Self {
        let (events, _) = broadcast::channel(config.event_capacity.max(1));
        let (state, _) = watch::channel(ConnState::Offline);
        let (via, _) = watch::channel(Via::None);
        Phone {
            inner: Arc::new(Inner {
                network,
                config,
                identity: Mutex::new(identity),
                session: tokio::sync::Mutex::new(None),
                writer: Mutex::new(None),
                lan: Mutex::new(None),
                lan_known: Mutex::new(Vec::new()),
                pending: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
                events,
                state,
                via,
                welcome: Mutex::new(None),
                last_error: Mutex::new(None),
                supervisor: Mutex::new(None),
                lan_task: Mutex::new(None),
                lan_wake: tokio::sync::Notify::new(),
            }),
        }
    }

    pub fn identity(&self) -> Option<Identity> {
        self.inner.identity.lock().unwrap().clone()
    }

    /// The last `welcome`: desktop name, whether its page answers, the device id.
    pub fn welcome(&self) -> Option<Welcome> {
        self.inner.welcome.lock().unwrap().clone()
    }

    /// Why the last connection attempt or connection ended.
    pub fn last_error(&self) -> Option<String> {
        self.inner.last_error.lock().unwrap().clone()
    }

    /// Events from the desktop, from now on.
    pub fn events(&self) -> broadcast::Receiver<Event> {
        self.inner.events.subscribe()
    }

    /// Offline / connecting / online, as it changes.
    pub fn state(&self) -> watch::Receiver<ConnState> {
        self.inner.state.subscribe()
    }

    /// The way requests go now (the local network or I2P), as it changes.
    pub fn via(&self) -> watch::Receiver<Via> {
        self.inner.via.subscribe()
    }

    /// Whether the channel over the network (I2P) is open: the one to fall back to.
    pub fn network_up(&self) -> bool {
        self.inner.writer.lock().unwrap().is_some()
    }

    /// Whether the network channel is being looked after: open, or being opened again after a fall.
    pub fn network_kept(&self) -> bool {
        self.inner.supervisor.lock().unwrap().as_ref().is_some_and(|task| !task.is_finished())
    }

    /// Where the desktop was on the local network, as kept from an earlier use.
    pub fn set_lan(&self, addresses: Vec<(String, u16)>) {
        *self.inner.lan_known.lock().unwrap() = addresses;
    }

    /// Starts looking for the desktop on the local network (once: more calls do nothing).
    /// Must be called within a Tokio runtime.
    pub fn watch_lan(&self) {
        self.inner.clone().ensure_lan();
    }

    /// Pairs with the desktop that showed `code`. On success the phone stays
    /// connected (the pairing channel is a session) and the returned identity
    /// is the one to keep.
    pub async fn pair(&self, code: &str, name: &str) -> Result<Identity> {
        let code = code::parse(code)?;
        let mut identity = Identity {
            static_key: HEXLOWER.encode(&Keypair::generate().private),
            reader_key: HEXLOWER.encode(&code.reader_key),
            desktop: PairedDesktop { address: code.address.clone(), public_key: HEXLOWER.encode(&code.public_key) },
            device_id: None,
        };
        self.close().await;
        let hello = serde_json::to_vec(&Hello { name: Some(name), platform: &self.inner.config.platform }).expect("plain JSON");
        let (reader, writer, welcome) = self.inner.clone().open(&identity, Kind::Pairing, Some(code.secret), &hello).await?;
        identity.device_id = Some(welcome.device.id.clone());
        *self.inner.identity.lock().unwrap() = Some(identity.clone());
        // Another desktop: where the one of before was on the local network is of no use.
        self.inner.lan_known.lock().unwrap().clear();
        self.inner.clone().start(reader, writer, welcome);
        Ok(identity)
    }

    /// Opens a session with the paired desktop, with all the retries, and
    /// keeps it open (pings, reconnection) until [`Phone::close`].
    pub async fn connect(&self) -> Result<Welcome> {
        if self.network_up()
            && let Some(welcome) = self.welcome() {
                return Ok(welcome);
            }
        let identity = self.identity().ok_or(Error::NotPaired)?;
        self.inner.stop_supervisor();
        self.inner.clone().ensure_lan();
        let hello = serde_json::to_vec(&Hello { name: None, platform: &self.inner.config.platform }).expect("plain JSON");
        let (reader, writer, welcome) = self.inner.clone().open(&identity, Kind::Session, None, &hello).await?;
        self.inner.clone().start(reader, writer, welcome.clone());
        Ok(welcome)
    }

    /// Asks the desktop for something: resolves with its `result` and body bytes.
    pub async fn call(&self, method: &str, params: Value, body: Option<Vec<u8>>) -> Result<(Value, Vec<u8>)> {
        self.inner.call(method, params, body.unwrap_or_default(), self.inner.config.call_timeout, Pick::Best).await
    }

    pub async fn call_with_timeout(&self, method: &str, params: Value, body: Option<Vec<u8>>, timeout: Duration) -> Result<(Value, Vec<u8>)> {
        self.inner.call(method, params, body.unwrap_or_default(), timeout, Pick::Best).await
    }

    /// Closes the channel and the network session; no reconnection.
    pub async fn close(&self) {
        self.inner.stop_supervisor();
        self.inner.stop_lan();
        self.inner.drop_lan();
        self.inner.drop_link();
        *self.inner.session.lock().await = None;
        self.inner.state.send_replace(ConnState::Offline);
    }
}

impl<N: Network> Drop for Inner<N> {
    fn drop(&mut self) {
        if let Some(task) = self.supervisor.get_mut().unwrap().take() {
            task.abort();
        }
        if let Some(task) = self.lan_task.get_mut().unwrap().take() {
            task.abort();
        }
    }
}

impl<N: Network> Inner<N> {
    fn set_state(&self, state: ConnState) {
        self.state.send_if_modified(|s| std::mem::replace(s, state) != state);
    }

    fn stop_supervisor(&self) {
        if let Some(task) = self.supervisor.lock().unwrap().take() {
            task.abort();
        }
    }

    fn stop_lan(&self) {
        if let Some(task) = self.lan_task.lock().unwrap().take() {
            task.abort();
        }
    }

    /// The local network watched, from the first time it is asked.
    fn ensure_lan(self: Arc<Self>) {
        if !self.config.lan {
            return;
        }
        let mut slot = self.lan_task.lock().unwrap();
        if slot.as_ref().is_some_and(|task| !task.is_finished()) {
            return;
        }
        *slot = Some(tokio::spawn(self.clone().lan_loop()));
    }

    /// Online while either channel is open; the local one is preferred.
    fn update_via(&self) {
        let via = if self.lan.lock().unwrap().is_some() {
            Via::Lan
        } else if self.writer.lock().unwrap().is_some() {
            Via::I2p
        } else {
            Via::None
        };
        self.via.send_if_modified(|v| std::mem::replace(v, via) != via);
        if via != Via::None {
            self.set_state(ConnState::Online);
        }
    }

    /// The state the network channel's own attempts lead to, unless the local channel keeps the phone online.
    fn set_network_state(&self, state: ConnState) {
        if self.lan.lock().unwrap().is_none() {
            self.set_state(state);
        }
    }

    /// The place on the network this phone reads the desktop's address from:
    /// kept while it lives, made anew when it ended or was dropped.
    async fn online(&self, identity: &Identity) -> Result<Arc<N::Session>> {
        let mut slot = self.session.lock().await;
        if let Some(session) = slot.as_ref()
            && !session.is_closed() {
                return Ok(session.clone());
            }
        *slot = None;
        let session = Arc::new(self.network.session(identity.reader()?).await?);
        *slot = Some(session.clone());
        Ok(session)
    }

    /// Reaches the desktop and runs the handshake (Node: `Phone.open`).
    async fn open(
        self: Arc<Self>,
        identity: &Identity,
        kind: Kind,
        psk: Option<[u8; 32]>,
        hello: &[u8],
    ) -> Result<(ChannelReader<Pipe>, ChannelWriter<Pipe>, Welcome)> {
        self.set_network_state(ConnState::Connecting);
        let result = self.open_now(identity, kind, psk, hello).await;
        if let Err(error) = &result {
            *self.last_error.lock().unwrap() = Some(error.to_string());
            self.set_network_state(ConnState::Offline);
        }
        result
    }

    async fn open_now(
        &self,
        identity: &Identity,
        kind: Kind,
        psk: Option<[u8; 32]>,
        hello: &[u8],
    ) -> Result<(ChannelReader<Pipe>, ChannelWriter<Pipe>, Welcome)> {
        let c = &self.config;
        let session = self.online(identity).await?;
        let address = identity.desktop.address.as_str();
        // Just after the desktop's address changed its lookup may fail: tried again.
        // A pairing goes on for as long as its code lasts: a router just started
        // on the computer may take more than a minute to publish the address.
        let tries = if kind == Kind::Pairing { c.tries.max(c.pairing_tries) } else { c.tries };
        let mut attempt = 1;
        let mut stream: Pipe = loop {
            match session.connect(address).await {
                Ok(stream) => break Box::new(stream),
                Err(Error::Unreachable(_)) if attempt < tries => {
                    attempt += 1;
                    tokio::time::sleep(c.retry).await;
                }
                Err(error) => return Err(error),
            }
        };
        // The first words over a stream just opened may never arrive, above all
        // from a destination made a moment ago: the handshake gets a time, and
        // is tried again over a new stream. Node times the handshake alone and
        // waits for `welcome` without a limit; here the limit covers both, so a
        // welcome that never comes is retried too.
        let remote = identity.desktop_key()?;
        let mut attempt = 1;
        loop {
            let s = identity.static_keypair()?;
            let opened = tokio::time::timeout(c.handshake_timeout, async {
                let (mut reader, writer, _hash) = wire::initiate(stream, kind, s, remote, psk, hello).await?;
                let (header, body) = reader.receive().await?;
                Ok::<_, Error>((reader, writer, header, body))
            })
            .await
            .unwrap_or_else(|_| Err(Error::Timeout("handshake".into())));
            match opened {
                Ok((reader, writer, header, body)) => {
                    if header["name"] != "welcome" {
                        return Err(Error::Channel("the desktop did not answer as expected".into()));
                    }
                    let data = header.get("data").cloned().unwrap_or(Value::Null);
                    let welcome: Welcome = serde_json::from_value(data.clone()).map_err(|_| Error::Channel("bad welcome".into()))?;
                    if welcome.device.id.is_empty() {
                        return Err(Error::Channel("bad welcome".into()));
                    }
                    let _ = self.events.send(Event { name: "welcome".into(), data, body });
                    return Ok((reader, writer, welcome));
                }
                Err(error) => {
                    if error.is_channel() || attempt >= c.handshake_attempts || c.tries <= 1 {
                        return Err(error);
                    }
                    attempt += 1;
                    stream = Box::new(session.connect(address).await?);
                }
            }
        }
    }

    /// Puts an open channel to use and watches over it.
    fn start(self: Arc<Self>, reader: ChannelReader<Pipe>, writer: ChannelWriter<Pipe>, welcome: Welcome) {
        self.stop_supervisor();
        self.install(writer, &welcome);
        let task = tokio::spawn(self.clone().supervise(reader, welcome));
        *self.supervisor.lock().unwrap() = Some(task);
        self.clone().ensure_lan();
        // A channel to ask on: where the desktop is on the local network is asked now.
        self.lan_wake.notify_waiters();
    }

    fn install(&self, writer: ChannelWriter<Pipe>, welcome: &Welcome) {
        *self.writer.lock().unwrap() = Some(Arc::new(tokio::sync::Mutex::new(writer)));
        *self.welcome.lock().unwrap() = Some(welcome.clone());
        *self.last_error.lock().unwrap() = None;
        self.update_via();
    }

    /// The network channel is gone: calls waiting on it fail, the writer is closed.
    fn drop_link(&self) {
        if let Some(writer) = self.writer.lock().unwrap().take() {
            // The peer sees the end of the stream; done aside, a closing write must not block.
            if tokio::runtime::Handle::try_current().is_ok() {
                tokio::spawn(async move { writer.lock().await.shutdown().await });
            }
        }
        self.fail_pending(false);
        self.update_via();
    }

    /// The local channel is gone: the requests go back to the network channel.
    fn drop_lan(&self) {
        if let Some(writer) = self.lan.lock().unwrap().take()
            && tokio::runtime::Handle::try_current().is_ok() {
                tokio::spawn(async move { writer.lock().await.shutdown().await });
            }
        self.fail_pending(true);
        self.update_via();
        // Neither channel is left: offline, until the network one is opened again.
        if self.writer.lock().unwrap().is_none() && *self.state.borrow() == ConnState::Online {
            self.set_state(ConnState::Offline);
        }
    }

    /// Calls still waiting on one channel learn that it closed (why is in last_error).
    fn fail_pending(&self, on_lan: bool) {
        let gone: Vec<_> = {
            let mut pending = self.pending.lock().unwrap();
            let ids: Vec<u64> = pending.iter().filter(|(_, (_, d))| *d == on_lan).map(|(&id, _)| id).collect();
            ids.into_iter().filter_map(|id| pending.remove(&id)).map(|(tx, _)| tx).collect()
        };
        for tx in gone {
            let _ = tx.send(Err(Error::Closed));
        }
    }

    /// Serves the channel; when it drops, reconnects from a fresh network
    /// session, until closed or until the desktop proves false.
    async fn supervise(self: Arc<Self>, mut reader: ChannelReader<Pipe>, mut welcome: Welcome) {
        loop {
            let reason = self.serve(&mut reader, &welcome).await;
            *self.last_error.lock().unwrap() = Some(reason.to_string());
            self.drop_link();
            // Docs: after a drop the SAM session is made again before retrying.
            *self.session.lock().await = None;
            // The local channel, if open, goes on meanwhile.
            self.set_network_state(ConnState::Offline);
            let Some(identity) = self.identity.lock().unwrap().clone() else { return };
            let hello = serde_json::to_vec(&Hello { name: None, platform: &self.config.platform }).expect("plain JSON");
            let mut attempt = 0usize;
            loop {
                let wait = self.config.reconnect.get(attempt).or(self.config.reconnect.last()).copied().unwrap_or(Duration::from_secs(5));
                tokio::time::sleep(wait).await;
                attempt += 1;
                match self.clone().open(&identity, Kind::Session, None, &hello).await {
                    Ok((r, w, wel)) => {
                        self.install(w, &wel);
                        reader = r;
                        welcome = wel;
                        break;
                    }
                    // The desktop's key does not match: trying again changes nothing.
                    Err(error) if error.is_channel() => return,
                    Err(_) => continue,
                }
            }
        }
    }

    /// Reads messages and pings every keepaliveMs until the channel fails.
    async fn serve(&self, reader: &mut ChannelReader<Pipe>, welcome: &Welcome) -> Error {
        let every = if welcome.keepalive_ms > 0 { Duration::from_millis(welcome.keepalive_ms) } else { self.config.keepalive };
        self.serve_on(reader, every, Pick::Network).await
    }

    /// One channel: its messages read, a ping on it every `every`, until it fails.
    async fn serve_on(&self, reader: &mut ChannelReader<Pipe>, every: Duration, pick: Pick) -> Error {
        let reading = async {
            loop {
                match reader.receive().await {
                    Ok((header, body)) => self.dispatch(header, body),
                    Err(error) => return error,
                }
            }
        };
        let pinging = async {
            let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                // No answer within one period: the channel is taken as gone.
                if let Err(error) = self.call("ping", json!({}), Vec::new(), every.max(Duration::from_secs(1)), pick).await
                    && !matches!(error, Error::Remote { .. }) {
                        return error;
                    }
            }
        };
        tokio::select! {
            error = reading => error,
            error = pinging => error,
        }
    }

    fn dispatch(&self, header: Value, body: Vec<u8>) {
        match header["t"].as_str() {
            Some("res") => {
                let Some(id) = header["id"].as_u64() else { return };
                let Some((tx, _)) = self.pending.lock().unwrap().remove(&id) else { return };
                let answer = if header["ok"] == Value::Bool(true) {
                    Ok((header.get("result").cloned().unwrap_or(Value::Null), body))
                } else {
                    let error = &header["error"];
                    Err(Error::Remote {
                        code: error["code"].as_str().unwrap_or("").to_string(),
                        message: error["message"].as_str().unwrap_or("request failed").to_string(),
                    })
                };
                let _ = tx.send(answer);
            }
            Some("evt") => {
                if header["name"] == "lan" {
                    self.lan_wake.notify_waiters();
                }
                if header["name"] == "page"
                    && let (Some(w), Some(there)) = (self.welcome.lock().unwrap().as_mut(), header["data"]["there"].as_bool()) {
                        w.page = there;
                    }
                let _ = self.events.send(Event {
                    name: header["name"].as_str().unwrap_or("").to_string(),
                    data: header.get("data").cloned().unwrap_or(Value::Null),
                    body,
                });
            }
            _ => {}
        }
    }

    async fn call(&self, method: &str, params: Value, body: Vec<u8>, timeout: Duration, pick: Pick) -> Result<(Value, Vec<u8>)> {
        let lan = self.lan.lock().unwrap().clone();
        let network = self.writer.lock().unwrap().clone();
        let (writer, on_lan) = match pick {
            Pick::Lan => (lan, true),
            Pick::Network => (network, false),
            Pick::Best => match lan {
                Some(lan) => (Some(lan), true),
                None => (network, false),
            },
        };
        let writer = writer.ok_or(Error::NotConnected)?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let params = if params.is_null() { json!({}) } else { params };
        let message = wire::encode_message(&Request { t: "req", id, method, params: &params }, &body)?;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, (tx, on_lan));
        // Sent from a task of its own: a caller that gives up halfway must not
        // leave half a message on the stream.
        let sent = tokio::spawn(async move { writer.lock().await.send_encoded(&message).await }).await;
        let sent = sent.unwrap_or_else(|e| Err(Error::Io(std::io::Error::other(e.to_string()))));
        if let Err(error) = sent {
            self.pending.lock().unwrap().remove(&id);
            return Err(error);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err(Error::Closed),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(Error::Timeout(format!("no answer to {method}")))
            }
        }
    }

    /* -------------------------------------------------------------- */
    /* The local network                                                */
    /* -------------------------------------------------------------- */

    /// For as long as the phone is paired: the desktop looked for on the
    /// local network, the channel there used while it lasts, looked for again
    /// when it falls. A desktop that keeps everything on I2P says so, and is
    /// asked again only now and then, or when it says it changed its mind.
    async fn lan_loop(self: Arc<Self>) {
        let mut attempt = 0usize;
        loop {
            // "Not here": the desktop does not allow this way, or this phone does not try it.
            let off = |error: &Error| matches!(error, Error::NotPaired) || matches!(error, Error::Remote { code, .. } if code == "lan_off" || code == "unknown_method");
            let wait = match self.open_lan().await {
                Ok((mut reader, writer)) => {
                    *self.lan.lock().unwrap() = Some(Arc::new(tokio::sync::Mutex::new(writer)));
                    self.update_via();
                    let since = Instant::now();
                    self.serve_on(&mut reader, self.config.lan_keepalive, Pick::Lan).await;
                    self.drop_lan();
                    // A channel that lasted is looked for again soon: the phone may only have changed room, or network.
                    if since.elapsed() > Duration::from_secs(60) {
                        attempt = 0;
                    }
                    self.lan_wait(&mut attempt)
                }
                Err(error) if off(&error) => Duration::from_secs(300),
                Err(_) => self.lan_wait(&mut attempt),
            };
            if tokio::time::timeout(wait, self.lan_wake.notified()).await.is_ok() {
                attempt = 0;
            }
        }
    }

    fn lan_wait(&self, attempt: &mut usize) -> Duration {
        let waits = &self.config.lan_retry;
        let wait = waits.get(*attempt).or(waits.last()).copied().unwrap_or(Duration::from_secs(60));
        *attempt += 1;
        wait
    }

    /// Where the desktop is on the local network: asked of it over the
    /// network channel when that is open (and kept), otherwise where it was
    /// the last time, if this phone is on that same network now.
    async fn lan_addresses(&self) -> Result<Vec<(String, u16)>> {
        if self.writer.lock().unwrap().is_some() {
            match self.call("lan.offer", json!({}), Vec::new(), Duration::from_secs(20), Pick::Network).await {
                Ok((answer, _)) => {
                    let found: Vec<(String, u16)> = answer["addresses"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|item| Some((item["host"].as_str()?.to_string(), u16::try_from(item["port"].as_u64()?).ok()?)))
                        .filter(|(host, _)| is_private(host))
                        .collect();
                    self.keep_lan(found.clone());
                    return Ok(found);
                }
                // The desktop keeps everything on I2P: what was known of the local network is let go of.
                Err(error @ Error::Remote { .. }) => {
                    self.keep_lan(Vec::new());
                    return Err(error);
                }
                Err(_) => {}
            }
        }
        let known = self.lan_known.lock().unwrap().clone();
        Ok(known.into_iter().filter(|(host, _)| same_network(host)).collect())
    }

    /// The addresses kept, and told to the app to keep them between one use and the next (`lan.known`).
    fn keep_lan(&self, addresses: Vec<(String, u16)>) {
        let changed = {
            let mut known = self.lan_known.lock().unwrap();
            let changed = *known != addresses;
            *known = addresses.clone();
            changed
        };
        if changed {
            let list: Vec<Value> = addresses.iter().map(|(host, port)| json!({ "host": host, "port": port })).collect();
            let _ = self.events.send(Event { name: "lan.known".into(), data: json!({ "addresses": list }), body: Vec::new() });
        }
    }

    /// A connection to the desktop on the local network, and the handshake on it.
    async fn open_lan(&self) -> Result<(ChannelReader<Pipe>, ChannelWriter<Pipe>)> {
        let identity = self.identity.lock().unwrap().clone().ok_or(Error::NotPaired)?;
        let mut addresses = self.lan_addresses().await?;
        // The desktop may have several private addresses (virtual networks of its own among them): the one on this
        // phone's network is tried first, so that the others do not make it wait.
        addresses.sort_by_key(|(host, _)| !same_network(host));
        if addresses.is_empty() {
            return Err(Error::Unreachable("the desktop is not known on this local network".into()));
        }
        let hello = serde_json::to_vec(&Hello { name: None, platform: &self.config.platform }).expect("plain JSON");
        let mut last = Error::Unreachable("no address of the desktop answered on the local network".into());
        for (host, port) in addresses {
            let Ok(Ok(stream)) = tokio::time::timeout(self.config.lan_timeout, tokio::net::TcpStream::connect((host.as_str(), port))).await else { continue };
            let _ = stream.set_nodelay(true);
            let stream: Pipe = Box::new(stream);
            let (s, key) = (identity.static_keypair()?, identity.desktop_key()?);
            let opened = tokio::time::timeout(self.config.lan_timeout * 2, async {
                let (mut reader, writer, _hash) = wire::initiate(stream, Kind::Session, s, key, None, &hello).await?;
                let (header, _body) = reader.receive().await?;
                Ok::<_, Error>((reader, writer, header))
            })
            .await
            .unwrap_or_else(|_| Err(Error::Timeout("local handshake".into())));
            match opened {
                Ok((reader, writer, header)) if header["name"] == "welcome" => return Ok((reader, writer)),
                // Something else answers at that address, on this network: not the desktop.
                Ok(_) => last = Error::Channel("the desktop did not answer as expected".into()),
                Err(error) => last = error,
            }
        }
        Err(last)
    }
}

/// Whether an address is of a private IPv4 network: the only ones the local way goes to.
fn is_private(host: &str) -> bool {
    host.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| ip.is_private())
}

/// Whether this phone has, now, an address on the same network as `host` (the same first three numbers):
/// an address kept from another day is tried only where it can be the desktop's.
fn same_network(host: &str) -> bool {
    let Ok(target) = host.parse::<std::net::Ipv4Addr>() else { return false };
    if !target.is_private() {
        return false;
    }
    // No packet leaves: connecting a UDP socket only chooses the local address that would be used.
    let Ok(socket) = std::net::UdpSocket::bind(("0.0.0.0", 0)) else { return false };
    if socket.connect((target, 9)).is_err() {
        return false;
    }
    match socket.local_addr() {
        Ok(std::net::SocketAddr::V4(local)) => local.ip().is_private() && local.ip().octets()[..3] == target.octets()[..3],
        _ => false,
    }
}

