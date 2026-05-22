import base64
import json
from pathlib import Path

import pytest
import respx
from httpx import Response

from content_tool.wordpress.seo_plugin import detect_seo_plugin


@pytest.mark.asyncio
async def test_detects_yoast():
    raw = Path("tests/fixtures/wp_responses/types_post.json").read_text(encoding="utf-8")  # noqa: ASYNC240
    types_resp = json.loads(raw)
    with respx.mock(assert_all_called=True) as r:
        r.get("https://wp.example.com/wp-json/wp/v2/types/post").mock(
            return_value=Response(200, json=types_resp)
        )
        plugin = await detect_seo_plugin("https://wp.example.com")
    assert plugin == "yoast"


@pytest.mark.asyncio
async def test_detects_rankmath_when_meta_keys_match():
    payload = {"post": {"meta_fields": ["rank_math_description", "rank_math_title"]}}
    with respx.mock(assert_all_called=True) as r:
        r.get("https://wp.example.com/wp-json/wp/v2/types/post").mock(
            return_value=Response(200, json=payload)
        )
        plugin = await detect_seo_plugin("https://wp.example.com")
    assert plugin == "rankmath"


@pytest.mark.asyncio
async def test_none_when_no_seo_meta():
    with respx.mock(assert_all_called=True) as r:
        r.get("https://wp.example.com/wp-json/wp/v2/types/post").mock(
            return_value=Response(200, json={"post": {"meta_fields": []}})
        )
        plugin = await detect_seo_plugin("https://wp.example.com")
    assert plugin is None


@pytest.mark.asyncio
async def test_sends_basic_auth_when_credentials_provided():
    """Regression: detect_seo_plugin used to send anonymous requests, causing
    401s on production WP installs that require auth on /wp/v2/types."""
    expected_auth = "Basic " + base64.b64encode(b"u:p").decode()
    with respx.mock(assert_all_called=True) as r:
        route = r.get("https://wp.example.com/wp-json/wp/v2/types/post").mock(
            return_value=Response(200, json={"post": {"meta_fields": []}})
        )
        await detect_seo_plugin(
            "https://wp.example.com",
            username="u",
            app_password="p",  # noqa: S106
        )
        assert route.called
        assert route.calls.last.request.headers["authorization"] == expected_auth


@pytest.mark.asyncio
async def test_no_auth_header_when_credentials_blank():
    """Backwards-compat: no auth header sent when creds are not configured."""
    with respx.mock(assert_all_called=True) as r:
        route = r.get("https://wp.example.com/wp-json/wp/v2/types/post").mock(
            return_value=Response(200, json={"post": {"meta_fields": []}})
        )
        await detect_seo_plugin("https://wp.example.com")
        assert route.called
        assert "authorization" not in route.calls.last.request.headers
