# Oracle And Settlement Exploration

This design should separate three different "prices":

```text
1. UI estimate price
2. roll decision price
3. maturity settlement price
```

Only the third one is consensus-critical.

## Price Roles

### UI Estimate

Used to show expected value, risk bands, and current vault status.

This can use fast public feeds such as Chainlink or Pyth, plus offchain exchange
prices. It does not directly move funds.

### Roll Decision

Used by the vault, user agent, RLP, or solvers to decide whether to roll.

This should be private or semi-private when possible. The protocol should not
force everyone to use one public threshold, because that recreates some of the
MEV and oracle-fragility problems of liquidation systems.

For MVP, this can be an offchain service or keeper using multiple sources.

### Maturity Settlement

Used to redeem matured `P` and `N`.

This should be slow, explicit, and disputable. The whole advantage of the
options design is that settlement can wait hours or days because there is no bad
debt and no liquidation race.

## Recommended MVP Path

## Fully Onchain Settlement Variant

If the goal is to remove trusted settlement entirely, define the reference price
as an onchain market value:

```text
ETH/USDC reference = Uniswap v3 TWAP over [maturity - W, maturity]
```

Series creation should require the oracle to bind the exact `seriesId`,
maturity, and TWAP window before the option series exists. Otherwise a launch
can look valid while settlement is actually dependent on manual rescue. The
factory should perform this hook before exposing the new series as mintable, so
oracle setup cannot interact with half-created inventory.

This removes:

```text
trusted poster
offchain proposer
committee
manual dispute process
admin price override
```

It adds:

```text
USDC dependency
Uniswap liquidity dependency
TWAP manipulation risk
observation-history / finalization timing risk
```

This variant should be called `ETH/USDC-TWAP`, not pure `ETH/USD`.

Implementation requirements:

```text
use a deep allowlisted Uniswap v3 pool
use a long window, likely 72h
verify the pool has enough observation history
finalize while the relevant observations are still available
cap open interest per series far below estimated manipulation capital
do not include a governance price override
```

The readiness gate now treats 72h as the default minimum settlement TWAP window
for live series.

If the TWAP cannot be read, the most decentralized behavior is to leave the
series unsettled or fail it into merge-only recovery. Any friendlier rescue path
reintroduces trust.

See `decentralized_mvp.md` for the simplified no-offchain-oracle design.

### Phase 0: Simulation And Testnet

Use a trusted price poster.

Rules:

```text
ETH/USD settlement price = daily close or daily TWAP for the maturity date
settlement delay = 24 hours
manual dispute / correction in testnet admin
```

This is enough to test contracts, vault accounting, roll auctions, and UX.

### Phase 1: Guarded Mainnet Pilot

Use small caps and a slow optimistic settlement process.

Recommended structure:

```text
1. At maturity, anyone can propose the ETH/USD settlement value.
2. The proposed value includes exact methodology in the request data.
3. The value has a liveness period, such as 24-72 hours.
4. If undisputed, the series settles.
5. If disputed, it escalates to the arbitration/backstop mechanism.
```

UMA's Optimistic Oracle is a natural candidate for this style because it lets
contracts request arbitrary verifiable data and only escalates disputed claims to
the DVM. UMA docs say disputes sent to the DVM are resolved within a few days.

Relevant docs:

```text
UMA overview: https://docs.uma.xyz/
UMA oracle mechanics: https://docs.uma.xyz/protocol-overview/how-does-umas-oracle-work
Chainlink data feeds: https://chain.link/data-feeds
Pyth price feeds: https://docs.pyth.network/price-feeds
Reality.eth docs: https://realitio.github.io/docs/html/
```

### Phase 2: Production Settlement

Use an oracle stack with redundancy:

```text
primary proposal source: deterministic TWAP methodology
proposal inputs: Chainlink/Pyth/exchange VWAPs
settlement path: optimistic oracle with dispute period
fallback path: manual governance only for disabling new series, not rewriting settled values
```

The settlement methodology needs to be precise enough that independent actors
can reproduce it.

## Settlement Methodology

For ETH/USD, one possible MVP rule:

```text
Price = median of hourly ETH/USD observations over the 24h UTC maturity day.
Observation sources = named venues / oracle feeds.
If one source is unavailable, use the remaining valid sources.
If fewer than N sources are valid, settlement is delayed and escalated.
```

Better:

```text
Price = 24h TWAP from a specified oracle/feed methodology, with a backup
source and a clearly defined invalid-data policy.
```

The exact rule matters more than which initial source is picked.

## Contract Implications

Each series should have:

```text
ticker
strike
maturity timestamp
settlement status
proposed settlement price
final settlement price
dispute deadline
open interest cap
```

Series lifecycle:

```text
Open -> Matured -> Proposed -> Disputed? -> Settled -> Redeemable
```

During `Matured` or `Proposed`, redemptions wait. This is acceptable because the
vault should roll before maturity and users should not be promised instant
matured-series redemption.

## Risk Controls

Use open-interest caps per series.

The dispute bond should scale with value at risk:

```text
minimum bond + bond_bps * open_interest
```

The protocol should not list too many series. More series means more oracle
surface and less liquidity.

Do not allow settlement at an instant timestamp if it can be manipulated.
Prefer TWAP over a window.

Keep a delay between last mint and maturity, or raise fees near maturity, so no
one can mint huge positions right before a favorable settlement.

## Key Product Decision

The Steady vault should strongly prefer to roll before maturity:

```text
target roll: 14 days before maturity
forced roll mode: 7 days before maturity
do not intentionally hold to settlement
```

That means settlement mostly exists for residual positions, `N` holders, manual
users, and edge cases. This reduces user-facing oracle anxiety.

## MVP Recommendation

For MVP:

```text
Use fast feeds for UI and offchain roll decisions.
Use a trusted poster on testnet.
Design the mainnet contracts around delayed optimistic settlement.
Cap open interest tightly until settlement disputes are battle-tested.
```

The protocol should message this clearly:

```text
Rolls use current market estimates.
Final redemption of matured options uses delayed dispute-friendly settlement.
```
