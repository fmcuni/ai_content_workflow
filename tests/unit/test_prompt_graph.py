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
    expected = {"audit", "gap_analysis", "outline_rewrite_mode",
                "writer_small_refresh", "writer_full_rewrite"}
    found: set[str] = set()
    for n in PROMPT_GRAPH["nodes"]:
        if n.get("system_prompt_template_id"):
            found.add(n["system_prompt_template_id"])
        for alt in n.get("alt_template_ids", []) or []:
            found.add(alt)
    assert expected.issubset(found)


def test_writer_is_one_node_with_both_templates():
    writer_nodes = [n for n in PROMPT_GRAPH["nodes"] if n["id"] == "writer"]
    assert len(writer_nodes) == 1
    w = writer_nodes[0]
    assert w["system_prompt_template_id"] == "writer_small_refresh"
    assert w.get("alt_template_ids") == ["writer_full_rewrite"]
