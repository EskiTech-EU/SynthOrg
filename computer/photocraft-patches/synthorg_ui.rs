//! SynthOrg's functions, inside the editor.
//!
//! The functions SynthOrg adds to photocraft (the first ones use a model that
//! runs in a pod, outside the page) are commands of the shell like any other:
//! they sit in the menus, they answer on the control channel, and what they
//! change is one step of the document's history.
//!
//! Two kinds of command live here.
//!
//! - The ones a person picks from a menu (`HOST_COMMANDS`). The work needs
//!   the pod, so the command only hands the request to the page
//!   (`set_host`), which carries it out with the commands below.
//! - The ones the page needs and a web build does not have, because upstream
//!   writes them against a file system: the pixels of one layer out
//!   (`synthorg.layerImage`), a matte in as a layer mask or a selection
//!   (`synthorg.matte`), an image in as a layer (`synthorg.place`). A matte
//!   comes from a model that looked at the picture small, so its edges are
//!   those of an enlargement: before it is used they are brought onto the
//!   picture's own, at full size, by the editor's Select and Mask (the guided
//!   filter of `photocraft_algo::matting`). Files go
//!   through the same two calls the control channel already uses, so the
//!   page decides where they come from and where they end.

use std::cell::RefCell;

use photocraft_algo::matting::{self, RefineParams};
use photocraft_algo::segment::{Sampler, SurfaceSampler};
use photocraft_algo::selection as sel;
use photocraft_color::BlendMode;
use photocraft_doc::{Document, LayerContent, LayerId, LayerMask};
use photocraft_engine::EngineError;
use photocraft_geom::Rect;
use serde_json::{Value, json};

use crate::PhotocraftApp;

/// The page's side of a menu command: its id and its params as JSON.
pub type HostFn = Box<dyn Fn(&str, &str) -> Result<(), String>>;

thread_local! {
    static HOST: RefCell<Option<HostFn>> = RefCell::default();
}

/// Who carries out the commands that need the pod.
pub fn set_host(f: HostFn) {
    HOST.with(|h| *h.borrow_mut() = Some(f));
}

/// Commands picked from the menus and carried out by the page.
const HOST_COMMANDS: [&str; 3] = ["synthorg.removeBackground", "synthorg.selectSubject", "synthorg.selectObject"];

/// Rows read at a time from a matte: bounds the memory a large one takes.
const STRIP_ROWS: u32 = 256;

/// The band around a matte's edge that is fitted to the picture, in pixels, for a matte whose
/// longer side is `side`: wider on a large picture, where the model's edge is a larger blur.
fn refine_radius(side: u32) -> f32 {
    (side as f32 / 300.0).clamp(2.0, 24.0)
}

/// Every visible layer together, for a matte that was made from the whole document.
struct Composite<'a>(&'a Document);

impl Sampler for Composite<'_> {
    fn rgba(&self, r: Rect) -> Vec<[f32; 4]> {
        photocraft_compose::render(self.0, r).px
    }
}

pub fn handles(id: &str) -> bool {
    id.starts_with("synthorg.")
}

pub fn is_enabled(app: &PhotocraftApp, id: &str) -> Option<bool> {
    if !handles(id) {
        return None;
    }
    let doc = app.session.active();
    Some(match id {
        "synthorg.status" => true,
        "synthorg.removeBackground" => doc.is_some_and(|d| d.active_layer.is_some()),
        // The object is the one the selection is drawn around: without a selection there is nothing to point at.
        "synthorg.selectObject" => doc.is_some_and(|d| d.doc.selection.is_some()),
        _ => doc.is_some(),
    })
}

pub fn menu(app: &mut PhotocraftApp, id: &str, params: &Value) -> Option<Result<Value, String>> {
    if !handles(id) {
        return None;
    }
    Some(match id {
        "synthorg.layerImage" => layer_image(app, params),
        "synthorg.matte" => matte(app, params),
        "synthorg.place" => place(app, params),
        "synthorg.status" => {
            app.ui.status = params.get("text").and_then(Value::as_str).unwrap_or_default().to_string();
            app.ui.status_error = params.get("error").and_then(Value::as_bool) == Some(true);
            Ok(Value::Null)
        }
        id if HOST_COMMANDS.contains(&id) => HOST.with(|h| match h.borrow().as_ref() {
            Some(f) => f(id, &params.to_string()).map(|()| json!({"started": true})),
            None => Err("this function needs SynthOrg around the editor".to_string()),
        }),
        _ => Err(format!("unknown command `{id}`")),
    })
}

fn path_param(p: &Value) -> Result<String, String> {
    p.get("path").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string).ok_or_else(|| "missing `path`".to_string())
}

fn layer_param(app: &PhotocraftApp, p: &Value) -> Result<LayerId, String> {
    let st = app.session.active().ok_or("no document open")?;
    let id = p.get("layer").and_then(Value::as_u64).map(LayerId).or(st.active_layer).ok_or("no active layer")?;
    st.doc.layer(id).map(|_| id).ok_or_else(|| format!("no layer {}", id.0))
}

fn bounds_json(r: Rect) -> Value {
    json!([r.x0, r.y0, r.width(), r.height()])
}

/// One layer alone on the document's canvas, or the whole document (`"layer": "merged"`), as a
/// PNG handed to the page. A layer comes without its mask: the function that asks for it is
/// about to make one.
fn layer_image(app: &mut PhotocraftApp, p: &Value) -> Result<Value, String> {
    let path = path_param(p)?;
    let merged = p.get("layer").and_then(Value::as_str) == Some("merged");
    let id = if merged { None } else { Some(layer_param(app, p)?) };
    let st = app.session.active().ok_or("no document open")?;
    let mut tmp: Document = (*st.doc).clone();
    tmp.selection = None;
    let mut name = st.doc.name.clone();
    let mut has_mask = false;
    if let Some(id) = id {
        let l = st.doc.layer(id).ok_or_else(|| format!("no layer {}", id.0))?;
        if matches!(l.content, LayerContent::Adjustment(_)) {
            return Err(format!("\"{}\" is an adjustment layer: it has no pixels of its own", l.name));
        }
        let mut alone = l.clone();
        alone.visible = true;
        alone.blend = if alone.is_group() { BlendMode::PassThrough } else { BlendMode::Normal };
        alone.clipped = false;
        alone.opacity = 1.0;
        has_mask = alone.mask.is_some();
        alone.mask = None;
        name = alone.name.clone();
        tmp.layers = vec![alone];
    }
    let selection = st.doc.selection.as_ref().map(|s| s.content_bounds().intersect(&st.doc.bounds())).filter(|r| !r.is_empty());
    let (width, height) = (st.doc.size.width, st.doc.size.height);
    let export = app.services.export.as_ref().ok_or("this build cannot encode images")?;
    let (bytes, _) = export(&tmp, "layer.png", &Default::default())?;
    let write = app.services.automation_write.as_mut().ok_or("the page takes no files")?;
    write(&path, &bytes)?;
    Ok(json!({
        "path": path, "layer": id.map(|i| i.0), "name": name, "width": width, "height": height,
        "bytes": bytes.len(), "hasMask": has_mask, "selection": selection.map(bounds_json),
    }))
}

/// A matte (an image whose alpha says what to keep) becomes the layer's mask or the document's
/// selection, in one step. `offset` is where the matte's top-left corner sits on the canvas, for a
/// matte made from a part of it. With `constrain` (the default) a selection the document already
/// has limits the result to its inside. With `refine` the matte's edge is fitted to
/// the picture at full size; `radius` is the band in pixels (by default from the picture's size).
fn matte(app: &mut PhotocraftApp, p: &Value) -> Result<Value, String> {
    let path = path_param(p)?;
    let as_selection = p.get("output").and_then(Value::as_str) == Some("selection");
    let constrain = p.get("constrain").and_then(Value::as_bool) != Some(false);
    let id = if as_selection { None } else { Some(layer_param(app, p)?) };
    let read = app.services.automation_read.as_mut().ok_or("the page hands in no files")?;
    let (name, bytes) = read(&path)?;
    let svg_depth = app.session.prefs().file_handling.rasterize_svg_groups_deeper_than as usize;
    let import = app.services.import.as_ref().ok_or("this build cannot decode images")?;
    // A matte is pixels: the depth SVG groups are kept to, which the editor's own opening of a file takes from the
    // preferences, is asked for by the signature and changes nothing here.
    let (src, _) = import(&name, &bytes, svg_depth).map_err(|e| format!("{name}: {e}"))?;
    drop(bytes);
    let (mw, mh) = (src.size.width, src.size.height);
    let surface = src.layers.first().and_then(|l| l.surface()).ok_or("the matte has no pixels")?;
    let offset = |i: usize| p.get("offset").and_then(Value::as_array).and_then(|a| a.get(i)).and_then(Value::as_i64).unwrap_or(0);
    let (ox, oy) = (i32::try_from(offset(0)).map_err(|_| "bad `offset`")?, i32::try_from(offset(1)).map_err(|_| "bad `offset`")?);
    let st = app.session.active().ok_or("no document open")?;
    let canvas = st.doc.bounds();
    let area = Rect::from_xywh(ox, oy, mw, mh);
    if area.is_empty() || area.intersect(&canvas) != area {
        return Err("the matte does not fit the document".to_string());
    }

    let w = mw as usize;
    let mut plane = vec![0.0f32; w * mh as usize];
    let mut strip = vec![[0.0f32; 4]; w * STRIP_ROWS as usize];
    let mut y = 0u32;
    while y < mh {
        let rows = STRIP_ROWS.min(mh - y);
        let n = w * rows as usize;
        let Some(buf) = strip.get_mut(..n) else { break };
        surface.read_rgba_into(Rect::from_xywh(0, i32::try_from(y).unwrap_or(i32::MAX), mw, rows), buf);
        if let Some(out) = plane.get_mut(w * y as usize..w * y as usize + n) {
            for (o, px) in out.iter_mut().zip(buf.iter()) {
                *o = px[3];
            }
        }
        y += rows;
    }
    drop(strip);
    let constrained = constrain && st.doc.selection.is_some();
    if constrained {
        let inside = sel::mask_from_surface(st.doc.selection.as_ref(), area);
        for (o, m) in plane.iter_mut().zip(inside) {
            *o *= m;
        }
    }
    if !plane.iter().any(|v| *v > 0.02) {
        return Err(if constrained { "nothing was found inside the selection".to_string() } else { "no subject was found".to_string() });
    }
    let mut result = sel::mask_to_surface(&plane, area);
    drop(plane);
    let refine = p.get("refine").and_then(Value::as_bool) == Some(true);
    let mut radius = 0.0;
    if refine {
        radius = p.get("radius").and_then(Value::as_f64).map_or_else(|| refine_radius(mw.max(mh)), |v| (v as f32).clamp(0.5, 64.0));
        let params = RefineParams { radius, smart_radius: true, ..RefineParams::default() };
        let reader = matting::surface_reader(&result);
        // The guide is what the matte was made from: the layer's own pixels, or the whole document.
        let own = id.and_then(|id| st.doc.layer(id)).and_then(|l| l.surface());
        let refined = match own {
            Some(surface) => matting::refine_mask(&SurfaceSampler(surface), &reader, result.content_bounds(), canvas, &params),
            None => matting::refine_mask(&Composite(&st.doc), &reader, result.content_bounds(), canvas, &params),
        };
        drop(reader);
        if let Some(region) = refined {
            result = matting::region_surface(&region);
            // Fitting the edge may reach a little outside a selection that limits the result: it stays inside.
            if constrained {
                let b = result.content_bounds().intersect(&canvas);
                if !b.is_empty() {
                    let inside = sel::mask_from_surface(st.doc.selection.as_ref(), b);
                    let mut values = sel::mask_from_surface(Some(&result), b);
                    for (o, m) in values.iter_mut().zip(inside) {
                        *o *= m;
                    }
                    result = sel::mask_to_surface(&values, b);
                }
            }
        }
    }
    let found = result.content_bounds();

    match id {
        None => app.session.edit(if p.get("object").and_then(Value::as_bool) == Some(true) { "Select Object" } else { "Select Subject" }, |doc, _| {
            doc.selection = Some(result);
            Ok(())
        }),
        Some(id) => app.session.edit("Remove Background", |doc, active| {
            // The Background cannot have a mask: it becomes a normal layer first, as when one is added by hand.
            if let Some(l) = doc.layers.first_mut().filter(|l| l.id == id && l.name == "Background" && l.locks.transparency && l.locks.position) {
                l.name = "Layer 0".into();
                l.locks.transparency = false;
                l.locks.position = false;
            }
            let l = doc.layer_mut(id).ok_or(EngineError::NoLayer(id))?;
            l.mask = Some(LayerMask { surface: result, ..LayerMask::reveal_all() });
            doc.selection = None;
            *active = Some(id);
            Ok(())
        }),
    }
    .map_err(|e| e.to_string())?;
    Ok(json!({"output": if as_selection { "selection" } else { "mask" }, "layer": id.map(|i| i.0), "bounds": bounds_json(found), "constrained": constrained, "refined": refine, "radius": radius}))
}

/// An image the page hands in, placed as a new layer above the active one: centred and scaled
/// down to fit unless `center`, `scale` (percent) or `fit` say otherwise.
fn place(app: &mut PhotocraftApp, p: &Value) -> Result<Value, String> {
    let path = path_param(p)?;
    if app.session.active().is_none() {
        return Err("no document open".to_string());
    }
    let read = app.services.automation_read.as_mut().ok_or("the page hands in no files")?;
    let (name, bytes) = read(&path)?;
    photocraft_engine::file_cmds::place_bytes(&mut app.session, &name, bytes, None, p).map_err(|e| e.to_string())
}
