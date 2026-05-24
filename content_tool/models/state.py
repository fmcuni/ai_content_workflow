from typing import Any, Literal, TypedDict


class ContentToolState(TypedDict):
    # input
    run_id: str
    article_url: str
    topic: str
    keywords: list[str]
    mode: Literal["auto", "small_refresh", "full_rewrite"]
    edit_note: str | None
    acf_adv_id: int
    acf_widget_id: int
    persona: str
    topic_category: str | None
    today_date: str

    # fetched
    existing_article_markdown: str | None
    wp_post_id: int | None
    wp_categories: list[dict[str, Any]] | None

    # strategy
    gap_analysis: dict[str, Any] | None
    outline: dict[str, Any] | None
    chosen_route: Literal["small_refresh", "full_rewrite"] | None

    # production (filled by Plan 3)
    writer_output: dict[str, Any] | None
    grounding_chunks: list[dict[str, Any]] | None
    citations: list[dict[str, Any]] | None
    render: dict[str, Any] | None
    final_markup: str | None
    audit_findings: dict[str, Any] | None
    iteration: int

    # HITL
    hitl_1_decision: str | None
    hitl_1_edits: dict[str, Any] | None
    hitl_2_decision: str | None
    hitl_2_notes: str | None
    hitl_2_comments: list[dict[str, Any]] | None
    hitl_2_iteration: int

    # lifecycle
    status: str
    error: dict[str, Any] | None
