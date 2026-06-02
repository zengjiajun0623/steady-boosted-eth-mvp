# Contributing

This project is still an MVP, so the main contribution rule is: keep the product
invariants stricter than the demo needs.

## Development Checks

Before opening or merging a PR, run:

```bash
forge test -vvv
node ops/mvp-acceptance.mjs --local-live
```

For economics or capacity changes, also run:

```bash
python3 ops/economic-stress-check.py --end 2026-06-01
python3 ops/capacity-policy.py \
  --end 2026-06-01 \
  --lp-vault-eth 50 \
  --boosted-demand-eth 0 \
  --solver-float-eth 0 \
  --target-steady-eth 5 \
  --rlp-capital-ratio 10 \
  --no-solver-launch \
  --strict

node ops/vault-strategy-plan.mjs \
  --target-steady-cap-eth 5 \
  --target-roll-eth 5 \
  --lp-vault-eth 50 \
  --solver-fill-eth 0 \
  --observed-roll-cost-bps 8.5 \
  --no-solver-launch \
  --expect-action vault-only-bootstrap \
  --strict
```

GitHub Actions runs the full local-live acceptance gate on pushes and pull
requests to `main`.

## Product Invariant Checklist

A PR should explain if it touches any of these:

```text
- ETH-only default trader buy/sell path
- <= 10 bps normal roll target
- wrapper roll-size cap
- ETH LP vault max roll price or inventory sale floor
- solver-first delay
- public roll-auction lifecycle
- settlement oracle source or TWAP window
- capacity policy
- LP risk disclosure
```

If a change loosens a guardrail, include the reason, the new risk, and the new
evidence that the protocol still pauses, shrinks, or requires liquidity instead
of forcing users through expensive rolls.

## Review Style

Prefer small PRs with one clear intent.

Good PR examples:

```text
- add a readiness check for a missing vault invariant
- improve the trader page buy/sell form without changing protocol policy
- add a solver model and prove it improves roll execution
- tighten an auction or LP vault limit
```

Risky PR examples:

```text
- increasing product capacity without a capacity-policy proof
- adding a trusted settlement fallback
- adding an exclusive solver path
- allowing the LP vault to sell inventory below its configured floor
- hiding roll cost or LP risk in the UI
```

## Branches And Commits

Use short branch names that name the work:

```text
frontend-trade-live
vault-strategy-sizing
readiness-oracle-check
solver-reward-accounting
```

Commit messages should describe the user or protocol effect, not just the file
changed.

## Local Demo

Run:

```bash
python3 -m http.server 8765
```

Open:

```text
http://localhost:8765/demo/
```

The demo can run in simulation mode. Live mode uses `demo/contract-manifest.json`
after a local deployment.

## Production Line

Nothing in this repo should be treated as safe for public funds until all of the
following are true:

```text
- external audit complete
- production manifest passes ops/readiness-check.mjs --rpc
- settlement oracle pools and TWAP windows are final
- LP vault capacity and roll-size caps are backed by committed ETH liquidity
- solver and keeper operations are documented and monitored
- frontend is connected to audited contracts
```
