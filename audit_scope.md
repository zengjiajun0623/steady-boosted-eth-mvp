# External Audit Scope

This file defines the review scope for any real-fund Steady ETH / Boosted ETH
launch. It must stay aligned with the production contract set enforced by
`ops/contract-size-check.mjs`.

## Production Contracts

Auditors should review these contracts as production runtime code:

```text
EthOptionsFactory
EthLPVault
EthLPVaultKeeper
EthTokenAMM
EthereumMainnetOracleConfig
EthereumPilotTopology
MedianStableTwapSettlementOracle
MintBurnToken
ProtocolHealthLens
RollAuction
RollSolver
SeriesExposureVault
SeriesExposureVaultKeeper
UniswapV3TwapSettlementOracle
```

## Script Helpers

These helpers are deployment, local smoke, or topology-export helpers. They are
not production `forge create` targets, but auditors should review them for
deployment-configuration mistakes:

```text
DeployEthereumPilot
DeployEthereumPilotManifest
DeployLocalMvp
DeployLocalMvpManifest
LocalMvpTopology
```

## Primary Invariants

```text
P + N accounting: one ETH mints one P and one N, and paired P/N can merge back to one ETH before settlement.
Settlement accounting: after settlement, P payoff plus N payoff is bounded by the original collateral.
Wrapper accounting: Steady and Boosted shares must not mint value during deposits, redemptions, rolls, cancels, or finalization.
Roll policy: normal wrapper rolls must not cross strike, TWAP window, or oracle; cheap roll floors must stay inside the configured band.
Auction liveness: public solvers can discover and fill auctions, while stale resets and cancellation cannot confiscate partially filled inventory.
LP vault accounting: LP share value may go down from strategy risk, but open inventory must block deposits and withdrawal requests until cleanup.
LP vault strategy caps: roll fills, direct product trades, AMM inventory sales, and inventory liquidity must stay inside immutable caps and price floors.
No-admin posture: production deployments must use guardian address(0), no owner/admin/upgradable path, and public keeper/solver/settlement entrypoints.
Oracle readiness: live-like deployments must use the 3-stable median TWAP oracle and reject missing, duplicate, stale, or out-of-band sources.
Frontend wallet safety: live actions must check deployed manifest addresses, chain id, wallet account, calldata selectors, and slippage/min-out bounds.
```

## Required Commands

Run these before any final audit sign-off and attach outputs to the audit
evidence package:

```bash
node ops/mvp-acceptance.mjs --local-live
node ops/contract-size-check.mjs
node ops/no-admin-surface-check.mjs
node ops/production-readiness.mjs \
  --manifest manifests/production.json \
  --rpc $MAINNET_RPC_URL \
  --audit-report evidence/audit-final.md \
  --incident-runbook ops/incident-runbook.md \
  --security-intake evidence/security-intake-final.json \
  --solver-commitments evidence/solver-commitments-final.json \
  --boosted-demand-eth <BOOSTED_DEMAND_ETH> \
  --solver-float-eth <SOLVER_FLOAT_ETH>
```

## Known Launch Blockers

```text
External audit evidence must be final.
Production manifest must pass strict live mainnet readiness.
Solver/liquidity commitments must be structured, signed or funded, unexpired, and large enough to cover the CLI capacity amounts.
Incident response ownership and user communications must be assigned before real funds.
Bug bounty or equivalent vulnerability intake must be active, structured, and evidenced before public-fund scale.
```
