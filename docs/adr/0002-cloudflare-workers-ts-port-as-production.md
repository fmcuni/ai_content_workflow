# 2. Cloudflare Workers TypeScript port as production hosting

Date: 2026-06-16

## Status

Accepted

## Context

The pipeline was originally built as a Python backend (FastAPI + LangGraph +
SQLAlchemy/asyncpg). Production hosting needed low-cost, globally-distributed,
near-zero-maintenance infrastructure with first-class support for long-running,
durable, interruptible workflows (the two HITL gates) and realtime collaboration.

The earlier Worker + Containers stack (`deploy/cloudflare/`, `Dockerfile.cf-*`)
and the Tauri desktop app added operational weight without matching the
serverless model well. Maintaining the full Python runtime in production also
meant managing a long-lived process, connection pooling, and container ops.

## Decision

Production runs a **Workers-native TypeScript port** of the backend
(`deploy/cloudflare-workers/`): Hono for routing, Cloudflare Workflows for the
durable graph, Durable Objects for realtime collab (`RunDoc`), and `postgres.js`
over Hyperdrive to the same Supabase Postgres. The frontend deploys via
`@opennextjs/cloudflare`.

The Python backend (`content_tool/`) is **retained** but is no longer the
production hosting path — it runs the `evals/` suite and supports local dev. A
parity gate (`deploy/cloudflare-workers/parity/check-parity.mjs`) diffs the TS
backend against the Python reference over read-only routes to limit drift.

The old Worker + Containers stack and the Tauri desktop app were retired.

## Consequences

- Two implementations of backend logic must be kept behaviourally in sync; the
  parity gate covers read-only routes but **not** auth-gated or write paths, so
  changes there require manual cross-checking and tests on both sides.
- DB migrations must be applied to **both** dev and prod Supabase projects, and
  the same commit deployed to both environments, to avoid drift.
- Migration deploy-ordering matters: additive (code-reads-new-column) migrations
  go **before** the deploy; non-backward-compatible (re-tokenizing stored bodies)
  go **after**. Split `db push` around the merge when a migration mixes both.
- Production gains serverless scaling, durable workflows, and edge collab; local
  dev keeps the simpler Python path.
