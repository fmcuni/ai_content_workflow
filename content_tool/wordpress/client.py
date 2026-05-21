import base64
from dataclasses import dataclass

import httpx


class WordPressError(Exception):
    pass


class WordPressConflictError(WordPressError):
    pass


@dataclass
class PublishPayload:
    post_id: int | None
    title: str
    content: str
    excerpt: str | None
    status: str
    slug: str | None
    categories: list[int]
    tags: list[int]
    author: int | None
    featured_media: int | None
    meta: dict[str, str]
    if_unmodified_since: str | None


@dataclass
class PublishResult:
    id: int
    link: str
    status: str
    modified_gmt: str
    slug: str


class WordPressClient:
    def __init__(
        self,
        base_url: str,
        *,
        username: str,
        app_password: str,
        timeout: float = 15.0,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._username = username
        self._password = app_password
        self._timeout = timeout
        self._client = client

    def _auth_header(self) -> str:
        token = base64.b64encode(f"{self._username}:{self._password}".encode()).decode()
        return f"Basic {token}"

    async def upsert(self, p: PublishPayload) -> PublishResult:
        own = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self._timeout)
        try:
            headers = {"authorization": self._auth_header()}
            if p.if_unmodified_since:
                headers["if-unmodified-since"] = p.if_unmodified_since
            body: dict[str, object] = {
                "title": p.title,
                "content": p.content,
                "status": p.status,
                "categories": p.categories,
                "tags": p.tags,
                "meta": p.meta,
            }
            if p.excerpt is not None:
                body["excerpt"] = p.excerpt
            if p.slug is not None:
                body["slug"] = p.slug
            if p.author is not None:
                body["author"] = p.author
            if p.featured_media is not None:
                body["featured_media"] = p.featured_media

            if p.post_id:
                resp = await client.put(
                    f"{self._base_url}/wp-json/wp/v2/posts/{p.post_id}",
                    json=body,
                    headers=headers,
                )
            else:
                resp = await client.post(
                    f"{self._base_url}/wp-json/wp/v2/posts",
                    json=body,
                    headers=headers,
                )

            if resp.status_code == 412:
                raise WordPressConflictError(resp.text)
            if resp.is_error:
                raise WordPressError(f"{resp.status_code}: {resp.text}")

            data = resp.json()
            return PublishResult(
                id=data["id"],
                link=data["link"],
                status=data["status"],
                modified_gmt=data["modified_gmt"],
                slug=data["slug"],
            )
        finally:
            if own:
                await client.aclose()
