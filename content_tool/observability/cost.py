from dataclasses import dataclass
from pathlib import Path

import yaml


@dataclass
class CostCalculator:
    prices: dict[str, dict[str, float]]

    @classmethod
    def load_from(cls, path: str | Path) -> "CostCalculator":
        raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
        return cls(prices=raw)

    def estimate_cents(
        self, *, model: str, tokens_in: int, tokens_out: int, thinking_tokens: int
    ) -> int:
        p = self.prices.get(model)
        if not p:
            return 0
        usd = (
            (tokens_in / 1_000_000) * p["input_per_million_usd"]
            + (tokens_out / 1_000_000) * p["output_per_million_usd"]
            + (thinking_tokens / 1_000_000) * p["thinking_per_million_usd"]
        )
        return int(usd * 100)
