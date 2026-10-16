/*
 * SynthOrg: the editor belongs to one project.
 *
 * Which folder is open is SynthOrg's decision (its Projects screen), never the
 * workbench's: there is no "open folder", no "recent", no second window, no
 * multi-root. The host already refuses anything outside the project at the IPC
 * boundary (src-tauri/src/code_runtime.rs); this removes the offers from the
 * interface, so nothing in it leads somewhere the host would then refuse.
 */
import { ContextKeyExpr } from './vs/platform/contextkey/common/contextkey.js';
import { CommandsRegistry } from './vs/platform/commands/common/commands.js';
import { isIMenuItem, MenuId, MenuRegistry } from './vs/platform/actions/common/actions.js';
import { Registry } from './vs/platform/registry/common/platform.js';
import { Extensions as ViewExtensions, type IViewContainersRegistry, type IViewsRegistry } from './vs/workbench/common/views.js';

/**
 * Commands that leave the project, or bring another one in. Cloning a repository
 * is not one of them: its destination is picked in the project's own folder.
 */
const LEAVES_PROJECT = [
	'workbench.action.files.openFolder',
	'workbench.action.files.openFileFolder',
	'workbench.action.files.openFile',
	'workbench.action.files.openLocalFolder',
	'workbench.action.files.openLocalFile',
	'workbench.action.files.openLocalFileFolder',
	'workbench.action.files.openFolderViaWorkspace',
	'workbench.action.openWorkspace',
	'workbench.action.openWorkspaceConfigFile',
	'workbench.action.openWorkspaceInNewWindow',
	'workbench.action.openRecent',
	'workbench.action.quickOpenRecent',
	'workbench.action.clearRecentFiles',
	'workbench.action.addRootFolder',
	'workbench.action.removeRootFolder',
	'workbench.action.saveWorkspaceAs',
	'workbench.action.duplicateWorkspaceInNewWindow',
	'workbench.action.closeFolder',
	'workbench.action.closeWindow',
	'workbench.action.newWindow',
	'workbench.action.newEmptyEditorWindow',
	'workbench.action.switchWindow',
	'workbench.action.quickSwitchWindow',
	'vscode.openFolder',
	'vscode.newWindow',
	'_files.pickFolderAndOpen',
	'_files.windowOpen',
	// Separate windows: the editor lives in SynthOrg's Code tab, and only there.
	'workbench.action.files.openFileInNewWindow',
	'workbench.action.files.openFolderInNewWindow',
	'workbench.action.files.openFileFolderInNewWindow',
	'workbench.action.files.showOpenedFileInNewWindow',
	'workbench.action.copyEditorToNewWindow',
	'workbench.action.moveEditorToNewWindow',
	'workbench.action.copyEditorGroupToNewWindow',
	'workbench.action.moveEditorGroupToNewWindow',
	'workbench.action.restoreEditorsToMainWindow',
	'workbench.action.terminal.newInNewWindow',
	'workbench.action.terminal.moveIntoNewWindow',
	// The display language is SynthOrg's setting, not the editor's (nls-loader.ts).
	'workbench.action.configureLocale',
	'workbench.action.clearLocalePreference'
];

/** Menus that carry those commands, or the "Open Recent" submenu. */
// The palette is in the list because most of these commands put themselves there explicitly.
const MENUS = [MenuId.CommandPalette, MenuId.EditorTitleContext, MenuId.EditorTabsBarContext, MenuId.MenubarFileMenu, MenuId.MenubarRecentMenu, MenuId.MenubarHelpMenu, MenuId.EmptyEditorGroupContext, MenuId.ExplorerContext];

const never = ContextKeyExpr.false();
const leaves = new Set(LEAVES_PROJECT);

function hideOffers(): void {
	for (const menu of MENUS) {
		for (const item of MenuRegistry.getMenuItems(menu)) {
			const gone = isIMenuItem(item) ? leaves.has(item.command.id) : item.submenu === MenuId.MenubarRecentMenu;
			if (gone) {
				item.when = never;
			}
		}
	}
}

// Menu items are plain registry entries: the ones registered so far are hidden
// now, the ones a later module adds when the registry next changes.
hideOffers();
let hiding = false;
MenuRegistry.onDidChangeMenu(() => {
	if (hiding) {
		return;
	}
	hiding = true;
	try {
		hideOffers();
	} finally {
		hiding = false;
	}
});

for (const id of LEAVES_PROJECT) {
	// A command without a palette entry of its own gets an implicit one: an explicit,
	// never-shown entry takes its place.
	MenuRegistry.appendMenuItem(MenuId.CommandPalette, { command: { id, title: id }, when: never });
	// The newest registration of a command wins: keybindings and extensions reach this one.
	CommandsRegistry.registerCommand(id, () => undefined);
}

/*
 * Git is SynthOrg's too: every change is recorded on its own, looked at and
 * restored from SynthOrg's history panel, uploaded with its "Carica su GitHub".
 * The Source Control view (commit, stage, branches, sync) goes, with its
 * Ctrl+Shift+G; the editor keeps the change marks and the diffs, which only look
 * (write commands: vs/workbench/contrib/scm/browser/git.contribution.ts).
 */
const SCM_CONTAINER = 'workbench.view.scm';
const containers = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
const views = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

function dropSourceControl(): void {
	const container = containers.get(SCM_CONTAINER);
	if (!container) {
		return;
	}
	const present = views.getViews(container);
	if (present.length) {
		views.deregisterViews(present, container);
	}
	containers.deregisterViewContainer(container);
}

dropSourceControl();
// A view a later module adds to it would bring the container's icon back.
views.onViewsRegistered(added => {
	if (added.some(({ viewContainer }) => viewContainer.id === SCM_CONTAINER)) {
		dropSourceControl();
	}
});

/*
 * The extensions the editor comes with are what it works with (the languages,
 * their colours, the tools of each): there is no view here to look for others,
 * install them or switch them off, and the commands that open it do nothing.
 */
const EXTENSIONS_CONTAINER = 'workbench.view.extensions';
const OPENS_EXTENSIONS = [
	'workbench.view.extensions',
	'workbench.extensions.action.showInstalledExtensions',
	'workbench.extensions.action.showEnabledExtensions',
	'workbench.extensions.action.showDisabledExtensions',
	'workbench.extensions.action.showPopularExtensions',
	'workbench.extensions.action.showRecommendedExtensions',
	'workbench.extensions.action.listBuiltInExtensions',
	'workbench.extensions.action.installExtensions',
	'workbench.extensions.action.installVSIX',
	'workbench.extensions.action.focusExtensionsView',
	'workbench.extensions.search',
	'workbench.extensions.action.checkForUpdates'
];

function dropExtensionsView(): void {
	const container = containers.get(EXTENSIONS_CONTAINER);
	if (!container) {
		return;
	}
	const present = views.getViews(container);
	if (present.length) {
		views.deregisterViews(present, container);
	}
	containers.deregisterViewContainer(container);
}

dropExtensionsView();
views.onViewsRegistered(added => {
	if (added.some(({ viewContainer }) => viewContainer.id === EXTENSIONS_CONTAINER)) {
		dropExtensionsView();
	}
});
for (const id of OPENS_EXTENSIONS) {
	MenuRegistry.appendMenuItem(MenuId.CommandPalette, { command: { id, title: id }, when: never });
	CommandsRegistry.registerCommand(id, () => undefined);
}
