"""Hand-written metadata describing the LangGraph topologies for UI rendering.

The topology only changes via code review (graph/*.py), so we encode it as a
constant rather than introspecting at runtime. There are three entry modes,
each with its own node set / prompts:

- ``refresh``  — rewrite an existing article (fetch + gap analysis + outline).
- ``create``   — author a brand-new article (enters at outline; publishes a
  WordPress *draft*).
- ``topic_expansion`` — Front II "Expand Topics" batch subgraph
  (topic_gen → fan-out dedup + hot-topic → HITL_T1 review).
"""

# ---------------------------------------------------------------------------
# Production sub-graph — shared by refresh and create. Only the writer and
# publish descriptions differ between the two modes (handled per-mode below).
# ---------------------------------------------------------------------------
_PRODUCTION_TAIL: list[dict] = [
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
        "description": (
            "Reviews the rendered HTML against the persona's voice rules "
            "and compliance constraints."
        ),
    },
]

# Production-side edges + gates are identical for refresh and create.
_PRODUCTION_EDGES: list[dict] = [
    {"from": "outline", "to": "writer", "label": "Outline review"},
    {"from": "writer", "to": "resolve_citations"},
    {"from": "resolve_citations", "to": "render_html"},
    {"from": "render_html", "to": "audit"},
    {"from": "audit", "to": "writer", "label": "internal refine ≤2"},
    {"from": "audit", "to": "publish", "label": "Draft review · approve"},
    {"from": "audit", "to": "writer", "label": "Draft review · request changes ≤3"},
]

_PRODUCTION_GATES: list[dict] = [
    {
        "id": "HITL_1",
        "before": "writer",
        "label": "Gate · Outline review",
        "description": "Editor reviews the outline and route choice.",
    },
    {
        "id": "HITL_2",
        "before": "publish",
        "label": "Gate · Draft review",
        "description": (
            "Editor reviews the rendered draft; may approve, request changes "
            "(up to 3 rounds), or reject."
        ),
    },
]


_REFRESH_GRAPH: dict = {
    "mode": "refresh",
    "label": "Rewrite",
    "summary": (
        "Refresh an existing article: fetch the live post, diff it against fresh "
        "search results, then rewrite and re-publish."
    ),
    "nodes": [
        # Strategy sub-graph
        {
            "id": "fetch_article",
            "sub_graph": "strategy",
            "order": 1,
            "kind": "deterministic",
            "uses_persona": False,
            "system_prompt_template_id": None,
            "description": (
                "Pulls the existing WordPress post by URL and stores raw HTML + markdown."
            ),
        },
        {
            "id": "gap_analysis",
            "sub_graph": "strategy",
            "order": 2,
            "kind": "llm",
            "uses_persona": False,
            "system_prompt_template_id": "gap_analysis",
            "description": (
                "Picks small_refresh vs full_rewrite by comparing the article "
                "to fresh search results."
            ),
        },
        {
            "id": "outline",
            "sub_graph": "strategy",
            "order": 3,
            "kind": "llm",
            "uses_persona": False,
            "system_prompt_template_id": "outline_rewrite_mode",
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
            "alt_template_ids": ["writer_full_rewrite"],
            "description": (
                "Writes the full Markdown draft in the persona's voice. Two templates: "
                "small_refresh and full_rewrite, chosen by gap analysis."
            ),
        },
        *_PRODUCTION_TAIL,
        # Publish — sits outside the two sub-graphs, after HITL_2
        {
            "id": "publish",
            "sub_graph": "publish",
            "order": 1,
            "kind": "deterministic",
            "uses_persona": False,
            "system_prompt_template_id": None,
            "description": "Pushes the approved draft live to WordPress via REST.",
        },
    ],
    "edges": [
        {"from": "fetch_article", "to": "gap_analysis"},
        {"from": "gap_analysis", "to": "outline"},
        *_PRODUCTION_EDGES,
    ],
    "gates": _PRODUCTION_GATES,
}


_CREATE_GRAPH: dict = {
    "mode": "create",
    "label": "Create",
    "summary": (
        "Author a brand-new article from a brief: skip fetch + gap analysis, "
        "enter at outline, and publish to WordPress as a draft."
    ),
    "nodes": [
        # Strategy sub-graph — create-mode skips fetch_article + gap_analysis.
        {
            "id": "outline",
            "sub_graph": "strategy",
            "order": 1,
            "kind": "llm",
            "uses_persona": False,
            "system_prompt_template_id": "outline_create_mode",
            "alt_template_ids": ["outline_rewrite_mode"],
            "description": (
                "Builds the outline straight from the operator's brief (topic + keywords). "
                "The create-mode block is prepended to the base outline template at runtime."
            ),
        },
        # Production sub-graph
        {
            "id": "writer",
            "sub_graph": "production",
            "order": 1,
            "kind": "llm",
            "uses_persona": True,
            "system_prompt_template_id": "writer_create",
            "description": (
                "Writes a brand-new Markdown draft in the persona's voice using the "
                "create-mode template. Create-mode always uses this template — there is "
                "no existing article to small_refresh / full_rewrite."
            ),
        },
        *_PRODUCTION_TAIL,
        {
            "id": "publish",
            "sub_graph": "publish",
            "order": 1,
            "kind": "deterministic",
            "uses_persona": False,
            "system_prompt_template_id": None,
            "description": (
                "Pushes the new article to WordPress as a DRAFT (not live); the draft URL "
                "is backfilled onto the run."
            ),
        },
    ],
    "edges": _PRODUCTION_EDGES,
    "gates": _PRODUCTION_GATES,
}


_TOPIC_EXPANSION_GRAPH: dict = {
    "mode": "topic_expansion",
    "label": "Topic Expansion",
    "summary": (
        "Front II batch: generate pillar-topic candidates from a brief, then fan out per "
        "candidate to check duplication and hotness before the operator reviews."
    ),
    "nodes": [
        {
            "id": "topic_gen",
            "sub_graph": "generate",
            "order": 1,
            "kind": "llm",
            "uses_persona": False,
            "system_prompt_template_id": "topic_gen",
            "description": (
                "Generates pillar-topic candidates with focus keywords from the research brief."
            ),
        },
        {
            "id": "fan_out",
            "sub_graph": "analyse",
            "order": 1,
            "kind": "deterministic",
            "uses_persona": False,
            "system_prompt_template_id": None,
            "description": (
                "Inserts one candidate row per generated topic and fans out N parallel "
                "analyses (max 5 concurrent)."
            ),
        },
        {
            "id": "topic_dedup",
            "sub_graph": "analyse",
            "order": 2,
            "kind": "llm",
            "uses_persona": False,
            "system_prompt_template_id": "topic_dedup",
            "description": (
                "Checks site:bowtie.com.hk/blog to flag topics already covered. Runs once "
                "per candidate, in parallel with topic_hot."
            ),
        },
        {
            "id": "topic_hot",
            "sub_graph": "analyse",
            "order": 3,
            "kind": "llm",
            "uses_persona": False,
            "system_prompt_template_id": "topic_hot",
            "description": (
                "Inspects the HK SERP to decide whether the topic is currently a hot topic. "
                "Runs once per candidate, in parallel with topic_dedup."
            ),
        },
        {
            "id": "aggregate",
            "sub_graph": "analyse",
            "order": 4,
            "kind": "deterministic",
            "uses_persona": False,
            "system_prompt_template_id": None,
            "description": (
                "Waits for all candidates to settle, then flips the batch to ready_for_review."
            ),
        },
    ],
    "edges": [
        {"from": "topic_gen", "to": "fan_out"},
        {"from": "fan_out", "to": "topic_dedup", "label": "Send · per candidate"},
        {"from": "fan_out", "to": "topic_hot", "label": "Send · per candidate"},
        {"from": "topic_dedup", "to": "aggregate"},
        {"from": "topic_hot", "to": "aggregate"},
    ],
    "gates": [
        {
            "id": "HITL_T1",
            "before": "__end__",
            "label": "Gate · Topic review",
            "description": (
                "Batch completes; the operator reviews candidates via the API and promotes "
                "the chosen topics to runs."
            ),
        },
    ],
}


PROMPT_GRAPHS: dict[str, dict] = {
    "refresh": _REFRESH_GRAPH,
    "create": _CREATE_GRAPH,
    "topic_expansion": _TOPIC_EXPANSION_GRAPH,
}

# Back-compat: callers that imported the single refresh topology still work.
PROMPT_GRAPH: dict = _REFRESH_GRAPH
