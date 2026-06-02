#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEFAULT_MANIFEST = path.join("demo", "contract-manifest.json");

function usage() {
  return `Usage:
  node ops/production-monitor.mjs --rpc <RPC_URL> --manifest <path> [options]

Options:
  --manifest <path>              Manifest path (default: ${DEFAULT_MANIFEST})
  --rpc <url>                    RPC URL (default: RPC_URL/MAINNET_RPC_URL)
  --expect-chain-id <hex>        Optional expected chain id, e.g. 0x1
  --boosted-demand-eth <eth>     Committed Boosted/N-side demand for capacity gate
  --solver-float-eth <eth>       External solver float for capacity gate
  --no-solver-launch             Monitor small-cap no-solver launch mode
  --interval-seconds <n>         Repeat monitor every n seconds
  --iterations <n>               Number of runs when interval is set (default: unlimited)
  --json                         Print machine-readable JSON

Examples:
  node ops/production-monitor.mjs --rpc $RPC_URL --manifest manifests/ethereum-pilot.json --expect-chain-id 0x1
  node ops/production-monitor.mjs --rpc $RPC_URL --manifest manifests/ethereum-pilot.json --interval-seconds 60`;
}

function parseArgs(argv) {
  const args = {
    manifest: DEFAULT_MANIFEST,
    rpc: process.env.RPC_URL || process.env.MAINNET_RPC_URL || "",
    expectChainId: "",
    boostedDemandEth: "0",
    solverFloatEth: "0",
    noSolverLaunch: false,
    intervalSeconds: 0,
    iterations: 0,
    json: false,
  };

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
    } else if (arg === "--manifest") {
      args.manifest = next();
    } else if (arg === "--rpc") {
      args.rpc = next();
    } else if (arg === "--expect-chain-id") {
      args.expectChainId = next();
    } else if (arg === "--boosted-demand-eth") {
      args.boostedDemandEth = next();
    } else if (arg === "--solver-float-eth") {
      args.solverFloatEth = next();
    } else if (arg === "--no-solver-launch") {
      args.noSolverLaunch = true;
    } else if (arg === "--interval-seconds") {
      args.intervalSeconds = parsePositiveInteger(next(), arg);
    } else if (arg === "--iterations") {
      args.iterations = parsePositiveInteger(next(), arg);
    } else if (arg === "--json") {
      args.json = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!args.rpc) throw new Error("Pass --rpc or set RPC_URL/MAINNET_RPC_URL.");
  return args;
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function runNode(args) {
  const result = spawnSync("node", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    code: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    command: ["node", ...args].join(" "),
  };
}

function jsonFrom(result) {
  if (!result.stdout.trim()) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function readinessArgs(args) {
  const command = [
    "ops/readiness-check.mjs",
    "--manifest",
    args.manifest,
    "--rpc",
    args.rpc,
    "--strict",
    "--require-median-oracle",
    "--capacity-strict",
    "--boosted-demand-eth",
    args.boostedDemandEth,
    "--solver-float-eth",
    args.solverFloatEth,
    "--json",
  ];
  if (args.expectChainId) command.push("--expect-chain-id", args.expectChainId);
  if (args.noSolverLaunch) command.push("--no-solver-launch");
  return command;
}

function keeperArgs(args) {
  const command = [
    "ops/keeper-decisions.mjs",
    "--manifest",
    args.manifest,
    "--rpc",
    args.rpc,
    "--strategy-boosted-demand-eth",
    args.boostedDemandEth,
    "--strategy-solver-float-eth",
    args.solverFloatEth,
    "--json",
  ];
  if (args.noSolverLaunch) command.push("--strategy-no-solver-launch");
  return command;
}

function summarize(readinessResult, keeperResult) {
  const readiness = jsonFrom(readinessResult);
  const keeper = jsonFrom(keeperResult);
  const failures = [];
  const warnings = [];

  if (!readinessResult.ok) failures.push("readiness-check failed");
  if (!keeperResult.ok) failures.push("keeper-decisions failed");

  const readinessCounts = readiness?.counts || { pass: 0, warn: 0, fail: readinessResult.ok ? 0 : 1 };
  const keeperActions = Array.isArray(keeper?.actions) ? keeper.actions : [];
  if (keeperResult.ok && keeperActions.length > 0) {
    warnings.push(`${keeperActions.length} keeper/solver action(s) suggested`);
  }

  return {
    status: failures.length ? "fail" : warnings.length ? "warn" : "pass",
    checkedAt: new Date().toISOString(),
    readiness: {
      ok: readinessResult.ok,
      counts: readinessCounts,
      command: readinessResult.command,
    },
    keeper: {
      ok: keeperResult.ok,
      actionCount: keeperActions.length,
      command: keeperResult.command,
      actions: keeperActions.map((action) => ({
        type: action.type,
        product: action.product || null,
        reason: action.reason || null,
        condition: action.condition || null,
      })),
    },
    failures,
    warnings,
    output: {
      readiness: readinessResult.ok ? "" : `${readinessResult.stdout}${readinessResult.stderr}`.trim().slice(-4000),
      keeper: keeperResult.ok ? "" : `${keeperResult.stdout}${keeperResult.stderr}`.trim().slice(-4000),
    },
  };
}

function printText(report) {
  console.log(`Production monitor: ${report.status.toUpperCase()} at ${report.checkedAt}`);
  console.log(
    `Readiness: ${report.readiness.ok ? "ok" : "failed"} (${report.readiness.counts.pass} pass, ${report.readiness.counts.warn} warn, ${report.readiness.counts.fail} fail)`,
  );
  console.log(`Keeper actions: ${report.keeper.actionCount}`);
  for (const warning of report.warnings) console.log(`WARN ${warning}`);
  for (const failure of report.failures) console.log(`FAIL ${failure}`);
  for (const action of report.keeper.actions) {
    console.log(`- ${action.type}${action.product ? ` ${action.product}` : ""}: ${action.reason || action.condition || "review"}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let run = 0;
  let lastStatus = "pass";

  do {
    run += 1;
    const report = summarize(runNode(readinessArgs(args)), runNode(keeperArgs(args)));
    lastStatus = report.status;
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printText(report);

    if (!args.intervalSeconds || (args.iterations && run >= args.iterations)) break;
    await sleep(args.intervalSeconds * 1000);
  } while (true);

  if (lastStatus === "fail") process.exit(1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
