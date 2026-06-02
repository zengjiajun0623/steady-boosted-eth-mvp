#!/usr/bin/env python3
"""Rough open-interest caps for deterministic onchain TWAP settlement.

If settlement is defined as a Uniswap TWAP, the trust point becomes market
manipulation risk. This script estimates how much spot distortion and capital
would be required to bias a TWAP by a target amount.

This is not a precise Uniswap v3 attack-cost model. Real v3 cost depends on the
liquidity distribution across ticks, arbitrage, fees, block control, and market
conditions. The goal is to produce conservative launch caps and identify which
parameters matter.
"""

from __future__ import annotations

import argparse
import math
from dataclasses import dataclass

from sim import usd


def compact_usd(value: float) -> str:
    if not math.isfinite(value):
        return "inf"
    abs_value = abs(value)
    if abs_value >= 1e15:
        return f"${value:.2e}"
    if abs_value >= 1e9:
        return f"${value / 1e9:,.2f}B"
    if abs_value >= 1e6:
        return f"${value / 1e6:,.2f}M"
    return usd(value)


def compact_factor(value: float) -> str:
    if not math.isfinite(value):
        return "inf"
    if value >= 1e9:
        return f"{value:.2e}x"
    return f"{value:,.2f}x"


@dataclass(frozen=True)
class Scenario:
    window_seconds: int
    control_seconds: int
    target_twap_bps: float


def quote_reserve_from_one_pct_depth(depth_1pct_usd: float) -> float:
    """Infer constant-product quote reserve from cost to move price up 1%."""
    return depth_1pct_usd / (math.sqrt(1.01) - 1.0)


def required_spot_factor(target_twap_bps: float, control_seconds: int, window_seconds: int) -> float:
    """For geometric TWAP, g = f^(control/window), so f = g^(window/control)."""
    twap_factor = 1.0 + target_twap_bps / 10_000.0
    fraction = max(control_seconds / window_seconds, 1e-12)
    try:
        return twap_factor ** (1.0 / fraction)
    except OverflowError:
        return float("inf")


def cp_upward_trade_usd(quote_reserve_usd: float, spot_factor: float) -> float:
    """USDC input needed to move a constant-product pool price up by spot_factor."""
    if not math.isfinite(spot_factor):
        return float("inf")
    return quote_reserve_usd * (math.sqrt(spot_factor) - 1.0)


def format_duration(seconds: int) -> str:
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m"
    if seconds < 86400:
        return f"{seconds // 3600}h"
    return f"{seconds // 86400}d"


def print_table(depth_1pct_usd: float, target_bps: list[float], safety_factor: float) -> None:
    quote_reserve = quote_reserve_from_one_pct_depth(depth_1pct_usd)
    windows = [24 * 3600, 72 * 3600]
    controls = [12, 60, 5 * 60, 30 * 60, 3600, 6 * 3600, 24 * 3600]

    print(f"Assumed 1% upward move depth: {compact_usd(depth_1pct_usd)}")
    print(f"Implied constant-product quote reserve: {compact_usd(quote_reserve)}")
    print(f"Safety factor for suggested cap: {safety_factor:g}x")
    print()

    headers = [
        "window",
        "control",
        "TWAP bias",
        "spot factor",
        "trade capital",
        "suggested cap",
    ]
    print(" | ".join(headers))
    print(" | ".join("-" * len(h) for h in headers))

    for window in windows:
        for control in controls:
            if control > window:
                continue
            for bps in target_bps:
                factor = required_spot_factor(bps, control, window)
                capital = cp_upward_trade_usd(quote_reserve, factor)
                cap = capital / safety_factor
                factor_text = compact_factor(factor)
                capital_text = compact_usd(capital)
                cap_text = compact_usd(cap)
                row = [
                    format_duration(window),
                    format_duration(control),
                    f"{bps:.0f} bps",
                    factor_text,
                    capital_text,
                    cap_text,
                ]
                print(" | ".join(row))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--depth-1pct",
        default=10_000_000.0,
        type=float,
        help="Approximate USDC needed to move the settlement pool price up 1%.",
    )
    parser.add_argument(
        "--target-bps",
        default="50,100,500",
        help="Comma-separated TWAP bias targets in basis points.",
    )
    parser.add_argument(
        "--safety-factor",
        default=10.0,
        type=float,
        help="Suggested open-interest cap is capital / safety_factor.",
    )
    args = parser.parse_args()

    target_bps = [float(x.strip()) for x in args.target_bps.split(",") if x.strip()]
    print_table(args.depth_1pct, target_bps, args.safety_factor)


if __name__ == "__main__":
    main()
