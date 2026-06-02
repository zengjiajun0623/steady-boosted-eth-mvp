#!/usr/bin/env python3
"""Create user-facing risk bands for the Steady ETH product.

The goal is to translate the option-roll machinery into language a user can
understand:

    "How steady was this historically versus just holding ETH?"

This script compares a fixed-cost Steady strategy against holding ETH over
30/90/180 day horizons.
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
class SeriesResult:
    steady_values: list[float]
    eth_values: list[float]
    roll_costs: list[float]
    roll_count: int
    danger_roll_count: int


def quantile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * q)))
    return ordered[index]


def max_drawdown(values: list[float]) -> float:
    peak = values[0]
    worst = 0.0
    for value in values:
        peak = max(peak, value)
        if peak > 0:
            worst = max(worst, 1.0 - value / peak)
    return worst


def annual_vol(values: list[float]) -> float:
    returns = [values[i] / values[i - 1] - 1.0 for i in range(1, len(values)) if values[i - 1] > 0]
    if len(returns) < 2:
        return 0.0
    return statistics.pstdev(returns) * math.sqrt(365.25)


def rolling_returns(values: list[float], horizon_days: int) -> list[float]:
    returns: list[float] = []
    for i in range(0, len(values) - horizon_days):
        if values[i] > 0:
            returns.append(values[i + horizon_days] / values[i] - 1.0)
    return returns


def simulate_series(
    candles: list[Candle],
    strategy: Strategy,
    initial_usd: float,
    trade_cost_bps: float,
) -> SeriesResult:
    n = len(candles)
    spot0 = candles[0].close
    strike0 = choose_strike(spot0, strategy.strike_factor)
    maturity0 = maturity_index_for(0, strategy.maturity_days, n)
    price0 = p_price_usd(spot0, strike0, maturity0, strategy.iv)
    pos = Position(initial_usd / price0, strike0, maturity0)

    steady_values: list[float] = []
    eth_values: list[float] = []
    roll_costs: list[float] = []
    roll_count = 0
    danger_roll_count = 0

    for i, candle in enumerate(candles):
        days_left = max(pos.maturity_index - i, 0)
        old_price = p_price_usd(candle.close, pos.strike, days_left, strategy.iv)
        value = pos.units * old_price
        steady_values.append(value)
        eth_values.append(initial_usd * candle.close / spot0)

        is_last = i == n - 1
        danger = candle.close < pos.strike * strategy.danger_factor
        too_close_to_maturity = days_left <= strategy.roll_before_days
        if is_last or not (danger or too_close_to_maturity):
            continue

        new_factor = strategy.reset_factor if danger else strategy.strike_factor
        new_strike = choose_strike(candle.close, new_factor)
        new_maturity = maturity_index_for(i, strategy.maturity_days, n)
        new_price = p_price_usd(candle.close, new_strike, new_maturity - i, strategy.iv)

        cost = trade_cost_bps / 10_000.0
        gross_proceeds = pos.units * old_price
        net_proceeds = gross_proceeds * (1.0 - cost)
        new_units = net_proceeds / (new_price * (1.0 + cost))
        roll_costs.append(gross_proceeds - net_proceeds + (new_units * new_price * cost))
        roll_count += 1
        danger_roll_count += int(danger)
        pos = Position(new_units, new_strike, new_maturity)

    return SeriesResult(steady_values, eth_values, roll_costs, roll_count, danger_roll_count)


def print_balance_band(label: str, values: list[float], initial_usd: float) -> None:
    ratios = [value / initial_usd for value in values]
    print(label)
    print(f"  median balance: {quantile(ratios, 0.50):.3f}x")
    print(f"  10th / 90th percentile balance: {quantile(ratios, 0.10):.3f}x / {quantile(ratios, 0.90):.3f}x")
    print(f"  worst balance: {min(ratios):.3f}x")
    print(f"  max drawdown: {pct(max_drawdown(values))}")
    print(f"  annualized volatility: {pct(annual_vol(values))}")


def print_horizon(label: str, values: list[float], horizons: list[int]) -> None:
    print(label)
    for horizon in horizons:
        returns = rolling_returns(values, horizon)
        print(
            f"  {horizon:3d}d: "
            f"p05 {pct(quantile(returns, 0.05))}, "
            f"p25 {pct(quantile(returns, 0.25))}, "
            f"median {pct(quantile(returns, 0.50))}, "
            f"p75 {pct(quantile(returns, 0.75))}, "
            f"p95 {pct(quantile(returns, 0.95))}"
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2018-01-01", type=parse_day)
    parser.add_argument("--end", default=date.today().isoformat(), type=parse_day)
    parser.add_argument("--iv", default=0.9, type=float)
    parser.add_argument("--cost-bps", default=10.0, type=float)
    parser.add_argument("--initial-usd", default=1000.0, type=float)
    args = parser.parse_args()

    cache_path = DATA_DIR / f"eth-usd-{args.start.isoformat()}-{args.end.isoformat()}.csv"
    candles = load_yahoo_eth_usd(args.start, args.end, cache_path)
    strategy = conservative_strategy(args.iv)
    series = simulate_series(candles, strategy, args.initial_usd, args.cost_bps)

    print(f"Data: ETH-USD daily close, {candles[0].day.isoformat()} to {candles[-1].day.isoformat()}")
    print(f"Strategy: conservative Steady ETH, fixed roll cost {args.cost_bps:g} bps per side")
    print(f"Initial balance: {usd(args.initial_usd)}")
    print(f"Rolls: {series.roll_count}, danger rolls: {series.danger_roll_count}")
    print(f"Total roll costs: {usd(sum(series.roll_costs))}")
    print()
    print_balance_band("Steady ETH balance band", series.steady_values, args.initial_usd)
    print()
    print_balance_band("Plain ETH hold balance band", series.eth_values, args.initial_usd)
    print()
    print_horizon("Steady ETH rolling returns", series.steady_values, [30, 90, 180])
    print()
    print_horizon("Plain ETH rolling returns", series.eth_values, [30, 90, 180])


if __name__ == "__main__":
    main()

