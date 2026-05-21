from content_tool.observability.cost import CostCalculator


def test_calculates_cost_usd_cents():
    c = CostCalculator.load_from("config/pricing.yaml")
    cents = c.estimate_cents(
        model="gemini-3.5-flash", tokens_in=100_000, tokens_out=20_000, thinking_tokens=5_000
    )
    # 100_000/1e6 * 0.30 = 0.03   USD
    # 20_000/1e6 * 2.50  = 0.05   USD
    # 5_000/1e6 * 2.50   = 0.0125 USD
    # total              = 0.0925 USD = 9.25 cents → 9 (int)
    assert cents == 9
