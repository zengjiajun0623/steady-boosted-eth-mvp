# Incident Response Runbook

This runbook is for the Steady ETH / Boosted ETH protocol production path.

The protocol is designed with no normal admin. Incident response must not assume
an owner can rewrite settlement, force an expensive roll, rescue LP inventory,
or replace a public auction. The response path is detection, public disclosure,
keeper/solver execution through existing public entrypoints, capacity control,
and, when needed, migration to a safer deployment.

## Severity Levels

```text
SEV-0: Active exploit, loss of funds, corrupt settlement, or frontend compromise.
SEV-1: Roll, oracle, vault, or keeper failure that can harm users if unresolved.
SEV-2: Degraded liquidity, delayed settlement, non-critical accounting mismatch.
SEV-3: Documentation, analytics, or non-blocking UI issue.
```

## First 15 Minutes

```text
1. Freeze new production announcements and capacity increases.
2. Assign one incident lead and one communications owner.
3. Capture chain, tx hashes, manifest path, affected series ids, and timestamps.
4. Run readiness and keeper inspection:
   node ops/readiness-check.mjs --manifest <manifest> --rpc <rpc> --strict --require-median-oracle --capacity-strict
   node ops/keeper-decisions.mjs --manifest <manifest> --rpc <rpc>
   node ops/production-monitor.mjs --manifest <manifest> --rpc <rpc> --expect-chain-id 0x1
5. Check whether the issue is contract state, oracle readiness, solver liquidity,
   frontend/wallet routing, or docs/ops only.
6. Publish an internal status note with current user impact and next update time.
```

## SEV-0 Actions

```text
1. Remove public launch links or replace them with a clear risk warning.
2. Stop all growth actions: no new caps, no new production deployments, no LP
   marketing, no solver rewards expansion.
3. If settlement is affected, do not encourage redemptions until oracle state is
   understood and independently verified.
4. If a public keeper action can reduce risk, run it only after dry-run output is
   reviewed by two people:
   node ops/keeper-runner.mjs --manifest <manifest> --rpc <rpc> --action settlement
   node ops/keeper-runner.mjs --manifest <manifest> --rpc <rpc> --action wrapper
   node ops/keeper-runner.mjs --manifest <manifest> --rpc <rpc> --action lp
5. Publish a user-facing incident notice with affected products, affected series,
   known safe actions, known unsafe actions, and next update time.
6. Preserve logs, manifests, screenshots, tx hashes, and command outputs.
```

## Roll Or Solver Failure

```text
1. Run keeper decisions and vault strategy planner.
2. If normal roll cost is above the strict band, do not force the roll.
3. Use the product answer encoded in policy: wait for cheaper solver fills,
   shrink future capacity, or require more LP/solver/Boosted liquidity.
4. If the wrapper roll fully fails and deposits pause, leave deposits paused
   until a later public retry clears and finalizes.
5. Attribute solver and vault fills:
   node ops/solver-improvement-report.mjs --manifest <manifest> --rpc <rpc>
```

## Settlement Or Oracle Failure

```text
1. Confirm chain id and manifest mode.
2. Run mainnet oracle preflight when on Ethereum mainnet:
   node ops/mainnet-oracle-preflight.mjs --rpc <mainnet-rpc>
3. Run readiness with --require-median-oracle.
4. Check series maturity, TWAP window, registered oracle metadata, and all three
   stable source states.
5. If any source is stale, missing, out of bounds, or duplicated, do not claim
   the series is ready for settlement.
6. There is no manual settlement fallback. Recovery is waiting for valid oracle
   readiness, using public settlement once ready, or migrating future capacity.
```

## LP Vault Inventory Failure

```text
1. Inspect LP vault health, open inventory series, and open inventory markets.
2. Do not allow new LP deposits or withdrawals while strategy inventory is open.
   The vault contract already enforces this to avoid trusted mark-to-market.
3. Prefer deterministic cleanup:
   - merge matched P/N inventory before maturity
   - redeem matured P or N only after settlement
   - sell or add liquidity only inside immutable vault price floors and caps
4. Do not present LP losses as temporary accounting noise. LP share price can go
   down when the vault takes market-making risk.
```

## Frontend Or Wallet Failure

```text
1. Remove or disable the affected hosted frontend.
2. Publish the canonical contract manifest and known-good commit hash.
3. Tell users not to connect wallets to unknown mirrors.
4. Keep command-line public runners available for verifiers and advanced users.
5. Re-enable frontend only after wallet routing, chain checks, calldata selectors,
   and transaction copy are reviewed.
```

## Communications

Every user-facing update should include:

```text
- severity
- affected products and series ids
- affected time range
- what users can safely do now
- what users should avoid
- next update time
- whether funds are believed to be at risk
```

Avoid saying "paused by admin" unless a future deployment actually adds such a
mechanism. In the MVP architecture, safety comes from immutable policy limits,
public readiness gates, failed-roll deposit pauses, and not growing capacity
when liquidity evidence is missing.

## Recovery And Closeout

```text
1. Confirm production readiness passes again:
   node ops/production-readiness.mjs --manifest <manifest> --rpc <mainnet-rpc> ...
2. Write a postmortem with root cause, user impact, financial impact, and fixes.
3. Add tests or readiness checks that would have caught the issue earlier.
4. Update this runbook if the response path was unclear.
5. Do not restore growth until audit/security owners sign off.
```
