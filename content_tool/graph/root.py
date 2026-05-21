from typing import Any
from uuid import UUID

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from sqlalchemy.ext.asyncio import async_sessionmaker

from content_tool.agents.publish import publish_to_wordpress
from content_tool.compliance.log import write_compliance_log
from content_tool.config import get_settings
from content_tool.gemini.client import GeminiClient
from content_tool.graph.production import build_production_graph
from content_tool.graph.strategy import build_strategy_graph
from content_tool.models.state import ContentToolState
from content_tool.observability.cost import CostCalculator
from content_tool.wordpress.client import WordPressClient


def build_root_graph(
    *,
    session_factory: async_sessionmaker,
    gemini: GeminiClient,
    checkpointer: AsyncPostgresSaver,
    wp_client: WordPressClient | None = None,
    seo_plugin: str | None = None,
) -> CompiledStateGraph:
    strategy = build_strategy_graph(session_factory=session_factory, gemini=gemini).compile()
    production = build_production_graph(session_factory=session_factory, gemini=gemini).compile()

    async def n_publish(state: ContentToolState) -> dict[str, Any]:
        if state.get("hitl_2_decision") != "approve":
            return {"status": state.get("status", "rejected")}
        if wp_client is None:
            return {"status": "persisted", "error": {"message": "wp_client not configured"}}

        async with session_factory() as session:
            await publish_to_wordpress(
                session=session,
                run_id=UUID(state["run_id"]),
                wp_client=wp_client,
                seo_plugin=seo_plugin,  # type: ignore[arg-type]
                if_unmodified_since=None,
            )

        settings = get_settings()
        cost_calc = CostCalculator.load_from("config/pricing.yaml")
        async with session_factory() as session:
            await write_compliance_log(
                session=session,
                run_id=UUID(state["run_id"]),
                cost_calc=cost_calc,
                gemini_model=settings.gemini_model,
            )
        return {"status": "published"}

    root = StateGraph(ContentToolState)
    root.add_node("strategy", strategy)
    root.add_node("production", production)
    root.add_node("publish", n_publish)
    root.add_edge(START, "strategy")
    root.add_edge("strategy", "production")
    root.add_edge("production", "publish")
    root.add_edge("publish", END)

    # HITL_1 interrupt is BEFORE production; HITL_2 is BEFORE publish.
    return root.compile(
        checkpointer=checkpointer,
        interrupt_before=["production", "publish"],
    )
