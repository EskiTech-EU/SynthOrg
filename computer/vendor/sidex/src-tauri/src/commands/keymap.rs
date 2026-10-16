use std::sync::OnceLock;

use serde::Serialize;
use sidex_keymap::{
    default_keybindings, format_keybinding,
    KeybindingResolver, KeybindingSource,
};

static RESOLVER: OnceLock<KeybindingResolver> = OnceLock::new();

fn resolver() -> &'static KeybindingResolver {
    RESOLVER.get_or_init(KeybindingResolver::new)
}

#[derive(Debug, Serialize)]
pub struct KeybindingEntry {
    pub key: String,
    pub command: String,
    pub when: Option<String>,
    pub source: String,
}

fn source_label(source: &KeybindingSource) -> String {
    match source {
        KeybindingSource::Default => "default".into(),
        KeybindingSource::User => "user".into(),
        KeybindingSource::Extension(id) => format!("extension:{id}"),
    }
}

#[allow(clippy::unnecessary_wraps)]
#[tauri::command]
pub fn keymap_get_defaults() -> Result<Vec<KeybindingEntry>, String> {
    let entries: Vec<KeybindingEntry> = default_keybindings()
        .into_iter()
        .map(|b| KeybindingEntry {
            key: b.key.to_string(),
            command: b.command.clone(),
            when: b.when.clone(),
            source: "default".into(),
        })
        .collect();
    Ok(entries)
}

#[allow(clippy::unnecessary_wraps)]
#[tauri::command]
pub fn keymap_get_all() -> Result<Vec<KeybindingEntry>, String> {
    let resolved = resolver().resolved_bindings();
    let entries: Vec<KeybindingEntry> = resolved
        .iter()
        .filter(|r| !r.command.starts_with('-'))
        .map(|r| KeybindingEntry {
            key: format_keybinding(&r.keys),
            command: r.command.clone(),
            when: r.when.clone(),
            source: source_label(&r.source),
        })
        .collect();
    Ok(entries)
}
