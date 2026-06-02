#!/usr/bin/env python3
"""RLP balance-sheet simulator.

RLP means "Roll Liquidity Provider": an HLP-like vault whose job is to make
P -> P' rolls cheap for the Steady vault.

The key question here is not whether a roll can be priced in theory. It is how
much RLP balance sheet, outside N demand, and risk budget are needed before the
roll can clear under roughly 10 bps per side.
"""

from __future__ import annotations

import argparse
import math
import statistics
from dataclasses import dataclass
from datetime import date

from sim import (
    DATA_DIR,
    Candle,
    Position,
    Strategy,
    choose_strike,
    load_yahoo_eth_usd,
    maturity_index_for,
    p_price_usd,
    parse_day,
    pct,
    usd,
)
from roll_market import conservative_strategy


@dataclass(frozen=True)
class RLPScenario:
    name: str
    capital_ratio: float
    n_external_fill: float
    old_p_external_fill: float = 0.25
    risk_budget_fraction: float = 0.40
    old_p_risk_weight: float = 0.35
    n_risk_weight: float = 1.0
    base_bps: float = 3.0
    impact_bps: float = 20.0
    stress_bps: float = 60.0


@dataclass(frozen=True)
class Quote:
    per_side_bps: float
    required_risk_usd: float
    capacity_usd: float
    utilization: float
    new_n_value_usd: float
    old_p_risk_usd: float
    breach: bool


def n_price_usd(spot: float, strike: float, p_price: float) -> float:
    collateral_value = spot / strike
    return max(0.0, collateral_value - p_price)


def quote_roll(
    old_value_usd: float,
    new_units: float,
    spot: float,
    new_strike: float,
    new_p_price: float,
    scenario: RLPScenario,
    steady_aum_usd: float,
) -> Quote:
    """Estimate how expensive RLP quotes a roll given its balance-sheet use."""

    rlp_capital = steady_aum_usd * scenario.capital_ratio
    capacity = max(rlp_capital * scenario.risk_budget_fraction, 1.0)
    new_n_value = new_units * n_price_usd(spot, new_strike, new_p_price)
    old_p_risk = old_value_usd * (1.0 - scenario.old_p_external_fill) * scenario.old_p_risk_weight
    n_risk = new_n_value * (1.0 - scenario.n_external_fill) * scenario.n_risk_weight
    required = old_p_risk + n_risk
    utilization = required / capacity
    bps = scenario.base_bps + scenario.impact_bps * math.sqrt(max(utilization, 0.0))
    if utilization > 1.0:
        bps += scenario.stress_bps * (utilization - 1.0) ** 2
    return Quote(
        per_side_bps=bps,
        required_risk_usd=required,
        capacity_usd=capacity,
        utilization=utilization,
        new_n_value_usd=new_n_value,
        old_p_risk_usd=old_p_risk,
        breach=utilization > 1.0,
    )


def simulate_rlp(
    candles: list[Candle],
    strategy: Strategy,
    scenario: RLPScenario,
    initial_usd: float,
) -> dict[str, float | int | str]:
    if len(candles) < 2:
        raise ValueError("need at least two candles")

    n = len(candles)
    spot0 = candles[0].close
    strike0 = choose_strike(spot0, strategy.strike_factor)
    maturity0 = maturity_index_for(0, strategy.maturity_days, n)
    price0 = p_price_usd(spot0, strike0, maturity0, strategy.iv)
    pos = Position(initial_usd / price0, strike0, maturity0)

    values: list[float] = []
    daily_returns: list[float] = []
    bps_samples: list[float] = []
    weighted_bps_numer = 0.0
    weighted_bps_denom = 0.0
    utilization_samples: list[float] = []
    required_samples: list[float] = []
    n_inventory_samples: list[float] = []
    roll_count = 0
    danger_rolls = 0
    breaches = 0
    cumulative_trade_cost = 0.0

    previous_value = initial_usd
    peak = initial_usd
    max_drawdown = 0.0

    for i, candle in enumerate(candles):
        days_left = max(pos.maturity_index - i, 0)
        old_price = p_price_usd(candle.close, pos.strike, days_left, strategy.iv)
        value = pos.units * old_price
        values.append(value)

        if i > 0:
            daily_returns.append(value / previous_value - 1.0)
        previous_value = value
        peak = max(peak, value)
        if peak > 0:
            max_drawdown = max(max_drawdown, 1.0 - value / peak)

        is_last = i == n - 1
        danger = candle.close < pos.strike * strategy.danger_factor
        too_close_to_maturity = days_left <= strategy.roll_before_days
        if is_last or not (danger or too_close_to_maturity):
            continue

        new_factor = strategy.reset_factor if danger else strategy.strike_factor
        new_strike = choose_strike(candle.close, new_factor)
        new_maturity = maturity_index_for(i, strategy.maturity_days, n)
        new_days_left = max(new_maturity - i, 0)
        new_price = p_price_usd(candle.close, new_strike, new_days_left, strategy.iv)
        gross_new_units = value / new_price
        quote = quote_roll(
            old_value_usd=value,
            new_units=gross_new_units,
            spot=candle.close,
            new_strike=new_strike,
            new_p_price=new_price,
            scenario=scenario,
            steady_aum_usd=initial_usd,
        )

        cost = quote.per_side_bps / 10_000.0
        net_proceeds = value * (1.0 - cost)
        new_units = net_proceeds / (new_price * (1.0 + cost))
        trade_cost = value - net_proceeds + (new_units * new_price * cost)
        cumulative_trade_cost += trade_cost

        bps_samples.append(quote.per_side_bps)
        weighted_bps_numer += quote.per_side_bps * value
        weighted_bps_denom += value
        utilization_samples.append(quote.utilization)
        required_samples.append(quote.required_risk_usd)
        n_inventory_samples.append(quote.new_n_value_usd * (1.0 - scenario.n_external_fill))
        breaches += int(quote.breach)
        roll_count += 1
        danger_rolls += int(danger)
        pos = Position(new_units, new_strike, new_maturity)

    final_value = values[-1]
    years = max((candles[-1].day - candles[0].day).days / 365.25, 1 / 365.25)
    cagr = (final_value / initial_usd) ** (1.0 / years) - 1.0
    daily_vol = statistics.pstdev(daily_returns) if len(daily_returns) > 1 else 0.0
    tracking_rmse = math.sqrt(statistics.fmean([(v / initial_usd - 1.0) ** 2 for v in values]))

    return {
        "scenario": scenario.name,
        "aum": initial_usd,
        "capital_ratio": scenario.capital_ratio,
        "n_external_fill": scenario.n_external_fill,
        "final_ratio": final_value / initial_usd,
        "cagr": cagr,
        "min_ratio": min(values) / initial_usd,
        "max_drawdown": max_drawdown,
        "annual_vol": daily_vol * math.sqrt(365.25),
        "tracking_rmse": tracking_rmse,
        "rolls": roll_count,
        "danger_rolls": danger_rolls,
        "avg_bps": statistics.fmean(bps_samples) if bps_samples else 0.0,
        "weighted_bps": weighted_bps_numer / weighted_bps_denom if weighted_bps_denom else 0.0,
        "max_bps": max(bps_samples) if bps_samples else 0.0,
        "avg_utilization": statistics.fmean(utilization_samples) if utilization_samples else 0.0,
        "max_utilization": max(utilization_samples) if utilization_samples else 0.0,
        "avg_required_risk": statistics.fmean(required_samples) if required_samples else 0.0,
        "max_required_risk": max(required_samples) if required_samples else 0.0,
        "avg_unsold_n": statistics.fmean(n_inventory_samples) if n_inventory_samples else 0.0,
        "max_unsold_n": max(n_inventory_samples) if n_inventory_samples else 0.0,
        "breaches": breaches,
        "trade_cost_ratio": cumulative_trade_cost / initial_usd,
    }


def default_scenarios() -> list[RLPScenario]:
    scenarios: list[RLPScenario] = []
    for capital_ratio in (1.0, 3.0, 10.0):
        for n_fill in (0.0, 0.5, 0.8, 0.95):
            scenarios.append(
                RLPScenario(
                    name=f"{capital_ratio:g}x-cap|N{int(n_fill * 100)}",
                    capital_ratio=capital_ratio,
                    n_external_fill=n_fill,
                )
            )
    return scenarios


def print_table(results: list[dict[str, float | int | str]]) -> None:
    headers = [
        "AUM",
        "scenario",
        "final",
        "CAGR",
        "wAvg bps",
        "max bps",
        "avg util",
        "max util",
        "breach",
        "avg req",
        "avg unsold N",
    ]
    print(" | ".join(headers))
    print(" | ".join("-" * len(h) for h in headers))
    for r in results:
        row = [
            usd(float(r["aum"])),
            str(r["scenario"]),
            f"{float(r['final_ratio']):.3f}x",
            pct(float(r["cagr"])),
            f"{float(r['weighted_bps']):.1f}",
            f"{float(r['max_bps']):.1f}",
            f"{float(r['avg_utilization']):.2f}x",
            f"{float(r['max_utilization']):.2f}x",
            str(r["breaches"]),
            usd(float(r["avg_required_risk"])),
            usd(float(r["avg_unsold_n"])),
        ]
        print(" | ".join(row))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2018-01-01", type=parse_day)
    parser.add_argument("--end", default=date.today().isoformat(), type=parse_day)
    parser.add_argument("--iv", default=0.9, type=float)
    parser.add_argument(
        "--aum",
        default="1000000,10000000",
        help="Comma-separated Steady vault sizes in USD.",
    )
    args = parser.parse_args()

    cache_path = DATA_DIR / f"eth-usd-{args.start.isoformat()}-{args.end.isoformat()}.csv"
    candles = load_yahoo_eth_usd(args.start, args.end, cache_path)
    strategy = conservative_strategy(args.iv)
    aums = [float(x.strip()) for x in args.aum.split(",") if x.strip()]

    results: list[dict[str, float | int | str]] = []
    for aum in aums:
        for scenario in default_scenarios():
            results.append(simulate_rlp(candles, strategy, scenario, aum))

    print(f"Data: ETH-USD daily close, {candles[0].day.isoformat()} to {candles[-1].day.isoformat()}")
    print(f"Strategy: {strategy.name}, immediate RLP rolls")
    print("RLP quote model: bps = 3 + 20 * sqrt(required risk / risk budget), with stress penalty over budget")
    print()
    print_table(results)


if __name__ == "__main__":
    main()

