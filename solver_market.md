# Solver Market

External solvers are the first competitive roll counterparties. They are not
exclusive market makers and do not need a backend approval path.

## Mental Model

```text
1. Wrappers start public Dutch roll auctions.
2. Solver bots read onchain auction state.
3. A solver bids only when price, size, and inventory risk fit its model.
4. The ETH LP vault waits behind the solver-first delay and backstops only if
   the auction is still cheap and inside vault policy.
5. Public reports measure how much external solvers filled before the vault.
```

For Steady ETH rolls, the auction sells old `P` and asks for next-series `P`.
For Boosted ETH rolls, the auction sells old `N` and asks for next-series `N`.

## Discover Actions

Use the public runner in dry-run mode:

```bash
node ops/keeper-runner.mjs \
  --action solver \
  --manifest demo/contract-manifest.json \
  --rpc $RPC_URL \
  --recipient <SOLVER_RECIPIENT> \
  --max-price-wad 1000000000000000000 \
  --solver-model ops/solver-model-spread.mjs
```

The dry-run output includes a ready action and its transaction command when a
solver bid is available. For structured JSON, call `ops/keeper-decisions.mjs`
with the same manifest, RPC, recipient, price, and model options.

The structured action includes:

```text
type: solver-bid
ready: true or false
suggestedFill
fillMode: fixedAmount or fillAll
maxPriceWad
maxBuyAmount
command
```

The generated command calls `RollSolver`, not a privileged backend. The helper
can mint the next series atomically from ETH, pay the auction with the needed
side, and return leftover paired inventory to the solver recipient.

## Plug In A Model

`ops/solver-model-spread.mjs` is the reference model. It receives JSON on stdin
from `ops/keeper-decisions.mjs` and returns JSON:

```json
{
  "bid": true,
  "maxPriceWad": "997500000000000000",
  "sellAmountWei": "400000000000000000",
  "reason": "Current Dutch price is inside the model price after 25 bps edge."
}
```

Useful environment variables for the reference model:

```bash
SOLVER_EDGE_BPS=25
SOLVER_FAIR_PRICE_WAD=1000000000000000000
SOLVER_MAX_FILL_ETH=0.4
```

A production solver should replace this with its own valuation, inventory, and
gas model. The only required contract behavior is respecting `maxBuyAmount` and
the auction dust rules.

## Measure Solver Contribution

After a roll, attribute public `AuctionFilled` events:

```bash
node ops/solver-improvement-report.mjs \
  --manifest demo/contract-manifest.json \
  --rpc $RPC_URL \
  --auction-id <AUCTION_ID>
```

The report classifies fills as:

```text
external solver: RollSolver or direct non-vault takers
ETH LP vault: fills where the taker or recipient is the protocol LP vault
```

It also estimates how many buy-token units external solvers saved versus the
ETH LP vault's configured `maxRollPriceWad` baseline. This is not a solver fee
yet; it is transparent accounting for whether solvers improved execution before
the vault stepped in.

For launch readiness, the local-live acceptance gate requires external fill in
the solver-plus-vault path and separately proves the no-solver vault-only
bootstrap path.

## Good Solver Behavior

```text
- bid before the vault only when the price is inside your model
- use fillAll variants when you intend to clear the current remainder
- cap every bid with maxBuyAmount
- leave no dust remainder below RollAuction.minSellAmount
- treat leftover paired P/N inventory as market risk, not free yield
```

## What Is Still Missing

```text
- production solver commitments or liquidity SLAs
- a formal solver reward program for fills that improve execution
- deeper market data feeds for fair-value models
- gas and MEV policy for competitive solver operations
```
