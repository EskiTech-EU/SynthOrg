use std::env;
use std::path::PathBuf;

const SENSITIVE_ENV_PATTERNS: &[&str] = &[
    "SECRET",
    "TOKEN",
    "PASSWORD",
    "PASSWD",
    "CREDENTIAL",
    "PRIVATE_KEY",
    "API_KEY",
    "APIKEY",
    "AUTH",
    "AWS_",
    "AZURE_",
    "GCP_",
    "GITHUB_TOKEN",
    "NPM_TOKEN",
    "DOCKER_PASSWORD",
    "SSH_",
    "GPG_",
];

#[tauri::command]
pub fn get_all_env() -> std::collections::HashMap<String, String> {
    env::vars()
        .filter(|(key, _)| {
            let upper = key.to_uppercase();
            !SENSITIVE_ENV_PATTERNS.iter().any(|p| upper.contains(p))
        })
        .collect()
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn get_user_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let user_dir = resolve_user_data_dir(&app)?;
    std::fs::create_dir_all(&user_dir)
        .map_err(|e| format!("failed to create UserData dir: {e}"))?;
    Ok(user_dir.to_string_lossy().to_string())
}

pub(crate) fn resolve_user_data_dir(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(crate::app_dirs::app_data_dir().join("UserData"))
}
