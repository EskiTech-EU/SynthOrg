/*
 * SynthOrg: the editor speaks the language SynthOrg is set to.
 *
 * There is no language setting inside the editor. The locale comes from the
 * host (the same `code_appearance` state that carries the theme), and the
 * translations are a file shipped with the application, `/nls/<locale>.json`,
 * prepared by `scripts/fetch-code-language-packs.js`. Nothing is looked up on
 * the network or in the user's home. English needs no file.
 */

type Translations = Record<string, string>;

/** The locale the host asked for when this workbench loaded; a different one later means reload. */
export let requestedLocale = 'en';

async function hostLocale(): Promise<string> {
	try {
		const { invoke } = await import('@tauri-apps/api/core');
		const appearance = await invoke<{ locale?: string }>('code_appearance');
		if (typeof appearance?.locale === 'string' && /^[a-z]{2}(-[a-z]{2})?$/i.test(appearance.locale)) {
			return appearance.locale.toLowerCase();
		}
	} catch {
		// Outside SynthOrg there is no host to ask.
	}
	const initial = (window as { __SYNTHORG_APPEARANCE__?: { locale?: string } }).__SYNTHORG_APPEARANCE__?.locale;
	return typeof initial === 'string' ? initial.toLowerCase() : 'en';
}

export async function loadNlsMessages(): Promise<void> {
	const locale = await hostLocale();
	requestedLocale = locale;
	if (locale.startsWith('en')) {
		return;
	}
	try {
		const [translationsRes, indexRes] = await Promise.all([fetch(`/nls/${locale}.json`), fetch('/nls.messages.json')]);
		const isJson = (res: Response) => res.ok && (res.headers.get('content-type') ?? '').includes('json');
		if (!isJson(translationsRes)) {
			console.warn(`[Code] No translations shipped for "${locale}": the editor stays in English.`);
			return;
		}
		const translations: Translations = await translationsRes.json();
		if (isJson(indexRes)) {
			const entries: Array<{ key: string; msg: string }> = await indexRes.json();
			if (entries.length > 0) {
				(globalThis as any)._VSCODE_NLS_MESSAGES = entries.map(({ key, msg }) => translations[key] ?? msg);
				(globalThis as any)._VSCODE_NLS_LANGUAGE = locale;
				return;
			}
		}
		(globalThis as any)._VSCODE_NLS_TRANSLATIONS = translations;
		(globalThis as any)._VSCODE_NLS_LANGUAGE = locale;
	} catch (error) {
		console.warn('[Code] Translations not loaded:', error);
	}
}
