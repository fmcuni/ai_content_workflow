from pathlib import Path

import yaml

from content_tool.models.persona import PersonaPack

_DEFAULT_PERSONA_DIR = Path(__file__).resolve().parents[2] / "config" / "personas"


def load_persona(name: str, base_dir: Path = _DEFAULT_PERSONA_DIR) -> PersonaPack:
    path = base_dir / f"{name}.yaml"
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    return PersonaPack.model_validate(raw)
