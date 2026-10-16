//! SideX editor runtime hosted by SynthOrg. See SYNTHORG.md.
mod app_dirs;
mod commands;

use commands::debug::{DapClientStore, DebugAdapterStore};
use commands::ext_host::ExtensionPlatformSupervisor;
use commands::extension_diagnostics::ExtensionDiagnosticsStore;
use commands::extension_wasm::WasmExtensionRuntime;
use commands::index::IndexStore;
use commands::lsp::LspState;
use commands::settings::SettingsStore;
use commands::storage::StorageDb;
use commands::tasks::TaskProcessStore;
use commands::terminal::TerminalStore;
use commands::watch::WatchStore;
use std::sync::Arc;

use tauri::Manager;

pub fn configure(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())

}

static INITIALIZED: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();

pub fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    INITIALIZED.get_or_init(|| setup(app).map_err(|e| e.to_string())).clone()
}

fn setup(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let wasm = WasmExtensionRuntime::new()?;
        app.manage(Arc::new(commands::extensions::MarketplaceClientState::new()));
        app.manage(Arc::new(TerminalStore::new()));
        app.manage(Arc::new(DebugAdapterStore::new()));
        app.manage(Arc::new(DapClientStore::new()));
        app.manage(Arc::new(LspState::new()));
        app.manage(Arc::new(TaskProcessStore::new()));
        app.manage(Arc::new(WatchStore::new()));
        app.manage(Arc::new(IndexStore::new(false)));
        app.manage(ExtensionPlatformSupervisor::new());
        app.manage(ExtensionDiagnosticsStore::new());
        app.manage(Arc::new(SettingsStore::new()));
        app.manage(Arc::new(sidex_extension_api::CommandRegistry::new()));
        app.manage(Arc::new(wasm));

            let app_data = crate::app_dirs::resolve_and_migrate();
            std::fs::create_dir_all(&app_data).ok();
            let db_path = app_data.join("sidex_storage.db");
            let db_path_str = db_path.to_string_lossy().to_string();
            let db = StorageDb::new(&db_path_str).map_err(|e| format!("editor storage: {e}"))?;



            app.manage(Arc::new(db));

            {
                use sidex_extension_api as ext;
                let registry = app
                    .state::<Arc<ext::CommandRegistry>>()
                    .inner()
                    .clone();
                app.manage(Arc::new(ext::ExtensionApiHandler::new(
                    Arc::new(ext::WindowApi::new()),
                    Arc::new(ext::WorkspaceApi::new()),
                    Arc::new(ext::LanguagesApi::new()),
                    registry,
                    Arc::new(ext::DebugApi::new()),
                    Arc::new(ext::TasksApi::new()),
                    Arc::new(ext::ScmApi::new()),
                    Arc::new(ext::TestApi::new()),
                    Arc::new(ext::EnvApi::new()),
                )));
            }

            {
                let settings_store = app.state::<Arc<SettingsStore>>();
                let user_settings_path = app_data.join("UserData").join("User").join("settings.json");
                settings_store.set_user_path(&user_settings_path);
                if user_settings_path.exists() {
                    if let Err(e) = settings_store.load_user(&user_settings_path) {
                        log::warn!("failed to pre-load user settings: {e}");
                    }
                }
            }

            if let Err(err) = commands::profiles::initialize(app) {
                log::warn!("profile storage disabled: {err}");
            }
            if let Err(err) = commands::secrets::initialize(app) {
                log::warn!("secret storage disabled: {err}");
            }


    Ok(())
}

pub fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        commands::compress::zip_list,
        commands::compress::zip_extract_file,
        commands::compress::zip_create,
        commands::crypto::sha256_hash,
        commands::crypto::sha256_file,
        commands::crypto::md5_file,
        commands::crypto::random_bytes,
        commands::crypto::base64_encode,
        commands::crypto::base64_decode,
        commands::crypto::file_hashes,
        commands::debug::debug_spawn_adapter,
        commands::debug::debug_send,
        commands::debug::debug_kill,
        commands::debug::dap_get_launch_configs,
        commands::debug::dap_get_adapter_registry,
        commands::debug::dap_start_adapter,
        commands::debug::dap_send_request,
        commands::debug::dap_stop_adapter,
        commands::ext_api::ext_api_get_namespaces,
        commands::ext_api::ext_api_get_commands,
        commands::ext_api::ext_api_call,
        commands::extension_diagnostics::extension_report_activated,
        commands::extension_diagnostics::extension_report_provider_call,
        commands::extension_diagnostics::extension_report_deactivated,
        commands::extension_diagnostics::extension_report_error,
        commands::extension_diagnostics::extension_mark_startup_complete,
        commands::extension_diagnostics::extension_register_session,
        commands::extension_diagnostics::extension_runtime_status,
        commands::extension_diagnostics::extension_runtime_profile,
        commands::extension_diagnostics::extension_slow_extensions,
        commands::extension_diagnostics::extension_startup_summary,
        commands::extension_diagnostics::extension_bisect_start,
        commands::extension_diagnostics::extension_bisect_good,
        commands::extension_diagnostics::extension_bisect_bad,
        commands::extension_diagnostics::extension_bisect_reset,
        commands::extension_diagnostics::extension_bisect_state,
        commands::extension_platform::extension_platform_bootstrap,
        commands::extension_platform::extension_platform_status,
        commands::extension_platform::extension_platform_restart,
        commands::extension_platform::extension_platform_stop,
        commands::extension_platform::extension_platform_init_data,
        commands::extension_wasm::wasm_provide_completion,
        commands::extension_wasm::wasm_provide_hover,
        commands::extension_wasm::wasm_provide_definition,
        commands::extension_wasm::wasm_provide_references,
        commands::extension_wasm::wasm_provide_document_symbols,
        commands::extension_wasm::wasm_provide_formatting,
        commands::extension_wasm::wasm_load_extension,
        commands::extension_wasm::wasm_unload_extension,
        commands::extension_wasm::wasm_list_extensions,
        commands::extension_wasm::wasm_sync_document,
        commands::extension_wasm::wasm_close_document,
        commands::extension_wasm::wasm_sync_workspace_folders,
        commands::extension_wasm::wasm_provide_completion_all,
        commands::extension_wasm::wasm_provide_hover_all,
        commands::extension_wasm::wasm_provide_definition_all,
        commands::extension_wasm::wasm_provide_document_symbols_all,
        commands::extension_wasm::wasm_provide_formatting_all,
        commands::extension_wasm::wasm_on_document_opened,
        commands::extension_wasm::wasm_on_document_closed,
        commands::extension_wasm::wasm_on_document_saved,
        commands::extension_wasm::wasm_on_document_changed,
        commands::extension_wasm::wasm_on_configuration_changed,
        commands::extension_wasm::wasm_on_active_editor_changed,
        commands::extension_wasm::wasm_provide_type_definition_all,
        commands::extension_wasm::wasm_provide_implementation_all,
        commands::extension_wasm::wasm_provide_declaration_all,
        commands::extension_wasm::wasm_provide_code_actions_all,
        commands::extension_wasm::wasm_provide_code_lenses_all,
        commands::extension_wasm::wasm_provide_signature_help_all,
        commands::extension_wasm::wasm_provide_document_highlights_all,
        commands::extension_wasm::wasm_provide_rename_all,
        commands::extension_wasm::wasm_provide_folding_ranges_all,
        commands::extension_wasm::wasm_provide_inlay_hints_all,
        commands::extension_wasm::wasm_provide_document_links_all,
        commands::extension_wasm::wasm_provide_selection_ranges_all,
        commands::extension_wasm::wasm_provide_semantic_tokens_all,
        commands::extension_wasm::wasm_provide_document_colors_all,
        commands::extension_wasm::wasm_provide_workspace_symbols_all,
        commands::extension_wasm::wasm_provide_range_formatting_all,
        commands::extension_wasm::wasm_execute_command_all,
        commands::extension_wasm::wasm_get_extension_metadata,
        commands::extensions::install_extension,
        commands::extensions::install_extension_from_url,
        commands::extensions::uninstall_extension,
        commands::extensions::list_installed_extensions,
        commands::extensions::extension_search_marketplace,
        commands::extensions::extension_get_contributions,
        commands::fs::get_cwd,
        commands::fs::read_file,
        commands::fs::read_file_bytes,
        commands::fs::write_file,
        commands::fs::write_file_bytes,
        commands::fs::read_dir,
        commands::fs::stat,
        commands::fs::mkdir,
        commands::fs::remove,
        commands::fs::rename,
        commands::fs::exists,
        commands::git::git_status,
        commands::git::git_diff,
        commands::git::git_log,
        commands::git::git_add,
        commands::git::git_commit,
        commands::git::git_checkout,
        commands::git::git_restore,
        commands::git::git_clean,
        commands::git::git_branches,
        commands::git::git_init,
        commands::git::git_is_repo,
        commands::git::git_push,
        commands::git::git_pull,
        commands::git::git_fetch,
        commands::git::git_create_branch,
        commands::git::git_clone,
        commands::git::git_reset,
        commands::git::git_show,
        commands::git::git_run,
        commands::git::git_log_graph,
        commands::git::git_rebase,
        commands::index::index_build,
        commands::index::index_search,
        commands::index::index_update,
        commands::index::index_stats,
        commands::index::index_clear,
        commands::keymap::keymap_get_defaults,
        commands::keymap::keymap_get_all,
        commands::lsp::lsp_get_server_registry,
        commands::lsp::lsp_get_supported_languages,
        commands::lsp::lsp_start_server,
        commands::lsp::lsp_send_request,
        commands::lsp::lsp_stop_server,
        commands::lsp::lsp_list_servers,
        commands::menu::update_menu_labels,
        commands::os::get_all_env,
        commands::os::get_user_data_dir,
        commands::path::parse_path,
        commands::path::join_paths,
        commands::path::relative_path,
        commands::path::glob_match,
        commands::path::ext_category,
        commands::path::is_binary_file,
        commands::path::common_parent,
        commands::profiles::profiles_load,
        commands::profiles::profiles_save,
        commands::profiles::profiles_load_associations,
        commands::profiles::profiles_save_associations,
        commands::search::search_files,
        commands::search::search_text,
        commands::search::search_workspace,
        commands::search::search_workspace_grouped,
        commands::search::search_workspace_replace_preview,
        commands::search::search_workspace_replace_apply,
        commands::secrets::secret_get,
        commands::secrets::secret_set,
        commands::secrets::secret_delete,
        commands::secrets::secret_keys,
        commands::settings::settings_get,
        commands::settings::settings_update,
        commands::settings::settings_load,
        commands::storage::storage_set,
        commands::storage::storage_list,
        commands::storage::storage_delete,
        commands::syntax::syntax_get_languages,
        commands::syntax::syntax_detect_language,
        commands::syntax::syntax_detect_from_content,
        commands::syntax::syntax_get_language_config,
        commands::syntax::syntax_tokenize,
        commands::tasks::task_spawn,
        commands::tasks::task_kill,
        commands::tasks::task_list,
        commands::tasks::tasks_detect,
        commands::tasks::tasks_parse_config,
        commands::terminal::terminal_spawn,
        commands::terminal::terminal_write,
        commands::terminal::terminal_resize,
        commands::terminal::terminal_kill,
        commands::terminal::terminal_get_pid,
        commands::terminal::terminal_interrupt,
        commands::terminal::terminal_busy,
        commands::terminal::terminal_state,
        commands::terminal::get_default_shell,
        commands::terminal::check_shell_exists,
        commands::terminal::get_available_shells,
        commands::terminal::get_shell_integration_dir,
        commands::terminal::setup_zsh_dotdir,
        commands::text::count_lines,
        commands::text::file_summary,
        commands::text::trim_trailing_whitespace,
        commands::text::file_hash,
        commands::text::files_equal,
        commands::theme::theme_list,
        commands::theme::theme_get,
        commands::theme::theme_get_default_dark,
        commands::theme::theme_get_default_light,
        commands::watch::watch_start,
        commands::watch::watch_stop,
        commands::watch::watch_update_patterns,
        commands::watch::watch_list,
        commands::watch::watch_is_active,
        commands::window::create_window,
        commands::window::close_window,
        commands::window::save_window_state,
    ];
    handler(invoke)
}

/// Ends every process the editor started on this machine: PTYs, tasks, debug
/// adapters and the extension host. The host calls it when the editor moves
/// to another project, so nothing from the previous one keeps running and the
/// extension host is rebuilt under the new project's policy.
pub fn reset_processes(app: &tauri::AppHandle) {
    if let Some(store) = app.try_state::<Arc<TerminalStore>>() { store.kill_all(); }
    if let Some(store) = app.try_state::<Arc<TaskProcessStore>>() { store.kill_all(); }
    if let Some(store) = app.try_state::<Arc<DebugAdapterStore>>() { store.kill_all(); }
    if let Some(host) = app.try_state::<ExtensionPlatformSupervisor>() { let _ = host.stop(); }
}

pub fn shutdown(app: &tauri::AppHandle) {
    reset_processes(app);
}

/// Directories the editor legitimately touches besides the open project: its
/// own data (settings, keybindings, storage, logs), installed extensions and
/// the bundled resources. The host confines every path the workbench sends
/// to these plus the project folder.
pub fn editor_roots(app: &tauri::AppHandle) -> Vec<std::path::PathBuf> {
    let mut roots = vec![
        crate::app_dirs::app_data_dir(),
        commands::extension_platform::user_extensions_dir(),
        commands::extension_platform::global_storage_dir(),
        commands::extension_platform::resolve_builtin_extensions_dir(app),
    ];
    if let Ok(dir) = app.path().resource_dir() { roots.push(dir); }
    roots
}

/// Where the editor's git commands run. `None` restores git on this machine.
pub use sidex_git::{set_launcher as set_git_launcher, GitLauncher};

/// What the host reuses to run a project's editor services inside a
/// container: the extension scan and init data (rewritten to container
/// paths), settings loading from text, and the language server and debug
/// adapter launchers that take an explicit command line.
pub mod host {
    pub use crate::commands::debug::{
        dap_command_line, dap_start_with, debug_spawn_command, DapClientStore, DebugAdapterStore,
    };
    pub use crate::commands::extension_platform::{
        build_extension_descriptions, build_init_data, global_storage_dir, path_to_uri_path,
        resolve_builtin_extensions_dir, scan_extensions, user_extensions_dir,
    };
    pub use crate::commands::lsp::{lsp_start_with, LspStartArgs, LspState};
    pub use crate::commands::settings::SettingsStore;
}

/// Extension ids the platform never loads, whatever the project.
const ALWAYS_DISABLED_EXTENSIONS: &str = "ms-python.vscode-pylance";

/// Extensions the next extension host start must skip, on top of the ones
/// that are always disabled. Takes effect when the host is (re)started: call
/// `reset_processes` afterwards for a running one.
pub fn set_disabled_extensions(extra: &[&str]) {
    let mut ids = vec![ALWAYS_DISABLED_EXTENSIONS];
    ids.extend_from_slice(extra);
    std::env::set_var("SIDEX_DISABLE_EXTENSION_IDS", ids.join(","));
}
