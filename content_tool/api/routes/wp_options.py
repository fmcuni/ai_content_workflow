"""Read-only proxy endpoints for WordPress users / categories.

Used by the HITL-2 reviewer form to populate searchable dropdowns.
TTL-cached on app.state.wp_options_cache.
"""

import logging
from dataclasses import asdict

from fastapi import APIRouter, HTTPException, Request

from content_tool.wordpress.client import WordPressError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/wp-options", tags=["wp-options"])


@router.get("/users")
async def list_users(request: Request) -> list[dict]:
    cache = request.app.state.wp_options_cache
    wp = request.app.state.wp_client
    try:
        users = await cache.get_or_set("users", wp.list_users)
    except WordPressError as e:
        logger.warning("WordPress upstream failed for /wp-options/users: %s", e)
        raise HTTPException(status_code=502, detail="WordPress upstream error") from e
    return [asdict(u) for u in users]


@router.get("/categories")
async def list_categories(request: Request) -> list[dict]:
    cache = request.app.state.wp_options_cache
    wp = request.app.state.wp_client
    try:
        cats = await cache.get_or_set("categories", wp.list_categories)
    except WordPressError as e:
        logger.warning("WordPress upstream failed for /wp-options/categories: %s", e)
        raise HTTPException(status_code=502, detail="WordPress upstream error") from e
    return [asdict(c) for c in cats]
