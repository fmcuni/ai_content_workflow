"""Production subgraph — the drafting + audit phase of a run.

Turns the approved outline into a rendered, audited draft (writer → citation
resolution → HTML render → audit, with an internal refine loop), then runs up to
the HITL_2 gate where the editor approves, publishes, or requests changes.
"""

from datetime import date
from typing import Any
from uuid import UUID

from langgraph.graph import END, START, StateGraph
from sqlalchemy.ext.asyncio import async_sessionmaker

from content_tool.agents.audit import run_audit
from content_tool.agents.render_html import run_render_html
from content_tool.agents.resolve_citations import run_resolve_citations
from content_tool.agents.writer import run_writer
from content_tool.gemini.client import GeminiClient
from content_tool.models.state import ContentToolState
from content_tool.observability.event_log import logged_node

MAX_ITERATIONS = 2


def build_production_graph(
    *,
    session_factory: async_sessionmaker,
    gemini: GeminiClient,
) -> StateGraph:
    async def n_writer(state: ContentToolState) -> dict[str, Any]:
        # Build refine_notes from prior audit (if internal-loop iteration > 0)
        # AND from reviewer feedback at the HITL2 gate (if hitl_2_iteration > 0).
        refine_notes_list: list[dict] = []
        if state["iteration"] > 0 and state["audit_findings"]:
            findings = state["audit_findings"].get("findings", [])
            refine_notes_list.extend(
                f for f in findings if f.get("must_fix") or f.get("severity") == "high"
            )
        if state.get("hitl_2_iteration", 0) > 0:
            for c in state.get("hitl_2_comments") or []:
                refine_notes_list.append({
                    "source": "reviewer",
                    "severity": "high",
                    "must_fix": True,
                    "issue": f'On span "{c["anchor_text"]}": {c["body"]}',
                })
            if state.get("hitl_2_notes"):
                refine_notes_list.append({
                    "source": "reviewer-overall",
                    "severity": "high",
                    "must_fix": True,
                    "issue": f"Overall reviewer note: {state['hitl_2_notes']}",
                })
        refine_notes: list[dict] | None = refine_notes_list or None
        async with session_factory() as session:
            result = await run_writer(
                session=session,
                gemini=gemini,
                run_id=UUID(state["run_id"]),
                iteration=state["iteration"],
                today=date.fromisoformat(state["today_date"]),
                refine_notes=refine_notes,
            )
        return {
            "writer_output": {
                "draft_id": str(result.draft_id),
                "diagnose": result.diagnose,
                "markup_raw": result.markup_raw,
                "citation_intents": result.citation_intents,
            },
            "grounding_chunks": result.grounding_chunks,
        }

    async def n_resolve_citations(state: ContentToolState) -> dict[str, Any]:
        async with session_factory() as session:
            r = await run_resolve_citations(
                session=session,
                draft_id=UUID(state["writer_output"]["draft_id"]),
                topic_category=state["topic_category"],
            )
        return {"final_markup": r["final_markup"]}

    async def n_render_html(state: ContentToolState) -> dict[str, Any]:
        async with session_factory() as session:
            result = await run_render_html(
                session=session,
                draft_id=UUID(state["writer_output"]["draft_id"]),
            )
        return {
            "render": {
                "seo_title": result.seo_title,
                "meta_description": result.meta_description,
                "html_body": result.html_body,
                "faq_schema_jsonld": result.faq_schema_jsonld,
                "schema_jsonld": result.schema_jsonld,
                "excerpt_suggestion": result.excerpt_suggestion,
            }
        }

    async def n_audit(state: ContentToolState) -> dict[str, Any]:
        async with session_factory() as session:
            a = await run_audit(
                session=session,
                gemini=gemini,
                draft_id=UUID(state["writer_output"]["draft_id"]),
                topic_category=state["topic_category"],
                today=date.fromisoformat(state["today_date"]),
            )
        return {
            "audit_findings": {
                "overall_pass": a.overall_pass,
                "severity_summary": a.severity_summary.model_dump(),
                "findings": [f.model_dump() for f in a.findings],
            }
        }

    def route_after_audit(state: ContentToolState) -> str:
        af = state["audit_findings"]
        if not af or af["overall_pass"]:
            return END
        if state["iteration"] >= MAX_ITERATIONS - 1:
            return END
        return "writer"

    async def n_increment_iteration(state: ContentToolState) -> dict[str, int]:
        return {"iteration": state["iteration"] + 1}

    g = StateGraph(ContentToolState)
    g.add_node("writer", logged_node("production", "writer", n_writer))
    g.add_node(
        "resolve_citations",
        logged_node("production", "resolve_citations", n_resolve_citations),
    )
    g.add_node("render_html", logged_node("production", "render_html", n_render_html))
    g.add_node("audit", logged_node("production", "audit", n_audit))
    g.add_node("bump", n_increment_iteration)

    g.add_edge(START, "writer")
    g.add_edge("writer", "resolve_citations")
    g.add_edge("resolve_citations", "render_html")
    g.add_edge("render_html", "audit")
    g.add_conditional_edges("audit", route_after_audit, {"writer": "bump", END: END})
    g.add_edge("bump", "writer")
    return g
