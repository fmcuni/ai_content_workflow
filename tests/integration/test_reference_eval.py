from pathlib import Path

from content_tool.models.gap_analysis import GapAnalysis
from evals.reference import evaluate_route_accuracy


def _make_ga(route: str) -> GapAnalysis:
    return GapAnalysis.model_validate(
        {
            "target_query": "x",
            "top_pages": [
                {"url": f"https://e.com/{i}", "title": "t", "rank": i + 1} for i in range(5)
            ],
            "current_article_assessment": {
                "strengths": [],
                "outdated_points": [],
                "weak_sections": [],
                "structure_status": "still_competitive",
            },
            "content_gaps": {
                "missing_topics": [],
                "missing_intents": [],
                "freshness_gaps": [],
                "semantic_gaps": [],
                "source_trust_gaps": [],
                "ai_extractability_gaps": [],
                "hk_localization_gaps": [],
                "faq_gaps": [],
            },
            "recommended_outline": "x",
            "update_plan": {
                "must_add": [],
                "must_update": [],
                "must_remove": [],
                "must_reorder": [],
                "faq_to_add": [],
                "facts_to_verify": [],
            },
            "chosen_route": route,
            "route_reason": "x",
        }
    )


def test_route_eval_accuracy_perfect():
    preds = {
        "https://www.bowtie.com.hk/blog/cancer-1": _make_ga("small_refresh"),
        "https://www.bowtie.com.hk/blog/vhis-1": _make_ga("full_rewrite"),
        "https://www.bowtie.com.hk/blog/dental-1": _make_ga("small_refresh"),
    }
    r = evaluate_route_accuracy(preds, Path("evals/fixtures/gold_labels/route.csv"))
    assert r.total == 3
    assert r.correct == 3
    assert r.accuracy == 1.0
    assert r.misses == []


def test_route_eval_accuracy_one_miss():
    preds = {
        "https://www.bowtie.com.hk/blog/cancer-1": _make_ga("full_rewrite"),  # wrong
        "https://www.bowtie.com.hk/blog/vhis-1": _make_ga("full_rewrite"),
        "https://www.bowtie.com.hk/blog/dental-1": _make_ga("small_refresh"),
    }
    r = evaluate_route_accuracy(preds, Path("evals/fixtures/gold_labels/route.csv"))
    assert r.correct == 2
    assert len(r.misses) == 1
