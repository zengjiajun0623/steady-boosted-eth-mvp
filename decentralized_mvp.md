# Simplified Decentralized MVP

Goal:

```text
Build Steady ETH and Boosted ETH with no debt, no liquidations, no admin price
poster, and no trusted settlement committee.
```

The unavoidable trade-off:

```text
We remove oracle trust by defining settlement as an onchain market TWAP.
We accept USDC/pool/liquidity/manipulation risk.
```

So the MVP should not say "USD stablecoin". It should say:

```text
ETH/USDC-TWAP stability.
```

## Product

### Steady ETH

User wants lower ETH volatility.

```text
Deposit ETH -> vault holds P -> vault rolls before maturity -> withdraw ETH
```

Promise:

```text
Reduce ETH volatility without selling, borrowing, or liquidation.
```

No promise:

```text
No guaranteed dollars.
No $1 peg.
No instant redemption during settlement edge cases.
```

### Boosted ETH

User wants convex ETH upside.

```text
Deposit ETH/USDC -> vault buys N -> user gets upside-heavy exposure
```

This is the natural buyer for the risk that Steady ETH gives up.

## Contracts

### OptionFactory

Creates fixed series:

```text
underlying: ETH
reference: ETH/USDC Uniswap v3 TWAP
strike: fixed USDC per ETH
maturity: fixed timestamp
twapWindow: e.g. 72h
```

Functions:

```text
mint(seriesId) payable -> mints matched P + N
merge(seriesId, pAmount, nAmount) -> returns ETH before settlement
redeemP(seriesId, amount) -> returns ETH after settlement
redeemN(seriesId, amount) -> returns ETH after settlement
```

Each full ETH deposit mints one matched `P/N` pair. UI can wrap this into
dollar-normalized units.

### SeriesRegistry

Keeps launch narrow.

```text
ETH/USD-like market only
canonical maturities only
adaptive strike grid only
hard open-interest cap per series
```

For the most decentralized MVP, configs can be immutable in the deployed
factory version. To change caps or grids, deploy a new factory.

### UniswapTwapSettlement

Settlement rule:

```text
settlementPrice = ETH/USDC Uniswap v3 geometric TWAP over [maturity - W, maturity]
```

Important details:

```text
pool must be allowlisted at series creation
pool must have enough observation history
finalization must happen within observation availability
settlement uses observe(secondsAgo[]) to read cumulative ticks
series cannot settle from spot price
series cannot settle from a thin pool
```

Lifecycle:

```text
Open -> Matured -> Settled -> Redeemable
```

No offchain proposer is required.

### SteadyVault

Deterministic strategy:

```text
hold P with strike around spot / 2
target roll 14 days before maturity
danger roll if ETH approaches 1.5x strike
danger reset to strike around spot / 4
```

Rolls happen through public auctions.

### RollAuction

Permissionless Dutch roll auction:

```text
vault offers old P
vault requests new safer P
anyone can bid
price decays from a strong quote to a policy floor
partial fills are allowed
open auction ids are discoverable onchain
```

No designated market maker is required. RLP can exist as a bidder, but should
not be required for correctness.

### BoostedVault

Optional for protocol correctness, but likely required for product viability.

```text
buys N from new issuance and roll auctions
packages N exposure for users
```

## Settlement Payoff

For one full ETH-backed pair:

```text
P receives min(1, strike / settlementPrice) ETH
N receives max(0, 1 - strike / settlementPrice) ETH
```

This matches the original post's fully collateralized structure:

```text
P + N = 1 ETH
```

No bad debt is possible.

## Onchain TWAP Risk Controls

Use all of these:

```text
long TWAP window, likely 72h
deep Uniswap v3 ETH/USDC pool only
hard open-interest cap per series
adaptive caps based on conservative manipulation-cost estimates
no minting near maturity
no spot settlement
no governance override of final price
```

If the TWAP cannot be read because observations are unavailable:

```text
series remains unsettled
anyone can attempt finalization again while history exists
if history expires, matched P+N holders can still merge back to ETH
```

The last rule is harsh but decentralized. A nicer fallback reintroduces trust.

## Suggested MVP Parameters

```text
reference pool: deep ETH/USDC Uniswap v3 pool
twap window: 72h
maturity cadence: monthly
minimum time from mint to maturity: 14 days
target roll: 14 days before maturity
danger roll: below 1.5x strike
routine strike: spot / 2
danger reset strike: spot / 4
strike grid: adaptive, about 1-3% of ETH spot
initial series OI cap: very small, e.g. $100k-$250k equivalent
```

## What This Removes

```text
no debt
no liquidations
no keeper liquidation race
no admin-set price
no multisig settlement
no offchain oracle dependency for final settlement
```

## What Remains

```text
USDC risk
Uniswap pool liquidity risk
TWAP manipulation risk
auction liquidity risk
smart contract risk
user misunderstanding risk
```

## MVP Build Order

```text
1. OptionFactory + UniswapTwapSettlement
2. Manual mint/merge/redeem UI
3. BoostedVault for N demand
4. SteadyVault with deterministic rolls
5. RollAuction
6. Optional RLP bidder
```

Do not start with a polished Steady product before the N side and settlement
mechanics are proven.
