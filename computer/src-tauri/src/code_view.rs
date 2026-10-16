//! The Code tab's editor: the embedded workbench in a child webview of the
//! main window. A local project binds it to a folder of this machine, a
//! container project to the container, where everything the workbench asks
//! for is done (see `code_runtime`). The page drives both through the same
//! three commands: `code_create`, `code_open` and `code_layout`.

use crate::code_runtime::{self, RuntimeSpec};
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

#[derive(Default)]
pub struct Appearance(pub Mutex<Value>);

/// The Code tab's area as the page last reported it.
#[derive(Default)]
pub struct LastBounds(pub Mutex<Option<Bounds>>);

#[tauri::command]
pub fn code_appearance(state: tauri::State<'_, Appearance>) -> Value {
    state.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// A command of the model for the editor's terminal of a local project: the
/// SynthOrg page asks, the workbench types it and answers with the output.
/// The desktop only carries the two messages between its two webviews.
#[derive(Clone, Debug, Deserialize, serde::Serialize)]
pub struct RunRequest {
    pub id: String,
    pub command: String,
    pub cwd: Option<String>,
    /// How long the command may run before the workbench interrupts it.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, serde::Serialize)]
pub struct RunResult {
    pub id: String,
    pub output: String,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}

#[tauri::command]
pub fn code_run_command(app: AppHandle, request: RunRequest) -> Result<(), String> {
    app.emit_to("code", "synthorg-code-run", request).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn code_command_done(app: AppHandle, result: RunResult) -> Result<(), String> {
    app.emit_to("main", "synthorg-code-command-done", result).map_err(|e| e.to_string())
}

/// A file pressed in the page's column of files: the workbench opens it. Only
/// the path travels; the workbench's own file service, held to the project's
/// folder like every other read of it, is what opens it or refuses.
#[tauri::command]
pub fn code_open_file(app: AppHandle, path: String) -> Result<(), String> {
    app.emit_to("code", "synthorg-code-open-file", path).map_err(|e| e.to_string())
}

/// The workbench is up and hears the files the page names: said to the page,
/// which may be holding one that was pressed while it was still loading.
#[tauri::command]
pub fn code_frame_ready(app: AppHandle) -> Result<(), String> {
    app.emit_to("main", "synthorg-code-frame-ready", ()).map_err(|e| e.to_string())
}

/// What the page's bar asks of the workbench: "undo", "redo", "save" on the
/// file in view; "zoomIn", "zoomOut", "zoomReset"; "close" with the file to
/// close; "settings" for the editor's own. The workbench does it, or nothing for a word it does not know, and
/// says with `code_did` that it is over: a file is renamed or copied only once
/// what was in the editor is in it.
#[tauri::command]
pub fn code_do(app: AppHandle, what: String, id: String, path: Option<String>) -> Result<(), String> {
    app.emit_to("code", "synthorg-code-do", serde_json::json!({ "what": what, "id": id, "path": path })).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn code_did(app: AppHandle, id: String) -> Result<(), String> {
    app.emit_to("main", "synthorg-code-did", id).map_err(|e| e.to_string())
}

/// What the workbench has open, for the page's bar: the files by their place
/// on this computer, which is in view, which have unsaved changes, the zoom.
#[tauri::command]
pub fn code_files(app: AppHandle, state: Value) -> Result<(), String> {
    app.emit_to("main", "synthorg-code-files", state).map_err(|e| e.to_string())
}

/// The branch strip over the file explorer of a local project. The SynthOrg
/// page owns the state and every action; the workbench only shows what it is
/// told and says what was pressed. The desktop carries the two messages.
#[tauri::command]
pub fn code_git_state(app: AppHandle, state: Value) -> Result<(), String> {
    app.emit_to("code", "synthorg-code-git", state).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn code_git_command(app: AppHandle, command: Value) -> Result<(), String> {
    app.emit_to("main", "synthorg-code-git-command", command).map_err(|e| e.to_string())
}

/// The stop button of the chat: the workbench interrupts the command with that id.
#[tauri::command]
pub fn code_stop_command(app: AppHandle, id: String) -> Result<(), String> {
    app.emit_to("code", "synthorg-code-stop", id).map_err(|e| e.to_string())
}

#[derive(Clone, Debug, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Bounds {
    fn validate(&self) -> Result<(), String> {
        if [self.x, self.y, self.width, self.height].iter().any(|n| !n.is_finite() || *n < 0.0 || *n > 32768.0)
            || self.width < 1.0 || self.height < 1.0 {
            return Err("invalid editor bounds".into());
        }
        Ok(())
    }
}

/// `file:` URI of a project folder on this machine, in the form the
/// workbench's `?folder=` parameter expects. Only an existing absolute
/// directory is accepted: the value decides which part of the disk the editor
/// exposes.
fn folder_uri(folder: &str) -> Result<String, String> {
    let path = Path::new(folder);
    if !path.is_absolute() || !path.is_dir() {
        return Err("invalid project folder".into());
    }
    Url::from_file_path(path).map(String::from).map_err(|()| "invalid project folder".into())
}

fn with_folder(mut url: Url, uri: &str) -> Url {
    url.set_query(None);
    url.query_pairs_mut().append_pair("folder", uri);
    url
}

fn set_appearance(app: &AppHandle, appearance: &Value) {
    *app.state::<Appearance>().0.lock().unwrap_or_else(|e| e.into_inner()) = appearance.clone();
}

fn remember_bounds(app: &AppHandle, bounds: &Bounds) {
    *app.state::<LastBounds>().0.lock().unwrap_or_else(|e| e.into_inner()) = Some(bounds.clone());
}

fn last_bounds(app: &AppHandle) -> Bounds {
    app.state::<LastBounds>().0.lock().unwrap_or_else(|e| e.into_inner()).clone()
        .unwrap_or(Bounds { x: 0.0, y: 0.0, width: 1200.0, height: 800.0 })
}

/// Which edges of the editor are edges of the window. Only Linux asks: there
/// the editor's webview has to offer the window's resize border itself (see
/// `resources/js/window-resize.js`).
fn resize_edges(app: &AppHandle, bounds: &Bounds) -> Value {
    let size = app.get_window("main").and_then(|window| {
        let scale = window.scale_factor().ok()?;
        Some(window.inner_size().ok()?.to_logical::<f64>(scale))
    });
    let Some(size) = size else { return serde_json::json!({}); };
    serde_json::json!({
        "top": bounds.y <= 1.0,
        "left": bounds.x <= 1.0,
        "right": bounds.x + bounds.width >= size.width - 1.0,
        "bottom": bounds.y + bounds.height >= size.height - 1.0,
    })
}

#[tauri::command]
pub fn code_resize_edges(app: AppHandle) -> Value {
    resize_edges(&app, &last_bounds(&app))
}

/// Creates the embedded workbench webview, hidden, on `uri`.
fn create_webview(app: &AppHandle, uri: &str, bounds: &Bounds) -> Result<(), String> {
    let window = app.get_window("main").ok_or("main window unavailable")?;
    let appearance = code_appearance(app.state::<Appearance>());
    // The resize strips are the page's own script: one behaviour, two webviews.
    let script = format!(
        "window.__SYNTHORG_EMBEDDED__ = true; window.__SYNTHORG_APPEARANCE__ = {};
{}",
        appearance,
        include_str!("../../resources/js/window-resize.js")
    );
    // Only the query matters here; Tauri joins the relative path onto the app URL.
    let entry = with_folder(Url::parse("http://localhost/code/index.html").map_err(|e| e.to_string())?, uri);
    let path = format!("code/index.html?{}", entry.query().unwrap_or_default());
    let policy = app.state::<Arc<code_runtime::CodeRuntime>>().inner().clone();
    let builder = tauri::webview::WebviewBuilder::new("code", WebviewUrl::App(path.into()))
        .initialization_script(script)
        // Tauri's own file-drop handler takes every drag over the webview on
        // Windows, so the workbench never sees one: moving a file between
        // folders in the explorer would do nothing. The main window turns it
        // off in tauri.conf.json (dragDropEnabled); this webview is built here.
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
            // Only the packaged app is served over the tauri.localhost custom
            // protocol; `tauri dev` serves frontendDist from a local dev server.
            let host_ok = matches!(url.host_str(), Some("tauri.localhost" | "localhost"))
                || (cfg!(debug_assertions) && url.host_str() == Some("127.0.0.1"));
            // And only on the project the host bound the editor to: the
            // workbench's own "Open Folder" cannot take it elsewhere.
            let allowed = matches!(url.scheme(), "http" | "https" | "tauri")
                && host_ok
                && code_runtime::navigation_allowed(&policy, url);
            if !allowed {
                log::info!("[code webview] blocked navigation to {url}");
            }
            allowed
        });
    // On Windows the webviews of the app share one browser process: this one is given the browser
    // arguments of the main window (tauri.conf.json), or it cannot be created beside it.
    let builder = match app.config().app.windows.first().and_then(|main| main.additional_browser_args.clone()) {
        Some(args) => builder.additional_browser_args(&args),
        None => builder,
    };
    let view = window.add_child(builder, LogicalPosition::new(bounds.x, bounds.y), LogicalSize::new(bounds.width, bounds.height))
        .map_err(|e| e.to_string())?;
    // The workbench runs in its own webview, so its console is the only place
    // its bootstrap errors surface — neither the host page nor the Rust log
    // sees them. SYNTHORG_NO_DEVTOOLS keeps them closed, for when the window
    // itself is what is being looked at (a recording of the screen).
    #[cfg(debug_assertions)]
    if std::env::var_os("SYNTHORG_NO_DEVTOOLS").is_none() {
        view.open_devtools();
    }
    // On Linux Tauri has just packed the editor below the page: lay it over
    // the page instead, where the bounds mean something.
    #[cfg(target_os = "linux")]
    crate::linux_view::adopt(app, bounds.x, bounds.y, bounds.width, bounds.height)?;
    view.hide().map_err(|e| e.to_string())
}

/// Shows `folder` in the workbench, bound to `runtime`. Reopening the
/// project already shown keeps everything as it is.
fn open_project(app: &AppHandle, folder: &str, runtime: RuntimeSpec, bounds: &Bounds) -> Result<(), String> {
    let container = runtime.validate()?;
    // A container project has no folder on this machine: the workbench opens
    // the container's directory, which the container answers for.
    let (root, uri) = match &container {
        Some(container) => (PathBuf::from(container.workdir()), container.folder_uri()),
        None => (PathBuf::from(folder), folder_uri(folder)?),
    };

    if let Some(view) = app.get_webview("code") {
        let current = view.url().map_err(|e| e.to_string())?;
        let same_folder = current.query_pairs().any(|(key, value)| key == "folder" && value == uri.as_str());
        let same_runtime = code_runtime::bound_container(app).as_deref() == container.as_ref().map(|c| c.name());
        if same_folder && same_runtime {
            // Nothing is loaded again, so the workbench will not say by itself that it is up — and the page that
            // asks may be a new one (reloaded, while the workbench stayed), waiting to hear it before it hands a
            // file over. The workbench is asked to say it again; one still loading says it when it is done.
            let _ = app.emit_to("code", "synthorg-code-hello", ());
            return Ok(());
        }
        // The previous project's processes end and the binding switches before
        // the workbench reloads on the new folder.
        code_runtime::apply(app, &root, &uri, container);
        return view.navigate(with_folder(current, &uri)).map_err(|e| e.to_string());
    }
    // Bound before the workbench exists, so its very first request already
    // runs under the project's binding.
    code_runtime::apply(app, &root, &uri, container);
    create_webview(app, &uri, bounds)
}

#[tauri::command]
pub async fn code_create(app: AppHandle, bounds: Bounds, appearance: Value, folder: String, runtime: RuntimeSpec) -> Result<(), String> {
    bounds.validate()?;
    set_appearance(&app, &appearance);
    remember_bounds(&app, &bounds);
    tauri::async_runtime::spawn_blocking(move || open_project(&app, &folder, runtime, &bounds))
        .await
        .map_err(|e| e.to_string())?
}

/// Points the editor at another project.
#[tauri::command]
pub async fn code_open(app: AppHandle, folder: String, runtime: RuntimeSpec) -> Result<(), String> {
    let bounds = last_bounds(&app);
    tauri::async_runtime::spawn_blocking(move || open_project(&app, &folder, runtime, &bounds))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn code_layout(app: AppHandle, visible: bool, bounds: Option<Bounds>, appearance: Option<Value>) -> Result<(), String> {
    if let Some(bounds) = &bounds {
        bounds.validate()?;
        remember_bounds(&app, bounds);
    }
    if let Some(appearance) = &appearance {
        set_appearance(&app, appearance);
    }
    let Some(view) = app.get_webview("code") else { return Ok(()); };
    if !visible { return view.hide().map_err(|e| e.to_string()); }
    let bounds = bounds.ok_or("editor bounds required")?;
    #[cfg(target_os = "linux")]
    crate::linux_view::place(&app, bounds.x, bounds.y, bounds.width, bounds.height)?;
    #[cfg(not(target_os = "linux"))]
    {
        view.set_position(LogicalPosition::new(bounds.x, bounds.y)).map_err(|e| e.to_string())?;
        view.set_size(LogicalSize::new(bounds.width, bounds.height)).map_err(|e| e.to_string())?;
    }
    if let Some(appearance) = appearance {
        app.emit_to("code", "synthorg-code-appearance", appearance).map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    view.eval(format!("window.__synthorgResizeEdges && window.__synthorgResizeEdges({})", resize_edges(&app, &bounds)))
        .map_err(|e| e.to_string())?;
    view.show().map_err(|e| e.to_string())
}
