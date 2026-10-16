//! Where the Code editor sits in the window, on Linux.
//!
//! Tauri adds every webview of a window to one vertical GtkBox. A child
//! webview added there has no position of its own: the box gives it a share of
//! the height below the page, and `set_position`/`set_size` do nothing because
//! the box is not a GtkFixed. The editor would take the lower half of the
//! window and squeeze the page into the upper one.
//!
//! So the page is moved into a GtkOverlay, and the editor is laid over it at
//! the bounds the page reports. The overlay asks where each child goes
//! (`get-child-position`) and is given exactly that rectangle: left to its
//! default, it would size the editor by WebKit's natural size, which follows
//! the last allocation and so never shrinks. Everything else (show, hide,
//! navigation, IPC) stays Tauri's.

use gtk::prelude::*;
use std::cell::Cell;
use std::sync::mpsc;
use tauri::{AppHandle, Manager};

const EDITOR: &str = "synthorg-code-editor";

thread_local! {
    /// The editor's rectangle in the window, in GTK (logical) pixels. Only the
    /// GTK main thread reads or writes it.
    static BOUNDS: Cell<(i32, i32, i32, i32)> = const { Cell::new((0, 0, 1, 1)) };
}

fn is_webview(widget: &gtk::Widget) -> bool {
    widget.type_().name() == "WebKitWebView"
}

/// GTK is single-threaded: the work runs on the main thread, the caller waits.
/// Never called from the main thread itself (the commands run on the blocking pool).
fn on_main<T: Send + 'static>(
    app: &AppHandle,
    work: impl FnOnce(&tauri::Window) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let window = app.get_window("main").ok_or("main window unavailable")?;
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || { let _ = tx.send(work(&window)); }).map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

fn overlay_of(vbox: &gtk::Box) -> Option<gtk::Overlay> {
    vbox.children().into_iter().find_map(|child| child.downcast::<gtk::Overlay>().ok())
}

/// Moves the editor webview Tauri has just packed into the window's box over
/// the page, hidden and at `bounds`.
pub fn adopt(app: &AppHandle, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    on_main(app, move |window| {
        let vbox = window.default_vbox().map_err(|e| e.to_string())?;
        let overlay = match overlay_of(&vbox) {
            Some(overlay) => overlay,
            None => {
                // The first webview in the box is the page.
                let page = vbox.children().into_iter().find(is_webview).ok_or("page webview not found")?;
                let overlay = gtk::Overlay::new();
                overlay.connect_get_child_position(|_, child| {
                    if child.widget_name() != EDITOR { return None; }
                    let (x, y, width, height) = BOUNDS.with(Cell::get);
                    Some(gtk::gdk::Rectangle::new(x, y, width, height))
                });
                vbox.remove(&page);
                overlay.add(&page);
                vbox.pack_start(&overlay, true, true, 0);
                overlay.show();
                page.grab_focus();
                overlay
            }
        };
        for editor in vbox.children().into_iter().filter(is_webview) {
            vbox.remove(&editor);
            editor.hide();
            editor.set_widget_name(EDITOR);
            remember(x, y, width, height);
            overlay.add_overlay(&editor);
        }
        Ok(())
    })
}

fn remember(x: f64, y: f64, width: f64, height: f64) {
    // GTK units are logical pixels, like the bounds the page reports.
    BOUNDS.with(|bounds| bounds.set((
        x.round() as i32,
        y.round() as i32,
        width.round().max(1.0) as i32,
        height.round().max(1.0) as i32,
    )));
}

/// Puts the editor at `bounds` inside the window.
pub fn place(app: &AppHandle, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    on_main(app, move |window| {
        let vbox = window.default_vbox().map_err(|e| e.to_string())?;
        let overlay = overlay_of(&vbox).ok_or("editor overlay not found")?;
        let editor = overlay.children().into_iter()
            .find(|child| child.widget_name() == EDITOR)
            .ok_or("editor webview not found")?;
        remember(x, y, width, height);
        editor.queue_resize();
        Ok(())
    })
}
