// SynthOrg without its window.
//
// The phone bridge has two switches. "Connection" keeps it on while the app
// is open. "Service" keeps it on when the app is closed: closing the window
// then hides it instead of ending the app, which goes on without a window
// until it is opened again or closed for good from the icon in the
// notification area. The assistant and the models live in the page, so the
// page stays loaded; while hidden it is asked to hold as little memory as it
// can.
//
// Starting with the computer is a switch of its own, which nothing else
// turns on or off: it writes an entry for the user who is logged in when it
// is turned on, removes it when it is turned off, and is never written or
// rewritten by the app on its own. What the switch shows is what the system
// holds, not what the app remembers. Started that way (`--background`) the
// app shows no window, only the icon.
//
// None of this is on unless the user turns it on: with the service off,
// closing the window ends the app as it always did. With it on, the app never
// goes on unseen: every time the window is closed a Windows notification
// says so, and the icon stays in the notification area, with "Chiudi
// SynthOrg" in its menu.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

const TRAY: &str = "synthorg-background";
const START_ARGUMENT: &str = "--background";
const WINDOW_EVENT: &str = "synthorg-window";

pub struct Background {
    /// The service is on: closing the window hides it.
    service: AtomicBool,
    /// The window is hidden and the app goes on without it.
    hidden: AtomicBool,
    /// What the icon's menu says, in the language of the interface.
    labels: Mutex<Labels>,
}

#[derive(Clone)]
struct Labels {
    open: String,
    quit: String,
    tooltip: String,
    notice_title: String,
    notice: String,
}

impl Default for Background {
    fn default() -> Self {
        let hidden = started_hidden();
        Self {
            // Whether the service is on is what the page says, once it has read the settings.
            service: AtomicBool::new(false),
            hidden: AtomicBool::new(hidden),
            labels: Mutex::new(Labels {
                open: "Apri SynthOrg".into(),
                quit: "Chiudi SynthOrg".into(),
                tooltip: "SynthOrg".into(),
                notice_title: "SynthOrg è ancora attivo".into(),
                notice: "Resta collegato al telefono senza finestra. Per chiuderlo: icona di SynthOrg nell'area di notifica, Chiudi SynthOrg.".into(),
            }),
        }
    }
}

#[derive(Deserialize)]
pub struct Configure {
    service: bool,
    open: Option<String>,
    quit: Option<String>,
    tooltip: Option<String>,
    notice_title: Option<String>,
    notice: Option<String>,
}

#[derive(Serialize)]
pub struct State {
    service: bool,
    hidden: bool,
    /// "off": no entry. "on": the entry is there. "blocked": it is there, and
    /// turned off by the user in the system's own list of what starts.
    autostart: &'static str,
    /// What the entry runs, as it is written in the system.
    entry: Option<String>,
}

/// Whether the app was started with the computer, to stay without a window.
pub fn started_hidden() -> bool {
    std::env::args().any(|argument| argument == START_ARGUMENT)
}

pub fn is_hidden(app: &AppHandle) -> bool {
    app.state::<Background>().hidden.load(Ordering::SeqCst)
}

fn state_of(app: &AppHandle) -> State {
    let background = app.state::<Background>();
    State {
        service: background.service.load(Ordering::SeqCst),
        hidden: background.hidden.load(Ordering::SeqCst),
        autostart: autostart::state(),
        entry: autostart::entry_text(),
    }
}

#[tauri::command]
pub fn background_state(app: AppHandle) -> State {
    state_of(&app)
}

/// The user's own switch: the entry is written, or removed. Nothing else does either.
#[tauri::command]
pub fn background_autostart(app: AppHandle, on: bool) -> Result<State, String> {
    autostart::set(on)?;
    Ok(state_of(&app))
}

/// What the page has read from the settings: whether the service is on.
#[tauri::command]
pub fn background_configure(app: AppHandle, request: Configure) -> Result<State, String> {
    let background = app.state::<Background>();
    background.service.store(request.service, Ordering::SeqCst);
    if let Ok(mut labels) = background.labels.lock() {
        if let Some(text) = request.open.filter(|text| !text.trim().is_empty()) { labels.open = text; }
        if let Some(text) = request.quit.filter(|text| !text.trim().is_empty()) { labels.quit = text; }
        if let Some(text) = request.tooltip.filter(|text| !text.trim().is_empty()) { labels.tooltip = text; }
        if let Some(text) = request.notice_title.filter(|text| !text.trim().is_empty()) { labels.notice_title = text; }
        if let Some(text) = request.notice.filter(|text| !text.trim().is_empty()) { labels.notice = text; }
    }
    // Without a window the icon is what is left to open the app or close it: drawn again, in the words just given.
    if background.hidden.load(Ordering::SeqCst) {
        tray(&app);
    }
    Ok(state_of(&app))
}

/// The header's two ways to close, each saying what it does. This one takes
/// the window away and leaves the app going, with its icon and its notice.
#[tauri::command]
pub fn background_hide(app: AppHandle) {
    hide(&app);
    notify(&app);
}

/// And this one closes everything, whatever the service is set to.
#[tauri::command]
pub fn background_quit(app: AppHandle) {
    app.exit(0);
}

/// The window is asked to close. With the service on it is hidden and the
/// app goes on; the answer says whether the closing was taken over.
pub fn close_requested(app: &AppHandle) -> bool {
    if !app.state::<Background>().service.load(Ordering::SeqCst) {
        return false;
    }
    hide(app);
    notify(app);
    true
}

/// Said every time the window is closed and the app goes on: never unseen.
fn notify(app: &AppHandle) {
    let labels = match app.state::<Background>().labels.lock() {
        Ok(labels) => labels.clone(),
        Err(_) => return,
    };
    if let Err(error) = app.notification().builder().title(&labels.notice_title).body(&labels.notice).show() {
        eprintln!("[SynthOrg] notifica non mostrata: {error}");
    }
}

pub fn hide(app: &AppHandle) {
    app.state::<Background>().hidden.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_window("main") {
        let _ = window.hide();
    }
    memory(app, true);
    tray(app);
    let _ = app.emit(WINDOW_EVENT, serde_json::json!({ "open": false }));
}

pub fn show(app: &AppHandle) {
    app.state::<Background>().hidden.store(false, Ordering::SeqCst);
    let _ = app.remove_tray_by_id(TRAY);
    memory(app, false);
    if let Some(window) = app.get_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit(WINDOW_EVENT, serde_json::json!({ "open": true }));
}

/// The icon in the notification area: the only thing left to see of the app.
pub fn tray(app: &AppHandle) {
    let _ = app.remove_tray_by_id(TRAY);
    let labels = match app.state::<Background>().labels.lock() {
        Ok(labels) => labels.clone(),
        Err(_) => return,
    };
    let built = (|| -> tauri::Result<()> {
        let open = MenuItem::with_id(app, "open", &labels.open, true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", &labels.quit, true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&open, &quit])?;
        let mut builder = TrayIconBuilder::with_id(TRAY)
            .tooltip(&labels.tooltip)
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "open" => show(app),
                "quit" => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                    show(tray.app_handle());
                }
            });
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
        builder.build(app)?;
        Ok(())
    })();
    if let Err(error) = built {
        eprintln!("[SynthOrg] icona nell'area di notifica non creata: {error}");
    }
}

/// While hidden the page is asked to hold little memory; shown, as much as it needs.
#[cfg(windows)]
fn memory(app: &AppHandle, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core::Interface;

    for (_, webview) in app.webviews() {
        let _ = webview.with_webview(move |platform| unsafe {
            let Ok(core) = platform.controller().CoreWebView2() else { return };
            if let Ok(newer) = core.cast::<ICoreWebView2_19>() {
                let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
                let _ = newer.SetMemoryUsageTargetLevel(level);
            }
        });
    }
}

#[cfg(not(windows))]
fn memory(_app: &AppHandle, _low: bool) {}

/// Starting with the computer, for the user who is logged in and nobody else.
mod autostart {
    use super::START_ARGUMENT;
    use std::process::Command;

    fn command_line() -> Result<String, String> {
        let exe = std::env::current_exe().map_err(|error| format!("percorso dell'app non trovato: {error}"))?;
        Ok(format!("\"{}\" {START_ARGUMENT}", exe.display()))
    }

    #[cfg(windows)]
    const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    #[cfg(windows)]
    const VALUE: &str = "SynthOrg";

    #[cfg(windows)]
    fn reg(arguments: &[&str]) -> Result<std::process::Output, String> {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        Command::new("reg.exe")
            .args(arguments)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|error| format!("registro non raggiungibile: {error}"))
    }

    #[cfg(windows)]
    const APPROVED_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

    /// What the value holds in the registry, as the registry prints it.
    #[cfg(windows)]
    fn value_of(key: &str) -> Option<String> {
        let output = reg(&["query", key, "/v", VALUE]).ok()?;
        if !output.status.success() {
            return None;
        }
        printed_value(&String::from_utf8_lossy(&output.stdout), VALUE)
    }

    /// The data of `name` in what `reg query` prints: a line with the name, the type and the data.
    #[cfg(any(windows, test))]
    pub(super) fn printed_value(text: &str, name: &str) -> Option<String> {
        let line = text.lines().find(|line| line.split_whitespace().next() == Some(name))?;
        let mut parts = line.split_whitespace();
        parts.next()?;
        parts.next()?;
        let data = parts.collect::<Vec<_>>().join(" ");
        if data.is_empty() { None } else { Some(data) }
    }

    /// Whether the system's list of what starts says "turned off": an odd first byte.
    #[cfg(any(windows, test))]
    pub(super) fn says_off(data: &str) -> bool {
        data.get(0..2).and_then(|hex| u8::from_str_radix(hex, 16).ok()).map(|first| first % 2 == 1).unwrap_or(false)
    }

    #[cfg(windows)]
    pub fn enabled() -> bool {
        value_of(RUN_KEY).is_some()
    }

    #[cfg(windows)]
    pub fn entry_text() -> Option<String> {
        value_of(RUN_KEY)
    }

    /// The system keeps its own list of what the user has turned off among
    /// what starts: an odd first byte there means turned off.
    #[cfg(windows)]
    fn blocked() -> bool {
        value_of(APPROVED_KEY).map(|data| says_off(&data)).unwrap_or(false)
    }

    #[cfg(not(windows))]
    fn blocked() -> bool {
        false
    }

    #[cfg(not(windows))]
    pub fn entry_text() -> Option<String> {
        entry().filter(|path| path.is_file()).map(|path| path.display().to_string())
    }

    pub fn state() -> &'static str {
        if !enabled() {
            "off"
        } else if blocked() {
            "blocked"
        } else {
            "on"
        }
    }

    #[cfg(windows)]
    pub fn set(on: bool) -> Result<(), String> {
        if on {
            let line = command_line()?;
            let output = reg(&["add", RUN_KEY, "/v", VALUE, "/t", "REG_SZ", "/d", &line, "/f"])?;
            if !output.status.success() {
                return Err(format!("avvio con il computer non impostato: {}", String::from_utf8_lossy(&output.stderr).trim()));
            }
        } else if enabled() {
            let output = reg(&["delete", RUN_KEY, "/v", VALUE, "/f"])?;
            if !output.status.success() {
                return Err(format!("avvio con il computer non tolto: {}", String::from_utf8_lossy(&output.stderr).trim()));
            }
        }
        Ok(())
    }

    /// A file of ours in the user's own folder: nothing of the system is touched.
    #[cfg(not(windows))]
    fn entry() -> Option<std::path::PathBuf> {
        let home = std::path::PathBuf::from(std::env::var_os("HOME")?);
        #[cfg(target_os = "macos")]
        return Some(home.join("Library/LaunchAgents/org.synthorg.orchestrator.background.plist"));
        #[cfg(not(target_os = "macos"))]
        {
            let config = std::env::var_os("XDG_CONFIG_HOME").map(std::path::PathBuf::from).unwrap_or_else(|| home.join(".config"));
            Some(config.join("autostart/synthorg-background.desktop"))
        }
    }

    #[cfg(not(windows))]
    pub fn enabled() -> bool {
        entry().map(|path| path.is_file()).unwrap_or(false)
    }

    #[cfg(not(windows))]
    pub fn set(on: bool) -> Result<(), String> {
        let Some(path) = entry() else { return Err("cartella dell'utente non trovata".into()) };
        if !on {
            if path.is_file() {
                std::fs::remove_file(&path).map_err(|error| format!("avvio con il computer non tolto: {error}"))?;
            }
            return Ok(());
        }
        let exe = std::env::current_exe().map_err(|error| format!("percorso dell'app non trovato: {error}"))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| format!("avvio con il computer non impostato: {error}"))?;
        }
        #[cfg(target_os = "macos")]
        let text = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>Label</key><string>org.synthorg.orchestrator.background</string>\n<key>ProgramArguments</key><array><string>{}</string><string>{START_ARGUMENT}</string></array>\n<key>RunAtLoad</key><true/>\n</dict></plist>\n",
            exe.display()
        );
        #[cfg(not(target_os = "macos"))]
        let text = format!(
            "[Desktop Entry]\nType=Application\nName=SynthOrg\nComment=SynthOrg senza finestra, per il ponte col telefono\nExec={}\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n",
            command_line()?
        );
        let _ = &exe;
        std::fs::write(&path, text).map_err(|error| format!("avvio con il computer non impostato: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::autostart;

    #[test]
    fn what_the_registry_prints_is_read_as_it_is() {
        let run = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    SynthOrgOther    REG_SZ    other.exe\r\n    SynthOrg    REG_SZ    \"C:\\Program Files\\SynthOrg\\synthorg.exe\" --background\r\n\r\n";
        assert_eq!(
            autostart::printed_value(run, "SynthOrg").as_deref(),
            Some("\"C:\\Program Files\\SynthOrg\\synthorg.exe\" --background")
        );
        assert_eq!(autostart::printed_value(run, "Synth"), None);
        assert_eq!(autostart::printed_value("ERROR: The system was unable to find the specified registry key or value.", "SynthOrg"), None);
    }

    #[test]
    fn what_the_user_turned_off_in_the_system_is_seen() {
        assert!(autostart::says_off("0300000041A9CA2C1FACDC01"));
        assert!(!autostart::says_off("020000000000000000000000"));
        assert!(!autostart::says_off(""));
        assert!(!autostart::says_off("zz"));
    }

    /// Writes to the system: run on purpose (`cargo test -- --ignored`), never with the others.
    #[test]
    #[ignore]
    fn the_entry_is_written_read_back_and_removed() {
        assert_eq!(autostart::state(), "off", "an entry is already there: not touched");
        autostart::set(true).unwrap();
        let written = autostart::entry_text();
        let state = autostart::state();
        autostart::set(false).unwrap();
        assert_eq!(state, "on");
        let written = written.expect("nothing was written");
        assert!(written.ends_with("--background"), "{written}");
        assert!(written.contains(&std::env::current_exe().unwrap().display().to_string()), "{written}");
        assert_eq!(autostart::state(), "off");
        assert_eq!(autostart::entry_text(), None);
    }
}
