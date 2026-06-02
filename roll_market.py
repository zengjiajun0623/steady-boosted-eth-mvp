#!/usr/bin/env python3
"""Explore roll-market designs for options-based index tracking.

This script asks a narrower question than sim.py:

    How cheap does the roll venue need to be, and how much depth does it need?

It models delayed roll intents. A strategy can signal that it wants to rotate
from the current P_K into a safer P_K'. The roll then executes after a venue
specific waiting period, unless maturity forces an earlier execution. Waiting
does not get future-aware price selection; it just gives the venue more time to
source liquidity and reduce impact.
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


@dataclass(frozen=True)
class Venue:
    name: str
    wait_days: int
    base_bps: float
    daily_depth_usd: float
    impact_bps_at_depth: float


@dataclass
class PendingRoll:
    signal_index: int
    execute_index: int
    reason: str


@dataclass
class RollExecution:
    position: Position
    trade_cost_usd: float
    per_side_bps: float
    delay_days: int
    danger_roll: bool
    maturity_roll: bool


def execution_bps(notional_usd: float, venue: Venue, actual_wait_days: int) -> float:
    """Per-side execution cost in bps."""
    depth_multiplier = max(1, actual_wait_days + 1)
    effective_depth = max(venue.daily_depth_usd * depth_multiplier, 1.0)
    impact = venue.impact_bps_at_depth * math.sqrt(max(notional_usd, 0.0) / effective_depth)
    return venue.base_bps + impact


def execute_roll(
    pos: Position,
    candle: Candle,
    index: int,
    pending: PendingRoll,
    strategy: Strategy,
    venue: Venue,
    n: int,
) -> RollExecution:
    days_left = max(pos.maturity_index - index, 0)
    old_price = p_price_usd(candle.close, pos.strike, days_left, strategy.iv)
    current_danger = candle.close < pos.strike * strategy.danger_factor
    new_factor = strategy.reset_factor if current_danger else strategy.strike_factor
    new_strike = choose_strike(candle.close, new_factor)
    new_maturity = maturity_index_for(index, strategy.maturity_days, n)
    new_days_left = max(new_maturity - index, 0)
    new_price = p_price_usd(candle.close, new_strike, new_days_left, strategy.iv)

    gross_proceeds = pos.units * old_price
    actual_wait = index - pending.signal_index
    per_side_bps = execution_bps(gross_proceeds, venue, actual_wait)
    cost = per_side_bps / 10_000.0
    net_proceeds = gross_proceeds * (1.0 - cost)
    new_units = net_proceeds / (new_price * (1.0 + cost))
    trade_cost = gross_proceeds - net_proceeds + (new_units * new_price * cost)

    return RollExecution(
        position=Position(new_units, new_strike, new_maturity),
        trade_cost_usd=trade_cost,
        per_side_bps=per_side_bps,
        delay_days=actual_wait,
        danger_roll=current_danger or pending.reason == "danger",
        maturity_roll=not current_danger and pending.reason == "maturity",
    )


def conservative_strategy(iv: float = 0.9) -> Strategy:
    return Strategy(
        name=f"conservative|iv{int(iv * 100)}",
        strike_factor=2.0,
        danger_factor=1.5,
        reset_factor=4.0,
        maturity_days=60,
        roll_before_days=14,
        iv=iv,
        trade_cost_bps=0.0,
    )


def default_venues(depth_scale: float = 1.0) -> list[Venue]:
    return [
        Venue(
            name="thin-amm",
            wait_days=0,
            base_bps=15.0,
            daily_depth_usd=250_000 * depth_scale,
            impact_bps_at_depth=90.0,
        ),
        Venue(
            name="rfq-1d",
            wait_days=1,
            base_bps=5.0,
            daily_depth_usd=1_000_000 * depth_scale,
            impact_bps_at_depth=35.0,
        ),
        Venue(
            name="batch-3d",
            wait_days=3,
            base_bps=3.0,
            daily_depth_usd=2_500_000 * depth_scale,
            impact_bps_at_depth=20.0,
        ),
        Venue(
            name="deep-batch-7d",
            wait_days=7,
            base_bps=2.0,
            daily_depth_usd=7_500_000 * depth_scale,
            impact_bps_at_depth=12.0,
        ),
    ]


def simulate_venue(
    candles: list[Candle],
    strategy: Strategy,
    venue: Venue,
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
    pending: PendingRoll | None = None

    values: list[float] = []
    daily_returns: list[float] = []
    bps_samples: list[float] = []
    delays: list[int] = []
    roll_count = 0
    danger_rolls = 0
    maturity_rolls = 0
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

        if i == n - 1:
            continue

        if pending is not None and i >= pending.execute_index:
            execution = execute_roll(pos, candle, i, pending, strategy, venue, n)
            cumulative_trade_cost += execution.trade_cost_usd
            bps_samples.append(execution.per_side_bps)
            delays.append(execution.delay_days)
            roll_count += 1
            danger_rolls += int(execution.danger_roll)
            maturity_rolls += int(execution.maturity_roll)
            pos = execution.position
            pending = None
            continue

        if pending is not None:
            continue

        danger = candle.close < pos.strike * strategy.danger_factor
        too_close_to_maturity = days_left <= strategy.roll_before_days
        if not (danger or too_close_to_maturity):
            continue

        reason = "danger" if danger else "maturity"
        last_safe_index = max(i, min(pos.maturity_index - 1, n - 1))
        execute_index = min(i + venue.wait_days, last_safe_index)
        pending = PendingRoll(i, execute_index, reason)
        if pending.execute_index <= i:
            execution = execute_roll(pos, candle, i, pending, strategy, venue, n)
            cumulative_trade_cost += execution.trade_cost_usd
            bps_samples.append(execution.per_side_bps)
            delays.append(execution.delay_days)
            roll_count += 1
            danger_rolls += int(execution.danger_roll)
            maturity_rolls += int(execution.maturity_roll)
            pos = execution.position
            pending = None

    final_value = values[-1]
    years = max((candles[-1].day - candles[0].day).days / 365.25, 1 / 365.25)
    cagr = (final_value / initial_usd) ** (1.0 / years) - 1.0
    daily_vol = statistics.pstdev(daily_returns) if len(daily_returns) > 1 else 0.0
    annual_vol = daily_vol * math.sqrt(365.25)
    tracking_rmse = math.sqrt(statistics.fmean([(v / initial_usd - 1.0) ** 2 for v in values]))
    avg_bps = statistics.fmean(bps_samples) if bps_samples else 0.0
    max_bps = max(bps_samples) if bps_samples else 0.0
    avg_delay = statistics.fmean(delays) if delays else 0.0

    return {
        "venue": venue.name,
        "initial_usd": initial_usd,
        "final_usd": final_value,
        "final_ratio": final_value / initial_usd,
        "cagr": cagr,
        "min_ratio": min(values) / initial_usd,
        "max_drawdown": max_drawdown,
        "annual_vol": annual_vol,
        "tracking_rmse": tracking_rmse,
        "rolls": roll_count,
        "danger_rolls": danger_rolls,
        "maturity_rolls": maturity_rolls,
        "trade_cost_usd": cumulative_trade_cost,
        "trade_cost_ratio": cumulative_trade_cost / initial_usd,
        "avg_bps": avg_bps,
        "max_bps": max_bps,
        "avg_delay": avg_delay,
    }


def print_results(results: list[dict[str, float | int | str]]) -> None:
    headers = [
        "AUM",
        "venue",
        "final",
        "CAGR",
        "min",
        "maxDD",
        "RMSE",
        "rolls",
        "avg bps",
        "max bps",
        "cost",
        "delay",
    ]
    print(" | ".join(headers))
    print(" | ".join("-" * len(h) for h in headers))
    for r in results:
        row = [
            usd(float(r["initial_usd"])),
            str(r["venue"]),
            f"{float(r['final_ratio']):.3f}x",
            pct(float(r["cagr"])),
            f"{float(r['min_ratio']):.3f}x",
            pct(float(r["max_drawdown"])),
            pct(float(r["tracking_rmse"])),
            str(r["rolls"]),
            f"{float(r['avg_bps']):.1f}",
            f"{float(r['max_bps']):.1f}",
            pct(float(r["trade_cost_ratio"])),
            f"{float(r['avg_delay']):.1f}d",
        ]
        print(" | ".join(row))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2018-01-01", type=parse_day)
    parser.add_argument("--end", default=date.today().isoformat(), type=parse_day)
    parser.add_argument("--iv", default=0.9, type=float)
    parser.add_argument(
        "--aum",
        default="100000,1000000,10000000",
        help="Comma-separated initial portfolio sizes in USD.",
    )
    parser.add_argument(
        "--depth-scale",
        default=1.0,
        type=float,
        help="Multiplier applied to every venue's assumed daily depth.",
    )
    args = parser.parse_args()

    cache_path = DATA_DIR / f"eth-usd-{args.start.isoformat()}-{args.end.isoformat()}.csv"
    candles = load_yahoo_eth_usd(args.start, args.end, cache_path)
    strategy = conservative_strategy(args.iv)
    aums = [float(x.strip()) for x in args.aum.split(",") if x.strip()]
    venues = default_venues(args.depth_scale)

    results: list[dict[str, float | int | str]] = []
    for aum in aums:
        for venue in venues:
            results.append(simulate_venue(candles, strategy, venue, aum))

    print(f"Data: ETH-USD daily close, {candles[0].day.isoformat()} to {candles[-1].day.isoformat()}")
    print(f"Strategy: {strategy.name}, strike=spot/2, danger=1.5x strike, reset=spot/4")
    print(f"Depth scale: {args.depth_scale:g}")
    print()
    print_results(results)


if __name__ == "__main__":
    main()
