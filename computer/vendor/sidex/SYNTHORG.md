# SideX in SynthOrg

Upstream: https://github.com/Sidenai/sidex

Pinned commit: `ad978652682270a593e7029269beff5411477a70` (0.1.3).
The upstream MIT license and source headers are retained. Compiled built-in
extensions come from VSCodium 1.110.11631; their source archive, SHA-256 and
notices are recorded by `scripts/fetch-code-extensions.js` in the host project.

## Integration boundaries

`src-tauri/src/embedded.rs` is the library entry point. SynthOrg owns the single
Tauri builder, application context, window, event loop and shutdown. The
upstream standalone entry points, agent server, remote (SSH/WSL/container)
commands, HTTP proxy commands, updater and chat/completion features are not
part of the vendored tree any more.

`configure` installs the native dialog and shell plugins. `initialize` lazily
creates the editor services when Code is first opened. `handle` dispatches the
editor commands alongside SynthOrg's existing commands. `shutdown` stops PTYs,
tasks, debug adapters and the extension host. On Windows the host also owns a
job object which terminates its descendant processes after a forced exit.
`host` exposes what SynthOrg reuses for container projects (extension scan and
init data, settings from text, language server and debug adapter launchers
taking an explicit command line).

The workbench runs in a native child webview inside the Code tab, with its own
Tauri IPC callback registry. Changing tabs keeps that webview alive; opening
another workspace reloads only the editor. The host owns window controls and
window geometry. The editor keeps its menus and settings button.

The runtime includes editor/files, search, watchers, terminal/PTY, Git, debugger,
tasks, LSP, Node and WASM extensions, keybindings, profiles and functional
configuration. Built-in Git uses SideX's Rust provider. The workbench has no
HTTP client of its own on the host: `requestService` refuses http(s) URLs.

The embedded entry point does not compile or initialize the SideX agent tool
executor, Go server, orchestration, MCP, hooks, browser automation, provider
accounts or chat persistence; those sources were removed. The `sidex-auth`
crate remains because extension secret storage depends on it.

## Two kinds of project

**Local** projects run the embedded workbench against this machine, confined
to the project folder by `src-tauri/src/code_runtime.rs`: every command that
names a path is checked at the IPC boundary (workspace or the editor's own
data, lexically, no `..`) and the webview may only navigate to
`/code/index.html?folder=<bound folder>`.

**Container** projects (Podman, GitHub) keep the workbench as the client and
nothing else on this machine. The project is a volume of the engine, mounted
at `/workspace` in an Alpine container built once per base image and runtime
build (`server/sandbox.js`, `ensureToolsImage`: `apk add git nodejs` plus
`/opt/synthorg-code/{agent.cjs,extension-host,extensions,shell-integration}`).
No folder of this disk is mounted, no port is published, no device is passed,
the network is off unless the project enables it.

The desktop reaches the container in two ways, both of which it initiates:

- `server/code-agent.cjs`, one `engine exec -i node agent.cjs` per open
  project, JSON lines over stdin/stdout. It answers files, search, watchers,
  text and hash helpers and task detection with the same shapes as the Rust
  commands, confines every path to `/workspace`, starts the extension host
  (`server.cjs`, whose stdin it keeps open) and tunnels the desktop's
  loopback connections to the host's port inside the container, byte for
  byte (`net_open`/`net_send`/`net_close`).
- `engine exec` per process: terminals (`-it`, a local PTY whose process is
  the exec), tasks and `exec`, git (through `sidex-git`'s launcher), language
  servers and debug adapters (their stdio is the protocol).

`code_runtime.rs` routes every workbench command of a container project:
`AGENT_COMMANDS` go to the agent, `CONTAINER_COMMANDS` are re-implemented on
top of `engine exec` or the tunnel, `REFUSED_COMMANDS` name only this machine.
The workbench keeps its own data (settings, storage, caches) in this machine's
app data with host paths; those are the only host paths accepted, and they go
to the editor library. Everything else is a path of the project and goes to
the container; a command mixing the two is refused. The extension API's `env`
namespace (clipboard, external URLs, the shell) is refused for container
projects: extension code runs in the container and gets no hand on the desktop.

Init data for the container's extension host is built here from the bundled
extensions and rewritten to container paths (`/opt/synthorg-code/extensions`,
`/root/.synthorg-code/...`). Only bundled extensions exist in the container;
marketplace installs are refused there. Language servers and debug adapters
must be present in the container to start.

## Appearance and data

SynthOrg's mode/accent/font/corner preferences drive workbench appearance.
Color overrides are applied at the in-memory configuration layer; functional
editor settings continue through SideX's existing persistence mechanisms.
The settings UI hides application theme overrides owned by SynthOrg.

Editor data uses the `SynthOrg/Code` namespace. No standalone SideX profile,
extension directory or legacy data is moved or imported. The extension host of
a local project uses SynthOrg's bundled Node runtime through `SIDEX_NODE_BINARY`;
in a container it is the image's Node.

Debug builds support `SYNTHORG_DEV_ROOT` for an isolated SynthOrg service root
and `SYNTHORG_CODE_DATA_DIR` for isolated editor data during native tests.

## Build

From the SynthOrg root run `npm run setup:code` once, then `npm start` or
`npm run build`. `npm run build:code` builds and stages just the workbench.
Rust 1.91+ is required by upstream. The native library is built as part of
SynthOrg, not as another executable; nothing of SideX is compiled for Linux.
Generated assets, dependencies and build output are not source files.

Built-in archive extraction uses libarchive (`tar` on Windows/macOS, `bsdtar`
from `libarchive-tools` on Linux). The Windows integration is the validation
target for this change; other platforms still require packaging and native
testing. Upstream itself describes extension host/debugger support as in
progress; arbitrary marketplace extensions are not assumed compatible merely
because they can be installed.
