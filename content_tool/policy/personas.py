from pathlib import Path

import yaml

from content_tool.models.persona import PersonaPack


def load_persona(name: str, base_dir: Path = Path("config/personas")) -> PersonaPack:
    path = base_dir / f"{name}.yaml"
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    return PersonaPack.model_validate(raw)
