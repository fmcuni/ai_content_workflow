<!-- Conventional Commit title, e.g. feat(hitl2): ..., fix(runs): ..., chore(deps): ... -->

## Summary

<!-- What does this PR change and why? Link the design doc under docs/design/ if one exists. -->

## Scope

- [ ] Python backend (`content_tool/`)
- [ ] Workers backend (`deploy/cloudflare-workers/`)
- [ ] Frontend (`web/`)
- [ ] DB migration (`supabase/migrations/`)
- [ ] Docs / config only

## Test plan

<!-- How was this verified? Tick what applies and paste key output. -->

- [ ] `ruff check .` + `pyright` (Python)
- [ ] `pytest` (Python)
- [ ] `tsc` + vitest (Workers)
- [ ] `tsc` + eslint + vitest (web)
- [ ] `npx playwright test` (web E2E)
- [ ] Self-verified in **dev** Workers env (claude-debug / browser)

## Deploy / migration notes

<!-- Migration ordering (additive vs non-backward-compat)? Secrets to set?
     Dev + prod both migrated? Anything operators must do post-merge? -->

## Checklist

- [ ] No secrets, credentials, or sensitive data in code, logs, or fixtures
- [ ] Dev and prod kept in sync (migrations applied to both; same commit deployed)
- [ ] CI green before requesting review
