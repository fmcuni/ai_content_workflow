# Plan: Email/Password Auth for Cloudflare Production

**Source spec:** `docs/superpowers/specs/2026-06-01-cloudflare-email-auth.md`
**Complexity:** Medium–Large

## Build order

### Backend (`deploy/cloudflare-workers/`)
1. `package.json` — add `better-auth`, `kysely`, `kysely-postgres-js`.
2. `src/auth/domain.ts` — `isAllowedEmailDomain(email, env)` from `ALLOWED_EMAIL_DOMAINS`.
3. `src/auth/email.ts` — `sendEmail()` via Resend HTTPS API.
4. `src/auth/ticket.ts` — WebCrypto HMAC `mintTicket`/`verifyTicket` (~60s TTL).
5. `src/auth/auth.ts` — `getAuth(env)` factory (kysely-postgres-js dialect, snake casing,
   emailAndPassword + requireEmailVerification, sendVerificationEmail/sendResetPassword,
   trustedOrigins, sign-up domain hook) returning `{ auth, sql }`.
6. `src/auth/middleware.ts` — `requireAuth` Hono middleware (cookie session for REST,
   ticket for `*/events`); skips `/health`, `/api/auth/*`; no-op when `AUTH_DISABLED`.
7. `src/index.ts` — extend `Env`; mount `app.on(["GET","POST"], "/api/auth/*", ...)`;
   add `GET /api/auth-ticket` (session-protected); `app.use("*", requireAuth)`.
8. `wrangler.jsonc` — vars `RESEND_FROM`, `ALLOWED_EMAIL_DOMAINS`; document new secrets.
9. `supabase/migrations/20260601000001_better_auth.sql` — auth tables + RLS + grants.

### Frontend (`web/`)
10. `package.json` — add `better-auth`.
11. `lib/auth-client.ts` — `createAuthClient({ baseURL, basePath: "/api/auth" })`.
12. `proxy.ts` — optimistic session-cookie gate (Next 16 convention).
13. `next.config.mjs` — rewrites `/api/auth/:path*` (path-preserving) + `/api/auth-ticket`.
14. `lib/sse.ts` — fetch ticket, append `?ticket=` to SSE URL.
15. `lib/api.ts` — `credentials: "include"`.
16. `app/login/page.tsx`, `app/signup/page.tsx`, `app/verify/page.tsx`.
17. `components/Masthead.tsx` — signed-in email + sign-out.

## Validation
```bash
cd deploy/cloudflare-workers && npm install && npm run typecheck
supabase db reset
cd web && npm install && npx tsc --noEmit && npx playwright test
node deploy/cloudflare-workers/parity/check-parity.mjs
```

## Risks (carried from spec)
- `.com.sg` lockout — allowlist is env-configurable; user confirmed @bowtie.com.hk access.
- Resend sending-domain DNS must be verified before mail sends.
- Proxy header forwarding (Origin/Cookie) through Next rewrites — verify at test time.
- better-auth ⇄ postgres.js/Hyperdrive on Workers — verified via Context7; kysely path.
