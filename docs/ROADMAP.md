# Roadmap — Bowtie AI Content Tool

**Status:** Brainstorm / living document — not a committed plan.
**Last updated:** 2026-05-27
**Owner:** Franco Ma

> This is a thinking document to align on where the tool goes next. Items are
> proposals, not commitments. Reorder and prune freely. Anything that graduates
> into real work should get a dated design doc under
> `docs/design/specs/` and a plan under `docs/design/plans/`.

---

## Where we are today (baseline)

Grounded in the current repo, not aspiration:

- **Three commissioning fronts** are live: Front I (refresh existing articles),
  Front II (topic expansion → batch → promote), Front III (create new → WP draft).
- **Pipeline:** LangGraph root → `strategy` + `production` subgraphs, plus a
  `topic_expansion` subgraph. Three HITL gates: HITL_1 (after outline),
  HITL_2 (after draft + audit), HITL_T1 (topic batch review).
- **HITL_2 maturity:** reviewer-comments revise loop, WP metadata dropdowns
  (taxonomy cache), prefill from existing post, dry-publish target verification.
- **Editing:** outline + article are editable and re-pushable even for
  finished/filed runs (latest commit `1a11bff`).
- **Voices/personas:** DB-backed, editable in-UI (ComposeDrawer), glossary +
  disclaimer templates.
- **Publishing:** WordPress REST (live + draft), SEO plugin detection.
- **Compliance:** audit log table + `GET /compliance/export.csv`.
- **Cost:** per-run + summary endpoints, hot-reloaded `config/pricing.yaml`.
- **CMS Stage 0:** refresh scanner / inventory / evaluator + `scripts/refresh_scan.py`.
- **Quality:** LLM-judge eval harness (`evals/`), ~61 backend test files,
  Playwright web tests.
- **Stack health:** pyright strict with a large existing baseline (~547 errors);
  ruff gated on changed files; pyright advisory in CI.

### Notable gaps (the "why" behind the roadmap)

- **No authentication / authorization layer** is visible in `api/routes/`.
  For a regulated HK insurer, *who* approved a HITL_2 publish is a compliance
  question, not just a UX one.
- **Refresh is manual-trigger** (`scripts/refresh_scan.py`); no scheduled cadence.
- **Evals exist but don't gate publishing** — quality is observed, not enforced.
- **No post-publish feedback loop** — nothing measures whether refreshed/created
  articles actually performed, so refresh prioritisation is blind.

---

## Themes

The roadmap organises around five themes. Most candidate work maps to one.

1. **Trust & Compliance** — make every regulated action attributable and safe.
2. **Quality & Evals** — turn quality from observed to enforced.
3. **Automation & Scale** — remove manual triggers and per-item bottlenecks.
4. **Feedback & Analytics** — close the loop from publish back to prioritisation.
5. **Content Capability** — broaden what an article can contain (媒體, 繁中, links).

---

## Now (next ~1–2 cycles) — highest leverage

### 1. Authentication, identity & approval attribution — *Trust & Compliance*
The single biggest gap for a regulated insurer. Without it the compliance log
records *what* was published but not *who* signed off.
- Add auth (SSO / Google Workspace is already an org-approved connector).
- Stamp reviewer identity onto HITL_1 / HITL_2 / HITL_T1 approvals and into the
  compliance log.
- Coarse RBAC: who can *approve & publish* vs. who can *draft*.
- **Done when:** every publish in `compliance_log` carries an authenticated
  approver identity; export.csv reflects it.

### 2. Pre-publish safety gate (PII/PHI + disclaimer enforcement) — *Trust & Compliance*
Bowtie data is Confidential (PHI/PII/HKID). Today disclaimer templates exist but
enforcement is advisory.
- Deterministic scan for HKID / policy-number / member-data patterns in draft
  content *before* WP push; block on hit.
- Enforce required disclaimer presence per persona condition (the
  `disclaimer_condition` migration already models this).
- **Done when:** a draft containing a synthetic HKID cannot reach `publish`.

### 3. Eval gating at HITL_2 — *Quality & Evals*
The judge harness exists; wire its score into the gate.
- Surface LLM-judge + deterministic audit scores in the HITL_2 UI.
- Soft gate first (warn), then optional hard floor before publish is enabled.
- **Done when:** reviewers see a quality verdict inline and a configurable floor
  can block approval.

---

## Next (this quarter) — build on the Now foundation

### 4. Scheduled refresh cadence — *Automation & Scale*
Promote CMS Stage 0 from manual script to a scheduled scan that files refresh
candidates automatically, surfaced as a review queue (not auto-published).
- Cron entrypoint already exists; add scheduling + a "candidates" inbox.
- Prioritise by staleness + (eventually) traffic signal (see #8).

### 5. Bulk & queue operations — *Automation & Scale*
- Batch-approve / batch-publish from the ledger.
- Concurrency + rate-limit control for Gemini calls (semaphore pattern already
  used in topic dedup — generalise it).
- Run queue with visible backpressure.

### 6. Prompt regression suite + experimentation — *Quality & Evals*
- Golden-set fixtures per agent (writer, outline, dedup, hot-topic).
- Run evals on prompt changes in CI (PR-label trigger already exists — extend).
- Lightweight A/B harness for prompt variants with cost + quality side-by-side.

### 7. Editorial notifications & routing — *Trust & Compliance / DX*
- Slack (`bowtie-ins`, org-approved) notifications when a run hits a HITL gate.
- Optional multi-reviewer routing for sensitive personas.

---

## Later (opportunistic / bigger bets)

### 8. Post-publish performance feedback loop — *Feedback & Analytics*
Measure whether published/refreshed articles performed (traffic, search
position, engagement) and feed that back into refresh prioritisation.
- Closes the loop: refresh the articles that matter, not just the stale ones.
- Likely needs an analytics source integration; scope carefully re: data rules.

### 9. Cost & ops dashboards — *Feedback & Analytics*
- Budget alerts (HK$ thresholds) on top of existing cost endpoints.
- Ship OTel spans to a dashboard (Jaeger/Grafana) — endpoint hook already exists.
- Run success/failure + recovery metrics.

### 10. 繁體中文 as a first-class content path — *Content Capability*
Bowtie is HK-facing; topic-gen already uses a 繁中 system prompt. Extend
localisation through the whole pipeline (outline, audit, disclaimers, metadata).

### 11. Richer article content — *Content Capability*
- Image / hero-media generation or selection.
- Internal-linking suggestions (link new articles to existing Bowtie content).
- Citation/source-policy quality scoring (source_policy already modelled).

### 12. Multi-target publishing — *Automation & Scale*
Generalise beyond a single `WP_TARGET` if more sites/brands come online.
(Note: never default `WP_TARGET` to staging in docs or config.)

---

## Continuous / cross-cutting (not a milestone)

- **Pyright baseline burn-down** — chip the ~547-error baseline down in touched
  files; never weaken the config to "fix" errors.
- **Test coverage** — keep integration tests hitting real DB (testcontainers),
  not mocks.
- **Spec discipline** — every graduated roadmap item gets a dated spec + plan.

---

## Sequencing rationale (one-paragraph version)

Auth (#1) unblocks real compliance attribution and is a prerequisite for
trustworthy automation later — do it first. The pre-publish safety gate (#2) and
eval gating (#3) are cheap relative to their risk-reduction and reuse machinery
that already exists (disclaimer model, judge harness). Only once approvals are
attributable and quality is enforced does it make sense to *automate* throughput
(#4–#5) and *measure* outcomes (#8) — automating an unguarded pipeline would
scale the risk, not just the output.

---

## Open questions

- Auth: Google Workspace SSO, or an existing Bowtie identity provider?
- Eval gating: hard floor or advisory-only at launch? Who sets the threshold?
- Performance feedback (#8): which analytics source, and does it touch any
  Confidential data we'd need to keep out of external tool calls?
- Scheduled refresh: what cadence, and auto-file vs. auto-draft vs. notify-only?
