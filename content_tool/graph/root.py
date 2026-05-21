from typing import Any

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from sqlalchemy.ext.asyncio import async_sessionmaker

from content_tool.gemini.client import GeminiClient
from content_tool.graph.strategy import build_strategy_graph
from content_tool.models.state import ContentToolState


def build_root_graph(
    *,
    session_factory: async_sessionmaker,
    gemini: GeminiClient,
    checkpointer: AsyncPostgresSaver,
) -> CompiledStateGraph:
    # Strategy is exposed as a subgraph node
    strategy = build_strategy_graph(session_factory=session_factory, gemini=gemini).compile()

    root = StateGraph(ContentToolState)
    root.add_node("strategy", strategy)

    # Production is added in Plan 3; for now we END after HITL_1 ack.
    async def n_hitl_2_placeholder(state: ContentToolState) -> dict[str, Any]:
        return {"status": "hitl_2"}

    root.add_node("post_hitl_1", n_hitl_2_placeholder)

    root.add_edge(START, "strategy")
    root.add_edge("strategy", "post_hitl_1")
    root.add_edge("post_hitl_1", END)

    # HITL_1 interrupts BEFORE post_hitl_1 (i.e. after strategy completes).
    return root.compile(checkpointer=checkpointer, interrupt_before=["post_hitl_1"])
