import asyncio
import json
from datetime import date
from uuid import uuid4

import click

from content_tool.agents.gap_analysis import run_gap_analysis
from content_tool.config import get_settings
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.db.models import Run
from content_tool.gemini.client import RealGeminiClient


@click.group()
def main() -> None:
    """Bowtie AI Content Tool CLI."""


@main.command("gap-analysis")
@click.option("--article-url", required=True)
@click.option("--topic", required=True)
@click.option("--keywords", required=True, help="Comma-separated")
@click.option(
    "--mode",
    type=click.Choice(["auto", "small_refresh", "full_rewrite"]),
    default="auto",
)
@click.option("--acf-adv-id", type=int, default=1)
@click.option("--acf-widget-id", type=int, default=1)
@click.option("--persona", default="bowtie-editor")
@click.option("--editor-email", default="cli@bowtie.local")
@click.option("--edit-note", default=None)
def gap_analysis_cmd(
    article_url: str,
    topic: str,
    keywords: str,
    mode: str,
    acf_adv_id: int,
    acf_widget_id: int,
    persona: str,
    editor_email: str,
    edit_note: str | None,
) -> None:
    """Run gap_analysis against an article."""
    asyncio.run(
        _run(
            article_url=article_url,
            topic=topic,
            keywords=[k.strip() for k in keywords.split(",")],
            mode=mode,
            acf_adv_id=acf_adv_id,
            acf_widget_id=acf_widget_id,
            persona=persona,
            editor_email=editor_email,
            edit_note=edit_note,
        )
    )


async def _run(
    *,
    article_url: str,
    topic: str,
    keywords: list[str],
    mode: str,
    acf_adv_id: int,
    acf_widget_id: int,
    persona: str,
    editor_email: str,
    edit_note: str | None,
) -> None:
    settings = get_settings()
    engine = make_engine(settings.postgres_url)
    sf = make_session_factory(engine)

    gemini = RealGeminiClient(
        api_key=settings.gemini_api_key,
        model=settings.gemini_model,
        thinking_level=settings.gemini_thinking_level,
    )

    async with sf() as session:
        run_id = uuid4()
        session.add(
            Run(
                run_id=run_id,
                created_by=editor_email,
                status="strategy",
                article_url=article_url,
                topic=topic,
                keywords=keywords,
                mode=mode,
                edit_note=edit_note,
                acf_adv_id=acf_adv_id,
                acf_widget_id=acf_widget_id,
                persona=persona,
                today_date=date.today(),
            )
        )
        await session.commit()

        ga = await run_gap_analysis(
            session=session, gemini=gemini, run_id=run_id, today=date.today()
        )

    click.echo(
        json.dumps(
            {
                "run_id": str(run_id),
                "chosen_route": ga.chosen_route,
                "route_reason": ga.route_reason,
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    await engine.dispose()
