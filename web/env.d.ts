// Ambient typing for the public (NEXT_PUBLIC_*) environment variables added by
// the Supabase Auth migration. These are build-time-inlined by Next and read via
// process.env. Spec: docs/superpowers/specs/2026-06-10-supabase-auth-migration.md
//
// Augments (does not replace) the @types/node ProcessEnv index signature, so
// other NEXT_PUBLIC_* vars keep resolving to `string | undefined`. Wired into the
// Supabase browser client / auth flag in WS2; absent values degrade to the
// better-auth path.
declare namespace NodeJS {
  interface ProcessEnv {
    /** "supabase" switches the frontend onto the Supabase Auth client (WS2). */
    NEXT_PUBLIC_AUTH_PROVIDER?: string;
    /** Supabase project URL for the browser client (e.g. https://<ref>.supabase.co). */
    NEXT_PUBLIC_SUPABASE_URL?: string;
    /** Supabase anon / publishable key for the browser client (safe to expose). */
    NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
  }
}
