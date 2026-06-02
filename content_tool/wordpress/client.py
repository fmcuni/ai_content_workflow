import asyncio
import base64
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from enum import Enum
from typing import Literal
from urllib.parse import urlparse

import httpx

# WordPress represents "use the theme's default page template" as the empty
# string in the REST API `template` field. Sending this on every upsert forces
# both the create and refresh/update pipelines onto the default template,
# overriding whatever template an old post may have carried. A literal
# "default" would be rejected as an invalid template name by WP.
WP_DEFAULT_PAGE_TEMPLATE = ""

# Post meta key carrying the article's structured-data graph (JSON-encoded list
# of schema.org pieces). A companion mu-plugin registers this key with
# show_in_rest and emits it in the page <head> via the Yoast `wpseo_schema_graph`
# / RankMath `rank_math/json_ld` filters — keeping the post body free of raw
# <script type="application/ld+json"> markup. See docs/wordpress/.
SCHEMA_JSONLD_META_KEY = "_bowtie_schema_jsonld"


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
    date_gmt: str | None = None
    # WP page template slug. "" selects the theme default; None omits the field
    # entirely (leaving any existing post template untouched).
    template: str | None = None


@dataclass
class PublishResult:
    id: int
    link: str
    status: str
    modified_gmt: str
    slug: str


def _parse_publish_result(data: dict[str, object]) -> PublishResult:
    return PublishResult(
        id=int(data["id"]),  # type: ignore[arg-type]
        link=str(data["link"]),
        status=str(data["status"]),
        modified_gmt=str(data["modified_gmt"]),
        slug=str(data["slug"]),
    )


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


@dataclass
class WpUser:
    id: int
    name: str
    slug: str


@dataclass
class WpCategory:
    id: int
    name: str
    slug: str


class _Outcome(Enum):
    """Classification of a single HTTP attempt (see spec classification table)."""

    SUCCESS = "success"
    CONFLICT = "conflict"
    WP_REJECT = "wp_reject"
    RETRIABLE = "retriable"


@dataclass(frozen=True)
class _Classified:
    outcome: _Outcome
    # PublishResult on SUCCESS; diagnostic message otherwise.
    result: "PublishResult | None"
    message: str


@dataclass(frozen=True)
class ReadbackFound:
    kind: Literal["found"]
    post: PublishResult


@dataclass(frozen=True)
class ReadbackNotFound:
    kind: Literal["not_found"]


@dataclass(frozen=True)
class ReadbackUnknown:
    kind: Literal["unknown"]
    message: str


ReadbackResult = ReadbackFound | ReadbackNotFound | ReadbackUnknown

# Default retry policy. backoff = backoff_base * 2**(attempt-1) seconds.
_DEFAULT_MAX_ATTEMPTS = 3
_DEFAULT_BACKOFF_BASE = 0.5


def _is_json_content_type(ctype: str) -> bool:
    return ctype.lower().startswith("application/json")


class WordPressClient:
    def __init__(
        self,
        base_url: str,
        *,
        username: str,
        app_password: str,
        timeout: float = 15.0,
        client: httpx.AsyncClient | None = None,
        max_attempts: int = _DEFAULT_MAX_ATTEMPTS,
        backoff_base: float = _DEFAULT_BACKOFF_BASE,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._username = username
        self._password = app_password
        self._timeout = timeout
        self._client = client
        self._max_attempts = max(1, max_attempts)
        self._backoff_base = backoff_base
        self._sleep = sleep

    @property
    def base_url(self) -> str:
        return self._base_url

    def _auth_header(self) -> str:
        token = base64.b64encode(f"{self._username}:{self._password}".encode()).decode()
        return f"Basic {token}"

    def _build_body(self, p: PublishPayload) -> dict[str, object]:
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
        if p.date_gmt is not None:
            body["date_gmt"] = p.date_gmt
        # `is not None` (not truthiness): "" is the meaningful value that
        # selects the WP default template, so it must still be sent.
        if p.template is not None:
            body["template"] = p.template
        return body

    @staticmethod
    def _non_json_message(resp: httpx.Response) -> str:
        ctype = resp.headers.get("content-type", "")
        return (
            f"WP REST returned non-JSON response ({resp.status_code} "
            f"{ctype or 'no content-type'}, {len(resp.content)} bytes, "
            f"x-cache={resp.headers.get('x-cache')!r}) — likely a "
            f"CloudFront/origin outage."
        )

    def _classify(self, resp: httpx.Response) -> _Classified:
        """Classify one HTTP attempt per the spec classification table.

        WP REST always answers with JSON (even for its own errors), so any
        non-JSON / unparseable body means the response came from an edge/WAF,
        not WP — that is RETRIABLE regardless of status.
        """
        if resp.status_code == 412:
            return _Classified(_Outcome.CONFLICT, None, resp.text)

        ctype = resp.headers.get("content-type", "")
        if not _is_json_content_type(ctype) or not resp.content:
            return _Classified(_Outcome.RETRIABLE, None, self._non_json_message(resp))
        try:
            data = resp.json()
        except json.JSONDecodeError:
            # Body claims application/json but is truncated/malformed — edge
            # failure, never a raw decode error out of the client.
            return _Classified(_Outcome.RETRIABLE, None, self._non_json_message(resp))

        if resp.is_error:
            # 4xx (not 412) with a parseable JSON body: deterministic WP
            # rejection (bad slug, bad author, validation) — no retry.
            return _Classified(
                _Outcome.WP_REJECT, None, f"{resp.status_code}: {resp.text}"
            )
        return _Classified(_Outcome.SUCCESS, _parse_publish_result(data), "")

    async def upsert(self, p: PublishPayload) -> PublishResult:
        own = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self._timeout)
        try:
            return await self._upsert_with_retry(client, p)
        finally:
            if own:
                await client.aclose()

    async def _upsert_with_retry(
        self, client: httpx.AsyncClient, p: PublishPayload
    ) -> PublishResult:
        headers = {"authorization": self._auth_header()}
        if p.if_unmodified_since:
            headers["if-unmodified-since"] = p.if_unmodified_since
        body = self._build_body(p)
        last_message = "no attempts made"

        for attempt in range(1, self._max_attempts + 1):
            classified = await self._attempt(client, p, body, headers)
            outcome = classified.outcome
            if outcome is _Outcome.SUCCESS and classified.result is not None:
                return classified.result
            if outcome is _Outcome.CONFLICT:
                raise WordPressConflictError(classified.message)
            if outcome is _Outcome.WP_REJECT:
                raise WordPressError(classified.message)

            # RETRIABLE.
            last_message = classified.message
            is_final = attempt >= self._max_attempts
            # Create (POST) is not idempotent: gate EVERY retriable outcome
            # (including the final attempt) behind a slug read-back. On the final
            # attempt this also recovers a create that landed at WP but whose
            # response was blocked by the edge — returning success instead of a
            # false failure that would tempt an operator into a duplicate
            # re-publish. Update (PUT) is idempotent → retry directly.
            if p.post_id is None:
                gated = await self._gate_create_retry(client, p, last_message)
                if gated is not None:
                    return gated
            if is_final:
                break
            await self._backoff(attempt)

        raise WordPressError(
            f"WP publish failed after {self._max_attempts} attempts: {last_message}"
        )

    async def _attempt(
        self,
        client: httpx.AsyncClient,
        p: PublishPayload,
        body: dict[str, object],
        headers: dict[str, str],
    ) -> _Classified:
        url = (
            f"{self._base_url}/wp-json/wp/v2/posts/{p.post_id}"
            if p.post_id
            else f"{self._base_url}/wp-json/wp/v2/posts"
        )
        try:
            if p.post_id:
                resp = await client.put(url, json=body, headers=headers)
            else:
                resp = await client.post(url, json=body, headers=headers)
        except httpx.HTTPError as err:
            return _Classified(_Outcome.RETRIABLE, None, f"transport_error: {err}")
        return self._classify(resp)

    async def _gate_create_retry(
        self, client: httpx.AsyncClient, p: PublishPayload, last_message: str
    ) -> PublishResult | None:
        """Decide whether a blocked create may safely retry.

        Returns a PublishResult to short-circuit (read-back FOUND the post), or
        None to proceed with the POST retry (read-back NOT_FOUND). Raises a
        WordPressError when absence cannot be proven (no slug, or UNKNOWN).
        """
        if not p.slug:
            raise WordPressError(
                f"{last_message} Read-back impossible: no slug supplied, "
                f"so a duplicate post cannot be ruled out — not retrying."
            )
        readback = await self._find_post_by_slug(client, p.slug)
        if readback.kind == "found":
            return readback.post
        if readback.kind == "not_found":
            return None
        raise WordPressError(
            f"{last_message} Read-back inconclusive ({readback.message}) — "
            f"not retrying to avoid a duplicate post."
        )

    async def _backoff(self, attempt: int) -> None:
        if self._backoff_base > 0:
            await self._sleep(self._backoff_base * 2 ** (attempt - 1))

    async def find_post_by_slug(self, slug: str) -> ReadbackResult:
        own = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self._timeout)
        try:
            return await self._find_post_by_slug(client, slug)
        finally:
            if own:
                await client.aclose()

    async def _find_post_by_slug(
        self, client: httpx.AsyncClient, slug: str
    ) -> ReadbackResult:
        """Read-back a post by slug; never raises out of the gate.

        status=any (authenticated) so a just-created draft is visible. A
        non-JSON / transport-failed read-back maps to UNKNOWN.
        """
        try:
            resp = await client.get(
                f"{self._base_url}/wp-json/wp/v2/posts",
                params={
                    "slug": slug,
                    "status": "any",
                    "_fields": "id,link,status,slug,modified_gmt",
                },
                headers={"authorization": self._auth_header()},
            )
        except httpx.HTTPError as err:
            return ReadbackUnknown(kind="unknown", message=f"transport_error: {err}")

        ctype = resp.headers.get("content-type", "")
        if resp.is_error or not _is_json_content_type(ctype) or not resp.content:
            return ReadbackUnknown(kind="unknown", message=self._non_json_message(resp))
        try:
            posts = resp.json()
        except json.JSONDecodeError:
            return ReadbackUnknown(kind="unknown", message=self._non_json_message(resp))

        if not posts:
            return ReadbackNotFound(kind="not_found")
        return ReadbackFound(kind="found", post=_parse_publish_result(posts[0]))

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

    async def _list_paginated(
        self,
        path: str,
        *,
        extra_params: dict[str, str] | None = None,
    ) -> list[dict]:
        own = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self._timeout)
        try:
            headers = {"authorization": self._auth_header()}
            base_params: dict[str, str] = {
                "per_page": "100",
                "_fields": "id,name,slug",
            }
            if extra_params:
                base_params.update(extra_params)

            page = 1
            total_pages = 1
            results: list[dict] = []
            while True:
                params = {**base_params, "page": str(page)}
                resp = await client.get(
                    f"{self._base_url}{path}",
                    params=params,
                    headers=headers,
                )
                # CloudFront / WAF guard — same shape as fetch_post_by_url.
                # We deliberately run this BEFORE the is_error check below so a
                # 2xx-with-empty-HTML response (CloudFront edge failure) is
                # diagnosed clearly instead of producing a JSONDecodeError.
                ctype = resp.headers.get("content-type", "")
                if not ctype.lower().startswith("application/json") or not resp.content:
                    raise WordPressError(
                        f"WP REST returned non-JSON response ({resp.status_code} "
                        f"{ctype or 'no content-type'}, {len(resp.content)} bytes, "
                        f"x-cache={resp.headers.get('x-cache')!r})."
                    )
                if resp.is_error:
                    raise WordPressError(f"{resp.status_code}: {resp.text}")
                if page == 1:
                    total_pages = int(resp.headers.get("x-wp-totalpages", "1") or "1")
                results.extend(resp.json())
                if page >= total_pages:
                    break
                page += 1
            return results
        finally:
            if own:
                await client.aclose()

    async def list_categories(self) -> list[WpCategory]:
        rows = await self._list_paginated(
            "/wp-json/wp/v2/categories",
            extra_params={"hide_empty": "false"},
        )
        return [WpCategory(id=int(r["id"]), name=r["name"], slug=r["slug"]) for r in rows]

    async def list_users(self) -> list[WpUser]:
        rows = await self._list_paginated("/wp-json/wp/v2/users")
        return [WpUser(id=int(r["id"]), name=r["name"], slug=r["slug"]) for r in rows]

    async def _get_single(self, path: str) -> dict[str, object] | None:
        """GET a single WP resource. Returns None on 404, raises WordPressError otherwise.

        Applies the same CloudFront/WAF guard as the list/fetch helpers: a 2xx
        response with non-JSON content (typically the AWS WAF challenge page)
        is surfaced as an explicit upstream error rather than a JSONDecodeError.
        """
        own = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self._timeout)
        try:
            headers = {"authorization": self._auth_header()}
            resp = await client.get(
                f"{self._base_url}{path}",
                params={"_fields": "id,name,slug"},
                headers=headers,
            )
            if resp.status_code == 404:
                return None
            ctype = resp.headers.get("content-type", "")
            if not ctype.lower().startswith("application/json") or not resp.content:
                raise WordPressError(
                    f"WP REST returned non-JSON response ({resp.status_code} "
                    f"{ctype or 'no content-type'}, {len(resp.content)} bytes, "
                    f"x-cache={resp.headers.get('x-cache')!r}) — likely a "
                    f"CloudFront/origin outage."
                )
            if resp.is_error:
                raise WordPressError(f"{resp.status_code}: {resp.text}")
            return resp.json()
        finally:
            if own:
                await client.aclose()

    async def get_user(self, user_id: int) -> WpUser | None:
        row = await self._get_single(f"/wp-json/wp/v2/users/{user_id}")
        if row is None:
            return None
        return WpUser(id=int(row["id"]), name=str(row["name"]), slug=str(row["slug"]))

    async def get_category(self, category_id: int) -> WpCategory | None:
        row = await self._get_single(f"/wp-json/wp/v2/categories/{category_id}")
        if row is None:
            return None
        return WpCategory(
            id=int(row["id"]), name=str(row["name"]), slug=str(row["slug"])
        )
