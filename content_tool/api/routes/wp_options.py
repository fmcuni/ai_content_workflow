"""Read-only proxy endpoints for WordPress users / categories.

Used by the HITL-2 reviewer form to populate searchable dropdowns.
TTL-cached on app.state.wp_options_cache.
"""

from dataclasses import asdict

from fastapi import APIRouter, HTTPException, Request

from content_tool.wordpress.client import WordPressError

router = APIRouter(prefix="/wp-options", tags=["wp-options"])


@router.get("/users")
async def list_users(request: Request) -> list[dict]:
    cache = request.app.state.wp_options_cache
    wp = request.app.state.wp_client
    try:
        users = await cache.get_or_set("users", wp.list_users)
    except WordPressError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return [asdict(u) for u in users]


@router.get("/categories")
async def list_categories(request: Request) -> list[dict]:
    cache = request.app.state.wp_options_cache
    wp = request.app.state.wp_client
    try:
        cats = await cache.get_or_set("categories", wp.list_categories)
    except WordPressError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return [asdict(c) for c in cats]
