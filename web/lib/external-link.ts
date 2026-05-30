/**
 * Open an external URL in the user's default browser.
 *
 * In the Tauri desktop shell the webview loads this frontend from
 * `http://127.0.0.1:3000` and swallows `target="_blank"` anchors and plain
 * external navigations, so a normal link click does nothing. There we route
 * through the Tauri `opener` plugin. In a regular browser we fall back to
 * `window.open`.
 *
 * The Tauri plugin is imported dynamically and only when the injected IPC
 * bridge is present, so the dependency never loads (or runs) during SSR or in
 * a plain-browser deployment.
 */
export async function openExternal(url: string): Promise<void> {
  if (!url || typeof window === "undefined") return;

  if ("__TAURI_INTERNALS__" in window) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return;
    } catch (err) {
      // Capability misconfigured or plugin unavailable — fall back below so the
      // link still has a chance to open rather than silently failing.
      console.error("Tauri opener failed; falling back to window.open", err);
    }
  }

  window.open(url, "_blank", "noopener,noreferrer");
}

/** True when running inside the Tauri desktop webview. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
