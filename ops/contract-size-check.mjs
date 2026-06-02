#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "out");
const EIP_170_LIMIT = 24_576;

const PRODUCTION_CONTRACTS = new Set([
  "EthOptionsFactory",
  "EthLPVault",
  "EthLPVaultKeeper",
  "EthTokenAMM",
  "EthereumMainnetOracleConfig",
  "MedianStableTwapSettlementOracle",
  "MintBurnToken",
  "ProtocolHealthLens",
  "RollAuction",
  "RollSolver",
  "SeriesExposureVault",
  "SeriesExposureVaultKeeper",
  "UniswapV3TwapSettlementOracle",
]);

const SCRIPT_HELPERS = new Set([
  "DeployEthereumPilot",
  "DeployLocalMvp",
  "DeployLocalMvpManifest",
  "LocalMvpTopology",
]);

function usage() {
  return `Usage:
  node ops/contract-size-check.mjs [options]

Options:
  --skip-build   Reuse existing out/ artifacts instead of running forge build
  --json         Print machine-readable JSON`;
}

function parseArgs(argv) {
  const args = { skipBuild: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--skip-build") {
      args.skipBuild = true;
    } else if (arg === "--json") {
      args.json = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

function runBuild() {
  const result = spawnSync("forge", ["build"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
  });
  if (result.status !== 0) {
    throw new Error(`forge build failed:\n${(result.stdout || "") + (result.stderr || "")}`);
  }
}

function artifactFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...artifactFiles(full));
    if (entry.isFile() && entry.name.endsWith(".json")) files.push(full);
  }
  return files;
}

function bytecodeSize(artifact) {
  const object = artifact.deployedBytecode?.object || "";
  if (!object || object === "0x") return 0;
  return (object.replace(/^0x/, "").length / 2) | 0;
}

function readArtifacts() {
  if (!fs.existsSync(OUT_DIR)) throw new Error("Missing out/ artifacts. Run forge build first.");
  const byName = new Map();
  for (const file of artifactFiles(OUT_DIR)) {
    const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
    const name = artifact.contractName || path.basename(file, ".json");
    if (!name) continue;
    byName.set(name, { name, file: path.relative(ROOT, file), size: bytecodeSize(artifact) });
  }
  return byName;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.skipBuild) runBuild();

  const artifacts = readArtifacts();
  const checks = [];
  for (const name of PRODUCTION_CONTRACTS) {
    const artifact = artifacts.get(name);
    if (!artifact) {
      checks.push({ level: "fail", name, detail: "Missing production artifact." });
      continue;
    }
    checks.push({
      level: artifact.size <= EIP_170_LIMIT ? "pass" : "fail",
      name,
      detail: `${artifact.size} bytes deployed runtime, limit ${EIP_170_LIMIT}.`,
      file: artifact.file,
      size: artifact.size,
    });
  }

  const helperWarnings = [];
  for (const name of SCRIPT_HELPERS) {
    const artifact = artifacts.get(name);
    if (artifact && artifact.size > EIP_170_LIMIT) {
      helperWarnings.push({
        level: "warn",
        name,
        detail: `${artifact.size} bytes. Treat as script/test helper, not a production forge-create target.`,
        file: artifact.file,
        size: artifact.size,
      });
    }
  }

  const all = [...checks, ...helperWarnings];
  const counts = all.reduce(
    (acc, item) => {
      acc[item.level] += 1;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0 },
  );
  const status = counts.fail > 0 ? "fail" : counts.warn > 0 ? "warn" : "pass";

  if (args.json) {
    console.log(JSON.stringify({ status, limit: EIP_170_LIMIT, checks: all }, null, 2));
  } else {
    console.log(
      `Contract size check: ${status.toUpperCase()} (${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail)`,
    );
    for (const item of all) {
      console.log(`${item.level.toUpperCase()} [${item.name}] ${item.detail}`);
    }
  }

  if (counts.fail > 0) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
