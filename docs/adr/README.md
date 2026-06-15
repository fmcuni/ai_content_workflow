# Architecture Decision Records (ADRs)

This directory holds durable records of significant architectural decisions for
the Bowtie AI Content Tool. ADRs capture the **context, decision, and
consequences** of choices that are expensive to reverse or that future
contributors would otherwise have to reverse-engineer.

- ADRs are immutable once accepted. To change a decision, add a new ADR that
  **supersedes** the old one (and mark the old one accordingly).
- Use the format in [`0001-record-architecture-decisions.md`](0001-record-architecture-decisions.md)
  (Michael Nygard's lightweight template).
- Naming: `NNNN-short-kebab-title.md`, zero-padded sequential.

For feature-level design docs (specs/plans), see `docs/design/` instead — ADRs
are for cross-cutting structural decisions, not per-feature implementation plans.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-cloudflare-workers-ts-port-as-production.md) | Cloudflare Workers TypeScript port as production hosting | Accepted |
