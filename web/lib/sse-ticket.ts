// SSE is opened cross-origin (directly against the backend Worker — the Next
// proxy buffers streams), so the same-origin session cookie isn't sent. We
// fetch a short-lived HMAC ticket from the cookie-protected `/api/auth-ticket`
// route and append it to the SSE URL.
//
// On failure (e.g. local dev against the Python backend, where AUTH_DISABLED is
// set and there is no ticket route), the URL is returned unchanged so streaming
// still works without auth.
export async function withSseTicket(sseUrl: string): Promise<string> {
  try {
    const r = await fetch("/api/auth-ticket", { credentials: "include" });
    if (!r.ok) return sseUrl;
    const { ticket } = (await r.json()) as { ticket?: string };
    if (!ticket) return sseUrl;
    const sep = sseUrl.includes("?") ? "&" : "?";
    return `${sseUrl}${sep}ticket=${encodeURIComponent(ticket)}`;
  } catch {
    return sseUrl;
  }
}
