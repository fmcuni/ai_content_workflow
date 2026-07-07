# Claude debug login (DEV stack only)

Headless login + guarded browser driver so Claude Code can verify UI changes on
the **dev** Workers stack itself (instead of asking a human to eyeball).

## Pieces

| Script | Purpose |
|---|---|
| `dev-env.mjs` | Loads gitignored `.env.dev.local`; pins everything to the dev Supabase ref (`ovxvhxwmqeccjudhyfbh`) and `*-dev.franco-ma.workers.dev` — throws on any non-dev target. |
| `provision.mjs` | Idempotent: generates `CLAUDE_DEBUG_EMAIL`/`CLAUDE_DEBUG_PASSWORD` into `.env.dev.local` (first run), creates/password-resets the GoTrue user via the admin API (email pre-confirmed), upserts `content_tool.app_user` with `role=admin` (invite-only authz needs the row), verifies the password grant. |
| `login.mjs` | Password grant via real `@supabase/supabase-js` (from `web/node_modules`), writes chunked `bowtie-sb-auth.0..n` cookies (mirrors `web/lib/supabase-client.ts`) as Playwright storageState → `.out/state.json`. |
| `browse.mjs` | Step-driven headless Chromium with guardrails (below). Screenshots/dumps land in `.out/`. |

## Usage

```bash
node scripts/claude-debug/provision.mjs   # once (or after creds rotate)
node scripts/claude-debug/login.mjs       # mint/refresh the session
node scripts/claude-debug/browse.mjs '[{"goto":"/runs"},{"shot":"runs.png"},{"dump":"main"}]'
```

Step ops: `goto`, `waitFor` (selector), `waitMs`, `click`, `clickText`,
`fill` `[selector, text]`, `press`, `shot`, `dump` (selector innerText),
`dumpLinks`.

## Guardrails

Dev shares the **live WordPress** with prod, so:

- Navigation is allowed only to the dev web/api Workers hosts.
- Every non-GET request whose path mentions `resume`/`publish`/`republish` is
  aborted at the network layer — HITL approval / publish can never fire.
- Non-GET requests to hosts outside {dev web, dev api, dev Supabase} are
  aborted (no accidental writes to prod backends or WordPress).
- `click`/`clickText` refuse elements whose text matches approve/publish/reject.
- `dev-env.mjs` refuses to run if `.env.dev.local` URLs reference any
  Supabase project other than the dev ref.

## Secrets hygiene

Creds live only in gitignored `.env.dev.local`; scripts print statuses, paths,
and the service email — never passwords, keys, or tokens. `.out/` (session
state + screenshots) is gitignored.
