#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_RPC = "http://127.0.0.1:8545";
const DEFAULT_REGISTRY_OUT = path.join("demo", "deployment-registry.txt");
const DEFAULT_MANIFEST_OUT = path.join("demo", "contract-manifest.json");
const DEFAULT_STEADY_SHARES = 1_000_000_000_000_000_000n;
const DEFAULT_BOOSTED_SHARES = 500_000_000_000_000_000n;
const DEFAULT_STEADY_MARKET_ETH = 1_200_000_000_000_000_000n;
const DEFAULT_BOOSTED_MARKET_ETH = 1_300_000_000_000_000_000n;

function usage() {
  return `Usage:
  node ops/deploy-local-demo.mjs [options]

Options:
  --rpc <url>                 RPC URL (default: ${DEFAULT_RPC})
  --private-key <key>         Deployer key (default: PRIVATE_KEY env)
  --registry-out <path>       Topology registry path (default: ${DEFAULT_REGISTRY_OUT})
  --out <path>                Manifest path (default: ${DEFAULT_MANIFEST_OUT})
  --mode <name>               Manifest mode label (default: local-live)
  --no-seed                   Skip market seeding
  --seed-recipient <address>  Recipient for AMM LP shares (default: deployer address)
  --steady-shares-wei <wei>   Steady shares to seed (default: 1 ETH)
  --boosted-shares-wei <wei>  Boosted shares to seed (default: 0.5 ETH)
  --steady-market-wei <wei>   ETH in Steady AMM seed (default: 1.2 ETH)
  --boosted-market-wei <wei>  ETH in Boosted AMM seed (default: 1.3 ETH)

Example:
  PRIVATE_KEY=<ANVIL_KEY> node ops/deploy-local-demo.mjs --rpc http://127.0.0.1:8545`;
}

function parseArgs(argv) {
  const args = {
    rpc: process.env.RPC_URL || DEFAULT_RPC,
    privateKey: process.env.PRIVATE_KEY || "",
    registryOut: DEFAULT_REGISTRY_OUT,
    out: DEFAULT_MANIFEST_OUT,
    mode: "local-live",
    seed: true,
    seedRecipient: "",
    steadySharesWei: DEFAULT_STEADY_SHARES,
    boostedSharesWei: DEFAULT_BOOSTED_SHARES,
    steadyMarketWei: DEFAULT_STEADY_MARKET_ETH,
    boostedMarketWei: DEFAULT_BOOSTED_MARKET_ETH,
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
    } else if (arg === "--no-seed") {
      args.seed = false;
    } else if (arg === "--seed-recipient") {
      args.seedRecipient = next();
    } else if (arg === "--steady-shares-wei") {
      args.steadySharesWei = BigInt(next());
    } else if (arg === "--boosted-shares-wei") {
      args.boostedSharesWei = BigInt(next());
    } else if (arg === "--steady-market-wei") {
      args.steadyMarketWei = BigInt(next());
    } else if (arg === "--boosted-market-wei") {
      args.boostedMarketWei = BigInt(next());
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!args.privateKey) throw new Error("Pass --private-key or set PRIVATE_KEY.");
  return args;
}

function isAddress(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

async function run(command, args, options = {}) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: path.resolve("."),
    maxBuffer: 20 * 1024 * 1024,
    timeout: options.timeoutMs || 120_000,
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
    "script/DeployLocalMvpManifest.sol:DeployLocalMvpManifest",
    "--sig",
    "runTo(string)",
    args.registryOut,
    "--rpc-url",
    args.rpc,
    "--broadcast",
    "--slow",
    "--private-key",
    args.privateKey,
  ]);

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

async function defaultRecipient(privateKey) {
  const address = await run("cast", ["wallet", "address", privateKey], { echo: false });
  if (!isAddress(address)) throw new Error(`Could not derive seed recipient from private key: ${address}`);
  return address;
}

async function seedMarkets(args, topology) {
  const recipient = args.seedRecipient || (await defaultRecipient(args.privateKey));
  if (!isAddress(recipient)) throw new Error(`Invalid seed recipient: ${recipient}`);

  const optionMintWei =
    args.steadySharesWei > args.boostedSharesWei ? args.steadySharesWei : args.boostedSharesWei;
  const valueWei = optionMintWei + args.steadyMarketWei + args.boostedMarketWei;

  await run("cast", [
    "send",
    topology,
    "seedMarkets(uint256,uint256,uint256,uint256,address)",
    args.steadySharesWei.toString(),
    args.boostedSharesWei.toString(),
    args.steadyMarketWei.toString(),
    args.boostedMarketWei.toString(),
    recipient,
    "--rpc-url",
    args.rpc,
    "--private-key",
    args.privateKey,
    "--value",
    valueWei.toString(),
    "--confirmations",
    "1",
    "--timeout",
    "60",
  ]);

  return recipient;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log("Deploying local MVP topology...");
  const topology = await deployTopology(args);

  console.log(`Exporting manifest from ${topology}...`);
  await exportManifest(args, topology);

  let seedRecipient = null;
  if (args.seed) {
    console.log("Seeding Steady/Boosted AMM markets...");
    seedRecipient = await seedMarkets(args, topology);
  }

  console.log("");
  console.log("Local demo ready.");
  console.log(`Topology: ${topology}`);
  console.log(`Registry: ${args.registryOut}`);
  console.log(`Manifest: ${args.out}`);
  if (seedRecipient) console.log(`Seed LP recipient: ${seedRecipient}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
