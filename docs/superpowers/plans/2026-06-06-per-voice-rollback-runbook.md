# Rollback Runbook — Per-Voice Prompt Library & Source Policy

**Date:** 2026-06-06
**Feature:** `feat/per-voice-prompt-library` (PR #9) — shipped to prod 2026-06-05.
**Spec/Plan:** `docs/superpowers/specs|plans/2026-06-05-per-voice-prompt-library.md`

> Current prod status: **healthy** (backend & web `/health` 200; smoke green).
> This runbook is precautionary.

---

## 0. The one thing to understand first: code ↔ schema are COUPLED

The prod DB schema was migrated **before** the code was deployed (ordering
invariant). The new schema is **incompatible with the pre-feature code**:

| Table | Old code expects | New schema has |
|---|---|---|
| `source_policy` | singleton PK `policy_id='default'` | PK `voice_slug`; **`policy_id` dropped** |
| `prompt_templates` | PK `template_id` | PK `(voice_slug, template_id)` |

**Consequence:** you **cannot** roll the backend Worker back to the pre-feature
version on its own — it would query `source_policy.policy_id` (gone) and break
prompt assembly. A backend rollback **requires** a matching schema down-migration.

➡️ **Default strategy: FIX-FORWARD.** Patch + redeploy a new version. Reserve the
destructive full rollback (§3) for a true emergency.

---

## 1. Rollback handles (version IDs, fmc account, `npx wrangler`)

| Worker | CURRENT (per-voice) | PRIOR (pre-feature) |
|---|---|---|
| `bowtie-content-tool-poc` (backend) | `9652f960-469e-49b2-ba83-821d10ae44d6` (2026-06-05) | `119deb6c-0c6e-4f67-96eb-e057589c9d7b` (2026-06-04) |
| `bowtie-content-tool-web` (web) | `80eaa002-c6da-4ff8-9a60-6ec59c17b28a` (2026-06-05) | `683cc0d1-253b-46b8-b2e4-1c2e1a5d41d9` (2026-06-04) |

Prod migrations applied (revert targets): `20260604172254`, `20260605000001`.

---

## 2. Web-only rollback (SAFE, FAST — use if the bug is purely in the new UI)

The **new backend tolerates requests without `?voice=`** (routes default to
`bowtie-editor`), so the pre-feature web Worker works against the new backend.

```bash
cd deploy/cloudflare-workers   # any dir; --name targets the worker
npx wrangler rollback 683cc0d1-253b-46b8-b2e4-1c2e1a5d41d9 \
  --name bowtie-content-tool-web --message "rollback web to pre per-voice"
```
Verify: `curl -s -o /dev/null -w '%{http_code}\n' https://bowtie-content-tool-web.fmc.workers.dev/login` → 200, and log in. Leave the **backend + schema as-is**.

> Do NOT do the inverse (roll back backend, keep new web) — that breaks (§0).

---

## 3. Full rollback (DESTRUCTIVE, LOSSY — emergency only)

Reverts code **and** schema together. **Loses all per-voice data** created since
rollout (per-voice templates, source policies, and their version history). The
`__shared__` seed becomes the singleton again.

**Pre-flight**
- Snapshot prod first (Supabase dashboard → Database → Backups, or take a PITR
  note of the timestamp). A snapshot is the real safety net; this SQL is lossy.
- **Rehearse** `scripts/rollback/per_voice_prompt_library_down.sql` on a branch
  DB / restored clone and confirm the `NOTICE`/assertions before touching prod.
  (Dry-run rehearsed 2026-06-06 on local in a rolled-back txn — runs clean,
  assertions pass; re-rehearse on a prod clone with real per-voice + version data.)

**Steps (order matters — schema down BEFORE code, mirror of the rollout)**
1. Apply the down-migration to prod (atomic; aborts on assertion failure):
   ```bash
   psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 \
     -f scripts/rollback/per_voice_prompt_library_down.sql
   ```
2. Reconcile migration state so future `supabase db push` is consistent:
   ```bash
   supabase migration repair --status reverted 20260605000001
   supabase migration repair --status reverted 20260604172254
   ```
3. Roll back BOTH Workers to the pre-feature versions:
   ```bash
   npx wrangler rollback 119deb6c-0c6e-4f67-96eb-e057589c9d7b \
     --name bowtie-content-tool-poc --message "rollback backend to pre per-voice"
   npx wrangler rollback 683cc0d1-253b-46b8-b2e4-1c2e1a5d41d9 \
     --name bowtie-content-tool-web --message "rollback web to pre per-voice"
   ```
4. Smoke: backend `/health` 200; `GET /api/source-policy` (no voice) 200;
   `GET /api/prompts/templates` 200; log in to web; confirm a refresh run reads
   the source policy block.

---

## 4. Repo / `main` hazard (act on this regardless of rollback)

Prod currently runs code that is **NOT on `main`** (PR #9 is open). Therefore:

- **Do not deploy from `main`** until PR #9 is merged — a `main`-based deploy
  would push **pre-feature code onto the new schema** and break prod exactly as
  in §0. (The bowtie-repo push-to-main CI deploy already fails on missing CF
  secrets, so it won't auto-deploy — but a manual `main` deploy would.)
- **Resolution: merge PR #9** to bring `main` in sync with prod. After merge,
  `main`-based deploys are schema-compatible again.

---

## 5. Post-rollout cleanup (independent of rollback)

- Archived smoke persona `zzz-smoke-pvpl` (+ its voice-scoped template/policy
  rows) remains in prod from the mutating smoke. Harmless (soft-delete, no FK).
  Hard-purge if desired:
  ```sql
  DELETE FROM content_tool.prompt_templates  WHERE voice_slug = 'zzz-smoke-pvpl';
  DELETE FROM content_tool.prompt_versions   WHERE voice_slug = 'zzz-smoke-pvpl';
  DELETE FROM content_tool.source_policy      WHERE voice_slug = 'zzz-smoke-pvpl';
  DELETE FROM content_tool.source_policy_versions WHERE voice_slug = 'zzz-smoke-pvpl';
  DELETE FROM content_tool.personas           WHERE slug = 'zzz-smoke-pvpl';
  ```
