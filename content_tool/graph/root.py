from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from sqlalchemy.ext.asyncio import async_sessionmaker

from content_tool.gemini.client import GeminiClient
from content_tool.graph.production import build_production_graph
from content_tool.graph.strategy import build_strategy_graph
from content_tool.models.state import ContentToolState


def build_root_graph(
    *,
    session_factory: async_sessionmaker,
    gemini: GeminiClient,
    checkpointer: AsyncPostgresSaver,
) -> CompiledStateGraph:
    strategy = build_strategy_graph(session_factory=session_factory, gemini=gemini).compile()
    production = build_production_graph(session_factory=session_factory, gemini=gemini).compile()

    root = StateGraph(ContentToolState)
    root.add_node("strategy", strategy)
    root.add_node("production", production)

    # HITL_1 interrupt is BEFORE production; HITL_2 is BEFORE persist.
    async def n_persist(state: ContentToolState) -> dict:
        return {"status": "persisted"}

    root.add_node("persist", n_persist)
    root.add_edge(START, "strategy")
    root.add_edge("strategy", "production")
    root.add_edge("production", "persist")
    root.add_edge("persist", END)

    return root.compile(
        checkpointer=checkpointer,
        interrupt_before=["production", "persist"],
    )
