from pathlib import Path

from fastapi import APIRouter, HTTPException

from content_tool.api.prompt_graph import PROMPT_GRAPH

router = APIRouter(prefix="/prompts", tags=["prompts"])

_PROMPT_DIR = Path(__file__).resolve().parents[3] / "prompts"
_TEMPLATE_FILES = {
    "audit": "audit.md",
    "gap_analysis": "gap_analysis.md",
    "outline": "outline.md",
    "writer_small_refresh": "writer_small_refresh.md",
    "writer_full_rewrite": "writer_full_rewrite.md",
}


@router.get("/graph")
async def graph() -> dict:
    return PROMPT_GRAPH


@router.get("/templates/{template_id}")
async def template(template_id: str) -> dict:
    filename = _TEMPLATE_FILES.get(template_id)
    if filename is None:
        raise HTTPException(404, f"unknown template_id '{template_id}'")
    path = _PROMPT_DIR / filename
    return {"template_id": template_id, "template": path.read_text(encoding="utf-8")}
