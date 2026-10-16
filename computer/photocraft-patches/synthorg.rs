//! SynthOrg's side of photocraft in the page.
//!
//! photocraft runs here as its web build, inside the Foto tab of SynthOrg's
//! Studio section: one canvas in a frame of the page, not a window. This file
//! is what SynthOrg adds to that build (scripts/build-photocraft.js copies it
//! in and wires it): the three things the page needs from the app and the app
//! cannot get from a browser on its own.
//!
//! - The control channel. The desktop app answers a JSON line protocol on a
//!   socket; a page has no socket to listen on, so the same requests come in
//!   through `window.synthorgPhotocraft.control(method, paramsJson)`, which
//!   returns a promise of the same reply.
//! - The look. `look(json)` takes SynthOrg's colours as photocraft's own
//!   tokens and lays them over the theme every frame, so the app is painted
//!   in the page's colours and follows them when they change.
//! - Files. Reads and writes of the control channel go through the page:
//!   `put(path, bytes)` hands in what `app.open {path}` will read, and what
//!   `app.save {path}` (and File › Save) writes is given to
//!   `window.synthorgHost.write(path, bytes)`, which stores it in the project
//!   folder instead of a download.
//! - SynthOrg's functions. The ones in the editor's menus that need a pod
//!   (crates/ui-egui/src/synthorg.rs) are handed to
//!   `window.synthorgHost.command(id, paramsJson)`.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::mpsc::{Receiver, Sender, TryRecvError};

use egui::Color32;
use photocraft_ui_egui::theme::{ThemeKind, Tokens};
use photocraft_ui_egui::{ControlRequest, ControlResponse, PhotocraftApp};
use serde_json::Value;
use wasm_bindgen::JsCast as _;
use wasm_bindgen::prelude::*;

type Waiting = (Receiver<ControlResponse>, js_sys::Function, js_sys::Function);

#[derive(Default)]
struct Bridge {
    /// Requests the page made, for the app to drain on its next frame.
    requests: Option<Sender<ControlRequest>>,
    /// Replies still to come, with the promise each one settles.
    waiting: Vec<Waiting>,
    /// The look the page asked for: the theme it sits on, and the tokens laid over it.
    look: Option<(ThemeKind, Value)>,
    /// Files the page handed in for `app.open {path}`.
    files: HashMap<String, Vec<u8>>,
    ctx: Option<egui::Context>,
}

thread_local! {
    static BRIDGE: RefCell<Bridge> = RefCell::default();
}

fn js_err(text: &str) -> JsValue {
    js_sys::Error::new(text).into()
}

/// Wires the app to the page and publishes `window.synthorgPhotocraft`.
pub fn attach(app: PhotocraftApp, ctx: &egui::Context) -> PhotocraftApp {
    let (tx, rx) = std::sync::mpsc::channel::<ControlRequest>();
    BRIDGE.with(|b| {
        let mut b = b.borrow_mut();
        b.requests = Some(tx);
        b.ctx = Some(ctx.clone());
    });
    let mut app = app.with_control(rx);
    app.services.automation_read = Some(Box::new(|path: &str| {
        let bytes = BRIDGE.with(|b| b.borrow_mut().files.remove(path)).ok_or_else(|| format!("`{path}` was not handed in by the page"))?;
        let name = path.rsplit('/').next().unwrap_or(path).to_string();
        Ok((name, bytes))
    }));
    app.services.automation_write = Some(Box::new(|path: &str, bytes: &[u8]| host_write(path, bytes)));
    // The functions of SynthOrg's picked from the editor's menus: the page carries them out.
    photocraft_ui_egui::synthorg::set_host(Box::new(|id: &str, params: &str| {
        let f = host_function("command").ok_or("the page runs no functions (synthorgHost.command is missing)")?;
        f.call2(&JsValue::NULL, &JsValue::from_str(id), &JsValue::from_str(params)).map(|_| ()).map_err(|e| format!("{e:?}"))
    }));
    publish();
    app
}

/// What File › Save writes: to the page when it takes it, otherwise `None` and the caller downloads as before.
pub fn write(path: &str, bytes: &[u8]) -> Option<Result<(), String>> {
    host_function("write").map(|_| host_write(path, bytes))
}

fn host_function(name: &str) -> Option<js_sys::Function> {
    let window = web_sys::window()?;
    let host = js_sys::Reflect::get(&window, &JsValue::from_str("synthorgHost")).ok()?;
    if host.is_undefined() || host.is_null() {
        return None;
    }
    js_sys::Reflect::get(&host, &JsValue::from_str(name)).ok()?.dyn_into::<js_sys::Function>().ok()
}

fn host_write(path: &str, bytes: &[u8]) -> Result<(), String> {
    let f = host_function("write").ok_or("the page takes no files (synthorgHost.write is missing)")?;
    f.call2(&JsValue::NULL, &JsValue::from_str(path), &js_sys::Uint8Array::from(bytes)).map(|_| ()).map_err(|e| format!("{e:?}"))
}

fn publish() {
    let Some(window) = web_sys::window() else { return };
    let api = js_sys::Object::new();
    let set = |name: &str, f: &JsValue| {
        let _ = js_sys::Reflect::set(&api, &JsValue::from_str(name), f);
    };

    let control = Closure::<dyn FnMut(String, String) -> js_sys::Promise>::new(|method: String, params: String| {
        js_sys::Promise::new(&mut |resolve, reject| {
            let params: Value = match serde_json::from_str(if params.is_empty() { "{}" } else { &params }) {
                Ok(v) => v,
                Err(e) => {
                    let _ = reject.call1(&JsValue::NULL, &js_err(&format!("params are not JSON: {e}")));
                    return;
                }
            };
            let (request, reply) = ControlRequest::new(method.clone(), params);
            BRIDGE.with(|b| {
                let mut b = b.borrow_mut();
                match b.requests.as_ref().map(|tx| tx.send(request)) {
                    Some(Ok(())) => {
                        b.waiting.push((reply, resolve.clone(), reject.clone()));
                        if let Some(ctx) = &b.ctx {
                            ctx.request_repaint();
                        }
                    }
                    _ => {
                        let _ = reject.call1(&JsValue::NULL, &js_err("photocraft is not running"));
                    }
                }
            });
        })
    });
    set("control", control.as_ref());
    control.forget();

    let look = Closure::<dyn FnMut(String) -> bool>::new(|json: String| {
        let Ok(v) = serde_json::from_str::<Value>(&json) else { return false };
        let kind = match v.get("theme").and_then(Value::as_str) {
            Some("studioLight") => ThemeKind::StudioLight,
            Some("studio") => ThemeKind::Studio,
            Some("proMedium") => ThemeKind::ProMedium,
            _ => ThemeKind::Pro,
        };
        let tokens = v.get("tokens").cloned().unwrap_or(Value::Null);
        BRIDGE.with(|b| {
            let mut b = b.borrow_mut();
            b.look = Some((kind, tokens));
            if let Some(ctx) = &b.ctx {
                ctx.request_repaint();
            }
        });
        true
    });
    set("look", look.as_ref());
    look.forget();

    let put = Closure::<dyn FnMut(String, js_sys::Uint8Array)>::new(|path: String, bytes: js_sys::Uint8Array| {
        BRIDGE.with(|b| b.borrow_mut().files.insert(path, bytes.to_vec()));
    });
    set("put", put.as_ref());
    put.forget();

    let _ = js_sys::Reflect::set(&window, &JsValue::from_str("synthorgPhotocraft"), &api);
    if let Some(ready) = host_function("ready") {
        let _ = ready.call0(&JsValue::NULL);
    }
}

fn color(v: &Value) -> Option<Color32> {
    let s = v.as_str()?.trim_start_matches('#');
    let b = |i: usize| u8::from_str_radix(s.get(i..i + 2)?, 16).ok();
    match s.len() {
        6 => Some(Color32::from_rgb(b(0)?, b(2)?, b(4)?)),
        8 => Some(Color32::from_rgba_unmultiplied(b(0)?, b(2)?, b(4)?, b(6)?)),
        _ => None,
    }
}

/// SynthOrg's tokens over the theme's own. Only the fields the page sent are touched.
fn overlay(t: &mut Tokens, v: &Value) {
    macro_rules! colors {
        ($($field:ident),* $(,)?) => {
            $( if let Some(c) = v.get(stringify!($field)).and_then(color) { t.$field = c; } )*
        };
    }
    colors!(
        chrome, canvas, canvas_dot, dock, card, card_border, field, field_border, hover, pressed, text, text_dim, text_faint, icon, accent, accent_soft,
        accent_border, accent_text, separator, shadow, primary_bg, primary_text, danger, tab_strip, row_selected,
    );
}

/// Once a frame, before the app's own logic: the look, and the replies that have arrived.
pub fn tick(app: &mut PhotocraftApp, ctx: &egui::Context) {
    let look = BRIDGE.with(|b| b.borrow().look.clone());
    if let Some((kind, tokens)) = look {
        // The theme is a preference the app keeps in step with what it shows: set through it, or it comes back.
        if app.ui.theme != kind {
            let name = match kind {
                ThemeKind::StudioLight => "studioLight",
                ThemeKind::Studio => "studio",
                ThemeKind::ProMedium => "proMedium",
                _ => "pro",
            };
            let _ = app.run("prefs.set", serde_json::json!({"values": {"interface.theme": name}}));
            app.set_theme(ctx, kind);
        }
        // The theme's own tokens are written whenever it is applied; ours go back on top every frame.
        let mut t = Tokens::get(ctx);
        overlay(&mut t, &tokens);
        ctx.data_mut(|d| d.insert_temp(egui::Id::new("photocraft-theme"), t));
    }

    BRIDGE.with(|b| {
        let mut b = b.borrow_mut();
        let mut still = Vec::new();
        for (reply, resolve, reject) in b.waiting.drain(..) {
            match reply.try_recv() {
                Ok(value) => {
                    let _ = resolve.call1(&JsValue::NULL, &JsValue::from_str(&value.to_string()));
                }
                Err(TryRecvError::Empty) => still.push((reply, resolve, reject)),
                Err(TryRecvError::Disconnected) => {
                    let _ = reject.call1(&JsValue::NULL, &js_err("photocraft dropped the request"));
                }
            }
        }
        if !still.is_empty() {
            ctx.request_repaint();
        }
        b.waiting = still;
    });
}

/// A handle kept so the closures above can be told apart from an unused import by the compiler.
#[allow(dead_code)]
pub type Shared = Rc<RefCell<()>>;
