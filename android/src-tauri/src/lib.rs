//! SynthOrg on the phone.
//!
//! The same interface as on the computer (android/ui, copied from
//! computer/resources) and the same archive, kept whole on the phone and run
//! by the same rules (archive.rs): what is done here is written here, at
//! once, with or without a computer. A paired computer is reached through
//! the I2P bridge: the router runs in the app (router.rs), the channel is
//! kept open and carries the rows each side wrote to the other (link.rs).
//! The page finds the archive at the address it uses on the computer
//! (proxy.rs); what only the computer has is asked of it from there.

mod archive;
mod link;
mod proxy;
mod router;
mod store;
mod vault;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use link::{Info, Link, Refusal};
use serde_json::{Value, json};
use std::sync::Arc;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

type Shared = Arc<Link>;

/// Where the page finds the archive (storage.js asks for it at the start).
#[tauri::command]
fn session_info() -> Value {
    json!({ "token": "", "port": 0, "origin": "http://synthorg.localhost" })
}

#[tauri::command]
fn storage_status() -> Value {
    json!({ "running": true, "detail": "" })
}

/// A request of the page to the archive (storage.js): the same as at the app's address, what is written included.
#[tauri::command]
async fn archive_request(link: tauri::State<'_, Shared>, method: String, path: String, body: Option<Value>) -> Result<Value, Refusal> {
    let bytes = match &body {
        Some(value) if !value.is_null() => serde_json::to_vec(value).unwrap_or_default(),
        _ => Vec::new(),
    };
    let uri = format!("http://synthorg.localhost{path}");
    let request = tauri::http::Request::builder().method(method.as_str()).uri(uri).body(bytes).map_err(|e| Refusal::new("bad_request", e.to_string()))?;
    let response = proxy::handle(link.inner().clone(), request).await;
    let data: Value = serde_json::from_slice(response.body()).unwrap_or(Value::Null);
    Ok(json!({ "status": response.status().as_u16(), "data": data }))
}

#[tauri::command]
fn remote_info(link: tauri::State<'_, Shared>) -> Info {
    link.info()
}

/// A request to the computer (remote.js): its answer, and its bytes as base64.
#[tauri::command]
async fn remote_call(link: tauri::State<'_, Shared>, method: String, params: Option<Value>, body: Option<String>) -> Result<Value, Refusal> {
    let bytes = match body {
        Some(text) => Some(B64.decode(text).map_err(|_| Refusal::new("bad_request", "Dati non validi."))?),
        None => None,
    };
    // What this phone wrote is on the computer before something is asked of its page (a message, before the turn that answers it).
    link.flush().await;
    let (result, bytes) = link.call(&method, params.unwrap_or_else(|| json!({})), bytes).await?;
    Ok(json!({ "result": result, "body": if bytes.is_empty() { Value::Null } else { Value::String(B64.encode(bytes)) } }))
}

#[tauri::command]
async fn remote_pair(link: tauri::State<'_, Shared>, code: String, name: String) -> Result<Info, Refusal> {
    let name = name.trim();
    let name = if name.is_empty() { "Telefono" } else { name };
    link.pair(code.trim(), &name.chars().take(60).collect::<String>()).await
}

#[tauri::command]
fn remote_connect(link: tauri::State<'_, Shared>) {
    link.retry();
}

#[tauri::command]
async fn remote_forget(link: tauri::State<'_, Shared>) -> Result<(), Refusal> {
    link.forget().await;
    Ok(())
}

/// What the page knows before it loads: that it is on the phone, and which one.
fn page_script(info: &Info) -> String {
    let given = json!({ "paired": info.paired, "deviceId": info.device_id, "desktop": info.desktop });
    format!("window.SYNTHORG_REMOTE = Object.freeze({given});")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    let app = builder
        .register_asynchronous_uri_scheme_protocol("synthorg", |ctx, request, responder| {
            let link = ctx.app_handle().state::<Shared>().inner().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(proxy::handle(link, request).await);
            });
        })
        .invoke_handler(tauri::generate_handler![session_info, storage_status, archive_request, remote_info, remote_call, remote_pair, remote_connect, remote_forget])
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let store = Arc::new(store::Store::open(&data_dir.join("phone.sqlite"))?);
            let archive = Arc::new(archive::Archive::open(&data_dir.join("archive.sqlite"), true).map_err(std::io::Error::other)?);
            let link = Link::new(app.handle().clone(), store, archive, data_dir);
            app.manage(link.clone());
            let script = page_script(&link.info());
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("SynthOrg")
                .initialization_script(&script)
                // The window holds the app's own page and nothing else: a link that leads anywhere else is not
                // followed here (the page opens it in the phone's browser, remote.js).
                .on_navigation(|url| match url.scheme() {
                    "http" | "https" => url.host_str().is_some_and(|host| host == "localhost" || host.ends_with(".localhost")),
                    _ => true,
                })
                .build()?;
            link.keep();
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("SynthOrg non si è avviato");
    app.run(|_, event| {
        if let RunEvent::Exit = event {
            router::stop();
        }
    });
}
