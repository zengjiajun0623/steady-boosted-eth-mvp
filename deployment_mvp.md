# Deployment MVP

Three dependency-free deployment helpers are available:

```text
script/DeployLocalMvp.sol: local/mock oracle topology
script/DeployLocalMvpManifest.sol: direct local component deployer plus topology registry
script/DeployEthereumPilot.sol: guarded Ethereum mainnet TWAP pilot topology
```

They deploy:

```text
EthOptionsFactory
RollAuction
RollSolver
EthLPVaultKeeper
EthLPVault managed by the keeper
first and second option series
Steady wrapper keeper
Boosted wrapper keeper
Steady wrapper for first-series P, managed by its keeper
Boosted wrapper for first-series N, managed by its keeper
Steady ETH/share AMM
Boosted ETH/share AMM
Direct P/N inventory AMMs for first and second series
```

The LP keeper is configured after wrapper deployment with the Steady and
Boosted wrapper addresses as its only allowed roll sellers. Readiness fails if
this seller pinning is missing or points anywhere else.

`DeployLocalMvp` and `DeployLocalMvpManifest` use `MockSettlementOracle`.
`DeployEthereumPilot` uses `EthereumMainnetOracleConfig` and
`MedianStableTwapSettlementOracle`.

All supported deployment paths use settlement oracles that register the exact
series metadata during `createSeries`. If that registration fails, series
creation reverts instead of leaving a hidden manual-settlement rescue path.

## Local Mock-Oracle Deploy

For local Anvil demos, use `ops/deploy-local-demo.mjs`. It wraps
`DeployLocalMvpManifest`, broadcasts each component deployment directly with
Foundry's `--slow` mode, exports `demo/contract-manifest.json`, and seeds the
Steady/Boosted AMMs. This avoids the large initcode of deploying the all-in-one
topology holder as a normal contract.

```bash
PRIVATE_KEY=<PRIVATE_KEY> node ops/deploy-local-demo.mjs \
  --rpc <RPC_URL>
```

Manual deployment is still available when you want to control each step.

Compile and test:

```bash
forge test -vvv
```

Deploy direct components and write the topology registry address to
`demo/deployment-registry.txt`:

```bash
forge script script/DeployLocalMvpManifest.sol:DeployLocalMvpManifest \
  --rpc-url <RPC_URL> \
  --private-key <PRIVATE_KEY> \
  --broadcast \
  --slow
```

Export a demo manifest from the topology registry:

```bash
node ops/export-manifest.mjs \
  --rpc <RPC_URL> \
  --topology "$(cat demo/deployment-registry.txt)" \
  --out demo/contract-manifest.json \
  --mode local-live
```

Bootstrap usable local markets by calling the topology registry:

```bash
cast send "$(cat demo/deployment-registry.txt)" \
  'seedMarkets(uint256,uint256,uint256,uint256,address)' \
  <steadyShares> <boostedShares> <steadyMarketEth> <boostedMarketEth> <recipient> \
  --rpc-url <RPC_URL> \
  --private-key <PRIVATE_KEY> \
  --value <max(steadyShares,boostedShares)+steadyMarketEth+boostedMarketEth>
```

Bootstrap optional direct P/N inventory markets for keeper-driven LP vault
unwinds:

```bash
cast send "$(cat demo/deployment-registry.txt)" \
  'seedInventoryMarket(bool,bool,uint256,uint256,address)' \
  <secondSeries> <nSide> <tokenAmount> <marketEth> <recipient> \
  --rpc-url <RPC_URL> \
  --private-key <PRIVATE_KEY> \
  --value <tokenAmount+marketEth>
```

Use `secondSeries=true,nSide=false` for second-series P and
`secondSeries=true,nSide=true` for second-series N. Use `secondSeries=false`
for first-series direct inventory markets.

The older `DeployLocalMvp` contract is still useful in tests and for environments
that allow the larger deployment contract. Deploying that wiring contract itself
looks like:

```bash
forge create script/DeployLocalMvp.sol:DeployLocalMvp \
  --rpc-url <RPC_URL> \
  --private-key <PRIVATE_KEY>
```

Then call:

```text
deployDefault()
```

To bootstrap usable local markets, call:

```text
seedMarkets(steadyShares, boostedShares, steadyMarketEth, boostedMarketEth, recipient)
seedInventoryMarket(secondSeries, nSide, tokenAmount, marketEth, recipient)
```

Send enough ETH with the call:

```text
max(steadyShares, boostedShares) + steadyMarketEth + boostedMarketEth
```

The helper does the first-product choreography:

```text
mint first-series P/N from ETH
wrap P into Steady shares
wrap N into Boosted shares
seed steadyMarket with ETH + Steady shares
seed boostedMarket with ETH + Boosted shares
send AMM LP shares to recipient
send any leftover first-series paired inventory to recipient
```

`seedInventoryMarket` mints the selected first/second series, seeds the selected
direct P or N AMM with ETH plus that token, and sends the paired-side token to
the recipient.

Read the manifest from:

```text
core()      -> factory, oracle, rollAuction, rollSolver, lpKeeper, lpVault
series()    -> firstSeriesId, secondSeriesId, firstP, firstN, secondP, secondN
products()  -> steadyVault, boostedVault, steadyMarket, boostedMarket
inventoryMarkets() -> firstPMarket, firstNMarket, secondPMarket, secondNMarket
steadyMarket.token() / boostedMarket.token() -> continuous wrapper share tokens
wrapperKeepers() -> steadyKeeper, boostedKeeper
healthLens() -> read-only protocol health lens for dashboards
```

## Guarded Ethereum Pilot Deploy

`DeployEthereumPilot` mirrors the local topology but refuses non-mainnet
deployment:

```text
block.chainid must be 1
capEth must be at or below the 50 ETH pilot cap
series TWAP window comes from EthereumMainnetOracleConfig
settlement oracle is MedianStableTwapSettlementOracle
```

Deploy the wiring contract:

```bash
forge create script/DeployEthereumPilot.sol:DeployEthereumPilot \
  --rpc-url <MAINNET_RPC_URL> \
  --private-key <PRIVATE_KEY>
```

Then call `deploy(Config)` with explicit pilot parameters:

```text
strike: ETH/stable strike with 18 decimals
firstMaturity: first series maturity timestamp
secondMaturity: second series maturity timestamp
capEth: per-series cap, maximum 50 ETH
withdrawDelay: LP withdrawal delay
maxEthPerRoll / maxActiveStrategyEth: LP vault risk limits
maxRollPriceWad: maximum roll price paid by vault/wrappers
minInventorySalePriceWad: minimum ETH/token price accepted for residual LP inventory AMM sales
auctionGuardian: set to address(0) for the normal trust-minimized launch path;
a nonzero guardian is only for an explicit guarded pilot circuit-breaker exception
minLpBackstopDelay: solver-first delay before the LP vault can backstop a roll
minLpAuctionTimeLeft / maxLpAuctionPriceDropBps: LP vault freshness limits for
backstop auction bids after the delay; launch deployments cap the price-decay
limit to the same normal roll-cost target, 10 bps by default
steadyFloorPriceWad / boostedFloorPriceWad: minimum Dutch auction floor
minAuctionDuration / maxAuctionDuration: wrapper keeper roll limits
minWrapperRollAmount: dust threshold for wrapper-started roll auctions and RollAuction fills
maxWrapperRollAmount: per-product roll-size cap for wrapper-started roll auctions
maxActiveRollAuctions: deployment-time cap on the public active auction list
maxActiveRollAuctionsPerSeller: deployment-time cap on active auctions from one seller
minRewardedOperationAmount: minimum LP keeper action size eligible for bounty
keeperRewardEth: optional fixed ETH bounty paid from funded keeper reward pools
ammFeeBps: pilot AMM swap fee
```

Read the same values from:

```text
core()
series()
products()
wrapperKeepers()
healthLens()
```

To bootstrap the first guarded pilot markets, call:

```text
seedMarkets(steadyShares, boostedShares, steadyMarketEth, boostedMarketEth, recipient)
```

Send enough ETH with the call:

```text
max(steadyShares, boostedShares) + steadyMarketEth + boostedMarketEth
```

The helper mints the first option series, wraps `P` into Steady shares, wraps
`N` into Boosted shares, seeds both AMMs, sends AMM LP shares to `recipient`,
and returns any leftover first-series paired inventory to `recipient`.

For topology contracts or registries exposing `core()`, `series()`,
`products()`, `wrapperKeepers()`, and `healthLens()`, generate the manifest with:

```bash
node ops/export-manifest.mjs \
  --rpc <RPC_URL> \
  --topology <TOPOLOGY_OR_REGISTRY_ADDRESS> \
  --out demo/contract-manifest.json
```

The demo page stays in simulation mode until the manifest contains valid
addresses for:

```text
steadyMarket
boostedMarket
lpVault
firstP
firstN
steadyShare / boostedShare are optional; the app reads market.token() live
```

Once a wallet is connected, the demo can submit:

```text
ETH -> Steady/Boosted AMM buy transactions
Steady/Boosted approval + sell transactions
ETH LP vault deposit transactions
ETH LP vault withdraw request + claim transactions
ETH LP vault keeper bid/unwind transactions for roll inventory
wrapper keeper start, reset, finalize, and cancel transactions
factory settle, redeemP, and redeemN transactions for matured direct tokens
solver direct RollAuction.fill transactions
solver atomic RollSolver callback mint-and-fill transactions
```

With a connected wallet and manifest, the demo also reads:

```text
ETH, Steady, and Boosted balances
live AMM buy/sell quotes
Steady/Boosted market token addresses from EthTokenAMM.token()
ETH LP vault share value, managed assets, and active strategy state
ETH LP vault max roll price, strategy capacity, solver-first delay, minimum
auction time left, and maximum price-decay policy
RollAuction remaining inventory and current Dutch price
RollAuction auctionStatus and resetStatus read models for solver/keeper state
RollAuction active auction ids for solver discovery
RollAuction stale reset policy for wrapper reset suggestions
wrapper keeper current/pending series and active roll auction state
factory series maturity, settled state, settlement price, and redeemable wallet balance
```

For keeper and risk dashboards, read `healthLens()` and call:

```text
marketHealth(...) -> AMM reserves, fee, sample buy/sell quotes
lpVaultHealth(...) -> managed ETH, reserved ETH, strategy utilization, deposit
pause state, LP share price, solver-first delay, auction freshness limits, and price-decay limits
lpInventoryHealth(...) -> tracked LP vault P/N balances, mergeable paired amount,
unpaired exposure, and maturity/settlement state
lpAccountHealth(...) -> LP share balance, current claimable assets, pending
withdrawal amount, unlock time, and claimable flag
wrapperHealth(...) -> current token, capacity, deposit-growth pause state, roll state, active roll auction id
seriesHealth(...) -> cap usage, maturity, settlement state
auctionHealth(...) -> seller, tokens, current Dutch price, remaining size, time left,
and Maker-style reset readiness from expiry or stale price decay
auctionPolicyHealth(...) -> guardian, stopped level, dust threshold, active auction count and ceilings
auctionPolicyHealth(...) also includes stale reset delay and price-drop threshold
wrapperKeeperHealth(...) -> wrapper roll price, duration, dust, cap, and reward policy
```

The backend contract also exposes `RollAuction.fillAll(...)`,
`RollAuction.fillWithCallback(...)`, and `RollAuction.fillAllWithCallback(...)`
for external bots that want to take inventory with one protected max-price
bound or source the payment token inside a callback router. The demo UI
intentionally keeps a sized-fill control instead of adding another solver mode.

For new deployments, the Auctions page can discover open auctions from
`RollAuction.activeAuctionCount()` and `activeAuctionIdAt(index)`, then match
Steady and Boosted rolls by their old-token/new-token pair. Solver bots can
also watch known wrapper sellers directly with `activeAuctionCountBySeller(...)`
and `activeAuctionIdBySellerAt(...)`.

Independent keepers and solvers can use the dependency-free operator helper:

```bash
node ops/keeper-decisions.mjs --manifest demo/contract-manifest.json --rpc <RPC_URL>
```

It reads public contract state, active auctions, wrapper-seller active auctions,
the global and per-seller active-auction ceilings, wrapper keeper state, wrapper
roll-size caps, the auction circuit-breaker level, the auction dust threshold,
the auction stale-reset policy, the ETH LP vault backstop policy, plus the
optional `ProtocolHealthLens`, then
prints suggested `cast send` commands for:

```text
solver RollSolver.mintAndFillWithCallback / mintAndFillNWithCallback bids
ETH LP vault backstop bids through EthLPVaultKeeper
ETH LP vault matched-inventory merges through EthLPVaultKeeper
ETH LP vault settled-inventory redeems through EthLPVaultKeeper
ETH LP vault residual tracked-inventory sells through matching ETH/token AMMs
wrapper startRoll when the full idle inventory can move to the next series
wrapper finalizeRoll when a roll auction is fully filled
wrapper resetRoll when an auction expires or crosses the stale price-drop threshold with inventory left
wrapper cancelUnfilledRoll when an auction expired with no fills
```

Use `--json` for bot-friendly output. Use `--max-price-wad` and
`--max-fill-eth` to cap solver risk. External solvers can also pass
`--solver-model <path>` to plug in their own bidding model. The model receives a
single auction context as JSON on stdin and returns a JSON object like:

```json
{
  "bid": true,
  "maxPriceWad": "997500000000000000",
  "sellAmountWei": "1000000000000000000",
  "reason": "Current Dutch price is inside the model price after 25 bps edge."
}
```

The operator `--max-price-wad` remains a hard cap even when a model asks for a
higher price. The included `ops/solver-model-spread.mjs` is a simple reference
model that treats a 1:1 roll as fair, waits for `SOLVER_EDGE_BPS` of edge, and
optionally caps size with `SOLVER_MAX_FILL_ETH`. Use `--max-inventory-sell-eth`
to cap each ETH LP vault cleanup suggestion and `--inventory-slippage-bps` to
set the minimum ETH-out buffer for residual AMM sells. The script marks solver,
LP, and wrapper-start actions as not
ready if they would violate the current circuit-breaker level, auction dust
threshold, product roll-size cap, global active-auction ceiling, or wrapper
seller's active-auction ceiling. LP backstop actions are also marked not ready if
the auction is too close to expiry, too far down the Dutch curve, above the LP
max roll price, inside the solver-first delay window, or above the LP vault's
remaining strategy capacity. It does not send transactions by itself; it is an
open decision layer that any operator can run and audit.

The helper also runs `ops/vault-strategy-plan.mjs` for each live roll auction.
By default, the LP backstop suggestion is blocked if the strategy plan fails:
the current roll must remain inside the normal roll-cost band and be supported
by managed ETH LP vault capital. For a deliberately small bootstrap, pass
`--strategy-no-solver-launch`; for scale mode, pass committed
`--strategy-boosted-demand-eth` and `--strategy-solver-float-eth`. Use
`--no-strategy-gate` only for inspection or emergency debugging, not normal
operation.

When a solver action is sized to the full current auction remainder, the helper
emits the `RollSolver` fill-all variant instead of a fixed-size fill. This keeps
the solver protected by `maxBuyAmount` while avoiding needless stale-size reverts
if another counterparty partially fills before the transaction lands.

Before treating a manifest as pilot-ready, run the readiness gate:

```bash
node ops/readiness-check.mjs \
  --manifest demo/contract-manifest.json \
  --rpc <RPC_URL> \
  --expect-chain-id <CHAIN_ID_HEX> \
  --strict
```

The checker reads only public state. It verifies deployed bytecode, live
Steady/Boosted trader market reserves and sample quotes, LP vault manager and
backstop policy, LP vault inventory visibility, wrapper keeper wiring, auction
circuit-breaker state, solver helper availability, settlement oracle wiring,
first/second series compatibility for normal wrapper rolls, per-series cap
usage, wrapper deposit capacity staying inside the keeper roll cap, live cap
alignment against committed LP/Boosted/solver liquidity, and a decentralized
liveness gate across the trader, LP, solver, wrapper-keeper, auction, and
settlement surfaces. The
default gate warns if the LP vault has less than `0.1 ETH` managed because
trader markets can be live while the roll backstop is still unfunded.

For a broader pre-launch check that includes the local contract suite, demo and
operator syntax, Maker-style auction/reset paths, and historical capacity
assumptions, run:

```bash
node ops/mvp-acceptance.mjs
```

For a fresh local-chain proof, add `--local-live`:

```bash
node ops/mvp-acceptance.mjs --local-live
```

That starts Anvil, deploys and seeds the MVP, funds separate trader/LP/solver/
keeper accounts, deposits the ETH LP vault, runs strict readiness, exercises
Steady/Boosted trader buy/sell transactions, then uses `ops/keeper-runner.mjs`
to prove both launch paths: one public roll auction filled by `RollSolver` plus
the ETH LP vault, and one no-solver roll cleared by the ETH LP vault alone. Both
paths finalize the Steady wrapper roll, redeem and close LP inventory, and check
that LP managed ETH increased from the market-making spread.

After deploying a manifest, include the live deployment in that same gate:

```bash
node ops/mvp-acceptance.mjs \
  --manifest demo/contract-manifest.json \
  --rpc <RPC_URL> \
  --expect-chain-id <CHAIN_ID_HEX> \
  --live-strict
```

For production-style checks, pass the explicit committed demand side and make
capacity misses blocking:

```bash
node ops/readiness-check.mjs \
  --manifest demo/contract-manifest.json \
  --rpc <RPC_URL> \
  --boosted-demand-eth <CREDIBLE_BOOSTED_BUYER_ETH> \
  --solver-float-eth <SOLVER_BALANCE_SHEET_ETH> \
  --capacity-strict \
  --strict
```

The readiness capacity section uses visible Boosted AMM ETH plus the explicit
Boosted/solver commitments above. It compares that against the Steady wrapper
roll cap, Boosted wrapper roll cap, and factory series cap using the same
historical N-demand ratios documented below. This is still an operator gate,
not an onchain market-demand oracle.

For a small no-solver launch, pass `--no-solver-launch` and size the product by
LP-vault capital alone. This is the Hyperliquid-style bootstrap path: the ETH LP
vault is the transparent protocol liquidity engine, external solvers are still
free to improve execution, and capacity stays small until outside demand is real.
A practical starting rule is `5-10x` LP-vault ETH per max Steady roll size; for
example, a `5 ETH` max Steady roll needs about `25-50 ETH` in the ETH LP vault.

On Ethereum mainnet, readiness also treats the settlement oracle as a launch
gate: both live series must share one oracle, each series must use at least a
72-hour settlement TWAP window by default, the oracle must expose three sources,
and those sources must match the guarded USDC, USDT, and DAI Uniswap v3 median
config. Local mock-oracle deployments are still accepted off mainnet.

Before raising Steady capacity, also run the historical economic stress gate:

```bash
python3 ops/economic-stress-check.py --end 2026-06-01
```

The default economic check targets a weighted roll cost of at most `10 bps`,
models a `3x` RLP capital ratio, and assumes `80%` external N-side fill. It
should stay below the configured roll-cost and capacity-breach limits before
Steady TVL grows; add `--strict` when warnings should block a capacity increase.
A stronger target for larger capacity is:

```bash
python3 ops/economic-stress-check.py \
  --end 2026-06-01 \
  --rlp-capital-ratio 10 \
  --n-external-fill 0.95
```

This check is historical and approximate, but it gives the launch process a
repeatable answer to the key sustainability question: whether committed RLP
capital plus Boosted/N demand can keep roll costs low enough for Steady users.
The current 2018-01-01 to 2026-06-01 stress run clears the stronger target at
8.6 bps weighted roll cost.

After the assumptions pass, turn current committed liquidity into a concrete
Steady cap:

```bash
python3 ops/capacity-policy.py \
  --end 2026-06-01 \
  --lp-vault-eth <COMMITTED_LP_VAULT_ETH> \
  --boosted-demand-eth <CREDIBLE_BOOSTED_BUYER_ETH> \
  --solver-float-eth <SOLVER_BALANCE_SHEET_ETH> \
  --target-steady-eth <PROPOSED_STEADY_CAP_ETH> \
  --rlp-capital-ratio 10 \
  --n-external-fill 0.95 \
  --strict
```

This gate is ETH-denominated on purpose. The output gives a suggested launch
cap from average historical N demand, plus a stricter stress cap from the
maximum historical outstanding N demand. If a proposed Steady cap fails the LP
capital check or the average Boosted/N demand check, do not raise capacity. If
it only misses the stress cap, keep the cap small or require more committed
Boosted/solver demand first. When capacity is raised, redeploy or migrate the
wrapper with a matching `maxAssets` and keeper `maxWrapperRollAmount`; do not
let wrapper deposits exceed the cheap-roll capacity gate.

For the no-solver bootstrap case, make that mode explicit:

```bash
python3 ops/capacity-policy.py \
  --end 2026-06-01 \
  --lp-vault-eth <COMMITTED_LP_VAULT_ETH> \
  --boosted-demand-eth 0 \
  --solver-float-eth 0 \
  --target-steady-eth <PROPOSED_STEADY_CAP_ETH> \
  --rlp-capital-ratio 10 \
  --no-solver-launch \
  --strict
```

The auction should be launched with `auctionGuardian = address(0)` for the
normal trust-minimized launch path. This permanently disables admin setters
after deployment. In that mode, `RollAuction.stopped()` remains `0` and the
configured dust/stale-reset policy is immutable. Readiness fails by default if a
nonzero guardian is present; pass `--allow-auction-guardian` only for an
explicit guarded-pilot exception. If a guarded pilot uses a nonzero guardian, the
runner marks blocked actions as not ready when `RollAuction.stopped()` would
reject them:

```text
stopped = 0: live
stopped = 1: no new wrapper roll auctions
stopped = 2: no new wrapper roll auctions or stale-roll resets
stopped = 3: no new wrapper roll auctions, stale-roll resets, or fills
```

A nonzero auction guardian can set this level:

```bash
cast send <ROLL_AUCTION> \
  'setStopped(uint256)' <LEVEL> \
  --rpc-url <RPC_URL> \
  --private-key <GUARDIAN_PRIVATE_KEY>
```

Auction seller cancellation remains live at every level so inventory can be
returned instead of trapped.

The same nonzero guardian can adjust the minimum auction/fill size:

```bash
cast send <ROLL_AUCTION> \
  'setMinSellAmount(uint256)' <AMOUNT_WEI> \
  --rpc-url <RPC_URL> \
  --private-key <GUARDIAN_PRIVATE_KEY>
```

New auctions below this threshold are rejected. Partial fills below the threshold
are rejected unless they clear the full current remainder, and fills cannot leave
a nonzero remainder below the threshold. This keeps onchain auction discovery
usable for independent solvers.

The nonzero guardian can also tune the Maker-style stale reset rule:

```bash
cast send <ROLL_AUCTION> \
  'setStaleResetPolicy(uint64,uint16)' <MIN_DELAY_SECONDS> <MIN_PRICE_DROP_BPS> \
  --rpc-url <RPC_URL> \
  --private-key <GUARDIAN_PRIVATE_KEY>
```

`MIN_PRICE_DROP_BPS=0` disables early price-stale resets, leaving only full
auction expiry. The default local/pilot policy is 12 hours and 5 bps, which
fits the normal 10 bps roll-cost band.

To run an actual decentralized operator backend, use the companion runner. It
recomputes decisions from public state each pass, filters for ready actions with
structured transaction metadata, and defaults to dry-run:

```bash
node ops/keeper-runner.mjs \
  --manifest demo/contract-manifest.json \
  --rpc <RPC_URL> \
  --action wrapper
```

Execution mode requires `--execute`, at least one explicit `--action` role, and
a key env var for that role. Use separate keys for parallel operators so solver,
wrapper, and LP loops do not share nonce state:

```text
solver actions: SOLVER_PRIVATE_KEY, fallback PRIVATE_KEY
wrapper actions: WRAPPER_KEEPER_PRIVATE_KEY, fallback PRIVATE_KEY
LP backstop actions: LP_KEEPER_PRIVATE_KEY, fallback PRIVATE_KEY
LP inventory unwind: INVENTORY_KEEPER_PRIVATE_KEY, LP_KEEPER_PRIVATE_KEY, fallback PRIVATE_KEY
```

For local tests with a single key, pass `--private-key-env PRIVATE_KEY` or just
set `PRIVATE_KEY`. For production-style operation, prefer role-specific keys:

```bash
# External solver: bid only when the Dutch price is inside the configured cap.
SOLVER_PRIVATE_KEY=<SOLVER_PRIVATE_KEY> node ops/keeper-runner.mjs \
  --execute \
  --action solver \
  --manifest demo/contract-manifest.json \
  --rpc <RPC_URL> \
  --recipient <SOLVER_RECIPIENT> \
  --max-price-wad 1000000000000000000 \
  --max-fill-eth 0.25 \
  --solver-model ops/solver-model-spread.mjs

# Wrapper keeper: maintain product rolls.
WRAPPER_KEEPER_PRIVATE_KEY=<WRAPPER_KEEPER_PRIVATE_KEY> node ops/keeper-runner.mjs \
  --execute \
  --action wrapper \
  --interval 30 \
  --manifest demo/contract-manifest.json \
  --rpc <RPC_URL>

# ETH LP vault keeper: backstop allowed rolls and clean up tracked inventory.
LP_KEEPER_PRIVATE_KEY=<LP_KEEPER_PRIVATE_KEY> node ops/keeper-runner.mjs \
  --execute \
  --action lp \
  --interval 30 \
  --manifest demo/contract-manifest.json \
  --rpc <RPC_URL> \
  --max-inventory-sell-eth 0.1 \
  --inventory-slippage-bps 50
```

The runner recomputes public-state decisions each pass, chooses the matching
role key for each ready action, and prints the key env var name it used without
printing the key itself.

Useful action filters:

```text
solver -> solver-bid
wrapper -> wrapper-start-roll, wrapper-finalize-roll, wrapper-reset-roll, wrapper-cancel-roll
lp -> lp-backstop-bid, lp-inventory-merge, lp-inventory-redeem, lp-inventory-sell
inventory -> lp-inventory-merge, lp-inventory-redeem, lp-inventory-sell
all -> every ready executable action
```

For LP inventory cleanup, the helper uses direct paths before AMMs. Matched
unsettled P+N inventory is merged back to ETH, and settled inventory is redeemed
back to ETH. For remaining unpaired inventory, add optional direct P/N market
addresses to the manifest. The helper verifies each AMM's `token()` before suggesting a
`sellInventory(...)` command, and it will not suggest an AMM sale whose quote is
below the ETH LP vault's immutable inventory-sale floor:

```json
{
  "inventoryMarkets": {
    "firstP": null,
    "firstN": null,
    "secondP": "0x...",
    "secondN": "0x..."
  }
}
```

The optional `auctions` entries in `demo/contract-manifest.json` remain useful
for manual overrides, direct-fill tests, or older deployments that do not expose
the active-auction list:

```text
auctionId: active RollAuction id
newSeriesId: next factory series used by RollSolver
fillMode: mintAndFillWithCallback for Steady, mintAndFillNWithCallback for Boosted, or directFill
remainingEth / price / ui fields: optional display hints before a live auction is created
```

## Production Oracle Config

`DeployLocalMvp` uses `MockSettlementOracle`, which is only for local testing.
For the first guarded Ethereum mainnet pilot, use
`EthereumMainnetOracleConfig` to deploy `MedianStableTwapSettlementOracle` with:

```text
Uniswap V3 factory: 0x1F98431c8aD98523631AE4a59f267346ea31F984
USDC/WETH 0.05% pool: 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640
WETH/USDT 0.05% pool: 0x11b815efB8f581194ae79006d24E0d814B7697F6
DAI/WETH 0.05% pool: 0x60594a405d53811d3BC4766596EFD80fd545A270
USDC conversion: priceAtTickZeroWad 1e30, invert true, tick band 175000 to 221200
USDT conversion: priceAtTickZeroWad 1e30, invert false, tick band -221200 to -175000
DAI conversion: priceAtTickZeroWad 1e18, invert true, tick band -106500 to -53000
default TWAP window: 72 hours
initial pilot cap: 50 ETH per series
```

These pool facts were verified on Ethereum mainnet with:

```bash
cast call --rpc-url <mainnet-rpc> 0x1F98431c8aD98523631AE4a59f267346ea31F984 \
  'getPool(address,address,uint24)(address)' \
  0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 \
  500

cast call --rpc-url <mainnet-rpc> 0x1F98431c8aD98523631AE4a59f267346ea31F984 \
  'getPool(address,address,uint24)(address)' \
  0xdAC17F958D2ee523a2206206994597C13D831ec7 \
  0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 \
  500

cast call --rpc-url <mainnet-rpc> 0x1F98431c8aD98523631AE4a59f267346ea31F984 \
  'getPool(address,address,uint24)(address)' \
  0x6B175474E89094C44Da98b954EedeAC495271d0F \
  0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 \
  500

cast call --rpc-url <mainnet-rpc> 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640 'token0()(address)'
cast call --rpc-url <mainnet-rpc> 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640 'token1()(address)'
cast call --rpc-url <mainnet-rpc> 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640 'fee()(uint24)'
```

Before real value, keep caps small and independently review the tick-price math,
pool-liquidity assumptions, and cap policy against current market depth.

## First Product Flow After Deploy

1. Seed option inventory by minting the first series from `EthOptionsFactory`.
2. Deposit first-series `P` into `steadyVault` to mint Steady wrapper shares.
3. Deposit first-series `N` into `boostedVault` to mint Boosted wrapper shares.
4. Seed `steadyMarket` with Steady shares plus ETH.
5. Seed `boostedMarket` with Boosted shares plus ETH.
6. Optionally seed direct P/N inventory AMMs for LP vault unwind liquidity.
7. Users trade Steady/Boosted wrapper shares against ETH through the AMMs.
8. Users can also wrap or unwrap current `P`/`N` directly through the wrappers.
9. Near roll time, wrapper keepers start public `RollAuction` rolls for the
   full current wrapper balance into the second series.
10. External solvers or the keeper-managed ETH LP vault fill the auctions.
11. The ETH LP vault can unwind tracked inventory through the direct P/N AMMs only when the quote is above its sale floor.
12. If a partially filled roll auction expires, anyone can reset its Dutch curve
    through the wrapper keeper so the remaining inventory can continue clearing.
13. Anyone finalizes filled wrapper rolls through the wrapper keepers.
14. Matured residual direct inventory settles through the oracle, then anyone can
    redeem.

## What Still Needs App Integration

```text
external DEX/deep liquidity deployment for wrapper-share markets
```
