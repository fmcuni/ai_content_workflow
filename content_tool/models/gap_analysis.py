from typing import Literal

from pydantic import BaseModel, Field


class TopPage(BaseModel):
    url: str
    title: str
    rank: int


class CurrentArticleAssessment(BaseModel):
    strengths: list[str]
    outdated_points: list[str]
    weak_sections: list[str]
    structure_status: Literal["still_competitive", "partly_outdated", "outdated"]


class ContentGaps(BaseModel):
    missing_topics: list[str]
    missing_intents: list[str]
    freshness_gaps: list[str]
    semantic_gaps: list[str]
    source_trust_gaps: list[str]
    ai_extractability_gaps: list[str]
    hk_localization_gaps: list[str]
    faq_gaps: list[str]


class UpdatePlan(BaseModel):
    must_add: list[str]
    must_update: list[str]
    must_remove: list[str]
    must_reorder: list[str]
    faq_to_add: list[str]
    facts_to_verify: list[str]


class GapAnalysis(BaseModel):
    target_query: str
    top_pages: list[TopPage] = Field(min_length=5, max_length=5)
    current_article_assessment: CurrentArticleAssessment
    content_gaps: ContentGaps
    recommended_outline: str
    update_plan: UpdatePlan
    chosen_route: Literal["small_refresh", "full_rewrite"]
    route_reason: str
