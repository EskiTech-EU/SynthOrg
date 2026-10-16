// SynthOrg desktop shell.
//
// Owns the native window and the lifetime of the Node storage sidecar.
// The session token is generated here, handed to the sidecar through its
// environment and to the webview through the `session_info` command: it is
// never written to disk.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod background;
mod vault_crypto;
mod code_canvas;
mod code_runtime;
mod code_view;
#[cfg(target_os = "linux")]
mod linux_view;
#[cfg(windows)]
mod process_job;

use std::path::{Path, PathBuf};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Manager, RunEvent, WindowEvent};

struct Session {
    token: String,
    /// The child is held for the whole run, and its stdin pipe with it: the
    /// service watches that pipe and exits when it reaches EOF, which happens
    /// the moment this process disappears for any reason at all. That is what
    /// makes an orphaned storage service impossible.
    sidecar: Mutex<Option<Child>>,
    /// Port the service actually bound, reported by the service itself. The OS
    /// chooses it, so a port already taken by something else is not a failure.
    port: Arc<Mutex<Option<u16>>>,
    /// Tail of the storage service's own output. When the service refuses to
    /// start — a port already held by a previous instance is the usual case —
    /// this is the only explanation there is, and the webview would otherwise
    /// show nothing but "unreachable".
    diagnostics: Arc<Mutex<String>>,
}

#[derive(Serialize)]
struct StorageStatus {
    running: bool,
    detail: String,
}

#[derive(Serialize)]
struct SessionInfo {
    token: String,
    /// Absent until the service reports the port it bound; the webview retries.
    port: Option<u16>,
    origin: Option<String>,
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("sistema senza generatore casuale");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Directory holding `server/index.js`: the repository root under `tauri dev`,
/// the bundled resource directory in a packaged build.
///
/// The dev branch matters: the build copies `server/` into `target/`, and
/// picking that copy would run stale code and create a second `data/`
/// directory, leaving the real SQLite store invisible.
fn app_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var_os("SYNTHORG_DEV_ROOT") {
        candidates.push(PathBuf::from(root));
    }

    #[cfg(debug_assertions)]
    if let Some(checkout) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
        candidates.push(checkout.to_path_buf());
    }

    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir);
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut dir: Option<&Path> = exe.parent();
        for _ in 0..4 {
            match dir {
                Some(d) => {
                    candidates.push(d.to_path_buf());
                    dir = d.parent();
                }
                None => break,
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.clone());
        if let Some(parent) = cwd.parent() {
            candidates.push(parent.to_path_buf());
        }
    }
    candidates
        .into_iter()
        .find(|dir| dir.join("server").join("index.js").is_file())
        .map(simplified)
}

/// A plain path, never a verbatim one.
///
/// Windows APIs — `resource_dir()` among them — hand back `\\?\C:\...`, which
/// is fine for opening files and fatal as the path of Node's main script: Node
/// reads `\\?\C:` as a UNC server and share and goes looking for `C:`, which
/// is a directory, so the service dies before it has run a line. In a debug
/// build the checkout is found first and this never shows; a packaged build
/// has nothing else to fall back on.
fn simplified(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        // Only a drive path: `\\?\UNC\server\share` is left exactly as it is.
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path,
    }
}

#[cfg(test)]
mod tests {
    use super::simplified;
    use std::path::PathBuf;

    #[test]
    fn verbatim_drive_paths_are_made_plain_for_node() {
        assert_eq!(
            simplified(PathBuf::from(r"\\?\C:\Users\x\SynthOrg")),
            PathBuf::from(r"C:\Users\x\SynthOrg")
        );
        // Already plain, and UNC: both untouched.
        assert_eq!(simplified(PathBuf::from(r"C:\Users\x")), PathBuf::from(r"C:\Users\x"));
        assert_eq!(
            simplified(PathBuf::from(r"\\?\UNC\server\share\x")),
            PathBuf::from(r"\\?\UNC\server\share\x")
        );
        assert_eq!(simplified(PathBuf::from("/opt/synthorg")), PathBuf::from("/opt/synthorg"));
    }
}

/// The Node runtime the service runs on.
///
/// It ships with the application as a Tauri external binary, so the user never
/// has to install anything: Tauri places it next to the executable, stripping
/// the target triple from its name. In a checkout it is still the fetched file,
/// which keeps the triple. Falling back to PATH covers only the case where
/// neither exists.
fn node_binary(root: &Path) -> PathBuf {
    // Our own name: on Linux the package installs external binaries in
    // /usr/bin, where `node` belongs to the system's nodejs package.
    let name = if cfg!(windows) { "synthorg-node.exe" } else { "synthorg-node" };

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join(name);
            if bundled.is_file() {
                return bundled;
            }
        }
    }

    if let Ok(entries) = std::fs::read_dir(root.join("src-tauri").join("binaries")) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with("synthorg-node-") && entry.path().is_file() {
                return entry.path();
            }
        }
    }

    // Neither bundled nor fetched: whatever Node the system has on PATH.
    PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" })
}

fn spawn_sidecar(
    app: &tauri::AppHandle,
    token: &str,
    diagnostics: &Arc<Mutex<String>>,
    port: &Arc<Mutex<Option<u16>>>,
) -> Option<Child> {
    let root = match app_root(app) {
        Some(root) => root,
        None => {
            let message = "server/index.js non trovato: archivio non avviato.".to_string();
            eprintln!("[SynthOrg] {message}");
            if let Ok(mut buffer) = diagnostics.lock() {
                *buffer = message;
            }
            return None;
        }
    };

    let mut command = Command::new(node_binary(&root));
    command
        .arg(root.join("server").join("index.js"))
        .current_dir(&root)
        .env("SYNTHORG_TOKEN", token)
        // 0: let the OS pick a free port rather than fail on a busy one.
        .env("SYNTHORG_PORT", "0")
        .env("SYNTHORG_PARENT_PIPE", "1")
        // Never taken and never closed while this process lives: it is the
        // service's liveness signal for its parent.
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // A packaged build on Linux and macOS is installed in a read-only system
    // directory (/usr/lib/SynthOrg, /Applications): what the service writes
    // goes in the user's data directory instead (~/.local/share/<identifier>
    // on Linux). Windows installs per user in a writable directory and keeps
    // `data/` next to the application; a checkout keeps the repository's.
    #[cfg(all(not(windows), not(debug_assertions)))]
    if let Ok(dir) = app.path().app_data_dir() {
        command.env("SYNTHORG_DATA_DIR", dir);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    match command.spawn() {
        Ok(mut child) => {
            // The service announces the port it bound on stdout.
            if let Some(stdout) = child.stdout.take() {
                let slot = port.clone();
                std::thread::spawn(move || {
                    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                        println!("{line}");
                        if let Some(value) = line.strip_prefix("SYNTHORG_PORT=") {
                            if let Ok(parsed) = value.trim().parse::<u16>() {
                                if let Ok(mut guard) = slot.lock() {
                                    *guard = Some(parsed);
                                }
                            }
                        }
                    }
                });
            }
            // Kept for the UI and still echoed, so `tauri dev` behaves as before.
            if let Some(stderr) = child.stderr.take() {
                let sink = diagnostics.clone();
                std::thread::spawn(move || {
                    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                        eprintln!("{line}");
                        if let Ok(mut buffer) = sink.lock() {
                            buffer.push_str(&line);
                            buffer.push('\n');
                            if buffer.len() > 4000 {
                                let cut = buffer.len() - 4000;
                                *buffer = buffer[cut..].to_string();
                            }
                        }
                    }
                });
            }
            Some(child)
        }
        Err(error) => {
            let message = format!("Avvio dell'archivio non riuscito: {error}. Node.js 24 o superiore deve essere installato e raggiungibile.");
            eprintln!("[SynthOrg] {message}");
            if let Ok(mut buffer) = diagnostics.lock() {
                *buffer = message;
            }
            None
        }
    }
}

/// Why the storage service is not answering. Called by the webview when a
/// request fails, so the user reads the actual cause instead of a generic
/// "unreachable".
#[tauri::command]
fn storage_status(state: tauri::State<'_, Session>) -> StorageStatus {
    let running = match state.sidecar.lock() {
        Ok(mut guard) => match guard.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        },
        Err(_) => false,
    };
    let detail = state
        .diagnostics
        .lock()
        .map(|buffer| buffer.trim().to_string())
        .unwrap_or_default();
    StorageStatus { running, detail }
}

/// Handed to the frontend so it can authenticate against the storage sidecar.
#[tauri::command]
fn session_info(state: tauri::State<'_, Session>) -> SessionInfo {
    let port = state.port.lock().ok().and_then(|guard| *guard);
    SessionInfo {
        token: state.token.clone(),
        port,
        origin: port.map(|value| format!("http://127.0.0.1:{value}")),
    }
}

/// The derived session key, cached in the native (parent) process so lock and
/// checkpoint reuse it without the password ever transiting the webview. Cleared
/// on lock (`forget`) or explicitly via `vault_forget_key`.
struct VaultKey(Arc<Mutex<Option<[u8; vault_crypto::KEY_LEN]>>>);

#[derive(serde::Deserialize)]
struct DumpCmd {
    /// Present on first enable (derive + cache). Absent = reuse the cached key
    /// (lock / checkpoint).
    password: Option<String>,
    /// Reuse an existing salt when re-dumping; absent + password = generate one.
    salt_hex: Option<String>,
    #[serde(default)]
    dbs: Vec<vault_crypto::DbTarget>,
    sandboxes_dir: Option<String>,
    sandboxes_enc_path: Option<String>,
    /// Clear the cached key once the dump completes (used by lock).
    #[serde(default)]
    forget: bool,
}

#[derive(serde::Deserialize)]
struct UndumpCmd {
    password: String,
    salt_hex: String,
    #[serde(default)]
    dbs: Vec<vault_crypto::DbUndumpTarget>,
    sandboxes: Option<vault_crypto::SandboxUndumpTarget>,
}

/// Encrypt the vault (databases individually + the sandbox artifact tree) off
/// the Node event loop. Node closes the DBs first, then the frontend invokes
/// this; Rust does the heavy pack/encrypt/IO async and returns the crypto
/// params (salt/iv/tag) for Node to persist into its meta JSON.
#[tauri::command]
async fn vault_dump(
    request: DumpCmd,
    state: tauri::State<'_, VaultKey>,
) -> Result<vault_crypto::DumpResult, String> {
    let cache = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (key, salt_hex) = if let Some(pw) = &request.password {
            let salt_hex = match &request.salt_hex {
                Some(s) => s.clone(),
                None => vault_crypto::random_salt_hex()?,
            };
            let salt = hex::decode(&salt_hex).map_err(|e| format!("salt hex: {e}"))?;
            let key = vault_crypto::derive_key(pw, &salt)?;
            (key, salt_hex)
        } else {
            let key = (*cache.lock().unwrap())
                .ok_or_else(|| "Vault bloccato: nessuna session key in memoria.".to_string())?;
            (key, request.salt_hex.clone().unwrap_or_default())
        };

        let sandboxes = match (&request.sandboxes_dir, &request.sandboxes_enc_path) {
            (Some(d), Some(e)) => Some((d.as_str(), e.as_str())),
            _ => None,
        };
        let result = vault_crypto::dump(&key, salt_hex, &request.dbs, sandboxes)?;

        *cache.lock().unwrap() = if request.forget { None } else { Some(key) };
        Ok(result)
    })
    .await
    .map_err(|e| format!("vault_dump join: {e}"))?
}

/// Decrypt the vault back onto the live location, async, and cache the derived
/// key for subsequent locks/checkpoints.
#[tauri::command]
async fn vault_undump(
    request: UndumpCmd,
    state: tauri::State<'_, VaultKey>,
) -> Result<(), String> {
    let cache = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let salt = hex::decode(&request.salt_hex).map_err(|e| format!("salt hex: {e}"))?;
        let key = vault_crypto::derive_key(&request.password, &salt)?;
        vault_crypto::undump(&key, &request.dbs, request.sandboxes.as_ref())?;
        *cache.lock().unwrap() = Some(key);
        Ok(())
    })
    .await
    .map_err(|e| format!("vault_undump join: {e}"))?
}

/// Drop the cached session key (app lock / logout).
#[tauri::command]
fn vault_forget_key(state: tauri::State<'_, VaultKey>) {
    *state.0.lock().unwrap() = None;
}

/// Where the service keeps what it writes (server/paths.js): the same folder the service is given.
fn data_dir(app: &tauri::AppHandle, root: &Path) -> PathBuf {
    if let Some(dir) = std::env::var_os("SYNTHORG_DATA_DIR") {
        return PathBuf::from(dir);
    }
    #[cfg(all(not(windows), not(debug_assertions)))]
    if let Ok(dir) = app.path().app_data_dir() {
        return dir;
    }
    let _ = app;
    root.join("data")
}

/// The editor's own data — its settings, what it remembers of each folder — are
/// part of the memory of the app (server/memory.js): in its folder, wherever the
/// user keeps it, under `editor`. What an earlier version kept in the system's
/// configuration folder is moved there once.
fn editor_data_dir(app: &tauri::AppHandle, root: &Path) -> PathBuf {
    let memory = memory_dir(&data_dir(app, root));
    let before = app.path().config_dir().ok().map(|base| base.join("SynthOrg").join("Code"));
    adopt_editor_data(before.as_deref(), &memory)
}

/// Where the memory is: the folder the data folder names (`memoria.json`), or the data folder itself.
fn memory_dir(data: &Path) -> PathBuf {
    std::fs::read_to_string(data.join("memoria.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|kept| kept.get("dir").and_then(|dir| dir.as_str()).map(PathBuf::from))
        // Only a folder that carries the memory's mark: a disk that is not plugged in is not written to.
        .filter(|dir| dir.join(".synthorg-memoria").is_file())
        .unwrap_or_else(|| data.to_path_buf())
}

/// `editor` in the memory, made if it is not there. The first time, what is in `before` is moved into it.
fn adopt_editor_data(before: Option<&Path>, memory: &Path) -> PathBuf {
    let dir = memory.join("editor");
    if !dir.exists() {
        if let Some(before) = before.filter(|before| before.is_dir()) {
            let _ = std::fs::create_dir_all(memory);
            if std::fs::rename(before, &dir).is_err() && copy_tree(before, &dir).is_ok() {
                let _ = std::fs::remove_dir_all(before);
            }
            // The folder that held it, when nothing else is in it.
            if let Some(parent) = before.parent() {
                let _ = std::fs::remove_dir(parent);
            }
        }
    }
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn code_initialize(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(root) = app_root(&app) {
            // Both services use the Node runtime already shipped by SynthOrg.
            std::env::set_var("SIDEX_NODE_BINARY", node_binary(&root));
            if std::env::var_os("SYNTHORG_CODE_DATA_DIR").is_none() {
                std::env::set_var("SYNTHORG_CODE_DATA_DIR", editor_data_dir(&app, &root));
            }
        }
        sidex_lib::initialize(&app)
    })
    .await
    .map_err(|e| format!("editor initialization: {e}"))?
}

fn main() {
    // Without a `log` implementation, sidex_lib's log macros are silent — the
    // extension host's stderr forwarder among them. Default to surfacing that
    // forwarder (debug) while keeping the rest at info; RUST_LOG overrides.
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info,sidex_lib=debug"),
    )
    .init();

    #[cfg(windows)]
    let _process_job = process_job::ProcessJob::new()
        .expect("impossibile collegare i processi figli alla finestra SynthOrg");
    let token = random_token();

    sidex_lib::configure(tauri::Builder::default())
        .manage(code_view::Appearance::default())
        .manage(code_view::LastBounds::default())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Started again while it is running. `--quit` closes it for good, as
            // "Chiudi SynthOrg" does; `--hide` does what closing the window does;
            // otherwise the window comes to the front, with or without one before.
            if argv.iter().any(|arg| arg == "--quit") {
                app.exit(0);
            } else if argv.iter().any(|arg| arg == "--hide") {
                if !background::close_requested(app) {
                    app.exit(0);
                }
            } else {
                background::show(app);
            }
        }))
        .manage(background::Background::default())
        // With the phone bridge's service on, closing the window hides it and the app goes on.
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                if background::close_requested(window.app_handle()) {
                    api.prevent_close();
                }
            }
        })
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .manage(Session {
            token: token.clone(),
            sidecar: Mutex::new(None),
            port: Arc::new(Mutex::new(None)),
            diagnostics: Arc::new(Mutex::new(String::new())),
        })
        .manage(VaultKey(Arc::new(Mutex::new(None))))
        .manage(Arc::new(code_runtime::CodeRuntime::default()))
        .manage(Arc::new(code_canvas::CanvasEditor::default()))
        .invoke_handler(|invoke| {
            let command = invoke.message.command();
            // Which project the editor is bound to is the SynthOrg page's
            // decision alone: the workbench webview cannot rebind itself.
            let from_workbench = invoke.message.webview_ref().label() == "code";
            match command {
                "code_create" | "code_open" | "editor_start" | "editor_input" | "editor_stop" | "editor_clipboard" | "code_run_command" | "code_stop_command" | "code_git_state" | "code_open_file" | "code_do" | "background_state" | "background_configure" | "background_autostart" | "background_hide" | "background_quit" if from_workbench => {
                    invoke.resolver.reject("only the SynthOrg window can open projects");
                    true
                }
                "session_info" | "storage_status" | "vault_dump" | "vault_undump"
                | "vault_forget_key" | "code_initialize" | "code_create" | "code_open" | "code_layout" | "code_appearance"
                | "code_resize_edges" | "editor_start" | "editor_input" | "editor_stop" | "editor_clipboard" | "code_run_command" | "code_stop_command" | "code_command_done" | "code_git_state" | "code_git_command" | "code_open_file" | "code_frame_ready" | "code_do" | "code_did" | "code_files"
                | "background_state" | "background_configure" | "background_autostart" | "background_hide" | "background_quit" => {
                    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                        session_info, storage_status, vault_dump, vault_undump,
                        vault_forget_key, code_initialize, code_view::code_create, code_view::code_open, code_view::code_layout, code_view::code_appearance, code_view::code_resize_edges,
                        code_view::code_run_command, code_view::code_stop_command, code_view::code_command_done, code_view::code_git_state, code_view::code_git_command, code_view::code_open_file, code_view::code_frame_ready, code_view::code_do, code_view::code_did, code_view::code_files,
                        code_canvas::editor_start, code_canvas::editor_input, code_canvas::editor_stop, code_canvas::editor_clipboard,
                        background::background_state, background::background_configure, background::background_autostart, background::background_hide, background::background_quit
                    ];
                    handler(invoke)
                },
                _ => {
                    // A write by the editor is a change the project's history
                    // has to hear about, in either kind of project.
                    code_runtime::note_write(&invoke.message);
                    // A container project: the container answers, or the
                    // command is refused. A local project: the editor's
                    // paths stay inside its folder.
                    if code_runtime::is_isolated(&invoke.message) {
                        return code_runtime::handle(invoke);
                    }
                    if let Err(message) = code_runtime::check_paths(&invoke.message) {
                        invoke.resolver.reject(message);
                        return true;
                    }
                    sidex_lib::handle(invoke)
                }
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            // `--quit` with no SynthOrg running: there is nothing to close, and nothing is started.
            if std::env::args().any(|arg| arg == "--quit") {
                handle.exit(0);
                return Ok(());
            }
            let diagnostics = app.state::<Session>().diagnostics.clone();
            let port = app.state::<Session>().port.clone();
            let child = spawn_sidecar(&handle, &token, &diagnostics, &port);
            *app.state::<Session>().sidecar.lock().unwrap() = child;

            // The window is created hidden and revealed by the frontend once it
            // has painted. This is the safety net: a JavaScript error before
            // that point must not leave the user with an app that has no window
            // at all.
            // Started with the computer: no window, only the icon in the notification area.
            if background::started_hidden() {
                background::tray(&handle);
            }
            let fallback = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(5));
                if background::is_hidden(&fallback) {
                    return;
                }
                if let Some(window) = fallback.get_window("main") {
                    if !window.is_visible().unwrap_or(true) {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("inizializzazione di Tauri non riuscita")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                code_canvas::shutdown(app);
                code_runtime::shutdown(app);
                sidex_lib::shutdown(app);
                if let Some(mut child) = app.state::<Session>().sidecar.lock().unwrap().take() {
                    // The service is told by its pipe closing, stops what it
                    // started (containers, router, local models) and leaves.
                    // Only if it has not done so in time is it ended here.
                    drop(child.stdin.take());
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(25);
                    while std::time::Instant::now() < deadline {
                        if let Ok(Some(_)) = child.try_wait() {
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}

#[cfg(test)]
mod editor_data_tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("synthorg-editor-test-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_editor_data_of_an_earlier_version_are_moved_into_the_memory_once() {
        let root = temp("move");
        let before = root.join("config").join("SynthOrg").join("Code");
        std::fs::create_dir_all(before.join("User")).unwrap();
        std::fs::write(before.join("User").join("settings.json"), "{\"a\":1}").unwrap();
        let memory = root.join("memory");
        let dir = adopt_editor_data(Some(&before), &memory);
        assert_eq!(dir, memory.join("editor"));
        assert_eq!(std::fs::read_to_string(dir.join("User").join("settings.json")).unwrap(), "{\"a\":1}");
        assert!(!before.exists() && !root.join("config").join("SynthOrg").exists());
        // A second start: what is in the memory is what is used, whatever appears in the old place.
        std::fs::create_dir_all(&before).unwrap();
        std::fs::write(before.join("other.json"), "x").unwrap();
        std::fs::write(dir.join("User").join("settings.json"), "{\"a\":2}").unwrap();
        let again = adopt_editor_data(Some(&before), &memory);
        assert_eq!(std::fs::read_to_string(again.join("User").join("settings.json")).unwrap(), "{\"a\":2}");
        assert!(!again.join("other.json").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_memory_is_where_the_data_folder_says_only_if_it_carries_the_mark() {
        let root = temp("where");
        let data = root.join("data");
        let elsewhere = root.join("disk").join("SynthOrg Memoria");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        assert_eq!(memory_dir(&data), data);
        let pointer = serde_json::json!({ "dir": elsewhere.to_string_lossy() }).to_string();
        std::fs::write(data.join("memoria.json"), pointer).unwrap();
        assert_eq!(memory_dir(&data), data, "senza il segno la cartella non si usa");
        std::fs::write(elsewhere.join(".synthorg-memoria"), "x").unwrap();
        assert_eq!(memory_dir(&data), elsewhere);
        assert_eq!(adopt_editor_data(None, &memory_dir(&data)), elsewhere.join("editor"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
