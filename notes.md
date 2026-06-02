# First Exploration Notes

## What we tested

We modeled a dollar-normalized `P_K` token:

```text
P_K maturity payoff = min(1, ETHUSD / K) dollars
```

That makes `P_K` behave like `$1` minus a fraction of an ETH put option. If ETH
is far above the strike `K`, `P_K` should trade close to `$1`. If ETH gets close
to `K`, it drifts away from `$1`, which is the quadratic deviation discussed in
the post.

The simulator uses Black-Scholes only as a rough mark-to-market proxy so that a
strategy can roll before maturity. This is not meant to be an oracle design.

Historical window:

```text
2018-01-01 to 2026-06-01
ETH-USD daily closes from Yahoo Finance
Initial portfolio value: $1,000
```

## Strategy rules

The most relevant strategy in the first run was:

```text
conservative:
  initial strike = spot / 2
  danger roll if spot < strike * 1.5
  after danger roll, reset strike = spot / 4
  maturity = 60 days
  roll when <= 14 days remain
```

This is close to the rule sketched in the Ethereum Research post.

## First-pass results

The biggest signal is execution cost sensitivity.

For the conservative strategy:

```text
IV 60%:
  0 bps per side:   final $967,  CAGR -0.4%
  5 bps per side:   final $887,  CAGR -1.4%
 10 bps per side:   final $813,  CAGR -2.4%
 25 bps per side:   final $626,  CAGR -5.4%
 50 bps per side:   final $405,  CAGR -10.2%
100 bps per side:   final $170,  CAGR -19.0%

IV 90%:
  0 bps per side:   final $1069, CAGR +0.8%
  5 bps per side:   final $980,  CAGR -0.2%
 10 bps per side:   final $898,  CAGR -1.3%
 25 bps per side:   final $692,  CAGR -4.3%
 50 bps per side:   final $448,  CAGR -9.1%
100 bps per side:   final $188,  CAGR -18.0%
```

The model says the idea is not obviously dead. But it only works if rolling is
very cheap. At 10 bps per side, the best strategies leak roughly 1-2.5% per
year. At 50 bps per side, repeated rebalancing dominates everything.

## Early takeaways

The first product should probably be a stability vault, not a payment stablecoin.
The drift and mark-to-market behavior are too weird for accounting use, but they
may be acceptable for users trying to dampen ETH volatility over a personal
planning horizon.

The main protocol problem is not the `P/N` split. That part is simple. The main
problem is the market mechanism for rolling:

- Can users roll through batch auctions with enough competition?
- Can RFQ solvers or market makers quote `P_K -> P_K'` cheaply?
- Can roll intents hide thresholds well enough to reduce MEV?
- Can a vault amortize execution across many users without becoming a brittle
  liquidation-like machine?

## Next experiments

1. Replace Black-Scholes with direct historical terminal payoff simulation.
2. Test delayed rolling windows, such as "roll sometime in the next 3 days".
3. Add batched order flow and model slippage as a function of auction volume.
4. Model the `N` side as a product and estimate what premium buyers require.
5. Compare against simply selling ETH into USDC and periodically rebuying ETH.
6. Add CPI/ETH or expense-basket indexes after the USD model is understood.

## Roll-market experiment

The second script, `roll_market.py`, models delayed roll intents and a simple
venue cost curve:

```text
per-side bps = base bps + impact bps * sqrt(order size / effective depth)
effective depth = daily depth * (wait days + 1)
```

The default venues are:

```text
thin-amm:       0 day wait,  $250k/day depth, 15 bps base, 90 bps impact
rfq-1d:         1 day wait,  $1.0m/day depth,  5 bps base, 35 bps impact
batch-3d:       3 day wait,  $2.5m/day depth,  3 bps base, 20 bps impact
deep-batch-7d:  7 day wait,  $7.5m/day depth,  2 bps base, 12 bps impact
```

Results for the conservative strategy, IV 90%, 2018-01-01 to 2026-06-01:

```text
$1m AUM, depth scale 1:
  thin-amm:       final 0.132x, CAGR -21.4%, avg bps 120.0
  rfq-1d:         final 0.639x, CAGR  -5.2%, avg bps  26.6
  batch-3d:       final 0.936x, CAGR  -0.8%, avg bps   9.1
  deep-batch-7d:  final 0.856x, CAGR  -1.8%, avg bps   3.4

$10m AUM, depth scale 1:
  thin-amm:       final 0.025x, CAGR -35.5%, avg bps 215.9
  rfq-1d:         final 0.351x, CAGR -11.7%, avg bps  63.5
  batch-3d:       final 0.777x, CAGR  -3.0%, avg bps  21.5
  deep-batch-7d:  final 0.823x, CAGR  -2.3%, avg bps   6.4
```

The interesting trade-off is that 7-day batching gets very low execution bps,
but the stale position can wander too much. In this model, 3-day batching is
best around $1m AUM, while deeper 7-day batching starts to win at $10m because
impact costs dominate.

The product requirement is becoming sharper:

```text
To be competitive, the roll venue probably needs effective per-side cost under
~10 bps for ordinary vault sizes, and under ~20 bps even for larger batched
flows. Thin AMM liquidity is not close.
```

## N-side experiment

The third script, `n_side.py`, treats the counterpart token as a product.

For one dollar-normalized unit:

```text
P payoff = min(1, ETHUSD / K)
N payoff = max(0, ETHUSD / K - 1)
```

So `N` is a normalized ETH call option. Sampling the `N` token created opposite
each fresh conservative-strategy `P` issuance gives:

```text
IV 90%, 2018-01-01 to 2026-06-01:
  trades: 88
  win rate: 45.45%
  mean trade return: 14.27%
  median trade return: -1.48%
  10th / 90th percentile return: -58.15% / 97.96%
  equal-flow N portfolio return: 12.85%
  equal-flow ETH benchmark return: 7.29%
```

This is a useful sign. The `N` side is not just trash risk; historically it
looked like a convex ETH-upside product with frequent small losses, some total
wipeouts, and a few large winners. That suggests a plausible market:

- stability seekers buy/roll `P`
- ETH bulls or structured-product vaults buy `N`
- solvers intermediate inventory during roll auctions

The remaining hard question is whether `N` demand is deep enough at the exact
strikes and maturities created by stability demand.

## Updated build hypothesis

The plausible first product is now:

```text
A personal or pooled stability vault that rolls P through delayed batch/RFQ
auctions, paired with an N-side vault marketed as convex ETH upside.
```

The protocol primitive is small. The real product is the two-sided market:

1. `P` vault: low-volatility, liquidation-free, non-accounting-stable exposure.
2. Roll venue: delayed batch/RFQ execution with hidden or private thresholds.
3. `N` vault: recurring buyer of paired upside tokens, possibly packaged as an
   ETH momentum or convexity strategy.

## RLP balance-sheet experiment

The fourth script, `rlp_sim.py`, models an HLP-like Roll Liquidity Provider
vault. Instead of assuming abstract venue depth, it asks how much balance sheet
RLP needs to quote rolls.

At each roll, RLP must do three things:

```text
1. Buy old P from the Steady vault.
2. Originate or source new safer P.
3. Sell or warehouse the paired N created with that new P.
```

This is the important discovery: the paired `N` inventory can be large. For a
routine new `P` with strike `spot / 2`, the paired `N` is roughly another $1 of
upside exposure per $1 of Steady demand. For danger rolls resetting to
`spot / 4`, paired `N` can be roughly $3 per $1 of Steady demand.

The quote model is intentionally simple:

```text
per-side bps = 3 + 20 * sqrt(required risk / RLP risk budget)
```

The default RLP risk budget is 40% of RLP capital. Required risk includes
weighted old-P inventory plus unsold N inventory.

Results for immediate RLP rolls, IV 90%, 2018-01-01 to 2026-06-01:

```text
RLP capital = 1x Steady AUM:
  N external fill 80%: weighted avg 30.2 bps, 21 capacity breaches
  N external fill 95%: weighted avg 19.9 bps,  2 capacity breaches

RLP capital = 3x Steady AUM:
  N external fill 80%: weighted avg 15.5 bps, 0 breaches
  N external fill 95%: weighted avg 13.0 bps, 0 breaches

RLP capital = 10x Steady AUM:
  N external fill 80%: weighted avg 10.0 bps, 0 breaches
  N external fill 95%: weighted avg  8.6 bps, 0 breaches
```

Interpretation:

```text
RLP alone is not enough unless it is very overcapitalized. To stay near or below
10 bps, the system needs both significant RLP capital and reliable external
buyers for N.
```

This changes the MVP design. The RLP vault should not be imagined as the only
counterparty. It should be a default/backstop bidder that works alongside:

- an N-side vault
- external solvers
- delayed batch auctions
- strict Steady vault TVL caps

The most plausible early configuration is:

```text
Steady vault capacity <= 10-20% of committed RLP + N-side liquidity.
Routine rolls clear in batches.
RLP only absorbs residual inventory after external N buyers and solvers bid.
```

## Economic stress gate

The operator-facing script `ops/economic-stress-check.py` turns the RLP and
N-side experiments into a repeatable launch check.

Default assumption:

```text
RLP capital ratio: 3x Steady AUM
external N fill: 80%
weighted avg roll cost: 15.5 bps
capacity breaches: 0
cumulative modeled roll leakage: 24.13%
N equal-flow portfolio return: 12.85%
status: WARN
```

The warning is useful. It says the market can clear under the model, but the
leakage is still high enough that capacity should not grow casually.

Stronger assumption:

```text
RLP capital ratio: 10x Steady AUM
external N fill: 95%
weighted avg roll cost: 8.6 bps
capacity breaches: 0
cumulative modeled roll leakage: 14.20%
N equal-flow portfolio return: 12.85%
status: PASS
```

Current product implication:

```text
Steady capacity should be capped by committed RLP capital and observed Boosted/N
demand. A simple first policy is to require the economic stress gate to pass in
strict mode before raising capacity.
```

## Capacity policy gate

The operator-facing script `ops/capacity-policy.py` turns that implication into
an ETH-denominated launch cap. It uses the historical N-demand model to ask how
much external Boosted/N buying capacity is needed per ETH of Steady capacity,
then takes the minimum of:

```text
LP vault cap = committed ETH LP vault capital / required RLP capital ratio
N demand cap = committed Boosted + solver demand / historical N demand ratio
```

Example with `1000 ETH` in the LP vault, `5000 ETH` of credible Boosted/solver
demand, a `10x` RLP capital ratio, and a `100 ETH` Steady target:

```text
status: PASS
suggested launch cap: 100 ETH
stress cap using max historical N outstanding: 100 ETH
average external N demand required: 201 ETH
stress external N demand required: 1,523 ETH
```

The same `100 ETH` Steady target with only `500 ETH` of Boosted/solver demand:

```text
status: WARN
suggested launch cap: 100 ETH
stress cap using max historical N outstanding: 32.8 ETH
```

Current product implication:

```text
Steady should launch as a capped product. The cap is a function of committed ETH
LP capital and observable Boosted/solver demand, not merely a governance number.
```

`ops/readiness-check.mjs` now includes the same idea in the live deployment
gate. It reads LP vault capital, visible Boosted AMM ETH, wrapper roll caps, and
factory series caps from onchain state. Operators can add explicitly committed
Boosted/solver budgets:

```bash
node ops/readiness-check.mjs \
  --rpc <RPC_URL> \
  --boosted-demand-eth 5000 \
  --solver-float-eth 250 \
  --capacity-strict
```

This keeps demand underwriting visible. A deployment can be technically live
while still failing the sustainable-capacity gate.

## RLP risk experiment

The fifth script, `rlp_risk.py`, marks RLP's residual inventory to market.

RLP earns spread from helping Steady roll, but it also warehouses:

```text
1. old P that Steady sells during a roll
2. unsold N from newly originated P/N pairs
```

Selected results for IV 90%, 2018-01-01 to 2026-06-01:

```text
1x RLP capital, 95% N external fill:
  RLP PnL: +24.32%
  max drawdown: 38.12%
  weighted avg roll bps: 19.9
  capacity breaches: 2

3x RLP capital, 95% N external fill:
  RLP PnL: +4.88%
  max drawdown: 16.54%
  weighted avg roll bps: 13.0
  capacity breaches: 0

10x RLP capital, 95% N external fill:
  RLP PnL: +0.77%
  max drawdown: 5.57%
  weighted avg roll bps: 8.6
  capacity breaches: 0

10x RLP capital, 80% N external fill:
  RLP PnL: -0.91%
  max drawdown: 15.33%
  weighted avg roll bps: 10.0
  capacity breaches: 0
```

This points to a trade-off:

```text
Undercapitalized RLP can earn high spreads, but Steady users pay too much and
RLP takes large drawdowns.

Overcapitalized RLP can give Steady users acceptable execution, but RLP itself
is not a very attractive yield product unless it gets fees, incentives, or
better inventory turnover.
```

So RLP probably should not be pitched like "deposit here for huge passive yield"
at MVP. It is closer to protocol liquidity infrastructure:

- seed it with protocol-owned liquidity or aligned strategic capital
- cap Steady vault TVL against it
- give RLP first-loss or incentive compensation only where needed
- route as much inventory as possible to the N vault and external solvers

The best structure may be:

```text
RLP is a backstop + spread-capture vault, not the main risk buyer.
The main risk buyer should be the Boosted ETH / N-side vault.
```

## N-demand experiment

The sixth script, `n_demand.py`, estimates how much recurring `N` buying
capacity the system needs per dollar of Steady AUM.

For a $1m Steady vault under the conservative strategy, IV 90%:

```text
issues: 87 total, 10.3 per year
annual N issuance / Steady AUM: 14.27x
average outstanding N mark / Steady AUM: 2.25x
maximum outstanding N mark / Steady AUM: 14.75x
average outstanding N cost / Steady AUM: 2.12x
maximum outstanding N cost / Steady AUM: 16.04x
danger-roll share of N issuance: 37.82%

total N bought: $120.0m
total N payoff: $135.1m
N portfolio return: 12.59%
ETH benchmark return: 7.16%
loss rate: 55.17%
```

This is probably the most important market-design finding so far.

Even if `N` is attractive, the system creates a lot of it. For every $1m of
Steady AUM, the conservative strategy produced about $14m of annualized `N`
issuance in this historical window. Average outstanding `N` was about 2.1-2.3x
Steady AUM, and peak outstanding exposure was much higher.

Implication:

```text
The N-side product is not optional. Steady capacity is constrained by credible
N demand, not merely by smart contract capacity.
```

This suggests an MVP launch order:

1. Start with Boosted ETH / N vault demand.
2. Use that committed demand to size Steady ETH.
3. Add RLP as residual/backstop liquidity.
4. Increase Steady caps only after N-side absorption is proven.

One rough sizing rule from this model:

```text
If the system has $1m of reliable N-side buying capacity outstanding, Steady
AUM should likely start well below $500k, and maybe closer to $100k-$250k,
until live roll behavior is proven.
```

## User promise and risk bands

The seventh script, `user_bands.py`, translates the Steady strategy into
user-facing language by comparing it against holding ETH.

For the conservative Steady strategy, IV 90%, 2018-01-01 to 2026-06-01:

```text
5 bps per-side roll cost:
  median balance: 0.982x
  10th / 90th percentile balance: 0.955x / 1.002x
  worst balance: 0.935x
  max drawdown: 7.50%
  90-day p05 return: -2.21%

10 bps per-side roll cost:
  median balance: 0.944x
  10th / 90th percentile balance: 0.912x / 0.976x
  worst balance: 0.894x
  max drawdown: 11.14%
  90-day p05 return: -2.50%

25 bps per-side roll cost:
  median balance: 0.845x
  10th / 90th percentile balance: 0.773x / 0.942x
  worst balance: 0.692x
  max drawdown: 31.19%
  90-day p05 return: -3.37%

Plain ETH hold:
  median balance: 2.299x
  10th / 90th percentile balance: 0.228x / 4.526x
  worst balance: 0.109x
  max drawdown: 93.96%
  90-day p05 return: -51.79%
```

This gives a much clearer user promise:

```text
Steady ETH does not promise to stay exactly at $1.
It tries to turn ETH's large swings into small drift.
```

What the UI should say:

```text
Reduce ETH volatility without selling, borrowing, or liquidation.
```

What the UI should not say:

```text
Stablecoin
Dollar account
Guaranteed principal
Always redeemable at $1
```

Risk bands can be shown directly:

```text
Optimistic execution: expected balance band around 0.95x-1.00x
Base execution: expected balance band around 0.91x-0.98x
Stressed execution: expected balance band around 0.77x-0.94x
```

The product should probably expose three statuses:

```text
Normal: rolls clearing cheaply, balance expected to drift slowly.
Stressed: rolls clearing but more expensive, balance may leak.
Emergency: liquidity thin or ETH moving fast, protection can drift materially.
```

## Oracle and settlement exploration

See `oracle_settlement.md` for the fuller version.

The important design split is:

```text
UI estimate price      -> fast feeds are fine
roll decision price    -> private/offchain feeds are fine
maturity settlement    -> slow, explicit, disputable oracle
```

Only maturity settlement is consensus-critical. The system should not put a
real-time liquidation oracle in the critical path, because avoiding that is the
point of the design.

Recommended MVP path:

```text
Phase 0/testnet:
  trusted poster
  24h settlement delay
  manual correction if needed

Guarded mainnet pilot:
  small caps
  optimistic settlement process
  exact TWAP methodology in oracle request data
  24-72h dispute window

Production:
  redundant proposal inputs
  optimistic dispute path
  open-interest caps per series
  dispute bond scales with value at risk
```

The Steady vault should avoid holding to maturity:

```text
target roll: 14 days before maturity
forced roll mode: 7 days before maturity
settlement mainly handles residual users and N holders
```

This keeps oracle anxiety away from the ordinary Steady user experience.

## Standardization exploration

The eighth script, `standardization.py`, compares ideal continuous strikes and
maturities against fixed strike grids and monthly expiries.

Full-window result, 2018-01-01 to 2026-06-01, 10 bps per side:

```text
continuous:       final 0.898x, CAGR -1.27%, maxDD 11.14%
$25 strikes:      final 0.847x, CAGR -1.95%, maxDD 15.66%
$50 strikes:      final 0.735x, CAGR -3.59%, maxDD 26.68%
$50 + monthly:    final 0.878x, CAGR -1.53%, maxDD 12.42%
$100 + monthly:   final 0.830x, CAGR -2.19%, maxDD 23.99%
```

Recent-window result, 2021-01-01 to 2026-06-01, 10 bps per side:

```text
continuous:       final 0.964x, CAGR -0.68%, maxDD  6.09%
$25 strikes:      final 0.954x, CAGR -0.87%, maxDD  6.22%
$50 strikes:      final 0.942x, CAGR -1.10%, maxDD  8.04%
$100 strikes:     final 0.943x, CAGR -1.07%, maxDD  7.19%
$50 + monthly:    final 0.916x, CAGR -1.61%, maxDD  9.82%
$100 + monthly:   final 0.906x, CAGR -1.80%, maxDD 10.06%
```

Interpretation:

```text
Standardization is viable, but a fixed dollar grid must adapt to the ETH price
regime. A coarse $100 grid was dangerous when ETH was historically low, but
reasonable in the recent high-price window.
```

MVP standardization recommendation:

```text
index: ETH/USD only
collateral: ETH only
strategy: Steady ETH only, plus Boosted ETH/N vault
expiry: monthly or 60-day canonical series
roll target: 14 days before maturity
emergency roll: 7 days before maturity or danger threshold
strike bands: spot/2 for routine P, spot/4 for danger reset
strike rounding: adaptive grid, roughly 1-3% of ETH spot
series cap: each series has an open-interest cap
vault cap: Steady AUM capped by demonstrated N demand + RLP capacity
```

What not to support at MVP:

```text
no CPI/rent/commodity indexes
no custom strikes
no custom maturities
no leveraged Steady modes
no "stablecoin" transfer UX
no uncapped deposits
```

The launch should optimize for one thick market, not many expressive markets.

## Fully decentralized settlement simplification

See `decentralized_mvp.md` and `twap_caps.py`.

To remove the trusted settlement point, define settlement as an onchain market
measurement:

```text
settlementPrice = Uniswap v3 ETH/USDC TWAP over [maturity - W, maturity]
```

This removes the need for:

```text
trusted poster
offchain proposer
settlement committee
admin price override
```

But it changes the trust/risk surface:

```text
the product is ETH/USDC-TWAP, not pure ETH/USD
USDC risk remains
Uniswap liquidity risk remains
TWAP manipulation risk remains
```

The rough manipulation-cap script estimates spot distortion required to bias a
TWAP. With a placeholder assumption that a 1% upward pool move requires $10m,
the model gives:

```text
1-day TWAP, attacker controls 1h:
  1% TWAP bias requires 1.27x spot factor and about $254m trade capital
  suggested cap at 10x safety factor: about $25m

3-day TWAP, attacker controls 1h:
  1% TWAP bias requires 2.05x spot factor and about $864m trade capital
  suggested cap at 10x safety factor: about $86m

3-day TWAP, attacker controls 1d:
  1% TWAP bias requires 1.03x spot factor and about $30m trade capital
  suggested cap at 10x safety factor: about $3m
```

This shows why long TWAPs help against short-window attacks but do not remove
the need for caps. If an attacker can pressure the market for a large fraction
of the TWAP window, manipulation becomes much cheaper.

Simplified MVP direction:

```text
no offchain oracle
no dispute mechanism
72h Uniswap v3 TWAP settlement
small immutable open-interest caps
manual new-factory deployment for parameter changes
```

The trade-off is acceptable for a capped pilot, as long as the product is honest
about being tied to an onchain USDC market rather than an abstract dollar.
