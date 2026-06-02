#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_OUT = path.join("demo", "contract-manifest.json");
const SELECTORS = {
  core: "0xf2f4eb26",
  products: "0xc71e261f",
  wrapperKeepers: "0x122eed2d",
  inventoryMarkets: "0x4c10db1f",
  healthLens: "0xb336f6a4",
  series: "0xf12d870f",
};

function usage() {
  return `Usage:
  node ops/export-manifest.mjs --rpc <RPC_URL> --topology <TOPOLOGY_ADDRESS> [options]

Options:
  --topology <address>  Topology helper address
  --out <path>       Output manifest path (default: ${DEFAULT_OUT})
  --stdout           Print manifest JSON instead of writing a file
  --mode <name>      Manifest mode label (default: live)

Example:
  node ops/export-manifest.mjs --rpc http://127.0.0.1:8545 --topology 0x... --out demo/contract-manifest.json`;
}

function parseArgs(argv) {
  const args = {
    rpc: process.env.RPC_URL || "",
    topology: "",
    out: DEFAULT_OUT,
    stdout: false,
    mode: "live",
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
    } else if (arg === "--topology") {
      args.topology = next();
    } else if (arg === "--out") {
      args.out = next();
    } else if (arg === "--stdout") {
      args.stdout = true;
    } else if (arg === "--mode") {
      args.mode = next();
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return args;
}

function isAddress(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function cleanHex(hex) {
  return (hex || "0x").replace(/^0x/, "");
}

function decodeWord(hex, index = 0) {
  return cleanHex(hex).slice(index * 64, index * 64 + 64).padStart(64, "0");
}

function decodeAddress(hex, index = 0) {
  return `0x${decodeWord(hex, index).slice(24)}`;
}

function decodeBytes32(hex, index = 0) {
  return `0x${decodeWord(hex, index)}`;
}

async function rpcCall(rpcUrl, method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload.error) throw new Error(`${method}: ${payload.error.message || JSON.stringify(payload.error)}`);
  return payload.result;
}

async function ethCall(rpcUrl, to, data) {
  if (!isAddress(to)) throw new Error(`Invalid topology address: ${to}`);
  return rpcCall(rpcUrl, "eth_call", [{ to, data }, "latest"]);
}

async function readTopology(rpcUrl, topologyAddress) {
  const [core, products, keepers, inventoryMarkets, healthLens, series] = await Promise.all([
    ethCall(rpcUrl, topologyAddress, SELECTORS.core),
    ethCall(rpcUrl, topologyAddress, SELECTORS.products),
    ethCall(rpcUrl, topologyAddress, SELECTORS.wrapperKeepers),
    ethCall(rpcUrl, topologyAddress, SELECTORS.inventoryMarkets).catch(() => null),
    ethCall(rpcUrl, topologyAddress, SELECTORS.healthLens),
    ethCall(rpcUrl, topologyAddress, SELECTORS.series),
  ]);

  return {
    contracts: {
      factory: decodeAddress(core, 0),
      oracle: decodeAddress(core, 1),
      rollAuction: decodeAddress(core, 2),
      rollSolver: decodeAddress(core, 3),
      healthLens: decodeAddress(healthLens, 0),
      lpKeeper: decodeAddress(core, 4),
      lpVault: decodeAddress(core, 5),
      steadyKeeper: decodeAddress(keepers, 0),
      boostedKeeper: decodeAddress(keepers, 1),
      steadyVault: decodeAddress(products, 0),
      boostedVault: decodeAddress(products, 1),
      steadyMarket: decodeAddress(products, 2),
      boostedMarket: decodeAddress(products, 3),
    },
    series: {
      firstSeriesId: decodeBytes32(series, 0),
      secondSeriesId: decodeBytes32(series, 1),
      firstP: decodeAddress(series, 2),
      firstN: decodeAddress(series, 3),
      secondP: decodeAddress(series, 4),
      secondN: decodeAddress(series, 5),
      steadyShare: null,
      boostedShare: null,
    },
    inventoryMarkets: {
      firstP: inventoryMarkets ? decodeAddress(inventoryMarkets, 0) : null,
      firstN: inventoryMarkets ? decodeAddress(inventoryMarkets, 1) : null,
      secondP: inventoryMarkets ? decodeAddress(inventoryMarkets, 2) : null,
      secondN: inventoryMarkets ? decodeAddress(inventoryMarkets, 3) : null,
    },
  };
}

async function chainId(rpcUrl) {
  return rpcCall(rpcUrl, "eth_chainId", []);
}

function buildManifest({ mode, chainIdHex, topology }) {
  return {
    mode,
    chainId: chainIdHex,
    contracts: topology.contracts,
    series: topology.series,
    inventoryMarkets: topology.inventoryMarkets,
    auctions: {
      steady: {
        auctionId: null,
        newSeriesId: topology.series.secondSeriesId,
        fillMode: "mintAndFillWithCallback",
        slippageBps: 50,
        remainingEth: null,
        price: null,
        ui: {
          floorPrice: null,
          timeLeft: null,
        },
      },
      boosted: {
        auctionId: null,
        newSeriesId: topology.series.secondSeriesId,
        fillMode: "mintAndFillNWithCallback",
        slippageBps: 50,
        remainingEth: null,
        price: null,
        ui: {
          floorPrice: null,
          timeLeft: null,
        },
      },
    },
    notes: "Generated by ops/export-manifest.mjs from deployed topology getters.",
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.rpc || !isAddress(args.topology)) {
    console.error(usage());
    process.exit(1);
  }

  const [chainIdHex, topology] = await Promise.all([chainId(args.rpc), readTopology(args.rpc, args.topology)]);
  const manifest = buildManifest({ mode: args.mode, chainIdHex, topology });
  const json = `${JSON.stringify(manifest, null, 2)}\n`;

  if (args.stdout) {
    process.stdout.write(json);
    return;
  }

  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, json);
  console.log(`Wrote ${args.out}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
