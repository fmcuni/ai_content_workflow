from content_tool.api.prompt_graph import PROMPT_GRAPH


def test_graph_has_both_subgraphs():
    sub = {n["sub_graph"] for n in PROMPT_GRAPH["nodes"]}
    assert {"strategy", "production"}.issubset(sub)


def test_persona_bound_agents_are_writer_and_audit():
    bound = {n["id"] for n in PROMPT_GRAPH["nodes"] if n.get("uses_persona")}
    assert bound == {"writer", "audit"}


def test_hitl_gates_present():
    gates = {g["id"] for g in PROMPT_GRAPH["gates"]}
    assert gates == {"HITL_1", "HITL_2"}


def test_template_ids_match_prompt_files():
    expected = {"audit", "gap_analysis", "outline",
                "writer_small_refresh", "writer_full_rewrite"}
    found = {n["system_prompt_template_id"]
             for n in PROMPT_GRAPH["nodes"]
             if n.get("system_prompt_template_id")}
    assert expected.issubset(found)
