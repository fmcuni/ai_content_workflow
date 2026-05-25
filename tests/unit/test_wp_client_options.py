"""Unit tests for WordPressClient list_users / list_categories."""

import pytest
import respx
from httpx import Response

from content_tool.wordpress.client import (
    WordPressClient,
    WordPressError,
    WpCategory,
    WpUser,
)


@pytest.fixture()
def client() -> WordPressClient:
    return WordPressClient("https://wp.test", username="user", app_password="pass")  # noqa: S106


@pytest.mark.asyncio
async def test_list_categories_single_page(client: WordPressClient) -> None:
    with respx.mock(assert_all_called=True) as router:
        router.get("https://wp.test/wp-json/wp/v2/categories").mock(
            return_value=Response(
                200,
                json=[
                    {"id": 1, "name": "News", "slug": "news"},
                    {"id": 2, "name": "Bowtie Story", "slug": "bowtie-story"},
                ],
                headers={"x-wp-total": "2", "x-wp-totalpages": "1"},
            )
        )
        result = await client.list_categories()
    assert result == [
        WpCategory(id=1, name="News", slug="news"),
        WpCategory(id=2, name="Bowtie Story", slug="bowtie-story"),
    ]


@pytest.mark.asyncio
async def test_list_categories_paginates(client: WordPressClient) -> None:
    page1 = [{"id": i, "name": f"c{i}", "slug": f"c{i}"} for i in range(100)]
    page2 = [{"id": i, "name": f"c{i}", "slug": f"c{i}"} for i in range(100, 107)]
    with respx.mock(assert_all_called=True) as router:
        route = router.get("https://wp.test/wp-json/wp/v2/categories")
        route.mock(side_effect=[
            Response(200, json=page1, headers={"x-wp-total": "107", "x-wp-totalpages": "2"}),
            Response(200, json=page2, headers={"x-wp-total": "107", "x-wp-totalpages": "2"}),
        ])
        result = await client.list_categories()
        assert route.call_count == 2
        first_url = str(route.calls[0].request.url)
        second_url = str(route.calls[1].request.url)
        assert "page=1" in first_url
        assert "per_page=100" in first_url
        assert "hide_empty=false" in first_url
        assert "page=2" in second_url
    assert len(result) == 107
    assert result[0].id == 0
    assert result[-1].id == 106


@pytest.mark.asyncio
async def test_list_categories_raises_on_non_json(client: WordPressClient) -> None:
    with respx.mock(assert_all_called=True) as router:
        router.get("https://wp.test/wp-json/wp/v2/categories").mock(
            return_value=Response(
                202,
                content=b"",
                headers={"content-type": "text/html; charset=UTF-8",
                         "x-cache": "Error from cloudfront"},
            )
        )
        with pytest.raises(WordPressError, match="non-JSON"):
            await client.list_categories()


@pytest.mark.asyncio
async def test_list_users_paginates(client: WordPressClient) -> None:
    page1 = [{"id": i, "name": f"u{i}", "slug": f"u{i}"} for i in range(100)]
    page2 = [{"id": i, "name": f"u{i}", "slug": f"u{i}"} for i in range(100, 200)]
    page3 = [{"id": i, "name": f"u{i}", "slug": f"u{i}"} for i in range(200, 266)]
    with respx.mock(assert_all_called=True) as router:
        route = router.get("https://wp.test/wp-json/wp/v2/users")
        route.mock(side_effect=[
            Response(200, json=page1, headers={"x-wp-total": "266", "x-wp-totalpages": "3"}),
            Response(200, json=page2, headers={"x-wp-total": "266", "x-wp-totalpages": "3"}),
            Response(200, json=page3, headers={"x-wp-total": "266", "x-wp-totalpages": "3"}),
        ])
        result = await client.list_users()
        assert route.call_count == 3
        first_url = str(route.calls[0].request.url)
        assert "per_page=100" in first_url
        assert "hide_empty" not in first_url  # users endpoint doesn't take it
    assert len(result) == 266
    assert isinstance(result[0], WpUser)
    assert result[0].id == 0


@pytest.mark.asyncio
async def test_list_users_propagates_4xx(client: WordPressClient) -> None:
    with respx.mock(assert_all_called=True) as router:
        router.get("https://wp.test/wp-json/wp/v2/users").mock(
            return_value=Response(
                403,
                json={"code": "rest_user_cannot_view", "message": "Sorry"},
                headers={"content-type": "application/json"},
            )
        )
        with pytest.raises(WordPressError, match="403"):
            await client.list_users()
