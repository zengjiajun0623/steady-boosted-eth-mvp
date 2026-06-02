#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_REGISTRY_OUT = path.join("manifests", "ethereum-pilot-registry.txt");
const DEFAULT_MANIFEST_OUT = path.join("manifests", "ethereum-pilot.json");

function usage() {
  return `Usage:
  node ops/deploy-ethereum-pilot.mjs --rpc <MAINNET_RPC_URL> --private-key <KEY> [options]

Options:
  --rpc <url>                  Ethereum mainnet RPC URL (default: MAINNET_RPC_URL/RPC_URL)
  --private-key <key>          Deployer key (default: PRIVATE_KEY env)
  --registry-out <path>        Topology registry path (default: ${DEFAULT_REGISTRY_OUT})
  --out <path>                 Manifest output path (default: ${DEFAULT_MANIFEST_OUT})
  --mode <name>                Manifest mode label (default: pilot)
  --boosted-demand-eth <eth>   Committed Boosted/N demand for strict readiness
  --solver-float-eth <eth>     Committed solver float for strict readiness
  --skip-preflight             Skip mainnet oracle pool preflight
  --skip-readiness             Skip strict readiness after manifest export

Pilot config is read by the Solidity script from PILOT_* environment variables.
See deployment_mvp.md for the full list.

Example:
  PRIVATE_KEY=<KEY> MAINNET_RPC_URL=<RPC> node ops/deploy-ethereum-pilot.mjs \\
    --mode pilot \\
    --boosted-demand-eth 5000 \\
    --solver-float-eth 250`;
}

function parseArgs(argv) {
  const args = {
    rpc: process.env.MAINNET_RPC_URL || process.env.RPC_URL || "",
    privateKey: process.env.PRIVATE_KEY || "",
    registryOut: DEFAULT_REGISTRY_OUT,
    out: DEFAULT_MANIFEST_OUT,
    mode: "pilot",
    boostedDemandEth: "",
    solverFloatEth: "",
    skipPreflight: false,
    skipReadiness: false,
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
    } else if (arg === "--rpc") {
      args.rpc = next();
    } else if (arg === "--private-key") {
      args.privateKey = next();
    } else if (arg === "--registry-out") {
      args.registryOut = next();
    } else if (arg === "--out") {
      args.out = next();
    } else if (arg === "--mode") {
      args.mode = next();
    } else if (arg === "--boosted-demand-eth") {
      args.boostedDemandEth = next();
    } else if (arg === "--solver-float-eth") {
      args.solverFloatEth = next();
    } else if (arg === "--skip-preflight") {
      args.skipPreflight = true;
    } else if (arg === "--skip-readiness") {
      args.skipReadiness = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!args.rpc) throw new Error("Pass --rpc or set MAINNET_RPC_URL/RPC_URL.");
  if (!args.privateKey) throw new Error("Pass --private-key or set PRIVATE_KEY.");
  if (!args.skipReadiness && (!positiveEth(args.boostedDemandEth) || !positiveEth(args.solverFloatEth))) {
    throw new Error("Strict readiness requires positive --boosted-demand-eth and --solver-float-eth.");
  }
  return args;
}

function isAddress(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function positiveEth(value) {
  return Boolean(value) && /^\d+(\.\d+)?$/.test(value) && Number(value) > 0;
}

async function run(command, args, options = {}) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: path.resolve("."),
    maxBuffer: 40 * 1024 * 1024,
    timeout: options.timeoutMs || 180_000,
  });
  if (options.echo !== false) {
    if (stdout.trim()) process.stdout.write(stdout);
    if (stderr.trim()) process.stderr.write(stderr);
  }
  return stdout.trim();
}

async function deployTopology(args) {
  await fs.mkdir(path.dirname(args.registryOut), { recursive: true });
  await run("forge", [
    "script",
    "script/DeployEthereumPilotManifest.sol:DeployEthereumPilotManifest",
    "--sig",
    "runTo(string)",
    args.registryOut,
    "--rpc-url",
    args.rpc,
    "--broadcast",
    "--slow",
    "--private-key",
    args.privateKey,
  ], { timeoutMs: 300_000 });

  const topology = (await fs.readFile(args.registryOut, "utf8")).trim();
  if (!isAddress(topology)) throw new Error(`Deploy script wrote an invalid topology address: ${topology}`);
  return topology;
}

async function exportManifest(args, topology) {
  await run(process.execPath, [
    "ops/export-manifest.mjs",
    "--rpc",
    args.rpc,
    "--topology",
    topology,
    "--out",
    args.out,
    "--mode",
    args.mode,
  ]);
}

async function runReadiness(args) {
  const readinessArgs = [
    "ops/readiness-check.mjs",
    "--manifest",
    args.out,
    "--rpc",
    args.rpc,
    "--strict",
    "--require-median-oracle",
    "--capacity-strict",
    "--expect-chain-id",
    "0x1",
    "--boosted-demand-eth",
    args.boostedDemandEth,
    "--solver-float-eth",
    args.solverFloatEth,
  ];
  await run(process.execPath, readinessArgs, { timeoutMs: 180_000 });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.skipPreflight) {
    console.log("Checking mainnet oracle pool facts...");
    await run(process.execPath, ["ops/mainnet-oracle-preflight.mjs", "--rpc", args.rpc]);
  }

  console.log("Deploying Ethereum pilot components...");
  const topology = await deployTopology(args);

  console.log(`Exporting manifest from ${topology}...`);
  await exportManifest(args, topology);

  if (!args.skipReadiness) {
    console.log("Running strict readiness...");
    await runReadiness(args);
  }

  console.log("Ethereum pilot deployment output:");
  console.log(`Topology: ${topology}`);
  console.log(`Manifest: ${args.out}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
