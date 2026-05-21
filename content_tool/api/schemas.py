from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


class CreateRunRequest(BaseModel):
    article_url: str
    topic: str
    keywords: list[str]
    mode: Literal["auto", "small_refresh", "full_rewrite"] = "auto"
    edit_note: str | None = None
    acf_adv_id: int
    acf_widget_id: int
    persona: str = "bowtie-editor"
    topic_category: str | None = None
    editor_email: str = Field(description="Identifies who triggered the run")


class CreateRunResponse(BaseModel):
    run_id: UUID
    status: str
    created_at: datetime


class ResumeRequest(BaseModel):
    decision: Literal["approve", "edit_outline", "override_route", "cancel"]
    edited_outline: dict | None = None
    new_route: Literal["small_refresh", "full_rewrite"] | None = None
    notes: str | None = None


class Hitl2Request(BaseModel):
    decision: Literal["approve", "request_changes", "reject"]
    notes: str | None = None
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
