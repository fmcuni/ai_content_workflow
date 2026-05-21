import csv
from dataclasses import dataclass
from pathlib import Path

from content_tool.models.gap_analysis import GapAnalysis


@dataclass
class RouteEvalResult:
    total: int
    correct: int
    accuracy: float
    misses: list[dict[str, str]]


def evaluate_route_accuracy(predictions: dict[str, GapAnalysis], gold_csv: Path) -> RouteEvalResult:
    """`predictions` keyed by article_url. Returns route-accuracy summary."""
    misses: list[dict[str, str]] = []
    total = 0
    correct = 0
    with open(gold_csv, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            url = row["article_url"]
            if url not in predictions:
                continue
            total += 1
            predicted = predictions[url].chosen_route
            gold = row["gold_route"]
            if predicted == gold:
                correct += 1
            else:
                misses.append({"url": url, "predicted": predicted, "gold": gold})
    accuracy = correct / total if total else 0.0
    return RouteEvalResult(total=total, correct=correct, accuracy=accuracy, misses=misses)
