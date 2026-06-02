# Contract MVP

This repo now has a first onchain core for the ETH-native product demo.

## What Exists

### `EthOptionsFactory`

The factory creates fixed ETH-backed option series:

```text
deposit 1 ETH -> mint 1 P token + 1 N token
merge 1 P + 1 N before settlement -> withdraw 1 ETH
settle after maturity -> redeem P and N against the settlement price
```

Series creation requires the settlement oracle to register the exact `seriesId`,
maturity, and TWAP window before the series exists. A production series should
not silently launch with an oracle that lacks maturity-anchored metadata. The
factory performs this registration before the new series is mintable and blocks
reentrant series creation during the hook.

Payoff for each full ETH-backed pair:

```text
P = min(1, strike / settlementPrice) ETH
N = 1 - P
```

This preserves the key invariant:

```text
P + N = 1 ETH
```

There is no debt, liquidation, or bad-debt path in the core split.

### `EthLPVault`

The vault is an ETH-denominated LP vault:

```text
deposit ETH -> receive LP shares
request withdraw -> wait unlock delay
claim withdraw -> receive ETH
```

It can also act as a roll-market bidder:

```text
trader sends ETH -> vault mints P/N with net ETH
vault deposits P into Steady wrapper, or N into Boosted wrapper, for the trader
vault keeps the paired P/N inventory and the ETH trade fee
trader sells wrapper shares -> vault unwraps P/N and pays ETH minus fee
vault uses ETH to mint the next P/N pair
vault pays a Steady roll auction with new P, or a Boosted roll auction with new N
vault receives old inventory plus leftover newly minted P/N inventory
vault can sell tracked inventory through a matching public ETH/token AMM only above its sale floor
vault can pair tracked inventory with ETH in an already-seeded matching AMM above the same floor
vault later merges or redeems inventory back to ETH
```

The manager can choose which auctions to bid, but cannot bid outside the vault's
immutable strategy policy:

```text
max ETH per roll
max active strategy ETH
max roll price paid
product trade fee
minimum ETH/token inventory sale price
minimum auction duration
```

For a more decentralized deployment, set `EthLPVaultKeeper` as the vault
manager. The keeper is a permissionless facade: anyone can call it to fill
allowed roll auctions, sell tracked inventory through matching public markets,
pair tracked inventory with ETH as public AMM liquidity, remove vault-owned AMM
liquidity, redeem settled inventory, merge matched inventory, or close the
strategy. The keeper cannot bypass the vault's immutable limits.
The keeper also pins the Steady and Boosted wrapper addresses as the only roll
auction sellers it will backstop, so arbitrary matching-token auctions cannot
consume LP-vault capacity.
It can also hold an optional ETH reward pool. If funded, successful keeper
calls above the configured minimum operation size pay a fixed bounty to the
caller. This gives independent keepers a direct gas incentive without giving
them strategy discretion.

The preferred LP inventory cleanup order is:

```text
matched P + N before settlement -> merge directly back to ETH
settled P or N after settlement -> redeem directly back to ETH
remaining unpaired unsettled P or N -> sell through a matching public AMM
or pair it with ETH as matching public AMM liquidity
```

This reduces the number of cases where the LP vault needs a new counterparty. A
counterparty is still needed for unpaired, unsettled inventory, but not for
matched balances or settled balances. AMM liquidity provision requires an
already-seeded matching market above the immutable sale floor, so the vault
cannot create arbitrary bad-price pools with depositor ETH. It is also capped by
the same `maxEthPerRoll` per-action limit used by vault roll backstops.

The LP vault earns from direct trader fees plus roll/inventory PnL when the
inventory it keeps later merges, redeems, or sells for more ETH than the vault
spent. This is market-making PnL, not guaranteed yield: bad fills, adverse
settlement, or thin residual-inventory markets can reduce LP returns. The
acceptance gate includes a discounted-roll smoke that resolves inventory and
checks that managed ETH increases.

To keep LP accounting decentralized, the vault does not rely on an offchain
mark-to-market price for open option inventory. Instead, new deposits and new
withdrawal requests pause while strategy inventory is open. The vault can reopen
only after all tracked `P/N` balances are merged or redeemed back to ETH. The
close check uses the current open-inventory counter, so historical cleared series
remain publicly visible without making future shutdowns loop over old history.

### `EthTokenAMM`

The AMM is now secondary liquidity, not the primary MVP trader route. The
protocol vault can quote and fill ordinary Steady/Boosted trades directly. AMMs
remain useful as simple public venues for wrapper-share liquidity and residual
inventory testing:

```text
buy Steady ETH: ETH -> Steady wrapper share
sell Steady ETH: Steady wrapper share -> ETH
buy Boosted ETH: ETH -> Boosted wrapper share
sell Boosted ETH: Boosted wrapper share -> ETH
```

The wrapper share is the user-facing token. It can keep trading against ETH even
when the wrapper rolls its internal `P` or `N` inventory from one maturity to the
next. This avoids rebuilding any secondary market every time a series changes.

`EthTokenAMM` is still a minimal constant-product pool with LP shares and
slippage limits. This is enough for the MVP to test secondary liquidity without
a centralized quote server. A production deployment can still add deep external
DEX pools, but the simplest launch story is one Protocol ETH Liquidity Vault.

`DeployLocalMvp.seedMarkets(...)` can bootstrap the first local product markets
in one call:

```text
mint first-series P/N
wrap P into Steady shares
wrap N into Boosted shares
seed ETH/share AMMs
return AMM LP shares to the chosen recipient
```

`seedInventoryMarket(...)` can also seed direct first/second-series P or N AMMs.
Those markets are not for ordinary trader UX; they give keepers a public venue
to unwind tracked ETH LP vault inventory with `sellInventory(...)`.

### `EthLPVaultKeeper`

The keeper removes the need for a single privileged account to push safe LP
strategy transactions:

```text
deploy keeper
deploy ETH LP vault with keeper as manager
optionally fund keeper reward pool
anyone calls keeper.fillSteadyRoll(...)
anyone calls keeper.fillBoostedRoll(...)
vault enforces max size, active inventory cap, max price, solver-first delay,
auction duration, minimum time left, and maximum Dutch price decay
anyone calls keeper.sellInventory(...) when a tracked P/N token has a matching AMM and the quote is above the vault sale floor
anyone calls keeper.addInventoryLiquidity(...) to pair tracked inventory with ETH in a matching seeded AMM above the same floor
anyone calls keeper.removeInventoryLiquidity(...) to recover ETH and inventory from vault-owned AMM LP shares
anyone calls keeper.redeemP/redeemN/mergeSeries/closeStrategy when inventory resolves
```

This is the same broad idea as keeper-driven Maker auctions: execution is public,
while the contract policy decides what is valid.

### `SeriesExposureVault`

This is the continuous user-facing wrapper for one side of the option pair:

```text
Steady ETH vault: holds P exposure and rolls P -> next P
Boosted ETH vault: holds N exposure and rolls N -> next N
```

Users deposit the current series token and receive vault shares. Each wrapper
has an immutable `maxAssets` capacity, set at deployment to stay inside the
product roll-size cap. When a maturity roll begins, deposits and redemptions
pause. The vault sells its full current series-token balance for the next series
token through `RollAuction`, and only switches to the new current token after
the auction is fully filled.

This keeps the wrapper decentralized and simple:

```text
no trusted quote signer
no offchain inventory valuation
no hidden market maker dependency
```

For a trust-minimized deployment, set `SeriesExposureVaultKeeper` as the
wrapper manager. The keeper is a permissionless facade for the roll lifecycle:

```text
anyone starts a validated roll into the next factory series
anyone finalizes once the roll auction is fully filled
anyone cancels an unfilled roll after the auction duration has elapsed
anyone resets an expired partially filled roll to a fresh Dutch curve
```

The keeper checks:

```text
current wrapper token matches the expected factory P/N side
next series is the same side, has a later maturity, and matches strike/TWAP/oracle metadata
roll auction is the configured public auction contract
roll sell amount is above the immutable dust threshold
roll sell amount is at or below the immutable product roll cap
roll sell amount equals the wrapper's full current-token balance
start price, floor price, and duration stay inside immutable policy bounds
```

The wrapper also rejects normal deposits that would push current-token assets
above `maxAssets`. Direct ERC-20 transfers can still send dust or extra tokens
to the wrapper address, so the keeper's independent roll-size cap remains the
last line of defense.

A roll auction can still be partially filled by solvers. That partially filled
roll cannot be cancelled or finalized as clean. If it expires with old inventory
left, the keeper can reset the Dutch curve for the remaining inventory. This
borrows Maker's `redo` lesson: stale auctions should be permissionlessly
restartable instead of leaving the product stuck.

If an auction receives no fills and is cancelled after expiry, the wrapper
automatically pauses new deposits. Existing holders can still redeem, and the
keeper can retry the roll using the remaining current-token inventory. Deposits
only reopen after a later roll finalizes successfully. This turns a failed
cheap-roll attempt into a visible growth stop instead of letting the product
accept more assets before liquidity has recovered.

### `SeriesExposureVaultKeeper`

The wrapper keeper removes centralized roll control from Steady ETH and
Boosted ETH wrappers:

```text
deploy keeper for Steady side or Boosted side
deploy wrapper with keeper as manager
attach wrapper to its current factory series
any caller starts/finalizes/resets/cancels allowed rolls through the keeper
optionally fund keeper reward pool for start/reset/finalize/cancel bounties
```

Unlike a free-form manager, the keeper cannot pick arbitrary tokens or auction
parameters. It can only roll the wrapper's current factory series into a later
compatible series of the same side, through the configured `RollAuction`, within
immutable price, duration, minimum-size, and maximum-size limits. Compatible
means the next series uses the same strike, settlement TWAP window, and oracle;
future dynamic-strike migrations need a separate valuation policy instead of
being treated as a normal cheap roll. The maximum roll size is the product's
market-depth cap. In the pilot deployers, wrapper `maxAssets` is set to the same
cap so ordinary deposits cannot grow the product beyond cheap roll capacity. If
direct transfers or later integrations push a wrapper above that cap, the keeper
will not launch a roll auction that the solver/vault market may be unable to
clear. If the keeper reward pool is funded, start/reset/finalize/cancel calls
can pay a fixed bounty to the caller. This makes the whole roll lifecycle
keeper-friendly without giving keepers discretion over roll terms.

### `RollAuction`

The roll auction is the first counterparty-discovery primitive:

```text
seller escrows old option token
seller asks for next-series option token
any solver can fill part or all of the auction
price decays from a strong quote to an acceptable floor
active auctions are exposed onchain for solver discovery
active auction count is capped at deployment so keepers are not flooded
seller can reset an expired open auction without moving custody
seller can reset a stale auction once the Dutch price has decayed enough
auction dust rules reject tiny auctions, tiny partial fills, and tiny remainders
callback fills let solver/router contracts source payment during settlement
```

This is inspired by Maker-style Dutch auctions and Hyperliquid-style shared
liquidity, but kept narrower for this protocol:

```text
Maker lesson: make execution public, atomic, and price-discovering
Hyperliquid lesson: use a shared vault as the launch liquidity engine, then let outside solvers compete around it
```

The concrete Maker-style pieces used here are public active-auction discovery,
partial and full fills, callback fills for routers/solvers, stale-auction reset,
deployment-time global and per-seller active-auction caps, and cancellation that
returns escrowed inventory instead of trapping it. The concrete
Hyperliquid-style piece is the ETH LP vault as a protocol-owned/shared
liquidity engine for small launch caps. External solvers still compete first
when they exist, so the vault is not the only counterparty as the market grows.

The demo now mirrors that product split:

```text
Trade page: normal users buy or sell Steady/Boosted ETH
Vault page: LPs deposit ETH into the protocol liquidity engine
Auctions page: solvers and keeper bots inspect/fill public roll auctions
```

The auction page should remain a specialist surface. It exposes the open roll
size, current Dutch price, floor, time left, and backstop. Those details help
counterparties compete without making ordinary trader or LP flows harder to
understand.

For a Steady ETH roll, the wrapper can auction old `P` for new `P`. For a
Boosted ETH roll, the wrapper can auction old `N` for new `N`. External solvers
can bid directly with next-series inventory, fill through a Maker-style callback
router, or mint the next pair atomically through `RollSolver`. The ETH LP vault
can plug in as one bidder/market maker, while external solvers remain free to
compete.

`RollAuction` maintains an active-auction list:

```text
activeAuctionCount()
activeAuctionIdAt(index)
activeAuctionCountBySeller(seller)
activeAuctionIdBySellerAt(seller, index)
isActive(auctionId)
auctionStatus(auctionId)
```

The list updates on auction creation, full fill, and cancellation. This gives
external solver bots a direct onchain discovery path instead of requiring a
trusted UI manifest or private backend to tell them which auction ids exist.
`auctionStatus` is the keeper-facing read model: it returns whether the auction
is open, whether it is still active, whether the Dutch price has reached the
floor, remaining inventory, raised buy-token amount, current price, elapsed
time, and time left. Seller-scoped discovery lets bots watch known protocol
sellers, such as the Steady and Boosted wrapper vaults, without relying only on
the noisier global board.

Solvers can fill a chosen amount with `fill`, or take the current remaining
inventory with `fillAll`. `fillAll` is useful for bots because the auction may
be partially filled by another taker between the bot's quote read and its
transaction. The solver still passes a `maxBuyAmount`, so the transaction cannot
execute above its accepted price.

For capital-light solvers, `fillWithCallback` and `fillAllWithCallback` first
send the sold token inventory to a solver/router contract, then call
`rollAuctionCall(...)`. The callback contract must source the buy token and
approve the auction before the fill completes. If it cannot, the whole
transaction reverts. This borrows Maker's key `take`/callee lesson: the auction
does not need to know whether the bidder used idle inventory, a mint helper, an
AMM route, or a flash source. It only needs atomic payment.

`RollSolver` exposes both fixed-amount and fill-all mint helpers:

```text
mintAndFill / mintAndFillN
mintAndFillAll / mintAndFillAllN
mintAndFillWithCallback / mintAndFillNWithCallback
mintAndFillAllWithCallback / mintAndFillAllNWithCallback
```

The runner helper uses the fill-all variants when its suggested solver bid is
for the full visible remainder. That makes independent solver loops less brittle:
if the auction size changes before execution, the solver is still protected by
its max payment instead of relying only on a stale exact amount.

The most important Maker lesson is not the visible auction table. It is the
operating model:

```text
discover active auctions onchain
quote the Dutch price from contract state
settle immediately when a keeper takes the auction
let partial fills recycle capital quickly
keep max price / duration / inventory limits outside the free-form bidder
```

What the MVP already borrows from Maker's newer auction design:

```text
Dutch price curve instead of a long capital-locking English auction
instant settlement when a taker fills
callback settlement so routers can source payment inside the transaction
partial fills so small solvers can participate
maxBuyAmount protection so takers never clear above their accepted price
onchain auction discovery instead of a trusted offchain auction list
redo/reset path for expired or price-stale partially filled auctions
minimum-size rules to keep the public auction list and partial fills worth scanning
immutable stale-reset policy for minimum delay and minimum Dutch price drop
per-product maximum roll-size caps, similar in spirit to Maker's global/per-market limits
deployment-time global and per-seller active-auction ceilings to reduce keeper-market flooding
no admin guardian in the MVP deployers or readiness gate
```

MVP deployment scripts require `guardian = address(0)`. Readiness fails any
manifest with a nonzero auction guardian. That permanently disables admin
setters and leaves only seller/solver/keeper auction mechanics callable. Raising
auction ceilings or changing stale-reset policy requires a new auction
deployment.

The auction also has immutable `minSellAmount`. New auctions must be at or above
that size. Partial fills must also be at least that size and cannot leave a
nonzero remainder below it. A taker can still clear the full current remainder
with `fillAll`, so dust rules do not trap inventory.

The auction also exposes `resetStatus(auctionId)` and a stale reset policy:

```text
minStaleResetDelay
minStaleResetPriceDropBps
```

`redo(...)` is valid once the auction has fully expired, or earlier if the
auction has been live for at least `minStaleResetDelay` and the current Dutch
price has dropped from the auction start price by at least
`minStaleResetPriceDropBps`. Setting the price-drop threshold to zero disables
the early price-stale reset path. This borrows Maker's `tail`/`cusp` idea
without adding a new trusted reset oracle.

What should be added before larger production value:

```text
independent review of production TWAP math and stale-reset parameter policy
```

What the MVP borrows from Hyperliquid's vault model:

```text
ordinary LPs deposit into one protocol-owned liquidity vault
the vault earns only by taking market-making/roll risk
the vault is the default launch liquidity engine
external solvers can still compete against the vault to improve pricing
the vault is transparent enough for users to see TVL, PnL, open inventory, and risk limits
```

The UI consequence is important: traders should not see this machinery. Traders
need buy/sell Steady and Boosted. LPs need deposit/withdraw and risk visibility.
Solvers and keepers need the auction and runner surface.

The most important Hyperliquid lesson is that the shared vault should look
boring to depositors while doing specialized liquidity work in the background.
For this product, that means the ETH LP vault can bid both Steady and Boosted
roll auctions. A small no-solver launch can rely on the vault alone with strict
caps, while larger capacity should require real solver/Boosted demand around
it. Its immutable policy makes that liquidity engine conservative:
the vault refuses auctions before the solver-first delay, auctions that are too
short, too close to expiry, too large, too expensive, or already too far down
the Dutch curve.

### `RollSolver`

`RollSolver` makes external bidding simple enough to be permissionless:

```text
solver sends ETH
contract mints the next P/N option pair during normal fill or callback settlement
contract pays a Steady roll auction with new P, or a Boosted roll auction with new N
solver receives old inventory, leftover paid-side inventory, and all paired-side inventory
```

This is not a privileged backend. It is an atomic helper that any solver,
aggregator, or LP strategy can call.

`ops/keeper-decisions.mjs` exposes the same idea operationally: it reads public
state and emits ready actions plus structured transaction metadata. The optional
`ops/keeper-runner.mjs` script can dry-run or execute a chosen action scope
(`solver`, `settlement`, `wrapper`, `lp`, or a specific action type). This gives
the MVP a simple backend loop without adding a trusted backend: anyone can run
the same loop, compete on fills, settle mature series when the oracle is ready,
and audit the commands before execution.

The helper also attaches the deterministic vault strategy plan to each live
roll auction. ETH LP vault backstop actions are gated by that plan by default:
the current roll must fit the low-cost band and be backed by managed ETH vault
capital, or by explicit scale-mode Boosted/solver demand. This keeps the
offchain runner path aligned with the product rule: pause, shrink, or require
liquidity instead of forcing an expensive roll.

`ops/solver-improvement-report.mjs` reads public `AuctionFilled` logs and
attributes roll execution between external solvers and the ETH LP vault. It
reports how much external solvers filled before the vault and estimates
buy-token savings versus the vault's max-roll-price baseline. This is not a
reward contract yet; it is the transparent accounting layer needed before a
solver incentive program.

For parallel execution, the runner supports action-scoped key environment
variables. Solver, settlement, wrapper-maintenance, LP backstop, and
inventory-unwind loops can run as separate processes with separate keys,
avoiding a shared nonce stream while still reading the same public contract
state.

### Settlement Oracles

`ISettlementOracle` defines the narrow settlement dependency:

```solidity
function settlementPrice(bytes32 seriesId) external view returns (bool settled, uint256 price);
```

Two adapters/config artifacts exist:

```text
MockSettlementOracle: local/test settlement price
UniswapV3TwapSettlementOracle: maturity-anchored cumulative tick TWAP
MedianStableTwapSettlementOracle: median of USDC, USDT, and DAI Uniswap v3 TWAPs
EthereumMainnetOracleConfig: bounded mainnet 3-stable median TWAP parameters
```

The Uniswap-style adapters store each series maturity/window when the factory
creates the series. At settlement they read the TWAP window ending at maturity,
not the caller's current timestamp. That keeps delayed settlement calls from
changing the price window. The median adapter requires all three stable pools to
be distinct and readable, then returns the middle ETH/stable price. That means
one depegged stable source cannot set settlement by itself, and a deployment
cannot fake a three-source median by repeating one pool.

Deployment must configure:

```text
pool addresses
factory address
token order / decimal scaling per pool via priceAtTickZeroWad
whether to invert the tick price
allowed average tick bounds per pool
```

`EthereumMainnetOracleConfig` now provides the first Ethereum mainnet
configuration:

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

The address and token-order facts were verified on Ethereum mainnet by calling
`UniswapV3Factory.getPool(stable, WETH, 500)` for USDC, USDT, and DAI, then
checking each returned pool's `token0()`, `token1()`, and `fee()` values. The
tick bands are intentionally guarded; outside those bands the oracle reports
not ready.

`ops/readiness-check.mjs` enforces this on mainnet by reading the oracle's
public `SOURCE_COUNT()`, `factory()`, `poolConfigs(index)`, and
`seriesConfigs(seriesId)` methods. Off mainnet, the same readiness gate accepts
the local mock oracle so Anvil tests stay deterministic.

The demo includes the direct holder maturity path:

```text
read factory series maturity / settled state / settlement price
show the connected wallet's direct P or N token balance
anyone can call settle(seriesId) after maturity
keeper-decisions surfaces settle-series once the oracle reports a nonzero price
holders can redeemP or redeemN after settlement
matched P+N holders can merge back to ETH until settlement, even after maturity
```

This is intentionally placed on the specialist Auctions page, not the normal
Trade page. Ordinary users should usually trade or let wrappers roll before
maturity; the maturity card is the decentralized cleanup path for residual
direct token holders and keeper bots.

### `ProtocolHealthLens`

`ProtocolHealthLens` is a read-only helper for decentralized protocol health
dashboards. It has no authority and does not hold funds. It packages existing
public state into structs:

```text
marketHealth: optional secondary AMM reserves, fee, and sample buy/sell quotes
lpVaultHealth: managed assets, reserved ETH, strategy utilization, pause state,
solver-first delay, auction freshness limits, and price-decay limits
wrapperHealth: current token, total assets, capacity, active roll auction
and deposit-growth pause state
seriesHealth: cap usage, maturity, settlement state
auctionHealth: Dutch price, remaining size, time left, token pair
auctionPolicyHealth: guardian, circuit-breaker level, dust threshold, active auction count
auctionPolicyHealth also includes global/per-seller active-auction ceilings, stale-reset delay, and price-drop threshold
wrapperKeeperHealth: roll price, duration, dust, cap, reward, and pending-series policy
```

The local and Ethereum pilot deployers both deploy and expose the lens
through `healthLens()`. Keepers and external dashboards can use it as a stable
read entry point without trusting a backend service.

## What Is Not Built Yet

```text
independent review of production TWAP math and per-series cap policy
external DEX liquidity/deep market deployment for wrapper-share markets
```

## Test Commands

```bash
forge test -vvv
```

Current coverage checks:

```text
mint creates matched P and N
merge before settlement returns ETH
merge after maturity but before settlement returns ETH
merge after settlement is rejected
high-price settlement splits collateral between P and N
low-price settlement pays P all collateral and N zero
settlement cannot happen before maturity
demo can submit deployed-chain merge/settle/redeem calls for direct tokens
Uniswap-style TWAP oracle registers maturity/window from the factory
Uniswap-style TWAP oracle settles from the window ending at maturity
Uniswap-style TWAP oracle rejects missing history and out-of-bounds ticks
ETH LP deposits mint shares
ETH LP withdrawals require the unlock delay
ETH LP vault can bid Steady roll auctions with depositor ETH
ETH LP vault can bid Boosted roll auctions with depositor ETH
ETH LP vault fuzzes Steady and Boosted cleanup against factory P/N payoffs
ETH LP deposits and withdrawal requests pause while inventory is open
ETH LP strategy cannot close until tracked inventory is redeemed
ETH LP strategy rejects oversized rolls
ETH LP strategy rejects bids above max roll price
ETH LP strategy rejects auctions shorter than the policy minimum
ETH LP strategy rejects auctions before the solver-first backstop delay
ETH LP strategy rejects auctions with too little time left
ETH LP strategy rejects auctions after too much Dutch price decay
deployers reject LP backstop price-decay limits above the normal roll-cost target
deployers reject LP inventory-sale floors below the normal roll-cost target
ETH LP strategy rejects active inventory above cap
ETH LP vault can merge matched inventory after maturity before settlement
ETH LP vault can sell tracked inventory through a matching public AMM
ETH LP vault can provide tracked inventory plus ETH as matching public AMM liquidity
ETH LP vault rejects inventory sales below its immutable sale floor
ETH LP vault rejects AMM liquidity provision into unseeded or below-floor markets
ETH LP vault rejects AMM liquidity provision above the per-action ETH limit
ETH LP vault rejects inventory sales through mismatched AMMs
permissionless keeper can execute allowed ETH LP vault bids
permissionless keeper can sell tracked ETH LP vault inventory through public AMMs
permissionless keeper can add and remove vault-owned AMM liquidity
funded ETH LP keeper pays a bounty on useful strategy actions
inactive ETH LP close calls cannot drain keeper rewards
permissionless keeper cannot bypass ETH LP vault policy
permissionless keeper can merge matched ETH LP vault inventory after maturity before settlement
permissionless keeper can redeem and close resolved inventory
permissionless wrapper keeper can start/finalize Steady and Boosted rolls
funded wrapper keeper pays a bounty on start/reset/finalize/cancel maintenance
wrapper keeper rejects dust rolls below its immutable minimum size
wrapper rejects normal deposits above its immutable roll-capacity ceiling
wrapper keeper rejects roll auctions above its immutable product cap
permissionless wrapper keeper rejects wrong-side vaults and out-of-policy rolls
permissionless wrapper keeper only cancels unfilled rolls after auction duration
permissionless wrapper keeper can reset expired partially filled rolls
trader can buy and sell Steady wrapper shares against ETH through the ETH LP vault
trader can buy and sell Boosted wrapper shares against ETH through the ETH LP vault
deployer can still wire optional secondary AMMs to wrapper shares instead of expiring first-series tokens
Ethereum pilot deployer rejects non-mainnet deployment
Ethereum pilot deployer rejects caps above the pilot limit
deployers reject nonzero auction guardians
Ethereum pilot deployer wires the TWAP oracle, product wrappers, LP vault, and wrapper-share AMMs
Ethereum pilot deployer can bootstrap first product AMM liquidity
deployers expose a read-only health lens for protocol health dashboards
health lens reads market, LP vault, wrapper, series, and auction status
health lens reads auction circuit-breaker and wrapper keeper policy
economic stress gate targets <= 10 bps weighted roll cost before raising capacity
no-solver launch capacity gate passes with LP-vault capital as the liquidity engine
local live smoke proves the ETH LP vault can clear a roll without external solver fill
trader slippage limits protect optional secondary AMM swaps
AMM LP can remove liquidity after earning swap fees
Steady wrapper can deposit/redeem current P exposure
Steady wrapper can roll old P to new P through public auction
Boosted wrapper can roll old N to new N through public auction
wrapper deposits and redemptions pause during active rolls
unfilled wrapper rolls can be cancelled
partially filled wrapper rolls must complete before finalization
expired partially filled wrapper rolls can be reset and then completed
roll auction escrows old option inventory
roll auction exposes active auction ids onchain for solvers
roll auction removes filled and cancelled auctions from the active list
roll auction price decays to a floor
roll auction seller can reset expired partially filled inventory
roll auction seller can reset price-stale inventory before full auction expiry
roll auction can run with no guardian, permanently disabling admin setters
product deployers and readiness reject nonzero auction guardians
roll auction rejects dust auctions, dust partial fills, and dust remainders
roll auction fillAll can clear a remainder below the current dust threshold
external solver can partially fill with next-series tokens
external solver can mint-and-fill Steady P rolls atomically from ETH
external solver can mint-and-fill Boosted N rolls atomically from ETH
external solver can mint during callback settlement for Steady and Boosted rolls
external solver can mint and fill all current Steady or Boosted remainder with max-payment protection
prefunded callback router can clear a full roll auction
roll solver rejects unauthorized direct callback calls
external solver cannot bid without enough newly minted P or N
solver max-price protection works
seller can cancel unfilled inventory
```

## Suggested Next Build Step

Connect the vault strategy policy and deployment layer:

```text
Vault strategy: make the vault-backed trader route, roll backstop, and inventory cleanup dashboard-ready
Secondary liquidity: optionally seed AMM or external DEX pools for wrapper shares after the vault route is live
Pilot operations: tune keeper bounty sizing and publish runbooks
Settlement UX: add richer post-roll/residual inventory views
Auction indexing: optionally add event/indexer indexing for historical analytics
```

See `deployment_mvp.md` for the local mock-oracle and Ethereum pilot
deployment topologies.

The current LP strategy accounting is intentionally conservative. It avoids
trusted live inventory marks by pausing LP entry/exit during active inventory.
Residual AMM unwinds are also conservative: if a public AMM quote is below the
vault's immutable sale floor, the vault does not dump inventory. It remains
paused until a direct merge/redeem path is available or better external
liquidity appears.
A more continuous vault would need a fully specified onchain valuation rule.

Before any real-value deployment, the TWAP adapter parameters and tick-price
math should be independently reviewed against the chosen pool.
