from typing import Any
from uuid import UUID

import httpx
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool import source_policy_store
from content_tool.agents.url_resolver import UrlResolver
from content_tool.db.models import Citation, Draft


def _build_sources_md(allowed: list[tuple[str, str]]) -> str:
    """allowed = [(domain, final_url), ...] in display order."""
    if not allowed:
        return ""
    lines = ["", "## 資訊來源"]
    for i, (domain, url) in enumerate(allowed, 1):
        lines.append(f"{i}. [{domain}]({url})")
    return "\n".join(lines) + "\n"


async def run_resolve_citations(
    *,
    session: AsyncSession,
    draft_id: UUID,
    topic_category: str | None,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    draft = (
        await session.execute(select(Draft).where(Draft.draft_id == draft_id))
    ).scalar_one()
    policy = await source_policy_store.get_policy(session=session)
    resolver = UrlResolver(session=session, client=client)

    allowed_for_display: list[tuple[str, str]] = []

    for idx, chunk in enumerate(draft.grounding_chunks or []):
        web = chunk.get("web") or {}
        vertex_uri = web.get("uri")
        title = web.get("title")
        if not vertex_uri:
            continue

        resolved = await resolver.resolve(vertex_uri)
        domain = resolved.domain
        if domain:
            decision = policy.evaluate(domain, topic_category=topic_category)
            decision_value: str = decision.decision
            decision_reason: str | None = decision.reason
        else:
            # Unknown domain (no public suffix etc.): treat as denied.
            decision_value = "denied"
            decision_reason = "unknown_domain"

        was_displayed = (
            decision_value in {"allowed", "community_exception"}
            and resolved.final_url is not None
        )

        session.add(
            Citation(
                draft_id=draft_id,
                chunk_idx=idx,
                vertex_uri=vertex_uri,
                final_url=resolved.final_url,
                domain=domain,
                title=title,
                policy_decision=decision_value,
                denied_reason=decision_reason,
                was_displayed=was_displayed,
                resolution_error=resolved.error,
            )
        )
        if was_displayed and resolved.final_url and domain:
            allowed_for_display.append((domain, resolved.final_url))

    sources_md = _build_sources_md(allowed_for_display)
    final_markup = (draft.markup_raw or "").rstrip() + "\n" + sources_md

    await session.execute(
        update(Draft).where(Draft.draft_id == draft_id).values(final_markup=final_markup)
    )
    await session.commit()

    return {"final_markup": final_markup, "displayed_count": len(allowed_for_display)}
