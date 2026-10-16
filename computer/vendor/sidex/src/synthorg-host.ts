// The workbench shares SynthOrg's runtime, window, and visual preferences.
// Its native child webview scopes editor styles, shortcuts and IPC callbacks.
export function installHostBridge(): void {
  // The native child webview has its own IPC destination and callback registry.
  (window as any).__SYNTHORG_EMBEDDED__ = true;
}
