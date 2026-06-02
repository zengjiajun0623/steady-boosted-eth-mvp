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
