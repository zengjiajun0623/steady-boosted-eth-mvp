#!/usr/bin/env python3
"""Compare continuous versus standardized strikes and maturities.

Liquidity needs standardization. This script asks how much performance we lose
when we replace idealized continuous strikes/maturities with a small grid that
market makers and N buyers can actually concentrate around.
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
class StandardConfig:
    name: str
    strike_increment_usd: float | None
    monthly_expiry: bool
    min_maturity_days: int = 45


def standard_strike(ideal: float, increment: float | None) -> float:
    if increment is None or increment <= 0:
        return ideal
    return max(increment, math.floor(ideal / increment) * increment)


def first_monthly_expiry_index(candles: list[Candle], start_index: int, min_days: int) -> int:
    start_day = candles[start_index].day
    for i in range(start_index + 1, len(candles)):
        day = candles[i].day
        if (day - start_day).days >= min_days and day.day <= 3:
            return i
    return min(len(candles) - 1, start_index + min_days)


def choose_maturity(candles: list[Candle], start_index: int, strategy: Strategy, config: StandardConfig) -> int:
    if config.monthly_expiry:
        return first_monthly_expiry_index(candles, start_index, config.min_maturity_days)
    return maturity_index_for(start_index, strategy.maturity_days, len(candles))


def simulate_config(
    candles: list[Candle],
    strategy: Strategy,
    config: StandardConfig,
    initial_usd: float,
    trade_cost_bps: float,
) -> dict[str, float | int | str]:
    n = len(candles)
    spot0 = candles[0].close
    ideal_strike0 = choose_strike(spot0, strategy.strike_factor)
    strike0 = standard_strike(ideal_strike0, config.strike_increment_usd)
    maturity0 = choose_maturity(candles, 0, strategy, config)
    price0 = p_price_usd(spot0, strike0, maturity0, strategy.iv)
    pos = Position(initial_usd / price0, strike0, maturity0)

    values: list[float] = []
    daily_returns: list[float] = []
    strike_slippage: list[float] = []
    maturity_days_samples: list[int] = []
    roll_count = 0
    danger_rolls = 0
    cumulative_cost = 0.0
    previous_value = initial_usd

    for i, candle in enumerate(candles):
        days_left = max(pos.maturity_index - i, 0)
        old_price = p_price_usd(candle.close, pos.strike, days_left, strategy.iv)
        value = pos.units * old_price
        values.append(value)
        if i > 0:
            daily_returns.append(value / previous_value - 1.0)
        previous_value = value

        is_last = i == n - 1
        danger = candle.close < pos.strike * strategy.danger_factor
        too_close_to_maturity = days_left <= strategy.roll_before_days
        if is_last or not (danger or too_close_to_maturity):
            continue

        new_factor = strategy.reset_factor if danger else strategy.strike_factor
        ideal_new_strike = choose_strike(candle.close, new_factor)
        new_strike = standard_strike(ideal_new_strike, config.strike_increment_usd)
        new_maturity = choose_maturity(candles, i, strategy, config)
        new_price = p_price_usd(candle.close, new_strike, new_maturity - i, strategy.iv)

        cost = trade_cost_bps / 10_000.0
        net_proceeds = value * (1.0 - cost)
        new_units = net_proceeds / (new_price * (1.0 + cost))
        cumulative_cost += value - net_proceeds + (new_units * new_price * cost)

        strike_slippage.append(new_strike / ideal_new_strike - 1.0)
        maturity_days_samples.append(new_maturity - i)
        roll_count += 1
        danger_rolls += int(danger)
        pos = Position(new_units, new_strike, new_maturity)

    years = max((candles[-1].day - candles[0].day).days / 365.25, 1 / 365.25)
    final_value = values[-1]
    peak = values[0]
    max_dd = 0.0
    for value in values:
        peak = max(peak, value)
        max_dd = max(max_dd, 1.0 - value / peak)

    return {
        "config": config.name,
        "final_ratio": final_value / initial_usd,
        "cagr": (final_value / initial_usd) ** (1.0 / years) - 1.0,
        "min_ratio": min(values) / initial_usd,
        "max_drawdown": max_dd,
        "annual_vol": statistics.pstdev(daily_returns) * math.sqrt(365.25) if len(daily_returns) > 1 else 0.0,
        "rolls": roll_count,
        "danger_rolls": danger_rolls,
        "cost_ratio": cumulative_cost / initial_usd,
        "avg_strike_slippage": statistics.fmean(strike_slippage) if strike_slippage else 0.0,
        "worst_strike_slippage": min(strike_slippage) if strike_slippage else 0.0,
        "avg_maturity_days": statistics.fmean(maturity_days_samples) if maturity_days_samples else 0.0,
    }


def default_configs() -> list[StandardConfig]:
    return [
        StandardConfig("continuous", None, False),
        StandardConfig("$25 strikes", 25.0, False),
        StandardConfig("$50 strikes", 50.0, False),
        StandardConfig("$100 strikes", 100.0, False),
        StandardConfig("$250 strikes", 250.0, False),
        StandardConfig("$50 + monthly", 50.0, True),
        StandardConfig("$100 + monthly", 100.0, True),
        StandardConfig("$250 + monthly", 250.0, True),
    ]


def print_table(results: list[dict[str, float | int | str]]) -> None:
    headers = [
        "config",
        "final",
        "CAGR",
        "min",
        "maxDD",
        "vol",
        "rolls",
        "danger",
        "cost",
        "avg strike",
        "worst strike",
        "avg mat",
    ]
    print(" | ".join(headers))
    print(" | ".join("-" * len(h) for h in headers))
    for r in results:
        row = [
            str(r["config"]),
            f"{float(r['final_ratio']):.3f}x",
            pct(float(r["cagr"])),
            f"{float(r['min_ratio']):.3f}x",
            pct(float(r["max_drawdown"])),
            pct(float(r["annual_vol"])),
            str(r["rolls"]),
            str(r["danger_rolls"]),
            pct(float(r["cost_ratio"])),
            pct(float(r["avg_strike_slippage"])),
            pct(float(r["worst_strike_slippage"])),
            f"{float(r['avg_maturity_days']):.1f}d",
        ]
        print(" | ".join(row))


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
    results = [
        simulate_config(candles, strategy, config, args.initial_usd, args.cost_bps)
        for config in default_configs()
    ]

    print(f"Data: ETH-USD daily close, {candles[0].day.isoformat()} to {candles[-1].day.isoformat()}")
    print(f"Strategy: conservative Steady ETH, fixed roll cost {args.cost_bps:g} bps per side")
    print()
    print_table(results)


if __name__ == "__main__":
    main()

