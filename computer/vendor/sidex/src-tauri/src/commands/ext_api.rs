use serde::Serialize;
use sidex_extension_api::CommandRegistry;
use sidex_extension_api::ExtensionApiHandler;
use std::sync::Arc;
use tauri::State;

#[derive(Serialize)]
pub struct ExtCommandInfo {
    pub id: String,
}

#[tauri::command]
pub fn ext_api_get_namespaces() -> Vec<String> {
    [
        "window",
        "workspace",
        "commands",
        "languages",
        "debug",
        "tasks",
        "scm",
        "tests",
        "env",
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn ext_api_get_commands(registry: State<'_, Arc<CommandRegistry>>) -> Vec<ExtCommandInfo> {
    registry
        .get_commands()
        .into_iter()
        .map(|id| ExtCommandInfo { id })
        .collect()
}

/// Dispatch an extension-API call ("namespace/action") to the appropriate
/// subsystem handler. This is the command the workbench-side
/// SidexExtensionApiService invokes — without it the entire extension API
/// surface was unreachable.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn ext_api_call(
    handler: State<'_, Arc<ExtensionApiHandler>>,
    namespace: String,
    action: String,
    params: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let method = format!("{namespace}/{action}");
    let params = params.unwrap_or(serde_json::Value::Null);
    handler
        .dispatch(&method, &params)
        .map_err(|e| e.to_string())
}
