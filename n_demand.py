#!/usr/bin/env python3
"""Estimate N-side demand required by a Steady vault.

The earlier n_side.py asks whether N is a plausible product. This script asks a
more operational MVP question:

    How much N buying capacity does the system need per dollar of Steady AUM?

It simulates the N supply created by every fresh P issuance during Steady rolls,
then measures annual issuance, outstanding inventory, and realized N returns.
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
from rlp_sim import n_price_usd


@dataclass(frozen=True)
class NIssue:
    issue_index: int
    maturity_index: int
    units: float
    strike: float
    cost_usd: float
    payoff_usd: float
    eth_benchmark_payoff_usd: float
    reason: str


def n_payoff_usd(spot_at_maturity: float, strike: float) -> float:
    return max(0.0, spot_at_maturity / strike - 1.0)


def collect_issues(candles: list[Candle], initial_usd: float, iv: float) -> list[NIssue]:
    strategy = conservative_strategy(iv)
    n = len(candles)
    spot0 = candles[0].close
    strike0 = choose_strike(spot0, strategy.strike_factor)
    maturity0 = maturity_index_for(0, strategy.maturity_days, n)
    price0 = p_price_usd(spot0, strike0, maturity0, strategy.iv)
    pos = Position(initial_usd / price0, strike0, maturity0)
    issues: list[NIssue] = []

    for i, candle in enumerate(candles):
        days_left = max(pos.maturity_index - i, 0)
        old_price = p_price_usd(candle.close, pos.strike, days_left, strategy.iv)
        value = pos.units * old_price
        is_last = i == n - 1
        danger = candle.close < pos.strike * strategy.danger_factor
        too_close_to_maturity = days_left <= strategy.roll_before_days
        if is_last or not (danger or too_close_to_maturity):
            continue

        reason = "danger" if danger else "maturity"
        new_factor = strategy.reset_factor if danger else strategy.strike_factor
        new_strike = choose_strike(candle.close, new_factor)
        new_maturity = maturity_index_for(i, strategy.maturity_days, n)
        new_days_left = max(new_maturity - i, 0)
        new_p_price = p_price_usd(candle.close, new_strike, new_days_left, strategy.iv)
        new_units = value / new_p_price
        new_n_price = n_price_usd(candle.close, new_strike, new_p_price)
        cost = new_units * new_n_price
        maturity_spot = candles[new_maturity].close
        payoff = new_units * n_payoff_usd(maturity_spot, new_strike)
        eth_benchmark = cost * maturity_spot / candle.close

        issues.append(
            NIssue(
                issue_index=i,
                maturity_index=new_maturity,
                units=new_units,
                strike=new_strike,
                cost_usd=cost,
                payoff_usd=payoff,
                eth_benchmark_payoff_usd=eth_benchmark,
                reason=reason,
            )
        )

        pos = Position(new_units, new_strike, new_maturity)

    return issues


def issue_mark(issue: NIssue, candle: Candle, index: int, iv: float) -> float:
    days_left = max(issue.maturity_index - index, 0)
    p_price = p_price_usd(candle.close, issue.strike, days_left, iv)
    return issue.units * n_price_usd(candle.close, issue.strike, p_price)


def summarize(candles: list[Candle], issues: list[NIssue], initial_usd: float, iv: float) -> dict[str, float | int]:
    years = max((candles[-1].day - candles[0].day).days / 365.25, 1 / 365.25)
    total_cost = sum(issue.cost_usd for issue in issues)
    total_payoff = sum(issue.payoff_usd for issue in issues)
    total_eth = sum(issue.eth_benchmark_payoff_usd for issue in issues)

    outstanding_marks: list[float] = []
    outstanding_costs: list[float] = []
    for i, candle in enumerate(candles):
        active = [issue for issue in issues if issue.issue_index <= i <= issue.maturity_index]
        outstanding_marks.append(sum(issue_mark(issue, candle, i, iv) for issue in active))
        outstanding_costs.append(sum(issue.cost_usd for issue in active))

    returns = [issue.payoff_usd / issue.cost_usd - 1.0 for issue in issues if issue.cost_usd > 0]
    danger_cost = sum(issue.cost_usd for issue in issues if issue.reason == "danger")
    return {
        "issues": len(issues),
        "issues_per_year": len(issues) / years,
        "total_cost": total_cost,
        "total_payoff": total_payoff,
        "portfolio_return": total_payoff / total_cost - 1.0,
        "eth_benchmark_return": total_eth / total_cost - 1.0,
        "annual_issuance_ratio": total_cost / initial_usd / years,
        "avg_outstanding_mark_ratio": statistics.fmean(outstanding_marks) / initial_usd,
        "max_outstanding_mark_ratio": max(outstanding_marks) / initial_usd,
        "avg_outstanding_cost_ratio": statistics.fmean(outstanding_costs) / initial_usd,
        "max_outstanding_cost_ratio": max(outstanding_costs) / initial_usd,
        "danger_issuance_ratio": danger_cost / total_cost if total_cost else 0.0,
        "mean_trade_return": statistics.fmean(returns),
        "median_trade_return": statistics.median(returns),
        "loss_rate": sum(1 for r in returns if r < 0) / len(returns),
    }


def print_summary(summary: dict[str, float | int]) -> None:
    print(f"Issues: {summary['issues']} ({float(summary['issues_per_year']):.1f}/year)")
    print(f"Annual N issuance / Steady AUM: {float(summary['annual_issuance_ratio']):.2f}x")
    print(f"Avg outstanding N mark / Steady AUM: {float(summary['avg_outstanding_mark_ratio']):.2f}x")
    print(f"Max outstanding N mark / Steady AUM: {float(summary['max_outstanding_mark_ratio']):.2f}x")
    print(f"Avg outstanding N cost / Steady AUM: {float(summary['avg_outstanding_cost_ratio']):.2f}x")
    print(f"Max outstanding N cost / Steady AUM: {float(summary['max_outstanding_cost_ratio']):.2f}x")
    print(f"Danger-roll share of N issuance: {pct(float(summary['danger_issuance_ratio']))}")
    print(f"Total N bought: {usd(float(summary['total_cost']))}")
    print(f"Total N payoff: {usd(float(summary['total_payoff']))}")
    print(f"N portfolio return: {pct(float(summary['portfolio_return']))}")
    print(f"ETH benchmark return: {pct(float(summary['eth_benchmark_return']))}")
    print(f"Mean / median N trade return: {pct(float(summary['mean_trade_return']))} / {pct(float(summary['median_trade_return']))}")
    print(f"Loss rate: {pct(float(summary['loss_rate']))}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2018-01-01", type=parse_day)
    parser.add_argument("--end", default=date.today().isoformat(), type=parse_day)
    parser.add_argument("--iv", default=0.9, type=float)
    parser.add_argument("--aum", default=1_000_000.0, type=float)
    args = parser.parse_args()

    cache_path = DATA_DIR / f"eth-usd-{args.start.isoformat()}-{args.end.isoformat()}.csv"
    candles = load_yahoo_eth_usd(args.start, args.end, cache_path)
    issues = collect_issues(candles, args.aum, args.iv)
    summary = summarize(candles, issues, args.aum, args.iv)

    print(f"Data: ETH-USD daily close, {candles[0].day.isoformat()} to {candles[-1].day.isoformat()}")
    print(f"Steady AUM: {usd(args.aum)}")
    print()
    print_summary(summary)


if __name__ == "__main__":
    main()

