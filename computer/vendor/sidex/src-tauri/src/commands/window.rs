use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use super::storage::StorageDb;

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn create_window(
    app: AppHandle,
    label: String,
    title: String,
    url: Option<String>,
) -> Result<(), String> {
    let webview_url = match url {
        Some(u) => WebviewUrl::External(u.parse().map_err(|e| format!("Invalid URL: {e}"))?),
        None => WebviewUrl::default(),
    };

    let builder = WebviewWindowBuilder::new(&app, &label, webview_url)
        .title(&title)
        .inner_size(1200.0, 800.0);

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false).shadow(true);

    builder
        .build()
        .map_err(|e| format!("Failed to create window '{label}': {e}"))?;

    Ok(())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn close_window(app: AppHandle, label: String) -> Result<(), String> {
    let window = app
        .get_window(&label)
        .ok_or_else(|| format!("Window '{label}' not found"))?;

    window
        .close()
        .map_err(|e| format!("Failed to close window '{label}': {e}"))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

const WINDOW_STATE_KEY: &str = "sidex.windowState";

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn save_window_state(
    app: AppHandle,
    label: String,
    db: tauri::State<'_, Arc<StorageDb>>,
) -> Result<(), String> {
    let window = app
        .get_window(&label)
        .ok_or_else(|| format!("window '{label}' not found"))?;

    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let maximized = window.is_maximized().unwrap_or(false);

    let state = WindowState {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        maximized,
    };

    let json = serde_json::to_string(&state).map_err(|e| e.to_string())?;
    db.set(WINDOW_STATE_KEY, &json)?;
    Ok(())
}
