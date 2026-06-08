# ruff: noqa: RUF001 (assertions embed 繁體中文 prompt text with fullwidth punctuation)
import pytest

from content_tool.policy.source_policy import SourcePolicy


@pytest.fixture
def policy() -> SourcePolicy:
    return SourcePolicy.load_from("config/source_policy.yaml")


def test_bowtie_is_denied(policy: SourcePolicy) -> None:
    d = policy.evaluate("bowtie.com.hk", topic_category=None)
    assert d.decision == "denied"
    assert d.reason == "bowtie_owned"


def test_competitor_is_denied(policy: SourcePolicy) -> None:
    d = policy.evaluate("manulife.com.hk", topic_category=None)
    assert d.decision == "denied"
    assert d.reason == "competitor"


def test_gov_hk_is_allowed(policy: SourcePolicy) -> None:
    d = policy.evaluate("www.ia.org.hk", topic_category=None)
    assert d.decision == "allowed"


def test_gov_tld_is_allowed(policy: SourcePolicy) -> None:
    d = policy.evaluate("nih.gov", topic_category=None)
    assert d.decision == "allowed"


def test_community_denied_when_no_exception(policy: SourcePolicy) -> None:
    d = policy.evaluate("reddit.com", topic_category=None)
    assert d.decision == "denied"


def test_community_allowed_with_exception(policy: SourcePolicy) -> None:
    d = policy.evaluate("reddit.com", topic_category="community-response")
    assert d.decision == "community_exception"


def test_unknown_domain_is_allowed(policy: SourcePolicy) -> None:
    d = policy.evaluate("some-medical-journal.org", topic_category=None)
    assert d.decision == "allowed"


def test_subdomain_treated_as_apex(policy: SourcePolicy) -> None:
    d = policy.evaluate("blog.bowtie.com.hk", topic_category=None)
    assert d.decision == "denied"
    assert d.reason == "bowtie_owned"


def test_denied_tld_blocks_matching_source() -> None:
    policy = SourcePolicy({"deny": {"tlds": [".cn"]}})
    d = policy.evaluate("https://example.com.cn/page", topic_category=None)
    assert d.decision == "denied"
    assert d.reason == "other"
    assert d.matched_rule == "denied-tld:cn"


def test_denied_tld_leaves_other_sources_allowed() -> None:
    policy = SourcePolicy({"deny": {"tlds": ["cn"]}})
    assert policy.evaluate("who.int", topic_category=None).decision == "allowed"


def test_empty_deny_tlds_does_not_change_prompt_block() -> None:
    base = SourcePolicy.load_from("config/source_policy.yaml")
    assert "額外硬性禁止" not in base.to_prompt_block()


def test_denied_tld_rendered_in_prompt_block() -> None:
    policy = SourcePolicy({"deny": {"tlds": [".cn", "ru"]}})
    block = policy.to_prompt_block()
    assert "額外硬性禁止" in block
    assert "cn / ru" in block


def test_prompt_block_template_substitutes_tokens() -> None:
    policy = SourcePolicy(
        {
            "prefer": {"tlds": [".gov.hk"], "domains": ["who.int", "ia.org.hk"]},
            "community_exception": {
                "topic_categories": ["community-response"],
                "allowed_domains": ["reddit.com"],
            },
            "prompt_block": (
                "RULES TLD={prefer_tlds} ORG={prefer_domains} "
                "CAT={community_categories} FORUM={community_domains}"
            ),
        }
    )
    block = policy.to_prompt_block()
    # prefer.domains is sorted, joined by 、; the rest are joined verbatim.
    expected = "RULES TLD=.gov.hk ORG=ia.org.hk、who.int CAT=community-response FORUM=reddit.com"
    assert block == expected


def test_prompt_block_template_overrides_default_prose() -> None:
    policy = SourcePolicy({"prompt_block": "只有這一行。"})
    block = policy.to_prompt_block()
    assert block == "只有這一行。"
    # The hard-coded default prose must not leak through.
    assert "引用與資料來源規則" not in block


def test_prompt_block_denied_tlds_line_token_present_when_set() -> None:
    policy = SourcePolicy(
        {"deny": {"tlds": [".cn"]}, "prompt_block": "A\n{denied_tlds_line}\nB"}
    )
    block = policy.to_prompt_block()
    assert block == "A\n- 額外硬性禁止：不可引用屬於以下頂級域名（TLD）的來源：cn。\nB"


def test_prompt_block_denied_tlds_line_token_empty_consumes_newline() -> None:
    # With no denied TLDs the token + its trailing newline vanish, leaving no
    # blank line behind.
    policy = SourcePolicy({"prompt_block": "A\n{denied_tlds_line}\nB"})
    assert policy.to_prompt_block() == "A\nB"


def test_whitespace_only_prompt_block_falls_back_to_default() -> None:
    # A whitespace-only template is stripped to "" and renders the default block.
    policy = SourcePolicy({"prompt_block": "   \n  "})
    assert "引用與資料來源規則" in policy.to_prompt_block()
