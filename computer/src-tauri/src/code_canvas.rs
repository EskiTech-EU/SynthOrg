//! The editor of a container project.
//!
//! The whole editor is a process inside the project's container (see
//! `server/code-editor`). It has no window: its stdout is a stream of changed
//! pixels, its stdin is keyboard and mouse. This module starts it through
//! `engine exec -i`, hands complete frames to the SynthOrg page, which paints
//! them on a canvas, and forwards the page's input.
//!
//! Nothing here interprets what the container sends beyond framing it: the
//! only thing that can come out of a project is an image.

use crate::code_runtime::RuntimeSpec;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::State;

/// Editor -> host message types (server/code-editor/gfx.c).
const OUT_FRAME: u8 = 4;
/// Sent to the page, never by the editor: the process ended; the rest is its stderr.
const ENDED: u8 = 0xFF;
/// Host -> editor: leave, keeping unsaved text for the next start.
const IN_QUIT: [u8; 3] = [9, 0, 0];

/// One message is at most a full-screen rectangle; one frame a few of them.
const MAX_MESSAGE: usize = 8192 * 8192 * 3 + 64;
const MAX_FRAME: usize = MAX_MESSAGE * 2;

struct Running {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct CanvasEditor(Mutex<Option<Running>>);

fn stop_running(running: Option<Running>) {
    let Some(mut running) = running else { return };
    // Ask first, so unsaved text is written to the editor's recovery store.
    let _ = running.stdin.write_all(&IN_QUIT);
    let _ = running.stdin.flush();
    drop(running.stdin);
    for _ in 0..20 {
        if matches!(running.child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    let _ = running.child.kill();
    let _ = running.child.wait();
}

/// Reads one `u8 type, u32 length, payload` message into `frame`. `Ok(None)` at end of stream.
fn read_message(stdout: &mut impl Read, frame: &mut Vec<u8>) -> std::io::Result<Option<u8>> {
    let mut header = [0u8; 5];
    match stdout.read_exact(&mut header) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_le_bytes([header[1], header[2], header[3], header[4]]) as usize;
    if length > MAX_MESSAGE || frame.len() + length > MAX_FRAME {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "editor stream out of bounds"));
    }
    frame.extend_from_slice(&header);
    let start = frame.len();
    frame.resize(start + length, 0);
    stdout.read_exact(&mut frame[start..])?;
    Ok(Some(header[0]))
}

/// Starts the editor of a container project. Frames arrive on `frames`, each
/// one a complete, self-contained batch of drawing messages.
#[tauri::command]
pub async fn editor_start(
    state: State<'_, Arc<CanvasEditor>>,
    runtime: RuntimeSpec,
    title: Option<String>,
    frames: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let container = runtime.validate()?.ok_or("the canvas editor only serves container projects")?;
    let previous = state.0.lock().unwrap_or_else(|e| e.into_inner()).take();
    stop_running(previous);

    let mut child = container
        .editor_command(title.as_deref())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("editor: {e}"))?;
    let stdin = child.stdin.take().ok_or("editor: no stdin")?;
    let mut stdout = child.stdout.take().ok_or("editor: no stdout")?;
    let mut stderr = child.stderr.take().ok_or("editor: no stderr")?;

    let errors = Arc::new(Mutex::new(String::new()));
    let errors_writer = errors.clone();
    std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        let tail: String = text.chars().rev().take(2000).collect::<String>().chars().rev().collect();
        *errors_writer.lock().unwrap_or_else(|e| e.into_inner()) = tail;
    });

    std::thread::spawn(move || {
        let mut frame: Vec<u8> = Vec::with_capacity(1 << 16);
        let reason = loop {
            match read_message(&mut stdout, &mut frame) {
                Ok(Some(OUT_FRAME)) => {
                    let complete = std::mem::replace(&mut frame, Vec::with_capacity(1 << 16));
                    if frames.send(InvokeResponseBody::Raw(complete)).is_err() {
                        break String::new(); // the page is gone
                    }
                }
                Ok(Some(_)) => {}
                Ok(None) => break String::new(),
                Err(error) => break error.to_string(),
            }
        };
        // stderr closes with the process; give its reader a moment to finish.
        std::thread::sleep(std::time::Duration::from_millis(150));
        let mut ended = vec![ENDED];
        let detail = errors.lock().unwrap_or_else(|e| e.into_inner()).clone();
        ended.extend_from_slice(if detail.trim().is_empty() { reason.as_bytes() } else { detail.trim().as_bytes() });
        let _ = frames.send(InvokeResponseBody::Raw(ended));
    });

    *state.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(Running { child, stdin });
    Ok(())
}

/// Keyboard, mouse, size and theme, already in the editor's wire format.
#[tauri::command]
pub fn editor_input(state: State<'_, Arc<CanvasEditor>>, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("editor input must be raw bytes".into());
    };
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let running = guard.as_mut().ok_or("editor not running")?;
    running
        .stdin
        .write_all(bytes)
        .and_then(|()| running.stdin.flush())
        .map_err(|e| format!("editor input: {e}"))
}

#[tauri::command]
pub async fn editor_stop(state: State<'_, Arc<CanvasEditor>>) -> Result<(), String> {
    let running = state.0.lock().unwrap_or_else(|e| e.into_inner()).take();
    tauri::async_runtime::spawn_blocking(move || stop_running(running))
        .await
        .map_err(|e| e.to_string())
}

/// The text on this machine's clipboard, for Paste chosen from the editor's own
/// menu (a keyboard paste brings it with the browser's paste event). Asked by
/// the page directly, so reading it never shows the webview's permission prompt.
/// It only ever flows into the container, as a paste does.
#[tauri::command]
pub fn editor_clipboard() -> Result<String, String> {
    clipboard_text()
}

#[cfg(windows)]
fn clipboard_text() -> Result<String, String> {
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    const CF_UNICODETEXT: u32 = 13;
    // SAFETY: the clipboard is opened, read while locked and released on every path.
    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err("clipboard busy".into());
        }
        let handle = GetClipboardData(CF_UNICODETEXT);
        let text = if handle.is_null() {
            String::new()
        } else {
            let data = GlobalLock(handle) as *const u16;
            if data.is_null() {
                String::new()
            } else {
                let mut len = 0usize;
                while *data.add(len) != 0 {
                    len += 1;
                }
                let text = String::from_utf16_lossy(std::slice::from_raw_parts(data, len));
                GlobalUnlock(handle);
                text
            }
        };
        CloseClipboard();
        Ok(text)
    }
}

#[cfg(not(windows))]
fn clipboard_text() -> Result<String, String> {
    Err("not available on this system".into())
}

/// On application exit: the editor leaves cleanly, so unsaved text survives.
pub fn shutdown(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(state) = app.try_state::<Arc<CanvasEditor>>() {
        let running = state.0.lock().unwrap_or_else(|e| e.into_inner()).take();
        stop_running(running);
    }
}
