import json
import re
from dataclasses import dataclass
from uuid import UUID

from markdown_it import MarkdownIt
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.db.models import Draft, Render


@dataclass
class RenderResult:
    seo_title: str
    meta_description: str
    html_body: str
    faq_schema_jsonld: dict | None
    excerpt_suggestion: str
    slug_suggestion: str


_META_RE = re.compile(r"^%%meta desc=(.*?)%%\s*$", re.MULTILINE)
_ADV_RE = re.compile(r"%%adv_panel id=(\d+)%%")
_WIDGET_RE = re.compile(r"%%page_widget id=(\d+)%%")
# Tolerate leading spaces/tabs around the delimiter lines so writers can nest
# these blocks inside markdown lists (which require 2+ leading spaces) without
# silently dropping the schema. `[ \t]*` — not `\s*` — so we don't gobble blank
# lines between independent blocks.
_FAQ_BLOCK_RE = re.compile(
    r"%%acf_faq type=q%%[ \t]*\n(.*?)\n[ \t]*%%acf_faq type=a%%[ \t]*\n(.*?)\n[ \t]*%%end%%",
    re.DOTALL,
)
# %%defterm name=<term>%%\n<description>\n%%end%%
# `name` is a single token (no spaces / quotes) per the writer-prompt contract.
# Newlines around the description are optional: writers sometimes inline the
# whole block inside CJK quotes (e.g. 「%%defterm name=X%%desc%%end%%」), and
# we'd rather strip cleanly than leak raw markers into the published HTML.
_DEFTERM_BLOCK_RE = re.compile(
    r"%%defterm name=(\S+?)%%[ \t]*\n?[ \t]*(.*?)[ \t]*\n?[ \t]*%%end%%",
    re.DOTALL,
)
# Catches any residual marker fragment after well-formed blocks were stripped.
# If the writer emitted a half-broken shortcode (open without close, or vice
# versa), refuse to render rather than publish literal `%%defterm…` to WordPress.
_DEFTERM_RESIDUE_RE = re.compile(r"%%defterm\b|%%end%%")


def _build_faq_html(items: list[tuple[str, str]]) -> str:
    if not items:
        return ""
    parts: list[str] = ['<div class="editor__item editor__faq">', '  <div class="e-faq__wrap">']
    for i, (q, a) in enumerate(items):
        active = " is--active" if i == 0 else ""
        body_style = ' style="display: block;"' if i == 0 else ""
        head = (
            f'      <div class="e-faq__head">{q}'
            '<span class="e-faq__icon icon-add"></span></div>'
        )
        parts.extend(
            [
                f'    <div class="e-faq__list{active}">',
                head,
                f'      <div class="e-faq__body"{body_style}>',
                f"        <p>{a}</p>",
                "      </div>",
                "    </div>",
            ]
        )
    parts.extend(["  </div>", "</div>"])
    return "\n".join(parts)


def _build_faq_jsonld(items: list[tuple[str, str]]) -> dict:
    return {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
            {
                "@type": "Question",
                "name": q,
                "acceptedAnswer": {"@type": "Answer", "text": a},
            }
            for q, a in items
        ],
    }


def _build_defterm_jsonld(items: list[tuple[str, str]]) -> dict:
    return {
        "@context": "https://schema.org",
        "@type": "DefinedTermSet",
        "hasDefinedTerm": [
            {"@type": "DefinedTerm", "name": name, "description": desc}
            for name, desc in items
        ],
    }


def _check_no_raw_html(markdown_body: str) -> None:
    """Refuse if writer somehow emitted a raw <script> or other dangerous tag."""
    if re.search(r"<\s*(script|style|iframe|object|embed)\b", markdown_body, re.IGNORECASE):
        raise ValueError("html sanitization failed: writer emitted disallowed raw tag")


def render_html(markdown: str) -> RenderResult:
    lines = markdown.splitlines()
    # H1 = first line starting with '# '
    if not lines or not lines[0].startswith("# "):
        raise ValueError("first markdown line must be '# H1'")
    seo_title = lines[0][2:].strip()

    rest = "\n".join(lines[1:])

    meta_m = _META_RE.search(rest)
    if not meta_m:
        raise ValueError("missing %%meta desc=...%% line")
    meta_description = meta_m.group(1).strip()
    rest = _META_RE.sub("", rest, count=1).lstrip()

    # Sanitization gate (run BEFORE we transform anything writer-controlled)
    _check_no_raw_html(rest)

    # Extract FAQ items, then strip FAQ shortcodes from rest
    faq_items = [(q.strip(), a.strip()) for q, a in _FAQ_BLOCK_RE.findall(rest)]
    rest = _FAQ_BLOCK_RE.sub("", rest)
    # Remove "## 常見問題" line if it's followed only by what was FAQ
    rest = re.sub(r"##\s*常見問題\s*\n", "", rest)

    # Split off the auto-generated "## 資訊來源" section so it can be re-ordered
    # to appear AFTER the FAQ widget in the final HTML.
    sources_md = ""
    sources_split = re.search(r"\n##\s*資訊來源\s*\n", rest)
    if sources_split is not None:
        sources_md = rest[sources_split.start():].lstrip("\n")
        rest = rest[: sources_split.start()]

    # Extract DefinedTerm items, dedup by name (first occurrence wins),
    # then strip the shortcodes so they don't survive into the visible HTML.
    # Block form (newlines around description) → strip entirely; the term
    # already appears in the surrounding paragraph text. Inline form (writer
    # wrapped the whole block inside e.g. 「…」 CJK quotes) → replace with just
    # the term name so the visible sentence keeps its referent instead of
    # collapsing to empty quotes.
    defterm_items: list[tuple[str, str]] = []
    _seen_defterm_names: set[str] = set()

    def _consume_defterm(match: re.Match[str]) -> str:
        name = match.group(1).strip()
        desc = match.group(2).strip()
        if name and name not in _seen_defterm_names:
            _seen_defterm_names.add(name)
            defterm_items.append((name, desc))
        return name if "\n" not in match.group(0) else ""

    rest = _DEFTERM_BLOCK_RE.sub(_consume_defterm, rest)
    # Belt-and-braces: if ANY half-formed defterm marker survived the regex
    # (open without close, malformed name, stray %%end%%, etc.), refuse to
    # render. Better to fail the publish step than ship literal markers to
    # readers — the writer node will surface the failure and HITL_2 can hold.
    residue = _DEFTERM_RESIDUE_RE.search(rest)
    if residue is not None:
        snippet = rest[max(0, residue.start() - 20) : residue.end() + 20]
        raise ValueError(
            f"render: unhandled defterm marker survived stripping near: {snippet!r}"
        )

    # Markdown → HTML (without FAQ block; we'll inject)
    md = MarkdownIt("commonmark").enable(["table"])
    body_html = md.render(rest)

    # Replace shortcodes (after MD rendering — they survive as raw text inside <p>)
    body_html = _ADV_RE.sub(lambda m: f'[adv_panel id="{m.group(1)}"]', body_html)
    body_html = _WIDGET_RE.sub(lambda m: f'[page_widget id="{m.group(1)}"]', body_html)

    # FAQ widget + JSON-LD
    faq_html = _build_faq_html(faq_items)
    faq_jsonld = _build_faq_jsonld(faq_items) if faq_items else None
    defterm_jsonld = _build_defterm_jsonld(defterm_items) if defterm_items else None

    jsonld_blocks: list[str] = []
    for obj in (faq_jsonld, defterm_jsonld):
        if obj is None:
            continue
        jsonld_blocks.append(
            '<script type="application/ld+json">\n'
            + json.dumps(obj, ensure_ascii=False, indent=2)
            + "\n</script>"
        )
    jsonld_script = ("\n".join(jsonld_blocks) + "\n") if jsonld_blocks else ""

    final = jsonld_script + body_html
    if faq_html:
        final += "\n<h2>常見問題</h2>\n" + faq_html + "\n"
    if sources_md:
        final += "\n" + md.render(sources_md)

    # Excerpt: first <p>... text, ≤160 chars
    p_match = re.search(r"<p>(.*?)</p>", body_html, re.DOTALL)
    excerpt = p_match.group(1)[:160] if p_match else ""
    slug_suggestion = ""  # preserved-by-default for updates; left empty here

    return RenderResult(
        seo_title=seo_title,
        meta_description=meta_description,
        html_body=final,
        faq_schema_jsonld=faq_jsonld,
        excerpt_suggestion=excerpt,
        slug_suggestion=slug_suggestion,
    )


async def run_render_html(
    *, session: AsyncSession, draft_id: UUID,
) -> RenderResult:
    draft = (await session.execute(select(Draft).where(Draft.draft_id == draft_id))).scalar_one()
    md = draft.final_markup or draft.markup_raw
    result = render_html(md)
    # Idempotency: LangGraph can re-enter the production sub-graph (resume,
    # retry, refine loop) and call this node twice for the same draft. Without
    # this DELETE we accumulate duplicate Render rows for one draft and the
    # downstream audit ``scalar_one()`` on ``Render.draft_id`` blows up with
    # MultipleResultsFound. The Render schema does not (yet) enforce a unique
    # constraint on ``draft_id``, so enforce single-row semantics here.
    await session.execute(delete(Render).where(Render.draft_id == draft_id))
    session.add(Render(
        draft_id=draft_id,
        seo_title=result.seo_title,
        meta_description=result.meta_description,
        html_body=result.html_body,
        faq_schema_jsonld=result.faq_schema_jsonld,
        excerpt_suggestion=result.excerpt_suggestion,
        slug_suggestion=result.slug_suggestion,
    ))
    await session.commit()
    return result
