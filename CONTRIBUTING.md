# Contributing — Bowtie AI Content Tool

Internal developer guide. New here? Read [`docs/CODEBASE_GUIDE.md`](docs/CODEBASE_GUIDE.md)
first to understand the two-backend model and the request lifecycle, then come
back here for the day-to-day workflow.

## Data scope (read first)

This app handles **public marketing/editorial content only** — no customer PII,
PHI, HKID, or other Bowtie private data. Even so: **never** commit secrets,
credentials, or `.env*` files, and don't paste them into logs, commit messages,
or external tools. Real runtime secrets live in Cloudflare (`wrangler secret put`)
and in local `.env.local` / `.dev.vars` files that are git-ignored.

## Prerequisites

- Python 3.13 + [uv](https://docs.astral.sh/uv/)
- Node.js (for `web/` and `deploy/cloudflare-workers/`)
- [Supabase CLI](https://supabase.com/docs/guides/cli) (local DB + migrations)

## Local setup

```bash
# Python backend
uv venv && source .venv/bin/activate
uv pip install -e ".[dev]"
cp .env.example .env.local          # fill in GEMINI_API_KEY etc.

# Database (local)
supabase db reset                   # wipe + apply all migrations + seed

# Frontend
cd web && cp .env.local.example .env.local && npm install
```

Run things:

| Task | Command |
|---|---|
| Backend dev | `uvicorn content_tool.api.main:app --reload --port 8000` |
| Web dev | `cd web && npm run dev` → http://localhost:3000 |
| Workers backend dev | `cd deploy/cloudflare-workers && npm run dev` |
| Python tests | `pytest` |
| Web tests | `cd web && npm run test` (unit) / `npx playwright test` (E2E) |
| Lint (py) | `ruff check .` |
| Typecheck (py) | `pyright` |

## The golden rule: keep the two backends in parity

Pipeline logic lives in **both** `content_tool/` (Python, reference) and
`deploy/cloudflare-workers/` (TypeScript, production). When you change behaviour:

1. Change it in **both** backends.
2. Keep canonical JSON serialization **byte-identical** across them — prompt
   assembly is hashed for parity and a serializer drift silently breaks it. The
   parity tests guard this; keep them green.
3. Run the parity checker before deploying:
   ```bash
   node deploy/cloudflare-workers/parity/check-parity.mjs
   ```

Prompts, pricing, personas, and source policy are **shared config/data** (see
`config/`, `prompts/`, and the DB) — change them once, not per backend.

## Database migrations

Supabase migrations under `supabase/migrations/` are **canonical** (the `alembic/`
directory is retired). Schema is `content_tool` (not `public`).

```bash
supabase migration new <name>   # scaffold
supabase db reset               # re-apply all locally
supabase db push                # apply pending to the linked prod project
```

**A schema-dependent code deploy must be preceded by the migration** (push the
migration first, then deploy code that relies on it).

## Code style & quality bars

- **Python:** ruff rules `E,F,I,B,UP,ASYNC,S,ANN,RUF` (line length 100); **pyright
  strict**. Don't weaken the config to fix errors and don't add *new* errors in
  files you touch (the baseline is large). Async everywhere (DB, HTTP, Gemini).
- **Naming:** snake_case modules; PascalCase Pydantic models; tests `test_*.py`.
- **Frontend:** see [`web/AGENTS.md`](web/AGENTS.md) — Next.js 16 has breaking
  changes; consult `web/node_modules/next/dist/docs/` before writing Next code.
- General style lives in the team coding-style rules: small focused files,
  explicit error handling, immutable patterns, no magic numbers.

## Commits & PRs

- **Conventional Commits with scope:** `feat(web):`, `fix(hitl2):`,
  `test(personas):`, `chore(release):`, etc.
- Analyze the full commit history (not just the latest commit) when drafting a PR.
- Include a test plan. Ensure CI is green and the branch is up to date with `main`
  before requesting review.
- New features get a dated design doc under `docs/design/specs/` and a plan
  under `docs/design/plans/`.

## Deployment

Production deploys automatically on push to `main` via
`.github/workflows/deploy-workers.yml` (both Workers). Runtime secrets are set
once via `wrangler secret put` and preserved across deploys — they are **not** in
CI. See [`deploy/cloudflare-workers/README.md`](deploy/cloudflare-workers/README.md).

## WordPress publishing safety

`WP_TARGET` and `WP_BASE_URL` must be set explicitly per environment. Before
approving HITL_2, **verify `target_label`** from the dry-publish endpoint matches
the environment you intend to publish to.
