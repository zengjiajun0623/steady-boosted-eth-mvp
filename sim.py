#!/usr/bin/env python3
"""Backtest ETH-backed option rolls for index-tracking assets.

The simulator models a dollar-normalized P_K token:

    payoff_usd = min(1, ETHUSD / K)

That is equivalent to 1 USD minus 1/K of an ETH put struck at K. We use a
Black-Scholes put as a rough market-price proxy so the strategy can roll before
maturity. This should be treated as a research approximation, not a protocol
oracle requirement.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import statistics
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path


DATA_DIR = Path(__file__).resolve().parent / "data"


@dataclass(frozen=True)
class Candle:
    day: date
    close: float


@dataclass(frozen=True)
class Strategy:
    name: str
    strike_factor: float
    danger_factor: float
    reset_factor: float
    maturity_days: int
    roll_before_days: int
    iv: float
    trade_cost_bps: float


@dataclass
class Position:
    units: float
    strike: float
    maturity_index: int


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def bs_put(spot: float, strike: float, years: float, vol: float, rate: float = 0.0) -> float:
    """Black-Scholes European put price in USD."""
    if years <= 0:
        return max(strike - spot, 0.0)
    if vol <= 0:
        forward = spot * math.exp(rate * years)
        return math.exp(-rate * years) * max(strike - forward, 0.0)

    sqrt_t = math.sqrt(years)
    d1 = (math.log(spot / strike) + (rate + 0.5 * vol * vol) * years) / (vol * sqrt_t)
    d2 = d1 - vol * sqrt_t
    return strike * math.exp(-rate * years) * norm_cdf(-d2) - spot * norm_cdf(-d1)


def p_price_usd(spot: float, strike: float, days_to_maturity: int, iv: float) -> float:
    """Market proxy for one dollar-normalized P_K unit."""
    years = max(days_to_maturity, 0) / 365.25
    put = bs_put(spot, strike, years, iv)
    price = 1.0 - put / strike
    collateral_value = spot / strike
    return max(0.0, min(price, collateral_value, 1.0))


def maturity_index_for(start_index: int, maturity_days: int, n: int) -> int:
    return min(n - 1, start_index + maturity_days)


def load_yahoo_eth_usd(start: date, end: date, cache_path: Path) -> list[Candle]:
    """Fetch ETH-USD daily candles from Yahoo Finance chart API."""
    if cache_path.exists():
        return read_candles(cache_path, start, end)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    period1 = int(datetime(start.year, start.month, start.day, tzinfo=timezone.utc).timestamp())
    period2 = int(
        datetime(end.year, end.month, end.day, tzinfo=timezone.utc).timestamp()
        + 24 * 60 * 60
    )
    query = urllib.parse.urlencode(
        {
            "period1": period1,
            "period2": period2,
            "interval": "1d",
            "events": "history",
            "includeAdjustedClose": "true",
        }
    )
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/ETH-USD?{query}"
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "index-options-sim/0.1 (+research backtest)",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))

    result = payload["chart"]["result"][0]
    timestamps = result["timestamp"]
    closes = result["indicators"]["quote"][0]["close"]
    rows = []
    for ts, close in zip(timestamps, closes):
        if close is None:
            continue
        day = datetime.fromtimestamp(ts, timezone.utc).date()
        if start <= day <= end:
            rows.append(Candle(day, float(close)))

    write_candles(cache_path, rows)
    return rows


def read_candles(path: Path, start: date, end: date) -> list[Candle]:
    rows: list[Candle] = []
    with path.open() as f:
        reader = csv.DictReader(f)
        for row in reader:
            day = date.fromisoformat(row["date"])
            if start <= day <= end:
                rows.append(Candle(day, float(row["close"])))
    return rows


def write_candles(path: Path, rows: list[Candle]) -> None:
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["date", "close"])
        writer.writeheader()
        for row in rows:
            writer.writerow({"date": row.day.isoformat(), "close": f"{row.close:.8f}"})


def pct(x: float) -> str:
    return f"{100 * x:8.2f}%"


def usd(x: float) -> str:
    return f"${x:,.2f}"


def choose_strike(spot: float, factor: float) -> float:
    return spot / factor


def simulate(candles: list[Candle], strategy: Strategy, initial_usd: float) -> dict[str, float | int | str]:
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

        is_last = i == n - 1
        danger = candle.close < pos.strike * strategy.danger_factor
        too_close_to_maturity = days_left <= strategy.roll_before_days
        if is_last or not (danger or too_close_to_maturity):
            continue

        new_factor = strategy.reset_factor if danger else strategy.strike_factor
        new_strike = choose_strike(candle.close, new_factor)
        new_maturity = maturity_index_for(i, strategy.maturity_days, n)
        new_price = p_price_usd(candle.close, new_strike, new_maturity - i, strategy.iv)

        cost = strategy.trade_cost_bps / 10_000.0
        gross_proceeds = pos.units * old_price
        net_proceeds = gross_proceeds * (1.0 - cost)
        new_units = net_proceeds / (new_price * (1.0 + cost))
        cumulative_trade_cost += gross_proceeds - net_proceeds + (new_units * new_price * cost)

        pos = Position(new_units, new_strike, new_maturity)
        roll_count += 1
        danger_rolls += int(danger)
        maturity_rolls += int(too_close_to_maturity and not danger)

    final_value = values[-1]
    years = max((candles[-1].day - candles[0].day).days / 365.25, 1 / 365.25)
    cagr = (final_value / initial_usd) ** (1.0 / years) - 1.0
    mean_daily = statistics.fmean(daily_returns) if daily_returns else 0.0
    daily_vol = statistics.pstdev(daily_returns) if len(daily_returns) > 1 else 0.0
    annual_vol = daily_vol * math.sqrt(365.25)
    tracking_rmse = math.sqrt(statistics.fmean([(v / initial_usd - 1.0) ** 2 for v in values]))

    return {
        "name": strategy.name,
        "start": candles[0].day.isoformat(),
        "end": candles[-1].day.isoformat(),
        "days": len(candles),
        "final_usd": final_value,
        "cagr": cagr,
        "min_value": min(values),
        "max_drawdown": max_drawdown,
        "annual_vol": annual_vol,
        "tracking_rmse": tracking_rmse,
        "rolls": roll_count,
        "danger_rolls": danger_rolls,
        "maturity_rolls": maturity_rolls,
        "trade_cost_usd": cumulative_trade_cost,
        "mean_daily": mean_daily,
    }


def default_strategies() -> list[Strategy]:
    base = [
        ("conservative", 2.0, 1.5, 4.0, 60, 14),
        ("wider-buffer", 3.0, 1.6, 5.0, 60, 14),
        ("short-roll", 2.0, 1.5, 4.0, 30, 7),
        ("slow-roll", 2.0, 1.4, 4.0, 90, 21),
    ]
    strategies: list[Strategy] = []
    for iv in (0.6, 0.9):
        for cost in (10.0, 50.0, 100.0):
            for name, strike_factor, danger_factor, reset_factor, maturity_days, roll_before_days in base:
                strategies.append(
                    Strategy(
                        name=f"{name}|iv{int(iv * 100)}|cost{int(cost)}",
                        strike_factor=strike_factor,
                        danger_factor=danger_factor,
                        reset_factor=reset_factor,
                        maturity_days=maturity_days,
                        roll_before_days=roll_before_days,
                        iv=iv,
                        trade_cost_bps=cost,
                    )
                )
    return strategies


def print_table(results: list[dict[str, float | int | str]]) -> None:
    headers = [
        "strategy",
        "final",
        "CAGR",
        "min",
        "maxDD",
        "annVol",
        "RMSE",
        "rolls",
        "danger",
        "cost",
    ]
    print(" | ".join(headers))
    print(" | ".join("-" * len(h) for h in headers))
    for r in sorted(results, key=lambda x: float(x["final_usd"]), reverse=True):
        row = [
            str(r["name"]),
            usd(float(r["final_usd"])),
            pct(float(r["cagr"])),
            usd(float(r["min_value"])),
            pct(float(r["max_drawdown"])),
            pct(float(r["annual_vol"])),
            pct(float(r["tracking_rmse"])),
            str(r["rolls"]),
            str(r["danger_rolls"]),
            usd(float(r["trade_cost_usd"])),
        ]
        print(" | ".join(row))


def parse_day(value: str) -> date:
    return date.fromisoformat(value)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2018-01-01", type=parse_day)
    parser.add_argument("--end", default=date.today().isoformat(), type=parse_day)
    parser.add_argument("--initial-usd", default=1000.0, type=float)
    parser.add_argument("--cache", default=None)
    args = parser.parse_args()

    cache_name = args.cache or f"eth-usd-{args.start.isoformat()}-{args.end.isoformat()}.csv"
    cache_path = DATA_DIR / cache_name
    candles = load_yahoo_eth_usd(args.start, args.end, cache_path)
    if len(candles) < 30:
        raise SystemExit(f"Only loaded {len(candles)} candles; check date range or data source.")

    results = [simulate(candles, strategy, args.initial_usd) for strategy in default_strategies()]
    print(f"Data: ETH-USD daily close, {candles[0].day.isoformat()} to {candles[-1].day.isoformat()}")
    print(f"Initial target: {usd(args.initial_usd)}")
    print()
    print_table(results)


if __name__ == "__main__":
    main()

