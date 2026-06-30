"""Unit tests for WordPressClient.fetch_post_by_url."""

import json
from pathlib import Path

import pytest
import respx
from httpx import Response

from content_tool.wordpress.client import FetchedPost, WordPressClient, WordPressError

FIXTURES = Path(__file__).parent.parent / "fixtures" / "wp_responses"


@pytest.fixture()
def client() -> WordPressClient:
    return WordPressClient(
        "https://wp.test",
        username="user",
        app_password="pass",
    )


@pytest.mark.asyncio
async def test_fetch_post_by_url_found(client: WordPressClient) -> None:
    payload = json.loads((FIXTURES / "post_by_slug.json").read_text())

    with respx.mock(assert_all_called=True) as router:
        router.get("https://wp.test/wp-json/wp/v2/posts").mock(
            return_value=Response(200, json=payload)
        )

        result = await client.fetch_post_by_url(
            "https://www.bowtie.com.hk/blog/zh/cancer-screening/"
        )

    assert isinstance(result, FetchedPost)
    assert result.id == 98785
    assert result.slug == "cancer-screening"
    assert result.title == "大腸癌篩查指南"
    assert "大腸癌" in result.content_html
    assert result.modified_gmt == "2026-04-12T08:30:00"
    assert result.status == "publish"
    assert result.author == 5
    assert result.categories == [42, 7]


@pytest.mark.asyncio
async def test_fetch_post_by_url_not_found(client: WordPressClient) -> None:
    payload = json.loads((FIXTURES / "post_404.json").read_text())

    with respx.mock(assert_all_called=True) as router:
        router.get("https://wp.test/wp-json/wp/v2/posts").mock(
            return_value=Response(200, json=payload)
        )

        result = await client.fetch_post_by_url(
            "https://www.bowtie.com.hk/blog/zh/no-such-article/"
        )

    assert result is None


@pytest.mark.asyncio
async def test_fetch_post_by_url_empty_slug(client: WordPressClient) -> None:
    """A URL with no path slug returns None without making any HTTP call."""
    result = await client.fetch_post_by_url("https://www.bowtie.com.hk/")
    assert result is None


@pytest.mark.asyncio
async def test_fetch_post_by_url_decodes_cjk_slug(client: WordPressClient) -> None:
    """A percent-encoded CJK slug (the zh Bowtie blog) is unquoted ONCE before the
    query, so httpx encodes it a single time. The pre-fix code left it encoded and
    httpx double-encoded it, so WP matched nothing and refresh minted a duplicate."""
    payload = json.loads((FIXTURES / "post_by_slug.json").read_text())

    with respx.mock(assert_all_called=True) as router:
        route = router.get("https://wp.test/wp-json/wp/v2/posts").mock(
            return_value=Response(200, json=payload)
        )
        # URL path carries the percent-encoded slug 紫蘇油.
        await client.fetch_post_by_url(
            "https://www.bowtie.com.hk/blog/zh/%E7%87%9F%E9%A4%8A/%E7%B4%AB%E8%98%87%E6%B2%B9/"
        )

    # httpx exposes the decoded param value; it must be the real slug, not "%E7..".
    assert route.calls.last.request.url.params["slug"] == "紫蘇油"


@pytest.mark.asyncio
async def test_fetch_post_by_url_raises_on_empty_2xx(client: WordPressClient) -> None:
    # CloudFront returns "202 Accepted + text/html + empty body" when the edge
    # cannot reach origin. raise_for_status() does not treat 2xx as an error,
    # so without an explicit guard resp.json() raised JSONDecodeError. Now we
    # surface a clear WordPressError instead.
    with respx.mock(assert_all_called=True) as router:
        router.get("https://wp.test/wp-json/wp/v2/posts").mock(
            return_value=Response(
                202,
                content=b"",
                headers={"content-type": "text/html; charset=UTF-8",
                         "x-cache": "Error from cloudfront"},
            )
        )
        with pytest.raises(WordPressError, match="non-JSON"):
            await client.fetch_post_by_url(
                "https://www.bowtie.com.hk/blog/zh/cancer-screening/"
            )
