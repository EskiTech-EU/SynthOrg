//! SynthOrg owns the editor data namespace. Never migrate another editor's data.
use std::path::PathBuf;
pub fn app_data_dir() -> PathBuf {
    sidex_extensions::paths::sidex_config_dir()
}
pub fn resolve_and_migrate() -> PathBuf {
    app_data_dir()
}
