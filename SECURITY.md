# Security Policy

This repository is an MVP and is not ready for public funds.

## Current Status

```text
Status: research / MVP
Real-fund deployment: not approved
External audit: not complete
Bug bounty: not active
```

The contracts and operators are designed around strict decentralization and
capacity controls, but they still need security review, threat modeling, gas
profiling, fuzzing, and production readiness evidence before launch.

## Reporting Security Issues

For now, report security issues privately to the repository owner or in the
private GitHub repo. Do not publish exploit details until the issue has been
triaged and fixed.

Please include:

```text
- affected contract, script, or UI path
- exploit preconditions
- impact
- reproduction steps
- suggested fix if known
```

## High-Priority Areas

Security review should focus on:

```text
- option split and P + N = 1 ETH accounting
- maturity settlement and TWAP oracle metadata
- wrapper roll lifecycle
- partial auction fills, resets, cancellation, and dust rules
- ETH LP vault inventory accounting
- LP vault immutable policy limits
- keeper bounties and execution incentives
- AMM slippage and liquidity assumptions
- deployment manifests and readiness checks
```

Current invariant coverage includes fuzz tests for complementary P/N payoff
math, pre-settlement mint/merge accounting, and post-settlement redemptions that
never overpay collateral. Full paired redemptions may leave at most 1 wei of
rounding dust in the factory for arbitrary wei-sized positions; that is bounded
dust, not debt.

LP-vault coverage includes both a discounted-roll profit path and a par-priced
roll loss path caused by series basis risk. The vault share price can go down
after a roll, so LP returns must be presented as market-making PnL with risk,
not as guaranteed yield.

LP-vault fuzz coverage also checks that, after Steady and Boosted rolls,
arbitrary old and new settlement prices clean up to the exact ETH value implied
by the factory's P/N payoff math. This ties strategy inventory accounting back
to the core option-split invariant instead of only scripted scenarios.

The wrapper keeper now blocks normal rolls across changed strike, TWAP window,
or settlement oracle. This keeps the simplified MVP from presenting a
basis-changing migration as a cheap maturity roll; any future dynamic-strike
roll needs an explicit valuation and risk policy.

Wrapper deposits now auto-pause after a fully unfilled roll is cancelled. This
does not trap existing holders because redemptions remain available; it stops
capacity growth until a later retry roll clears and finalizes.

Settlement coverage includes 3-stable median TWAP tests that reject missing or
out-of-band sources, reject duplicate median source pools, ignore one low or
high issuer outlier, and fuzz that settlement equals the median of the three
source prices.

## Non-Negotiable Safety Rules

Do not add:

```text
- trusted manual settlement fallback
- exclusive market maker dependency
- hidden expensive roll fallback
- centralized roll execution path
- LP return guarantee
- capacity growth without liquidity evidence
```

If cheap roll execution is unavailable, the protocol should pause, shrink, or
require more liquidity.
