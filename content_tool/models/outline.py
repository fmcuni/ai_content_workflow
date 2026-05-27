from typing import Literal

from pydantic import BaseModel, field_validator


class OutlineSection(BaseModel):
    heading_level: Literal[2, 3]
    heading_text: str
    action: Literal["keep", "update", "add", "remove", "reorder"]
    intent: str
    key_points: list[str]
    format_hint: Literal["paragraph", "bullet", "numbered", "table"]
    source_note: str | None = None


class FaqItem(BaseModel):
    question: str
    answer_intent: str
    action: Literal["keep", "update", "add", "remove"]


class ShortcodePositions(BaseModel):
    adv_panel_after_section_index: int
    page_widget_before: Literal["faq"] = "faq"

    @field_validator("page_widget_before", mode="before")
    @classmethod
    def _normalize_widget(cls, _v: object) -> str:
        # The page widget is always the FAQ block, so this token is a constant.
        # In CJK runs the model sometimes localizes it (e.g. returns 常見問題),
        # which previously crashed the whole run with a ValidationError. Coerce
        # any value back to the canonical token.
        return "faq"


class Outline(BaseModel):
    h1: str
    meta_description_hint: str
    sections: list[OutlineSection]
    faq_section: list[FaqItem]
    shortcode_positions: ShortcodePositions
