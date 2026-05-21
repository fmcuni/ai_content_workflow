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
