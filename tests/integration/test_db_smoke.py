import pytest
from sqlalchemy import text


@pytest.mark.asyncio
async def test_db_has_content_tool_schema(db_session):
    result = await db_session.execute(text(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'content_tool'"
    ))
    names = {row[0] for row in result}
    assert "runs" in names
    assert "gap_analyses" in names
