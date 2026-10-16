/**
 * The model's commands on a local project, in the user's own terminals.
 *
 * SynthOrg's page asks the desktop to run a command; the desktop hands it to
 * this workbench, which types it into a terminal of the panel — the one the
 * user is looking at, when it is free. There is one place for terminals: the
 * user and the model share it, each command in plain view.
 *
 * Every terminal says when it is free. Its prompt is hooked — PowerShell at
 * launch (see the desktop's terminal_spawn), bash and zsh with a setup line
 * typed once in a terminal the model opened — to set the title to a count of
 * prompts and the exit code of the line before. The desktop, which sees every
 * byte through a terminal from its birth, keeps its state: at its prompt,
 * something typed, a line running. A command ends at the first prompt counted
 * after it was sent, so the line itself is the command alone, as readable as
 * the user's. A prompt comes back however a command ended — on its own, with a
 * Ctrl+C typed by the user, stopped from the chat, killed from outside — so
 * every end reaches the chat, with the reason when there is one.
 *
 * Which terminal a command goes to: the active one if it is free, else another
 * free one, else a new tab. Free means back at its prompt with nothing typed:
 * the model never types into a program the user is running, nor after half a
 * line of theirs. A terminal whose shell cannot be hooked (cmd, or an unknown
 * one) is never borrowed; if the model has to open one of those itself, it
 * uses the older way there — a marker echoed at the end of the line.
 *
 * Nothing here decides whether the command may run: that was settled before
 * the request arrived, by the project's permissions.
 */
import { Disposable, DisposableStore } from './vs/base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from './vs/workbench/common/contributions.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from './vs/workbench/contrib/terminal/browser/terminal.js';
import { TerminalLocation } from './vs/platform/terminal/common/terminal.js';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

interface RunRequest { id: string; command: string; cwd?: string | null; timeout_ms?: number | null; }
/**
 * `error` says why the command did not simply end: `interrupted:ctrl-c` (typed
 * in the terminal), `interrupted:stop` (the chat's stop button), `timeout`,
 * `terminal closed`, or a failure to run it at all.
 */
interface RunResult { id: string; output: string; exit_code: number | null; error: string | null; }
type Shell = 'pwsh' | 'bash' | 'zsh' | 'cmd' | 'other';
type Reason = 'interrupted:ctrl-c' | 'interrupted:stop' | 'timeout' | 'terminal closed';
/** What the desktop knows of a terminal's prompt: hooked, and free (at its prompt, nothing typed). */
interface PromptInfo { hooked: boolean; free: boolean; seq: number; }

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
// Colour and cursor sequences, OSC strings (titles, our prompt signal), carriage returns.
const CONTROL = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r/g;
// What a hooked prompt shows, as a title the console passes on in order with the text:
// ESC ] 0 (or 2) ; synthorg:<count, one more at every prompt>:<exit code of the line before> BEL
const PROMPT_SIGNAL = /\x1b\][02];synthorg:(\d+):(-?\d+)(?:\x07|\x1b\\)/;
// A program ended by Ctrl+C: 130 on POSIX shells, STATUS_CONTROL_C_EXIT on Windows.
const CTRL_C_EXIT = new Set([130, -1073741510, 3221225786]);
// After an interruption: how long a program gets to end on its own before its processes are ended.
const GRACE_MS = 2500;

/** Setup lines for the shells not hooked at launch. Idempotent. */
const HOOKS: Partial<Record<Shell, string>> = {
	bash: "if [ -z \"$__so_hook\" ]; then __so_hook=1; __so_n=0; PROMPT_COMMAND='__so_c=$?; __so_n=$((__so_n+1)); printf \"\\033]0;synthorg:%s:%s\\007\" \"$__so_n\" \"$__so_c\";'\"${PROMPT_COMMAND:+ $PROMPT_COMMAND}\"; fi",
	zsh: "if [ -z \"$__so_hook\" ]; then __so_hook=1; __so_n=0; __so_precmd() { local c=$?; __so_n=$((__so_n+1)); printf \"\\033]0;synthorg:%s:%s\\007\" \"$__so_n\" \"$c\"; }; precmd_functions=(__so_precmd $precmd_functions); fi",
};

class SynthOrgRun extends Disposable implements IWorkbenchContribution {
	private queue: Promise<void> = Promise.resolve();
	/** The command running now, and how to stop it: the chat's stop button reaches it here. */
	private current: { id: string; stop: () => void } | null = null;

	constructor(
		@ITerminalService private readonly terminals: ITerminalService,
		@ITerminalGroupService private readonly groups: ITerminalGroupService,
	) {
		super();
		void listen<RunRequest>('synthorg-code-run', event => {
			// One at a time: the model runs one command after the other.
			this.queue = this.queue.then(() => this.run(event.payload)).catch(error => console.error('[Code] Run:', error));
		}).then(unlisten => this._register({ dispose: unlisten }))
			.catch(error => console.error('[Code] Run bridge:', error));
		void listen<string>('synthorg-code-stop', event => {
			if (this.current && this.current.id === event.payload) { this.current.stop(); }
		}).then(unlisten => this._register({ dispose: unlisten }))
			.catch(error => console.error('[Code] Stop bridge:', error));
	}

	/** Free: hooked, at its prompt, nothing typed — as the desktop, which sees every byte through it, tells. */
	private async isFree(instance: ITerminalInstance): Promise<boolean> {
		if (instance.isDisposed || instance.target === TerminalLocation.Editor) { return false; }
		const info = await this.promptInfo(instance);
		return info.free;
	}

	private async promptInfo(instance: ITerminalInstance): Promise<PromptInfo> {
		const pid = instance.processId;
		if (!pid) { return { hooked: false, free: false, seq: 0 }; }
		return invoke<PromptInfo>('terminal_state', { pid }).catch(() => ({ hooked: false, free: false, seq: 0 }));
	}

	/** The terminal for the next command: the active one if free, else another free one, else a new tab. */
	private async pick(): Promise<{ instance: ITerminalInstance; fresh: boolean }> {
		const active = this.groups.activeInstance;
		const order = [...(active ? [active] : []), ...this.groups.instances.filter(instance => instance !== active)];
		for (const instance of order) {
			if (await this.isFree(instance)) { return { instance, fresh: false }; }
		}
		return { instance: await this.terminals.createTerminal({ location: TerminalLocation.Panel }), fresh: true };
	}

	/** Which shell the line has to be phrased for. */
	private shellOf(instance: ITerminalInstance): Shell {
		const type = String(instance.shellType || '').toLowerCase();
		const exe = String(instance.shellLaunchConfig.executable || '').toLowerCase().replace(/\\/g, '/');
		const base = exe.slice(exe.lastIndexOf('/') + 1).replace(/\.exe$/, '');
		if (type === 'pwsh' || type === 'powershell' || base === 'pwsh' || base === 'powershell') { return 'pwsh'; }
		if (type === 'cmd' || base === 'cmd') { return 'cmd'; }
		if (type === 'bash' || base === 'bash') { return 'bash'; }
		if (type === 'zsh' || base === 'zsh') { return 'zsh'; }
		if (type || exe) { return 'other'; }
		// Nothing known yet: SideX's own default, PowerShell on Windows.
		return navigator.platform.toLowerCase().startsWith('win') ? 'pwsh' : 'other';
	}

	/**
	 * A terminal the model just opened: waits for its first prompt. A shell not
	 * hooked at launch gets its setup line typed (the screen is cleared after
	 * it); true once the prompt signal came.
	 */
	private async ready(instance: ITerminalInstance): Promise<boolean> {
		await instance.processReady;
		const waitSignal = (ms: number) => new Promise<boolean>(resolve => {
			const store = new DisposableStore();
			const done = (ok: boolean) => { clearTimeout(timer); clearInterval(poll); store.dispose(); resolve(ok); };
			const timer = setTimeout(() => done(false), ms);
			// The first prompt may already have come: the desktop keeps what it saw.
			const poll = setInterval(() => { void this.promptInfo(instance).then(info => { if (info.hooked) { done(true); } }); }, 250);
			store.add(instance.onData(data => { if (PROMPT_SIGNAL.test(data)) { done(true); } }));
			store.add(instance.onDisposed(() => done(false)));
		});
		if (await waitSignal(6000)) { return true; }
		const line = HOOKS[this.shellOf(instance)];
		if (!line) { return false; }
		void instance.sendText(line + '; clear', true).catch(() => undefined);
		return waitSignal(6000);
	}

	/** Resolves once the terminal has printed nothing for a moment (at most 1.5 s). */
	private settle(instance: ITerminalInstance): Promise<void> {
		return new Promise<void>(resolve => {
			const store = new DisposableStore();
			let quiet: ReturnType<typeof setTimeout>;
			const done = () => { clearTimeout(quiet); clearTimeout(cap); store.dispose(); resolve(); };
			const cap = setTimeout(done, 1500);
			const arm = () => { clearTimeout(quiet); quiet = setTimeout(done, 200); };
			store.add(instance.onData(arm));
			store.add(instance.onDisposed(done));
			arm();
		});
	}

	private async busy(instance: ITerminalInstance): Promise<number> {
		const pid = instance.processId;
		return pid ? invoke<number>('terminal_busy', { pid }).catch(() => 0) : 0;
	}

	private async run(request: RunRequest): Promise<void> {
		const result: RunResult = { id: request.id, output: '', exit_code: null, error: null };
		try {
			await this.groups.showPanel(false);
			const { instance, fresh } = await this.pick();
			// In plain view: the terminal the command goes to is the one on screen, without taking the keyboard.
			this.groups.setActiveInstance(instance);
			const hooked = fresh ? await this.ready(instance) : true;
			// A tab brought on screen is resized, and the console repaints it: that
			// old screen must not be read as this command's output.
			await this.settle(instance);
			// The count of the prompt the line is typed at: the command ends at the first one counted after it.
			const sentAt = (await this.promptInfo(instance)).seq;
			const shell = this.shellOf(instance);
			const tag = request.id.replace(/[^a-zA-Z0-9]/g, '');
			const marker = `__SYNTHORG_END_${tag}__`;
			const markerLine = shell === 'pwsh'
				? `Write-Output "${marker} $(if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 })"`
				: shell === 'cmd' ? `echo ${marker} %ERRORLEVEL%` : `echo "${marker} $?"`;
			// Hooked: the command alone. Its echo is found by the whole of it: a part could be what it prints.
			const cut = hooked ? request.command.trim() : tag;
			// How the echo is found: the console may draw spaces as cursor moves and
			// break a long line anywhere, so any run of whitespace, or none, may stand
			// between two of its characters.
			const echoOf = (flags: string) => new RegExp([...cut.replace(/\s+/g, '')].map(c => c.replace(/[.*+?^$(){}|[\]\\/-]/g, '\\$&')).join('\\s*'), flags);
			const line = hooked ? request.command
				: shell === 'pwsh' ? `$global:LASTEXITCODE=$null; ${request.command}; ${markerLine}`
					: shell === 'cmd' ? `${request.command} & ${markerLine}` : `${request.command}; ${markerLine}`;

			await new Promise<void>(resolve => {
				const store = new DisposableStore();
				let raw = '';
				let reason: Reason | null = null;
				let ending = false;
				let finished = false;
				const timers: ReturnType<typeof setTimeout>[] = [];
				const later = (ms: number, fn: () => void) => { timers.push(setTimeout(() => { if (!finished) { fn(); } }, ms)); };
				const cleanOutput = (end: number, cut: string) => {
					const clean = raw.slice(0, end).replace(CONTROL, '');
					// A long line is echoed more than once as the terminal wraps it: cut after the last echo of it,
					// looked for only where the echo can be, so the output repeating the command is not taken for it.
					const echoZone = clean.slice(0, 2 * request.command.length + 400);
					let echoed = -1;
					const echoes = echoOf('g');
					for (let m = echoes.exec(echoZone); m; m = echoes.exec(echoZone)) { echoed = m.index + m[0].length; }
					const afterEcho = echoed >= 0 ? clean.indexOf('\n', echoed) : -1;
					return clean.slice(afterEcho >= 0 ? afterEcho + 1 : 0).trim();
				};
				// The signal comes with the prompt it goes with, drawn just before it: that last line is not output.
				const withoutPrompt = (text: string) => {
					const lines = text.split('\n');
					return (lines.length > 1 ? lines.slice(0, -1) : [lines[0].replace(/^PS [^\n]*> ?$/, '')]).join('\n').trim();
				};
				const finish = (exit: number | null, output: string) => {
					if (finished) { return; }
					finished = true;
					timers.forEach(clearTimeout);
					store.dispose();
					this.current = null;
					result.output = output;
					result.exit_code = exit;
					if (!reason && exit !== null && CTRL_C_EXIT.has(exit)) { reason = 'interrupted:ctrl-c'; }
					result.error = reason;
					resolve();
				};
				// Asks the command to end: Ctrl+C first, as the user would; if it is
				// still running after a grace period, its processes are ended; a line
				// that lost its marker gets one typed on its own; and if the terminal
				// says nothing at all, what came so far goes back as it is.
				const end = (why: Reason) => {
					reason = reason ?? why;
					if (ending) { return; }
					ending = true;
					void instance.sendText('\u0003', false).catch(() => undefined);
					later(GRACE_MS, async () => {
						if (await this.busy(instance) > 0 && instance.processId) {
							await invoke<number>('terminal_interrupt', { pid: instance.processId }).catch(() => 0);
						}
						if (!hooked) { later(1000, () => void instance.sendText(markerLine, true).catch(() => undefined)); }
						later(6000, () => finish(null, cleanOutput(raw.length, cut)));
					});
				};
				this.current = { id: request.id, stop: () => end('interrupted:stop') };

				store.add(instance.onData(data => {
					raw += data;
					if (hooked) {
						// The prompt that ends this command: the first one counted after it was sent. A
						// repaint may show the same title again; its count is not a new one.
						const signals = new RegExp(PROMPT_SIGNAL.source, 'g');
						for (let match = signals.exec(raw); match; match = signals.exec(raw)) {
							if (Number(match[1]) > sentAt) { finish(Number(match[2]), withoutPrompt(cleanOutput(match.index, cut))); return; }
						}
						return;
					}
					const clean = raw.replace(CONTROL, '');
					// The typed line carries the marker too, without a number after it; the real one is followed by the exit code.
					const match = clean.match(new RegExp(`${marker} (-?\\d+)`));
					if (match && match.index !== undefined) {
						const echoed = clean.lastIndexOf(marker, match.index - 1);
						const afterEcho = echoed >= 0 ? clean.indexOf('\n', echoed) : -1;
						finish(Number(match[1]), clean.slice(afterEcho >= 0 && afterEcho < match.index ? afterEcho + 1 : 0, match.index).trim());
					}
				}));
				// A Ctrl+C typed by the user in this terminal while the command runs.
				// With the hook, the prompt that follows ends the wait by itself; without
				// it, the marker is dropped with the line and has to be typed again —
				// only once the shell is idle, never into a program still reading input.
				store.add(instance.onDidInputData(data => {
					if (ending || !data.includes('\u0003')) { return; }
					reason = reason ?? 'interrupted:ctrl-c';
					if (!hooked) {
						later(1500, async () => {
							if (await this.busy(instance) === 0) { void instance.sendText(markerLine, true).catch(() => undefined); }
						});
					}
				}));
				store.add(instance.onExit(() => { reason = reason ?? 'terminal closed'; finish(null, cleanOutput(raw.length, cut)); }));
				store.add(instance.onDisposed(() => { reason = reason ?? 'terminal closed'; finish(null, cleanOutput(raw.length, cut)); }));
				later(Math.max(1000, request.timeout_ms || DEFAULT_TIMEOUT_MS), () => end('timeout'));
				void instance.sendText(line, true).catch(error => { result.error = String(error?.message || error); finish(null, ''); });
			});
		} catch (error) {
			result.error = String((error as Error)?.message || error);
		}
		await invoke('code_command_done', { result }).catch(error => console.error('[Code] Run result:', error));
	}
}

registerWorkbenchContribution2('synthorg.run', SynthOrgRun, WorkbenchPhase.AfterRestored);
