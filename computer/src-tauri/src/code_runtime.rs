//! Process and file policy of the Code tab.
//!
//! A **local** project runs the embedded workbench against this machine,
//! confined to its folder: every path the workbench names is checked here, at
//! the IPC boundary, and the webview may only navigate to that folder.
//!
//! A **container** project keeps the workbench as a client and nothing else on
//! this machine. Files, search, watchers, terminals, tasks, git, the extension
//! host, language servers and debug adapters all run inside the project's
//! container. The desktop asks: one agent connection over `engine exec -i`
//! (stdin in, stdout out) for files and events, and a `engine exec` per
//! terminal, task, git or server process. Nothing is mounted from this disk,
//! no port is published, and the container never opens anything towards the
//! desktop: the only inbound path is the loopback tunnel the desktop itself
//! opens to reach the extension host, byte for byte through the agent.

use base64::Engine as _;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Where the editor's runtime lives in the tools image (see server/sandbox.js).
const CONTAINER_RUNTIME_DIR: &str = "/opt/synthorg-code";
/// The extension host's own data inside the container.
const CONTAINER_DATA_DIR: &str = "/root/.synthorg-code";

/// Editor commands the agent in the container answers; the payload is
/// forwarded as the workbench sent it.
const AGENT_COMMANDS: &[&str] = &[
    "get_cwd",
    "read_file",
    "read_file_bytes",
    "write_file",
    "write_file_bytes",
    "read_dir",
    "stat",
    "mkdir",
    "remove",
    "rename",
    "exists",
    "search_files",
    "search_text",
    "search_workspace",
    "search_workspace_grouped",
    "search_workspace_replace_preview",
    "search_workspace_replace_apply",
    "watch_start",
    "watch_stop",
    "watch_update_patterns",
    "watch_list",
    "watch_is_active",
    "count_lines",
    "file_summary",
    "file_hash",
    "files_equal",
    "sha256_file",
    "md5_file",
    "file_hashes",
    "is_binary_file",
    "tasks_detect",
    "tasks_parse_config",
];

/// Editor commands re-implemented here for the container.
const CONTAINER_COMMANDS: &[&str] = &[
    "terminal_spawn",
    "terminal_write",
    "terminal_resize",
    "terminal_kill",
    "terminal_get_pid",
    "get_default_shell",
    "get_available_shells",
    "check_shell_exists",
    "get_shell_integration_dir",
    "task_spawn",
    "task_kill",
    "task_list",
    "exec",
    "get_all_env",
    "settings_load",
    "lsp_start_server",
    "debug_spawn_adapter",
    "dap_start_adapter",
    "extension_platform_bootstrap",
    "extension_platform_status",
    "extension_platform_restart",
    "extension_platform_stop",
    "extension_platform_init_data",
    "index_build",
    "index_search",
    "index_update",
    "index_stats",
    "index_clear",
];

/// Editor commands that only exist for this machine: refused in a container project.
const REFUSED_COMMANDS: &[&str] = &[
    "setup_zsh_dotdir",
    "install_extension",
    "install_extension_from_url",
    "uninstall_extension",
    "extension_search_marketplace",
    "create_window",
    "zip_list",
    "zip_extract_file",
    "zip_create",
    "wasm_load_extension",
];

const REFUSED_MESSAGE: &str =
    "Non disponibile in un progetto isolato: questa funzione userebbe il tuo PC, fuori dal container.";

const AGENT_TIMEOUT: Duration = Duration::from_secs(120);
const AGENT_START_TIMEOUT: Duration = Duration::from_secs(30);
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const DEFAULT_EXEC_TIMEOUT_MS: u64 = 30_000;
const MAX_EXEC_TIMEOUT_MS: u64 = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Runtime descriptor, as sent by the SynthOrg page, and its validated form
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct EngineSpec {
    bin: String,
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RuntimeSpec {
    Host,
    Container {
        engine: EngineSpec,
        container: String,
        workdir: String,
    },
}

/// A container the editor is bound to: everything it does goes through
/// `engine exec` into `name`, where the project is the directory `workdir`.
#[derive(Clone, Debug)]
pub struct Container {
    /// The engine command: program followed by its fixed arguments.
    engine: Vec<String>,
    name: String,
    workdir: String,
}

fn clean_arg(value: &str) -> bool {
    !value.is_empty() && !value.contains('\0') && !value.chars().any(char::is_control)
}

fn valid_name(value: &str, pattern_first: fn(char) -> bool) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(pattern_first)
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

impl EngineSpec {
    fn validate(self) -> Result<Vec<String>, String> {
        if !clean_arg(&self.bin) || self.args.iter().any(|a| !clean_arg(a)) {
            return Err("invalid container engine".into());
        }
        let file = Path::new(&self.bin)
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        let has_dir = self.bin.contains(['/', '\\']);
        if has_dir && !Path::new(&self.bin).is_absolute() {
            return Err("invalid container engine".into());
        }
        if matches!(file.as_str(), "wsl" | "wsl.exe") {
            // `--exec` runs podman directly instead of through the distro's
            // shell, so every argument reaches it untouched.
            return match self.args.as_slice() {
                // `synthorg-podman` is the distro's own wrapper: podman as an
                // unprivileged user, in the cgroup delegated to it.
                [flag, distro, tool]
                    if flag == "-d" && (tool == "podman" || tool == "synthorg-podman") && valid_name(distro, |c| c.is_ascii_alphanumeric()) =>
                {
                    Ok(vec![self.bin, "-d".into(), distro.clone(), "--exec".into(), tool.clone()])
                }
                [flag, distro, exec, tool]
                    if flag == "-d" && exec == "--exec" && (tool == "podman" || tool == "synthorg-podman") && valid_name(distro, |c| c.is_ascii_alphanumeric()) =>
                {
                    Ok(vec![self.bin, "-d".into(), distro.clone(), "--exec".into(), tool.clone()])
                }
                _ => Err("invalid container engine".into()),
            };
        }
        if !matches!(file.as_str(), "podman" | "podman.exe" | "docker" | "docker.exe") || !self.args.is_empty() {
            return Err("invalid container engine".into());
        }
        Ok(vec![self.bin])
    }
}

fn valid_workdir(value: &str) -> bool {
    value.starts_with('/')
        && value.len() > 1
        && clean_arg(value)
        && !value.contains(char::is_whitespace)
        && !value.split('/').any(|part| part == "..")
}

/// Windows paths compare case-insensitively; keep the original spelling for
/// what ends up inside the container, where case matters.
fn fold(value: &str) -> String {
    if cfg!(windows) {
        value.replace('/', "\\").to_ascii_lowercase()
    } else {
        value.to_string()
    }
}

fn trim_separators(value: &str) -> &str {
    value.trim_end_matches(['/', '\\'])
}

impl RuntimeSpec {
    /// The validated runtime: `None` for this machine, or the container.
    pub fn validate(self) -> Result<Option<Container>, String> {
        match self {
            RuntimeSpec::Host => Ok(None),
            RuntimeSpec::Container { engine, container, workdir } => {
                let engine = engine.validate()?;
                let slug = container.strip_prefix("synthorg-code-").unwrap_or_default();
                if container.len() > 100
                    || !slug.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
                    || !slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'))
                    || slug.ends_with(['-', '_', '.'])
                {
                    return Err("invalid container name".into());
                }
                if !valid_workdir(&workdir) {
                    return Err("invalid container workdir".into());
                }
                Ok(Some(Container { engine, name: container, workdir: trim_separators(&workdir).to_string() }))
            }
        }
    }
}

impl Container {
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn workdir(&self) -> &str {
        &self.workdir
    }

    /// The `file:` URI the workbench opens for this project.
    pub fn folder_uri(&self) -> String {
        format!("file://{}", self.workdir)
    }

    /// A path as the workbench spells it (its own OS's separators, sometimes a
    /// `\\?\` prefix) turned into the container's, and kept inside the project.
    fn container_path(&self, value: &str) -> Result<String, String> {
        if !clean_arg(value) {
            return Err(format!("Percorso non valido: {value}"));
        }
        let mut path = value.strip_prefix(r"\\?\").unwrap_or(value).replace('\\', "/");
        // A drive letter or a UNC prefix names this machine, never the container.
        if path.as_bytes().get(1) == Some(&b':') || path.starts_with("//") {
            return Err(format!("Percorso fuori dal progetto isolato: {value}"));
        }
        if !path.starts_with('/') {
            path = format!("{}/{path}", self.workdir);
        }
        let mut parts: Vec<&str> = Vec::new();
        for part in path.split('/') {
            match part {
                "" | "." => {}
                ".." => return Err(format!("Percorso non valido: {value}")),
                other => parts.push(other),
            }
        }
        let normalized = format!("/{}", parts.join("/"));
        if normalized == self.workdir || normalized.starts_with(&format!("{}/", self.workdir)) {
            Ok(normalized)
        } else {
            Err(format!("Percorso fuori dal progetto isolato: {value}"))
        }
    }

    /// The working directory inside the container for an optional cwd.
    fn cwd(&self, requested: Option<&str>) -> String {
        requested
            .filter(|dir| !dir.is_empty())
            .and_then(|dir| self.container_path(dir).ok())
            .unwrap_or_else(|| self.workdir.clone())
    }

    fn exec_args(&self, cwd: &str, tty: bool, env: &[(String, String)], argv: &[String]) -> Vec<String> {
        let mut args: Vec<String> = self.engine[1..].to_vec();
        args.push("exec".into());
        args.push(if tty { "-it" } else { "-i" }.into());
        args.push("-w".into());
        args.push(cwd.into());
        for (key, value) in env {
            args.push("--env".into());
            args.push(format!("{key}={value}"));
        }
        args.push(self.name.clone());
        args.extend_from_slice(argv);
        args
    }

    /// A non-interactive command inside the container.
    fn command(&self, cwd: &str, env: &[(String, String)], argv: &[String]) -> Command {
        let mut cmd = Command::new(&self.engine[0]);
        cmd.args(self.exec_args(cwd, false, env, argv));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd
    }

    /// The project's editor: a process in the container whose stdout is
    /// frames and whose stdin is input (server/code-editor, code_canvas.rs).
    /// The editor on the project's directory; `title` names it at the top of the tree.
    pub fn editor_command(&self, title: Option<&str>) -> Command {
        let mut argv = vec![format!("{CONTAINER_RUNTIME_DIR}/editor"), self.workdir.clone()];
        if let Some(title) = title.map(str::trim).filter(|t| clean_arg(t)) {
            argv.push(title.chars().take(120).collect());
        }
        self.command(&self.workdir, &[], &argv)
    }

    /// The `git` command SideX's git provider runs for a repository.
    fn git_command(&self, repo_root: Option<&Path>) -> Result<Command, String> {
        let root = repo_root.ok_or("Non disponibile in un progetto isolato: git lavora solo sulla cartella del progetto.")?;
        let cwd = self.container_path(&root.to_string_lossy())?;
        Ok(self.command(&cwd, &[], &["git".to_string()]))
    }

    /// `program` and the arguments that run `argv` inside the container, for
    /// a process whose stdio is the protocol (language servers, debug adapters).
    fn exec_line(&self, cwd: &str, argv: &[String]) -> (String, Vec<String>) {
        (self.engine[0].clone(), self.exec_args(cwd, false, &[], argv))
    }
}

// ---------------------------------------------------------------------------
// The agent in the container
// ---------------------------------------------------------------------------

/// One `engine exec -i node agent.cjs` per container project: requests go
/// down its stdin, answers and events come up its stdout. See
/// server/code-agent.cjs for the protocol.
pub struct Agent {
    name: String,
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
    /// Desktop-side sockets of the extension host tunnel, by connection id.
    conns: Mutex<HashMap<u64, TcpStream>>,
}

impl Agent {
    fn start(app: &AppHandle, container: &Container) -> Result<Arc<Agent>, String> {
        let argv = vec!["node".to_string(), format!("{CONTAINER_RUNTIME_DIR}/agent.cjs")];
        let mut cmd = container.command(&container.workdir, &[], &argv);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("Impossibile avviare l'agente nel container {}: {e}", container.name))?;
        let stdin = child.stdin.take().ok_or("agent stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("agent stdout unavailable")?;
        let stderr = child.stderr.take();
        let agent = Arc::new(Agent {
            name: container.name.clone(),
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(Some(stdin)),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            conns: Mutex::new(HashMap::new()),
        });

        let reader = agent.clone();
        let reader_app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
                if let Some(id) = message.get("id").and_then(Value::as_u64) {
                    let outcome = if message.get("ok").and_then(Value::as_bool) == Some(true) {
                        Ok(message.get("result").cloned().unwrap_or(Value::Null))
                    } else {
                        Err(message.get("error").and_then(Value::as_str).unwrap_or("agent error").to_string())
                    };
                    if let Some(sender) = reader.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
                        let _ = sender.send(outcome);
                    }
                } else if let Some(event) = message.get("event").and_then(Value::as_str) {
                    reader.on_event(&reader_app, event, message.get("payload").cloned().unwrap_or(Value::Null));
                }
            }
            // The agent is gone: nobody will answer what is still pending.
            let pending: Vec<_> = reader.pending.lock().unwrap_or_else(|e| e.into_inner()).drain().collect();
            for (_, sender) in pending {
                let _ = sender.send(Err("L'agente del container si è chiuso.".into()));
            }
            log::info!("[code agent {}] ended", reader.name);
        });
        if let Some(stderr) = stderr {
            let name = container.name.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    log::warn!("[code agent {name} stderr] {line}");
                }
            });
        }

        agent.call_timeout("ping", json!({}), AGENT_START_TIMEOUT).map_err(|e| {
            agent.stop();
            format!("L'agente dell'editor non risponde nel container {}: {e}", container.name)
        })?;
        Ok(agent)
    }

    fn write(&self, message: &Value) -> Result<(), String> {
        let mut guard = self.stdin.lock().unwrap_or_else(|e| e.into_inner());
        let stdin = guard.as_mut().ok_or("L'agente del container non è attivo.")?;
        writeln!(stdin, "{message}").and_then(|()| stdin.flush()).map_err(|e| format!("agent write: {e}"))
    }

    fn call_timeout(&self, op: &str, mut params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = mpsc::channel();
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(id, sender);
        if !params.is_object() {
            params = json!({});
        }
        params["id"] = json!(id);
        params["op"] = json!(op);
        if let Err(error) = self.write(&params) {
            self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            return Err(error);
        }
        match receiver.recv_timeout(timeout) {
            Ok(outcome) => outcome,
            Err(_) => {
                self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                Err(format!("Nessuna risposta dal container per {op}."))
            }
        }
    }

    /// A request the agent answers.
    pub fn call(&self, op: &str, params: Value) -> Result<Value, String> {
        self.call_timeout(op, params, AGENT_TIMEOUT)
    }

    /// A message the agent does not answer.
    fn notify(&self, op: &str, mut params: Value) {
        if !params.is_object() {
            params = json!({});
        }
        params["op"] = json!(op);
        let _ = self.write(&params);
    }

    fn on_event(&self, app: &AppHandle, event: &str, payload: Value) {
        match event {
            "watch-batch" => {
                let _ = app.emit("watch-batch", payload);
            }
            "net-data" => {
                let conn = payload.get("conn").and_then(Value::as_u64).unwrap_or(0);
                let data = payload.get("data").and_then(Value::as_str).unwrap_or("");
                let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) else { return };
                let mut conns = self.conns.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(stream) = conns.get_mut(&conn) {
                    if stream.write_all(&bytes).is_err() {
                        conns.remove(&conn);
                    }
                }
            }
            "net-close" => {
                let conn = payload.get("conn").and_then(Value::as_u64).unwrap_or(0);
                if let Some(stream) = self.conns.lock().unwrap_or_else(|e| e.into_inner()).remove(&conn) {
                    let _ = stream.shutdown(std::net::Shutdown::Both);
                }
            }
            "exthost-log" => log::debug!("[code agent {} ext-host] {}", self.name, payload.as_str().unwrap_or_default()),
            "exthost-exit" => log::warn!("[code agent {}] extension host exited: {payload}", self.name),
            "agent-error" => log::error!("[code agent {}] {}", self.name, payload.as_str().unwrap_or_default()),
            "ready" => log::info!("[code agent {}] ready: {payload}", self.name),
            _ => {}
        }
    }

    fn stop(&self) {
        *self.stdin.lock().unwrap_or_else(|e| e.into_inner()) = None;
        for (_, stream) in self.conns.lock().unwrap_or_else(|e| e.into_inner()).drain() {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
        if let Some(mut child) = self.child.lock().unwrap_or_else(|e| e.into_inner()).take() {
            // Closing stdin is the agent's own signal to end everything it
            // started; give it a moment before insisting.
            for _ in 0..20 {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// The loopback listener the workbench connects to for the extension host;
/// every accepted socket becomes one tunnelled connection to the host's port
/// inside the container.
struct Relay {
    port: u16,
    stopped: Arc<AtomicBool>,
}

impl Relay {
    fn start(agent: Arc<Agent>, remote_port: u16) -> Result<Relay, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("relay bind: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let stopped = Arc::new(AtomicBool::new(false));
        let flag = stopped.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if flag.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(stream) = stream else { continue };
                let agent = agent.clone();
                std::thread::spawn(move || tunnel(agent, stream, remote_port));
            }
        });
        Ok(Relay { port, stopped })
    }

    fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        // Wakes the accept loop so it sees the flag.
        let _ = TcpStream::connect(("127.0.0.1", self.port));
    }
}

fn tunnel(agent: Arc<Agent>, mut stream: TcpStream, remote_port: u16) {
    let conn = match agent.call("net_open", json!({ "port": remote_port })).ok().and_then(|v| v.as_u64()) {
        Some(conn) => conn,
        None => {
            let _ = stream.shutdown(std::net::Shutdown::Both);
            return;
        }
    };
    let _ = stream.set_nodelay(true);
    if let Ok(writer) = stream.try_clone() {
        agent.conns.lock().unwrap_or_else(|e| e.into_inner()).insert(conn, writer);
    }
    let mut buf = [0u8; 16384];
    loop {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                agent.notify("net_send", json!({ "conn": conn, "data": data }));
            }
        }
    }
    agent.notify("net_close", json!({ "conn": conn }));
    agent.conns.lock().unwrap_or_else(|e| e.into_inner()).remove(&conn);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

struct Pty {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send>,
}

#[derive(Default)]
pub struct CodeRuntime {
    container: Mutex<Option<Container>>,
    /// The project folder of a local project: every path the editor sends
    /// stays within it.
    workspace: Mutex<Option<PathBuf>>,
    /// The editor's own data and bundled resources, which it may also touch.
    editor_roots: Mutex<Vec<PathBuf>>,
    /// The only `folder` the editor webview may navigate to.
    folder_uri: Mutex<Option<String>>,
    /// Shells found inside the container, probed once per binding.
    shells: Mutex<Option<Vec<String>>>,
    terminals: Mutex<HashMap<u32, Pty>>,
    tasks: Mutex<HashMap<u32, Child>>,
    next_id: Mutex<u32>,
    agent: Mutex<Option<Arc<Agent>>>,
    relay: Mutex<Option<Relay>>,
}

impl CodeRuntime {
    fn current(&self) -> Result<Container, String> {
        self.container
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or_else(|| "no isolated project is open".to_string())
    }

    fn agent(&self) -> Result<Arc<Agent>, String> {
        self.agent
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or_else(|| "L'agente dell'editor non è attivo in questo container: riapri il progetto.".to_string())
    }

    fn next_id(&self) -> u32 {
        let mut next = self.next_id.lock().unwrap_or_else(|e| e.into_inner());
        *next += 1;
        *next
    }

    fn stop_relay(&self) {
        if let Some(relay) = self.relay.lock().unwrap_or_else(|e| e.into_inner()).take() {
            relay.stop();
        }
    }

    fn kill_all(&self) {
        let mut terminals = self.terminals.lock().unwrap_or_else(|e| e.into_inner());
        for (_, mut pty) in terminals.drain() {
            let _ = pty.child.kill();
            let _ = pty.child.wait();
        }
        let mut tasks = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
        for (_, mut child) in tasks.drain() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.stop_relay();
        if let Some(agent) = self.agent.lock().unwrap_or_else(|e| e.into_inner()).take() {
            agent.stop();
        }
    }

    fn shells(&self, container: &Container) -> Vec<String> {
        if let Some(shells) = self.shells.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            return shells;
        }
        let script = "for s in /bin/bash /usr/bin/bash /bin/zsh /usr/bin/zsh /bin/fish /usr/bin/fish /bin/sh; do [ -x \"$s\" ] && echo \"$s\"; done";
        let probe = run_with_timeout(
            container.command(&container.workdir, &[], &["sh".into(), "-c".into(), script.into()]),
            PROBE_TIMEOUT,
        );
        let mut shells: Vec<String> = probe
            .map(|result| result.stdout.lines().map(str::trim).filter(|l| l.starts_with('/')).map(String::from).collect())
            .unwrap_or_default();
        if shells.is_empty() {
            shells.push("/bin/sh".into());
        }
        *self.shells.lock().unwrap_or_else(|e| e.into_inner()) = Some(shells.clone());
        shells
    }
}

/// Binds the editor to the project at `folder` (the only place its paths may
/// point to and the only `folder` it may navigate to) and to `container`, or
/// to this machine with `None`. Everything the previous project had running
/// is ended first; the extension host is rebuilt for the new project when
/// the workbench reloads.
pub fn apply(app: &AppHandle, folder: &Path, folder_uri: &str, container: Option<Container>) {
    let state = app.state::<Arc<CodeRuntime>>();
    state.kill_all();
    *state.container.lock().unwrap_or_else(|e| e.into_inner()) = container.clone();
    *state.workspace.lock().unwrap_or_else(|e| e.into_inner()) = Some(folder.to_path_buf());
    *state.editor_roots.lock().unwrap_or_else(|e| e.into_inner()) = sidex_lib::editor_roots(app);
    *state.folder_uri.lock().unwrap_or_else(|e| e.into_inner()) = Some(folder_uri.to_string());
    *state.shells.lock().unwrap_or_else(|e| e.into_inner()) = None;
    log::info!("[code] project bound to {}", folder.display());
    sidex_lib::reset_processes(app);
    sidex_lib::set_disabled_extensions(&[]);
    match container {
        Some(container) => {
            log::info!("[code] isolated project: everything runs in container {}", container.name);
            let launcher_container = container.clone();
            let launcher: Arc<sidex_lib::GitLauncher> =
                Arc::new(move |root: Option<&Path>| launcher_container.git_command(root));
            sidex_lib::set_git_launcher(Some(launcher));
            match Agent::start(app, &container) {
                Ok(agent) => *state.agent.lock().unwrap_or_else(|e| e.into_inner()) = Some(agent),
                Err(error) => log::error!("[code] {error}"),
            }
        }
        None => sidex_lib::set_git_launcher(None),
    }
}

/// Ends whatever the Code tab has running: called when the app exits.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<Arc<CodeRuntime>>() {
        state.kill_all();
    }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/// The name of the container the editor is bound to, if any.
pub fn bound_container(app: &AppHandle) -> Option<String> {
    app.try_state::<Arc<CodeRuntime>>()?
        .container
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|c| c.name.clone())
}

/// Whether the editor is currently bound to a container.
pub fn is_isolated(message: &tauri::ipc::InvokeMessage<tauri::Wry>) -> bool {
    message
        .webview_ref()
        .try_state::<Arc<CodeRuntime>>()
        .is_some_and(|state| state.container.lock().unwrap_or_else(|e| e.into_inner()).is_some())
}

fn payload_json(message: &tauri::ipc::InvokeMessage<tauri::Wry>) -> Value {
    match message.payload() {
        tauri::ipc::InvokeBody::Json(value) => value.clone(),
        tauri::ipc::InvokeBody::Raw(_) => Value::Null,
    }
}

/// Handles an editor command for the bound container. Every command the
/// workbench can send passes through here; what is not answered by the
/// container, re-implemented here or refused is a pure computation or the
/// editor's own state, and goes to the editor library as for a local project.
pub fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let command = invoke.message.command().to_string();
    if REFUSED_COMMANDS.contains(&command.as_str()) {
        log::info!("[code] refused {command} in an isolated project");
        invoke.resolver.reject(REFUSED_MESSAGE);
        return true;
    }
    if AGENT_COMMANDS.contains(&command.as_str()) {
        // The workbench keeps its own data (settings, caches, storage) in
        // this machine's app data, which it names with host paths: those
        // stay here. Anything else it names is the project, in the container.
        let state = invoke.message.webview_ref().try_state::<Arc<CodeRuntime>>().map(|s| s.inner().clone());
        let route = state.as_ref().map_or(Route::Container, |state| state.route(&command, &payload_json(&invoke.message)));
        return match route {
            Route::Container => {
                forward(invoke);
                true
            }
            Route::Host => sidex_lib::handle(invoke),
            Route::Refused(message) => {
                log::info!("[code] refused {command}: {message}");
                invoke.resolver.reject(message);
                true
            }
        };
    }
    if command == "ext_api_call" {
        // The `env` namespace is the desktop itself: clipboard, external
        // URLs, the shell. Extension code runs in the container and gets
        // no hand on this machine.
        let namespace = payload_json(&invoke.message).get("namespace").and_then(Value::as_str).unwrap_or_default().to_string();
        if namespace == "env" {
            invoke.resolver.reject(REFUSED_MESSAGE);
            return true;
        }
        return sidex_lib::handle(invoke);
    }
    if command == "settings_load" {
        // User settings are the desktop's own file; workspace settings are a
        // file of the project, read in the container.
        let scope = payload_json(&invoke.message).get("scope").and_then(Value::as_str).unwrap_or_default().to_string();
        if scope != "workspace" {
            return sidex_lib::handle(invoke);
        }
    }
    if CONTAINER_COMMANDS.contains(&command.as_str()) {
        let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
            terminal_spawn,
            terminal_write,
            terminal_resize,
            terminal_kill,
            terminal_get_pid,
            get_default_shell,
            get_available_shells,
            check_shell_exists,
            get_shell_integration_dir,
            task_spawn,
            task_kill,
            task_list,
            exec,
            get_all_env,
            settings_load,
            lsp_start_server,
            debug_spawn_adapter,
            dap_start_adapter,
            extension_platform_bootstrap,
            extension_platform_status,
            extension_platform_restart,
            extension_platform_stop,
            extension_platform_init_data,
            index_build,
            index_search,
            index_update,
            index_stats,
            index_clear
        ];
        return handler(invoke);
    }
    sidex_lib::handle(invoke)
}

/// Where a path-bearing command of a container project is answered.
enum Route {
    Container,
    Host,
    Refused(String),
}

/// A path that names this machine: a drive letter, a UNC share, a `\\?\` prefix.
fn is_host_path(path: &str) -> bool {
    let path = path.strip_prefix(r"\\?\").unwrap_or(path);
    path.as_bytes().get(1) == Some(&b':') || path.starts_with(r"\\") || path.starts_with("//")
}

impl CodeRuntime {
    /// Host paths are accepted only inside the editor's own data and go to
    /// the editor library; every other path is the project's and goes to the
    /// container. A command mixing the two, or naming this machine anywhere
    /// else, is refused.
    fn route(&self, command: &str, payload: &Value) -> Route {
        let roots = self.editor_roots.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let (mut host, mut container) = (0usize, 0usize);
        let mut outside: Option<String> = None;
        let mut classify = |value: &Value| {
            let Some(text) = value.as_str() else { return };
            if text.is_empty() {
                return;
            }
            let path = path_of(text).unwrap_or_default();
            if is_host_path(&path) {
                if within(&path, &roots) {
                    host += 1;
                } else {
                    outside.get_or_insert_with(|| text.to_string());
                }
            } else {
                container += 1;
            }
        };
        for name in path_args(command) {
            for key in [name.to_string(), snake_case(name)] {
                match payload.get(&key) {
                    Some(Value::Array(items)) => items.iter().for_each(&mut classify),
                    Some(value) => classify(value),
                    None => {}
                }
            }
        }
        if let Some(text) = outside {
            return Route::Refused(format!("Fuori dal progetto isolato: {text}"));
        }
        match (host, container) {
            (0, _) => Route::Container,
            (_, 0) => Route::Host,
            _ => Route::Refused("Percorsi di questo PC e del container nello stesso comando.".into()),
        }
    }
}

/// Sends the command to the agent as it came and answers with what comes back.
fn forward(invoke: tauri::ipc::Invoke<tauri::Wry>) {
    let command = invoke.message.command().to_string();
    let payload = payload_json(&invoke.message);
    let state = invoke.message.webview_ref().try_state::<Arc<CodeRuntime>>().map(|s| s.inner().clone());
    let resolver = invoke.resolver;
    std::thread::spawn(move || {
        let outcome = state
            .ok_or_else(|| "no isolated project is open".to_string())
            .and_then(|state| state.agent())
            .and_then(|agent| agent.call(&command, payload))
            .and_then(|value| {
                if command == "read_file_bytes" {
                    // The agent sends bytes as base64; the workbench expects the
                    // byte array the Rust command returns.
                    let text = value.as_str().unwrap_or_default();
                    let bytes = base64::engine::general_purpose::STANDARD.decode(text).map_err(|e| e.to_string())?;
                    Ok(Value::Array(bytes.into_iter().map(|b| json!(b)).collect()))
                } else {
                    Ok(value)
                }
            });
        match outcome {
            Ok(value) => resolver.resolve(value),
            Err(error) => resolver.reject(error),
        }
    });
}

// ---------------------------------------------------------------------------
// Confinement to the project folder (local projects)
// ---------------------------------------------------------------------------

/// Whether the editor webview may load `url`: only its own page, on the
/// folder the host bound it to. "Open Folder" and recent workspaces cannot
/// take it anywhere else.
pub fn navigation_allowed(state: &CodeRuntime, url: &tauri::Url) -> bool {
    if url.path() != "/code/index.html" {
        return false;
    }
    let bound = state.folder_uri.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let requested: Vec<String> = url.query_pairs().filter(|(k, _)| k == "folder").map(|(_, v)| v.into_owned()).collect();
    match (bound, requested.as_slice()) {
        (Some(bound), [folder]) => *folder == bound,
        _ => false,
    }
}

/// Editor commands that change the project's files.
///
/// Git records nothing on its own, so what follows one of these has to reach
/// the project's history: the SynthOrg page is told, gathers the burst of
/// saves and asks the service for a commit. The notice goes out before the
/// write is answered, on purpose — the page commits what is on disk once the
/// burst ends, so a write that failed simply leaves nothing to record.
const MUTATING_COMMANDS: &[&str] = &[
    "write_file",
    "write_file_bytes",
    "remove",
    "rename",
    "mkdir",
    "search_workspace_replace_apply",
    "zip_extract_file",
    "zip_create",
];

/// Event name the SynthOrg page listens on for the above.
pub const CHANGED_EVENT: &str = "synthorg-code-changed";

/// Tells the page the editor just wrote something in the open project.
pub fn note_write(message: &tauri::ipc::InvokeMessage<tauri::Wry>) {
    if !MUTATING_COMMANDS.contains(&message.command()) {
        return;
    }
    let _ = message.webview_ref().app_handle().emit_to("main", CHANGED_EVENT, ());
}

/// Editor commands that name files or directories, with the arguments to
/// check (camelCase, as the workbench sends them).
const PATH_ARGS: &[(&str, &[&str])] = &[
    ("read_file", &["path"]),
    ("read_file_bytes", &["path"]),
    ("write_file", &["path"]),
    ("write_file_bytes", &["path"]),
    ("read_dir", &["path"]),
    ("stat", &["path"]),
    ("mkdir", &["path"]),
    ("remove", &["path"]),
    ("rename", &["oldPath", "newPath"]),
    ("exists", &["path"]),
    ("search_files", &["root", "dir"]),
    ("search_text", &["root", "dir"]),
    ("search_workspace", &["root", "dir"]),
    ("search_workspace_grouped", &["root", "dir"]),
    ("search_workspace_replace_preview", &["root", "dir"]),
    ("search_workspace_replace_apply", &["root", "dir"]),
    ("watch_start", &["paths", "path"]),
    ("index_build", &["root", "path"]),
    ("index_update", &["root", "path", "paths"]),
    ("count_lines", &["path"]),
    ("file_summary", &["path"]),
    ("file_hash", &["path"]),
    ("files_equal", &["path1", "path2"]),
    ("is_binary_file", &["path"]),
    ("zip_list", &["path"]),
    ("zip_extract_file", &["zipPath"]),
    ("zip_create", &["sourceDir", "zipPath"]),
    ("sha256_file", &["path"]),
    ("md5_file", &["path"]),
    ("file_hashes", &["path"]),
    ("tasks_detect", &["workspace"]),
    ("tasks_parse_config", &["workspace"]),
    ("task_spawn", &["cwd"]),
    ("dap_get_launch_configs", &["workspace"]),
    ("debug_spawn_adapter", &["cwd"]),
    ("terminal_spawn", &["cwd"]),
    ("exec", &["cwd"]),
    ("settings_load", &["path"]),
    ("install_extension", &["vsixPath"]),
    ("extension_get_contributions", &["extensionDir"]),
    ("wasm_load_extension", &["wasmPath"]),
    ("wasm_sync_workspace_folders", &["folders"]),
];

fn snake_case(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 4);
    for c in name.chars() {
        if c.is_ascii_uppercase() {
            out.push('_');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

fn is_git_command(command: &str) -> bool {
    command.starts_with("git_")
}

/// Whether `command` names paths the policy checks.
pub fn guards(command: &str) -> bool {
    is_git_command(command) || PATH_ARGS.iter().any(|(name, _)| *name == command)
}

fn path_args(command: &str) -> &'static [&'static str] {
    if is_git_command(command) {
        return &["path", "repoRoot"];
    }
    PATH_ARGS.iter().find(|(name, _)| *name == command).map_or(&[], |(_, args)| args)
}

/// Lexical containment: `path` equals one of `roots` or lies below it. No
/// `..`, no relative paths; Windows compares case-insensitively.
fn within(path: &str, roots: &[PathBuf]) -> bool {
    let path = path.strip_prefix(r"\\?\").unwrap_or(path);
    if !Path::new(path).is_absolute() || !clean_arg(path) {
        return false;
    }
    if Path::new(path).components().any(|c| matches!(c, Component::ParentDir)) {
        return false;
    }
    let separator = if cfg!(windows) { '\\' } else { '/' };
    let target = fold(trim_separators(path));
    roots.iter().any(|root| {
        let root = fold(trim_separators(&root.to_string_lossy()));
        !root.is_empty() && (target == root || target.starts_with(&format!("{root}{separator}")))
    })
}

fn path_of(value: &str) -> Option<String> {
    if value.starts_with("file:") {
        return tauri::Url::parse(value).ok()?.to_file_path().ok().map(|p| p.to_string_lossy().into_owned());
    }
    Some(value.to_string())
}

impl CodeRuntime {
    fn allowed_roots(&self) -> Option<Vec<PathBuf>> {
        let workspace = self.workspace.lock().unwrap_or_else(|e| e.into_inner()).clone()?;
        let mut roots = vec![workspace];
        roots.extend(self.editor_roots.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned());
        Some(roots)
    }

    /// Checks every path-bearing argument of `command` in `payload`.
    fn check_payload(&self, command: &str, payload: &Value) -> Result<(), String> {
        let Some(roots) = self.allowed_roots() else { return Ok(()) };
        let workspace = roots[0].display().to_string();
        let mut check = |value: &Value| -> Result<(), String> {
            let Some(text) = value.as_str() else { return Ok(()) };
            if text.is_empty() {
                return Ok(());
            }
            let path = path_of(text).unwrap_or_default();
            if within(&path, &roots) {
                return Ok(());
            }
            log::info!("[code] refused {command}: {text} is outside {workspace}");
            Err(format!("Fuori dal progetto: l'editor può usare solo {workspace} (richiesto: {text})."))
        };
        for name in path_args(command) {
            for key in [name.to_string(), snake_case(name)] {
                match payload.get(&key) {
                    Some(Value::Array(items)) => items.iter().try_for_each(&mut check)?,
                    Some(value) => check(value)?,
                    None => {}
                }
            }
        }
        Ok(())
    }
}

/// Refuses a guarded command whose paths leave the bound project (local projects).
pub fn check_paths(message: &tauri::ipc::InvokeMessage<tauri::Wry>) -> Result<(), String> {
    let command = message.command();
    if !guards(command) {
        return Ok(());
    }
    let Some(state) = message.webview_ref().try_state::<Arc<CodeRuntime>>() else { return Ok(()) };
    match message.payload() {
        tauri::ipc::InvokeBody::Json(value) => state.check_payload(command, value),
        tauri::ipc::InvokeBody::Raw(_) => Err("Richiesta non riconosciuta per un comando con percorsi.".into()),
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

struct Finished {
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    timed_out: bool,
}

fn read_to_string<R: Read + Send + 'static>(reader: Option<R>) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut reader) = reader {
            let _ = reader.read_to_end(&mut buf);
        }
        String::from_utf8_lossy(&buf).into_owned()
    })
}

fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Result<Finished, String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Impossibile eseguire il comando nel container: {e}"))?;
    let stdout = read_to_string(child.stdout.take());
    let stderr = read_to_string(child.stderr.take());
    let started = Instant::now();
    let (exit_code, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (status.code(), false),
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                break (None, true);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(e) => return Err(format!("Errore nell'attesa del comando: {e}")),
        }
    };
    Ok(Finished {
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
        exit_code,
        timed_out,
    })
}

/// Single-quotes a word for a POSIX shell.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn valid_shell(value: &str) -> bool {
    value.starts_with('/')
        && clean_arg(value)
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'))
        && !value.split('/').any(|part| part == "..")
}

fn shell_basename(value: &str) -> &str {
    value.rsplit('/').next().unwrap_or(value)
}

/// Environment for a shell in the container: terminal capabilities only.
/// Nothing from this machine's environment is forwarded.
fn terminal_env(env: Option<&HashMap<String, String>>) -> Vec<(String, String)> {
    let mut vars = vec![
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
        ("TERM_PROGRAM".to_string(), "SynthOrg".to_string()),
        ("LANG".to_string(), "C.UTF-8".to_string()),
    ];
    if let Some(lang) = env.and_then(|e| e.get("LANG")).filter(|v| clean_arg(v) && !v.contains(char::is_whitespace)) {
        vars[3].1 = lang.clone();
    }
    vars
}

/// Environment for a task or command: what the editor asked for, minus
/// anything that names a location on this machine.
fn task_env(env: Option<HashMap<String, String>>) -> Vec<(String, String)> {
    env.unwrap_or_default()
        .into_iter()
        .filter(|(key, value)| {
            valid_name(key, |c| c.is_ascii_alphabetic() || c == '_')
                && !key.contains(['-', '.'])
                && !matches!(key.as_str(), "PATH" | "HOME" | "USERPROFILE" | "APPDATA" | "LOCALAPPDATA" | "TEMP" | "TMP" | "SystemRoot" | "COMSPEC")
                && !value.contains('\0')
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Terminals: a local PTY whose process is `engine exec -it … <shell>`
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct TerminalDataEvent {
    terminal_id: u32,
    data: String,
}

#[derive(Clone, Serialize)]
struct TerminalExitEvent {
    terminal_id: u32,
    exit_code: i32,
}

#[tauri::command]
#[allow(clippy::too_many_arguments, clippy::needless_pass_by_value)]
fn terminal_spawn(
    app: AppHandle,
    state: State<'_, Arc<CodeRuntime>>,
    shell: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<u32, String> {
    let container = state.current()?;
    let shells = state.shells(&container);
    // The workbench runs on this machine and offers this machine's profiles
    // (PowerShell, cmd, Git Bash…): anything that is not a shell of the
    // container becomes the container's default shell, with its own arguments.
    let requested = shell.filter(|s| !s.is_empty()).filter(|s| valid_shell(s) && shells.contains(s));
    let args = if requested.is_some() { args } else { None };
    let shell = requested.unwrap_or_else(|| shells[0].clone());
    let mut argv = vec![shell.clone()];
    match args {
        Some(args) => {
            if args.iter().any(|a| !clean_arg(a) && !a.is_empty()) {
                return Err("Argomenti della shell non validi.".into());
            }
            argv.extend(args);
        }
        None => {
            if matches!(shell_basename(&shell), "sh" | "ash" | "bash" | "zsh" | "fish") {
                argv.push("-l".into());
            }
        }
    }

    let pair = native_pty_system()
        .openpty(PtySize { rows: rows.unwrap_or(24), cols: cols.unwrap_or(80), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("Impossibile aprire il terminale: {e}"))?;

    let mut cmd = CommandBuilder::new(&container.engine[0]);
    cmd.args(container.exec_args(&container.cwd(cwd.as_deref()), true, &terminal_env(env.as_ref()), &argv));
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Impossibile avviare la shell nel container {}: {e}", container.name))?;
    drop(pair.slave);
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let terminal_id = state.next_id();
    state
        .terminals
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(terminal_id, Pty { writer, master: pair.master, child });

    // The console names the PTY after the engine executable on this machine;
    // the terminal tab should say what actually runs.
    let title = format!("{} · {}", shell_basename(&shell), container.name);
    let reader_app = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut titles = TitleRewriter::new(title);
        loop {
            match reader.read(&mut buf) {
                Ok(n) if n > 0 => {
                    if let Some(data) = titles.push(&buf[..n]) {
                        let _ = reader_app.emit("terminal-data", TerminalDataEvent { terminal_id, data });
                    }
                }
                _ => break,
            }
        }
        if let Some(data) = titles.flush() {
            let _ = reader_app.emit("terminal-data", TerminalDataEvent { terminal_id, data });
        }
    });

    // On Windows the output pipe only ends once the pseudo console is closed,
    // so the exit is watched separately: the handle is dropped after the
    // shell ends, which lets the reader finish.
    let store = state.inner().clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(200));
            let mut terminals = store.terminals.lock().unwrap_or_else(|e| e.into_inner());
            let Some(pty) = terminals.get_mut(&terminal_id) else { return };
            match pty.child.try_wait() {
                Ok(Some(status)) => {
                    let handle = terminals.remove(&terminal_id);
                    drop(terminals);
                    // Let the reader deliver what the shell printed last.
                    std::thread::sleep(Duration::from_millis(150));
                    drop(handle);
                    let exit_code = i32::try_from(status.exit_code()).unwrap_or(1);
                    let _ = app.emit("terminal-exit", TerminalExitEvent { terminal_id, exit_code });
                    return;
                }
                Ok(None) => {}
                Err(_) => {
                    terminals.remove(&terminal_id);
                    drop(terminals);
                    let _ = app.emit("terminal-exit", TerminalExitEvent { terminal_id, exit_code: -1 });
                    return;
                }
            }
        }
    });

    Ok(terminal_id)
}

/// Rewrites the first window-title sequence (`ESC ] 0 ; title BEL`) a
/// terminal emits, which on Windows names the engine executable.
struct TitleRewriter {
    title: String,
    pending: Vec<u8>,
    done: bool,
}

impl TitleRewriter {
    const LOOKAHEAD: usize = 4096;

    fn new(title: String) -> Self {
        Self { title, pending: Vec::new(), done: false }
    }

    fn push(&mut self, chunk: &[u8]) -> Option<String> {
        if self.done {
            return Some(String::from_utf8_lossy(chunk).into_owned());
        }
        self.pending.extend_from_slice(chunk);
        let start = self.pending.windows(4).position(|w| w == b"\x1b]0;");
        match start {
            Some(start) => {
                let body = &self.pending[start + 4..];
                let end = body.iter().position(|b| *b == 0x07).map(|i| (i, 1))
                    .or_else(|| body.windows(2).position(|w| w == b"\x1b\\").map(|i| (i, 2)));
                match end {
                    Some((len, terminator)) => {
                        let mut out = self.pending[..start].to_vec();
                        out.extend_from_slice(b"\x1b]0;");
                        out.extend_from_slice(self.title.as_bytes());
                        out.extend_from_slice(if terminator == 1 { b"\x07" } else { b"\x1b\\" });
                        out.extend_from_slice(&body[len + terminator..]);
                        self.pending.clear();
                        self.done = true;
                        Some(String::from_utf8_lossy(&out).into_owned())
                    }
                    None if self.pending.len() < Self::LOOKAHEAD => None,
                    None => self.flush(),
                }
            }
            None if self.pending.len() < Self::LOOKAHEAD
                && [&b"\x1b"[..], b"\x1b]", b"\x1b]0"].iter().any(|tail| self.pending.ends_with(tail)) => None,
            None => {
                if self.pending.len() >= Self::LOOKAHEAD {
                    self.done = true;
                }
                let out = std::mem::take(&mut self.pending);
                Some(String::from_utf8_lossy(&out).into_owned())
            }
        }
    }

    fn flush(&mut self) -> Option<String> {
        self.done = true;
        if self.pending.is_empty() {
            return None;
        }
        let out = std::mem::take(&mut self.pending);
        Some(String::from_utf8_lossy(&out).into_owned())
    }
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn terminal_write(state: State<'_, Arc<CodeRuntime>>, terminal_id: u32, data: String) -> Result<(), String> {
    let mut terminals = state.terminals.lock().unwrap_or_else(|e| e.into_inner());
    let pty = terminals.get_mut(&terminal_id).ok_or("terminal not found")?;
    pty.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    pty.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn terminal_resize(state: State<'_, Arc<CodeRuntime>>, terminal_id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let terminals = state.terminals.lock().unwrap_or_else(|e| e.into_inner());
    let pty = terminals.get(&terminal_id).ok_or("terminal not found")?;
    pty.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn terminal_kill(state: State<'_, Arc<CodeRuntime>>, terminal_id: u32) -> Result<(), String> {
    let removed = state.terminals.lock().unwrap_or_else(|e| e.into_inner()).remove(&terminal_id);
    if let Some(mut pty) = removed {
        let _ = pty.child.kill();
        let _ = pty.child.wait();
    }
    Ok(())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn terminal_get_pid(state: State<'_, Arc<CodeRuntime>>, terminal_id: u32) -> Result<u32, String> {
    let terminals = state.terminals.lock().unwrap_or_else(|e| e.into_inner());
    let pty = terminals.get(&terminal_id).ok_or("terminal not found")?;
    Ok(pty.child.process_id().unwrap_or(terminal_id))
}

#[derive(Serialize)]
struct ShellInfo {
    name: String,
    path: String,
    is_default: bool,
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn get_default_shell(state: State<'_, Arc<CodeRuntime>>) -> Result<String, String> {
    let container = state.current()?;
    Ok(state.shells(&container)[0].clone())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn get_available_shells(state: State<'_, Arc<CodeRuntime>>) -> Result<Vec<ShellInfo>, String> {
    let container = state.current()?;
    let mut seen = std::collections::HashSet::new();
    Ok(state
        .shells(&container)
        .into_iter()
        .enumerate()
        .filter(|(_, path)| seen.insert(shell_basename(path).to_string()))
        .map(|(index, path)| ShellInfo {
            name: format!("{} · {}", shell_basename(&path), container.name),
            path,
            is_default: index == 0,
        })
        .collect())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn check_shell_exists(state: State<'_, Arc<CodeRuntime>>, path: String) -> Result<bool, String> {
    let container = state.current()?;
    Ok(state.shells(&container).contains(&path))
}

#[tauri::command]
fn get_shell_integration_dir() -> String {
    format!("{CONTAINER_RUNTIME_DIR}/shell-integration")
}

/// This machine's environment is nobody's business in the container.
#[tauri::command]
fn get_all_env() -> HashMap<String, String> {
    HashMap::new()
}

// ---------------------------------------------------------------------------
// Tasks and one-off commands
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct TaskOutputEvent {
    task_id: u32,
    data: String,
    stream: &'static str,
}

#[derive(Clone, Serialize)]
struct TaskExitEvent {
    task_id: u32,
    exit_code: Option<i32>,
}

fn forward_output<R: Read + Send + 'static>(app: AppHandle, task_id: u32, stream: &'static str, reader: Option<R>) -> Option<std::thread::JoinHandle<()>> {
    let mut reader = reader?;
    Some(std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            let data = String::from_utf8_lossy(&buf[..n]).into_owned();
            let _ = app.emit("task-output", TaskOutputEvent { task_id, data, stream });
        }
    }))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn task_spawn(
    app: AppHandle,
    state: State<'_, Arc<CodeRuntime>>,
    command: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    shell: Option<bool>,
) -> Result<u32, String> {
    let container = state.current()?;
    let args = args.unwrap_or_default();
    if !clean_arg(&command) || args.iter().any(|a| a.contains('\0')) {
        return Err("Comando non valido.".into());
    }
    let argv: Vec<String> = if shell.unwrap_or(true) {
        let line = std::iter::once(command.clone())
            .chain(args.iter().map(|a| shell_quote(a)))
            .collect::<Vec<_>>()
            .join(" ");
        vec!["sh".into(), "-c".into(), line]
    } else {
        std::iter::once(command).chain(args).collect()
    };

    let mut cmd = container.command(&container.cwd(cwd.as_deref()), &task_env(env), &argv);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Impossibile avviare il task nel container {}: {e}", container.name))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let task_id = state.next_id();
    state.tasks.lock().unwrap_or_else(|e| e.into_inner()).insert(task_id, child);

    let out = forward_output(app.clone(), task_id, "stdout", stdout);
    let err = forward_output(app.clone(), task_id, "stderr", stderr);
    let store = state.inner().clone();
    std::thread::spawn(move || {
        if let Some(handle) = out {
            let _ = handle.join();
        }
        if let Some(handle) = err {
            let _ = handle.join();
        }
        // Taken out of the map before waiting, so a hung wait never holds the lock.
        let child = store.tasks.lock().unwrap_or_else(|e| e.into_inner()).remove(&task_id);
        let exit_code = child.and_then(|mut child| child.wait().ok()).and_then(|status| status.code());
        let _ = app.emit("task-exit", TaskExitEvent { task_id, exit_code });
    });
    Ok(task_id)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn task_kill(state: State<'_, Arc<CodeRuntime>>, task_id: u32) -> Result<(), String> {
    let removed = state.tasks.lock().unwrap_or_else(|e| e.into_inner()).remove(&task_id);
    let mut child = removed.ok_or_else(|| format!("task {task_id} not found"))?;
    let _ = child.kill();
    let _ = child.wait();
    Ok(())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn task_list(state: State<'_, Arc<CodeRuntime>>) -> Result<Vec<u32>, String> {
    Ok(state.tasks.lock().unwrap_or_else(|e| e.into_inner()).keys().copied().collect())
}

#[derive(Serialize)]
struct ExecResult {
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    timed_out: bool,
}

#[tauri::command]
async fn exec(
    state: State<'_, Arc<CodeRuntime>>,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    timeout_ms: Option<u64>,
) -> Result<ExecResult, String> {
    let container = state.current()?;
    if !clean_arg(&command) || args.iter().any(|a| a.contains('\0')) {
        return Err("Comando non valido.".into());
    }
    let argv: Vec<String> = std::iter::once(command).chain(args).collect();
    let cmd = container.command(&container.cwd(cwd.as_deref()), &task_env(env), &argv);
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_EXEC_TIMEOUT_MS).clamp(1, MAX_EXEC_TIMEOUT_MS));
    let finished = tauri::async_runtime::spawn_blocking(move || run_with_timeout(cmd, timeout))
        .await
        .map_err(|e| e.to_string())??;
    Ok(ExecResult {
        stdout: finished.stdout,
        stderr: finished.stderr,
        exit_code: finished.exit_code,
        timed_out: finished.timed_out,
    })
}

// ---------------------------------------------------------------------------
// Settings, language servers, debug adapters
// ---------------------------------------------------------------------------

/// Workspace settings are a file of the project: fetched from the container,
/// parsed here.
#[tauri::command]
async fn settings_load(app: AppHandle, state: State<'_, Arc<CodeRuntime>>, path: String, scope: String) -> Result<(), String> {
    if scope != "workspace" {
        return Err("invalid scope for an isolated project".into());
    }
    let container = state.current()?;
    let agent = state.agent()?;
    let target = container.container_path(&path)?;
    let text = tauri::async_runtime::spawn_blocking(move || agent.call("read_file", json!({ "path": target })))
        .await
        .map_err(|e| e.to_string())??;
    let store = app.state::<Arc<sidex_lib::host::SettingsStore>>();
    store.load_workspace_text(text.as_str().unwrap_or_default())
}

/// The language server runs in the container; its stdio is the protocol,
/// carried by `engine exec`.
#[tauri::command]
async fn lsp_start_server(
    app: AppHandle,
    state: State<'_, Arc<CodeRuntime>>,
    lsp: State<'_, Arc<sidex_lib::host::LspState>>,
    args: sidex_lib::host::LspStartArgs,
) -> Result<serde_json::Value, String> {
    let container = state.current()?;
    let (command, server_args) = lsp.resolve_command(&args)?;
    if !clean_arg(&command) || server_args.iter().any(|a| !clean_arg(a)) {
        return Err("Comando del language server non valido.".into());
    }
    let argv: Vec<String> = std::iter::once(command).chain(server_args).collect();
    let (program, exec_args) = container.exec_line(&container.workdir, &argv);
    let result = sidex_lib::host::lsp_start_with(app, lsp.inner(), program, exec_args, args.root_uri).await?;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn debug_spawn_adapter(
    app: AppHandle,
    state: State<'_, Arc<CodeRuntime>>,
    adapters: State<'_, Arc<sidex_lib::host::DebugAdapterStore>>,
    executable: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
) -> Result<u32, String> {
    let container = state.current()?;
    let args = args.unwrap_or_default();
    if !clean_arg(&executable) || args.iter().any(|a| !clean_arg(a)) {
        return Err("Comando del debug adapter non valido.".into());
    }
    let argv: Vec<String> = std::iter::once(executable.clone()).chain(args).collect();
    let cmd = container.command(&container.cwd(cwd.as_deref()), &task_env(env), &argv);
    sidex_lib::host::debug_spawn_command(app, adapters.inner(), cmd, &executable)
}

#[tauri::command]
async fn dap_start_adapter(
    app: AppHandle,
    state: State<'_, Arc<CodeRuntime>>,
    clients: State<'_, Arc<sidex_lib::host::DapClientStore>>,
    type_name: String,
    config: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let container = state.current()?;
    let adapter = sidex_lib::host::dap_command_line(&type_name)?;
    // The adapter command line is split on whitespace by the DAP client, so
    // every part of the engine command must be a single word.
    let (program, exec_args) = container.exec_line(&container.workdir, &[]);
    let parts: Vec<String> = std::iter::once(program).chain(exec_args).collect();
    if parts.iter().any(|p| p.contains(char::is_whitespace)) {
        return Err("Il percorso del container engine contiene spazi: debug non disponibile in questo progetto.".into());
    }
    let command_line = format!("{} {adapter}", parts.join(" "));
    let config = serde_json::from_value(config).map_err(|e| format!("launch configuration: {e}"))?;
    let result = sidex_lib::host::dap_start_with(app, clients.inner(), command_line, config).await?;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Extension host: runs in the container, reached through the tunnel
// ---------------------------------------------------------------------------

/// Every spelling of a host directory the init data may carry: as a path,
/// with forward slashes, and as the path of a `file:` URI.
fn host_prefixes(dir: &Path) -> Vec<String> {
    let raw = dir.to_string_lossy().to_string();
    let raw = raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_string();
    let mut forms = vec![raw.clone(), raw.replace('\\', "/"), sidex_lib::host::path_to_uri_path(&raw)];
    forms.sort();
    forms.dedup();
    forms.retain(|f| f.len() > 1);
    forms
}

/// Replaces, in every string of `value`, a host directory prefix with its
/// container counterpart.
fn rewrite_paths(value: &mut Value, rewrites: &[(Vec<String>, String)]) {
    match value {
        Value::String(text) => {
            for (prefixes, target) in rewrites {
                for prefix in prefixes {
                    if text.starts_with(prefix.as_str()) {
                        let rest = text[prefix.len()..].replace('\\', "/");
                        *text = format!("{target}{rest}");
                        return;
                    }
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| rewrite_paths(item, rewrites)),
        Value::Object(map) => map.values_mut().for_each(|item| rewrite_paths(item, rewrites)),
        _ => {}
    }
}

struct ContainerExtensions {
    init_data: Value,
    summaries: Vec<Value>,
}

/// The init data of the bundled extensions, as the container sees them.
fn container_extensions(app: &AppHandle, container: &Container) -> Result<ContainerExtensions, String> {
    use sidex_lib::host::*;
    let builtin = resolve_builtin_extensions_dir(app);
    let manifests: Vec<_> = scan_extensions(app, &[builtin.clone()]).into_iter().filter(|m| m.builtin).collect();
    let descriptions = build_extension_descriptions(&manifests);
    let init_data = build_init_data(&descriptions, &[container.workdir.to_string()]);
    let mut json = serde_json::to_value(&init_data).map_err(|e| e.to_string())?;
    let rewrites = vec![
        (host_prefixes(&builtin), format!("{CONTAINER_RUNTIME_DIR}/extensions")),
        (host_prefixes(&user_extensions_dir()), format!("{CONTAINER_DATA_DIR}/extensions")),
        (host_prefixes(&global_storage_dir()), format!("{CONTAINER_DATA_DIR}/globalStorage")),
    ];
    rewrite_paths(&mut json, &rewrites);
    json["environment"]["appRoot"] = json!(CONTAINER_RUNTIME_DIR);
    json["environment"]["workspaceStorageHome"]["path"] = json!(format!("{CONTAINER_DATA_DIR}/workspaceStorage"));
    json["logsLocation"]["path"] = json!(format!("{CONTAINER_DATA_DIR}/logs"));
    let summaries = manifests
        .iter()
        .map(|m| {
            let mut location = json!(m.path);
            rewrite_paths(&mut location, &rewrites);
            json!({
                "id": m.id, "name": m.display_name, "version": m.version, "kind": m.kind,
                "activationEvents": m.activation_events, "main": m.main, "browser": m.browser,
                "wasmBinary": m.wasm_binary, "contributes": m.contributes_keys, "location": location,
            })
        })
        .collect();
    Ok(ContainerExtensions { init_data: json, summaries })
}

fn ext_host_start(app: &AppHandle, state: &Arc<CodeRuntime>) -> Result<Value, String> {
    let container = state.current()?;
    let agent = state.agent()?;
    let extensions = container_extensions(app, &container)?;
    let init_json = serde_json::to_string(&extensions.init_data).map_err(|e| e.to_string())?;
    let mut env = serde_json::Map::new();
    if let Ok(disabled) = std::env::var("SIDEX_DISABLE_EXTENSION_IDS") {
        env.insert("SIDEX_DISABLE_EXTENSION_IDS".into(), json!(disabled));
    }
    state.stop_relay();
    let started = agent.call("exthost_start", json!({ "initData": init_json, "env": env }))?;
    let remote_port = u16::try_from(started.get("port").and_then(Value::as_u64).unwrap_or(0)).map_err(|_| "bad extension host port")?;
    if remote_port == 0 {
        return Err("L'extension host nel container non ha riportato una porta.".into());
    }
    let relay = Relay::start(agent, remote_port)?;
    let local_port = relay.port;
    *state.relay.lock().unwrap_or_else(|e| e.into_inner()) = Some(relay);
    log::info!("[code] extension host of {} on container port {remote_port}, tunnel 127.0.0.1:{local_port}", container.name);
    Ok(json!({
        "transport": { "kind": "websocket", "endpoint": format!("ws://127.0.0.1:{local_port}/") },
        "runtime": { "path": "node", "version": Value::Null, "source": "container", "bundled": false },
        "paths": {
            "serverScript": format!("{CONTAINER_RUNTIME_DIR}/extension-host/server.cjs"),
            "builtinExtensionsDir": format!("{CONTAINER_RUNTIME_DIR}/extensions"),
            "userExtensionsDir": format!("{CONTAINER_DATA_DIR}/extensions"),
            "globalStorageDir": format!("{CONTAINER_DATA_DIR}/globalStorage"),
        },
        "sessionKind": "container",
        "extensions": extensions.summaries,
        "initDataJson": init_json,
    }))
}

fn ext_host_status(app: &AppHandle, state: &Arc<CodeRuntime>) -> Result<Value, String> {
    let container = state.current()?;
    let status = state.agent()?.call("exthost_status", json!({}))?;
    let count = container_extensions(app, &container).map(|e| e.summaries.len()).unwrap_or(0);
    let port = state.relay.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|r| r.port);
    Ok(json!({
        "running": status.get("running").and_then(Value::as_bool).unwrap_or(false),
        "port": port,
        "sessionId": status.get("session").cloned().unwrap_or(Value::Null),
        "uptimeSecs": Value::Null,
        "extensionCount": count,
        "restartCount": 0,
        "totalCrashes": 0,
    }))
}

#[tauri::command]
async fn extension_platform_bootstrap(app: AppHandle, state: State<'_, Arc<CodeRuntime>>) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || ext_host_start(&app, &state)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn extension_platform_status(app: AppHandle, state: State<'_, Arc<CodeRuntime>>) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || ext_host_status(&app, &state)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn extension_platform_restart(app: AppHandle, state: State<'_, Arc<CodeRuntime>>) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        ext_host_start(&app, &state)?;
        ext_host_status(&app, &state)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn extension_platform_stop(state: State<'_, Arc<CodeRuntime>>) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.stop_relay();
        state.agent()?.call("exthost_stop", json!({})).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn extension_platform_init_data(app: AppHandle, state: State<'_, Arc<CodeRuntime>>) -> Result<String, String> {
    let container = state.current()?;
    let extensions = container_extensions(&app, &container)?;
    serde_json::to_string(&extensions.init_data).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Search index: the container's files are not indexed on this machine
// ---------------------------------------------------------------------------

fn empty_index_stats(root: &str) -> Value {
    json!({ "total_files": 0, "total_words": 0, "memory_bytes": 0, "root_path": root })
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn index_build(root: String) -> Value {
    empty_index_stats(&root)
}

#[tauri::command]
fn index_search() -> Vec<Value> {
    Vec::new()
}

#[tauri::command]
fn index_update() {}

#[tauri::command]
fn index_stats() -> Value {
    empty_index_stats("")
}

#[tauri::command]
fn index_clear() {}

#[cfg(test)]
mod tests {
    use super::*;

    fn container() -> Container {
        Container {
            engine: vec!["wsl.exe".into(), "-d".into(), "synthorg-runtime".into(), "--exec".into(), "podman".into()],
            name: "synthorg-code-api".into(),
            workdir: "/workspace".into(),
        }
    }

    fn spec(bin: &str, args: &[&str]) -> EngineSpec {
        EngineSpec { bin: bin.into(), args: args.iter().map(|a| (*a).to_string()).collect() }
    }

    #[test]
    fn wsl_engine_runs_podman_without_the_distro_shell() {
        let argv = spec("wsl.exe", &["-d", "synthorg-runtime", "podman"]).validate().unwrap();
        assert_eq!(argv, vec!["wsl.exe", "-d", "synthorg-runtime", "--exec", "podman"]);
        let wrapped = spec("wsl.exe", &["-d", "synthorg-runtime", "synthorg-podman"]).validate().unwrap();
        assert_eq!(wrapped, vec!["wsl.exe", "-d", "synthorg-runtime", "--exec", "synthorg-podman"]);
        assert!(spec("wsl.exe", &["-d", "synthorg-runtime", "sh"]).validate().is_err());
        assert!(spec("wsl.exe", &["-d", "x y", "podman"]).validate().is_err());
        assert!(spec("wsl.exe", &[]).validate().is_err());
    }

    #[test]
    fn only_container_engines_are_accepted() {
        assert!(spec("podman", &[]).validate().is_ok());
        assert!(spec(r"C:\Program Files\RedHat\Podman\podman.exe", &[]).validate().is_ok());
        assert!(spec("podman", &["--remote"]).validate().is_err());
        assert!(spec("powershell.exe", &[]).validate().is_err());
        assert!(spec(r"bin\podman.exe", &[]).validate().is_err());
    }

    #[test]
    fn runtime_binds_only_to_project_containers() {
        let bound = RuntimeSpec::Container { engine: spec("podman", &[]), container: "synthorg-code-api".into(), workdir: "/workspace/".into() }
            .validate().unwrap().unwrap();
        assert_eq!(bound.workdir, "/workspace");
        assert_eq!(bound.folder_uri(), "file:///workspace");
        for name in ["api", "synthorg-code-", "synthorg-code-A", "synthorg-code-a b", "synthorg-code-a-"] {
            let bad = RuntimeSpec::Container { engine: spec("podman", &[]), container: name.into(), workdir: "/workspace".into() };
            assert!(bad.validate().is_err(), "{name}");
        }
        for dir in ["workspace", "/", "/a b", "/x/../y"] {
            let bad = RuntimeSpec::Container { engine: spec("podman", &[]), container: "synthorg-code-api".into(), workdir: dir.into() };
            assert!(bad.validate().is_err(), "{dir}");
        }
        assert!(RuntimeSpec::Host.validate().unwrap().is_none());
    }

    #[test]
    fn workbench_paths_map_into_the_container_and_never_out_of_it() {
        let c = container();
        assert_eq!(c.container_path("/workspace").unwrap(), "/workspace");
        assert_eq!(c.container_path("/workspace/src/Main.JS").unwrap(), "/workspace/src/Main.JS");
        // The workbench on Windows spells the same paths with backslashes.
        assert_eq!(c.container_path(r"\workspace\src\a.ts").unwrap(), "/workspace/src/a.ts");
        assert_eq!(c.container_path(r"\\?\\workspace\src").unwrap(), "/workspace/src");
        assert_eq!(c.container_path("src/lib").unwrap(), "/workspace/src/lib");
        assert_eq!(c.container_path("/workspace//src/./a").unwrap(), "/workspace/src/a");
        assert!(c.container_path("/workspace2/x").is_err());
        assert!(c.container_path("/workspace/../etc").is_err());
        assert!(c.container_path("/etc/passwd").is_err());
        assert!(c.container_path(r"C:\Windows").is_err());
        assert_eq!(c.cwd(Some("/etc")), "/workspace");
        assert_eq!(c.cwd(Some(r"\workspace\pkg")), "/workspace/pkg");
        assert_eq!(c.cwd(None), "/workspace");
    }

    #[test]
    fn exec_arguments_target_the_container() {
        let c = container();
        let args = c.exec_args("/workspace/src", true, &[("TERM".into(), "xterm".into())], &["/bin/sh".into(), "-l".into()]);
        assert_eq!(args, vec!["-d", "synthorg-runtime", "--exec", "podman", "exec", "-it", "-w", "/workspace/src", "--env", "TERM=xterm", "synthorg-code-api", "/bin/sh", "-l"]);
        let git = c.git_command(Some(Path::new(r"\workspace\pkg"))).unwrap();
        let argv: Vec<String> = git.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(argv, vec!["-d", "synthorg-runtime", "--exec", "podman", "exec", "-i", "-w", "/workspace/pkg", "synthorg-code-api", "git"]);
        assert!(c.git_command(None).is_err());
        assert!(c.git_command(Some(Path::new("/home"))).is_err());
        let (program, line) = c.exec_line("/workspace", &["typescript-language-server".into(), "--stdio".into()]);
        assert_eq!(program, "wsl.exe");
        assert_eq!(line.last().unwrap(), "--stdio");
    }

    #[test]
    fn init_data_paths_move_into_the_container() {
        let builtin = PathBuf::from(if cfg!(windows) { r"C:\Apps\SynthOrg\resources\extensions" } else { "/opt/synthorg/resources/extensions" });
        let rewrites = vec![(host_prefixes(&builtin), "/opt/synthorg-code/extensions".to_string())];
        let mut value = json!({
            "extensions": [{ "extensionLocation": { "scheme": "file", "path": sidex_lib::host::path_to_uri_path(&format!("{}{}git", builtin.display(), std::path::MAIN_SEPARATOR)) } }],
            "raw": format!("{}{}json", builtin.display(), std::path::MAIN_SEPARATOR),
            "other": "/workspace"
        });
        rewrite_paths(&mut value, &rewrites);
        assert_eq!(value["extensions"][0]["extensionLocation"]["path"], "/opt/synthorg-code/extensions/git");
        assert_eq!(value["raw"], "/opt/synthorg-code/extensions/json");
        assert_eq!(value["other"], "/workspace");
    }

    #[test]
    fn paths_stay_inside_the_project_or_the_editor_data() {
        let ws = if cfg!(windows) { r"C:\Proj\App" } else { "/srv/proj/app" };
        let data = if cfg!(windows) { r"C:\Users\x\AppData\Roaming\SynthOrg\Code" } else { "/home/x/.synthorg/code" };
        let state = CodeRuntime::default();
        *state.workspace.lock().unwrap() = Some(PathBuf::from(ws));
        *state.editor_roots.lock().unwrap() = vec![PathBuf::from(data)];
        let sep = if cfg!(windows) { '\\' } else { '/' };
        let ok = |cmd: &str, payload: Value| state.check_payload(cmd, &payload).is_ok();

        assert!(ok("read_file", json!({ "path": format!("{ws}{sep}src{sep}main.js") })));
        assert!(ok("read_file", json!({ "path": ws })));
        assert!(ok("settings_load", json!({ "path": format!("{data}{sep}UserData{sep}User{sep}settings.json"), "scope": "user" })));
        assert!(ok("rename", json!({ "oldPath": format!("{ws}{sep}a"), "newPath": format!("{ws}{sep}b") })));
        assert!(ok("watch_start", json!({ "paths": [format!("{ws}{sep}src"), ws] })));
        assert!(ok("git_status", json!({ "path": ws })));
        assert!(ok("read_file", json!({ "path": "" })));
        assert!(ok("sha256_hash", json!({ "data": [1, 2] })));

        assert!(!ok("read_file", json!({ "path": format!("{ws}2{sep}secret") })));
        assert!(!ok("read_file", json!({ "path": format!("{ws}{sep}..{sep}other") })));
        assert!(!ok("write_file", json!({ "path": if cfg!(windows) { r"C:\Windows\system.ini" } else { "/etc/passwd" }, "content": ws })));
        assert!(!ok("watch_start", json!({ "paths": [ws, if cfg!(windows) { r"C:\Users" } else { "/home" }] })));
        assert!(!ok("search_text", json!({ "root": "relative/dir", "query": "x" })));
        assert!(!ok("git_run", json!({ "path": if cfg!(windows) { r"D:\other" } else { "/other" }, "args": ["status"] })));

        // Nothing bound: nothing to enforce.
        let unbound = CodeRuntime::default();
        assert!(unbound.check_payload("read_file", &json!({ "path": "/etc/passwd" })).is_ok());
    }

    #[test]
    fn the_editor_only_navigates_to_its_bound_folder() {
        let state = CodeRuntime::default();
        let url = |s: &str| tauri::Url::parse(s).unwrap();
        assert!(!navigation_allowed(&state, &url("http://localhost/code/index.html?folder=file:///workspace")));
        *state.folder_uri.lock().unwrap() = Some("file:///workspace".into());
        assert!(navigation_allowed(&state, &url("http://localhost/code/index.html?folder=file%3A%2F%2F%2Fworkspace")));
        assert!(navigation_allowed(&state, &url("tauri://localhost/code/index.html?folder=file:///workspace")));
        assert!(!navigation_allowed(&state, &url("http://localhost/code/index.html?folder=file:///other")));
        assert!(!navigation_allowed(&state, &url("http://localhost/code/index.html?folder=file:///workspace&folder=file:///b")));
        assert!(!navigation_allowed(&state, &url("http://localhost/code/index.html")));
        assert!(!navigation_allowed(&state, &url("http://localhost/index.html?folder=file:///workspace")));
    }

    #[test]
    fn the_first_window_title_names_the_container_shell() {
        let mut r = TitleRewriter::new("sh · synthorg-code-api".into());
        assert_eq!(r.push(b"\x1b]0;C:\\WINDOWS\\system32\\wsl.exe\x07$ ").unwrap(), "\x1b]0;sh · synthorg-code-api\x07$ ");
        assert_eq!(r.push(b"\x1b]0;later\x07").unwrap(), "\x1b]0;later\x07");

        let mut r = TitleRewriter::new("sh".into());
        assert_eq!(r.push(b"pre\x1b]"), None);
        assert_eq!(r.push(b"0;C:\\wsl.exe"), None);
        assert_eq!(r.push(b"\x1b\\post").unwrap(), "pre\x1b]0;sh\x1b\\post");

        let mut r = TitleRewriter::new("sh".into());
        assert_eq!(r.push(b"hello\r\n").unwrap(), "hello\r\n");
        assert_eq!(r.flush(), None);
        let mut r = TitleRewriter::new("sh".into());
        assert_eq!(r.push(&[b'x'; 5000]).unwrap().len(), 5000);
        assert!(r.done);
    }

    #[test]
    fn task_environment_never_names_this_machine() {
        let env: HashMap<String, String> = [("PATH", "C:\\x"), ("HOME", "C:\\u"), ("NODE_ENV", "test"), ("bad-key", "1"), ("_X", "y")]
            .into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let mut kept = task_env(Some(env));
        kept.sort();
        assert_eq!(kept, vec![("NODE_ENV".to_string(), "test".to_string()), ("_X".to_string(), "y".to_string())]);
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert!(valid_shell("/bin/sh") && valid_shell("/usr/local/bin/fish"));
        assert!(!valid_shell("sh") && !valid_shell("/bin/../sh") && !valid_shell("/bin/sh -c"));
    }

    #[test]
    fn the_editor_data_stays_here_and_the_project_stays_in_the_container() {
        let data = if cfg!(windows) { r"C:\Users\x\AppData\Roaming\SynthOrg\Code" } else { "/home/x/.synthorg/code" };
        let state = CodeRuntime::default();
        *state.editor_roots.lock().unwrap() = vec![PathBuf::from(data)];
        let sep = if cfg!(windows) { '\\' } else { '/' };
        let route = |cmd: &str, payload: Value| state.route(cmd, &payload);

        assert!(matches!(route("read_file", json!({ "path": "/workspace/src/a.ts" })), Route::Container));
        assert!(matches!(route("read_file", json!({ "path": r"\workspace\src\a.ts" })), Route::Container));
        assert!(matches!(route("get_cwd", json!({})), Route::Container));
        assert!(matches!(route("watch_start", json!({ "paths": ["/workspace"] })), Route::Container));
        assert!(matches!(route("write_file", json!({ "path": format!("{data}{sep}UserData{sep}User{sep}cache.json"), "content": "" })), Route::Host));
        if cfg!(windows) {
            assert!(matches!(route("write_file", json!({ "path": r"c:\Users\x\AppData\Roaming\SynthOrg\Code\UserData\x.json" })), Route::Host));
            assert!(matches!(route("write_file", json!({ "path": r"C:\Users\x\Desktop\x.json" })), Route::Refused(_)));
            assert!(matches!(route("read_file", json!({ "path": r"\\server\share\x" })), Route::Refused(_)));
        }
        assert!(matches!(route("rename", json!({ "oldPath": "/workspace/a", "newPath": format!("{data}{sep}b") })), Route::Refused(_)));
        // A drive of this machine outside the editor data is refused; a posix
        // path outside the workspace is the container's problem to refuse.
        assert!(matches!(route("read_file", json!({ "path": r"D:\other" })), Route::Refused(_)));
        assert!(matches!(route("read_file", json!({ "path": "/other" })), Route::Container));
    }

    #[test]
    fn every_workbench_command_that_touches_the_project_has_a_container_answer() {
        // Commands answered in the container are never also re-implemented or refused.
        for command in AGENT_COMMANDS {
            assert!(!CONTAINER_COMMANDS.contains(command) && !REFUSED_COMMANDS.contains(command), "{command}");
        }
        for command in CONTAINER_COMMANDS {
            assert!(!REFUSED_COMMANDS.contains(command), "{command}");
        }
        // Everything the local policy guards is either forwarded, re-implemented or refused.
        for (command, _) in PATH_ARGS {
            let covered = AGENT_COMMANDS.contains(command) || CONTAINER_COMMANDS.contains(command) || REFUSED_COMMANDS.contains(command)
                || matches!(*command, "dap_get_launch_configs" | "extension_get_contributions" | "wasm_sync_workspace_folders");
            assert!(covered, "{command} would touch this machine in an isolated project");
        }
    }
}
