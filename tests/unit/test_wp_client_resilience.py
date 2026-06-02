"""Resilience tests for WordPressClient.upsert() - spec cases 1-14.

Covers the infra-block hardening: outcome classification, bounded retry with
zero backoff, and the create-side slug read-back gate that prevents duplicate
posts. Mirrors deploy/cloudflare-workers/src/wordpress/client_resilience.test.ts.
"""

import base64

import httpx
import pytest
import respx
from httpx import Response

from content_tool.wordpress.client import (
    PublishPayload,
    WordPressClient,
    WordPressConflictError,
    WordPressError,
)

WP = "https://wp.example.com"
POSTS = f"{WP}/wp-json/wp/v2/posts"
PUT_URL = f"{POSTS}/98785"

SUCCESS_JSON = {
    "id": 98785,
    "link": "https://wp.example.com/x",
    "status": "draft",
    "modified_gmt": "2026-05-21T10:00:00",
    "slug": "x",
}
CREATE_JSON = {
    "id": 5150,
    "link": "https://wp.example.com/new-article",
    "status": "publish",
    "modified_gmt": "2026-05-21T10:00:00",
    "slug": "new-article",
}


def _client() -> WordPressClient:
    # Zero backoff so retries never actually sleep.
    return WordPressClient(
        WP, username="user", app_password="pass", max_attempts=3, backoff_base=0.0  # noqa: S106
    )


def _update_payload(*, slug: str | None = "x") -> PublishPayload:
    return PublishPayload(
        post_id=98785, title="x", content="<p>x</p>", excerpt="x",
        status="draft", slug=slug, categories=[42], tags=[7], author=5,
        featured_media=None, meta={}, if_unmodified_since=None,
    )


def _create_payload(*, slug: str | None = "new-article") -> PublishPayload:
    return PublishPayload(
        post_id=None, title="x", content="<p>x</p>", excerpt="x",
        status="publish", slug=slug, categories=[42], tags=[], author=5,
        featured_media=None, meta={}, if_unmodified_since=None,
    )


# ---------------------------------------------------------------------------
# Case 1 — update success unchanged: 200 + JSON → one call.
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_update_success_single_call():
    with respx.mock(assert_all_called=True) as r:
        route = r.put(PUT_URL).mock(return_value=Response(200, json=SUCCESS_JSON))
        result = await _client().upsert(_update_payload())
    assert result.id == 98785
    assert route.call_count == 1


# ---------------------------------------------------------------------------
# Case 2 — update: 2xx + HTML body (infra block), then 200 JSON → retries PUT.
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_update_html_block_then_success_retries():
    with respx.mock(assert_all_called=True) as r:
        route = r.put(PUT_URL).mock(
            side_effect=[
                Response(200, text="<html>challenge</html>",
                         headers={"content-type": "text/html"}),
                Response(200, json=SUCCESS_JSON),
            ]
        )
        result = await _client().upsert(_update_payload())
    assert result.id == 98785
    assert route.call_count == 2


# ---------------------------------------------------------------------------
# Case 3 — update: 200 + application/json content-type but truncated body,
# then 200 JSON → retries (guards the resp.json() decode crash).
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_update_truncated_json_then_success_retries():
    with respx.mock(assert_all_called=True) as r:
        route = r.put(PUT_URL).mock(
            side_effect=[
                Response(200, text='{"id": 98785, "li',
                         headers={"content-type": "application/json"}),
                Response(200, json=SUCCESS_JSON),
            ]
        )
        result = await _client().upsert(_update_payload())
    assert result.id == 98785
    assert route.call_count == 2


# ---------------------------------------------------------------------------
# Case 4 — update: 5xx then 200 → retries.
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_update_5xx_then_success_retries():
    with respx.mock(assert_all_called=True) as r:
        route = r.put(PUT_URL).mock(
            side_effect=[
                Response(503, text="<html>gateway</html>",
                         headers={"content-type": "text/html"}),
                Response(200, json=SUCCESS_JSON),
            ]
        )
        result = await _client().upsert(_update_payload())
    assert result.id == 98785
    assert route.call_count == 2


# ---------------------------------------------------------------------------
# Case 5 — update: transport error then 200 → retries.
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_update_transport_error_then_success_retries():
    with respx.mock(assert_all_called=True) as r:
        route = r.put(PUT_URL).mock(
            side_effect=[
                httpx.ConnectError("boom"),
                Response(200, json=SUCCESS_JSON),
            ]
        )
        result = await _client().upsert(_update_payload())
    assert result.id == 98785
    assert route.call_count == 2


# ---------------------------------------------------------------------------
# Case 6 — update: persistent non-JSON for all attempts → WordPressError
# (not a decode error) after exactly max_attempts calls; message has diagnostics.
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_update_persistent_non_json_raises_after_max_attempts():
    with respx.mock(assert_all_called=True) as r:
        route = r.put(PUT_URL).mock(
            return_value=Response(
                200, text="<html>challenge</html>",
                headers={"content-type": "text/html", "x-cache": "Error from cloudfront"},
            )
        )
        with pytest.raises(WordPressError) as exc:
            await _client().upsert(_update_payload())
    assert route.call_count == 3
    msg = str(exc.value)
    assert "text/html" in msg
    assert "cloudfront" in msg.lower()


# ---------------------------------------------------------------------------
# Case 7 — 412 on update → WordPressConflictError, exactly one call (no retry).
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_update_412_conflict_no_retry():
    with respx.mock(assert_all_called=True) as r:
        route = r.put(PUT_URL).mock(
            return_value=Response(412, json={"code": "rest_post_modified"})
        )
        with pytest.raises(WordPressConflictError):
            await _client().upsert(_update_payload())
    assert route.call_count == 1


# ---------------------------------------------------------------------------
# Case 8 — 4xx + JSON error body on update → WordPressError, one call (no retry).
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_update_4xx_json_reject_no_retry():
    with respx.mock(assert_all_called=True) as r:
        route = r.put(PUT_URL).mock(
            return_value=Response(
                400,
                json={"code": "rest_invalid_param", "message": "Invalid slug."},
                headers={"content-type": "application/json"},
            )
        )
        with pytest.raises(WordPressError) as exc:
            await _client().upsert(_update_payload())
    assert route.call_count == 1
    assert not isinstance(exc.value, WordPressConflictError)
    assert "400" in str(exc.value)


# ---------------------------------------------------------------------------
# Case 9 — create success unchanged: POST 201 + JSON → one call.
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_create_success_single_call():
    with respx.mock(assert_all_called=True) as r:
        route = r.post(POSTS).mock(return_value=Response(201, json=CREATE_JSON))
        result = await _client().upsert(_create_payload())
    assert result.id == 5150
    assert route.call_count == 1


# ---------------------------------------------------------------------------
# Case 10 — create: infra block on POST, read-back FINDS the post → no second
# POST; returns PublishResult from the read-back. Exactly one POST issued.
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_create_block_then_readback_found_no_second_post():
    with respx.mock(assert_all_called=True) as r:
        post_route = r.post(POSTS).mock(
            return_value=Response(200, text="<html>blocked</html>",
                                   headers={"content-type": "text/html"})
        )
        readback = r.get(POSTS, params={"slug": "new-article", "status": "any"}).mock(
            return_value=Response(200, json=[{
                "id": 5150, "link": "https://wp.example.com/new-article",
                "status": "publish", "slug": "new-article",
                "modified_gmt": "2026-05-21T10:00:00",
            }])
        )
        result = await _client().upsert(_create_payload())
    assert result.id == 5150
    assert result.link == "https://wp.example.com/new-article"
    assert post_route.call_count == 1
    assert readback.called


# ---------------------------------------------------------------------------
# Case 11 — create: infra block on POST, read-back NOT_FOUND → second POST
# issued, succeeds.
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_create_block_then_readback_not_found_retries_post():
    with respx.mock(assert_all_called=True) as r:
        post_route = r.post(POSTS).mock(
            side_effect=[
                Response(200, text="<html>blocked</html>",
                         headers={"content-type": "text/html"}),
                Response(201, json=CREATE_JSON),
            ]
        )
        readback = r.get(POSTS, params={"slug": "new-article", "status": "any"}).mock(
            return_value=Response(200, json=[])
        )
        result = await _client().upsert(_create_payload())
    assert result.id == 5150
    assert post_route.call_count == 2
    assert readback.called


# ---------------------------------------------------------------------------
# Case 12 — create: infra block on POST, read-back itself blocked (UNKNOWN) →
# WordPressError; only one POST issued (no duplicate).
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_create_block_then_readback_unknown_no_duplicate():
    with respx.mock(assert_all_called=True) as r:
        post_route = r.post(POSTS).mock(
            return_value=Response(200, text="<html>blocked</html>",
                                   headers={"content-type": "text/html"})
        )
        readback = r.get(POSTS, params={"slug": "new-article", "status": "any"}).mock(
            return_value=Response(200, text="<html>blocked</html>",
                                  headers={"content-type": "text/html"})
        )
        with pytest.raises(WordPressError):
            await _client().upsert(_create_payload())
    assert post_route.call_count == 1
    assert readback.called


# ---------------------------------------------------------------------------
# Case 13 — create with slug=None, infra block → WordPressError; no second POST;
# message states read-back impossible without slug.
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_create_block_no_slug_raises_no_retry():
    with respx.mock(assert_all_called=True) as r:
        post_route = r.post(POSTS).mock(
            return_value=Response(200, text="<html>blocked</html>",
                                   headers={"content-type": "text/html"})
        )
        with pytest.raises(WordPressError) as exc:
            await _client().upsert(_create_payload(slug=None))
    assert post_route.call_count == 1
    assert "slug" in str(exc.value).lower()


# ---------------------------------------------------------------------------
# Case 14 — find_post_by_slug query shape: requests status=any and the
# expected _fields.
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_find_post_by_slug_query_shape():
    with respx.mock(assert_all_called=True) as r:
        route = r.get(POSTS).mock(return_value=Response(200, json=[]))
        await _client().find_post_by_slug("new-article")
    req = route.calls.last.request
    assert req.url.params["slug"] == "new-article"
    assert req.url.params["status"] == "any"
    assert req.url.params["_fields"] == "id,link,status,slug,modified_gmt"
    # Authenticated so non-published statuses are visible.
    expected_auth = "Basic " + base64.b64encode(b"user:pass").decode()
    assert req.headers["authorization"] == expected_auth


# ---------------------------------------------------------------------------
# Case 15 — create: read-back gate runs on the FINAL attempt too. A create that
# landed at WP but whose response was blocked is recovered as success (no false
# failure → no operator-driven duplicate). max_attempts=1 isolates the final
# attempt: the gate must still fire.
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_create_final_attempt_readback_found_recovers():
    client = WordPressClient(
        WP, username="user", app_password="pass", max_attempts=1, backoff_base=0.0  # noqa: S106
    )
    with respx.mock(assert_all_called=True) as r:
        post_route = r.post(POSTS).mock(
            return_value=Response(200, text="<html>blocked</html>",
                                   headers={"content-type": "text/html"})
        )
        readback = r.get(POSTS, params={"slug": "new-article", "status": "any"}).mock(
            return_value=Response(200, json=[{
                "id": 5150, "link": "https://wp.example.com/new-article",
                "status": "publish", "slug": "new-article",
                "modified_gmt": "2026-05-21T10:00:00",
            }])
        )
        result = await client.upsert(_create_payload())
    assert result.id == 5150
    assert post_route.call_count == 1
    assert readback.called
