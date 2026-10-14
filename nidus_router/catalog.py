"""Reviewed standard text rates, never inferred from names or remote price metadata.

Exact IDs only. Extend with an official source and adapter tests; complex/tiered
prices stay unknown. verified_at is a review date, not a provider effective date.
"""
from datetime import date

OFFICIAL = {
    "openai": {"https://api.openai.com/v1"},
    "anthropic": {"https://api.anthropic.com/v1"},
    "gemini": {"https://generativelanguage.googleapis.com/v1beta", "https://generativelanguage.googleapis.com/v1"},
}
SOURCES = {
    "openai": "https://developers.openai.com/api/docs/models/",
    "anthropic": "https://platform.claude.com/docs/en/about-claude/pricing",
    "gemini": "https://ai.google.dev/gemini-api/docs/pricing",
}
# USD per million standard, uncached text tokens; output includes thinking tokens.
RATES = {
    "openai": {"gpt-4.1-mini": (0.4, 1.6, False), "gpt-4o-mini": (0.15, 0.6, False),
               "gpt-5-mini": (0.25, 2, False), "gpt-5-nano": (0.05, 0.4, False)},
    "anthropic": {"claude-haiku-4-5": (1, 5, False), "claude-haiku-4-5-20251001": (1, 5, False),
                  "claude-sonnet-4-6": (3, 15, False)},
    "gemini": {"gemini-2.5-flash": (0.3, 2.5, True), "gemini-2.5-flash-lite": (0.1, 0.4, True)},
}
VERIFIED = "2026-10-14"


def quote(connection, upstream, today=None):
    kind = connection["provider"]
    rate = RATES.get(kind, {}).get(upstream)
    if not rate or connection["base_url"] not in OFFICIAL.get(kind, set()):
        return None
    # This release has no announced end date for these standard prices.
    if (today or date.today()).isoformat() < VERIFIED:
        return None
    inp, out, free = rate
    tier = connection.get("billing_tier", "unconfirmed")
    pricing = "free" if free and tier == "free" else "paid"
    if (free and tier == "unconfirmed") or (tier == "free" and not free):
        pricing = "unknown"
    return {"pricing": pricing, "input_per_million": inp, "output_per_million": out,
            "price_source": SOURCES[kind] + (upstream if kind == "openai" else ""),
            "price_verified_at": VERIFIED, "price_valid_from": VERIFIED, "price_valid_until": None,
            "free_tier_available": free}


def supported(kind, upstream):
    return upstream in RATES.get(kind, {})


def model_status(model, connection, settings):
    if not model["enabled"] or not connection["enabled"]:
        return "disabled"
    if model.get("availability", "available") != "available":
        return "connection_required"
    if model.get("support", "supported") != "supported":
        return "support_required"
    if model["pricing"] == "unknown" or (model["pricing"] == "paid" and any(
            model[k] is None for k in ("input_per_million", "output_per_million"))):
        return "unknown_pricing"
    if model["pricing"] == "paid" and (model["id"] not in settings["approved_model_ids"]
                                      or settings["monthly_budget_usd"] <= 0):
        return "approval_required"
    return "available"
