#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEFAULT_MANIFEST = path.join("demo", "contract-manifest.json");
const DEFAULT_END = "2026-06-01";

const NODE_CHECKS = [
  "demo/app.js",
  "ops/deploy-local-demo.mjs",
  "ops/export-manifest.mjs",
  "ops/keeper-decisions.mjs",
  "ops/keeper-runner.mjs",
  "ops/mvp-acceptance.mjs",
  "ops/readiness-check.mjs",
  "ops/solver-model-spread.mjs",
  "ops/vault-strategy-plan.mjs",
];

const PYTHON_CHECKS = [
  "ops/capacity-policy.py",
  "ops/economic-stress-check.py",
];

function usage() {
  return `Usage:
  node ops/mvp-acceptance.mjs [options]

Options:
  --manifest <path>                  Manifest path for optional live checks (default: ${DEFAULT_MANIFEST})
  --rpc <RPC_URL>                    Include live manifest/readiness checks
  --expect-chain-id <hex>            Optional expected live chain id, e.g. 0x1 or 0x7a69
  --live-strict                      Make live readiness warnings fail
  --capacity-end <yyyy-mm-dd>         Historical data end date (default: ${DEFAULT_END})
  --capacity-lp-eth <eth>            Capacity smoke LP vault ETH (default: 1000)
  --capacity-boosted-demand-eth <eth>
                                     Capacity smoke committed Boosted demand (default: 5000)
  --capacity-solver-float-eth <eth>  Capacity smoke solver float (default: 250)
  --capacity-target-steady-eth <eth> Capacity smoke proposed Steady cap (default: 100)
  --skip-forge                       Skip Foundry test suite
  --skip-static                      Skip JS/Python static checks
  --skip-economic                    Skip historical economic stress check
  --skip-capacity                    Skip launch capacity policy check
  --local-live                       Start Anvil and run deploy/trade/LP/solver smoke
  --skip-live                        Skip live readiness even when --rpc is provided
  --json                             Print machine-readable JSON

Examples:
  node ops/mvp-acceptance.mjs
  node ops/mvp-acceptance.mjs --rpc http://127.0.0.1:8545 --manifest demo/contract-manifest.json
  node ops/mvp-acceptance.mjs --rpc $RPC_URL --expect-chain-id 0x1 --live-strict`;
}

function parseArgs(argv) {
  const args = {
    manifest: DEFAULT_MANIFEST,
    rpc: process.env.RPC_URL || "",
    expectChainId: "",
    liveStrict: false,
    json: false,
    skipForge: false,
    skipStatic: false,
    skipEconomic: false,
    skipCapacity: false,
    localLive: false,
    skipLive: false,
    capacityEnd: DEFAULT_END,
    capacityLpEth: "1000",
    capacityBoostedDemandEth: "5000",
    capacitySolverFloatEth: "250",
    capacityTargetSteadyEth: "100",
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
    } else if (arg === "--live-strict") {
      args.liveStrict = true;
    } else if (arg === "--capacity-end") {
      args.capacityEnd = next();
    } else if (arg === "--capacity-lp-eth") {
      args.capacityLpEth = next();
    } else if (arg === "--capacity-boosted-demand-eth") {
      args.capacityBoostedDemandEth = next();
    } else if (arg === "--capacity-solver-float-eth") {
      args.capacitySolverFloatEth = next();
    } else if (arg === "--capacity-target-steady-eth") {
      args.capacityTargetSteadyEth = next();
    } else if (arg === "--skip-forge") {
      args.skipForge = true;
    } else if (arg === "--skip-static") {
      args.skipStatic = true;
    } else if (arg === "--skip-economic") {
      args.skipEconomic = true;
    } else if (arg === "--skip-capacity") {
      args.skipCapacity = true;
    } else if (arg === "--local-live") {
      args.localLive = true;
    } else if (arg === "--skip-live") {
      args.skipLive = true;
    } else if (arg === "--json") {
      args.json = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return args;
}

function runStep({ area, name, command, args }) {
  const started = Date.now();
  const child = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const elapsedMs = Date.now() - started;
  const stdout = child.stdout || "";
  const stderr = child.stderr || "";
  const status = child.status === 0 ? "pass" : "fail";

  return {
    area,
    name,
    status,
    command: [command, ...args].join(" "),
    elapsedMs,
    code: child.status,
    summary: outputSummary(stdout, stderr, status),
  };
}

function skipStep(area, name, reason) {
  return {
    area,
    name,
    status: "skip",
    command: "",
    elapsedMs: 0,
    code: 0,
    summary: reason,
  };
}

function outputSummary(stdout, stderr, status) {
  const combined = `${stdout}\n${stderr}`.trim();
  if (!combined) return "";
  const lines = combined.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (status === "fail") return lines.slice(-30).join("\n");

  const useful = lines.filter((line) =>
    /^(Suite result|Ran \d+ test|MVP acceptance|Economic stress|Capacity policy|PASS|WARN|FAIL|No files changed|Success|Compiler run)/i.test(line)
      || /tests? passed/i.test(line)
      || /Error:/i.test(line)
  );
  return (useful.length ? useful : lines).slice(-8).join("\n");
}

function buildSteps(args) {
  const steps = [];
  if (args.skipForge) {
    steps.push(skipStep("contracts", "Foundry product suite", "Skipped by --skip-forge."));
  } else {
    steps.push({
      area: "contracts",
      name: "Foundry product suite",
      command: "forge",
      args: ["test", "-vvv"],
    });
  }

  if (args.skipStatic) {
    steps.push(skipStep("static", "Demo/operator syntax checks", "Skipped by --skip-static."));
  } else {
    for (const file of NODE_CHECKS) {
      steps.push({
        area: file.startsWith("demo/") ? "demo" : "operators",
        name: `node --check ${file}`,
        command: "node",
        args: ["--check", file],
      });
    }
    steps.push({
      area: "risk",
      name: "Python risk script compile",
      command: "python3",
      args: ["-m", "py_compile", ...PYTHON_CHECKS],
    });
  }

  if (args.skipEconomic) {
    steps.push(skipStep("economics", "Historical RLP/N stress", "Skipped by --skip-economic."));
  } else {
    steps.push({
      area: "economics",
      name: "Historical RLP/N stress",
      command: "python3",
      args: [
        "ops/economic-stress-check.py",
        "--end",
        args.capacityEnd,
        "--rlp-capital-ratio",
        "10",
        "--n-external-fill",
        "0.95",
        "--max-weighted-bps",
        "10",
        "--strict",
      ],
    });
  }

  if (args.skipCapacity) {
    steps.push(skipStep("economics", "ETH launch capacity smoke", "Skipped by --skip-capacity."));
  } else {
    steps.push({
      area: "economics",
      name: "ETH launch capacity smoke",
      command: "python3",
      args: [
        "ops/capacity-policy.py",
        "--end",
        args.capacityEnd,
        "--lp-vault-eth",
        args.capacityLpEth,
        "--boosted-demand-eth",
        args.capacityBoostedDemandEth,
        "--solver-float-eth",
        args.capacitySolverFloatEth,
        "--target-steady-eth",
        args.capacityTargetSteadyEth,
        "--rlp-capital-ratio",
        "10",
        "--n-external-fill",
        "0.95",
        "--strict",
      ],
    });
    steps.push({
      area: "economics",
      name: "No-solver launch capacity smoke",
      command: "python3",
      args: [
        "ops/capacity-policy.py",
        "--end",
        args.capacityEnd,
        "--lp-vault-eth",
        "50",
        "--boosted-demand-eth",
        "0",
        "--solver-float-eth",
        "0",
        "--target-steady-eth",
        "5",
        "--rlp-capital-ratio",
        "10",
        "--no-solver-launch",
        "--strict",
      ],
    });
    steps.push({
      area: "operators",
      name: "ETH LP vault strategy smoke",
      command: "node",
      args: [
        "ops/vault-strategy-plan.mjs",
        "--target-steady-cap-eth",
        "5",
        "--target-roll-eth",
        "5",
        "--lp-vault-eth",
        "50",
        "--solver-fill-eth",
        "0",
        "--observed-roll-cost-bps",
        "8.5",
        "--no-solver-launch",
        "--expect-action",
        "vault-only-bootstrap",
        "--strict",
      ],
    });
  }

  if (args.localLive) {
    steps.push({
      area: "live",
      name: "Local deploy/trade/LP/solver smoke",
      command: "node",
      args: ["ops/local-live-smoke.mjs"],
    });
    steps.push({
      area: "live",
      name: "Local no-solver LP-vault launch smoke",
      command: "node",
      args: ["ops/local-live-smoke.mjs", "--no-solver-launch"],
    });
  } else {
    steps.push(skipStep("live", "Local deploy/trade/LP/solver smoke", "Pass --local-live to run a fresh Anvil smoke test."));
    steps.push(skipStep("live", "Local no-solver LP-vault launch smoke", "Pass --local-live to run a fresh Anvil no-solver smoke test."));
  }

  if (args.skipLive) {
    steps.push(skipStep("live", "Manifest readiness", "Skipped by --skip-live."));
  } else if (!args.rpc) {
    steps.push(skipStep("live", "Manifest readiness", "Pass --rpc to include a deployed manifest/readiness check."));
  } else {
    const readinessArgs = [
      "ops/readiness-check.mjs",
      "--manifest",
      args.manifest,
      "--rpc",
      args.rpc,
      "--boosted-demand-eth",
      args.capacityBoostedDemandEth,
      "--solver-float-eth",
      args.capacitySolverFloatEth,
      "--capacity-strict",
    ];
    if (args.liveStrict) readinessArgs.push("--strict");
    if (args.expectChainId) readinessArgs.push("--expect-chain-id", args.expectChainId);
    steps.push({
      area: "live",
      name: "Manifest readiness",
      command: "node",
      args: readinessArgs,
    });
  }

  return steps;
}

function summarize(results) {
  const counts = { pass: 0, skip: 0, fail: 0 };
  for (const result of results) counts[result.status] += 1;
  return {
    status: counts.fail ? "fail" : "pass",
    counts,
    results,
  };
}

function printReport(report) {
  const { counts } = report;
  console.log(`MVP acceptance: ${report.status.toUpperCase()} (${counts.pass} pass, ${counts.skip} skip, ${counts.fail} fail)`);
  console.log("");
  console.log("Covers:");
  console.log("- Trader: Steady/Boosted ETH buy/sell markets and demo trading surface.");
  console.log("- LP: ETH vault deposit/withdraw, roll backstop, inventory cleanup, return check, and capacity policy.");
  console.log("- Vault strategy: solver-first, vault-backstop, vault-only bootstrap, and pause/shrink/liquidity-required planning.");
  console.log("- Solver: public Dutch roll auctions, callback fills, fill-all paths, and keeper discovery.");
  console.log("- Rotation: historical 10 bps roll-cost gate plus a live 10 bps public roll smoke.");
  console.log("- Bootstrap: no-solver launch capacity gate with LP vault capital as the protocol liquidity engine.");
  console.log("- Decentralization: role-separated trader/LP/solver/keeper smoke, public scripts, readiness lens, 3-stable median settlement, and merge/redeem wiring.");
  console.log("");

  for (const result of report.results) {
    const label = result.status.toUpperCase().padEnd(4);
    const time = result.elapsedMs ? ` ${Math.round(result.elapsedMs / 100) / 10}s` : "";
    console.log(`${label} [${result.area}] ${result.name}${time}`);
    if (result.summary) {
      for (const line of result.summary.split("\n")) console.log(`     ${line}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const steps = buildSteps(args);
  const results = steps.map((step) => (step.status === "skip" ? step : runStep(step)));
  const report = summarize(results);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  if (report.status !== "pass") process.exit(1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
