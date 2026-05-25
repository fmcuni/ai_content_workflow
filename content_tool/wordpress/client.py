import base64
from dataclasses import dataclass
from urllib.parse import urlparse

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


@dataclass
class FetchedPost:
    id: int
    slug: str
    link: str
    title: str
    content_html: str
    modified_gmt: str
    status: str
    author: int | None
    categories: list[int]


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

    @property
    def base_url(self) -> str:
        return self._base_url

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

    async def fetch_post_by_url(self, article_url: str) -> FetchedPost | None:
        """Resolve a WordPress post by its public URL. Returns None if not found.

        Strategy: extract the trailing slug from the URL path, then call
        GET /wp/v2/posts?slug=<slug>&_fields=...
        """
        parsed = urlparse(article_url)
        slug = parsed.path.rstrip("/").rsplit("/", 1)[-1]
        if not slug:
            return None

        own = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self._timeout)
        try:
            resp = await client.get(
                f"{self._base_url}/wp-json/wp/v2/posts",
                params={
                    "slug": slug,
                    "_fields": "id,slug,link,title,content,modified_gmt,status,author,categories",
                    "status": "publish",
                },
                headers={"authorization": self._auth_header()},
            )
            resp.raise_for_status()
            # CloudFront sometimes returns 2xx with an empty/HTML body when the
            # edge can't reach origin (x-cache: "Error from cloudfront"). Surface
            # that as a clear WordPressError instead of a cryptic JSONDecodeError
            # from resp.json().
            ctype = resp.headers.get("content-type", "")
            if not ctype.lower().startswith("application/json") or not resp.content:
                raise WordPressError(
                    f"WP REST returned non-JSON response ({resp.status_code} "
                    f"{ctype or 'no content-type'}, {len(resp.content)} bytes, "
                    f"x-cache={resp.headers.get('x-cache')!r}) — likely a "
                    f"CloudFront/origin outage."
                )
            posts = resp.json()
            if not posts:
                return None
            p = posts[0]
            return FetchedPost(
                id=int(p["id"]),
                slug=p["slug"],
                link=p["link"],
                title=p["title"]["rendered"],
                content_html=p["content"]["rendered"],
                modified_gmt=p["modified_gmt"],
                status=p["status"],
                author=p.get("author"),
                categories=list(p.get("categories", [])),
            )
        finally:
            if own:
                await client.aclose()
