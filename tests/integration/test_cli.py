from click.testing import CliRunner

from content_tool.cli import main


def test_help_works():
    runner = CliRunner()
    result = runner.invoke(main, ["--help"])
    assert result.exit_code == 0
    assert "gap-analysis" in result.output
