//! Shared helpers for running git commands via `std::process::Command`.

use std::path::Path;
use std::process::Command;
use std::sync::{Arc, RwLock};

use crate::error::{GitError, GitResult};

/// Builds the command that runs `git` for a repository, or explains why it
/// cannot. `None` is a command with no repository (a clone destination).
///
/// Installed by the host when git must not run on this machine: SynthOrg's
/// isolated projects run it inside their container instead. Every git
/// invocation of this crate goes through the launcher, so the policy holds
/// for all operations at once rather than per call site.
pub type GitLauncher = dyn Fn(Option<&Path>) -> Result<Command, String> + Send + Sync;

static LAUNCHER: RwLock<Option<Arc<GitLauncher>>> = RwLock::new(None);

/// Replaces (or, with `None`, removes) the launcher used for every git command.
pub fn set_launcher(launcher: Option<Arc<GitLauncher>>) {
    *LAUNCHER.write().unwrap_or_else(|e| e.into_inner()) = launcher;
}

/// Build a `Command` for git on this machine, with `CREATE_NO_WINDOW` on Windows.
fn host_git_command() -> Command {
    let cmd = Command::new("git");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = cmd;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    cmd
}

/// A `git` command that runs in `repo_root` (or, for `None`, with no
/// repository), wherever the installed launcher says git runs.
pub(crate) fn git_command_in(repo_root: Option<&Path>) -> GitResult<Command> {
    let launcher = LAUNCHER.read().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(launcher) = launcher {
        return launcher(repo_root).map_err(|message| GitError::Command { message });
    }
    let mut cmd = host_git_command();
    if let Some(root) = repo_root {
        cmd.current_dir(root);
    }
    Ok(cmd)
}

/// Run a git command in `repo_root` and return stdout as a `String`.
pub(crate) fn run_git(repo_root: &Path, args: &[&str]) -> GitResult<String> {
    let output = git_command_in(Some(repo_root))?
        .args(args)
        .output()
        .map_err(GitError::Exec)?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitError::Command {
            message: stderr.trim().to_string(),
        });
    }

    String::from_utf8(output.stdout).map_err(GitError::Utf8)
}
