#!/usr/bin/env python3
"""RLP inventory risk simulator.

This extends rlp_sim.py from "can RLP quote the roll?" to "what happens to
RLP's own NAV if it warehouses the residual inventory?"

Inventory sources:

1. Old P that RLP buys from the Steady vault and cannot immediately resell.
2. New paired N created when RLP originates safer P and cannot sell all of N.

The model marks this inventory to the same rough option prices used elsewhere.
It is intentionally approximate, but it helps identify whether RLP risk is
mostly spread business or a disguised long-convexity balance sheet.
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
    choose_strike,
    load_yahoo_eth_usd,
    maturity_index_for,
    p_price_usd,
    parse_day,
    pct,
    usd,
)
from roll_market import conservative_strategy
from rlp_sim import RLPScenario, default_scenarios, n_price_usd, quote_roll


@dataclass
class InventoryLot:
    kind: str
    units: float
    strike: float
    maturity_index: int
    cost_per_unit: float


def lot_value(lot: InventoryLot, candle: Candle, index: int, iv: float) -> float:
    days_left = max(lot.maturity_index - index, 0)
    if lot.kind == "P":
        price = p_price_usd(candle.close, lot.strike, days_left, iv)
    elif lot.kind == "N":
        p_price = p_price_usd(candle.close, lot.strike, days_left, iv)
        price = n_price_usd(candle.close, lot.strike, p_price)
    else:
        raise ValueError(f"unknown lot kind {lot.kind}")
    return lot.units * price


def lot_cost(lot: InventoryLot) -> float:
    return lot.units * lot.cost_per_unit


def simulate_rlp_risk(
    candles: list[Candle],
    scenario: RLPScenario,
    initial_usd: float,
    iv: float,
) -> dict[str, float | int | str]:
    strategy = conservative_strategy(iv)
    n = len(candles)
    rlp_capital = initial_usd * scenario.capital_ratio

    spot0 = candles[0].close
    strike0 = choose_strike(spot0, strategy.strike_factor)
    maturity0 = maturity_index_for(0, strategy.maturity_days, n)
    price0 = p_price_usd(spot0, strike0, maturity0, strategy.iv)
    pos = Position(initial_usd / price0, strike0, maturity0)

    lots: list[InventoryLot] = []
    navs: list[float] = []
    spread_revenue = 0.0
    weighted_bps_numer = 0.0
    weighted_bps_denom = 0.0
    breaches = 0
    roll_count = 0
    danger_rolls = 0
    max_inventory_mark = 0.0
    max_n_mark = 0.0

    for i, candle in enumerate(candles):
        lots = [lot for lot in lots if lot.maturity_index >= i]
        inventory_mark = sum(lot_value(lot, candle, i, strategy.iv) for lot in lots)
        inventory_cost = sum(lot_cost(lot) for lot in lots)
        n_mark = sum(lot_value(lot, candle, i, strategy.iv) for lot in lots if lot.kind == "N")
        max_inventory_mark = max(max_inventory_mark, inventory_mark)
        max_n_mark = max(max_n_mark, n_mark)
        navs.append(rlp_capital + spread_revenue + inventory_mark - inventory_cost)

        days_left = max(pos.maturity_index - i, 0)
        old_price = p_price_usd(candle.close, pos.strike, days_left, strategy.iv)
        value = pos.units * old_price

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
        spread_revenue += value - net_proceeds + (new_units * new_price * cost)

        old_p_units = pos.units * (1.0 - scenario.old_p_external_fill)
        if old_p_units > 0:
            lots.append(
                InventoryLot(
                    kind="P",
                    units=old_p_units,
                    strike=pos.strike,
                    maturity_index=pos.maturity_index,
                    cost_per_unit=old_price,
                )
            )

        new_n_units = gross_new_units * (1.0 - scenario.n_external_fill)
        if new_n_units > 0:
            new_n_price = n_price_usd(candle.close, new_strike, new_price)
            lots.append(
                InventoryLot(
                    kind="N",
                    units=new_n_units,
                    strike=new_strike,
                    maturity_index=new_maturity,
                    cost_per_unit=new_n_price,
                )
            )

        weighted_bps_numer += quote.per_side_bps * value
        weighted_bps_denom += value
        breaches += int(quote.breach)
        roll_count += 1
        danger_rolls += int(danger)
        pos = Position(new_units, new_strike, new_maturity)

    peak = navs[0]
    max_drawdown = 0.0
    for nav in navs:
        peak = max(peak, nav)
        max_drawdown = max(max_drawdown, 1.0 - nav / peak)

    daily_returns = [navs[i] / navs[i - 1] - 1.0 for i in range(1, len(navs)) if navs[i - 1] > 0]
    final_nav = navs[-1]
    inventory_mark = sum(lot_value(lot, candles[-1], len(candles) - 1, strategy.iv) for lot in lots)
    inventory_cost = sum(lot_cost(lot) for lot in lots)
    inventory_pnl = inventory_mark - inventory_cost

    return {
        "scenario": scenario.name,
        "aum": initial_usd,
        "rlp_capital": rlp_capital,
        "final_nav_ratio": final_nav / rlp_capital,
        "pnl_ratio": (final_nav - rlp_capital) / rlp_capital,
        "max_drawdown": max_drawdown,
        "annual_vol": (statistics.pstdev(daily_returns) * math.sqrt(365.25)) if len(daily_returns) > 1 else 0.0,
        "spread_ratio": spread_revenue / rlp_capital,
        "inventory_pnl_ratio": inventory_pnl / rlp_capital,
        "max_inventory_ratio": max_inventory_mark / rlp_capital,
        "max_n_ratio": max_n_mark / rlp_capital,
        "weighted_bps": weighted_bps_numer / weighted_bps_denom if weighted_bps_denom else 0.0,
        "rolls": roll_count,
        "danger_rolls": danger_rolls,
        "breaches": breaches,
    }


def print_table(results: list[dict[str, float | int | str]]) -> None:
    headers = [
        "AUM",
        "scenario",
        "RLP PnL",
        "maxDD",
        "annVol",
        "spread",
        "invPnL",
        "maxInv",
        "maxN",
        "wAvg bps",
        "breach",
    ]
    print(" | ".join(headers))
    print(" | ".join("-" * len(h) for h in headers))
    for r in results:
        row = [
            usd(float(r["aum"])),
            str(r["scenario"]),
            pct(float(r["pnl_ratio"])),
            pct(float(r["max_drawdown"])),
            pct(float(r["annual_vol"])),
            pct(float(r["spread_ratio"])),
            pct(float(r["inventory_pnl_ratio"])),
            pct(float(r["max_inventory_ratio"])),
            pct(float(r["max_n_ratio"])),
            f"{float(r['weighted_bps']):.1f}",
            str(r["breaches"]),
        ]
        print(" | ".join(row))


def selected_scenarios() -> list[RLPScenario]:
    names = {"1x-cap|N95", "3x-cap|N80", "3x-cap|N95", "10x-cap|N80", "10x-cap|N95"}
    return [scenario for scenario in default_scenarios() if scenario.name in names]


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
    aums = [float(x.strip()) for x in args.aum.split(",") if x.strip()]

    results: list[dict[str, float | int | str]] = []
    for aum in aums:
        for scenario in selected_scenarios():
            results.append(simulate_rlp_risk(candles, scenario, aum, args.iv))

    print(f"Data: ETH-USD daily close, {candles[0].day.isoformat()} to {candles[-1].day.isoformat()}")
    print("RLP risk: spread revenue plus mark-to-market of residual old-P and unsold-N inventory")
    print()
    print_table(results)


if __name__ == "__main__":
    main()

