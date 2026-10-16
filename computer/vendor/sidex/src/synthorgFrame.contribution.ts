/*
 * SynthOrg: the workbench inside the frame of a project.
 *
 * The frame is SynthOrg's page: the files of the project are in a column of
 * its own there, with what is open in the middle. So here the side bar starts
 * closed, a file is opened when the page names it, and what the side bar and
 * a window of its own used to hold is in one section under the editor, the
 * panel with the terminals, which closes as the columns of the frame do: to a
 * strip — its title — with the button that opens it again.
 *
 * The page's bar also lists the open files, as tabs of its own, and holds what
 * every editor of SynthOrg has — save, undo, redo, zoom: which files are open,
 * which is in view, which has unsaved changes and how large the text is are
 * told to the page whenever one of them changes (the tabs of the workbench
 * itself are off, see main.ts), and what the bar asks is done here. The title
 * bar of the workbench is off too (layoutService.ts): its settings are opened
 * from the page's bar like those of every other editor.
 */
import { Disposable, toDisposable } from './vs/base/common/lifecycle.js';
import { URI } from './vs/base/common/uri.js';
import { EditorZoom } from './vs/editor/common/config/editorZoom.js';
import { ICommandService } from './vs/platform/commands/common/commands.js';
import { EditorResourceAccessor, SideBySideEditor } from './vs/workbench/common/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from './vs/workbench/common/contributions.js';
import { IEditorService } from './vs/workbench/services/editor/common/editorService.js';
import { IViewsService } from './vs/workbench/services/views/common/viewsService.js';
import { IWorkbenchLayoutService, Parts, Position } from './vs/workbench/services/layout/browser/layoutService.js';
import { IWorkingCopyService } from './vs/workbench/services/workingCopy/common/workingCopyService.js';
import { mainWindow } from './vs/base/browser/window.js';
import { panelFold } from './synthorgPanelFold.js';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

/** Whether the section under the editor was left folded to its title. */
const FOLDED = 'synthorg.bottomFolded';

/** What the page's bar asks, as the workbench's own commands. */
const DO: Record<string, string> = { undo: 'undo', redo: 'redo', save: 'workbench.action.files.save', settings: 'workbench.action.openSettings' };

class SynthOrgFrame extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'synthorg.frame';

	private telling = false;

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commands: ICommandService,
		@IWorkingCopyService private readonly workingCopies: IWorkingCopyService,
		@IViewsService private readonly viewsService: IViewsService
	) {
		super();

		// The files are in the page's column: the side bar is closed when the project opens.
		this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);

		// A file pressed in that column, named by its place on this computer.
		void listen<string>('synthorg-code-open-file', event => {
			if (typeof event.payload !== 'string' || !event.payload) { return; }
			void this.editorService.openEditor({ resource: URI.file(event.payload), options: { pinned: true } })
				.catch(error => console.error('[Code] Open file:', error));
		}).then(unlisten => {
			this._register(toDisposable(unlisten));
			// From here on a file named by the page is heard: the page is told, and hands over the one it may be holding.
			void invoke('code_frame_ready').catch(error => console.error('[Code] Frame ready:', error));
		});

		// The page was loaded again while this workbench stayed: it asks, and is told again that files are heard and
		// which ones are open.
		void listen('synthorg-code-hello', () => {
			void invoke('code_frame_ready').catch(error => console.error('[Code] Frame ready:', error));
			this.tellFiles();
		}).then(unlisten => this._register(toDisposable(unlisten)));

		// The page's bar: what is open is listed there, and what it asks is done here.
		this._register(this.editorService.onDidActiveEditorChange(() => this.tellFiles()));
		this._register(this.editorService.onDidEditorsChange(() => this.tellFiles()));
		this._register(this.workingCopies.onDidChangeDirty(() => this.tellFiles()));
		this._register(EditorZoom.onDidChangeZoomLevel(() => this.tellFiles()));
		this.tellFiles();
		void listen<{ what: string; id: string; path?: string | null }>('synthorg-code-do', async event => {
			const { what, id, path } = event.payload;
			try {
				if (DO[what]) { await this.commands.executeCommand(DO[what]); }
				else if (what === 'zoomIn' || what === 'zoomOut') { EditorZoom.setZoomLevel(EditorZoom.getZoomLevel() + (what === 'zoomIn' ? 1 : -1)); }
				else if (what === 'zoomReset') { EditorZoom.setZoomLevel(0); }
				// Closed as its tab's cross would: with unsaved changes, the workbench asks what to do with them.
				else if (what === 'close' && path) { await this.editorService.closeEditors(this.editorService.findEditors(URI.file(path))); }
			} catch (error) {
				console.error(`[Code] ${what}:`, error);
			}
			// Done or not, the page is waiting to go on.
			void invoke('code_did', { id }).catch(error => console.error('[Code] Did:', error));
		}).then(unlisten => this._register(toDisposable(unlisten)));

		try {
			this.bottom();
		} catch (error) {
			console.error('[Code] Bottom section:', error);
		}
	}

	/**
	 * Says to the page what its bar shows: the open files in the order of their tabs, by their place on this
	 * computer, each with whether it has unsaved changes; which one is in view; the zoom as a percentage. A tab
	 * that is not a file of this computer (settings, a comparison) is not listed. Several changes in a row are
	 * told once.
	 */
	private tellFiles(): void {
		if (this.telling) { return; }
		this.telling = true;
		queueMicrotask(() => {
			this.telling = false;
			const pathOf = (editor: Parameters<typeof EditorResourceAccessor.getOriginalUri>[0]) => {
				const resource = EditorResourceAccessor.getOriginalUri(editor, { supportSideBySide: SideBySideEditor.PRIMARY });
				return resource?.scheme === 'file' ? resource.fsPath : '';
			};
			const files: { path: string; dirty: boolean }[] = [];
			for (const editor of this.editorService.editors) {
				const path = pathOf(editor);
				const known = files.find(file => file.path === path);
				if (known) { known.dirty = known.dirty || editor.isDirty(); }
				else if (path) { files.push({ path, dirty: editor.isDirty() }); }
			}
			const state = { files, shown: pathOf(this.editorService.activeEditor), zoom: Math.round(100 * (1 + EditorZoom.getZoomLevel() * 0.1)) };
			void invoke('code_files', { state }).catch(error => console.error('[Code] Files:', error));
		});
	}

	/**
	 * The section under the editor: the panel, always there. Its own buttons that maximise it and take it away are
	 * replaced by one that folds it to its title and opens it again; a tab pressed while it is folded opens it.
	 */
	private bottom(): void {
		this.layoutService.setPanelPosition(Position.BOTTOM);
		this.layoutService.setPartHidden(false, Parts.PANEL_PART);
		const panel = this.layoutService.getContainer(mainWindow, Parts.PANEL_PART);
		const title = panel?.querySelector<HTMLElement>(':scope > .title');
		if (!panel || !title) { return; }
		panelFold.title = Math.round(title.getBoundingClientRect().height) || panelFold.title;

		const button = document.createElement('div');
		button.className = 'synthorg-fold codicon';
		button.setAttribute('role', 'button');
		button.tabIndex = 0;
		title.append(button);
		this._register(toDisposable(() => button.remove()));

		let open = 0;
		const fold = (folded: boolean, keep = true) => {
			if (folded && !panelFold.folded) { open = panel.getBoundingClientRect().height; }
			panelFold.folded = folded;
			panel.classList.toggle('synthorg-folded', folded);
			button.classList.toggle('codicon-chevron-down', !folded);
			button.classList.toggle('codicon-chevron-up', folded);
			button.setAttribute('aria-expanded', String(!folded));
			// Opened again as tall as it was; never opened yet, two fifths of the workbench.
			panelFold.resize?.(folded ? undefined : (open > panelFold.title + 40 ? open : Math.round(this.layoutService.mainContainerDimension.height * 0.4)));
			if (keep) { try { localStorage.setItem(FOLDED, folded ? '1' : '0'); } catch { /* as it is until the workbench is loaded again */ } }
		};
		button.addEventListener('click', () => fold(!panelFold.folded));
		button.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fold(!panelFold.folded); } });
		// A tab of the folded section is pressed to see what it holds.
		title.addEventListener('click', event => {
			if (panelFold.folded && event.target instanceof HTMLElement && event.target.closest('.composite-bar')) { fold(false); }
		});
		// Taken away from the keyboard (the workbench's own toggle), it comes back as it was left.
		this._register(this.layoutService.onDidChangePartVisibility(event => {
			if (event.partId === Parts.PANEL_PART && !this.layoutService.isVisible(Parts.PANEL_PART)) { this.layoutService.setPartHidden(false, Parts.PANEL_PART); fold(true); }
		}));

		let folded = false, seen = true;
		try { seen = localStorage.getItem(FOLDED) !== null; folded = localStorage.getItem(FOLDED) === '1'; } catch { /* open */ }
		fold(folded, !seen);
		// The first time, what the section shows is the terminal: it is what the section is there for.
		if (!seen) { void this.viewsService.openView('terminal', false).catch(error => console.error('[Code] Terminal:', error)); }
	}
}

registerWorkbenchContribution2(SynthOrgFrame.ID, SynthOrgFrame, WorkbenchPhase.AfterRestored);
