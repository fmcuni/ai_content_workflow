import subprocess
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import async_sessionmaker

from content_tool.db.models import Eval


def current_commit_sha() -> str:
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()  # noqa: S607
    except Exception:
        return "unknown"


async def record_eval(
    sf: async_sessionmaker,  # type: ignore[type-arg]
    *,
    metric: str,
    fixture_id: str,
    score: float | None,
    passed: bool,
    judge_notes: dict[str, object] | None = None,
    run_id: UUID | None = None,
) -> None:
    sha = current_commit_sha()
    async with sf() as session:
        session.add(Eval(
            eval_id=uuid4(), metric=metric, fixture_id=fixture_id, run_id=run_id,
            score=score, pass_=passed, judge_notes=judge_notes, commit_sha=sha,
        ))
        await session.commit()
