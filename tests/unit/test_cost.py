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


def test_cost_calculator_handles_refresh_scan_inputs():
    """Sanity guard: estimate_cents works for typical refresh_scan token volumes.

    Uses the fake client's default token counts scaled up to produce ≥1 cent:
    10_000 tokens_in at $0.30/M + 5_000 tokens_out at $2.50/M
    = 0.003 + 0.0125 = 0.0155 USD = 1 cent (int truncation).
    """
    calc = CostCalculator.load_from("config/pricing.yaml")
    cents = calc.estimate_cents(
        model="gemini-3.5-flash",
        tokens_in=10_000,
        tokens_out=5_000,
        thinking_tokens=0,
    )
    assert cents > 0
