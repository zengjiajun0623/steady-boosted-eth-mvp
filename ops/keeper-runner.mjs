#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DECISIONS_SCRIPT = path.join(SCRIPT_DIR, "keeper-decisions.mjs");

const ACTION_ALIASES = {
  all: ["*"],
  solver: ["solver-bid"],
  settlement: ["settle-series"],
  wrapper: ["wrapper-start-roll", "wrapper-finalize-roll", "wrapper-reset-roll", "wrapper-cancel-roll"],
  lp: ["lp-backstop-bid", "lp-inventory-merge", "lp-inventory-redeem", "lp-inventory-sell", "lp-inventory-close"],
  vault: ["lp-backstop-bid", "lp-inventory-merge", "lp-inventory-redeem", "lp-inventory-sell", "lp-inventory-close"],
  inventory: ["lp-inventory-merge", "lp-inventory-redeem", "lp-inventory-sell", "lp-inventory-close"],
};

function usage() {
  return `Usage:
  node ops/keeper-runner.mjs [runner options] --rpc <RPC_URL> [decision options]

Runner options:
  --execute                 Send ready transactions. Default is dry-run.
  --action <type|alias>      Action type to run. Repeatable or comma-separated.
                             Aliases: solver, settlement, wrapper, lp, vault, inventory, all.
  --max-actions <n>          Max ready actions per pass. Default: 1 in execute mode, all in dry-run.
  --interval <seconds>       Repeat forever with this delay. Default: run once.
  --private-key-env <name>   Override all role-specific key env vars.

Action key env vars:
  Solver actions prefer SOLVER_PRIVATE_KEY, then PRIVATE_KEY.
  Settlement actions prefer SETTLEMENT_RUNNER_PRIVATE_KEY, then PRIVATE_KEY.
  Wrapper actions prefer WRAPPER_KEEPER_PRIVATE_KEY, then PRIVATE_KEY.
  LP backstop actions prefer LP_KEEPER_PRIVATE_KEY, then PRIVATE_KEY.
  LP inventory cleanup prefers INVENTORY_KEEPER_PRIVATE_KEY, LP_KEEPER_PRIVATE_KEY, then PRIVATE_KEY.

Decision options are passed to keeper-decisions.mjs, for example:
  --manifest <path>
  --max-price-wad <wad>
  --max-fill-eth <eth>
  --max-inventory-sell-eth <eth>
  --inventory-slippage-bps <bps>
  --solver-model <path>
  --recipient <address>
  --strategy-no-solver-launch
  --strategy-boosted-demand-eth <eth>
  --strategy-solver-float-eth <eth>
  --no-strategy-gate

Examples:
  node ops/keeper-runner.mjs --rpc http://127.0.0.1:8545 --action wrapper
  SETTLEMENT_RUNNER_PRIVATE_KEY=0x... node ops/keeper-runner.mjs --execute --action settlement --rpc $RPC_URL
  SOLVER_PRIVATE_KEY=0x... node ops/keeper-runner.mjs --execute --action solver --rpc $RPC_URL --recipient 0x... --max-price-wad 999000000000000000 --solver-model ops/solver-model-spread.mjs
  node ops/keeper-runner.mjs --execute --action lp-inventory-sell --interval 30 --rpc $RPC_URL`;
}

function parseArgs(argv) {
  const args = {
    execute: false,
    actions: [],
    maxActions: null,
    intervalSeconds: 0,
    privateKeyEnv: null,
    decisionArgs: [],
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
    } else if (arg === "--execute") {
      args.execute = true;
    } else if (arg === "--action") {
      args.actions.push(...expandActions(next()));
    } else if (arg === "--max-actions") {
      args.maxActions = Number(next());
      if (!Number.isInteger(args.maxActions) || args.maxActions < 1) {
        throw new Error("--max-actions must be a positive integer");
      }
    } else if (arg === "--interval") {
      args.intervalSeconds = Number(next());
      if (!Number.isFinite(args.intervalSeconds) || args.intervalSeconds < 0) {
        throw new Error("--interval must be a non-negative number");
      }
    } else if (arg === "--private-key-env") {
      args.privateKeyEnv = next();
    } else {
      args.decisionArgs.push(arg);
    }
  }

  args.actions = [...new Set(args.actions)];
  return args;
}

export function expandActions(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .flatMap((item) => ACTION_ALIASES[item] || [item]);
}

function selectedAction(type, selected) {
  if (!selected.length) return true;
  return selected.includes("*") || selected.includes(type);
}

export function actionRole(type) {
  if (type === "solver-bid") return "solver";
  if (type === "settle-series") return "settlement";
  if (type.startsWith("wrapper-")) return "wrapper";
  if (type === "lp-backstop-bid") return "lp";
  if (type.startsWith("lp-inventory-")) return "inventory";
  return "default";
}

export function privateKeyEnvCandidates(action, runnerArgs) {
  if (runnerArgs.privateKeyEnv) return [runnerArgs.privateKeyEnv];

  const byRole = {
    solver: ["SOLVER_PRIVATE_KEY", "PRIVATE_KEY"],
    settlement: ["SETTLEMENT_RUNNER_PRIVATE_KEY", "PRIVATE_KEY"],
    wrapper: ["WRAPPER_KEEPER_PRIVATE_KEY", "PRIVATE_KEY"],
    lp: ["LP_KEEPER_PRIVATE_KEY", "PRIVATE_KEY"],
    inventory: ["INVENTORY_KEEPER_PRIVATE_KEY", "LP_KEEPER_PRIVATE_KEY", "PRIVATE_KEY"],
    default: ["PRIVATE_KEY"],
  };
  return byRole[actionRole(action.type)] || byRole.default;
}

export function privateKeyForAction(action, runnerArgs) {
  const candidates = privateKeyEnvCandidates(action, runnerArgs);
  const envName = candidates.find((name) => process.env[name]);
  if (!envName) {
    throw new Error(`Action ${action.type} requires one of these env vars: ${candidates.join(", ")}`);
  }
  return { envName, privateKey: process.env[envName] };
}

export function runnerCommand(action, runnerArgs) {
  if (!action.command) return "";
  const envName = privateKeyEnvCandidates(action, runnerArgs)[0] || "PRIVATE_KEY";
  return action.command.replace("--private-key $PRIVATE_KEY", `--private-key $${envName}`);
}

function rpcFromDecisionArgs(decisionArgs) {
  let rpc = process.env.RPC_URL || "";
  for (let i = 0; i < decisionArgs.length; i += 1) {
    if (decisionArgs[i] === "--rpc" && i + 1 < decisionArgs.length) {
      rpc = decisionArgs[i + 1];
      i += 1;
    }
  }
  return rpc;
}

function runDecisionScript(decisionArgs) {
  const finalArgs = decisionArgs.includes("--json") ? decisionArgs : [...decisionArgs, "--json"];
  const result = spawnSync(process.execPath, [DECISIONS_SCRIPT, ...finalArgs], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`keeper-decisions failed with exit code ${result.status ?? "unknown"}`);
  }

  try {
    return JSON.parse(result.stdout || "{}");
  } catch (error) {
    throw new Error(`keeper-decisions did not return JSON: ${error.message}`);
  }
}

function readyActions(decision, runnerArgs) {
  const actions = Array.isArray(decision.actions) ? decision.actions : [];
  const selected = actions.filter((action) => (
    action.ready === true &&
    action.tx &&
    selectedAction(action.type, runnerArgs.actions)
  ));
  const limit = runnerArgs.maxActions || (runnerArgs.execute ? 1 : selected.length);
  return selected.slice(0, limit);
}

function assertExecutableConfig(runnerArgs, rpc) {
  if (!runnerArgs.execute) return;
  if (!runnerArgs.actions.length) {
    throw new Error("--execute requires at least one --action so the bot scope is explicit");
  }
  if (!rpc) {
    throw new Error("--execute requires --rpc or RPC_URL");
  }
}

function assertNoPlaceholders(action) {
  const values = [
    action.tx?.contract,
    action.tx?.signature,
    action.tx?.value,
    ...(action.tx?.args || []),
  ].filter((value) => value !== null && value !== undefined);

  for (const value of values) {
    if (String(value).includes("$") || String(value).includes("<") || String(value).includes(">")) {
      throw new Error(`Action ${action.type} still has a placeholder value; pass concrete decision options such as --recipient`);
    }
  }
}

function castArgs(action, rpc, privateKey) {
  const tx = action.tx;
  const args = ["send", tx.contract, tx.signature, ...tx.args, "--rpc-url", rpc, "--private-key", privateKey];
  if (tx.value !== null && tx.value !== undefined) args.push("--value", tx.value);
  return args;
}

function executeAction(action, rpc, runnerArgs) {
  assertNoPlaceholders(action);
  const { envName, privateKey } = privateKeyForAction(action, runnerArgs);
  console.log(`[execute] ${action.type} ${action.product || ""}`.trim());
  console.log(`Key env: ${envName}`);
  if (action.reason) console.log(`Reason: ${action.reason}`);
  if (action.condition) console.log(`Condition: ${action.condition}`);

  const result = spawnSync("cast", castArgs(action, rpc, privateKey), { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`cast send failed for ${action.type} with exit code ${result.status ?? "unknown"}`);
  }
}

function printDryRun(decision, actions, runnerArgs) {
  console.log(`Decision status: ${decision.status || "unknown"}`);
  if (decision.status !== "ok") {
    console.log(JSON.stringify(decision, null, 2));
    return;
  }

  if (!actions.length) {
    console.log("No ready actions matched the selected filters.");
    return;
  }

  for (const action of actions) {
    console.log("");
    console.log(`[ready] ${action.type} ${action.product || ""}`.trim());
    if (action.reason) console.log(`Reason: ${action.reason}`);
    if (action.condition) console.log(`Condition: ${action.condition}`);
    const command = runnerCommand(action, runnerArgs);
    if (command) console.log(command);
  }
  console.log("");
  console.log("Dry-run only. Add --execute after choosing an explicit --action role.");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const runnerArgs = parseArgs(process.argv.slice(2));
  const rpc = rpcFromDecisionArgs(runnerArgs.decisionArgs);
  assertExecutableConfig(runnerArgs, rpc);

  do {
    const decision = runDecisionScript(runnerArgs.decisionArgs);
    const actions = decision.status === "ok" ? readyActions(decision, runnerArgs) : [];

    if (!runnerArgs.execute) {
      printDryRun(decision, actions, runnerArgs);
    } else {
      for (const action of actions) {
        executeAction(action, rpc, runnerArgs);
      }
      if (!actions.length) console.log("No ready executable actions matched this pass.");
    }

    if (runnerArgs.intervalSeconds === 0) break;
    await delay(runnerArgs.intervalSeconds * 1000);
  } while (true);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
