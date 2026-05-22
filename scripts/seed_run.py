"""Smoke-test the run pipeline without going through fetch_article.

The live Bowtie blog is fronted by AWS WAF (returns HTTP 202 challenge to
programmatic clients), so fetch_article cannot resolve the post id from a
dev machine until the WAF allowlist is in place. This script bypasses that:

  1. Inserts a `runs` row with the supplied params.
  2. Inserts a stub `fetched_articles` row so the now-defensive fetch_article
     short-circuits and uses the stub markdown.
  3. Builds the root LangGraph directly and runs it. The graph should
     proceed through gap_analysis -> outline -> HITL_1 interrupt (the root
     graph has `interrupt_before=["production", "publish"]`).
  4. Prints node-done events and the post-interrupt next-nodes.

Usage:
  uv run python scripts/seed_run.py
"""
from __future__ import annotations

import asyncio
import json
from datetime import date
from typing import Any
from uuid import uuid4

from content_tool.config import get_settings
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.db.models import FetchedArticle, Run
from content_tool.gemini.client import RealGeminiClient
from content_tool.graph.checkpointer import make_checkpointer
from content_tool.graph.root import build_root_graph

ARTICLE_URL = (
    "https://www.bowtie.com.hk/blog/zh/%e8%80%81%e4%ba%ba%e5%81%a5%e5%ba%b7/"
    "%e8%80%81%e4%ba%ba%e7%99%a1%e5%91%86-%e8%aa%8d%e7%9f%a5%e9%9a%9c%e7%a4%99%e7%97%87/"
)
TOPIC = "認知障礙"
KEYWORDS = ["認知障礙", "腦退化症", "癡呆症", "阿茲海默症", "記憶力衰退"]
EDIT_NOTE = "-/-"
ACF_ADV_ID = 44663
ACF_WIDGET_ID = 66816

# Placeholder markdown — the gap-analysis LLM call will critique this as a
# very thin article and propose a comprehensive rewrite. Good enough to
# exercise the graph end-to-end.
ARTICLE_MARKDOWN_STUB = """# 老人癡呆 / 認知障礙症

認知障礙症（俗稱腦退化症或老人癡呆症）是一種腦部退化疾病，常見於長者。

## 常見症狀
- 記憶力衰退
- 表達及理解困難
- 判斷力下降

## 阿茲海默症
阿茲海默症是認知障礙症最常見的成因之一，佔病例約六至七成。

## 預防
保持腦部活動、健康飲食、適量運動及社交活動有助降低風險。
"""


def _initial_state(run_id: str, today: date) -> dict[str, Any]:
    return {
        "run_id": run_id,
        "article_url": ARTICLE_URL,
        "topic": TOPIC,
        "keywords": KEYWORDS,
        "mode": "auto",
        "edit_note": EDIT_NOTE,
        "acf_adv_id": ACF_ADV_ID,
        "acf_widget_id": ACF_WIDGET_ID,
        "persona": "bowtie-editor",
        "topic_category": None,
        "today_date": today.isoformat(),
        "existing_article_markdown": None,  # fetch_article short-circuit fills it
        "wp_post_id": None,
        "wp_categories": None,
        "gap_analysis": None,
        "outline": None,
        "chosen_route": None,
        "writer_output": None,
        "grounding_chunks": None,
        "citations": None,
        "render": None,
        "final_markup": None,
        "audit_findings": None,
        "iteration": 0,
        "hitl_1_decision": None,
        "hitl_1_edits": None,
        "hitl_2_decision": None,
        "hitl_2_notes": None,
        "status": "pending",
        "error": None,
    }


async def main() -> None:
    settings = get_settings()
    engine = make_engine(settings.postgres_url)
    sf = make_session_factory(engine)
    gemini = RealGeminiClient(
        api_key=settings.gemini_api_key,
        model=settings.gemini_model,
        thinking_level=settings.gemini_thinking_level,
    )

    run_id = uuid4()
    today = date.today()
    print(f"run_id: {run_id}")

    # 1) Seed DB — commit Run first so the FK on FetchedArticle resolves.
    async with sf() as session:
        session.add(
            Run(
                run_id=run_id,
                created_by="seed@local",
                status="pending",
                article_url=ARTICLE_URL,
                topic=TOPIC,
                keywords=KEYWORDS,
                mode="auto",
                edit_note=EDIT_NOTE,
                acf_adv_id=ACF_ADV_ID,
                acf_widget_id=ACF_WIDGET_ID,
                persona="bowtie-editor",
                today_date=today,
            )
        )
        await session.commit()

    async with sf() as session:
        session.add(
            FetchedArticle(
                run_id=run_id,
                wp_post_id=999999,
                wp_categories=[
                    {"id": 1, "name": "老人健康", "slug": "senior-health"}
                ],
                raw_html="<article>" + ARTICLE_MARKDOWN_STUB + "</article>",
                markdown=ARTICLE_MARKDOWN_STUB,
            )
        )
        await session.commit()

    print("seeded runs + fetched_articles\n")

    # 2) Build graph + run to HITL_1 interrupt
    try:
        async with make_checkpointer(settings.postgres_url) as cp:
            graph = build_root_graph(
                session_factory=sf,
                gemini=gemini,
                checkpointer=cp,
                wp_client=None,
                seo_plugin=None,
            )
            config = {"configurable": {"thread_id": str(run_id)}}
            initial = _initial_state(str(run_id), today)

            print("--- graph events ---")
            async for chunk in graph.astream(
                initial, config=config, stream_mode="updates"
            ):
                for node, payload in chunk.items():
                    keys = (
                        list(payload.keys())[:6]
                        if isinstance(payload, dict)
                        else type(payload).__name__
                    )
                    print(f"  node done: {node}  keys={keys}")

            state = await graph.aget_state(config)
            print()
            if state.next:
                print(f"INTERRUPTED. Next pending: {list(state.next)}")
                snap = {
                    "chosen_route": state.values.get("chosen_route"),
                    "gap_analysis_keys": list(
                        (state.values.get("gap_analysis") or {}).keys()
                    )[:8],
                    "outline_keys": list(
                        (state.values.get("outline") or {}).keys()
                    )[:8],
                }
                print(json.dumps(snap, ensure_ascii=False, indent=2))
                print(
                    f"\nTo approve HITL_1 and continue:\n"
                    f"  curl -X POST http://127.0.0.1:8000/runs/{run_id}/resume "
                    f"-H 'content-type: application/json' -d '{{\"decision\":\"approve\"}}'"
                )
            else:
                print("GRAPH COMPLETED without interrupt (unexpected).")
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
