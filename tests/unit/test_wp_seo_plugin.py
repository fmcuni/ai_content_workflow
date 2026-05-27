import base64

import pytest
import respx
from httpx import Response

from content_tool.wordpress.seo_plugin import detect_seo_plugin

POSTS = "https://wp.example.com/wp-json/wp/v2/posts"


def _schema(*meta_keys: str) -> dict:
    """Shape of an OPTIONS /wp/v2/posts response: registered REST meta lives
    under schema.properties.meta.properties."""
    return {
        "schema": {
            "properties": {
                "meta": {"properties": {k: {"type": "string"} for k in meta_keys}}
            }
        }
    }


@pytest.mark.asyncio
async def test_detects_yoast():
    with respx.mock(assert_all_called=True) as r:
        r.options(POSTS).mock(
            return_value=Response(
                200,
                json=_schema(
                    "_yoast_wpseo_metadesc", "_yoast_wpseo_title", "_yoast_wpseo_focuskw"
                ),
            )
        )
        plugin = await detect_seo_plugin("https://wp.example.com")
    assert plugin == "yoast"


@pytest.mark.asyncio
async def test_detects_rankmath_when_meta_keys_match():
    with respx.mock(assert_all_called=True) as r:
        r.options(POSTS).mock(
            return_value=Response(
                200, json=_schema("rank_math_description", "rank_math_title")
            )
        )
        plugin = await detect_seo_plugin("https://wp.example.com")
    assert plugin == "rankmath"


@pytest.mark.asyncio
async def test_none_when_no_seo_meta():
    with respx.mock(assert_all_called=True) as r:
        r.options(POSTS).mock(return_value=Response(200, json=_schema()))
        plugin = await detect_seo_plugin("https://wp.example.com")
    assert plugin is None


@pytest.mark.asyncio
async def test_sends_basic_auth_when_credentials_provided():
    """Regression: detect_seo_plugin used to send anonymous requests, causing
    401s on production WP installs that require auth."""
    expected_auth = "Basic " + base64.b64encode(b"u:p").decode()
    with respx.mock(assert_all_called=True) as r:
        route = r.options(POSTS).mock(return_value=Response(200, json=_schema()))
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
        route = r.options(POSTS).mock(return_value=Response(200, json=_schema()))
        await detect_seo_plugin("https://wp.example.com")
        assert route.called
        assert "authorization" not in route.calls.last.request.headers
