# Steady ETH / Boosted ETH Protocol MVP

This repo is a working MVP for an ETH-native exposure product.

The product is built around a simple user choice:

```text
Hold Steady ETH if you want smoother ETH exposure.
Hold Boosted ETH if you want more upside and can accept more downside.
Deposit ETH into the LP vault if you want to provide protocol liquidity.
Run a solver or keeper bot if you want to compete to clear public rolls.
```

The original research thread is here:

https://ethresear.ch/t/building-index-tracking-assets-on-top-of-options-instead-of-debt/25036

## User Stories

### Trader

A trader already holds ETH, but wants a different risk profile.

If they want ETH exposure that moves more calmly, they buy Steady ETH with ETH.
If they want a higher-upside version of ETH and accept the extra risk, they buy
Boosted ETH with ETH. When they want out, they sell back into ETH.

The trader should not need to understand roll auctions, settlement windows, or
vault inventory. Their page should feel like a simple ETH-native buy/sell flow.

### Liquidity Provider

An LP deposits ETH into the protocol LP vault.

The vault helps the market work: it can backstop maturity rolls, support
liquidity, and clean up option inventory. The LP earns when those actions make
profitable market-making PnL. The LP can also lose money when the vault takes
bad inventory risk or the market moves against it.

There is no guaranteed yield. The vault should show risk, open inventory,
capacity, and withdrawal state plainly.

### Solver

A solver watches public roll auctions.

When Steady ETH or Boosted ETH needs to rotate into the next maturity, the roll
is exposed as an onchain Dutch auction. Solvers can bid permissionlessly. If a
solver can clear the roll at a better price before the ETH LP vault steps in,
they improve execution for the product and can be measured from public events.

The ETH LP vault is the launch liquidity engine. Solvers compete around it; they
do not need to be exclusive market makers.

### Keeper / Verifier

There is no normal protocol admin.

Anyone can run the public scripts that inspect readiness, start or finalize
allowed rolls, bid as a solver, or clean up LP vault inventory. Those scripts do
not grant special authority; the contracts decide what is valid.

Before capacity grows, verifiers run readiness and capacity gates. If normal
rolls cannot clear inside the low-cost band, the right product answer is to
pause growth, shrink capacity, or require more backstop/solver liquidity. It
should not quietly force users through expensive rotation.

## Try The Demo

```bash
python3 -m http.server 8765
```

Open:

```text
http://localhost:8765/demo/
```

The demo separates the experience by user:

```text
Trade: buy and sell Steady ETH or Boosted ETH with ETH
Vault: deposit ETH into the liquidity vault and see vault risk
Auctions: inspect solver/keeper roll activity
```

## 2-Minute Demo Path

Use this path when showing the MVP to a teammate:

```text
1. Trade page
   Buy Steady ETH with ETH, then switch to Boosted ETH.
   The story is: one product is calmer ETH exposure, the other is higher-upside
   ETH exposure.

2. Sell flow
   Switch Buy to Sell.
   The story is: users can exit back to ETH without learning the roll machinery.

3. Vault page
   Show the ETH LP vault deposit flow and risk language.
   The story is: LPs provide ETH liquidity, earn market-making PnL, and can lose.

4. Auctions page
   Show public roll auctions, solver actions, and vault backstop status.
   The story is: rolls are public, solvers compete, and the vault bootstraps
   liquidity only inside the cheap-roll policy.
```

The demo is ready to show when `node ops/mvp-acceptance.mjs --local-live`
passes. That gate proves the user-facing trade flow, LP vault flow, public
solver roll path, no-solver vault bootstrap path, settlement runner, and
readiness checks on a fresh local deployment. It also runs a no-admin surface
check that rejects common owner/admin/upgradability patterns and verifies
RollAuction deployments use `guardian = address(0)`.

## Demo Evidence

What is proven today:

```text
The static demo opens and keeps the Trade, Vault, and Auctions pages usable.
Traders can buy and sell Steady ETH and Boosted ETH with ETH locally.
LPs can deposit, withdraw, and claim through the ETH LP vault locally.
External solvers can fill public roll auctions.
The ETH LP vault can bootstrap a small no-solver launch locally.
The settlement runner can settle matured local series.
Readiness rejects unsafe staging defaults, including mock settlement when
--require-median-oracle is used.
```

What is not claimed yet:

```text
public-fund safety
external audit coverage
real solver liquidity commitments
a production deployment manifest passing --rpc readiness
production wallet hardening, monitoring, and incident response
```

## Run The MVP

Run the contract suite:

```bash
forge test -vvv
```

Run the full local acceptance gate:

```bash
node ops/mvp-acceptance.mjs --local-live
```

That command starts a fresh local chain, deploys and seeds the MVP, funds
separate trader/LP/solver/keeper accounts, runs strict readiness, executes
Steady/Boosted buy and sell flows, proves an external-solver roll path, proves a
no-solver vault-only launch path, settles inventory, and checks that LP vault
accounting remains visible.

GitHub Actions runs the same local-live acceptance gate on pushes and pull
requests to `main`.

## What Must Stay True

These are product requirements, not implementation preferences:

```text
Traders use ETH by default.
LPs deposit ETH, not a hidden stablecoin balance sheet.
LP returns are market-making PnL with risk, not promised yield.
External solvers can bid into public roll auctions.
The ETH LP vault can bootstrap small launch caps without external solvers.
Normal rolls target <= 10 bps by default.
If cheap rolls fail, capacity pauses or shrinks instead of hiding high costs.
Settlement uses a median of USDC, USDT, and DAI Uniswap TWAP sources.
No trusted manual settlement, exclusive market maker, or centralized roll path is required.
The normal launch path has no admin guardian.
```

## Team Handoff

Start here if you are joining the project:

```text
TEAM_HANDOFF.md      product mental model, invariants, and next workstreams
contracts_mvp.md     contract behavior and test coverage
deployment_mvp.md    local and Ethereum pilot deployment
solver_market.md     solver onboarding and fill attribution
SECURITY.md          current security posture and non-production caveats
CONTRIBUTING.md      PR expectations
```

## Builder Map

The repo has four main product surfaces:

```text
Trader liquidity:
  EthLPVault quotes and fills Steady ETH / ETH and Boosted ETH / ETH trades

User-facing exposure:
  SeriesExposureVault wrappers for continuous Steady and Boosted shares

Roll liquidity:
  RollAuction public Dutch auctions plus RollSolver helper

Protocol liquidity:
  EthLPVault plus EthLPVaultKeeper for trader fills, roll backstops, and inventory cleanup
```

Settlement uses:

```text
MedianStableTwapSettlementOracle over USDC, USDT, and DAI Uniswap v3 TWAPs
EthereumMainnetOracleConfig for bounded Ethereum mainnet pool configuration
MockSettlementOracle for local deterministic tests
```

Verification, keeper, settlement, and solver scripts:

```text
ops/mvp-acceptance.mjs             full local/live acceptance gate
ops/readiness-check.mjs            live manifest readiness gate
ops/local-live-smoke.mjs           fresh Anvil trader/LP/solver/keeper proof
ops/keeper-decisions.mjs           public-state settlement/keeper/solver suggestions
ops/keeper-runner.mjs              optional action-scoped transaction runner
ops/solver-improvement-report.mjs  public solver-vault fill attribution
ops/vault-strategy-plan.mjs        deterministic LP vault action planner
ops/capacity-policy.py             ETH-denominated launch cap gate
ops/economic-stress-check.py       historical low-cost roll stress gate
ops/mainnet-oracle-preflight.mjs   Ethereum mainnet oracle pool preflight
```

## Local Deployment

For a local live demo on Anvil, deploy direct components, export the manifest,
and seed markets with:

The local topology helper is constructor-filled deployment metadata. It is only
used to export demo addresses and seed demo AMMs.

```bash
PRIVATE_KEY=<PRIVATE_KEY> node ops/deploy-local-demo.mjs \
  --rpc http://127.0.0.1:8545
```

Then check whether the deployment is runnable:

```bash
node ops/readiness-check.mjs \
  --manifest demo/contract-manifest.json \
  --rpc http://127.0.0.1:8545
```

The human-readable readiness report starts with a launch-posture summary for
trader route, liquidity engine, roll safety, settlement, and no-admin/public
execution, then prints the full checklist underneath.

For a production-style capacity check, pass committed Boosted/solver demand and
make cap misses blocking:

```bash
node ops/readiness-check.mjs \
  --manifest demo/contract-manifest.json \
  --rpc <RPC_URL> \
  --require-median-oracle \
  --boosted-demand-eth 5000 \
  --solver-float-eth 250 \
  --capacity-strict
```

Leave `--require-median-oracle` off for the local mock demo. Use it for staging
or pilot readiness so mock/manual settlement cannot accidentally pass. Readiness
also enforces the median-oracle gate automatically for live-like manifest modes
such as `live`, `staging`, `pilot`, and `production`; local modes such as
`local-live`, `simulation`, `demo`, and `test` remain mock-oracle compatible.

For a small no-solver launch, gate capacity by the ETH LP vault alone:

```bash
python3 ops/capacity-policy.py \
  --end 2026-06-01 \
  --lp-vault-eth 50 \
  --boosted-demand-eth 0 \
  --solver-float-eth 0 \
  --target-steady-eth 5 \
  --rlp-capital-ratio 10 \
  --no-solver-launch \
  --strict
```

Before a roll, turn current liquidity and roll cost into an explicit vault
strategy action:

```bash
node ops/vault-strategy-plan.mjs \
  --target-steady-cap-eth 5 \
  --target-roll-eth 5 \
  --lp-vault-eth 50 \
  --solver-fill-eth 0 \
  --observed-roll-cost-bps 8.5 \
  --no-solver-launch
```

The planner returns one of the product actions: clear with solvers, wait for
solvers then vault-backstop, vault-only bootstrap, pause rolls, shrink capacity,
or require more solver/Boosted liquidity.

## Permissionless Runners

Anyone can inspect public roll state:

```bash
node ops/keeper-decisions.mjs \
  --manifest demo/contract-manifest.json \
  --rpc <RPC_URL>
```

Permissionless bots can then act after reviewing the dry-run output. These are
not privileged roles; they are ordinary transactions constrained by contract
policy.

```bash
# Solver bot: compete for roll auctions.
node ops/keeper-runner.mjs \
  --rpc <RPC_URL> \
  --action solver \
  --recipient <ADDRESS> \
  --solver-model ops/solver-model-spread.mjs

# Settlement bot: settle mature series when the oracle is ready.
node ops/keeper-runner.mjs --rpc <RPC_URL> --action settlement

# Wrapper keeper bot: start/finalize/reset/cancel validated wrapper rolls.
node ops/keeper-runner.mjs --rpc <RPC_URL> --action wrapper

# ETH LP vault bot: backstop rolls or clean up tracked inventory.
node ops/keeper-runner.mjs \
  --rpc <RPC_URL> \
  --action lp \
  --strategy-no-solver-launch
```

Add `--execute` only after setting the key for that action scope:

```text
SOLVER_PRIVATE_KEY
SETTLEMENT_RUNNER_PRIVATE_KEY
WRAPPER_KEEPER_PRIVATE_KEY
LP_KEEPER_PRIVATE_KEY
```

## Research Scripts

The research scripts are still useful, but they are supporting tools now, not
the product identity of the repo.

```bash
python3 sim.py --start 2018-01-01 --end 2026-06-01
python3 roll_market.py --start 2018-01-01 --end 2026-06-01
python3 n_side.py --start 2018-01-01 --end 2026-06-01
python3 n_demand.py --start 2018-01-01 --end 2026-06-01
python3 rlp_sim.py --start 2018-01-01 --end 2026-06-01
python3 rlp_risk.py --start 2018-01-01 --end 2026-06-01
python3 user_bands.py --start 2018-01-01 --end 2026-06-01 --cost-bps 10
python3 standardization.py --start 2018-01-01 --end 2026-06-01 --cost-bps 10
python3 twap_caps.py --depth-1pct 10000000 --target-bps 50,100,500
```

The scripts use historical data and simplified pricing assumptions to explore
capacity, roll cost, and liquidity sensitivity. They are not a production
pricing oracle.

## Current Status

This is a research MVP and is not ready for public funds.

Known gaps before real value:

```text
external security audit
production deployment manifest proven by live readiness
real solver commitments or liquidity SLAs
production wallet/frontend hardening
incident response and bug bounty process
```

Do not weaken these caveats until the evidence exists.
