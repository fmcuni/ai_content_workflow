"""Read side of the verbose event log.

A single query helper backs both ``GET /runs/{id}/logs`` and
``GET /topic-batches/{id}/logs`` so the row shape and filtering semantics stay
identical across the two surfaces (and match the Workers-native port).
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.db.models import RunEventLog

DEFAULT_LIMIT = 2000
MAX_LIMIT = 10000

# The only valid values for the ``level`` query filter; mirrors ``derive_level``
# in ``event_log.py`` and the Workers-native port.
VALID_LEVELS: frozenset[str] = frozenset({"info", "thinking", "gate", "error"})


def _row_to_dict(row: RunEventLog) -> dict[str, Any]:
    return {
        "log_id": str(row.log_id),
        "stream_id": str(row.stream_id),
        "stream_kind": row.stream_kind,
        "seq": row.seq,
        "event": row.event,
        "level": row.level,
        "step": row.step,
        "iteration": row.iteration,
        "duration_ms": row.duration_ms,
        "payload": row.payload,
        "recorded_at": row.recorded_at.isoformat(),
    }


async def query_event_logs(
    session: AsyncSession,
    *,
    stream_id: UUID,
    since_seq: int | None = None,
    limit: int = DEFAULT_LIMIT,
    level: str | None = None,
) -> list[dict[str, Any]]:
    """Return event-log rows for one stream ordered by ``seq`` ascending.

    ``since_seq`` returns only rows with ``seq > since_seq``. ``limit`` defaults
    to ``DEFAULT_LIMIT`` and is capped at ``MAX_LIMIT``. ``level`` is an optional
    equality filter.
    """
    capped_limit = max(1, min(limit, MAX_LIMIT))
    stmt = select(RunEventLog).where(RunEventLog.stream_id == stream_id)
    if since_seq is not None:
        stmt = stmt.where(RunEventLog.seq > since_seq)
    if level is not None:
        stmt = stmt.where(RunEventLog.level == level)
    stmt = stmt.order_by(RunEventLog.seq.asc()).limit(capped_limit)

    rows = (await session.execute(stmt)).scalars().all()
    return [_row_to_dict(r) for r in rows]
