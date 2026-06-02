#!/usr/bin/env python3
"""Historical economic stress gate for Steady/Boosted roll liquidity.

This is not a pricing oracle and not a promise of future returns. It packages
the repo's existing historical RLP/N-side research into a public stress check:

1. Can the ETH LP vault quote rolls below a target cost under the assumed
   capital and external N-demand mix?
2. Does the assumed risk budget avoid capacity breaches?
3. Has the paired N side historically looked viable enough to attract buyers?
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from datetime import date
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from n_side import collect_n_trades, summarize as summarize_n_trades
from rlp_sim import RLPScenario, simulate_rlp
from roll_market import conservative_strategy
from sim import DATA_DIR, load_yahoo_eth_usd, parse_day, pct, usd


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a historical RLP/N-side economic stress gate.",
    )
    parser.add_argument("--start", default="2018-01-01", type=parse_day)
    parser.add_argument("--end", default=date.today().isoformat(), type=parse_day)
    parser.add_argument("--iv", default=0.9, type=float)
    parser.add_argument("--aum", default=1_000_000.0, type=float, help="Steady vault AUM in USD.")
    parser.add_argument(
        "--rlp-capital-ratio",
        default=3.0,
        type=float,
        help="ETH LP vault capital divided by Steady AUM.",
    )
    parser.add_argument(
        "--n-external-fill",
        default=0.80,
        type=float,
        help="Fraction of paired N inventory cleared by external buyers/solvers.",
    )
    parser.add_argument(
        "--old-p-external-fill",
        default=0.25,
        type=float,
        help="Fraction of old P inventory sourced by external solvers instead of RLP.",
    )
    parser.add_argument("--risk-budget-fraction", default=0.40, type=float)
    parser.add_argument("--max-weighted-bps", default=10.0, type=float)
    parser.add_argument("--max-breaches", default=0, type=int)
    parser.add_argument("--max-trade-cost-ratio", default=0.20, type=float)
    parser.add_argument("--min-steady-final-ratio", default=0.70, type=float)
    parser.add_argument("--min-n-portfolio-return", default=0.0, type=float)
    parser.add_argument("--strict", action="store_true", help="Exit nonzero on warnings as well as failures.")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def check(level: str, area: str, name: str, detail: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "level": level,
        "area": area,
        "name": name,
        "detail": detail,
        "data": data or {},
    }


def result_status(checks: list[dict[str, Any]]) -> tuple[str, dict[str, int]]:
    counts = {"pass": 0, "warn": 0, "fail": 0}
    for item in checks:
        counts[item["level"]] += 1
    status = "fail" if counts["fail"] else "warn" if counts["warn"] else "pass"
    return status, counts


def json_safe(value: Any) -> str:
    return json.dumps(value, indent=2, default=str)


def print_report(result: dict[str, Any]) -> None:
    counts = result["counts"]
    print(
        f"Economic stress: {result['status'].upper()} "
        f"({counts['pass']} pass, {counts['warn']} warn, {counts['fail']} fail)"
    )
    print(
        f"Data: ETH-USD daily close, {result['start']} to {result['end']}; "
        f"AUM {usd(result['aum'])}, RLP {result['rlpCapitalRatio']:.2f}x, "
        f"external N fill {pct(result['nExternalFill'])}"
    )
    print("")
    for level in ("fail", "warn", "pass"):
        rows = [item for item in result["checks"] if item["level"] == level]
        if not rows:
            continue
        print(level.upper())
        for item in rows:
            print(f"- [{item['area']}] {item['name']}: {item['detail']}")
        print("")


def main() -> None:
    args = parse_args()
    cache_path = DATA_DIR / f"eth-usd-{args.start.isoformat()}-{args.end.isoformat()}.csv"
    candles = load_yahoo_eth_usd(args.start, args.end, cache_path)
    strategy = conservative_strategy(args.iv)

    scenario = RLPScenario(
        name="runner-assumption",
        capital_ratio=args.rlp_capital_ratio,
        n_external_fill=args.n_external_fill,
        old_p_external_fill=args.old_p_external_fill,
        risk_budget_fraction=args.risk_budget_fraction,
    )
    rlp = simulate_rlp(candles, strategy, scenario, args.aum)
    n_summary = summarize_n_trades(collect_n_trades(candles, strategy))

    checks: list[dict[str, Any]] = []
    checks.append(
        check(
            "pass" if float(rlp["weighted_bps"]) <= args.max_weighted_bps else "fail",
            "rlp",
            "weighted roll cost target",
            f"Weighted average roll cost is {float(rlp['weighted_bps']):.1f} bps; target is <= {args.max_weighted_bps:.1f} bps.",
            {"weightedBps": rlp["weighted_bps"], "maxWeightedBps": args.max_weighted_bps},
        )
    )
    checks.append(
        check(
            "pass" if int(rlp["breaches"]) <= args.max_breaches else "fail",
            "rlp",
            "balance-sheet capacity",
            f"Capacity breaches: {int(rlp['breaches'])}; allowed <= {args.max_breaches}. Max utilization {float(rlp['max_utilization']):.2f}x.",
            {"breaches": rlp["breaches"], "maxBreaches": args.max_breaches, "maxUtilization": rlp["max_utilization"]},
        )
    )
    checks.append(
        check(
            "pass" if float(rlp["trade_cost_ratio"]) <= args.max_trade_cost_ratio else "warn",
            "rlp",
            "cumulative roll leakage",
            f"Cumulative modeled roll cost is {pct(float(rlp['trade_cost_ratio']))}; warning threshold is {pct(args.max_trade_cost_ratio)}.",
            {"tradeCostRatio": rlp["trade_cost_ratio"], "maxTradeCostRatio": args.max_trade_cost_ratio},
        )
    )
    checks.append(
        check(
            "pass" if float(rlp["final_ratio"]) >= args.min_steady_final_ratio else "warn",
            "steady",
            "Steady path survives historical window",
            f"Modeled final Steady value is {float(rlp['final_ratio']):.3f}x; warning threshold is {args.min_steady_final_ratio:.3f}x.",
            {"finalRatio": rlp["final_ratio"], "minFinalRatio": args.min_steady_final_ratio},
        )
    )
    checks.append(
        check(
            "pass" if float(n_summary["portfolio_return"]) >= args.min_n_portfolio_return else "fail",
            "boosted",
            "paired N demand is historically plausible",
            f"Equal-flow N portfolio return is {pct(float(n_summary['portfolio_return']))}; target is >= {pct(args.min_n_portfolio_return)}.",
            {
                "portfolioReturn": n_summary["portfolio_return"],
                "minPortfolioReturn": args.min_n_portfolio_return,
                "trades": n_summary["trades"],
                "winRate": n_summary["win_rate"],
            },
        )
    )

    status, counts = result_status(checks)
    result = {
        "status": status,
        "counts": counts,
        "start": candles[0].day.isoformat(),
        "end": candles[-1].day.isoformat(),
        "aum": args.aum,
        "rlpCapitalRatio": args.rlp_capital_ratio,
        "nExternalFill": args.n_external_fill,
        "scenario": asdict(scenario),
        "rlp": rlp,
        "nSide": n_summary,
        "checks": checks,
    }

    if args.json:
        print(json_safe(result))
    else:
        print_report(result)

    if status == "fail" or (args.strict and counts["warn"] > 0):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
