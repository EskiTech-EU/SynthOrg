'use strict';
// Builds photocraft, the photo editor of the Studio's Foto tab, as it runs
// inside SynthOrg: its web build, a canvas in a frame of the page.
//
// Why a build of ours and not the upstream web release: in the page the app
// has to be driven by SynthOrg (the model's tools, opening and saving in the
// project folder) and painted in SynthOrg's colours, and the upstream web
// build has neither a control channel nor a way to take colours. So SynthOrg
// takes the source of the newest release and adds its own side of the shell
// (photocraft-patches/synthorg.rs): the control requests of the desktop app
// through a function of the page, the tokens laid over the theme, and files
// that go to the page instead of a download. It also takes out of the title
// bar what belongs to a standalone app: the theme switch (the theme is
// SynthOrg's) and the link to the project's Discord.
//
// Following the releases means: every build of SynthOrg takes the newest tag
// (SYNTHORG_PHOTOCRAFT_TAG pins one). A new release may move what the changes
// are written against: then they no longer apply, or what they leave no longer
// compiles, and they have to be updated by hand. That must not be what stops
// the application from starting, as this runs before every start: the release
// that was built last stays in use, and the terminal says so — which release
// is held back and why — at this start and at every one after it, until the
// changes are updated or a newer release comes out. The same when the newest
// release cannot be asked for (no network). Only with nothing built yet, or
// with a pinned tag, does a build that fails stop here.
//
// The result is in resources/photocraft/ (a web asset: the page loads it in
// a frame): index.html, the wasm-bindgen glue, the WebAssembly, the licences
// and build.json with the tag, the commit and the fingerprint of the changes.
//
// Run `npm run build:photocraft`. Needs the wasm32-unknown-unknown target
// (`rustup target add wasm32-unknown-unknown`); the wasm-bindgen tool of the
// exact version the source pins is fetched from its release, checked against
// the checksum published beside it.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'photocraft-src');
const PATCHES = path.join(ROOT, 'photocraft-patches');
const OUT = path.join(ROOT, 'resources', 'photocraft');
const TOOLS = path.join(SRC, '.synthorg-tools');
const REPO = 'https://github.com/storytold/photocraft';
const API_LATEST = 'https://api.github.com/repos/storytold/photocraft/releases/latest';
const TARGET = 'wasm32-unknown-unknown';
const PROFILE = 'wasm-release';

/**
 * The changes, as exact text substitutions and not as a .patch: a patch keys
 * on line numbers and breaks on any edit nearby, while each of these is one
 * string that is either there or not. Every `from` must be found exactly
 * once, or the change does not apply and the build stops.
 */
const CHANGES = [
  {
    file: 'apps/photocraft-web/src/main.rs',
    from: '#[cfg(target_arch = "wasm32")]\nmod web;',
    to: '#[cfg(target_arch = "wasm32")]\nmod synthorg;\n#[cfg(target_arch = "wasm32")]\nmod web;'
  },
  {
    // The app is wired to the page as it is made.
    file: 'apps/photocraft-web/src/web.rs',
    from: 'let mut app = PhotocraftApp::new(session, services(inbox.clone()));',
    to: 'let mut app = crate::synthorg::attach(PhotocraftApp::new(session, services(inbox.clone())), &cc.egui_ctx);'
  },
  {
    // File › Save goes to the page (the project folder) when the page takes it; a download otherwise.
    file: 'apps/photocraft-web/src/web.rs',
    from: 'write: Some(Box::new(|path: &str, bytes: &[u8]| download(path, bytes))),',
    to: 'write: Some(Box::new(|path: &str, bytes: &[u8]| crate::synthorg::write(path, bytes).unwrap_or_else(|| download(path, bytes)))),'
  },
  {
    // The look and the replies of the control channel, once a frame.
    file: 'apps/photocraft-web/src/web.rs',
    from: '        self.app.logic(ctx, frame);',
    to: '        crate::synthorg::tick(&mut self.app, ctx);\n        self.app.logic(ctx, frame);'
  },
  {
    // The web app has serde_json for its tests alone: the control channel needs it in the app.
    file: 'apps/photocraft-web/Cargo.toml',
    from: 'log = { workspace = true }\n',
    to: 'log = { workspace = true }\nserde_json = { workspace = true }\n'
  },
  {
    // The title bar of an app inside SynthOrg: no appearance switch (the look follows SynthOrg's)…
    file: 'crates/ui-egui/src/panels.rs',
    from: `                    let (theme_icon, appearance_label) = match app.session.prefs().interface.appearance_mode {
                        photocraft_engine::prefs::AppearanceMode::Auto => ("monitor", tl!("Auto")),
                        photocraft_engine::prefs::AppearanceMode::Dark => ("moon", tl!("Dark")),
                        photocraft_engine::prefs::AppearanceMode::Light => ("sun", tl!("Light")),
                    };
                    let appearance_tip = format!("{}: {}", tl!("Appearance Mode"), appearance_label);
                    if icons_shown >= 2 && icons::button(ui, theme_icon, 28.0, false, &appearance_tip).clicked() {
                        crate::prefs_ui::cycle_appearance(app, ui.ctx());
                    }
`,
    to: ''
  },
  {
    // …and no Discord link,
    file: 'crates/ui-egui/src/panels.rs',
    from: `                    if ui.available_width() >= DISCORD_ROOM {
                        let discord = egui::Button::image_and_text(
                            icons::image("message-square", 14.0, t.text_dim),
                            egui::RichText::new(tl!("Discord")).color(t.text_dim).size(12.0),
                        )
                        .frame(false);
                        if ui.add(discord).on_hover_text(format!("Join the ArtCraft Discord ({})", crate::links::DISCORD)).clicked() {
                            crate::links::open(app, ui.ctx(), crate::links::DISCORD);
                        }
                    }
`,
    to: ''
  },
  {
    // …nor the room that was kept for it.
    file: 'crates/ui-egui/src/panels.rs',
    from: `/// Free room the title bar needs after its other controls to show the Discord button.
const DISCORD_ROOM: f32 = 120.0;
`,
    to: ''
  },
  {
    // SynthOrg's functions are commands of the shell (photocraft-patches/synthorg_ui.rs)…
    file: `crates/ui-egui/src/lib.rs`,
    from: `pub mod state;
`,
    to: `pub mod state;
pub mod synthorg;
`
  },
  {
    // …listed in the menus beside the ones they resemble,
    file: `crates/ui-egui/src/menus.rs`,
    from: `pub const UI_COMMANDS: &[(&str, &str, &[&str], Option<&str>)] = &[
`,
    to: `pub const UI_COMMANDS: &[(&str, &str, &[&str], Option<&str>)] = &[
    ("synthorg.removeBackground", "Remove Background", &["Layer"], None),
    ("synthorg.selectSubject", "Subject (Model)", &["Select"], None),
    ("synthorg.selectObject", "Object (Model)", &["Select"], None),
`
  },
  {
    // …each right after the item a Photoshop user would look for it next to,
    file: 'crates/ui-egui/src/menus.rs',
    from: 'const PLACE_AFTER: &[(&str, &str)] = &[\n    ("file.newFromClipboard", "file.new"),\n',
    to: 'const PLACE_AFTER: &[(&str, &str)] = &[\n    ("file.newFromClipboard", "file.new"),\n    ("synthorg.removeBackground", "layer.maskAllObjects"),\n    ("synthorg.selectSubject", "select.subject"),\n    ("synthorg.selectObject", "synthorg.selectSubject"),\n'
  },
  {
    // …run before the shell's other commands,
    file: `crates/ui-egui/src/menus.rs`,
    from: `    // Help › Discord, website, GitHub, Report an Issue.
    if let Some(url) = crate::links::url_for(id) {`,
    to: `    if let Some(r) = crate::synthorg::menu(app, id, &params) {
        return r;
    }
    // Help › Discord, website, GitHub, Report an Issue.
    if let Some(url) = crate::links::url_for(id) {`
  },
  {
    // …and greyed when there is nothing to work on.
    file: `crates/ui-egui/src/menus.rs`,
    from: `    if let Some(e) = crate::workspace_ui::is_enabled(app, id) {
        return e;
    }
`,
    to: `    if let Some(e) = crate::synthorg::is_enabled(app, id) {
        return e;
    }
    if let Some(e) = crate::workspace_ui::is_enabled(app, id) {
        return e;
    }
`
  },
  {
    // The tools are a palette over the image (the frame of a SynthOrg project keeps the sides for its own columns):
    // taken by any part of it that is not a button and put where it is wanted. Folded, it is a dot with the tool in
    // hand; open, one column of tools — the one of the tool in hand — or every column…
    file: 'crates/ui-egui/src/panels.rs',
    from: `    let w = if double { w1 + bx + 2.0 } else { w1 };
    egui::Panel::left("toolbar").resizable(false).exact_size(w).frame(egui::Frame::NONE.fill(t.chrome).inner_margin(egui::Margin::symmetric(m, 8))).show(
        ui,
        |ui| {
            if t.pro {
                // Photoshop's toolbar header chevrons switch between one and two columns.
                let (cr, resp) = ui.allocate_exact_size(vec2(bx, 14.0), Sense::click());
                icons::paint(ui, cr, if double { "chevrons-left" } else { "chevrons-right" }, 11.0, if resp.hovered() { t.text } else { t.text_faint });
                resp.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Button, true, tl!("Toolbar")));
                if resp.clicked() {
                    app.ui.panels.toolbar_double = !app.ui.panels.toolbar_double;
                }
                ui.add_space(4.0);
            }
`,
    to: `    let _ = (w1, m);
    let slots: usize = sections.iter().map(Vec::len).sum();
    let ctx = ui.ctx().clone();
    let room = ui.available_rect_before_wrap();
    let folded_id = egui::Id::new("synthorg-palette-folded");
    let folded = ctx.data(|d| d.get_temp::<bool>(folded_id)).unwrap_or(false);
    // As many tools in a column as the image's room holds under the documents' tabs, with the palette's head over
    // them and the colours under them.
    let per_column = (((room.height() - 195.0) / (bx + 3.0)).floor().max(5.0) as usize).min(14);
    let shown_columns = if double { slots.div_ceil(per_column).max(1) } else { 1 };
    egui::Area::new(egui::Id::new("toolbar")).order(egui::Order::Middle).movable(true).constrain(true).default_pos(room.left_top() + vec2(12.0, 44.0)).show(&ctx, |ui| {
    egui::Frame::NONE.fill(t.chrome).stroke(Stroke::new(1.0, t.separator)).corner_radius(if folded { 20u8 } else { 8u8 }).inner_margin(egui::Margin::same(if folded { 3 } else { 6 })).show(
        ui,
        |ui| {
            if folded {
                if icons::button(ui, icons::tool_icon(app.ui.tool), 30.0, false, "Toolbar").clicked() {
                    ctx.data_mut(|d| d.insert_temp(folded_id, false));
                }
                return;
            }
            // As wide as its columns: what is under them (the colours) does not ask for more.
            ui.set_max_width(shown_columns as f32 * bx + (shown_columns - 1) as f32 * 2.0);
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 2.0;
                if icons::button(ui, "circle", 17.0, false, "Collapse").clicked() {
                    ctx.data_mut(|d| d.insert_temp(folded_id, true));
                }
                if icons::button(ui, if double { "chevrons-left" } else { "chevrons-right" }, 17.0, false, "Toolbar").clicked() {
                    app.ui.panels.toolbar_double = !app.ui.panels.toolbar_double;
                }
            });
            ui.add_space(4.0);
`
  },
  {
    // …without the wash of colour the standing toolbar had at its foot,
    file: 'crates/ui-egui/src/panels.rs',
    from: `            if !t.bevel && !t.pro && t.dark() {
`,
    to: `            if false && !t.bevel && !t.pro && t.dark() {
`
  },
  {
    // …the tools down each column, the columns side by side,
    file: 'crates/ui-egui/src/panels.rs',
    from: `                let sections: Vec<Vec<(usize, Vec<Tool>)>> = if t.pro { vec![sections.into_iter().flatten().collect()] } else { sections };
                for (si, section) in sections.iter().enumerate() {
                    // Photoshop 2026 draws one uninterrupted column (no group dividers).
                    if si > 0 && !t.pro {
                        ui.add_space(4.0);
                        let (r, _) = ui.allocate_exact_size(vec2(if double { bx * 2.0 + 2.0 } else { bx }, 1.0), Sense::hover());
                        ui.painter().line_segment([r.left_center() + vec2(8.0, 0.0), r.right_center() - vec2(8.0, 0.0)], Stroke::new(1.0, t.separator));
                        ui.add_space(4.0);
                    }
                    let rows: Vec<&[(usize, Vec<Tool>)]> = if double { section.chunks(2).collect() } else { section.chunks(1).collect() };
                    for row in rows {
                        ui.horizontal(|ui| {
`,
    to: `            let all: Vec<(usize, Vec<Tool>)> = sections.into_iter().flatten().collect();
            let columns: Vec<&[(usize, Vec<Tool>)]> = all.chunks(per_column).collect();
            let in_hand = columns.iter().position(|column| column.iter().any(|(_, slot)| slot.contains(&app.ui.tool))).unwrap_or(0);
            let rows: Vec<&[(usize, Vec<Tool>)]> = if double { columns } else { columns.into_iter().skip(in_hand).take(1).collect() };
            ui.horizontal_top(|ui| {
                for row in rows {
                    ui.vertical(|ui| {
`
  },
  {
    // …the columns closed,
    file: 'crates/ui-egui/src/panels.rs',
    from: `                        });
                    }
                }
                let ctx = ui.ctx().clone();
                if t.pro && icons::button(ui, "ellipsis", bx, false, tl!("Edit Toolbar…")).clicked() {
`,
    to: `                        });
                    }
                });
                let ctx = ui.ctx().clone();
                if t.pro && icons::button(ui, "ellipsis", bx, false, tl!("Edit Toolbar…")).clicked() {
`
  },
  {
    // …and the palette closed.
    file: 'crates/ui-egui/src/panels.rs',
    from: `                }
            });
        },
    );
}

/// Paints a triangle on the bottom right corner of an icon button`,
    to: `                }
            });
        },
    );
    });
}

/// Paints a triangle on the bottom right corner of an icon button`
  },
  {
    // The panels (layers, swatches, history…) are under the image, where the tools were, and no longer beside it:
    // their groups side by side, each a column as wide as the others and never narrower than the dock was, scrolled
    // sideways when they do not all fit. Dragged by its upper edge the section is taller or shorter.
    file: 'crates/ui-egui/src/panels.rs',
    from: `    let mut panel = egui::Panel::right("dock").resizable(true).default_size(if t.pro { 290.0 } else { 300.0 }).size_range(DOCK_WIDTH);
    if let Some(w) = ui.ctx().data_mut(|d| d.remove_temp::<f32>(dock_width_id())) {
        panel = panel.exact_size(w);
    }
    panel.frame(egui::Frame::NONE.fill(t.dock).inner_margin(egui::Margin::same(margin))).show(ui, |ui| {
        // Groups keep their heights whatever they show (#88): see \`dock\`.
        crate::dock::show(app, ui, &shown, dock_body);
    });
`,
    to: `    let _ = ui.ctx().data_mut(|d| d.remove_temp::<f32>(dock_width_id()));
    egui::Panel::bottom("dock").resizable(true).default_size(220.0).size_range(150.0..=560.0).frame(egui::Frame::NONE.fill(t.dock).inner_margin(egui::Margin::same(margin))).show(ui, |ui| {
        let order: Vec<crate::dock::Group> = app.ui.dock.order().into_iter().filter(|g| shown.contains(g)).collect();
        let gap = crate::dock::GAP;
        let count = order.len().max(1) as f32;
        let width = ((ui.available_width() - gap * (count - 1.0)) / count).max(*DOCK_WIDTH.start());
        egui::ScrollArea::horizontal().id_salt("dock-columns").auto_shrink([false, false]).show(ui, |ui| {
            let (all, _) = ui.allocate_exact_size(vec2(width * count + gap * (count - 1.0), ui.available_height()), Sense::hover());
            for (i, group) in order.iter().enumerate() {
                let rect = Rect::from_min_size(pos2(all.left() + (width + gap) * i as f32, all.top()), vec2(width, all.height()));
                let mut column = ui.new_child(egui::UiBuilder::new().id_salt(("dock-column", group.key())).max_rect(rect));
                column.set_clip_rect(rect.intersect(ui.clip_rect()));
                crate::dock::show(app, &mut column, &[*group], dock_body);
            }
        });
    });
`
  },
  {
    // The options of the tool in hand are a bar under the image…
    file: 'crates/ui-egui/src/panels.rs',
    from: `    egui::Panel::top("options_bar")
`,
    to: `    egui::Panel::bottom("options_bar")
`
  },
  {
    // …over the panels, which are over the status bar; the palette of the tools is laid last, over what is left.
    file: 'crates/ui-egui/src/lib.rs',
    from: `        if chrome && self.ui.panels.options_bar {
            panels::options_bar(self, ui);
        }
        if chrome && self.ui.panels.status_bar {
            panels::status_bar(self, ui);
        }
        if chrome && self.ui.panels.toolbar {
            panels::toolbar(self, ui);
        }
        if chrome && self.ui.panels.dock {
            panels::right_dock(self, ui);
        }
`,
    to: `        if chrome && self.ui.panels.status_bar {
            panels::status_bar(self, ui);
        }
        if chrome && self.ui.panels.dock {
            panels::right_dock(self, ui);
        }
        if chrome && self.ui.panels.options_bar {
            panels::options_bar(self, ui);
        }
        if chrome && self.ui.panels.toolbar {
            panels::toolbar(self, ui);
        }
`
  }
];
const COPIES = [
  { from: 'synthorg.rs', to: 'apps/photocraft-web/src/synthorg.rs' },
  { from: 'synthorg_ui.rs', to: 'crates/ui-egui/src/synthorg.rs' }
];

function git(args, cwd = SRC) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

function log(message) { console.log(`[build-photocraft] ${message}`); }

async function latestTag() {
  if (process.env.SYNTHORG_PHOTOCRAFT_TAG) return process.env.SYNTHORG_PHOTOCRAFT_TAG;
  const response = await fetch(API_LATEST, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'SynthOrg' } });
  if (!response.ok) throw new Error(`GitHub non risponde per l'ultima release (${response.status}); fissa un tag con SYNTHORG_PHOTOCRAFT_TAG.`);
  const release = await response.json();
  if (!/^v\d+\.\d+\.\d+/.test(release.tag_name || '')) throw new Error(`Tag della release non riconosciuto: ${release.tag_name}`);
  return release.tag_name;
}

function describe() {
  try { return git(['describe', '--tags', '--exact-match']); } catch { return ''; }
}

/** The source at the tag, clean: fetched once, then reset on every build so the changes are applied on the tag's own files. */
function checkout(tag) {
  if (!fs.existsSync(path.join(SRC, '.git'))) {
    log(`clono ${REPO} al tag ${tag}`);
    execFileSync('git', ['clone', '--quiet', '--depth', '1', '--branch', tag, REPO, SRC], { cwd: ROOT, stdio: 'inherit' });
  } else if (describe() !== tag) {
    log(`prendo il tag ${tag}`);
    execFileSync('git', ['fetch', '--quiet', '--depth', '1', 'origin', `refs/tags/${tag}:refs/tags/${tag}`], { cwd: SRC, stdio: 'inherit' });
    git(['checkout', '--quiet', '--force', tag]);
  }
  git(['checkout', '--quiet', '--', '.']);
  git(['clean', '--quiet', '-fd', 'crates', 'apps']);
  return git(['rev-parse', 'HEAD']);
}

/** Applies the changes to a source tree; returns their fingerprint, so build.json says which changes the build carries. */
function applyChanges(src = SRC, patches = PATCHES) {
  const hash = createHash('sha256');
  for (const change of CHANGES) {
    const full = path.join(src, change.file);
    const text = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
    const found = text.split(change.from).length - 1;
    if (found !== 1) throw new Error(`Una modifica di SynthOrg non si applica a ${change.file} (trovata ${found} volte, attesa 1): va aggiornata per questa release.`);
    fs.writeFileSync(full, text.replace(change.from, change.to));
    hash.update(`${change.file}\n${change.from}\n${change.to}\n`);
  }
  for (const copy of COPIES) {
    const body = fs.readFileSync(path.join(patches, copy.from));
    fs.writeFileSync(path.join(src, copy.to), body);
    hash.update(`${copy.to}\n`);
    hash.update(body);
  }
  hash.update(fs.readFileSync(path.join(patches, 'index.html')));
  return hash.digest('hex').slice(0, 16);
}

/** The wasm-bindgen version the source pins: the tool that writes the glue must be exactly that one. */
function bindgenVersion() {
  const lock = fs.readFileSync(path.join(SRC, 'Cargo.lock'), 'utf8');
  const match = /name = "wasm-bindgen"\r?\nversion = "([^"]+)"/.exec(lock);
  if (!match) throw new Error('Versione di wasm-bindgen non trovata in Cargo.lock.');
  return match[1];
}

async function bindgenTool(version) {
  const triple = { 'win32-x64': 'x86_64-pc-windows-msvc', 'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-gnu', 'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin' }[`${process.platform}-${process.arch}`];
  if (!triple) throw new Error(`Nessun wasm-bindgen precompilato per ${process.platform}-${process.arch}.`);
  const name = `wasm-bindgen-${version}-${triple}`;
  const exe = path.join(TOOLS, name, process.platform === 'win32' ? 'wasm-bindgen.exe' : 'wasm-bindgen');
  if (fs.existsSync(exe)) return exe;
  const base = `https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${version}/${name}.tar.gz`;
  log(`scarico ${base}`);
  const [archive, sums] = await Promise.all([fetch(base), fetch(`${base}.sha256sum`)]);
  if (!archive.ok) throw new Error(`Download di wasm-bindgen non riuscito (${archive.status}).`);
  const bytes = Buffer.from(await archive.arrayBuffer());
  // The checksum the release publishes beside the archive: the bytes are the ones it shipped.
  if (!sums.ok) throw new Error(`Checksum di wasm-bindgen non disponibile (${sums.status}).`);
  const expected = (await sums.text()).trim().split(/\s+/)[0];
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (expected !== actual) throw new Error(`sha256 di wasm-bindgen diverso da quello pubblicato: ${actual}`);
  fs.mkdirSync(TOOLS, { recursive: true });
  const file = path.join(TOOLS, `${name}.tar.gz`);
  fs.writeFileSync(file, bytes);
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xf', file, '-C', TOOLS], { stdio: 'inherit' });
  if (!fs.existsSync(exe)) throw new Error(`wasm-bindgen non trovato nell'archivio: ${exe}`);
  return exe;
}

function run(command, args, cwd) {
  log(`${path.basename(command)} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${path.basename(command)} non riuscito (codice ${result.status}).`);
}

async function build() {
  const started = Date.now();
  // serde_json is already in the lock; the change adds only an edge to it, so nothing new is downloaded.
  run('cargo', ['build', '-p', 'photocraft-web', '--target', TARGET, '--profile', PROFILE], SRC);
  const wasm = path.join(SRC, 'target', TARGET, PROFILE, 'photocraft-web.wasm');
  if (!fs.existsSync(wasm)) throw new Error(`WebAssembly non trovato: ${wasm}`);
  const tool = await bindgenTool(bindgenVersion());
  const staged = path.join(SRC, 'target', 'synthorg-web');
  fs.rmSync(staged, { recursive: true, force: true });
  run(tool, ['--target', 'web', '--no-typescript', '--weak-refs', '--out-dir', staged, '--out-name', 'photocraft-web', wasm], SRC);
  return { staged, seconds: Math.round((Date.now() - started) / 1000) };
}

function collect({ tag, commit, changes, staged, seconds, held = null }) {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  for (const name of ['photocraft-web.js', 'photocraft-web_bg.wasm']) fs.copyFileSync(path.join(staged, name), path.join(OUT, name));
  fs.copyFileSync(path.join(PATCHES, 'index.html'), path.join(OUT, 'index.html'));
  for (const name of ['LICENSE-APACHE', 'LICENSE-MIT', 'NOTICE']) {
    if (fs.existsSync(path.join(SRC, name))) fs.copyFileSync(path.join(SRC, name), path.join(OUT, name));
  }
  const stamp = { tag, commit, changes, wasmBytes: fs.statSync(path.join(OUT, 'photocraft-web_bg.wasm')).size, builtAt: new Date().toISOString(), seconds };
  // A newer release that could not be built with these changes: remembered, so it is not tried again at every start.
  if (held) stamp.held = held;
  fs.writeFileSync(path.join(OUT, 'build.json'), JSON.stringify(stamp, null, 2) + '\n');
  return stamp;
}

function readStamp() {
  try { return JSON.parse(fs.readFileSync(path.join(OUT, 'build.json'), 'utf8')); } catch { return null; }
}

/** The fingerprint the current changes would have, without touching a source tree: what says a built copy is stale. */
function changesFingerprint() {
  const hash = createHash('sha256');
  for (const change of CHANGES) hash.update(`${change.file}\n${change.from}\n${change.to}\n`);
  for (const copy of COPIES) { hash.update(`${copy.to}\n`); hash.update(fs.readFileSync(path.join(PATCHES, copy.from))); }
  hash.update(fs.readFileSync(path.join(PATCHES, 'index.html')));
  return hash.digest('hex').slice(0, 16);
}

/** One release built with the changes, into resources/photocraft. */
async function buildAt(tag, held = null) {
  const commit = checkout(tag);
  const changes = applyChanges();
  log(`modifiche applicate (${changes}); sorgenti al commit ${commit.slice(0, 9)}`);
  const { staged, seconds } = await build();
  const built = collect({ tag, commit, changes, staged, seconds, held });
  log(`${path.relative(ROOT, OUT)} pronto: ${built.tag}, ${(built.wasmBytes / 1048576).toFixed(1)} MB di WebAssembly, ${seconds} s`);
  return built;
}

/** The release that stays in use while a newer one is held back, said where it cannot be missed. */
function sayHeld(kept, held) {
  const line = '-'.repeat(78);
  for (const text of [
    line,
    `ATTENZIONE: photocraft resta alla ${kept}.`,
    `E' uscita la ${held.latest}, ma con le modifiche di SynthOrg non si compila:`,
    `  ${held.reason}`,
    'L\'app parte con la versione che c\'era. Per passare alla nuova vanno aggiornate le',
    'modifiche in scripts/build-photocraft.js e in photocraft-patches/.',
    line
  ]) console.warn(`[build-photocraft] ${text}`);
}

/**
 * What a start does. `parts` stands in for the network, the compiler and the
 * built copy, so that the choices made here can be tried without them.
 */
async function main(parts = {}) {
  const latest = parts.latest || latestTag;
  const make = parts.buildAt || buildAt;
  const stampOf = parts.readStamp || readStamp;
  const keep = parts.writeStamp || (stamp => fs.writeFileSync(path.join(OUT, 'build.json'), JSON.stringify(stamp, null, 2) + '\n'));
  const pinned = parts.pinned ?? Boolean(process.env.SYNTHORG_PHOTOCRAFT_TAG);
  const force = parts.force ?? Boolean(process.env.SYNTHORG_FORCE_PHOTOCRAFT_BUILD);
  const fingerprint = (parts.fingerprint || changesFingerprint)();
  const found = stampOf();
  const stamp = found && (parts.built ?? fs.existsSync(path.join(OUT, 'photocraft-web_bg.wasm'))) ? found : null;
  // What is built is as the changes are now: nothing to compile to stay on its release.
  const current = Boolean(stamp) && stamp.changes === fingerprint;

  let tag;
  try { tag = await latest(); } catch (error) {
    // The newest release cannot be asked for: the one built last is the one there is.
    if (!stamp || pinned) throw error;
    console.warn(`[build-photocraft] ATTENZIONE: non so qual e' l'ultima versione di photocraft (${String(error.message).split(';')[0]}). Resto alla ${stamp.tag}.`);
    tag = stamp.tag;
  }
  if (current && stamp.tag === tag && !force) {
    log(`gia presente: ${path.relative(ROOT, OUT)} (${tag}, ${stamp.commit.slice(0, 9)})`);
    return;
  }
  // A release other than the one built, not asked for by name: if it does not build, the one built stays.
  const newer = Boolean(stamp) && !pinned && stamp.tag !== tag;
  let held = newer && stamp.held && stamp.held.latest === tag && stamp.held.changes === fingerprint && !force ? stamp.held : null;
  if (!held) {
    try { await make(tag); return; } catch (error) {
      if (!newer) throw error;
      held = { latest: tag, changes: fingerprint, reason: String(error.message).split(/\r?\n/)[0], at: new Date().toISOString() };
    }
  }
  // Held back: tried now, or at an earlier start with these same changes.
  if (current) {
    if (stamp.held !== held) keep({ ...stamp, held });
    sayHeld(stamp.tag, held);
    return;
  }
  // The changes are not the ones the built copy carries: it is built again, at its own release.
  try { await make(stamp.tag, held); } catch (error) {
    throw new Error(`${held.reason}\n[build-photocraft] E nemmeno la ${stamp.tag}, quella che c'era, si compila con le modifiche di adesso: ${error.message}`);
  }
  sayHeld(stamp.tag, held);
}

module.exports = { CHANGES, COPIES, applyChanges, changesFingerprint, latestTag, readStamp, main, SRC, OUT, PATCHES };

if (require.main === module) {
  main().catch(error => {
    console.error(`[build-photocraft] ${error.message}`);
    process.exit(1);
  });
}
