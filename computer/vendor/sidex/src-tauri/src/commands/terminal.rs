use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct PtyHandle {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send>,
    prompt: Arc<Mutex<PromptState>>,
}

/// Whether a terminal's shell is at its prompt with nothing typed, as the bytes
/// through it tell: its hooked prompt (see POWERSHELL_PROMPT_HOOK) says when it
/// is back, what is written to it says when it is not. Kept here, where every
/// byte passes from the terminal's birth, so SynthOrg never types into a
/// program the user is running nor after half a line of theirs.
#[derive(Default, Clone, Copy, Serialize)]
pub struct PromptState {
    /// Its prompt emits the signal: its state below can be trusted.
    hooked: bool,
    /// Back at the prompt since the last line was entered.
    idle: bool,
    /// Something typed at that prompt, not entered yet.
    typing: bool,
    /// The count of the last prompt: a command's end is the first prompt counted after it was sent.
    seq: u64,
}

/// The prompt's signal, as the console passes the hooked prompt's title on:
/// ESC ] 0 (or 2) ; synthorg:<count>:<exit code> BEL.
const PROMPT_SIGNAL: &str = ";synthorg:";

/// The count in the last prompt signal of a piece of output, if there is one.
fn prompt_count(text: &str) -> Option<u64> {
    let at = text.rfind(PROMPT_SIGNAL)?;
    if !(text[..at].ends_with("\x1b]0") || text[..at].ends_with("\x1b]2")) {
        return None;
    }
    let digits: String = text[at + PROMPT_SIGNAL.len()..].chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

pub struct TerminalStore {
    terminals: Mutex<HashMap<u32, PtyHandle>>,
    next_id: Mutex<u32>,
}

impl TerminalStore {
    pub fn kill_all(&self) {
        let mut terminals = self.terminals.lock().unwrap_or_else(|e| e.into_inner());
        for (_, mut terminal) in terminals.drain() {
            let _ = terminal.child.kill();
            let _ = terminal.child.wait();
        }
    }

    pub fn new() -> Self {
        Self {
            terminals: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct TerminalDataEvent {
    terminal_id: u32,
    data: String,
}

#[derive(Debug, Clone, Serialize)]
struct TerminalExitEvent {
    terminal_id: u32,
    exit_code: i32,
}

pub(crate) fn resolve_windows_shell() -> String {
    for candidate in ["pwsh.exe", "powershell.exe"] {
        if let Ok(path) = which::which(candidate) {
            return path.to_string_lossy().to_string();
        }
    }

    std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
}

#[cfg(target_os = "windows")]
fn is_git_bash_path(path: &std::path::Path) -> bool {
    let normalized = path.to_string_lossy().replace('/', "\\").to_lowercase();
    normalized.ends_with("\\git\\bin\\bash.exe")
        || normalized.ends_with("\\git\\usr\\bin\\bash.exe")
}

#[cfg(target_os = "windows")]
fn resolve_git_bash() -> Option<String> {
    let mut candidates = Vec::new();

    for key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(root) = std::env::var_os(key) {
            let root = std::path::PathBuf::from(root);
            candidates.push(root.join("Git").join("bin").join("bash.exe"));
            candidates.push(root.join("Git").join("usr").join("bin").join("bash.exe"));
            candidates.push(
                root.join("Programs")
                    .join("Git")
                    .join("bin")
                    .join("bash.exe"),
            );
            candidates.push(
                root.join("Programs")
                    .join("Git")
                    .join("usr")
                    .join("bin")
                    .join("bash.exe"),
            );
        }
    }

    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join("bash.exe"));
        }
    }

    candidates
        .into_iter()
        .find(|path| path.exists() && is_git_bash_path(path))
        .map(|path| path.to_string_lossy().to_string())
}

/// Wraps PowerShell's prompt so that, each time it comes back, it sets the
/// window title to "synthorg:<count>:<exit code of the line before>" — the
/// count goes up by one at every prompt. A prompt comes back however a command
/// ended (on its own, with a Ctrl+C, killed from outside), so SynthOrg knows
/// when each terminal is free, and when a command it typed is over and how.
/// A title and not a private sequence: the Windows console holds private
/// sequences back until its next repaint, while a title change is part of the
/// repaint itself, so it arrives right after the prompt, in order.
///
/// The exit code is worked out, never reset: a line stopped with Ctrl+C is
/// "Stopped" in the history (130); a program run since the last prompt is
/// noticed by a marker on $LASTEXITCODE that runs at each assignment and
/// leaves the value alone (its own code, even the same one twice); otherwise
/// the line's success (0 or 1). What the user sees in $LASTEXITCODE is what
/// PowerShell alone would show. The user's own prompt still runs.
const POWERSHELL_PROMPT_HOOK: &str = "class SynthOrgExitMark : System.Management.Automation.ArgumentTransformationAttribute { [object] Transform([System.Management.Automation.EngineIntrinsics]$engine, [object]$value) { $global:__soNative = $true; return $value } } ; if (-not $global:__soHook) { $global:__soHook = $function:prompt; $global:__soN = 0; $global:__soHist = 0 ; if (-not (Get-Variable LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue)) { Set-Variable -Scope Global -Name LASTEXITCODE -Value $null } ; (Get-Variable LASTEXITCODE -Scope Global).Attributes.Add([SynthOrgExitMark]::new()) ; $global:__soNative = $false ; function global:prompt { $ok = $? ; $h = Get-History -Count 1 ; $new = $h -and $h.Id -ne $global:__soHist ; $c = if ($new -and $h.ExecutionStatus -eq 'Stopped') { 130 } elseif ($global:__soNative) { $global:LASTEXITCODE } elseif ($ok) { 0 } else { 1 } ; $global:__soNative = $false ; if ($h) { $global:__soHist = $h.Id } ; $global:__soN++ ; [Console]::Title = 'synthorg:' + $global:__soN + ':' + $c ; & $global:__soHook } }";

#[tauri::command]
#[allow(
    clippy::too_many_lines,
    clippy::needless_pass_by_value,
    clippy::too_many_arguments
)]
pub fn terminal_spawn(
    app: AppHandle,
    state: State<'_, Arc<TerminalStore>>,
    shell: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<u32, String> {
    let pty_system = native_pty_system();

    let pty_cols = cols.unwrap_or(80);
    let pty_rows = rows.unwrap_or(24);

    let pair = pty_system
        .openpty(PtySize {
            rows: pty_rows,
            cols: pty_cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    #[allow(unused_mut)]
    let mut shell_path = shell.unwrap_or_else(|| {
        if cfg!(target_os = "windows") {
            resolve_windows_shell()
        } else {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
        }
    });

    #[cfg(target_os = "windows")]
    if std::path::Path::new(&shell_path)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("bash.exe"))
        && !is_git_bash_path(std::path::Path::new(&shell_path))
    {
        if let Some(git_bash) = resolve_git_bash() {
            shell_path = git_bash;
        }
    }

    if !cfg!(target_os = "windows") {
        let path = std::path::Path::new(&shell_path);
        if !path.exists() {
            let fallbacks = ["/bin/zsh", "/bin/bash", "/bin/sh"];
            for fb in &fallbacks {
                if std::path::Path::new(fb).exists() {
                    return terminal_spawn(
                        app,
                        state,
                        Some(fb.to_string()),
                        args,
                        cwd,
                        env,
                        cols,
                        rows,
                    );
                }
            }
            return Err(format!(
                "Shell '{shell_path}' not found, and no fallback shell available"
            ));
        }
    }

    let mut cmd = CommandBuilder::new(&shell_path);

    let is_powershell = {
        let base = std::path::Path::new(&shell_path)
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        base == "powershell" || base == "pwsh"
    };
    if is_powershell && args.as_ref().map_or(true, Vec::is_empty) {
        // SynthOrg: the prompt tells when a line is over (see POWERSHELL_PROMPT_HOOK).
        // Given at launch, so no setup line ever shows in the terminal.
        cmd.arg("-NoExit");
        cmd.arg("-Command");
        cmd.arg(POWERSHELL_PROMPT_HOOK);
    } else if let Some(ref shell_args) = args {
        for arg in shell_args {
            cmd.arg(arg);
        }
    } else {
        let shell_basename = std::path::Path::new(&shell_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        match shell_basename {
            "zsh" | "bash" | "sh" | "fish" => {
                cmd.arg("-l");
            }
            _ => {}
        }
    }

    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "SideX");

    if let Ok(home) = std::env::var("HOME") {
        cmd.env("HOME", &home);
    }
    if cfg!(target_os = "windows") {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            cmd.env("USERPROFILE", &profile);
            if std::env::var("HOME").is_err() {
                cmd.env("HOME", &profile);
            }
        }
        for key in &[
            "USERNAME",
            "APPDATA",
            "LOCALAPPDATA",
            "HOMEDRIVE",
            "HOMEPATH",
            "COMSPEC",
            "SystemRoot",
        ] {
            if let Ok(val) = std::env::var(key) {
                cmd.env(key, &val);
            }
        }
    } else if let Ok(user) = std::env::var("USER") {
        cmd.env("USER", &user);
    }
    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", &path);
    }
    if let Ok(lang) = std::env::var("LANG") {
        cmd.env("LANG", &lang);
    } else if !cfg!(target_os = "windows") {
        cmd.env("LANG", "en_US.UTF-8");
    }

    if let Some(ref dir) = cwd {
        if !dir.is_empty() && std::path::Path::new(dir).is_dir() {
            cmd.cwd(dir);
        } else if let Some(home) = home_dir_string() {
            cmd.cwd(&home);
        }
    } else if let Some(home) = home_dir_string() {
        cmd.cwd(&home);
    }

    if let Some(env_vars) = env {
        for (k, v) in env_vars {
            cmd.env(k, v);
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell '{shell_path}': {e}"))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {e}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to get PTY reader: {e}"))?;

    let id = {
        let mut next = state.next_id.lock().map_err(|e| e.to_string())?;
        let id = *next;
        *next += 1;
        id
    };

    let prompt = Arc::new(Mutex::new(PromptState::default()));

    {
        let mut terminals = state.terminals.lock().map_err(|e| e.to_string())?;
        terminals.insert(
            id,
            PtyHandle {
                writer,
                master: pair.master,
                child,
                prompt: prompt.clone(),
            },
        );
    }

    let terminal_id = id;
    let state_clone = state.inner().clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        // The end of the previous read: a signal split across two reads is still seen.
        let mut tail = String::new();
        loop {
            match reader.read(&mut buf) {
                Ok(n) if n > 0 => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    if let Some(seq) = prompt_count(&format!("{tail}{text}")) {
                        if let Ok(mut p) = prompt.lock() {
                            if seq != p.seq || !p.hooked {
                                *p = PromptState { hooked: true, idle: true, typing: false, seq };
                            }
                        }
                    }
                    tail = text.chars().rev().take(48).collect::<Vec<_>>().into_iter().rev().collect();
                    let _ = app.emit(
                        "terminal-data",
                        TerminalDataEvent {
                            terminal_id,
                            data: text,
                        },
                    );
                }
                Ok(_) | Err(_) => break,
            }
        }

        let exit_code = {
            let Ok(mut terminals) = state_clone.terminals.lock() else {
                let _ = app.emit(
                    "terminal-exit",
                    TerminalExitEvent {
                        terminal_id,
                        exit_code: -1,
                    },
                );
                return;
            };
            let code = if let Some(handle) = terminals.get_mut(&terminal_id) {
                match handle.child.try_wait() {
                    Ok(Some(status)) => i32::from(!status.success()),
                    _ => 0,
                }
            } else {
                0
            };
            terminals.remove(&terminal_id);
            code
        };

        let _ = app.emit(
            "terminal-exit",
            TerminalExitEvent {
                terminal_id,
                exit_code,
            },
        );
    });

    Ok(id)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn terminal_write(
    state: State<'_, Arc<TerminalStore>>,
    terminal_id: u32,
    data: String,
) -> Result<(), String> {
    let mut terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    let handle = terminals
        .get_mut(&terminal_id)
        .ok_or_else(|| format!("Terminal {terminal_id} not found"))?;

    if let Ok(mut p) = handle.prompt.lock() {
        if data.contains('\r') || data.contains('\n') {
            // A line entered: busy until the prompt comes back.
            p.idle = false;
            p.typing = false;
        } else if p.idle && !data.chars().all(|c| c == '\u{3}') {
            // Anything else at the prompt — keys, history, a paste — is a line being written.
            p.typing = true;
        }
    }

    handle
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write to terminal {terminal_id}: {e}"))?;

    handle
        .writer
        .flush()
        .map_err(|e| format!("Failed to flush terminal {terminal_id}: {e}"))?;

    Ok(())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn terminal_resize(
    state: State<'_, Arc<TerminalStore>>,
    terminal_id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    let handle = terminals
        .get(&terminal_id)
        .ok_or_else(|| format!("Terminal {terminal_id} not found"))?;

    handle
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize terminal {terminal_id}: {e}"))?;

    Ok(())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn terminal_kill(state: State<'_, Arc<TerminalStore>>, terminal_id: u32) -> Result<(), String> {
    let mut terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    let mut handle = terminals
        .remove(&terminal_id)
        .ok_or_else(|| format!("Terminal {terminal_id} not found"))?;

    handle
        .child
        .kill()
        .map_err(|e| format!("Failed to kill terminal {terminal_id}: {e}"))?;

    Ok(())
}

/// The pid has to be a shell of this store: nothing else can be looked into or ended from here.
fn owned_shell(state: &State<'_, Arc<TerminalStore>>, pid: u32) -> Result<(), String> {
    let terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    if terminals.values().any(|handle| handle.child.process_id() == Some(pid)) {
        Ok(())
    } else {
        Err(format!("pid {pid} is not a terminal of this workbench"))
    }
}

/// Ends what runs inside one of this store's shells — every process under it —
/// and leaves the shell itself alive, back at its prompt: SynthOrg's last resort
/// when a command it typed ignores Ctrl+C. Returns how many processes were ended.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn terminal_interrupt(state: State<'_, Arc<TerminalStore>>, pid: u32) -> Result<u32, String> {
    owned_shell(&state, pid)?;
    Ok(end_processes(&descendants(pid)))
}

/// Whether one of this store's shells is hooked, and free: at its prompt with nothing typed.
#[derive(Serialize)]
pub struct TerminalPromptInfo {
    hooked: bool,
    free: bool,
    seq: u64,
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn terminal_state(state: State<'_, Arc<TerminalStore>>, pid: u32) -> Result<TerminalPromptInfo, String> {
    let terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    let handle = terminals
        .values()
        .find(|handle| handle.child.process_id() == Some(pid))
        .ok_or_else(|| format!("pid {pid} is not a terminal of this workbench"))?;
    let p = handle.prompt.lock().map(|p| *p).unwrap_or_default();
    Ok(TerminalPromptInfo { hooked: p.hooked, free: p.hooked && p.idle && !p.typing, seq: p.seq })
}

/// How many processes run under one of this store's shells: 0 means the shell
/// is idle at its prompt, or running a built-in of its own.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn terminal_busy(state: State<'_, Arc<TerminalStore>>, pid: u32) -> Result<u32, String> {
    owned_shell(&state, pid)?;
    Ok(u32::try_from(descendants(pid).len()).unwrap_or(u32::MAX))
}

/// Every descendant of a process, the process itself excluded.
#[cfg(windows)]
// The process snapshot and termination are Win32 calls; the crate forbids
// unsafe everywhere else, and these are the places that need it.
#[allow(unsafe_code)]
fn descendants(root: u32) -> Vec<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    // When a process started: pids get reused, so a child is only one that
    // started after the process it names as its parent.
    fn started(pid: u32) -> Option<u64> {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle == 0 {
                return None;
            }
            let mut times: [FILETIME; 4] = std::mem::zeroed();
            let ok = GetProcessTimes(handle, &mut times[0], &mut times[1], &mut times[2], &mut times[3]) != 0;
            CloseHandle(handle);
            ok.then(|| (u64::from(times[0].dwHighDateTime) << 32) | u64::from(times[0].dwLowDateTime))
        }
    }

    let mut pairs: Vec<(u32, u32)> = Vec::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Vec::new();
        }
        let mut entry: PROCESSENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32>() as u32;
        if Process32First(snapshot, &mut entry) != 0 {
            loop {
                pairs.push((entry.th32ProcessID, entry.th32ParentProcessID));
                if Process32Next(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
    }

    let mut found: Vec<u32> = Vec::new();
    let mut frontier: Vec<(u32, Option<u64>)> = vec![(root, started(root))];
    while let Some((parent, parent_start)) = frontier.pop() {
        for &(pid, ppid) in &pairs {
            if ppid != parent || pid == root || found.contains(&pid) {
                continue;
            }
            let child_start = started(pid);
            let genuine = match (parent_start, child_start) {
                (Some(p), Some(c)) => c >= p,
                _ => false,
            };
            if genuine {
                found.push(pid);
                frontier.push((pid, child_start));
            }
        }
    }
    found
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn end_processes(pids: &[u32]) -> u32 {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    let mut ended = 0;
    for &pid in pids {
        unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if handle != 0 {
                if TerminateProcess(handle, 130) != 0 {
                    ended += 1;
                }
                CloseHandle(handle);
            }
        }
    }
    ended
}

#[cfg(not(windows))]
fn descendants(root: u32) -> Vec<u32> {
    let mut found = Vec::new();
    let listed = std::process::Command::new("pgrep").args(["-P", &root.to_string()]).output();
    let Ok(output) = listed else { return found };
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Ok(pid) = line.trim().parse::<u32>() {
            found.push(pid);
            found.extend(descendants(pid));
        }
    }
    found
}

#[cfg(not(windows))]
fn end_processes(pids: &[u32]) -> u32 {
    let mut ended = 0;
    for &pid in pids.iter().rev() {
        if std::process::Command::new("kill").args(["-TERM", &pid.to_string()]).status().map(|s| s.success()).unwrap_or(false) {
            ended += 1;
        }
    }
    ended
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn terminal_get_pid(
    state: State<'_, Arc<TerminalStore>>,
    terminal_id: u32,
) -> Result<u32, String> {
    let terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    let handle = terminals
        .get(&terminal_id)
        .ok_or_else(|| format!("Terminal {terminal_id} not found"))?;

    let pid = handle
        .child
        .process_id()
        .ok_or_else(|| "Process ID not available".to_string())?;

    Ok(pid)
}

fn home_dir_string() -> Option<String> {
    if cfg!(target_os = "windows") {
        std::env::var("USERPROFILE")
            .ok()
            .or_else(|| std::env::var("HOME").ok())
    } else {
        std::env::var("HOME").ok()
    }
}

#[tauri::command]
pub fn get_default_shell() -> String {
    if cfg!(target_os = "windows") {
        return resolve_windows_shell();
    }

    // 1. Check $SHELL (same as VS Code: shell.ts getSystemShellUnixLike)
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.is_empty() && shell != "/bin/false" {
            return shell;
        }
    }

    // 2. Read from passwd via libc (same as VS Code: os.userInfo().shell)
    #[cfg(unix)]
    {
        #[allow(unsafe_code)]
        unsafe {
            let uid = libc::getuid();
            let pw = libc::getpwuid(uid);
            if !pw.is_null() {
                let shell_cstr = std::ffi::CStr::from_ptr((*pw).pw_shell);
                if let Ok(s) = shell_cstr.to_str() {
                    if !s.is_empty() && s != "/bin/false" {
                        return s.to_string();
                    }
                }
            }
        }
    }

    // 3. Fallback: zsh first on macOS, then bash
    for fb in &["/bin/zsh", "/bin/bash", "/bin/sh"] {
        if std::path::Path::new(fb).exists() {
            return fb.to_string();
        }
    }
    "/bin/sh".to_string()
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn check_shell_exists(path: String) -> bool {
    if cfg!(target_os = "windows") {
        return std::path::Path::new(&path).exists() || which::which(&path).is_ok();
    }

    std::path::Path::new(&path).exists()
}

#[tauri::command]
#[allow(clippy::too_many_lines)]
pub fn get_available_shells() -> Vec<ShellInfo> {
    #[cfg(target_os = "windows")]
    {
        let candidates: &[(&str, &str)] = &[
            ("PowerShell", "powershell.exe"),
            ("PowerShell Core", "pwsh.exe"),
            ("Command Prompt", "cmd.exe"),
            ("WSL", "wsl.exe"),
        ];
        let default_shell = get_default_shell();
        let mut seen = std::collections::HashSet::new();
        let mut shells = Vec::new();

        if let Some(resolved_path) = resolve_git_bash() {
            seen.insert("Git Bash".to_string());
            shells.push(ShellInfo {
                name: "Git Bash".to_string(),
                path: resolved_path.clone(),
                is_default: resolved_path.eq_ignore_ascii_case(&default_shell),
            });
        }

        for (name, path) in candidates {
            if let Ok(resolved_path) = which::which(path) {
                let resolved_path = resolved_path.to_string_lossy().to_string();
                if !seen.insert(name.to_string()) {
                    continue;
                }

                shells.push(ShellInfo {
                    name: name.to_string(),
                    path: resolved_path.clone(),
                    is_default: resolved_path.eq_ignore_ascii_case(&default_shell),
                });
            }
        }
        return shells;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let default_shell = get_default_shell();
        let mut seen_paths = std::collections::HashSet::new();
        let mut shells = Vec::new();

        // Read /etc/shells (same as VS Code: terminalProfiles.ts detectAvailableUnixProfiles)
        if let Ok(contents) = std::fs::read_to_string("/etc/shells") {
            for line in contents.lines() {
                let trimmed = if let Some(idx) = line.find('#') {
                    &line[..idx]
                } else {
                    line
                };
                let trimmed = trimmed.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let path = std::path::Path::new(trimmed);
                if path.exists() && seen_paths.insert(trimmed.to_string()) {
                    let name = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("sh")
                        .to_string();
                    shells.push(ShellInfo {
                        name: name.clone(),
                        path: trimmed.to_string(),
                        is_default: trimmed == default_shell
                            || path.file_name().and_then(|n| n.to_str())
                                == std::path::Path::new(&default_shell)
                                    .file_name()
                                    .and_then(|n| n.to_str()),
                    });
                }
            }
        }

        // Fallback if /etc/shells wasn't readable
        if shells.is_empty() {
            let candidates: &[(&str, &str)] = &[
                ("zsh", "/bin/zsh"),
                ("bash", "/bin/bash"),
                ("fish", "/usr/bin/fish"),
                ("fish", "/usr/local/bin/fish"),
                ("fish", "/opt/homebrew/bin/fish"),
                ("sh", "/bin/sh"),
            ];
            let mut seen_names = std::collections::HashSet::new();
            for (name, shell_path) in candidates {
                if std::path::Path::new(shell_path).exists() && seen_names.insert(name.to_string())
                {
                    shells.push(ShellInfo {
                        name: name.to_string(),
                        path: shell_path.to_string(),
                        is_default: *shell_path == default_shell,
                    });
                }
            }
        }

        shells
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ShellInfo {
    pub name: String,
    pub path: String,
    pub is_default: bool,
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn get_shell_integration_dir(app: tauri::AppHandle) -> Result<String, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {e}"))?;
    let scripts_dir = resource_dir.join("shell-integration");
    Ok(scripts_dir.to_string_lossy().to_string())
}

#[tauri::command]
#[allow(clippy::too_many_lines, clippy::needless_pass_by_value)]
pub fn setup_zsh_dotdir(app: tauri::AppHandle) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;
    let zdotdir = data_dir.join("zsh-integration");
    std::fs::create_dir_all(&zdotdir).map_err(|e| format!("Failed to create zdotdir: {e}"))?;

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {e}"))?;
    let scripts_dir = resource_dir.join("shell-integration");

    let zshrc_content = format!(
        r#"# SideX Shell Integration - Auto-generated
VSCODE_SHELL_INTEGRATION=1
VSCODE_INJECTION=1
if [[ -f "{scripts}/shellIntegration-rc.zsh" ]]; then
    USER_ZDOTDIR="${{ZDOTDIR:-$HOME}}"
    . "{scripts}/shellIntegration-rc.zsh"
fi
"#,
        scripts = scripts_dir.to_string_lossy()
    );

    let zshrc_path = zdotdir.join(".zshrc");
    std::fs::write(&zshrc_path, zshrc_content)
        .map_err(|e| format!("Failed to write .zshrc: {e}"))?;

    let zshenv_content = format!(
        r#"# SideX Shell Integration - Auto-generated
USER_ZDOTDIR="${{ZDOTDIR:-$HOME}}"
if [[ -f "{scripts}/shellIntegration-env.zsh" ]]; then
    . "{scripts}/shellIntegration-env.zsh"
fi
"#,
        scripts = scripts_dir.to_string_lossy()
    );

    let zshenv_path = zdotdir.join(".zshenv");
    std::fs::write(&zshenv_path, zshenv_content)
        .map_err(|e| format!("Failed to write .zshenv: {e}"))?;

    let zprofile_content = format!(
        r#"# SideX Shell Integration - Auto-generated
if [[ -f "{scripts}/shellIntegration-profile.zsh" ]]; then
    . "{scripts}/shellIntegration-profile.zsh"
fi
"#,
        scripts = scripts_dir.to_string_lossy()
    );

    let zprofile_path = zdotdir.join(".zprofile");
    std::fs::write(&zprofile_path, zprofile_content)
        .map_err(|e| format!("Failed to write .zprofile: {e}"))?;

    let zlogin_content = format!(
        r#"# SideX Shell Integration - Auto-generated
if [[ -f "{scripts}/shellIntegration-login.zsh" ]]; then
    . "{scripts}/shellIntegration-login.zsh"
fi
"#,
        scripts = scripts_dir.to_string_lossy()
    );

    let zlogin_path = zdotdir.join(".zlogin");
    std::fs::write(&zlogin_path, zlogin_content)
        .map_err(|e| format!("Failed to write .zlogin: {e}"))?;

    Ok(zdotdir.to_string_lossy().to_string())
}
