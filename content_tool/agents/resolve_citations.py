from typing import Any
from uuid import UUID

import httpx
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool import source_policy_store
from content_tool.agents.url_resolver import UrlResolver
from content_tool.db.models import Citation, Draft, Run

# Simplified- vs Traditional-only character sets used to pick the script of the
# auto-generated sources heading so it matches the article's voice (e.g. a zh-MY
# voice writes Simplified Chinese). Deliberately small but high-frequency — any
# real article hits many. MUST stay in sync with the Workers port
# (citations.ts). Default is Traditional, so existing voices stay byte-identical.
_SIMPLIFIED_CHARS = frozenset("这个为与会时国说后应医险来们对现实样关开点岁费资讯问题卫营见")
_TRADITIONAL_CHARS = frozenset("這個為與會時國說後應醫險來們對現實樣關開點歲費資訊問題衛營見")


def _sources_heading_for(markup: str) -> str:
    """Pick the sources heading whose Chinese script matches ``markup``."""
    simplified = sum(ch in _SIMPLIFIED_CHARS for ch in markup)
    traditional = sum(ch in _TRADITIONAL_CHARS for ch in markup)
    return "资讯来源" if simplified > traditional else "資訊來源"


def _build_sources_md(allowed: list[tuple[str, str]], heading: str = "資訊來源") -> str:
    """allowed = [(domain, final_url), ...] in display order."""
    if not allowed:
        return ""
    lines = ["", f"## {heading}"]
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
    # Evaluate citation domains against the run's voice policy, matching the
    # per-voice {source_policy_block} the writer was given for this run.
    voice_slug = (
        await session.execute(
            select(Run.persona).where(Run.run_id == draft.run_id)
        )
    ).scalar_one()
    policy = await source_policy_store.get_policy(voice_slug=voice_slug, session=session)
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

    markup_raw = draft.markup_raw or ""
    sources_md = _build_sources_md(
        allowed_for_display, heading=_sources_heading_for(markup_raw)
    )
    final_markup = markup_raw.rstrip() + "\n" + sources_md

    await session.execute(
        update(Draft).where(Draft.draft_id == draft_id).values(final_markup=final_markup)
    )
    await session.commit()

    return {"final_markup": final_markup, "displayed_count": len(allowed_for_display)}
