#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const DEFAULT_AVG_N_DEMAND_BPS = 21_152;
const DEFAULT_STRESS_N_DEMAND_BPS = 160_364;

export const DEFAULT_STRATEGY_ARGS = Object.freeze({
  targetSteadyCapEth: null,
  targetRollEth: null,
  lpVaultEth: 0,
  solverFillEth: 0,
  boostedDemandEth: 0,
  solverFloatEth: 0,
  observedRollCostBps: null,
  maxNormalRollBps: 10,
  rlpCapitalRatio: 10,
  nExternalFillBps: 9_500,
  avgNDemandBps: DEFAULT_AVG_N_DEMAND_BPS,
  stressNDemandBps: DEFAULT_STRESS_N_DEMAND_BPS,
  noSolverLaunch: false,
  expectAction: "",
  strict: false,
  json: false,
});

function defaultArgs() {
  return { ...DEFAULT_STRATEGY_ARGS };
}

function usage() {
  return `Usage:
  node ops/vault-strategy-plan.mjs [options]

Options:
  --target-steady-cap-eth <eth>   Current or proposed Steady ETH capacity cap
  --target-roll-eth <eth>         Roll size to clear, defaults to target cap
  --lp-vault-eth <eth>            Committed ETH in the protocol LP vault
  --solver-fill-eth <eth>         Expected immediate external solver fill for this roll
  --boosted-demand-eth <eth>      Committed recurring Boosted/N-side demand
  --solver-float-eth <eth>        External solver balance sheet for paired N inventory
  --observed-roll-cost-bps <bps>  Current expected normal roll cost
  --max-normal-roll-bps <bps>     Strict normal-roll ceiling (default: 10)
  --rlp-capital-ratio <n>         Required LP vault ETH / allowed roll ETH (default: 10)
  --n-external-fill-bps <bps>     Target external N fill for scale mode (default: 9500)
  --avg-n-demand-bps <bps>        Avg historical N outstanding / Steady cap (default: ${DEFAULT_AVG_N_DEMAND_BPS})
  --stress-n-demand-bps <bps>     Max historical N outstanding / Steady cap (default: ${DEFAULT_STRESS_N_DEMAND_BPS})
  --no-solver-launch              Explicit small-cap mode where LP vault alone may clear rolls
  --expect-action <name>          Fail unless the recommended action matches
  --strict                        Treat warnings as failures
  --json                          Print machine-readable JSON

Examples:
  node ops/vault-strategy-plan.mjs \\
    --target-steady-cap-eth 5 \\
    --target-roll-eth 5 \\
    --lp-vault-eth 50 \\
    --observed-roll-cost-bps 8.5 \\
    --no-solver-launch

  node ops/vault-strategy-plan.mjs \\
    --target-steady-cap-eth 100 \\
    --target-roll-eth 20 \\
    --lp-vault-eth 1000 \\
    --solver-fill-eth 15 \\
    --boosted-demand-eth 5000 \\
    --solver-float-eth 250 \\
    --observed-roll-cost-bps 8.5`;
}

function parseArgs(argv) {
  const args = defaultArgs();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return argv[i];
    };

    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--target-steady-cap-eth") {
      args.targetSteadyCapEth = parseNonNegativeNumber(next(), arg);
    } else if (arg === "--target-roll-eth") {
      args.targetRollEth = parseNonNegativeNumber(next(), arg);
    } else if (arg === "--lp-vault-eth") {
      args.lpVaultEth = parseNonNegativeNumber(next(), arg);
    } else if (arg === "--solver-fill-eth") {
      args.solverFillEth = parseNonNegativeNumber(next(), arg);
    } else if (arg === "--boosted-demand-eth") {
      args.boostedDemandEth = parseNonNegativeNumber(next(), arg);
    } else if (arg === "--solver-float-eth") {
      args.solverFloatEth = parseNonNegativeNumber(next(), arg);
    } else if (arg === "--observed-roll-cost-bps") {
      args.observedRollCostBps = parseNonNegativeNumber(next(), arg);
    } else if (arg === "--max-normal-roll-bps") {
      args.maxNormalRollBps = parseNonNegativeNumber(next(), arg);
    } else if (arg === "--rlp-capital-ratio") {
      args.rlpCapitalRatio = parsePositiveNumber(next(), arg);
    } else if (arg === "--n-external-fill-bps") {
      args.nExternalFillBps = parsePositiveBps(next(), arg);
    } else if (arg === "--avg-n-demand-bps") {
      args.avgNDemandBps = parsePositiveBps(next(), arg);
    } else if (arg === "--stress-n-demand-bps") {
      args.stressNDemandBps = parsePositiveBps(next(), arg);
    } else if (arg === "--no-solver-launch") {
      args.noSolverLaunch = true;
    } else if (arg === "--expect-action") {
      args.expectAction = next();
    } else if (arg === "--strict") {
      args.strict = true;
    } else if (arg === "--json") {
      args.json = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return normalizePlanArgs(args);
}

export function normalizePlanArgs(input) {
  const args = { ...DEFAULT_STRATEGY_ARGS, ...input };

  if (args.targetSteadyCapEth === null && args.targetRollEth === null) {
    throw new Error("Pass --target-steady-cap-eth or --target-roll-eth.");
  }
  if (args.targetSteadyCapEth === null) args.targetSteadyCapEth = args.targetRollEth;
  if (args.targetRollEth === null) args.targetRollEth = args.targetSteadyCapEth;
  if (args.observedRollCostBps === null) throw new Error("Pass --observed-roll-cost-bps.");
  if (args.solverFillEth > args.targetRollEth) args.solverFillEth = args.targetRollEth;
  return args;
}

function parseNonNegativeNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
  return parsed;
}

function parsePositiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

function parsePositiveBps(value, name) {
  const parsed = parsePositiveNumber(value, name);
  if (parsed > 10_000) throw new Error(`${name} must be <= 10000`);
  return parsed;
}

function check(level, name, detail, data = {}) {
  return { level, name, detail, data };
}

function capFromExternalDemand(externalDemandEth, demandBps, fillBps) {
  const requiredRatio = (demandBps / 10_000) * (fillBps / 10_000);
  return requiredRatio <= 0 ? Number.POSITIVE_INFINITY : externalDemandEth / requiredRatio;
}

function fmtEth(value) {
  if (!Number.isFinite(value)) return "unbounded";
  if (Math.abs(value) >= 100) return `${value.toLocaleString("en-US", { maximumFractionDigits: 0 })} ETH`;
  if (Math.abs(value) >= 10) return `${value.toLocaleString("en-US", { maximumFractionDigits: 1 })} ETH`;
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 4 })} ETH`;
}

function fmtBps(value) {
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} bps`;
}

function statusFor(checks) {
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const item of checks) counts[item.level] += 1;
  const status = counts.fail ? "fail" : counts.warn ? "warn" : "pass";
  return { status, counts };
}

export function buildPlan(input) {
  const args = normalizePlanArgs(input);
  const checks = [];
  const externalDemandEth = args.boostedDemandEth + args.solverFloatEth;
  const lpRollCapEth = args.lpVaultEth / args.rlpCapitalRatio;
  const solverFillEth = Math.min(args.solverFillEth, args.targetRollEth);
  const vaultRemainderEth = Math.max(0, args.targetRollEth - solverFillEth);
  const avgExternalCapEth = capFromExternalDemand(externalDemandEth, args.avgNDemandBps, args.nExternalFillBps);
  const stressExternalCapEth = capFromExternalDemand(externalDemandEth, args.stressNDemandBps, args.nExternalFillBps);
  const launchCapEth = args.noSolverLaunch ? lpRollCapEth : Math.min(lpRollCapEth, avgExternalCapEth);
  const stressCapEth = args.noSolverLaunch ? lpRollCapEth : Math.min(lpRollCapEth, stressExternalCapEth);

  checks.push(
    check(
      args.observedRollCostBps <= args.maxNormalRollBps ? "pass" : "fail",
      "normal roll cost stays inside the strict band",
      `Observed ${fmtBps(args.observedRollCostBps)}; maximum is ${fmtBps(args.maxNormalRollBps)}.`,
      {
        observedRollCostBps: args.observedRollCostBps,
        maxNormalRollBps: args.maxNormalRollBps,
      },
    ),
  );

  checks.push(
    check(
      vaultRemainderEth <= lpRollCapEth ? "pass" : "fail",
      "ETH LP vault can backstop the solver remainder",
      `Vault remainder is ${fmtEth(vaultRemainderEth)}; LP-backed roll cap is ${fmtEth(lpRollCapEth)}.`,
      {
        vaultRemainderEth,
        lpRollCapEth,
        lpVaultEth: args.lpVaultEth,
        rlpCapitalRatio: args.rlpCapitalRatio,
      },
    ),
  );

  checks.push(
    check(
      args.targetSteadyCapEth <= lpRollCapEth ? "pass" : "fail",
      "LP capital backs the Steady cap",
      `Target cap ${fmtEth(args.targetSteadyCapEth)} needs ${fmtEth(args.targetSteadyCapEth * args.rlpCapitalRatio)} of LP vault capital; available is ${fmtEth(args.lpVaultEth)}.`,
      {
        targetSteadyCapEth: args.targetSteadyCapEth,
        requiredLpVaultEth: args.targetSteadyCapEth * args.rlpCapitalRatio,
        availableLpVaultEth: args.lpVaultEth,
      },
    ),
  );

  if (args.noSolverLaunch) {
    checks.push(
      check(
        "pass",
        "no-solver launch mode is explicit",
        "External solver and Boosted-side demand are advisory; keep caps small and let the ETH LP vault clear rolls inside its capital ratio.",
        { externalDemandEth },
      ),
    );
  } else {
    checks.push(
      check(
        args.targetSteadyCapEth <= avgExternalCapEth ? "pass" : "fail",
        "average external Boosted/solver demand backs the Steady cap",
        `Target cap ${fmtEth(args.targetSteadyCapEth)} needs ${fmtEth(args.targetSteadyCapEth * (args.avgNDemandBps / 10_000) * (args.nExternalFillBps / 10_000))} of average external N-side support; available is ${fmtEth(externalDemandEth)}.`,
        {
          targetSteadyCapEth: args.targetSteadyCapEth,
          externalDemandEth,
          avgExternalCapEth,
        },
      ),
    );
    checks.push(
      check(
        args.targetSteadyCapEth <= stressExternalCapEth ? "pass" : "warn",
        "stress external Boosted/solver demand backs the Steady cap",
        `Target cap ${fmtEth(args.targetSteadyCapEth)} needs ${fmtEth(args.targetSteadyCapEth * (args.stressNDemandBps / 10_000) * (args.nExternalFillBps / 10_000))} of stress external N-side support; available is ${fmtEth(externalDemandEth)}.`,
        {
          targetSteadyCapEth: args.targetSteadyCapEth,
          externalDemandEth,
          stressExternalCapEth,
        },
      ),
    );
  }

  const failing = checks.filter((item) => item.level === "fail");
  const costFailed = failing.some((item) => item.name === "normal roll cost stays inside the strict band");
  const vaultFailed = failing.some((item) => item.name === "ETH LP vault can backstop the solver remainder");
  const capFailed = failing.some((item) => item.name === "LP capital backs the Steady cap");
  const externalFailed = failing.some((item) => item.name === "average external Boosted/solver demand backs the Steady cap");

  let action;
  let recommendation;
  if (costFailed) {
    action = "pause-rolls";
    recommendation = "Do not force this roll. Wait for a cheaper auction fill, reset the curve, shrink capacity, or require more solver/backstop liquidity.";
  } else if (vaultFailed) {
    action = "increase-vault-liquidity-or-shrink-roll";
    recommendation = "The solver remainder is larger than the ETH LP vault can responsibly backstop. Reduce the roll size or add LP vault capital.";
  } else if (capFailed) {
    action = "shrink-capacity";
    recommendation = "The Steady cap is too large for committed LP vault capital. Lower capacity before starting new rolls.";
  } else if (externalFailed) {
    action = "require-more-boosted-or-solver-demand";
    recommendation = "The LP vault is not the bottleneck, but scale-mode external N-side support is too thin. Add Boosted demand, solver float, or switch to explicit no-solver launch with a smaller cap.";
  } else if (solverFillEth >= args.targetRollEth && args.targetRollEth > 0) {
    action = "clear-with-solvers";
    recommendation = "External solvers can clear the roll inside the normal-cost band. The ETH LP vault can stay idle.";
  } else if (solverFillEth > 0) {
    action = "solver-first-vault-backstop";
    recommendation = "Let solvers fill first, then allow the ETH LP vault to backstop the remaining cheap roll after its delay.";
  } else if (args.noSolverLaunch) {
    action = "vault-only-bootstrap";
    recommendation = "For this small launch, the ETH LP vault can clear the roll alone inside the capital ratio and cost band.";
  } else {
    action = "wait-for-solvers-then-vault-backstop";
    recommendation = "No immediate solver fill is expected. Keep solver discovery open first, then let the ETH LP vault backstop only if the cheap band still holds.";
  }

  if (args.expectAction && args.expectAction !== action) {
    checks.push(
      check(
        "fail",
        "expected action matched",
        `Expected ${args.expectAction}, got ${action}.`,
        { expected: args.expectAction, actual: action },
      ),
    );
  }

  const { status, counts } = statusFor(checks);
  return {
    status,
    counts,
    action,
    recommendation,
    mode: args.noSolverLaunch ? "no-solver LP-vault launch" : "LP vault plus external solver/Boosted demand",
    inputs: args,
    derived: {
      externalDemandEth,
      lpRollCapEth,
      solverFillEth,
      vaultRemainderEth,
      avgExternalCapEth,
      stressExternalCapEth,
      launchCapEth,
      stressCapEth,
    },
    checks,
  };
}

function printReport(plan) {
  const counts = plan.counts;
  console.log(`Vault strategy: ${plan.status.toUpperCase()} (${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail)`);
  console.log(`Mode: ${plan.mode}`);
  console.log(`Recommended action: ${plan.action}`);
  console.log(`Recommendation: ${plan.recommendation}`);
  console.log("");
  console.log(`LP-backed roll cap: ${fmtEth(plan.derived.lpRollCapEth)}`);
  console.log(`Target Steady cap: ${fmtEth(plan.inputs.targetSteadyCapEth)}`);
  console.log(`Target roll size: ${fmtEth(plan.inputs.targetRollEth)}`);
  console.log(`Solver fill: ${fmtEth(plan.derived.solverFillEth)}`);
  console.log(`Vault remainder: ${fmtEth(plan.derived.vaultRemainderEth)}`);
  console.log(`Suggested launch cap: ${fmtEth(plan.derived.launchCapEth)}`);
  console.log(`Stress cap: ${fmtEth(plan.derived.stressCapEth)}`);
  console.log("");

  for (const level of ["fail", "warn", "pass"]) {
    const rows = plan.checks.filter((item) => item.level === level);
    if (!rows.length) continue;
    console.log(level.toUpperCase());
    for (const row of rows) console.log(`- ${row.name}: ${row.detail}`);
    console.log("");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = buildPlan(args);

  if (args.json) console.log(JSON.stringify(plan, null, 2));
  else printReport(plan);

  if (plan.status === "fail" || (args.strict && plan.counts.warn > 0)) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
