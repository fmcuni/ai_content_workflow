import base64
import json
from pathlib import Path

import pytest
import respx
from httpx import Response

from content_tool.wordpress.client import (
    WP_DEFAULT_PAGE_TEMPLATE,
    PublishPayload,
    WordPressClient,
    WordPressConflictError,
)


@pytest.mark.asyncio
async def test_publish_updates_existing_post():
    payload = PublishPayload(
        post_id=98785, title="x", content="<p>x</p>", excerpt="x",
        status="draft", slug="x", categories=[42], tags=[7], author=5,
        featured_media=None, meta={"_yoast_wpseo_metadesc": "x"},
        if_unmodified_since="2026-04-12T08:30:00",
    )
    raw = Path("tests/fixtures/wp_responses/publish_response.json").read_text(encoding="utf-8")  # noqa: ASYNC240
    expected_resp = json.loads(raw)
    auth = "Basic " + base64.b64encode(b"user:pass").decode()
    with respx.mock(assert_all_called=True) as r:
        route = r.put("https://wp.example.com/wp-json/wp/v2/posts/98785").mock(
            return_value=Response(200, json=expected_resp)
        )
        client = WordPressClient(
            "https://wp.example.com", username="user", app_password="pass"  # noqa: S106
        )
        result = await client.upsert(payload)
        assert route.called
        assert route.calls.last.request.headers["authorization"] == auth
        assert route.calls.last.request.headers["if-unmodified-since"] == "2026-04-12T08:30:00"
    assert result.id == 98785
    assert result.status == "draft"


@pytest.mark.asyncio
async def test_publish_raises_on_412():
    raw = Path("tests/fixtures/wp_responses/conflict_412.json").read_text(encoding="utf-8")  # noqa: ASYNC240
    body = json.loads(raw)
    with respx.mock(assert_all_called=True) as r:
        r.put("https://wp.example.com/wp-json/wp/v2/posts/98785").mock(
            return_value=Response(412, json=body)
        )
        client = WordPressClient(
            "https://wp.example.com", username="user", app_password="pass"  # noqa: S106
        )
        with pytest.raises(WordPressConflictError):
            await client.upsert(PublishPayload(
                post_id=98785, title="x", content="x", excerpt="x",
                status="draft", slug=None, categories=[], tags=[], author=None,
                featured_media=None, meta={}, if_unmodified_since="2026-04-12T08:30:00",
            ))


@pytest.mark.asyncio
async def test_publish_includes_date_gmt_when_set():
    raw = Path("tests/fixtures/wp_responses/publish_response.json").read_text(encoding="utf-8")  # noqa: ASYNC240
    expected_resp = json.loads(raw)
    with respx.mock(assert_all_called=True) as r:
        route = r.put("https://wp.example.com/wp-json/wp/v2/posts/98785").mock(
            return_value=Response(200, json=expected_resp)
        )
        client = WordPressClient(
            "https://wp.example.com", username="user", app_password="pass"  # noqa: S106
        )
        await client.upsert(PublishPayload(
            post_id=98785, title="x", content="<p>x</p>", excerpt="x",
            status="future", slug="x", categories=[42], tags=[],
            author=5, featured_media=None, meta={},
            if_unmodified_since=None,
            date_gmt="2026-06-01T03:00:00",
        ))
        body = json.loads(route.calls.last.request.content)
        assert body["date_gmt"] == "2026-06-01T03:00:00"


@pytest.mark.asyncio
async def test_publish_sends_default_template_when_set():
    raw = Path("tests/fixtures/wp_responses/publish_response.json").read_text(encoding="utf-8")  # noqa: ASYNC240
    expected_resp = json.loads(raw)
    with respx.mock(assert_all_called=True) as r:
        route = r.put("https://wp.example.com/wp-json/wp/v2/posts/98785").mock(
            return_value=Response(200, json=expected_resp)
        )
        client = WordPressClient(
            "https://wp.example.com", username="user", app_password="pass"  # noqa: S106
        )
        await client.upsert(PublishPayload(
            post_id=98785, title="x", content="<p>x</p>", excerpt="x",
            status="draft", slug=None, categories=[], tags=[],
            author=None, featured_media=None, meta={},
            if_unmodified_since=None,
            template=WP_DEFAULT_PAGE_TEMPLATE,
        ))
        body = json.loads(route.calls.last.request.content)
        # "" is the meaningful WP "default template" value — it must be present.
        assert body["template"] == ""
        assert WP_DEFAULT_PAGE_TEMPLATE == ""


@pytest.mark.asyncio
async def test_publish_omits_template_when_none():
    raw = Path("tests/fixtures/wp_responses/publish_response.json").read_text(encoding="utf-8")  # noqa: ASYNC240
    expected_resp = json.loads(raw)
    with respx.mock(assert_all_called=True) as r:
        route = r.put("https://wp.example.com/wp-json/wp/v2/posts/98785").mock(
            return_value=Response(200, json=expected_resp)
        )
        client = WordPressClient(
            "https://wp.example.com", username="user", app_password="pass"  # noqa: S106
        )
        await client.upsert(PublishPayload(
            post_id=98785, title="x", content="<p>x</p>", excerpt="x",
            status="draft", slug=None, categories=[], tags=[],
            author=None, featured_media=None, meta={},
            if_unmodified_since=None,
            template=None,
        ))
        body = json.loads(route.calls.last.request.content)
        assert "template" not in body


@pytest.mark.asyncio
async def test_publish_omits_date_gmt_when_none():
    raw = Path("tests/fixtures/wp_responses/publish_response.json").read_text(encoding="utf-8")  # noqa: ASYNC240
    expected_resp = json.loads(raw)
    with respx.mock(assert_all_called=True) as r:
        route = r.put("https://wp.example.com/wp-json/wp/v2/posts/98785").mock(
            return_value=Response(200, json=expected_resp)
        )
        client = WordPressClient(
            "https://wp.example.com", username="user", app_password="pass"  # noqa: S106
        )
        await client.upsert(PublishPayload(
            post_id=98785, title="x", content="<p>x</p>", excerpt="x",
            status="draft", slug=None, categories=[], tags=[],
            author=None, featured_media=None, meta={},
            if_unmodified_since=None,
            date_gmt=None,
        ))
        body = json.loads(route.calls.last.request.content)
        assert "date_gmt" not in body
