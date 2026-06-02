# Index Options Simulator

Small research simulator for the options-based index tracking idea described in:

https://ethresear.ch/t/building-index-tracking-assets-on-top-of-options-instead-of-debt/25036

The first model focuses on a USD-tracking `P_K` token backed by ETH.

## Team Handoff

Start with `TEAM_HANDOFF.md` if you are joining the project. It explains the
product mental model, the strict invariants, the test commands, and the next
workstreams.

Use `CONTRIBUTING.md` for PR expectations and `SECURITY.md` for the current
security posture.

## Token model

For a strike `K` in USD per ETH, one dollar-normalized `P_K` unit is backed by
`1 / K` ETH and pays at maturity:

```text
min(1, ETHUSD / K) dollars
```

Equivalently, it behaves like `$1` minus `1 / K` of an ETH put option. When ETH
is far above `K`, `P_K` should trade close to `$1`; as ETH approaches `K`, it
develops quadratic drift away from the dollar target.

This is a pragmatic normalization of the post's ETH-collateralized `P/N` pair:
one full ETH split can be viewed as creating `K` dollar-normalized units.

## Run

```bash
python3 sim.py --start 2018-01-01 --end 2026-06-01
```

The script fetches ETH-USD daily candles from Yahoo Finance, caches them under
`data/`, and prints a strategy comparison table.

## Browser demo

```bash
python3 -m http.server 8765
```

Then open:

```text
http://localhost:8765/demo/
```

The demo has separate pages for traders and liquidity providers. The trader page
shows Steady/Boosted exposure in simple terms; the liquidity-provider page shows
roll-vault capacity, expected quote width, and TWAP safety caps.

To explore roll venues and liquidity depth:

```bash
python3 roll_market.py --start 2018-01-01 --end 2026-06-01
```

This compares immediate AMM-style execution against delayed RFQ/batch venues
whose cost depends on order size, daily depth, and waiting time.

To inspect the `N` side created opposite stability demand:

```bash
python3 n_side.py --start 2018-01-01 --end 2026-06-01
```

To estimate how much recurring `N` demand a Steady vault requires:

```bash
python3 n_demand.py --start 2018-01-01 --end 2026-06-01
```

To model an HLP-like roll liquidity vault:

```bash
python3 rlp_sim.py --start 2018-01-01 --end 2026-06-01
```

To mark the RLP vault's residual inventory risk:

```bash
python3 rlp_risk.py --start 2018-01-01 --end 2026-06-01
```

To produce user-facing risk bands:

```bash
python3 user_bands.py --start 2018-01-01 --end 2026-06-01 --cost-bps 10
```

To compare idealized versus standardized strikes and expiries:

```bash
python3 standardization.py --start 2018-01-01 --end 2026-06-01 --cost-bps 10
```

To estimate rough open-interest caps for onchain TWAP settlement:

```bash
python3 twap_caps.py --depth-1pct 10000000 --target-bps 50,100,500
```

See `decentralized_mvp.md` for the simplified trust-minimized design and
`oracle_settlement.md` for the broader oracle/settlement notes.

## Contract MVP

The first Solidity core is under `src/` and uses Foundry:

```bash
forge test -vvv
```

For the full MVP acceptance gate, run:

```bash
node ops/mvp-acceptance.mjs
```

That command checks the contract product loop, the trader demo surface, the
keeper/solver scripts, historical roll economics, and the ETH-denominated
launch capacity policy. Add `--rpc <RPC_URL>` after deploying a manifest to
include the live decentralized readiness check.

For a heavier local-chain proof, run:

```bash
node ops/mvp-acceptance.mjs --local-live
```

It starts Anvil, deploys and seeds the MVP, funds separate trader/LP/solver/
keeper accounts, deposits the ETH LP vault, runs strict live readiness, buys and
sells Steady/Boosted ETH, then uses `ops/keeper-runner.mjs` to prove two roll
paths: external solver plus ETH LP vault, and no-solver launch where the ETH LP
vault clears the roll alone. Both paths finalize the wrapper roll, redeem and
close LP inventory, and check that LP managed ETH increased from the
market-making spread.

In local-live mode the acceptance gate also runs an explicit local manifest
readiness step, including negative probes that must reject an unpinned LP roll
seller topology and a nonzero auction guardian by default. Readiness also makes
wrapper deposit-growth pauses visible, so a failed cheap roll stops new capacity
instead of being hidden behind normal UX. This tests the same
`ops/readiness-check.mjs` path even when no external RPC is provided.

GitHub Actions runs the same local-live acceptance gate on pushes and pull
requests to `main`, so team changes should keep the contracts, demo, operators,
economics, and no-solver launch path green before merging.

Implemented:

```text
EthOptionsFactory: ETH-backed P/N option split
SeriesExposureVault: auto-rolling Steady/Boosted series-token wrapper with immutable deposit capacity
SeriesExposureVaultKeeper: permissionless keeper facade for start/reset/finalize/cancel wrapper rolls, dust limits, product roll-size caps, and optional maintenance bounties
EthLPVault: ETH LP vault with conservative roll-bidding inventory accounting, direct merge/redeem cleanup paths, guarded AMM inventory sales, immutable size/price limits, solver-first delay, and auction freshness limits
EthLPVaultKeeper: permissionless keeper facade for allowed LP bid/cleanup actions with wrapper-seller pinning and optional funded bounties
EthTokenAMM: ETH market for buying/selling continuous Steady/Boosted wrapper shares
RollAuction: permissionless Dutch auction for old-series/new-series rolls, including callback settlement, dust rules, active-auction flood limits, stale price-decay reset, and optional guardian circuit-breaker levels
RollSolver: atomic helper for external solvers to mint/source payment during roll auction settlement, including fill-all paths for clearing the current remainder
ProtocolHealthLens: read-only operator/risk dashboard helper, including auction reset readiness, LP share/account, LP inventory, and wrapper-keeper policy views
MockSettlementOracle: local/test settlement adapter
UniswapV3TwapSettlementOracle: maturity-anchored cumulative tick TWAP adapter
MedianStableTwapSettlementOracle: median of USDC, USDT, and DAI Uniswap v3 TWAPs
EthereumMainnetOracleConfig: guarded mainnet 3-stable median TWAP config
DeployLocalMvp: local mock-oracle deployment topology
DeployLocalMvpManifest: broadcast-friendly local component deployer plus topology registry with optional P/N inventory markets
DeployEthereumPilot: guarded Ethereum mainnet pilot deployment topology with optional P/N inventory markets
ops/deploy-local-demo.mjs: one-command Anvil deploy, manifest export, and AMM seeding helper
ops/frontend-live-surface-check.mjs: static acceptance check for wallet-connected trader, LP, solver, keeper, and settlement actions, including calldata selector drift checks
ops/local-live-smoke.mjs: fresh-Anvil deploy/trader/LP/solver smoke test, including optional negative readiness probes
ops/mvp-acceptance.mjs: local/live acceptance gate for trader, LP, solver, and decentralized-liveness requirements
ops/solver-model-spread.mjs: reference external solver model for price-edge and fill-size decisions
ops/solver-improvement-report.mjs: public event-log attribution for solver fills versus ETH LP vault backstop fills
ops/readiness-check.mjs: live manifest/RPC readiness gate for trader markets, LP vault, solver auctions, keepers, settlement wiring, and decentralized liveness
ops/economic-stress-check.py: historical RLP/N-side stress gate for roll cost, capacity, and paired Boosted demand assumptions
ops/capacity-policy.py: ETH-denominated launch cap gate from committed LP-vault capital, Boosted/solver demand, or explicit no-solver launch mode
ops/vault-strategy-plan.mjs: deterministic ETH LP vault action plan for solver-first, vault-backstop, pause, shrink, or liquidity-required decisions
```

Independent operators can inspect public roll state and get suggested keeper or
solver commands with:

```bash
node ops/keeper-decisions.mjs --manifest demo/contract-manifest.json --rpc <RPC_URL>
```

The same helper now prioritizes direct LP inventory cleanup before looking for a
market buyer: matched P+N balances merge back to ETH, settled P/N balances redeem
to ETH, and only residual unpaired inventory uses optional public AMMs from
`inventoryMarkets`. It also discovers active auctions directly from known wrapper
sellers, reads the immutable global and per-seller active-auction ceilings, and
marks new wrapper roll starts as not ready when the public auction board or
wrapper seller quota is full. The companion runner turns those public-state
decisions into a dry-run or
operator-selected execution loop:

For roll auctions, `keeper-decisions` also attaches a vault strategy plan and
blocks LP backstop suggestions by default when the current roll would breach
the low-cost band or lacks enough managed ETH vault capital. Pass
`--strategy-no-solver-launch` for a deliberately small bootstrap, or pass
committed `--strategy-boosted-demand-eth` and `--strategy-solver-float-eth` for
scale mode.

```bash
# Solver role: compete for roll auctions.
node ops/keeper-runner.mjs \
  --rpc <RPC_URL> \
  --action solver \
  --recipient <ADDRESS> \
  --solver-model ops/solver-model-spread.mjs

# Solver attribution: measure external fill before the ETH LP vault.
node ops/solver-improvement-report.mjs \
  --rpc <RPC_URL> \
  --auction-id <AUCTION_ID>

# Wrapper keeper role: start/finalize/reset/cancel validated wrapper rolls.
node ops/keeper-runner.mjs --rpc <RPC_URL> --action wrapper

# ETH LP vault role: backstop rolls or clean up tracked inventory.
node ops/keeper-runner.mjs \
  --rpc <RPC_URL> \
  --action lp \
  --strategy-no-solver-launch
```

Add `--execute` only after reviewing the dry-run output and setting the key for
that role: `SOLVER_PRIVATE_KEY`, `WRAPPER_KEEPER_PRIVATE_KEY`, or
`LP_KEEPER_PRIVATE_KEY`. `PRIVATE_KEY` remains a local-test fallback, and
`--private-key-env <NAME>` can override all role keys. The runner requires an
explicit `--action` in execute mode, so operators choose their role instead of
blindly running every possible action.

For a local live demo on Anvil, deploy direct components, export the registry
manifest, and seed markets with one helper:

```bash
PRIVATE_KEY=<PRIVATE_KEY> node ops/deploy-local-demo.mjs \
  --rpc http://127.0.0.1:8545
```

Then check whether the deployment is actually runnable:

```bash
node ops/readiness-check.mjs \
  --manifest demo/contract-manifest.json \
  --rpc http://127.0.0.1:8545
```

For a production-style capacity check, pass committed Boosted/solver demand and
make cap misses blocking:

```bash
node ops/readiness-check.mjs \
  --manifest demo/contract-manifest.json \
  --rpc <RPC_URL> \
  --boosted-demand-eth 5000 \
  --solver-float-eth 250 \
  --capacity-strict
```

On Ethereum mainnet, readiness also verifies that both series use the same
median settlement oracle, that each series uses at least a 72-hour settlement
TWAP window by default, and that the oracle exposes the guarded USDC, USDT, and
DAI Uniswap v3 source pool configuration.
Readiness expects the roll auction guardian to be `address(0)` by default, so
admin circuit breakers are permanently disabled; use `--allow-auction-guardian`
only for a deliberately guarded pilot.

Before raising Steady capacity, run the historical economic stress gate:

```bash
python3 ops/economic-stress-check.py --end 2026-06-01
python3 ops/economic-stress-check.py --end 2026-06-01 --rlp-capital-ratio 10 --n-external-fill 0.95
```

The default gate targets a weighted roll cost of at most 10 bps. Under the
current conservative historical assumptions, the 2018-01-01 to 2026-06-01
window clears at 8.6 bps with a 10x ETH LP capital ratio and 95% external
N-side fill.

Then turn the committed liquidity into an ETH-denominated Steady cap:

```bash
python3 ops/capacity-policy.py \
  --end 2026-06-01 \
  --lp-vault-eth 1000 \
  --boosted-demand-eth 5000 \
  --target-steady-eth 100 \
  --strict
```

For a small Hyperliquid-style bootstrap with no committed external solvers yet,
gate capacity by the ETH LP vault alone and keep the cap small:

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

Before a roll, turn the current quote, solver interest, and LP vault capital
into an explicit vault strategy action:

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

See `contracts_mvp.md` for the current contract surface and next build steps.
See `deployment_mvp.md` for local and guarded Ethereum pilot deployment topology.

## Caveats

This is not a production pricing model. It uses Black-Scholes put pricing only
as a rough market-price proxy for `P_K`; the post explicitly warns against
depending on a volatility oracle. The purpose here is to compare rebalancing
rules, slippage sensitivity, and rough viability.
