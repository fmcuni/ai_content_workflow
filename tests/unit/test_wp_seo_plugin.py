import base64

import pytest
import respx
from httpx import Response

from content_tool.wordpress.seo_plugin import (
    SeoPluginResolver,
    detect_seo_plugin,
    seo_meta_key,
)

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
async def test_yoast_namespace_without_metadesc_returns_none():
    """Regression: the publish failure root cause. Yoast registers several
    ``_yoast_wpseo_*`` keys for REST, but if ``_yoast_wpseo_metadesc`` itself is
    NOT registered (protected/not writable), we must NOT claim "yoast" — sending
    that key would 400 the whole publish."""
    with respx.mock(assert_all_called=True) as r:
        r.options(POSTS).mock(
            return_value=Response(
                200, json=_schema("_yoast_wpseo_title", "_yoast_wpseo_focuskw")
            )
        )
        plugin = await detect_seo_plugin("https://wp.example.com")
    assert plugin is None


@pytest.mark.asyncio
async def test_rankmath_namespace_without_description_returns_none():
    with respx.mock(assert_all_called=True) as r:
        r.options(POSTS).mock(
            return_value=Response(200, json=_schema("rank_math_title", "rank_math_focus_keyword"))
        )
        plugin = await detect_seo_plugin("https://wp.example.com")
    assert plugin is None


def test_seo_meta_key_mapping():
    assert seo_meta_key("yoast") == "_yoast_wpseo_metadesc"
    assert seo_meta_key("rankmath") == "rank_math_description"
    assert seo_meta_key(None) is None


@pytest.mark.asyncio
async def test_resolver_override_skips_network():
    """An explicit override resolves with zero network I/O (no respx route)."""
    resolver = SeoPluginResolver("https://wp.example.com", override="yoast")
    assert await resolver.resolve() == "yoast"


@pytest.mark.asyncio
async def test_resolver_no_base_url_returns_none():
    resolver = SeoPluginResolver("")
    assert await resolver.resolve() is None


@pytest.mark.asyncio
async def test_resolver_detects_and_caches_within_ttl():
    """Re-detect per publish, but cache briefly so dry-publish polling doesn't
    hammer the OPTIONS endpoint: two resolves within TTL → one network call."""
    with respx.mock(assert_all_called=True) as r:
        route = r.options(POSTS).mock(
            return_value=Response(200, json=_schema("_yoast_wpseo_metadesc"))
        )
        resolver = SeoPluginResolver("https://wp.example.com", ttl_seconds=300.0)
        assert await resolver.resolve() == "yoast"
        assert await resolver.resolve() == "yoast"
        assert route.call_count == 1


@pytest.mark.asyncio
async def test_resolver_degrades_to_none_on_detection_error():
    with respx.mock(assert_all_called=True) as r:
        r.options(POSTS).mock(return_value=Response(500))
        resolver = SeoPluginResolver("https://wp.example.com")
        assert await resolver.resolve() is None


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
