"use client";

// Browser-side Supabase client for the Supabase Auth migration (WS2).
//
// Gated by NEXT_PUBLIC_AUTH_PROVIDER === "supabase". When the provider is not
// Supabase (default = better-auth) this module still imports safely: the client
// is created lazily and never throws at import time, even if the env vars are
// unset. Call sites check `isSupabaseAuth()` before using `getSupabaseClient()`.
//
// Session persistence uses a custom **cookie** storage adapter (not
// localStorage) so the Next proxy/middleware — which only sees cookies, never
// JS storage — can run its optimistic auth gate by reading one cookie name.
//
// Spec: docs/superpowers/specs/2026-06-10-supabase-auth-migration.md
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Single, stable cookie name the middleware also reads. We deliberately do NOT
// use Supabase's default `sb-<ref>-auth-token` key because (a) it embeds the
// project ref (so the middleware would need the ref to reconstruct it) and (b)
// Supabase may chunk that key across multiple cookies. A single fixed name
// keeps the edge gate trivial. Real enforcement is still the backend 401.
export const SUPABASE_COOKIE_NAME = "bowtie-sb-auth";

// Cookie attributes. Path "/" so every route (incl. the proxy matcher) sees it;
// SameSite=Lax so it rides top-level navigations (the magic-link redirect lands
// on /verify via a GET navigation); Secure in production. Max-Age ~ 30 days —
// Supabase refreshes the access token inside this envelope.
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function isBrowser(): boolean {
  return typeof document !== "undefined";
}

function readCookie(name: string): string | null {
  if (!isBrowser()) return null;
  const prefix = `${name}=`;
  for (const part of document.cookie.split("; ")) {
    if (part.startsWith(prefix)) {
      return decodeURIComponent(part.slice(prefix.length));
    }
  }
  return null;
}

function writeCookie(name: string, value: string): void {
  if (!isBrowser()) return;
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    `${name}=${encodeURIComponent(value)}` +
    `; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
}

function deleteCookie(name: string): void {
  if (!isBrowser()) return;
  // Mirror writeCookie's attributes (incl. Secure) — some browsers require the
  // deletion directive's attributes to match for a Secure cookie to be cleared.
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

// Max RAW (pre-encode) chars per cookie chunk. A full Supabase session (ES256
// access token + the GoTrue user object with identities/metadata) serializes to
// ~3.7 KB, which after encodeURIComponent (~1.3x) blows past the ~4096-byte
// per-cookie browser limit — the browser then silently drops the cookie and the
// session never persists (→ middleware sees no cookie → /login bounce). So we
// chunk the value across `${key}.0`, `${key}.1`, … exactly like @supabase/ssr.
// 3000 raw chars keeps name + encoded value well under 4096.
const COOKIE_CHUNK_SIZE = 3000;

// Read a possibly-chunked value. Prefers chunks (`${key}.0`, `${key}.1`, …);
// falls back to a legacy single `${key}` cookie written before chunking existed.
function readChunkedCookie(key: string): string | null {
  const first = readCookie(`${key}.0`);
  if (first === null) return readCookie(key);
  let value = first;
  for (let i = 1; ; i++) {
    const part = readCookie(`${key}.${i}`);
    if (part === null) break;
    value += part;
  }
  return value;
}

// Write a value as N chunks and clear stale state: a legacy single cookie and
// higher-index chunks left by a previously-larger value.
function writeChunkedCookie(key: string, value: string): void {
  if (!isBrowser()) return;
  deleteCookie(key); // drop any pre-chunking single cookie
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += COOKIE_CHUNK_SIZE) {
    chunks.push(value.slice(i, i + COOKIE_CHUNK_SIZE));
  }
  chunks.forEach((chunk, i) => writeCookie(`${key}.${i}`, chunk));
  for (let i = chunks.length; readCookie(`${key}.${i}`) !== null; i++) {
    deleteCookie(`${key}.${i}`);
  }
}

// Delete the legacy single cookie and every chunk.
function deleteChunkedCookie(key: string): void {
  deleteCookie(key);
  for (let i = 0; readCookie(`${key}.${i}`) !== null; i++) {
    deleteCookie(`${key}.${i}`);
  }
}

// Storage adapter shape Supabase expects (getItem/setItem/removeItem). Backed by
// document.cookie (chunked) so the session lands in cookies the middleware reads.
const cookieStorage = {
  getItem: (key: string): string | null => readChunkedCookie(key),
  setItem: (key: string, value: string): void => writeChunkedCookie(key, value),
  removeItem: (key: string): void => deleteChunkedCookie(key),
};

/** True when the app is configured to use Supabase auth (vs better-auth). */
export function isSupabaseAuth(): boolean {
  return process.env.NEXT_PUBLIC_AUTH_PROVIDER === "supabase";
}

let cachedClient: SupabaseClient | null = null;

/**
 * Lazily create (and memoize) the browser Supabase client. Returns null when
 * the provider is not Supabase or the required env vars are missing — callers
 * must handle null rather than assume a client exists. Never throws at import.
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (cachedClient) return cachedClient;
  if (!isSupabaseAuth()) return null;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  cachedClient = createClient(url, anonKey, {
    auth: {
      flowType: "pkce",
      autoRefreshToken: true,
      persistSession: true,
      // The magic-link callback lands on /verify which performs the exchange
      // explicitly, so we keep URL detection off to avoid a double-exchange
      // race (and so a stray token in a URL elsewhere is never auto-consumed).
      detectSessionInUrl: false,
      storage: cookieStorage,
      storageKey: SUPABASE_COOKIE_NAME,
    },
  });
  return cachedClient;
}
