#!/usr/bin/env python3
"""Launch capacity policy for the Steady/Boosted ETH MVP.

The contracts can technically create more Steady ETH whenever the series cap
allows it. Economically, Steady capacity should be much smaller: every Steady
roll needs enough protocol liquidity to clear without making execution too
expensive. At larger scale that means LP-vault capital plus Boosted/N-side
demand. For a small no-solver launch, the LP vault can be the explicit protocol
liquidity engine as long as capacity stays inside a conservative capital ratio.

This script turns that bottleneck into an operator gate:

    normal mode: safe Steady cap = min(LP-vault capital cap, Boosted/N demand cap)
    no-solver mode: safe Steady cap = LP-vault capital cap

It is deliberately conservative and ETH-denominated, matching the product UX.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import date
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from n_demand import collect_issues, summarize
from sim import DATA_DIR, load_yahoo_eth_usd, parse_day, pct, usd


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Estimate a sustainable ETH-denominated Steady capacity cap.",
    )
    parser.add_argument("--start", default="2018-01-01", type=parse_day)
    parser.add_argument("--end", default=date.today().isoformat(), type=parse_day)
    parser.add_argument("--iv", default=0.9, type=float)
    parser.add_argument(
        "--lp-vault-eth",
        default=100.0,
        type=float,
        help="Committed ETH in the shared LP/backstop vault.",
    )
    parser.add_argument(
        "--boosted-demand-eth",
        default=100.0,
        type=float,
        help="Credible recurring Boosted/N-side buyer capacity, denominated in ETH.",
    )
    parser.add_argument(
        "--solver-float-eth",
        default=0.0,
        type=float,
        help="External solver balance sheet that can absorb paired N inventory.",
    )
    parser.add_argument(
        "--target-steady-eth",
        default=None,
        type=float,
        help="Optional proposed Steady cap to gate.",
    )
    parser.add_argument(
        "--rlp-capital-ratio",
        default=10.0,
        type=float,
        help="Required LP-vault capital divided by allowed Steady capacity.",
    )
    parser.add_argument(
        "--n-external-fill",
        default=0.95,
        type=float,
        help="Target fraction of paired N inventory cleared outside the LP vault.",
    )
    parser.add_argument(
        "--no-solver-launch",
        action="store_true",
        help="Gate a small launch by LP-vault capital only, without requiring committed solver/Boosted demand.",
    )
    parser.add_argument("--strict", action="store_true", help="Exit nonzero on warnings as well as failures.")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def check(level: str, name: str, detail: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "level": level,
        "name": name,
        "detail": detail,
        "data": data or {},
    }


def cap_from_liquidity(liquidity_eth: float, ratio: float, external_fill: float) -> float:
    required_ratio = ratio * external_fill
    if required_ratio <= 0:
        return math.inf
    return liquidity_eth / required_ratio


def fmt_eth(value: float) -> str:
    if math.isinf(value):
        return "unbounded"
    if abs(value) >= 100:
        return f"{value:,.0f} ETH"
    if abs(value) >= 10:
        return f"{value:,.1f} ETH"
    return f"{value:,.2f} ETH"


def status_for(checks: list[dict[str, Any]]) -> tuple[str, dict[str, int]]:
    counts = {"pass": 0, "warn": 0, "fail": 0}
    for item in checks:
        counts[item["level"]] += 1
    status = "fail" if counts["fail"] else "warn" if counts["warn"] else "pass"
    return status, counts


def print_report(result: dict[str, Any]) -> None:
    counts = result["counts"]
    print(
        f"Capacity policy: {result['status'].upper()} "
        f"({counts['pass']} pass, {counts['warn']} warn, {counts['fail']} fail)"
    )
    print(
        f"Data: ETH-USD daily close, {result['start']} to {result['end']}; "
        f"last spot {usd(result['spotUsd'])}"
    )
    print(
        f"Inputs: LP vault {fmt_eth(result['lpVaultEth'])}, "
        f"Boosted/solver demand {fmt_eth(result['externalNDemandEth'])}, "
        f"RLP ratio {result['rlpCapitalRatio']:.2f}x, external N fill {pct(result['nExternalFill'])}"
    )
    print(f"Mode: {'no-solver LP-vault launch' if result['noSolverLaunch'] else 'LP vault plus external Boosted/solver demand'}")
    print("")
    print(f"Suggested launch cap: {fmt_eth(result['launchCapEth'])}")
    print(f"Stress cap using max historical N outstanding: {fmt_eth(result['stressCapEth'])}")
    if result["targetSteadyEth"] is not None:
        print(f"Target Steady cap: {fmt_eth(result['targetSteadyEth'])}")
    print("")
    print("Demand ratios from historical Steady rolls:")
    print(f"- Annual N issuance / Steady cap: {result['nDemand']['annualIssuanceRatio']:.2f}x")
    print(f"- Avg outstanding N cost / Steady cap: {result['nDemand']['avgOutstandingCostRatio']:.2f}x")
    print(f"- Max outstanding N cost / Steady cap: {result['nDemand']['maxOutstandingCostRatio']:.2f}x")
    print("")
    for level in ("fail", "warn", "pass"):
        rows = [item for item in result["checks"] if item["level"] == level]
        if not rows:
            continue
        print(level.upper())
        for item in rows:
            print(f"- {item['name']}: {item['detail']}")
        print("")


def json_safe(value: Any) -> str:
    return json.dumps(value, indent=2, default=str)


def main() -> None:
    args = parse_args()
    if args.lp_vault_eth < 0 or args.boosted_demand_eth < 0 or args.solver_float_eth < 0:
        raise SystemExit("liquidity inputs must be non-negative")
    if args.rlp_capital_ratio <= 0:
        raise SystemExit("--rlp-capital-ratio must be positive")
    if not 0 < args.n_external_fill <= 1:
        raise SystemExit("--n-external-fill must be greater than 0 and at most 1")
    if args.target_steady_eth is not None and args.target_steady_eth < 0:
        raise SystemExit("--target-steady-eth must be non-negative")

    cache_path = DATA_DIR / f"eth-usd-{args.start.isoformat()}-{args.end.isoformat()}.csv"
    candles = load_yahoo_eth_usd(args.start, args.end, cache_path)
    issues = collect_issues(candles, 1_000_000.0, args.iv)
    n_summary = summarize(candles, issues, 1_000_000.0, args.iv)

    external_n_demand_eth = args.boosted_demand_eth + args.solver_float_eth
    avg_n_ratio = float(n_summary["avg_outstanding_cost_ratio"])
    max_n_ratio = float(n_summary["max_outstanding_cost_ratio"])
    annual_n_ratio = float(n_summary["annual_issuance_ratio"])

    rlp_cap_eth = args.lp_vault_eth / args.rlp_capital_ratio
    avg_n_cap_eth = cap_from_liquidity(external_n_demand_eth, avg_n_ratio, args.n_external_fill)
    stress_n_cap_eth = cap_from_liquidity(external_n_demand_eth, max_n_ratio, args.n_external_fill)
    launch_cap_eth = rlp_cap_eth if args.no_solver_launch else min(rlp_cap_eth, avg_n_cap_eth)
    stress_cap_eth = rlp_cap_eth if args.no_solver_launch else min(rlp_cap_eth, stress_n_cap_eth)

    checks: list[dict[str, Any]] = []
    if args.target_steady_eth is not None:
        target = args.target_steady_eth
        checks.append(
            check(
                "pass" if target <= rlp_cap_eth else "fail",
                "LP capital backs the target cap",
                f"Target needs {fmt_eth(target * args.rlp_capital_ratio)} of LP capital; available is {fmt_eth(args.lp_vault_eth)}.",
                {
                    "requiredLpVaultEth": target * args.rlp_capital_ratio,
                    "availableLpVaultEth": args.lp_vault_eth,
                    "rlpCapEth": rlp_cap_eth,
                },
            )
        )
        if args.no_solver_launch:
            checks.append(
                check(
                    "pass",
                    "no-solver launch mode uses LP vault capacity",
                    "External solver/Boosted demand is advisory in this mode; keep caps small and let the ETH LP vault clear rolls within the configured capital ratio.",
                    {
                        "lpVaultEth": args.lp_vault_eth,
                        "rlpCapEth": rlp_cap_eth,
                        "externalNDemandEth": external_n_demand_eth,
                    },
                )
            )
        else:
            checks.append(
                check(
                    "pass" if target <= avg_n_cap_eth else "fail",
                    "average Boosted/N demand backs the target cap",
                    f"Target needs {fmt_eth(target * avg_n_ratio * args.n_external_fill)} average external N demand; available is {fmt_eth(external_n_demand_eth)}.",
                    {
                        "requiredAverageNDemandEth": target * avg_n_ratio * args.n_external_fill,
                        "availableNDemandEth": external_n_demand_eth,
                        "averageNCapEth": avg_n_cap_eth,
                    },
                )
            )
            checks.append(
                check(
                    "pass" if target <= stress_cap_eth else "warn",
                    "stress Boosted/N demand backs the target cap",
                    f"Target needs {fmt_eth(target * max_n_ratio * args.n_external_fill)} under max historical outstanding N demand; available is {fmt_eth(external_n_demand_eth)}.",
                    {
                        "requiredStressNDemandEth": target * max_n_ratio * args.n_external_fill,
                        "availableNDemandEth": external_n_demand_eth,
                        "stressCapEth": stress_cap_eth,
                    },
                )
            )
    else:
        checks.append(
            check(
                "pass",
                "capacity estimate generated",
                "Pass --target-steady-eth to turn this advisory estimate into a gate.",
            )
        )

    status, counts = status_for(checks)
    result = {
        "status": status,
        "counts": counts,
        "start": candles[0].day.isoformat(),
        "end": candles[-1].day.isoformat(),
        "spotUsd": candles[-1].close,
        "lpVaultEth": args.lp_vault_eth,
        "boostedDemandEth": args.boosted_demand_eth,
        "solverFloatEth": args.solver_float_eth,
        "externalNDemandEth": external_n_demand_eth,
        "targetSteadyEth": args.target_steady_eth,
        "noSolverLaunch": args.no_solver_launch,
        "rlpCapitalRatio": args.rlp_capital_ratio,
        "nExternalFill": args.n_external_fill,
        "rlpCapEth": rlp_cap_eth,
        "averageNCapEth": avg_n_cap_eth,
        "stressNCapEth": stress_n_cap_eth,
        "launchCapEth": launch_cap_eth,
        "stressCapEth": stress_cap_eth,
        "nDemand": {
            "annualIssuanceRatio": annual_n_ratio,
            "avgOutstandingCostRatio": avg_n_ratio,
            "maxOutstandingCostRatio": max_n_ratio,
            "issues": n_summary["issues"],
            "portfolioReturn": n_summary["portfolio_return"],
        },
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
