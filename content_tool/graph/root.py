"""Root graph composition.

Wires the ``strategy`` and ``production`` subgraphs into the top-level run graph
and declares the two Human-In-The-Loop interrupts (HITL_1 after the outline,
HITL_2 after the draft). State is checkpointed to Postgres so an interrupted run
can be resumed via ``POST /runs/{id}/resume``.
"""

import logging
from typing import Any
from uuid import UUID

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from sqlalchemy.ext.asyncio import async_sessionmaker

from content_tool.agents.publish import publish_to_wordpress
from content_tool.compliance.log import write_compliance_log
from content_tool.config import config_path, get_settings
from content_tool.gemini.client import GeminiClient
from content_tool.graph.production import build_production_graph
from content_tool.graph.strategy import build_strategy_graph
from content_tool.models.state import ContentToolState
from content_tool.observability.cost import CostCalculator
from content_tool.observability.event_log import logged_node
from content_tool.wordpress.client import WordPressClient

_logger = logging.getLogger(__name__)

MAX_HITL2_ROUNDS = 3


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

    async def n_publish_or_revise(state: ContentToolState) -> dict[str, Any]:
        decision = state.get("hitl_2_decision")

        if decision == "approve":
            if wp_client is None:
                return {"status": "persisted", "error": {"message": "wp_client not configured"}}
            async with session_factory() as session:
                publish_result: dict[str, object] = await publish_to_wordpress(
                    session=session,
                    run_id=UUID(state["run_id"]),
                    wp_client=wp_client,
                    seo_plugin=seo_plugin,  # type: ignore[arg-type]
                    if_unmodified_since=None,
                )
            # The WP post is already published and the run row is committed as
            # "published" by publish_to_wordpress. A failure writing the
            # compliance log must NOT propagate out of this node — that would
            # let LangGraph mark the run "failed" even though publishing
            # succeeded. Log and continue; the audit row can be backfilled.
            try:
                settings = get_settings()
                cost_calc = CostCalculator.load_from(config_path("pricing.yaml"))
                async with session_factory() as session:
                    await write_compliance_log(
                        session=session,
                        run_id=UUID(state["run_id"]),
                        cost_calc=cost_calc,
                        gemini_model=settings.gemini_model,
                    )
            except Exception:
                _logger.exception(
                    "compliance log write failed after successful publish (run_id=%s)",
                    state["run_id"],
                )
            # Create-mode: surface the freshly-minted WP draft link on graph
            # state so downstream nodes / SSE subscribers see the URL the
            # publish step backfilled onto the runs row.
            patch: dict[str, Any] = {"status": "published"}
            link = publish_result.get("link")
            if state.get("start_mode") == "create" and isinstance(link, str) and link:
                patch["article_url"] = link
            return patch

        if decision == "reject":
            return {"status": "rejected"}

        # decision == "request_changes"
        if state.get("hitl_2_iteration", 0) >= MAX_HITL2_ROUNDS:
            return {"status": "changes_requested"}  # cap reached, terminal

        # Reset production-internal counters so the audit refine-loop has fresh
        # budget for the next revision round. We keep hitl_2_* fields intact —
        # writer reads them on entry to produce a reviewer-driven draft.
        return {
            "status": "revising",
            "iteration": 0,
            "writer_output": None,
            "render": None,
            "audit_findings": None,
        }

    def route_after_publish_or_revise(state: ContentToolState) -> str:
        return "production_revise" if state.get("status") == "revising" else END

    root = StateGraph(ContentToolState)
    root.add_node("strategy", strategy)
    root.add_node("production", production)
    # "production_revise" is the SAME compiled sub-graph mounted under a second
    # node name. We want HITL_1 to gate only the *initial* entry to production;
    # revision rounds (publish_or_revise → production_revise) must not re-pause.
    root.add_node("production_revise", production)
    root.add_node(
        "publish_or_revise",
        logged_node("publish", "publish_or_revise", n_publish_or_revise),
    )
    root.add_edge(START, "strategy")
    root.add_edge("strategy", "production")
    root.add_edge("production", "publish_or_revise")
    root.add_edge("production_revise", "publish_or_revise")
    root.add_conditional_edges(
        "publish_or_revise",
        route_after_publish_or_revise,
        {"production_revise": "production_revise", END: END},
    )

    # HITL_1 interrupt is BEFORE the initial production node; HITL_2 is BEFORE
    # publish_or_revise. "production_revise" intentionally has no interrupt.
    return root.compile(
        checkpointer=checkpointer,
        interrupt_before=["production", "publish_or_revise"],
    )
