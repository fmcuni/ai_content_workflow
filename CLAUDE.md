# Context discipline

Before reading files, search first with rg.

Prefer:
- rg for discovery
- targeted file reads by line range
- reading only the function, component, or config block needed
- summarizing findings before opening more files

Avoid:
- reading whole files unless necessary
- broad Glob exploration without a reason
- pasting full logs into context
- re-reading the same file after small edits unless needed

## Model Routing

Use subagents when they keep the main Fable context cleaner or make the work safer.

- Use Fable for planning, architecture, task split, and final judgment.
- Use `codebase-scout` for broad repo scans, logs, search, and read-only investigation.
- Use `sonnet-builder` for routine implementation, refactors, tests, and scoped file edits.
- Use `opus-reviewer` for hard debugging, risky logic, security-sensitive code, migrations, complex state, or pre-merge review.

Effort guide:
- Fable: high by default, xhigh only for genuinely hard tasks.
- Sonnet: medium for building, low for scouting.
- Opus: xhigh only for deep review.

Subagents should return concise findings: files inspected or changed, validation run, risks, and next steps. Do not dump huge logs unless requested.

# Project Instructions

Bowtie AI Content Tool — LangGraph-based article update pipeline with HITL
(Human-In-The-Loop) gates, publishing to WordPress.

## Tech Stack

- **Backend:** Python 3.13, FastAPI, LangGraph, SQLAlchemy async, Pydantic v2,
  asyncpg, sse-starlette, OpenTelemetry, structlog
- **LLM:** Google Gemini (`google-genai`)
- **DB:** PostgreSQL 16
- **Frontend:** Next.js 16, React 19, TanStack Query, TipTap, Tailwind 4, shadcn
- **Tests:** pytest + pytest-asyncio + testcontainers (backend), Playwright (web)
- **Lint/Type:** ruff + pyright **strict**
- **Tooling:** uv (Python), npm (web)

## Build & Run

| Task | Command |
|---|---|
| Install (Python) | `uv venv && source .venv/bin/activate && uv pip install -e ".[dev]"` |
| Install (web) | `cd web && npm install` |
| Backend dev | `uvicorn content_tool.api.main:app --reload --port 8000` |
| Web dev | `cd web && npm run dev` (→ http://localhost:3000) |
| Tests (py) | `pytest` |
| Tests (web) | `cd web && npx playwright test` |
| Lint (py) | `ruff check .` |
| Typecheck | `pyright` |
| Migrate DB (local) | `supabase db reset` |
| Migrate DB (prod) | `supabase db push` |
| New migration | `supabase migration new <name>` |
| CLI | `content-tool gap-analysis --article-url ... --topic ... --keywords ...` |

## Project Structure

```
content_tool/        Backend Python package
  api/               FastAPI app + routes/ (runs, articles, personas, prompts, ...)
  agents/            LangGraph node functions (fetch, outline, writer, audit, publish, ...)
  graph/             Graph composition (root, strategy, production, checkpointer)
  models/            Pydantic models + LangGraph state types
  db/                SQLAlchemy models, async engine/session
  gemini/            Gemini client wrapper
  wordpress/         WP REST client, SEO plugin detection
  policy/            Personas, source policy
  compliance/        Compliance audit log writer
  observability/     Logging, tracing, cost calculation
  refresh/           Periodic article re-audit (CMS Stage 0)
config/              YAML config (pricing, refresh, personas, source_policy)
prompts/             LLM prompt templates (.md)
supabase/migrations/ Supabase migration files (baseline + future changes)
supabase/seed.sql    Seed data (personas)
web/                 Next.js 16 frontend (see web/AGENTS.md before editing)
deploy/cloudflare-workers/  Production hosting: TypeScript port of the backend as a
                     Cloudflare Worker (Hono + Workflows + Durable Objects, DB via
                     postgres.js over Hyperdrive). See its README + AGENTS notes.
docs/design/    specs/ and plans/ — design docs per feature, dated
evals/               LLM-judge evals + fixtures (nightly cron + PR label trigger);
                     prompt_advisor.py = aggregate LLM-as-judge that prescribes
                     prompt fixes (`python -m evals.run_prompt_advisor`)
tests/{unit,integration,fixtures}
scripts/             Cron entrypoints (e.g. refresh_scan)
```

## Deployment (production)

Production runs the **Workers-native TypeScript port**, not the Python backend:

| Service | Source | URL |
|---|---|---|
| Backend | `deploy/cloudflare-workers/` (`bowtie-content-tool-poc`) | `https://bowtie-content-tool-poc.fmc.workers.dev` |
| Frontend | `web/` via `@opennextjs/cloudflare` (`bowtie-content-tool-web`) | `https://bowtie-content-tool-web.fmc.workers.dev` |

- CI: `.github/workflows/deploy-workers.yml` deploys both to the `fmc` Cloudflare
  account on push to `main` (secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`).
  Runtime secrets (`POSTGRES_URL`, `GEMINI_API_KEY`, `WP_*`) are set once via
  `wrangler secret put` and preserved across deploys.
- The Python backend (`content_tool/`) is **retained** — it runs the `evals/`
  suite and is used for local dev. It is no longer the production hosting path.
  (The old Worker+Containers stack — `deploy/cloudflare/`, `Dockerfile.cf-*` — and
  the Tauri desktop app were retired.)
- Parity gate: `node deploy/cloudflare-workers/parity/check-parity.mjs` diffs the TS
  backend against the Python reference over read-only routes.

### Alt account (CI-deployed)

A second Cloudflare account (franco.ma@bowtie.com.hk, `franco-ma.workers.dev`)
hosts compute-only duplicates: `alt` mirrors prod (same prod Supabase/WP data)
and `alt-dev` mirrors dev (dev Supabase). URLs: `bowtie-content-tool-{poc,web}[-dev].franco-ma.workers.dev`.
**CI deploys all four alt Workers** on push to main (`deploy-workers.yml` alt
steps run after the fmc prod deploys; GH secrets `CF_ALT_API_TOKEN`/
`CF_ALT_ACCOUNT_ID`/`SUPABASE_ANON_KEY_DEV`). Manual fallback with the same
creds from gitignored `.env.local`: backend `npx wrangler deploy --env alt|alt-dev`,
web `node scripts/deploy-web.mjs alt|alt-dev`.

### Dev environment (Workers) — develop here first

A parallel, isolated dev stack mirrors prod via wrangler named environments
(`env.dev` in both `wrangler.jsonc`). **Prefer building + verifying in dev before
touching prod.**

| Service | Dev Worker | Dev URL |
|---|---|---|
| Backend | `bowtie-content-tool-poc-dev` | `https://bowtie-content-tool-poc-dev.fmc.workers.dev` |
| Frontend | `bowtie-content-tool-web-dev` | `https://bowtie-content-tool-web-dev.fmc.workers.dev` |

- **Deploy dev (manual):** `npm run deploy:dev` (backend) / `npm run cf:deploy:dev`
  (web, with `NEXT_PUBLIC_*` for dev). CI deploys **prod only**.
- **Isolated** dev Supabase DB (`ovxvhxwmqeccjudhyfbh`) + Hyperdrive + Workflows
  (`-dev`) + DO namespaces; refresh-scan cron disabled. **WordPress is shared with
  prod** — a dev publish hits the live CMS.
- **Keep in sync:** apply every new migration to both (dev
  `supabase db push --db-url "$DEV_POSTGRES_URL"`, prod `supabase db push`) and
  deploy the same commit to both. Runtime data (voices/prompts) is NOT auto-synced.
- Full runbook + dev↔prod workflow: `docs/dev-environment-runbook.md`. Dev creds
  live in gitignored `.env.dev.local`.

### Claude debug login (dev-only) — self-verify UI changes

`scripts/claude-debug/` gives Claude Code an authenticated headless browser on
the **dev** stack — use it to verify UI changes yourself (screenshots via the
`Read` tool) instead of asking the user to eyeball:

```bash
node scripts/claude-debug/provision.mjs   # once / after cred rotation (idempotent)
node scripts/claude-debug/login.mjs       # mint session → .out/state.json (~30d)
node scripts/claude-debug/browse.mjs '[{"goto":"/runs"},{"shotView":"runs.png"}]'
```

- Service user `content-tool-claude-debug@bowtie.com.hk` (GoTrue + `app_user`
  role=admin on the dev Supabase project); creds auto-managed in gitignored
  `.env.dev.local` (`CLAUDE_DEBUG_EMAIL`/`CLAUDE_DEBUG_PASSWORD`).
- **DEV-ONLY by decision** — do NOT provision a prod variant. Guardrails are
  client-side: navigation pinned to `*-dev.fmc.workers.dev`; all non-GET
  requests to `resume|publish|republish` paths or non-dev hosts are aborted at
  the network layer (HITL_2 approve/publish can never fire; WordPress is shared
  with prod). Do not weaken these guards.
- Full-page shots of long articles are unreadable — prefer `shotView` (2×
  density) or `shotEl`. See `scripts/claude-debug/README.md` for all step ops.

## Architecture

- Request enters via FastAPI route in `content_tool/api/routes/`.
- `RunExecutor` (`api/sse.py`) drives a compiled LangGraph from `graph/root.py`,
  composed of `strategy` and `production` subgraphs.
- Two HITL interrupts: `HITL_1` (after outline) and `HITL_2` (after draft);
  resumed via `POST /runs/{id}/resume`. UI streams progress over SSE.
- Approval at HITL_2 publishes via `wordpress/client.py` and writes the
  compliance audit log.
- Entry modes via `start_mode`: refresh runs follow the path above; **Front II**
  ("Expand Topics") runs the `topic_expansion` subgraph (theme → topic-gen →
  dedup + hot-topic → HITL_T1 review → fan-out to runs); **Front III** ("Create
  New Articles") uses `start_mode="create"` — skip `fetch_article`/`gap_analysis`,
  enter at `outline`, and publish to WordPress with the operator's selected
  `wp_publish_status` (defaulting to **draft** when unset; both create and
  refresh honor the choice — see `wordpress/publish_status` / `publish.py`).
  **Promoted topics**
  (Front II → `POST /topic-batches/{id}/promote`) fan out per the selected promotion
  `mode`: `create` promotions follow the Front III path above, while `refresh`
  promotions use `start_mode="refresh"` with the candidate's `existing_url` and run
  the full refresh path (fetch + gap analysis).

### Realtime collab (`RunDoc` Durable Object)

- Per-run collab document hub as a Cloudflare Durable Object `RunDoc`
  (`deploy/cloudflare-workers/src/run-doc.ts`, bound `RUN_DOC`; wrangler migration
  tag `v5`, `new_sqlite_classes: ["RunDoc"]`).
- Relays **Yjs CRDT sync + awareness** (presence/cursor) over a WebSocket at
  `/runs/:id/doc`. Cursor colours are **server-issued** by the DO, not the client.
- Per-author attribution ("blame") via `Y.PermanentUserData` — surfaced in live
  cursors and the Review popover.
- **Seeder grant:** the DO designates exactly one client as seeder
  ("you-are-seeder" signal) to close the seed race. Caveat: it currently grants
  `primary` regardless of role, so a future read-only observer could consume the
  seeder slot (latent — no observer surface exists yet).
- **Persistence:** DO storage + best-effort Postgres cold-store table
  `run_collab_state` (migration `supabase/migrations/20260612000000_run_collab_state.sql`).
  The Postgres cold-store is a **no-op when `HYPERDRIVE` is unbound** (e.g. local);
  prod has Hyperdrive so it persists/cold-loads.
- **Gate:** collab is behind the **build-time** Next public env var
  `NEXT_PUBLIC_COLLAB_ENABLED` (`web/lib/run-editor/collab-flag.ts`) — NOT a runtime
  toggle; default **OFF**.
- Collab surfaces (presence avatar stack) are wired into the run-editor shell on the
  `/hitl2` and `/edit` pages. Observer read-only infra exists but no observer surface
  is wired yet.
- External working-body writes (tracked-change reject, AI apply-edits result,
  comment/review-span edits, snapshot restore) are pushed into the Yjs doc via a
  **whole-document replace** (`replaceCollabDoc` + the `useWorkingBody` hook) so they
  reflect in the Edit panel under collab. CAVEAT: a whole-doc replace can merge
  unexpectedly against a concurrent peer's in-flight edit (rare at the HITL_2 review
  gate, accepted for now).

## Conventions

- **Async everywhere** — DB, HTTP, Gemini. `asyncio_mode = "auto"` in pytest.
- **Pyright strict.** Add precise type hints; do not weaken the config to fix errors.
  The baseline is ~547 existing errors — focus on not adding new ones in touched files.
- **Ruff rules:** `E, F, I, B, UP, ASYNC, S, ANN, RUF` (`S101` ignored, tests exempt from
  `ANN`). Line length 100.
- **Naming:** snake_case modules; PascalCase Pydantic models; tests as `test_*.py`.
- **Frontend:** see `web/AGENTS.md` — Next.js 16 has breaking changes from earlier
  versions; consult `node_modules/next/dist/docs/` before writing Next code.
- **Commits:** Conventional Commits with scope: `feat(web):`, `fix(hitl2):`,
  `test(personas):`, etc.
- **Specs & plans:** new features get a dated design doc under
  `docs/design/specs/` and a plan under `docs/design/plans/`.

## Ops & Data

- **Scope:** this app handles public marketing/editorial content only — no
  customer PII, PHI, HKID, or other Bowtie private data passes through it.
  Standard hygiene still applies: no secrets/credentials in commits, logs, or
  external tool calls.
- **Run access (intentional shared model — NOT an IDOR bug):** run endpoints
  authorize by *role* (`viewer<author<reviewer<admin`), **not** by per-run
  ownership. Any authorized user may view/edit/resume/publish/PATCH any run by
  `run_id`; there is deliberately **no `created_by` ownership gate**. This is by
  design: the tool is a shared editorial **ops board** for invite-only Bowtie
  staff working on public content, with no tenant boundary. A security review
  may flag the by-`run_id`-only handlers (`routes/runs.ts`, `apply_edits`) as an
  IDOR — it is an accepted trade-off given the trust model. **Revisit and add an
  owner/tenant gate if that model changes** (external collaborators, multi-org,
  or any private/customer data entering the pipeline).
- Costs: `GET /costs/run/{run_id}` and `/costs/summary`; pricing in
  `config/pricing.yaml` (hot-reloaded).
- Compliance export: `GET /compliance/export.csv`.
- Tracing: set `OTEL_EXPORTER_OTLP_ENDPOINT` to ship spans (e.g. local Jaeger).

## Supabase

**Managed Postgres + Supabase Auth** — no PostgREST, no Data API.
SQLAlchemy/asyncpg owns all data access for the Python backend. Supabase Auth
(GoTrue) is the auth provider for the Workers backend + web (see **Auth** below).
The Python backend is retained for evals/local dev only and is not part of the
prod auth path. `supabase-js` is used **only** in the browser for the GoTrue
session — never for data access.

**Workers-native backend** (`deploy/cloudflare-workers/`) uses `postgres.js` through
Cloudflare Hyperdrive (`{ max: 5, fetch_types: false }`) instead of SQLAlchemy/asyncpg —
still a direct SQL connection to the same Supabase DB; no PostgREST, Data API, or
`supabase-js` is introduced.

**Schema:** `content_tool` (not `public`) — not auto-exposed to PostgREST/Data API.
RLS is enabled on all tables as defense in depth; app connects via the dedicated
`content_tool_app` role (not the `postgres` superuser).

**Connection choice:**
- **Direct connection** (port 5432) — default for the long-lived FastAPI process;
  supports SQLAlchemy/asyncpg prepared statements without workarounds.
- **Session-mode pooler** (port 5432 via pooler) — fallback if the host is
  IPv4-only and cannot reach the direct connection endpoint.
- **Never** use the transaction-mode pooler (port 6543) — it breaks prepared
  statements and silently degrades performance.

**Migration workflow:**
- `supabase migration new <name>` — scaffold a new migration
- `supabase db reset` — wipe + re-apply all migrations locally
- `supabase db push` — apply pending migrations to the linked prod project

### Auth (GoTrue / Supabase Auth)

Authentication is **Supabase Auth (GoTrue)**. The legacy better-auth provider and
the `AUTH_PROVIDER` / `NEXT_PUBLIC_AUTH_PROVIDER` selector flag were retired in
`chore/retire-better-auth` — GoTrue is now the sole path (`better-auth` + `pg` were
dropped from both `package.json`s).

- **Google OAuth, invite-only.** Sign-in is **Google OAuth** only
  (`signInWithOAuth({provider:"google"})` → Supabase `/auth/v1/callback` →
  `/verify` exchanges the PKCE `?code=`). `/signup` redirects. Magic-link was
  dropped (email-deliverability).
  **Invite-only is enforced at the AUTHORIZATION layer, not sign-in:** Google
  OAuth auto-creates a GoTrue user for anyone, so `effectiveRole`/`loadRole`
  (`authz.ts`) return **null (→ 401)** for an authenticated session with no
  `content_tool.app_user` row (and not a bootstrap admin) — i.e. unprovisioned
  users are denied, NOT floored to `viewer`. Provisioning is unchanged (admin pre-creates the
  `app_user` row + GoTrue user; the invitee then signs in with Google on the
  same email — Google's verified email auto-links to the existing user).
  **Provider setup:** enable Google in Supabase → Auth → Providers (client
  id/secret from a Google Cloud OAuth Web client whose authorized redirect URI is
  `https://<ref>.supabase.co/auth/v1/callback`); add the web origin's `/verify`
  to the Supabase redirect allow-list. Keep email/password enabled **only** for
  the `content-tool-e2e` service account (the Playwright harness mints sessions
  via password grant — OAuth can't run headless).
- **Token model:** the browser holds a Supabase session in a single cookie
  (`bowtie-sb-auth`, PKCE, cookie storage) and sends `Authorization: Bearer
  <access_token>`. The Workers backend verifies it in `src/auth/jwt.ts` via the
  project **JWKS** (asymmetric RS256/ES256, cached). **Once `SUPABASE_URL` is set,
  JWKS is authoritative and there is NO HS256 fallback** — so **prod MUST enable
  asymmetric ("Signing keys") JWTs in the Supabase dashboard**, or every request
  401s. HS256 (`SUPABASE_JWT_SECRET`) is only honored when no `SUPABASE_URL` is set.
- **User table:** `content_tool.app_user` (id ↔ GoTrue user id, lower(email)
  unique, `role` + `status`, RLS on, `content_tool_app` grants). `loadRole` reads
  it on the supabase branch. Migration `20260613000000_app_user.sql` **must be
  applied before** any code that reads the table (deploy-ordering invariant).
- **Roles (4-role cumulative):** `viewer < author < reviewer < admin`. The
  capability maps in `deploy/cloudflare-workers/src/auth/authz.ts` (`ROLES`/
  `ROLE_RANK`) and `web/lib/roles.ts` **must stay byte-in-sync**. `coerceRole`
  aliases the legacy stored `editor` → `reviewer`; `isRole` is strict 4-role.
- **Admin user-mgmt** calls GoTrue admin REST with the `service_role` key from
  `src/auth/gotrue-admin.ts` (fail-closed; **never log the key**).
- **Env/secrets:** Workers — `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `SUPABASE_JWT_SECRET` (via `wrangler secret put`); web build —
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- **E2E:** `web/playwright.supabase.config.ts` mints a session via the Supabase
  password grant from the gitignored root `.env.test.local` (needs
  `E2E_EMAIL`/`E2E_PASSWORD`, `E2E_SUPABASE_URL`/`E2E_SUPABASE_ANON_KEY`).
- **Spec/plan:** `docs/design/{specs,plans}/2026-06-10-supabase-auth-migration.md`.

**Prod cutover runbook (E1–E9):** see [Supabase Cutover Runbook (E1–E9)](https://www.notion.so/36fef2b9861481d39723d884070e30fa) in Notion.

## WordPress publishing

Always verify `target_label` from the dry-publish endpoint before approving HITL_2.
`WP_TARGET` and `WP_BASE_URL` must be set explicitly per environment.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
