#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_MANIFEST = path.join("demo", "contract-manifest.json");
const WAD = 10n ** 18n;
const BPS = 10_000n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const SELECTORS = {
  maxRollPriceWad: "0x70ae0b1f",
};

const AUCTION_FILLED_TOPIC =
  "0xb6743bc6c9e9870a1ab4dcc547e5a3e32518a025a7612368f874dc0a49f87971";

function usage() {
  return `Usage:
  node ops/solver-improvement-report.mjs --rpc <RPC_URL> [options]

Options:
  --manifest <path>        Manifest path (default: ${DEFAULT_MANIFEST})
  --from-block <n|hex>     First block to scan (default: 0)
  --to-block <n|hex|latest>
                           Last block to scan (default: latest)
  --auction-id <id>        Restrict report to one auction id
  --vault-price-wad <wad>  Baseline backstop price. Defaults to lpVault.maxRollPriceWad()
  --require-external-fill  Exit nonzero if no external solver fill is observed
  --json                   Print machine-readable JSON

Examples:
  node ops/solver-improvement-report.mjs --rpc http://127.0.0.1:8545
  node ops/solver-improvement-report.mjs --rpc $RPC_URL --auction-id 7 --require-external-fill`;
}

function parseArgs(argv) {
  const args = {
    manifest: DEFAULT_MANIFEST,
    rpc: process.env.RPC_URL || "",
    fromBlock: "0",
    toBlock: "latest",
    auctionId: null,
    vaultPriceWad: null,
    requireExternalFill: false,
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
    } else if (arg === "--from-block") {
      args.fromBlock = next();
    } else if (arg === "--to-block") {
      args.toBlock = next();
    } else if (arg === "--auction-id") {
      args.auctionId = parseUint(next(), arg);
    } else if (arg === "--vault-price-wad") {
      args.vaultPriceWad = parseUint(next(), arg);
    } else if (arg === "--require-external-fill") {
      args.requireExternalFill = true;
    } else if (arg === "--json") {
      args.json = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!args.rpc) throw new Error("Pass --rpc or set RPC_URL.");
  return args;
}

function parseUint(value, name) {
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be a non-negative integer`);
  return BigInt(text);
}

function isAddress(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value) && value.toLowerCase() !== ZERO_ADDRESS;
}

function sameAddress(a, b) {
  return isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
}

function cleanHex(hex) {
  return (hex || "0x").replace(/^0x/, "");
}

function word(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function topicWord(value) {
  return `0x${word(value)}`;
}

function blockTag(value) {
  if (value === "latest" || value === "earliest" || value === "pending") return value;
  if (/^0x[0-9a-fA-F]+$/.test(value)) return value.toLowerCase();
  if (/^\d+$/.test(value)) return `0x${BigInt(value).toString(16)}`;
  throw new Error(`Invalid block tag: ${value}`);
}

function decodeWord(hex, index = 0) {
  return cleanHex(hex).slice(index * 64, index * 64 + 64).padStart(64, "0");
}

function decodeUint(hex, index = 0) {
  return BigInt(`0x${decodeWord(hex, index)}`);
}

function decodeAddressTopic(topic) {
  return `0x${cleanHex(topic).slice(24)}`;
}

function jsonSafe(value) {
  return JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item), 2);
}

async function rpcCall(rpcUrl, method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`${method}: ${payload.error.message || JSON.stringify(payload.error)}`);
  return payload.result;
}

async function ethCall(rpcUrl, to, data) {
  return rpcCall(rpcUrl, "eth_call", [{ to, data }, "latest"]);
}

async function loadManifest(manifestPath) {
  return JSON.parse(await fs.readFile(manifestPath, "utf8"));
}

async function baselinePriceWad(rpcUrl, manifest, explicitPrice) {
  if (explicitPrice !== null) return explicitPrice;
  const lpVault = manifest.contracts?.lpVault;
  if (!isAddress(lpVault)) throw new Error("Manifest is missing contracts.lpVault; pass --vault-price-wad.");
  return decodeUint(await ethCall(rpcUrl, lpVault, SELECTORS.maxRollPriceWad));
}

async function readFillLogs(rpcUrl, manifest, args) {
  const rollAuction = manifest.contracts?.rollAuction;
  if (!isAddress(rollAuction)) throw new Error("Manifest is missing contracts.rollAuction.");

  const topics = [AUCTION_FILLED_TOPIC];
  if (args.auctionId !== null) topics.push(topicWord(args.auctionId));

  const logs = await rpcCall(rpcUrl, "eth_getLogs", [{
    address: rollAuction,
    fromBlock: blockTag(args.fromBlock),
    toBlock: blockTag(args.toBlock),
    topics,
  }]);

  return logs.map(decodeFillLog);
}

function decodeFillLog(log) {
  return {
    blockNumber: BigInt(log.blockNumber),
    transactionHash: log.transactionHash,
    auctionId: BigInt(log.topics[1]),
    taker: decodeAddressTopic(log.topics[2]),
    recipient: decodeAddressTopic(log.topics[3]),
    sellAmount: decodeUint(log.data, 0),
    buyAmount: decodeUint(log.data, 1),
    priceWad: decodeUint(log.data, 2),
  };
}

function classifyFill(fill, manifest) {
  const lpVault = manifest.contracts?.lpVault;
  const rollSolver = manifest.contracts?.rollSolver;
  if (sameAddress(fill.taker, lpVault) || sameAddress(fill.recipient, lpVault)) return "lp-vault";
  if (sameAddress(fill.taker, rollSolver) || sameAddress(fill.recipient, rollSolver)) return "roll-solver";
  return "external-direct";
}

function emptyTotals() {
  return {
    fillCount: 0,
    sellAmount: 0n,
    buyAmount: 0n,
    baselineBuyAmount: 0n,
    savedBuyAmount: 0n,
  };
}

function addFill(totals, fill, baselinePrice) {
  totals.fillCount += 1;
  totals.sellAmount += fill.sellAmount;
  totals.buyAmount += fill.buyAmount;
  const baselineBuy = mulDivUp(fill.sellAmount, baselinePrice, WAD);
  totals.baselineBuyAmount += baselineBuy;
  if (baselineBuy > fill.buyAmount) totals.savedBuyAmount += baselineBuy - fill.buyAmount;
}

function buildReport(manifest, fills, baselinePrice) {
  const totals = {
    all: emptyTotals(),
    externalSolver: emptyTotals(),
    rollSolver: emptyTotals(),
    externalDirect: emptyTotals(),
    lpVault: emptyTotals(),
  };
  const decodedFills = fills.map((fill) => {
    const category = classifyFill(fill, manifest);
    addFill(totals.all, fill, baselinePrice);
    if (category === "lp-vault") {
      addFill(totals.lpVault, fill, baselinePrice);
    } else {
      addFill(totals.externalSolver, fill, baselinePrice);
      if (category === "roll-solver") addFill(totals.rollSolver, fill, baselinePrice);
      if (category === "external-direct") addFill(totals.externalDirect, fill, baselinePrice);
    }
    return { ...fill, category };
  });

  return {
    status: "pass",
    baseline: {
      vaultPriceWad: baselinePrice,
      vaultPrice: wadText(baselinePrice),
    },
    totals: addDerivedTotals(totals),
    fills: decodedFills,
  };
}

function addDerivedTotals(totals) {
  const withDerived = {};
  for (const [key, value] of Object.entries(totals)) {
    withDerived[key] = {
      ...value,
      averagePriceWad: value.sellAmount === 0n ? 0n : (value.buyAmount * WAD) / value.sellAmount,
      fillShareBps: totals.all.sellAmount === 0n ? 0n : (value.sellAmount * BPS) / totals.all.sellAmount,
    };
  }
  return withDerived;
}

function mulDivUp(x, y, denominator) {
  return (x * y + denominator - 1n) / denominator;
}

function weiToEthText(value) {
  const sign = value < 0n ? "-" : "";
  const raw = value < 0n ? -value : value;
  const whole = raw / WAD;
  const fraction = raw % WAD;
  const fractionText = fraction.toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
  return `${sign}${whole.toString()}${fractionText ? `.${fractionText}` : ""} ETH`;
}

function wadText(value) {
  return `${weiToEthText(value).replace(/ ETH$/, "")}x`;
}

function percentText(fillShareBps) {
  const whole = fillShareBps / 100n;
  const frac = (fillShareBps % 100n).toString().padStart(2, "0");
  return `${whole.toString()}.${frac}%`;
}

function printReport(report) {
  const solver = report.totals.externalSolver;
  const lp = report.totals.lpVault;
  const all = report.totals.all;
  console.log(`Solver improvement report: ${report.status.toUpperCase()}`);
  console.log(`Baseline vault price: ${report.baseline.vaultPrice}`);
  console.log(`Total filled: ${amountText(all.sellAmount)} token units across ${all.fillCount} fill(s)`);
  console.log(
    `External solver fill: ${amountText(solver.sellAmount)} token units (${percentText(solver.fillShareBps)}), saved ${amountText(solver.savedBuyAmount)} buy-token units versus baseline`,
  );
  console.log(`ETH LP vault fill: ${amountText(lp.sellAmount)} token units (${percentText(lp.fillShareBps)})`);
}

function amountText(value) {
  return weiToEthText(value).replace(/ ETH$/, "");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = await loadManifest(args.manifest);
  const baseline = await baselinePriceWad(args.rpc, manifest, args.vaultPriceWad);
  const fills = await readFillLogs(args.rpc, manifest, args);
  const report = buildReport(manifest, fills, baseline);

  if (args.requireExternalFill && report.totals.externalSolver.sellAmount === 0n) {
    report.status = "fail";
    report.error = "No external solver fill observed.";
  }

  if (args.json) {
    console.log(jsonSafe(report));
  } else {
    printReport(report);
    if (report.status !== "pass") console.log(`FAIL ${report.error}`);
  }

  if (report.status !== "pass") process.exit(1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
