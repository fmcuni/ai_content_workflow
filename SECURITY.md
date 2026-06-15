# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue for security problems.**

Report privately via GitHub's
[private vulnerability reporting](https://github.com/fmcuni/ai_content_workflow/security/advisories/new)
("Report a vulnerability" under the repository **Security** tab).

Bowtie staff may also raise the issue with the relevant internal Bowtie
security / IT team via Slack.

Please include:

- A description of the issue and its impact
- Steps to reproduce (or a proof of concept)
- Affected surface: Python backend, Workers backend, or web frontend
- Any relevant logs — **redacted of secrets and any sensitive data**

We aim to acknowledge reports within a few business days. Please give us a
reasonable window to remediate before any public disclosure.

## Scope & data sensitivity

This application handles **public marketing / editorial content only**. By
design, no customer PII, PHI, HKID, health, financial, or other Bowtie private
data passes through the pipeline. Reports about exposure of such data in this
repo are treated as **critical** — do not attach the data itself to your report.

The shared, by-role (not by-owner) run access model is **intentional** and
documented in `CLAUDE.md` ("Run access") — it is an accepted trade-off for an
invite-only editorial ops board over public content, **not** an IDOR bug.
Re-raise it only if the trust model changes (external collaborators, multi-org,
or any private data entering the pipeline).

## Supported versions

Only the `main` branch and the currently deployed production Workers are
supported. Fixes ship forward on `main`; there are no long-lived release
branches.

## Handling secrets

- Never commit secrets, API keys, tokens, or credentials. Runtime secrets are
  set via `wrangler secret put` and Supabase dashboard config.
- If a secret is exposed, **rotate it immediately** and notify the maintainers.
- Automated dependency security updates are enabled (see `.github/dependabot.yml`).
