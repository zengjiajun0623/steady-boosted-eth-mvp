#!/usr/bin/env python3
"""Analyze the N-side product created across P-rolls.

For one dollar-normalized P_K unit backed by 1/K ETH:

    P payoff = min(1, ETHUSD / K)
    N payoff = max(0, ETHUSD / K - 1)

N is therefore a normalized ETH call option. This script samples the N token
that would be created every time a conservative stability strategy opens or
rolls into a fresh P position, then asks whether N looks like a viable product.
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
class NTrade:
    issue_day: date
    maturity_day: date
    issue_spot: float
    maturity_spot: float
    strike: float
    days: int
    n_price: float
    payoff: float
    reason: str

    @property
    def simple_return(self) -> float:
        if self.n_price <= 0:
            return 0.0
        return self.payoff / self.n_price - 1.0

    @property
    def eth_return(self) -> float:
        return self.maturity_spot / self.issue_spot - 1.0

    @property
    def annualized_return(self) -> float:
        if self.n_price <= 0 or self.payoff <= 0 or self.days <= 0:
            return -1.0
        years = self.days / 365.25
        return (self.payoff / self.n_price) ** (1.0 / years) - 1.0


def n_price_usd(spot: float, strike: float, days_to_maturity: int, iv: float) -> float:
    collateral_value = spot / strike
    p_price = p_price_usd(spot, strike, days_to_maturity, iv)
    return max(0.0, collateral_value - p_price)


def n_payoff_usd(spot_at_maturity: float, strike: float) -> float:
    return max(0.0, spot_at_maturity / strike - 1.0)


def collect_n_trades(candles: list[Candle], strategy: Strategy) -> list[NTrade]:
    trades: list[NTrade] = []
    n = len(candles)
    index = 0
    strike = choose_strike(candles[index].close, strategy.strike_factor)
    maturity_index = maturity_index_for(index, strategy.maturity_days, n)
    reason = "initial"

    while index < n - 1 and maturity_index < n:
        issue = candles[index]
        maturity = candles[maturity_index]
        days = max(maturity_index - index, 0)
        price = n_price_usd(issue.close, strike, days, strategy.iv)
        payoff = n_payoff_usd(maturity.close, strike)
        trades.append(
            NTrade(
                issue_day=issue.day,
                maturity_day=maturity.day,
                issue_spot=issue.close,
                maturity_spot=maturity.close,
                strike=strike,
                days=days,
                n_price=price,
                payoff=payoff,
                reason=reason,
            )
        )

        rolled = False
        for j in range(index + 1, min(maturity_index, n - 1) + 1):
            candle = candles[j]
            days_left = max(maturity_index - j, 0)
            danger = candle.close < strike * strategy.danger_factor
            too_close_to_maturity = days_left <= strategy.roll_before_days
            if danger or too_close_to_maturity:
                new_factor = strategy.reset_factor if danger else strategy.strike_factor
                index = j
                strike = choose_strike(candle.close, new_factor)
                maturity_index = maturity_index_for(index, strategy.maturity_days, n)
                reason = "danger" if danger else "maturity"
                rolled = True
                break
        if not rolled:
            break

    return [trade for trade in trades if trade.days > 0 and trade.n_price > 0]


def quantile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * q)))
    return ordered[index]


def summarize(trades: list[NTrade]) -> dict[str, float | int]:
    returns = [trade.simple_return for trade in trades]
    annualized = [trade.annualized_return for trade in trades]
    eth_returns = [trade.eth_return for trade in trades]
    wins = [r for r in returns if r > 0]
    losses = [r for r in returns if r <= 0]
    total_paid = sum(trade.n_price for trade in trades)
    total_payoff = sum(trade.payoff for trade in trades)
    eth_total_payoff = sum(
        trade.n_price * trade.maturity_spot / trade.issue_spot for trade in trades
    )
    return {
        "trades": len(trades),
        "win_rate": len(wins) / len(returns),
        "mean_return": statistics.fmean(returns),
        "median_return": statistics.median(returns),
        "p10_return": quantile(returns, 0.10),
        "p90_return": quantile(returns, 0.90),
        "mean_annualized": statistics.fmean(annualized),
        "mean_eth_return": statistics.fmean(eth_returns),
        "total_paid": total_paid,
        "total_payoff": total_payoff,
        "portfolio_return": total_payoff / total_paid - 1.0,
        "eth_portfolio_return": eth_total_payoff / total_paid - 1.0,
        "danger_trades": sum(1 for trade in trades if trade.reason == "danger"),
        "maturity_trades": sum(1 for trade in trades if trade.reason == "maturity"),
    }


def print_summary(summary: dict[str, float | int]) -> None:
    print(f"Trades: {summary['trades']}")
    print(f"Win rate: {pct(float(summary['win_rate']))}")
    print(f"Mean trade return: {pct(float(summary['mean_return']))}")
    print(f"Median trade return: {pct(float(summary['median_return']))}")
    print(f"10th / 90th pct return: {pct(float(summary['p10_return']))} / {pct(float(summary['p90_return']))}")
    print(f"Mean ETH return over same windows: {pct(float(summary['mean_eth_return']))}")
    print(f"Equal-flow portfolio paid: {usd(float(summary['total_paid']))}")
    print(f"Equal-flow portfolio payoff: {usd(float(summary['total_payoff']))}")
    print(f"Equal-flow portfolio return: {pct(float(summary['portfolio_return']))}")
    print(f"Equal-flow ETH benchmark return: {pct(float(summary['eth_portfolio_return']))}")
    print(f"Danger / maturity issuances: {summary['danger_trades']} / {summary['maturity_trades']}")


def print_examples(trades: list[NTrade]) -> None:
    worst = sorted(trades, key=lambda trade: trade.simple_return)[:5]
    best = sorted(trades, key=lambda trade: trade.simple_return, reverse=True)[:5]
    print()
    print("Worst N trades")
    for trade in worst:
        print(
            f"{trade.issue_day} -> {trade.maturity_day} "
            f"K={trade.strike:.0f} spot={trade.issue_spot:.0f}->{trade.maturity_spot:.0f} "
            f"price={trade.n_price:.3f} payoff={trade.payoff:.3f} "
            f"return={pct(trade.simple_return)} reason={trade.reason}"
        )
    print()
    print("Best N trades")
    for trade in best:
        print(
            f"{trade.issue_day} -> {trade.maturity_day} "
            f"K={trade.strike:.0f} spot={trade.issue_spot:.0f}->{trade.maturity_spot:.0f} "
            f"price={trade.n_price:.3f} payoff={trade.payoff:.3f} "
            f"return={pct(trade.simple_return)} reason={trade.reason}"
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2018-01-01", type=parse_day)
    parser.add_argument("--end", default=date.today().isoformat(), type=parse_day)
    parser.add_argument("--iv", default=0.9, type=float)
    args = parser.parse_args()

    cache_path = DATA_DIR / f"eth-usd-{args.start.isoformat()}-{args.end.isoformat()}.csv"
    candles = load_yahoo_eth_usd(args.start, args.end, cache_path)
    strategy = conservative_strategy(args.iv)
    trades = collect_n_trades(candles, strategy)
    summary = summarize(trades)

    print(f"Data: ETH-USD daily close, {candles[0].day.isoformat()} to {candles[-1].day.isoformat()}")
    print(f"Strategy: {strategy.name}, N paired with each fresh P issuance")
    print()
    print_summary(summary)
    print_examples(trades)


if __name__ == "__main__":
    main()
