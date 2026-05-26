"""Hand-written metadata describing the LangGraph topology for UI rendering.

The topology only changes via code review (graph/*.py), so we encode it as
a constant rather than introspecting at runtime.
"""

PROMPT_GRAPH: dict = {
    "nodes": [
        # Strategy sub-graph
        {
            "id": "fetch_article",
            "sub_graph": "strategy",
            "order": 1,
            "kind": "deterministic",
            "uses_persona": False,
            "system_prompt_template_id": None,
            "description": "Pulls the existing WordPress post by URL and stores raw HTML + markdown.",
        },
        {
            "id": "gap_analysis",
            "sub_graph": "strategy",
            "order": 2,
            "kind": "llm",
            "uses_persona": False,
            "system_prompt_template_id": "gap_analysis",
            "description": "Picks small_refresh vs full_rewrite by comparing the article to fresh search results.",
        },
        {
            "id": "outline",
            "sub_graph": "strategy",
            "order": 3,
            "kind": "llm",
            "uses_persona": False,
            "system_prompt_template_id": "outline",
            "description": "Drafts the section-by-section outline the writer will follow.",
        },
        # Production sub-graph
        {
            "id": "writer",
            "sub_graph": "production",
            "order": 1,
            "kind": "llm",
            "uses_persona": True,
            "system_prompt_template_id": "writer_small_refresh",
            "description": "Writes the full Markdown draft (small-refresh path) in the persona's voice.",
        },
        {
            "id": "writer_full_rewrite",
            "sub_graph": "production",
            "order": 1,
            "kind": "llm",
            "uses_persona": False,
            "system_prompt_template_id": "writer_full_rewrite",
            "description": "Alternate template for the writer node (full-rewrite path). Same graph node as writer; template chosen by gap analysis.",
            "graph_node_alias": "writer",
        },
        {
            "id": "resolve_citations",
            "sub_graph": "production",
            "order": 2,
            "kind": "deterministic",
            "uses_persona": False,
            "system_prompt_template_id": None,
            "description": "Resolves citation intents to real URLs and applies the source policy.",
        },
        {
            "id": "render_html",
            "sub_graph": "production",
            "order": 3,
            "kind": "deterministic",
            "uses_persona": False,
            "system_prompt_template_id": None,
            "description": "Converts the resolved Markdown to HTML, plus SEO meta + FAQ JSON-LD.",
        },
        {
            "id": "audit",
            "sub_graph": "production",
            "order": 4,
            "kind": "llm",
            "uses_persona": True,
            "system_prompt_template_id": "audit",
            "description": "Reviews the rendered HTML against the persona's voice rules and compliance constraints.",
        },
        # Publish — sits outside the two sub-graphs, after HITL_2
        {
            "id": "publish",
            "sub_graph": "publish",
            "order": 1,
            "kind": "deterministic",
            "uses_persona": False,
            "system_prompt_template_id": None,
            "description": "Pushes the approved draft to WordPress via REST.",
        },
    ],
    "edges": [
        {"from": "fetch_article", "to": "gap_analysis"},
        {"from": "gap_analysis", "to": "outline"},
        {"from": "outline", "to": "writer", "label": "HITL_1"},
        {"from": "writer", "to": "resolve_citations"},
        {"from": "resolve_citations", "to": "render_html"},
        {"from": "render_html", "to": "audit"},
        {"from": "audit", "to": "writer", "label": "internal refine ≤2"},
        {"from": "audit", "to": "publish", "label": "HITL_2 · approve"},
        {"from": "audit", "to": "writer", "label": "HITL_2 · request_changes ≤3"},
    ],
    "gates": [
        {"id": "HITL_1", "before": "writer",
         "label": "GATE · HITL_1",
         "description": "Editor reviews the outline and route choice."},
        {"id": "HITL_2", "before": "publish",
         "label": "GATE · HITL_2",
         "description": "Editor reviews the rendered draft; may approve, request changes (up to 3 rounds), or reject."},
    ],
}
