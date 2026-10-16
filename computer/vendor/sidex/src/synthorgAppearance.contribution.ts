import { Disposable } from './vs/base/common/lifecycle.js';
import { Color, RGBA } from './vs/base/common/color.js';
import { ConfigurationTarget, IConfigurationService } from './vs/platform/configuration/common/configuration.js';
import { Registry } from './vs/platform/registry/common/platform.js';
import { Extensions as ColorExtensions, IColorRegistry } from './vs/platform/theme/common/colorUtils.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from './vs/workbench/common/contributions.js';
import { IWorkbenchThemeService } from './vs/workbench/services/themes/common/workbenchThemeService.js';
import './synthorg.css';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { requestedLocale } from './nls-loader.js';

interface Appearance { mode: string; tokens: Record<string, string>; locale?: string; }

/** Remembers, across the restart, which language it was already restarted for. */
const RELOAD_KEY = 'synthorg.code.locale-restart';

/**
 * Colours that are a palette of their own, where blue means blue and not "the accent": the terminal's sixteen,
 * the charts, the kinds of symbol, the bracket pairs, what git and the debugger mark.
 */
const OWN_PALETTE = /^(terminal\.ansi|charts\.|symbolIcon\.|terminalSymbolIcon\.|editorBracket|gitDecoration\.|editorGutter\.|minimapGutter\.|editorOverviewRuler\.|debugTokenExpression\.|debugConsole\.)/;

class SynthOrgAppearance extends Disposable implements IWorkbenchContribution {
  /** For each base theme, the colours it paints in its own blue and how opaque each is: found once, see `accented`. */
  private readonly themeBlue = new Map<string, [string, number][]>();

  constructor(
    @IConfigurationService private readonly configuration: IConfigurationService,
    @IWorkbenchThemeService private readonly theme: IWorkbenchThemeService,
  ) {
    super();
    let pending = Promise.resolve();
    // Translations are loaded once, at start: another language means another
    // start. Unsaved editors come back from the workbench's own backups.
    const restartNeeded = (appearance: Appearance) => {
      const locale = appearance.locale?.toLowerCase();
      if (!locale) { return false; }
      if (locale === requestedLocale) {
        try { sessionStorage.removeItem(RELOAD_KEY); } catch { /* no storage, no memory of it */ }
        return false;
      }
      // One restart per language. If the workbench comes back still disagreeing
      // — the host was unreachable while it was loading — it stays as it is:
      // an editor in the wrong language beats one that reloads forever.
      try {
        if (sessionStorage.getItem(RELOAD_KEY) === locale) { return false; }
        sessionStorage.setItem(RELOAD_KEY, locale);
      } catch { /* no storage: the check below still stops the second reload */ }
      return true;
    };
    const update = (appearance: Appearance, mayRestart = true) => {
      if (mayRestart && restartNeeded(appearance)) { window.location.reload(); return; }
      pending = pending.then(() => this.apply(appearance)).catch(error => console.error('[Code] Appearance:', error));
    };
    void listen<Appearance>('synthorg-code-appearance', event => update(event.payload))
      .then(async unlisten => {
        this._register({ dispose: unlisten });
        update(await invoke<Appearance>('code_appearance'));
      }).catch(error => console.error('[Code] Appearance bridge:', error));
    // The colours in the script that created this webview are painted at once,
    // before the host answers. Its locale, though, is the one of the day the
    // webview was created and never changes again: comparing it here restarted
    // the workbench at every start, forever. Only the host's own answer, above,
    // decides a restart.
    const initial = (window as any).__SYNTHORG_APPEARANCE__;
    if (initial) update(initial, false);
  }

  private async apply(appearance: Appearance): Promise<void> {
    const token = (name: string) => appearance.tokens[name] || '';
    const light = appearance.mode === 'light';
    const bg = token('--bg-app');
    const surface = token('--bg-surface');
    const text = token('--text-main');
    const accent = token('--primary');
    const neutral = token('--text-neutral');
    const header = token('--bg-header');
    const active = token('--bg-active');
    const hover = token('--bg-pill');
    const muted = token('--text-muted');
    const borderSubtle = token('--border-subtle');
    const border = token('--border-default');
    const line = token('--line-color') || borderSubtle;
    const shadow = light ? '#1919231f' : '#00000066';
    const colors: Record<string, string> = {
      'editor.background': bg, 'editor.foreground': text,
      'sideBar.background': surface, 'sideBar.foreground': text,
      'activityBar.background': surface, 'activityBar.foreground': accent,
      'titleBar.activeBackground': surface, 'titleBar.activeForeground': text,
      'statusBar.background': surface, 'statusBar.foreground': neutral,
      'statusBar.noFolderBackground': surface, 'statusBar.noFolderForeground': neutral,
      'panel.background': bg, 'terminal.background': bg, 'terminal.foreground': text,
      // The section under the editor, drawn as the frame of the project is: its line, its names, the one in view in the accent.
      'panel.border': line, 'panelTitle.activeForeground': accent, 'panelTitle.inactiveForeground': muted, 'panelTitle.activeBorder': '#00000000',
      'tab.activeBackground': bg, 'tab.inactiveBackground': surface,
      'tab.activeForeground': text, 'tab.inactiveForeground': neutral,
      'editorGroupHeader.tabsBackground': surface,
      'input.background': token('--bg-input'), 'input.foreground': text,
      'input.border': border, 'input.placeholderForeground': muted,
      'dropdown.background': surface, 'dropdown.foreground': text,
      'dropdown.border': border, 'dropdown.listBackground': surface,
      // Right-click and title-bar menus: the app's surface, not Dark/Light Modern's grey.
      'menu.background': surface, 'menu.foreground': text, 'menu.border': border,
      'menu.selectionBackground': active, 'menu.selectionForeground': text,
      'menu.separatorBackground': borderSubtle,
      'menubar.selectionBackground': hover, 'menubar.selectionForeground': text,
      // Ctrl+P, the command palette and every other quick pick.
      'quickInput.background': surface, 'quickInput.foreground': text,
      'quickInputTitle.background': header,
      'quickInputList.focusBackground': active, 'quickInputList.focusForeground': text,
      'pickerGroup.border': borderSubtle, 'pickerGroup.foreground': accent,
      // Selection and hover in the explorer, the lists and the pickers.
      'list.activeSelectionBackground': active, 'list.activeSelectionForeground': text,
      'list.inactiveSelectionBackground': hover, 'list.inactiveSelectionForeground': text,
      'list.hoverBackground': hover, 'list.hoverForeground': text,
      'list.focusOutline': accent, 'list.highlightForeground': accent,
      'widget.shadow': shadow, 'widget.border': borderSubtle,
      'editorWidget.background': surface, 'editorWidget.foreground': text, 'editorWidget.border': borderSubtle,
      'editorSuggestWidget.background': surface, 'editorSuggestWidget.border': borderSubtle,
      'editorSuggestWidget.selectedBackground': active, 'editorHoverWidget.background': surface,
      'editorHoverWidget.border': borderSubtle,
      'focusBorder': accent, 'progressBar.background': accent,
      'button.background': accent, 'button.foreground': token('--on-primary'),
      'badge.background': accent, 'badge.foreground': token('--on-primary'),
    };
    // A token the page did not send leaves the theme's own colour, not an empty one.
    for (const key of Object.keys(colors)) { if (!colors[key]) { delete colors[key]; } }
    document.documentElement.style.setProperty('--synthorg-font', token('--font-sans'));
    document.documentElement.style.setProperty('--synthorg-radius', token('--radius-sm'));
    const themeName = light ? 'Light Modern' : 'Dark Modern';
    // MEMORY overrides appearance for this session. Functional user settings
    // continue to persist through the existing editor configuration service.
    const known = this.themeBlue.get(themeName);
    await this.configuration.updateValue('workbench.colorCustomizations', known ? this.accented(colors, known, accent) : colors, ConfigurationTarget.MEMORY);
    await this.configuration.updateValue('workbench.colorTheme', themeName, ConfigurationTarget.MEMORY);
    const themes = await this.theme.getColorThemes();
    const selected = themes.find(theme => theme.settingsId === themeName);
    if (selected) await this.theme.setColorTheme(selected.id, undefined);
    if (!known && selected && accent) {
      const found = this.findThemeBlue(colors);
      this.themeBlue.set(themeName, found);
      await this.configuration.updateValue('workbench.colorCustomizations', this.accented(colors, found, accent), ConfigurationTarget.MEMORY);
    }
  }

  /**
   * The base theme has one blue — Dark Modern's #0078D4, Light Modern's #005FB8 — and paints with it, and with
   * lighter and fainter ones of the same hue, far more than the handful of colours named above: the line over
   * the open tab and under the panel's, links, the icons of what informs, of the debugger and of an extension's
   * publisher, a switch that is on. Named one by one, the next one the workbench adds stays blue. So they are
   * found: every colour the theme, as it stands with ours over it, still resolves to that hue.
   */
  private findThemeBlue(ours: Record<string, string>): [string, number][] {
    const theme = this.theme.getColorTheme();
    const found: [string, number][] = [];
    for (const { id } of Registry.as<IColorRegistry>(ColorExtensions.ColorContribution).getColors()) {
      if (ours[id] || OWN_PALETTE.test(id)) { continue; }
      const color = theme.getColor(id);
      if (!color) { continue; }
      const { h, s, a } = color.hsla;
      if (a > 0 && s >= 0.5 && h >= 200 && h <= 216) { found.push([id, a]); }
    }
    return found;
  }

  /** `colors`, and the theme's blue ones in the app's accent, each as opaque as it was. */
  private accented(colors: Record<string, string>, blue: [string, number][], accent: string): Record<string, string> {
    if (!accent) { return colors; }
    const { r, g, b } = Color.fromHex(accent).rgba;
    const all = { ...colors };
    for (const [id, alpha] of blue) { all[id] = Color.Format.CSS.formatHexA(new Color(new RGBA(r, g, b, alpha)), true); }
    return all;
  }
}

registerWorkbenchContribution2('synthorg.appearance', SynthOrgAppearance, WorkbenchPhase.AfterRestored);
