from datetime import date

from content_tool.models.state import ContentToolState


def test_state_accepts_minimal_input():
    s: ContentToolState = {
        "run_id": "00000000-0000-0000-0000-000000000000",
        "article_url": "https://e.com",
        "topic": "x",
        "keywords": ["a"],
        "mode": "auto",
        "edit_note": None,
        "acf_adv_id": 1,
        "acf_widget_id": 2,
        "persona": "bowtie-editor",
        "topic_category": None,
        "today_date": date(2026, 5, 21).isoformat(),
        "existing_article_markdown": None,
        "wp_post_id": None,
        "wp_categories": None,
        "gap_analysis": None,
        "outline": None,
        "chosen_route": None,
        "writer_output": None,
        "grounding_chunks": None,
        "citations": None,
        "render": None,
        "final_markup": None,
        "audit_findings": None,
        "iteration": 0,
        "hitl_1_decision": None,
        "hitl_1_edits": None,
        "hitl_2_decision": None,
        "hitl_2_notes": None,
        "status": "pending",
        "error": None,
    }
    assert s["run_id"].startswith("0000")
