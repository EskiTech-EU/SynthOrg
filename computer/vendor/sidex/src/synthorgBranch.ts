/**
 * The branch strip over the file explorer of a local project.
 *
 * A project linked to a GitHub repository follows either the whole repository
 * or one branch of it. This strip is where that shows and where it is moved:
 * the branch the project is on (and, with the whole repository, the list to
 * move between them), the steps to download and to upload, and the switch
 * that makes this branch sync on its own.
 *
 * Nothing is decided or run here. SynthOrg's page owns the state and every
 * action — git itself runs in its service, never in this workbench — and this
 * only shows what it is told (`synthorg-code-git`) and says what was pressed
 * (`code_git_command`). The labels arrive with the state, already in the
 * user's language.
 */
import { Disposable, DisposableStore } from './vs/base/common/lifecycle.js';
import { ICommandService } from './vs/platform/commands/common/commands.js';
import { IQuickInputService, IQuickPick, IQuickPickItem } from './vs/platform/quickinput/common/quickInput.js';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

interface BranchMenuItem { name: string; current: boolean; detail: string; }
interface BranchMenu { id: number; loading: boolean; items: BranchMenuItem[]; }
interface BranchText {
	branchTitle: string; pull: string; pullTitle: string; push: string; pushTitle: string;
	autoTitle: string; diverged: string; note: string;
	pickPlaceholder: string; newBranch: string; newBranchPrompt: string; newBranchPlaceholder: string; invalidName: string;
}
interface BranchState {
	visible: boolean;
	/** 'full': every branch of the repository; 'branch': this one only. */
	mode: 'full' | 'branch';
	branch: string;
	unpushed: number;
	behind: number;
	diverged: boolean;
	auto: boolean;
	busy: boolean;
	canPull: boolean;
	canPush: boolean;
	error: string | null;
	text: BranchText;
	menu: BranchMenu | null;
}
interface PickItem extends IQuickPickItem { branch?: string; current?: boolean; create?: boolean; }

// What git accepts as a branch name; the service checks again, this only spares a round trip.
const BRANCH_NAME = /^(?!-)(?!\/)(?!.*\.\.)(?!.*\/\/)(?!.*\/\.)(?!\.)[A-Za-z0-9._\/-]{1,200}(?<!\/)(?<!\.)(?<!\.lock)$/;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	node.className = className;
	parent?.append(node);
	return node;
}

function icon(name: string, parent: HTMLElement): HTMLElement {
	const node = el('span', `codicon codicon-${name}`, parent);
	node.setAttribute('aria-hidden', 'true');
	return node;
}

export class SynthOrgBranchHead extends Disposable {
	readonly element: HTMLElement;
	private state: BranchState | null = null;
	private readonly branchButton: HTMLButtonElement;
	private readonly branchName: HTMLElement;
	private readonly branchChevron: HTMLElement;
	private readonly autoButton: HTMLButtonElement;
	private readonly pullButton: HTMLButtonElement;
	private readonly pullLabel: HTMLElement;
	private readonly pullCount: HTMLElement;
	private readonly pushButton: HTMLButtonElement;
	private readonly pushLabel: HTMLElement;
	private readonly pushCount: HTMLElement;
	private readonly divergedButton: HTMLButtonElement;
	private readonly divergedLabel: HTMLElement;
	private readonly note: HTMLElement;
	/** The list of branches while it is open, and which request of the page it answers. */
	private pick: IQuickPick<PickItem, { useSeparators: true }> | null = null;
	private pickId = 0;

	constructor(
		parent: HTMLElement,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@ICommandService private readonly commands: ICommandService,
	) {
		super();
		this.element = el('div', 'synthorg-branch-head');
		this.element.hidden = true;
		parent.prepend(this.element);

		const top = el('div', 'synthorg-branch-row', this.element);
		this.branchButton = el('button', 'synthorg-branch-name', top);
		this.branchButton.type = 'button';
		icon('git-branch', this.branchButton);
		this.branchName = el('span', 'synthorg-branch-label', this.branchButton);
		this.branchChevron = icon('chevron-down', this.branchButton);
		this.autoButton = el('button', 'synthorg-branch-auto', top);
		this.autoButton.type = 'button';
		icon('sync', this.autoButton);

		const actions = el('div', 'synthorg-branch-row', this.element);
		this.pullButton = el('button', 'synthorg-branch-action', actions);
		this.pullButton.type = 'button';
		icon('cloud-download', this.pullButton);
		this.pullLabel = el('span', 'synthorg-branch-label', this.pullButton);
		this.pullCount = el('span', 'synthorg-branch-count', this.pullButton);
		this.pushButton = el('button', 'synthorg-branch-action', actions);
		this.pushButton.type = 'button';
		icon('cloud-upload', this.pushButton);
		this.pushLabel = el('span', 'synthorg-branch-label', this.pushButton);
		this.pushCount = el('span', 'synthorg-branch-count', this.pushButton);

		this.divergedButton = el('button', 'synthorg-branch-diverged', this.element);
		this.divergedButton.type = 'button';
		icon('warning', this.divergedButton);
		this.divergedLabel = el('span', 'synthorg-branch-label', this.divergedButton);
		this.note = el('div', 'synthorg-branch-note', this.element);

		// With one branch there is nowhere to move: the name opens the repository's settings instead.
		this.branchButton.addEventListener('click', () => this.send(this.state?.mode === 'full' ? { type: 'menu' } : { type: 'repo' }));
		this.autoButton.addEventListener('click', () => void this.act({ type: 'auto', auto: !this.state?.auto }));
		this.pullButton.addEventListener('click', () => void this.act({ type: 'pull' }));
		this.pushButton.addEventListener('click', () => void this.act({ type: 'push' }));
		this.divergedButton.addEventListener('click', () => void this.act({ type: 'resolve' }));

		void listen<BranchState>('synthorg-code-git', event => this.update(event.payload))
			.then(unlisten => this._register({ dispose: unlisten }))
			.catch(error => console.error('[Code] Branch bridge:', error));
		this._register({ dispose: () => this.pick?.dispose() });
		// The page may have sent the state before this workbench existed.
		this.send({ type: 'ready' });
	}

	private send(command: Record<string, unknown>): void {
		void invoke('code_git_command', { command }).catch(error => console.error('[Code] Branch command:', error));
	}

	/** What moves files on disk first puts on disk what is still only in the editors. */
	private async act(command: Record<string, unknown>): Promise<void> {
		try { await this.commands.executeCommand('workbench.action.files.saveAll'); } catch { /* nothing to save */ }
		this.send(command);
	}

	private update(state: BranchState): void {
		this.state = state;
		const wasHidden = this.element.hidden;
		this.element.hidden = !state.visible;
		if (!state.visible) {
			this.pick?.hide();
			if (!wasHidden) { this.element.dispatchEvent(new Event('synthorg-resize')); }
			return;
		}
		const text = state.text;
		const full = state.mode === 'full';
		this.element.classList.toggle('is-busy', state.busy);
		this.branchName.textContent = state.branch;
		this.branchButton.title = text.branchTitle;
		this.branchChevron.hidden = !full;
		this.autoButton.title = text.autoTitle;
		this.autoButton.setAttribute('aria-label', text.autoTitle);
		this.autoButton.setAttribute('aria-pressed', String(state.auto));
		this.autoButton.disabled = state.busy;
		this.pullLabel.textContent = text.pull;
		this.pullButton.title = text.pullTitle;
		this.pullCount.textContent = state.behind ? String(state.behind) : '';
		this.pullButton.disabled = state.busy || !state.canPull;
		this.pushLabel.textContent = text.push;
		this.pushButton.title = text.pushTitle;
		this.pushCount.textContent = state.unpushed ? String(state.unpushed) : '';
		this.pushButton.disabled = state.busy || !state.canPush;
		this.divergedButton.hidden = !state.diverged;
		this.divergedLabel.textContent = text.diverged;
		this.divergedButton.disabled = state.busy;
		this.note.textContent = state.error || text.note;
		this.note.title = state.error || '';
		this.note.classList.toggle('is-error', Boolean(state.error));
		this.note.hidden = !this.note.textContent;
		// The strip can change height (a warning, a note): the explorer below is laid out again.
		this.element.dispatchEvent(new Event('synthorg-resize'));
		this.showMenu(state);
	}

	// --- the list of branches ---------------------------------------------------

	private showMenu(state: BranchState): void {
		const menu = state.menu;
		if (!menu) { return; }
		if (this.pick && this.pickId === menu.id) {
			this.pick.items = this.menuItems(state, menu);
			this.pick.busy = menu.loading;
			return;
		}
		if (menu.id <= this.pickId) { return; }   // already shown and closed
		this.pick?.dispose();
		const store = new DisposableStore();
		const pick = store.add(this.quickInput.createQuickPick<PickItem>({ useSeparators: true }));
		this.pick = pick;
		this.pickId = menu.id;
		pick.placeholder = state.text.pickPlaceholder;
		pick.matchOnDescription = true;
		pick.items = this.menuItems(state, menu);
		pick.busy = menu.loading;
		store.add(pick.onDidAccept(() => {
			const item = pick.selectedItems[0];
			pick.hide();
			if (item?.create) { void this.newBranch(); }
			else if (item?.branch && !item.current) { void this.act({ type: 'switch', branch: item.branch }); }
		}));
		store.add(pick.onDidHide(() => {
			if (this.pick === pick) { this.pick = null; }
			store.dispose();
		}));
		pick.show();
	}

	private menuItems(state: BranchState, menu: BranchMenu): PickItem[] {
		const items: PickItem[] = menu.items.map(item => ({
			label: `$(${item.current ? 'check' : 'git-branch'}) ${item.name}`,
			description: item.detail,
			branch: item.name,
			current: item.current,
		}));
		items.push({ type: 'separator', label: '' } as unknown as PickItem);
		items.push({ label: `$(add) ${state.text.newBranch}`, create: true, alwaysShow: true });
		return items;
	}

	private async newBranch(): Promise<void> {
		const text = this.state?.text;
		if (!text) { return; }
		const name = await this.quickInput.input({
			prompt: text.newBranchPrompt,
			placeHolder: text.newBranchPlaceholder,
			validateInput: async value => (BRANCH_NAME.test(value.trim()) && value.trim() !== 'HEAD' ? undefined : text.invalidName),
		});
		if (name?.trim()) { await this.act({ type: 'new-branch', name: name.trim() }); }
	}
}
