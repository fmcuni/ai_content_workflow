from datetime import datetime
from decimal import Decimal
from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class CreateRunRequest(BaseModel):
    article_url: str | None = None
    topic: str
    keywords: list[str]
    mode: Literal["auto", "small_refresh", "full_rewrite"] = "auto"
    edit_note: str | None = None
    acf_adv_id: int
    acf_widget_id: int
    persona: str = "bowtie-editor"
    topic_category: str | None = None
    editor_email: str = Field(description="Identifies who triggered the run")
    triggered_by_evaluation_id: UUID | None = None
    start_mode: Literal["refresh", "create"] = "refresh"
    topic_candidate_id: UUID | None = None
    target_audience: str | None = None
    # Auto-approve the HITL_1 outline/gap-analysis gate and proceed straight to
    # drafting. HITL_2 (draft -> publish) still waits for a human.
    auto_accept_hitl1: bool = False

    @model_validator(mode="after")
    def _check_article_url_for_start_mode(self) -> Self:
        """refresh mode requires article_url; create mode forbids it (server-generated)."""
        if self.start_mode == "refresh" and not self.article_url:
            raise ValueError("article_url is required when start_mode='refresh'")
        if self.start_mode == "create" and self.article_url:
            raise ValueError(
                "article_url must be absent when start_mode='create' "
                "(server-generated after draft publish)"
            )
        return self


class CreateRunResponse(BaseModel):
    run_id: UUID
    status: str
    created_at: datetime
    article_id: UUID | None = None


class ResumeRequest(BaseModel):
    decision: Literal["approve", "edit_outline", "override_route", "cancel"]
    edited_outline: dict | None = None
    new_route: Literal["small_refresh", "full_rewrite"] | None = None
    notes: str | None = None


class Hitl2Comment(BaseModel):
    id: str
    anchor_text: str = Field(max_length=120)
    body: str


# --- Review threads (human-only highlight discussions) ---------------------
# A SEPARATE pipeline from the AI-edit ``Hitl2Comment``: review threads are
# never dispatched to apply-edits. They support reply + resolve and persist in
# the ``review_threads`` table independently of snapshot versions.


class ReviewMessage(BaseModel):
    id: str
    author_email: str | None = None
    author_name: str | None = None
    body: str
    created_at: datetime


class ReviewThreadOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    thread_id: UUID
    run_id: UUID
    anchor_id: str
    anchor_text: str | None = None
    status: Literal["open", "resolved"]
    messages: list[ReviewMessage]
    created_by: str | None = None
    created_by_name: str | None = None
    created_at: datetime
    resolved_by: str | None = None
    resolved_by_name: str | None = None
    resolved_at: datetime | None = None
    updated_at: datetime


class CreateReviewThreadIn(BaseModel):
    anchor_id: str
    anchor_text: str | None = Field(default=None, max_length=240)
    body: str
    # Author identity (email + display name). The Workers backend overrides the
    # email from the session; the Python sidecar takes both from the body.
    editor_email: str | None = None
    editor_name: str | None = None


class ReviewReplyIn(BaseModel):
    body: str
    editor_email: str | None = None
    editor_name: str | None = None


class ReviewResolveIn(BaseModel):
    resolved: bool
    editor_email: str | None = None
    editor_name: str | None = None


class Hitl2Request(BaseModel):
    decision: Literal["approve", "request_changes", "reject"]
    # Authenticated approver identity (email). In production the Workers backend
    # derives this from the session and ignores the payload; the Python sidecar
    # has no auth layer, so the frontend supplies it here for the audit trail.
    editor_email: str | None = None
    notes: str | None = None
    comments: list[Hitl2Comment] | None = None
    edited_html_body: str | None = None      # if editor tweaked HTML
    edited_seo_title: str | None = None
    edited_meta_description: str | None = None
    wp_publish_status: Literal["draft", "future", "publish"] = "draft"
    wp_author_id: int | None = None
    wp_category_ids: list[int] | None = None
    wp_tag_ids: list[int] | None = None
    wp_featured_media_id: int | None = None
    wp_slug: str | None = None
    wp_excerpt: str | None = None
    wp_publish_at: datetime | None = None


class Hitl2SnapshotIn(BaseModel):
    """Autosave / version-history capture of the HITL_2 reviewer's working state.

    One combined point-in-time snapshot of the editor body, SEO/WP metadata,
    overall notes, and anchored comments. ``trigger`` records what caused the
    save (``interval`` | ``navigate`` | ``unload`` | ``manual``; the synthetic
    ``generated`` baseline is server-written, never client-supplied) for the
    history list.
    """

    trigger: Literal["interval", "navigate", "unload", "manual", "generated"] = "manual"
    # Author of this snapshot (email). See Hitl2Request.editor_email.
    editor_email: str | None = None
    html_body: str
    # Tracked-changes baseline (last committed body). None ⇒ no pending changes.
    committed_html_body: str | None = None
    seo_title: str | None = None
    meta_description: str | None = None
    notes: str | None = None
    comments: list[Hitl2Comment] | None = None
    wp_publish_status: str | None = None
    wp_author_id: int | None = None
    wp_category_ids: list[int] | None = None
    wp_tag_ids: list[int] | None = None
    wp_featured_media_id: int | None = None
    wp_slug: str | None = None
    wp_excerpt: str | None = None
    wp_publish_at: datetime | None = None


class Hitl2SnapshotOut(Hitl2SnapshotIn):
    model_config = ConfigDict(from_attributes=True)

    snapshot_id: UUID
    created_at: datetime
    created_by: str | None = None
    # Stable display number (oldest = 1) and "● Live" flag, set by the list
    # endpoint. Defaulted so the single-row POST response still validates.
    version_number: int | None = None
    is_current: bool = False


class RegenerateRequest(BaseModel):
    """Operator-initiated AI regeneration of a finished run's article.

    Mirrors the HITL_2 ``request_changes`` feedback shape (overall ``notes`` +
    anchored ``comments``) but runs post-hoc on a terminal run: it re-runs the
    writer → resolve_citations → render → audit pipeline at a fresh iteration
    instead of resuming the LangGraph checkpoint. The new draft becomes the
    latest, so the standalone edit / re-push page picks it up.
    """

    notes: str | None = None
    comments: list[Hitl2Comment] | None = None


class ApplyEditsRequest(BaseModel):
    """Inline AI-edit of an article using reviewer feedback.

    Stateless: the agent revises the supplied ``html_body`` per the anchored
    ``comments`` and/or overall ``notes`` and returns the revised HTML — no new
    draft / render iteration, no graph resume. The operator reviews the result in
    the editor, then Saves / Approves through the existing flows.
    """

    # Bounded so an oversized payload fails fast at the boundary instead of
    # blowing the Gemini context window with an opaque upstream error.
    html_body: str = Field(max_length=500_000)
    comments: list[Hitl2Comment] | None = None
    notes: str | None = Field(default=None, max_length=10_000)


class ApplyEditsResponse(BaseModel):
    html_body: str


class OutlineEditRequest(BaseModel):
    """Post-hoc outline edit for a finished run (no graph resume).

    Persists to ``outlines.human_edits`` so the durable record reflects the
    edit. Used by the standalone edit page, not the HITL_1 gate.
    """

    outline: dict
    # Optimistic-concurrency guard. When set, the save is rejected (409) if the
    # stored outline version has moved on since the client loaded it. Omit for
    # the single-user sidecar / backwards compatibility (last-write-wins).
    expected_version: int | None = None


class ArticleEditRequest(BaseModel):
    """Post-hoc article edit for a finished run (no graph resume).

    Writes the body/SEO fields onto the latest Render row and the WP metadata
    onto the Run row, so a subsequent re-push reads the edited content.
    """

    html_body: str
    seo_title: str
    meta_description: str
    # Optimistic-concurrency guard against the latest Render's version. When set,
    # the save is rejected (409) if another reviewer saved since this client
    # loaded the render. Omit for single-user sidecar / backwards compatibility.
    expected_version: int | None = None
    wp_publish_status: Literal["draft", "future", "publish"] | None = None
    wp_author_id: int | None = None
    wp_category_ids: list[int] | None = None
    wp_tag_ids: list[int] | None = None
    wp_featured_media_id: int | None = None
    wp_slug: str | None = None
    wp_excerpt: str | None = None
    wp_publish_at: datetime | None = None


class RunWpMetaPatch(BaseModel):
    """Partial update of a run's editable destination / brief fields.

    Used by the Ledger board's inline cell editors. Only fields explicitly
    provided (non-null) are overwritten, mirroring the ``wp_values`` block in
    ``PUT /article``. Persona/Voice is intentionally absent — it is read-only in
    the board (edit it on the run page). ``acf_adv_id`` / ``acf_widget_id`` only
    affect re-runs / republish, never the already-generated draft.
    """

    acf_adv_id: int | None = None
    acf_widget_id: int | None = None
    wp_author_id: int | None = None
    wp_category_ids: list[int] | None = None
    wp_slug: str | None = None
    wp_publish_status: Literal["draft", "future", "publish"] | None = None
    wp_publish_at: datetime | None = None
    # Optimistic-concurrency guard against the latest Render's version (the run's
    # content version token, shared with PUT /article). When set, the patch is
    # rejected (409 stale_version) if another reviewer saved since this client
    # loaded the render. Omit for last-write-wins.
    expected_version: int | None = None


class TopicBatchDefaultsPatch(BaseModel):
    """Partial update of a topic batch's promotion defaults.

    Editing a default only affects runs promoted **after** the change, never an
    already-generated draft/run. Only fields present in the request are applied
    (so a default can be cleared to null or toggled false).
    """

    persona_default: str | None = None
    acf_adv_id_default: int | None = None
    acf_widget_id_default: int | None = None
    auto_accept_hitl1_default: bool | None = None


class RepublishResponse(BaseModel):
    wp_post_id: int
    link: str | None = None
    status: str


class DryPublishRequest(BaseModel):
    """Optional in-progress edits from the HITL2 reviewer.

    When fields are set, they override the persisted Render / Run values
    so the preview reflects unsaved edits.
    """

    edited_html_body: str | None = None
    edited_seo_title: str | None = None
    edited_meta_description: str | None = None
    wp_publish_status: Literal["draft", "future", "publish"] | None = None
    wp_author_id: int | None = None
    wp_category_ids: list[int] | None = None
    wp_tag_ids: list[int] | None = None
    wp_featured_media_id: int | None = None
    wp_slug: str | None = None
    wp_excerpt: str | None = None
    wp_publish_at: datetime | None = None


class DryPublishResponse(BaseModel):
    target_base_url: str
    target_label: str                    # staging | production
    request_method: Literal["PUT", "POST"]
    request_url: str
    request_headers: dict[str, str]
    request_body: dict


class ExistingPostOut(BaseModel):
    wp_post_id: int
    link: str | None = None
    wp_author_id: int | None = None
    wp_author_name: str | None = None
    wp_category_id: int | None = None
    wp_category_name: str | None = None
    wp_slug: str | None = None


class RefreshEvaluationOut(BaseModel):
    evaluation_id: UUID
    evaluated_at: datetime
    age_days: int
    staleness_score: Decimal
    recommended_action: Literal["refresh", "monitor", "ok"]
    deterministic_findings: dict
    llm_findings: dict | None = None
    llm_skipped_reason: str | None = None
    outcome: Literal["open", "triggered", "dismissed", "superseded"]
    resulting_run_id: UUID | None = None


class ArticleOut(BaseModel):
    article_id: UUID
    article_url: str
    wp_post_id: int | None = None
    topic: str | None = None
    persona: str | None = None
    topic_category: str | None = None
    first_seen_at: datetime
    last_persisted_at: datetime | None = None
    next_scan_due_at: datetime
    dismissed_until: datetime | None = None
    latest_evaluation: RefreshEvaluationOut | None = None
    open_runs_count: int = 0


class ArticleListResponse(BaseModel):
    items: list[ArticleOut]
    total: int


class ArticleDetailOut(ArticleOut):
    recent_evaluations: list[RefreshEvaluationOut] = Field(default_factory=list)
    recent_run_ids: list[UUID] = Field(default_factory=list)


class DismissRequest(BaseModel):
    until: datetime
    reason: str | None = None
    dismissed_by: str


class ScanRequest(BaseModel):
    article_ids: list[UUID] | None = None
    force: bool = False


class ScanResponse(BaseModel):
    tick_id: UUID
    scanned: int
    evaluations_created: int
    llm_calls: int
    est_cost_usd_cents: int
    started_at: datetime
    finished_at: datetime
    skipped: list[dict]  # [{ "article_id": UUID, "reason": str }]


# --- Personas ---------------------------------------------------------------

GlossaryStatus = Literal["preferred", "avoid", "forbidden", "do_not_translate"]


class GlossaryEntry(BaseModel):
    term: str = Field(min_length=1, max_length=200)
    preferred: str = Field(default="", max_length=200)
    variants: list[str] = Field(default_factory=list)
    status: GlossaryStatus = "preferred"
    notes: str | None = Field(default=None, max_length=500)


class DisclaimerTemplate(BaseModel):
    condition: str = Field(default="", max_length=500)
    disclaimer: str = Field(default="", max_length=2000)


class PersonaIn(BaseModel):
    slug: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$")
    name: str = Field(min_length=1, max_length=128)
    voice_rules: list[str]
    banned_terms: list[str]
    required_phrasings: list[str]
    disclaimer_templates: dict[str, DisclaimerTemplate]
    tone_examples: dict[str, list[str]]
    glossary: list[GlossaryEntry] = Field(default_factory=list)


class PersonaPatch(BaseModel):
    name: str | None = None
    voice_rules: list[str] | None = None
    banned_terms: list[str] | None = None
    required_phrasings: list[str] | None = None
    disclaimer_templates: dict[str, DisclaimerTemplate] | None = None
    tone_examples: dict[str, list[str]] | None = None
    glossary: list[GlossaryEntry] | None = None
    # CMS publish target for this voice; null clears it (→ legacy WP env).
    publish_target_id: UUID | None = None


class PersonaOut(BaseModel):
    persona_id: UUID
    slug: str
    name: str
    voice_rules: list[str]
    banned_terms: list[str]
    required_phrasings: list[str]
    disclaimer_templates: dict[str, DisclaimerTemplate]
    tone_examples: dict[str, list[str]]
    glossary: list[GlossaryEntry] = Field(default_factory=list)
    publish_target_id: UUID | None = None
    is_archived: bool
    created_at: datetime
    updated_at: datetime
    created_by: str | None
    updated_by: str | None


class PersonaUsage(BaseModel):
    slug: str
    by_status: dict[str, int]
    total: int


class PublishTargetOut(BaseModel):
    publish_target_id: UUID
    name: str
    kind: str
    auth_ref: str
    status: str
    is_archived: bool


# An ``auth_ref`` is used as an env-var prefix (``{ref}_BASE_URL`` etc.), so it
# must be a valid shell-style identifier: a letter/underscore followed by
# letters, digits, or underscores. Conventionally uppercase (e.g. ``VHIS101_WP``).
_AUTH_REF_PATTERN = r"^[A-Za-z_][A-Za-z0-9_]*$"


class PublishTargetCreate(BaseModel):
    """Create a WordPress publish target (Phase 2 self-service).

    ``kind`` is always ``wordpress`` in this phase and is not accepted from the
    client. The actual base URL + credentials are NOT stored here — an operator
    must provision ``{auth_ref}_BASE_URL`` / ``_USERNAME`` / ``_APP_PASSWORD`` in
    the environment (see the readiness endpoint).
    """

    name: str = Field(min_length=1, max_length=128)
    auth_ref: str = Field(min_length=1, max_length=64, pattern=_AUTH_REF_PATTERN)
    status: Literal["active", "inactive"] = "active"


class PublishTargetUpdate(BaseModel):
    """Edit a target's display name / status. ``auth_ref`` is immutable — changing
    which secrets a live target reads is intentionally not allowed here."""

    name: str | None = Field(default=None, min_length=1, max_length=128)
    status: Literal["active", "inactive"] | None = None


class PublishTargetUsage(BaseModel):
    publish_target_id: UUID
    assigned_voice_count: int


class PublishTargetReadiness(BaseModel):
    """Presence-only check of a target's credential env vars. Booleans only —
    credential VALUES are never read into the response."""

    publish_target_id: UUID
    auth_ref: str
    base_url: bool
    username: bool
    app_password: bool
    ready: bool


# --- Topic batches ----------------------------------------------------------

BatchStatus = Literal[
    "pending",
    "generating",
    "analysing",
    "ready_for_review",
    "partially_promoted",
    "done",
    "failed",
]

CandidateStatus = Literal["candidate", "promoted", "skipped", "errored"]

ExistingVerdict = Literal["yes", "no", "not_sure"]
HotTopicVerdict = Literal["yes", "no"]


class TopicBatchIn(BaseModel):
    """Brief-form payload that kicks off a topic-expansion batch."""

    research_theme: str = Field(min_length=1)
    target_audience: str = Field(min_length=1)
    topic_count: int = Field(ge=1, le=30, default=10)
    keywords_per_topic: int = Field(ge=1, le=10, default=5)
    must_cover: list[str] = Field(default_factory=list)
    must_avoid: list[str] = Field(default_factory=list)
    priority_focus: str | None = None
    notes: str | None = None
    persona_default: str | None = None
    acf_adv_id_default: int | None = None
    acf_widget_id_default: int | None = None
    # Carried onto every run promoted from this batch: when true those runs
    # auto-approve their HITL_1 outline gate.
    auto_accept_hitl1_default: bool = False
    editor_email: str = Field(description="Identifies who triggered the batch")


class TopicCandidateOut(BaseModel):
    candidate_id: UUID
    batch_id: UUID
    position: int
    status: CandidateStatus
    topic: str
    keywords: list[str]
    original_topic: str
    original_keywords: list[str]
    existing: ExistingVerdict | None = None
    existing_note: str | None = None
    existing_url: str | None = None
    hot_topic: HotTopicVerdict | None = None
    hot_topic_note: str | None = None
    existing_search_debug: dict[str, object] | None = None
    persona_slug: str | None = None
    acf_adv_id: int | None = None
    acf_widget_id: int | None = None
    operator_note: str | None = None
    promote_mode: Literal["create", "refresh"] | None = None
    promoted_run_id: UUID | None = None
    last_error: str | None = None
    last_edited_by: str | None = None
    last_edited_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class TopicBatchOut(BaseModel):
    batch_id: UUID
    status: BatchStatus
    created_by: str
    created_at: datetime
    updated_at: datetime
    research_theme: str
    target_audience: str
    topic_count: int
    keywords_per_topic: int
    must_cover: list[str]
    must_avoid: list[str]
    priority_focus: str | None = None
    notes: str | None = None
    persona_default: str | None = None
    acf_adv_id_default: int | None = None
    acf_widget_id_default: int | None = None
    auto_accept_hitl1_default: bool = False
    cost_cents: int = 0
    last_error: str | None = None
    candidates: list[TopicCandidateOut] | None = None


class TopicBatchCreateResponse(BaseModel):
    batch_id: UUID
    status: BatchStatus


class PatchCandidateIn(BaseModel):
    """Partial-update payload for a single candidate row.

    All fields are optional; only those explicitly set propagate to the row.
    ``editor_email`` identifies the operator so the server can stamp
    ``last_edited_by`` / ``last_edited_at``.
    """

    topic: str | None = Field(default=None, min_length=1)
    keywords: list[str] | None = None
    persona_slug: str | None = None
    acf_adv_id: int | None = None
    acf_widget_id: int | None = None
    operator_note: str | None = None
    editor_email: str = Field(description="Operator identifier for edit stamp")


class PromotionItem(BaseModel):
    candidate_id: UUID
    mode: Literal["create", "refresh"]


class PromoteRequest(BaseModel):
    promotions: list[PromotionItem] = Field(min_length=1)
    editor_email: str = Field(description="Identifies who is promoting")


class PromoteResponseItem(BaseModel):
    candidate_id: UUID
    run_id: UUID
    mode: Literal["create", "refresh"]


class PromoteResponse(BaseModel):
    items: list[PromoteResponseItem]
    batch_status: BatchStatus


class SkipCandidateRequest(BaseModel):
    editor_email: str = Field(description="Identifies who skipped the candidate")
