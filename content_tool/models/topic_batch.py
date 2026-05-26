"""Pydantic models shared by the topic-expansion agents.

Kept separate from the SQLAlchemy ORM in ``content_tool/db/topic_batch_model.py``;
these are LLM-facing input/output schemas.
"""

from typing import Literal

from pydantic import BaseModel, Field


class TopicGenInput(BaseModel):
    """Input brief for the topic-gen agent.

    Fields mirror the n8n ``Settings`` user-prompt placeholders.
    """

    research_theme: str
    target_audience: str
    topic_count: int = Field(ge=1, le=30)
    keywords_per_topic: int = Field(ge=1, le=10)
    must_cover: list[str] = Field(default_factory=list)
    must_avoid: list[str] = Field(default_factory=list)
    priority_focus: str | None = None
    notes: str | None = None


class TopicGenCandidate(BaseModel):
    topic: str
    keywords: list[str]


class TopicGenOutput(BaseModel):
    topics: list[TopicGenCandidate]


class TopicDedupInput(BaseModel):
    topic: str
    keywords: list[str]


class TopicDedupOutput(BaseModel):
    existing: Literal["yes", "no", "not_sure"]
    existing_note: str
    existing_url: str


class TopicHotInput(BaseModel):
    topic: str
    keywords: list[str]


class TopicHotOutput(BaseModel):
    hot_topic: Literal["yes", "no"]
    hot_topic_note: str
