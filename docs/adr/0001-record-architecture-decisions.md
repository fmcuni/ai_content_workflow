# 1. Record architecture decisions

Date: 2026-06-16

## Status

Accepted

## Context

The project has accumulated several structural decisions that are not obvious
from the code alone — the dual backend (Python reference + Workers production
port), Supabase Auth via GoTrue, the intentional by-role run access model, and
migration deploy-ordering rules. These are currently spread across `CLAUDE.md`,
commit messages, and contributors' memory, which makes the *why* behind them
hard to recover.

We need a lightweight, durable place to record decisions that are costly to
reverse, so that future contributors (human or agent) can understand the
reasoning rather than re-litigating settled choices.

## Decision

We will use Architecture Decision Records, as described by Michael Nygard, kept
as Markdown files under `docs/adr/`. Each record is numbered sequentially and is
immutable once accepted; a superseding ADR is added when a decision changes.

Per-feature implementation plans continue to live under `docs/design/`
(specs/plans). ADRs are reserved for cross-cutting, structural decisions.

## Consequences

- The reasoning behind major decisions is preserved in-repo and reviewable.
- Contributors should add an ADR when making a decision that is expensive to
  reverse or that materially shapes the architecture.
- The audit's "Memory Persistence" dimension is satisfied by durable in-repo
  decision history.
