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
