from datetime import date
from typing import Any
from uuid import UUID

from langgraph.graph import END, START, StateGraph
from sqlalchemy.ext.asyncio import async_sessionmaker

from content_tool.agents.fetch_article import fetch_article
from content_tool.agents.gap_analysis import run_gap_analysis
from content_tool.agents.outline import run_outline
from content_tool.gemini.client import GeminiClient
from content_tool.models.state import ContentToolState


def build_strategy_graph(
    *,
    session_factory: async_sessionmaker,
    gemini: GeminiClient,
) -> StateGraph:
    async def n_fetch_article(state: ContentToolState) -> dict[str, Any]:
        async with session_factory() as session:
            result = await fetch_article(
                session=session,
                run_id=UUID(state["run_id"]),
                article_url=state["article_url"],
            )
        return {
            "existing_article_markdown": result["markdown"],
            "wp_post_id": result["wp_post_id"],
            "wp_categories": result["wp_categories"],
            "status": "strategy",
        }

    async def n_gap_analysis(state: ContentToolState) -> dict[str, Any]:
        async with session_factory() as session:
            ga = await run_gap_analysis(
                session=session,
                gemini=gemini,
                run_id=UUID(state["run_id"]),
                today=date.fromisoformat(state["today_date"]),
            )
        return {"gap_analysis": ga.model_dump(), "chosen_route": ga.chosen_route}

    async def n_outline(state: ContentToolState) -> dict[str, Any]:
        async with session_factory() as session:
            o = await run_outline(
                session=session,
                gemini=gemini,
                run_id=UUID(state["run_id"]),
                today=date.fromisoformat(state["today_date"]),
            )
        return {"outline": o.model_dump()}

    def route_entry(state: ContentToolState) -> str:
        # Task 4: create-mode runs (Front III + Front II promotions) skip
        # fetch_article + gap_analysis entirely — there is no upstream article
        # to fetch and no gap to analyse. Refresh-mode behaviour (start_mode
        # missing, None, or "refresh") keeps today's path.
        if state.get("start_mode") == "create":
            return "outline"
        return "fetch_article"

    g = StateGraph(ContentToolState)
    g.add_node("fetch_article", n_fetch_article)
    g.add_node("gap_analysis", n_gap_analysis)
    g.add_node("outline", n_outline)
    g.add_conditional_edges(
        START,
        route_entry,
        {"fetch_article": "fetch_article", "outline": "outline"},
    )
    g.add_edge("fetch_article", "gap_analysis")
    g.add_edge("gap_analysis", "outline")
    g.add_edge("outline", END)
    return g
