# Rollback runbook — Langfuse observability release (PR #11)

Date: 2026-06-06. Release ships P1–P4 with `LANGFUSE_ENABLED` **off by default**, so the
deploy is behavior-neutral (additive, dormant code). This runbook covers reverting if the
deploy or post-deploy smoke fails.

## Known-good baseline (capture before deploying)

- **Prod backend Worker:** `bowtie-content-tool-poc` (fmc account `0e032244…`, login `fmcuni@gmail.com`)
- **Current ACTIVE prod version (rollback target):** `e398c5df-4f5b-4d90-bdb0-98dbb558772d`
  (deployed 2026-06-06T05:13Z; prior `9652f960-…` = per-voice prompt library release)
- **Code baseline (main HEAD before merge):** `9bf365a`
- Frontend Worker `bowtie-content-tool-web` is **unchanged** by this release — do not redeploy it.

## A. Deploy-time rollback (Worker is broken / smoke fails)

```bash
cd deploy/cloudflare-workers
# Re-point 100% traffic to the last known-good version:
npx wrangler rollback e398c5df-4f5b-4d90-bdb0-98dbb558772d
# Verify:
npx wrangler deployments list | tail -8
curl -s -o /dev/null -w '%{http_code}\n' https://bowtie-content-tool-poc.fmc.workers.dev/health
```

Runtime secrets (`POSTGRES_URL`, `GEMINI_API_KEY`, `WP_*`) are preserved across deploys/rollbacks.

## B. Code rollback (merge already happened, need to undo on main)

```bash
git checkout main && git pull
# Revert the squash-merge commit (replace <merge-sha>):
git revert --no-edit <merge-sha>
git push bowtie main      # NOTE: push-to-main deploy CI fails (missing CF secrets) — deploy manually via A.
```

If the version bump was a separate commit, revert it too.

## C. "Disable, don't roll back" (fastest mitigation if only Langfuse misbehaves)

The integration only acts when `LANGFUSE_ENABLED` is truthy AND keys are present. If a future
enablement misbehaves, simply unset the flag instead of rolling back code:

```bash
cd deploy/cloudflare-workers
npx wrangler secret delete LANGFUSE_ENABLED   # or set it to "false" / leave keys unset
# redeploy current version or rollback per A
```

## Smoke checks (post-deploy)

```bash
B=https://bowtie-content-tool-poc.fmc.workers.dev
curl -s -o /dev/null -w 'health=%{http_code}\n' $B/health
# add a read-only route the parity gate covers, e.g. costs summary, to confirm no regression
```
