# Team Handoff

This repo is the ETH-native Steady ETH / Boosted ETH MVP.

The product idea is simple:

```text
Traders choose ETH exposure:
- Steady ETH: smoother ETH exposure
- Boosted ETH: higher-upside, higher-risk ETH exposure

Liquidity providers deposit ETH:
- the ETH LP vault helps rolls clear
- the vault earns market-making PnL when it helps at good prices
- returns are not guaranteed

Solvers compete publicly:
- wrapper rolls are Dutch auctions
- external solvers can fill first
- the ETH LP vault is the bootstrap liquidity engine when solvers are thin
```

## Start Here

Run the browser demo:

```bash
python3 -m http.server 8765
```

Open:

```text
http://localhost:8765/demo/
```

Run the core tests:

```bash
forge test -vvv
```

Run the full local MVP acceptance gate:

```bash
node ops/mvp-acceptance.mjs --local-live
```

That acceptance command starts a fresh local chain, deploys the MVP, seeds the
markets, checks readiness, exercises trader buy/sell flows, runs external-solver
and no-solver roll paths, and verifies LP inventory cleanup.

## What Must Stay True

These are product invariants, not preferences.

```text
1. Trader UX is ETH native.
   Users buy and sell Steady ETH / Boosted ETH with ETH by default.
   The browser demo should keep wallet-connected buy/sell actions available
   when a deployed manifest is loaded.

2. Normal rolls stay cheap.
   The default normal roll target is <= 10 bps. If cheap rolls cannot clear,
   the protocol should pause growth, shrink capacity, or require more liquidity
   instead of silently accepting expensive rotation. A fully failed wrapper roll
   automatically pauses new wrapper deposits until a later retry clears.

3. Roll execution is public.
   External solvers bid into public roll auctions. There should be no exclusive
   offchain market maker path required for the MVP to work.

4. The ETH LP vault is the bootstrap liquidity engine.
   The vault can run the system at small caps without external solvers, but only
   inside strict immutable size, price, delay, freshness, and inventory-sale
   policy limits.

5. LP returns are not promised yield.
   LPs earn market-making PnL when the vault helps clear rolls at good prices.
   The UI and docs should keep risk visible.

6. Settlement is decentralized.
   Production-style settlement uses the median of USDC, USDT, and DAI Uniswap
   v3 TWAP sources, with maturity-anchored oracle metadata.

7. Capacity is earned, not assumed.
   Steady capacity should grow only when LP vault capital, solver float, and
   Boosted-side demand can support cheap normal rolls.
```

## Current Architecture

```text
Trader liquidity:
  EthTokenAMM markets for Steady ETH / ETH and Boosted ETH / ETH

Roll liquidity:
  RollAuction public Dutch auctions for wrapper maturity rotation

Bootstrap liquidity:
  EthLPVault plus EthLPVaultKeeper

External competition:
  RollSolver and keeper-runner solver actions

Settlement:
  MedianStableTwapSettlementOracle over stablecoin Uniswap v3 TWAP sources

Readiness:
  ProtocolHealthLens plus ops/readiness-check.mjs
```

The clean mental model is:

```text
AMMs help traders enter and exit.
Auctions discover roll counterparties.
The ETH LP vault bootstraps liquidity and caps product growth.
Solvers compete to improve pricing before the vault steps in.
```

## Useful Files

```text
README.md                       quick start and command list
contracts_mvp.md                contract architecture and behavior
deployment_mvp.md               local and Ethereum pilot deployment topology
oracle_settlement.md            settlement oracle notes
decentralized_mvp.md            trust-minimized product design
solver_market.md                solver onboarding and attribution guide
demo/index.html                 demo surface
demo/app.js                     demo interactions and simulated/live mode
ops/mvp-acceptance.mjs          full local acceptance gate
ops/readiness-check.mjs         live manifest readiness gate
ops/mainnet-oracle-preflight.mjs
                                mainnet oracle pool-fact preflight
ops/keeper-decisions.mjs        public-state runner suggestions
ops/keeper-runner.mjs           optional execution runner
ops/solver-improvement-report.mjs
                                public event-log attribution for solver fills
ops/vault-strategy-plan.mjs     deterministic vault strategy action planner
ops/economic-stress-check.py    historical roll-cost stress gate
ops/capacity-policy.py          ETH-denominated capacity gate
```

## Next Workstreams

1. Production deployment readiness

   Prove the `--rpc` readiness path against a real deployed manifest, including
   oracle metadata, compatible first/second series metadata, pinned sellers,
   keeper policies, auction limits, and capacity checks. Before deploy, run the
   mainnet oracle preflight against the intended Ethereum RPC.

2. Vault strategy

   Extend the deterministic strategy planner into dashboard and keeper-runner
   workflows around bid sizing, inventory cleanup, solver-first delay, and risk
   reporting. The vault should remain the transparent protocol liquidity engine,
   not a hidden discretionary bailout.

3. Solver market

   Expand from the current solver guide, sample model, and fill-attribution
   report into real solver integrations and reward accounting for fills that
   improve execution before the vault. The goal is competitive improvement, not
   activity for its own sake.

4. Frontend wallet integration

   The demo has live wallet actions for trader buy/sell, LP deposit/withdraw/
   claim, solver bids, wrapper keeper actions, and settlement actions. Next,
   improve transaction receipts, network switching, and end-to-end browser tests
   against a fresh local deployment.

5. Security and audit prep

   Add threat models, gas profiling, invariant tests, fuzzing, and external
   audit notes before any real funds are allowed.

## Known Non-Production Gaps

The MVP is useful for team exploration, but it is not ready for public funds.

```text
- no external security audit yet
- no production deployment manifest proven by --rpc readiness
- no real solver commitments or liquidity SLAs
- no formal proof of roll economics across all market regimes
- no wallet-connected production frontend yet
- no incident response or bug bounty program yet
```

Do not remove or weaken these caveats until the evidence exists.
