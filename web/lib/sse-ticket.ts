// SSE and the collab WebSocket are opened cross-origin (directly against the
// backend Worker — the Next proxy buffers streams and can't carry a WS
// upgrade), so the same-origin session cookie isn't sent. We fetch a
// short-lived HMAC ticket from the `/api/auth-ticket` route and append it to
// the URL.
//
// The backend authenticates the `Authorization: Bearer <jwt>` Supabase access
// token and never reads the session cookie (src/auth/middleware.ts
// validateSupabaseSession). We attach that header here exactly like lib/api.ts
// does for REST — otherwise the ticket fetch 401s, no ticket is appended, and
// the SSE/collab socket opens unauthenticated → rejected (a returning run's
// collab editor then renders empty).
//
// On failure (e.g. local dev against the Python backend, where AUTH_DISABLED is
// set and there is no ticket route), the URL is returned unchanged so streaming
// still works without auth.
import { getSupabaseClient } from "./supabase-client";

async function supabaseAccessToken(forceRefresh = false): Promise<string | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;
  const { data } = forceRefresh
    ? await supabase.auth.refreshSession()
    : await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function fetchTicket(token: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  return fetch("/api/auth-ticket", { credentials: "include", headers });
}

export async function withSseTicket(sseUrl: string): Promise<string> {
  try {
    let r = await fetchTicket(await supabaseAccessToken());
    // A stale Supabase access token 401s; force-refresh once and retry
    // (mirrors the REST client's recovery in lib/api.ts).
    if (r.status === 401) {
      const refreshed = await supabaseAccessToken(true);
      if (refreshed) r = await fetchTicket(refreshed);
    }
    if (!r.ok) return sseUrl;
    const { ticket } = (await r.json()) as { ticket?: string };
    if (!ticket) return sseUrl;
    const sep = sseUrl.includes("?") ? "&" : "?";
    return `${sseUrl}${sep}ticket=${encodeURIComponent(ticket)}`;
  } catch {
    return sseUrl;
  }
}
