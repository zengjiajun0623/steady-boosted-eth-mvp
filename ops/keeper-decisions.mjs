#!/usr/bin/env node

import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const DEFAULT_MANIFEST = path.join("demo", "contract-manifest.json");
const WAD = 10n ** 18n;

const SELECTORS = {
  activeAuctionCount: "0x72e2867d",
  activeAuctionIdAt: "0xb3588a17",
  activeAuctionIdBySellerAt: "0x38750e9a",
  maxActiveAuctions: "0x1cda41bd",
  maxActiveAuctionsPerSeller: "0xda86c158",
  activeAuctionCountBySeller: "0x9f4fd695",
  auctionStopped: "0x75f12b21",
  minSellAmount: "0xfa29141b",
  minStaleResetDelay: "0xd7286b7b",
  minStaleResetPriceDropBps: "0x046431d8",
  ammToken: "0xfc0c546a",
  activeStrategyEth: "0x3271f123",
  auctions: "0x571a26a0",
  balanceOf: "0x70a08231",
  factorySeries: "0xf5de118e",
  keeperCurrentSeriesId: "0xc9777451",
  keeperPendingSeriesId: "0xe2f6f51a",
  keeperMaxRollSellAmount: "0x7312fcea",
  healthWrapper: "0x254fe68f",
  healthAuction: "0x71ea82c9",
  inventorySeries: "0x8788f42b",
  inventorySeriesLength: "0x99b97012",
  maxActiveStrategyEth: "0x7442e57e",
  maxAuctionPriceDropBps: "0x1e51dda4",
  maxEthPerRoll: "0x7bcde30b",
  maxRollPriceWad: "0x70ae0b1f",
  minInventorySalePriceWad: "0x53127954",
  minBackstopDelay: "0x101cbba4",
  minAuctionTimeLeft: "0xdade311a",
  quoteSellToken: "0x80870de0",
};

const WRAPPER_DEFAULTS = {
  steady: {
    label: "Steady ETH",
    keeperKey: "steadyKeeper",
    vaultKey: "steadyVault",
    firstTokenKey: "firstP",
    secondTokenKey: "secondP",
    startPriceWad: 1_000_000_000_000_000_000n,
    floorPriceWad: 999_000_000_000_000_000n,
    fillMode: "mintAndFillWithCallback",
    lpMethod: "fillSteadyRoll",
    solverMethod: "mintAndFillWithCallback",
  },
  boosted: {
    label: "Boosted ETH",
    keeperKey: "boostedKeeper",
    vaultKey: "boostedVault",
    firstTokenKey: "firstN",
    secondTokenKey: "secondN",
    startPriceWad: 1_000_000_000_000_000_000n,
    floorPriceWad: 999_000_000_000_000_000n,
    fillMode: "mintAndFillNWithCallback",
    lpMethod: "fillBoostedRoll",
    solverMethod: "mintAndFillNWithCallback",
  },
};

function usage() {
  return `Usage:
  node ops/keeper-decisions.mjs --rpc <RPC_URL> [options]

Options:
  --manifest <path>          Manifest path (default: ${DEFAULT_MANIFEST})
  --json                     Print machine-readable JSON
  --max-price-wad <wad>      Solver/vault bid ceiling (default: 1.0000 WAD)
  --max-fill-eth <eth>       Max auction size to suggest per fill (default: full remaining)
  --max-inventory-sell-eth <eth>
                              Max LP vault inventory cleanup per suggestion
  --inventory-slippage-bps <bps>
                              Min ETH out buffer for LP inventory AMM sells (default: 50)
  --start-price-wad <wad>    Wrapper start-roll price (default: per product)
  --floor-price-wad <wad>    Wrapper floor price (default: per product)
  --duration <seconds>       Wrapper roll duration (default: 86400)
  --recipient <address>      Recipient placeholder for solver commands (default: $RECIPIENT)
  --solver-model <path>      Optional executable/JS model for solver bid decisions

Examples:
  node ops/keeper-decisions.mjs --rpc http://127.0.0.1:8545
  node ops/keeper-decisions.mjs --rpc $RPC_URL --max-price-wad 999000000000000000 --json
  node ops/keeper-decisions.mjs --rpc $RPC_URL --solver-model ops/solver-model-spread.mjs --json`;
}

function parseArgs(argv) {
  const args = {
    manifest: DEFAULT_MANIFEST,
    rpc: process.env.RPC_URL || "",
    json: false,
    maxPriceWad: WAD,
    maxFillWei: null,
    maxInventorySellWei: null,
    inventorySlippageBps: 50,
    startPriceWad: null,
    floorPriceWad: null,
    duration: 86_400n,
    recipient: "$RECIPIENT",
    solverModel: null,
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
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--max-price-wad") {
      args.maxPriceWad = BigInt(next());
    } else if (arg === "--max-fill-eth") {
      args.maxFillWei = ethToWei(next());
    } else if (arg === "--max-inventory-sell-eth") {
      args.maxInventorySellWei = ethToWei(next());
    } else if (arg === "--inventory-slippage-bps") {
      args.inventorySlippageBps = Number(next());
      if (!Number.isInteger(args.inventorySlippageBps) || args.inventorySlippageBps < 0 || args.inventorySlippageBps > 10_000) {
        throw new Error("--inventory-slippage-bps must be an integer from 0 to 10000");
      }
    } else if (arg === "--start-price-wad") {
      args.startPriceWad = BigInt(next());
    } else if (arg === "--floor-price-wad") {
      args.floorPriceWad = BigInt(next());
    } else if (arg === "--duration") {
      args.duration = BigInt(next());
    } else if (arg === "--recipient") {
      args.recipient = next();
    } else if (arg === "--solver-model") {
      args.solverModel = next();
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return args;
}

function isAddress(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isBytes32(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value);
}

function sameAddress(a, b) {
  return isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
}

function word(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function addressWord(address) {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function bytes32Word(value) {
  return value.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function encodeUint(selector, value) {
  return `${selector}${word(value)}`;
}

function encodeAddress(selector, address) {
  return `${selector}${addressWord(address)}`;
}

function encodeAuctionHealth(auction, auctionId) {
  return `${SELECTORS.healthAuction}${addressWord(auction)}${word(auctionId)}`;
}

function cleanHex(hex) {
  return (hex || "0x").replace(/^0x/, "");
}

function decodeWord(hex, index = 0) {
  return cleanHex(hex).slice(index * 64, index * 64 + 64).padStart(64, "0");
}

function decodeUint(hex, index = 0) {
  return BigInt(`0x${decodeWord(hex, index)}`);
}

function decodeAddress(hex, index = 0) {
  return `0x${decodeWord(hex, index).slice(24)}`;
}

function decodeBool(hex, index = 0) {
  return decodeUint(hex, index) !== 0n;
}

function decodeBytes32(hex, index = 0) {
  return `0x${decodeWord(hex, index)}`;
}

function ethToWei(value) {
  const text = String(value);
  const [whole, fraction = ""] = text.split(".");
  const padded = `${fraction}000000000000000000`.slice(0, 18);
  return BigInt(whole || "0") * WAD + BigInt(padded);
}

function weiToEthText(value) {
  const sign = value < 0n ? "-" : "";
  const raw = value < 0n ? -value : value;
  const whole = raw / WAD;
  const fraction = raw % WAD;
  const fractionText = fraction.toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
  return `${sign}${whole.toString()}${fractionText ? `.${fractionText}` : ""} ETH`;
}

function mulDivUp(x, y, denominator) {
  return (x * y + denominator - 1n) / denominator;
}

function priceDropBps(startPriceWad, currentPriceWad) {
  if (currentPriceWad >= startPriceWad || startPriceWad === 0n) return 0n;
  return ((startPriceWad - currentPriceWad) * 10_000n) / startPriceWad;
}

function jsonSafe(value) {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

function parseOptionalUint(value, field) {
  if (value === null || value === undefined || value === "") return null;
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch {
    throw new Error(`Solver model returned invalid ${field}; expected a non-negative integer string`);
  }
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
  if (!isAddress(to)) throw new Error(`Invalid contract address: ${to}`);
  return rpcCall(rpcUrl, "eth_call", [{ to, data }, "latest"]);
}

async function latestBlockTimestamp(rpcUrl) {
  const block = await rpcCall(rpcUrl, "eth_getBlockByNumber", ["latest", false]);
  return BigInt(block.timestamp);
}

async function readManifest(manifestPath) {
  const raw = await fs.readFile(manifestPath, "utf8");
  return JSON.parse(raw);
}

function missingManifestKeys(manifest) {
  const contracts = manifest.contracts || {};
  const series = manifest.series || {};
  const required = [
    ["contracts.factory", contracts.factory],
    ["contracts.rollAuction", contracts.rollAuction],
    ["contracts.rollSolver", contracts.rollSolver],
    ["contracts.lpKeeper", contracts.lpKeeper],
    ["contracts.steadyKeeper", contracts.steadyKeeper],
    ["contracts.boostedKeeper", contracts.boostedKeeper],
    ["series.firstSeriesId", series.firstSeriesId],
    ["series.secondSeriesId", series.secondSeriesId],
    ["series.firstP", series.firstP],
    ["series.firstN", series.firstN],
    ["series.secondP", series.secondP],
    ["series.secondN", series.secondN],
  ];
  return required.filter(([, value]) => !(isAddress(value) || isBytes32(value))).map(([key]) => key);
}

async function readActiveAuctions(rpcUrl, rollAuction) {
  const count = Number(decodeUint(await ethCall(rpcUrl, rollAuction, SELECTORS.activeAuctionCount)));
  const now = await latestBlockTimestamp(rpcUrl);
  const auctions = [];

  for (let index = 0; index < count; index += 1) {
    const auctionId = decodeUint(await ethCall(rpcUrl, rollAuction, encodeUint(SELECTORS.activeAuctionIdAt, BigInt(index))));
    auctions.push(await readAuctionById(rpcUrl, rollAuction, auctionId, now));
  }

  return auctions;
}

async function readAuctionById(rpcUrl, rollAuction, auctionId, now) {
  const raw = await ethCall(rpcUrl, rollAuction, encodeUint(SELECTORS.auctions, auctionId));
  const startPriceWad = decodeUint(raw, 6);
  const endPriceWad = decodeUint(raw, 7);
  const startTime = decodeUint(raw, 8);
  const duration = decodeUint(raw, 9);
  const elapsed = now > startTime ? now - startTime : 0n;
  const currentPriceWad =
    elapsed >= duration ? endPriceWad : startPriceWad - ((startPriceWad - endPriceWad) * elapsed) / duration;

  return {
    auctionId,
    seller: decodeAddress(raw, 0),
    beneficiary: decodeAddress(raw, 1),
    sellToken: decodeAddress(raw, 2),
    buyToken: decodeAddress(raw, 3),
    remainingSellAmount: decodeUint(raw, 4),
    buyTokenRaised: decodeUint(raw, 5),
    startPriceWad,
    endPriceWad,
    currentPriceWad,
    startTime,
    duration,
    elapsed,
    timeLeft: elapsed >= duration ? 0n : duration - elapsed,
    cancelled: decodeBool(raw, 10),
  };
}

async function readActiveAuctionsBySellers(rpcUrl, rollAuction, sellers) {
  const uniqueSellers = [...new Set(sellers.filter(isAddress).map((seller) => seller.toLowerCase()))];
  if (!uniqueSellers.length) return [];

  const now = await latestBlockTimestamp(rpcUrl);
  const auctions = [];

  for (const seller of uniqueSellers) {
    const count = Number(
      decodeUint(await ethCall(rpcUrl, rollAuction, `${SELECTORS.activeAuctionCountBySeller}${addressWord(seller)}`)),
    );
    for (let index = 0; index < count; index += 1) {
      const data = `${SELECTORS.activeAuctionIdBySellerAt}${addressWord(seller)}${word(BigInt(index))}`;
      const auctionId = decodeUint(await ethCall(rpcUrl, rollAuction, data));
      auctions.push(await readAuctionById(rpcUrl, rollAuction, auctionId, now));
    }
  }

  return auctions;
}

function mergeAuctions(...auctionSets) {
  const merged = new Map();
  for (const auction of auctionSets.flat()) {
    if (!auction) continue;
    merged.set(auction.auctionId.toString(), auction);
  }
  return [...merged.values()];
}

async function readLpVaultPolicy(rpcUrl, lpVault) {
  if (!isAddress(lpVault)) return null;

  const [
    maxRollPriceWadRaw,
    maxEthPerRollRaw,
    maxActiveStrategyEthRaw,
    activeStrategyEthRaw,
    minBackstopDelayRaw,
    minAuctionTimeLeftRaw,
    maxAuctionPriceDropRaw,
    minInventorySalePriceRaw,
  ] = await Promise.all([
    ethCall(rpcUrl, lpVault, SELECTORS.maxRollPriceWad),
    ethCall(rpcUrl, lpVault, SELECTORS.maxEthPerRoll),
    ethCall(rpcUrl, lpVault, SELECTORS.maxActiveStrategyEth),
    ethCall(rpcUrl, lpVault, SELECTORS.activeStrategyEth),
    ethCall(rpcUrl, lpVault, SELECTORS.minBackstopDelay),
    ethCall(rpcUrl, lpVault, SELECTORS.minAuctionTimeLeft),
    ethCall(rpcUrl, lpVault, SELECTORS.maxAuctionPriceDropBps),
    ethCall(rpcUrl, lpVault, SELECTORS.minInventorySalePriceWad).catch(() => "0x"),
  ]);

  return {
    maxRollPriceWad: decodeUint(maxRollPriceWadRaw),
    maxEthPerRoll: decodeUint(maxEthPerRollRaw),
    maxActiveStrategyEth: decodeUint(maxActiveStrategyEthRaw),
    activeStrategyEth: decodeUint(activeStrategyEthRaw),
    minBackstopDelay: decodeUint(minBackstopDelayRaw),
    minAuctionTimeLeft: decodeUint(minAuctionTimeLeftRaw),
    maxAuctionPriceDropBps: decodeUint(maxAuctionPriceDropRaw),
    minInventorySalePriceWad: decodeUint(minInventorySalePriceRaw),
  };
}

async function readWrapperState(rpcUrl, manifest, key) {
  const config = WRAPPER_DEFAULTS[key];
  const keeper = manifest.contracts?.[config.keeperKey];
  const vault = manifest.contracts?.[config.vaultKey];
  const healthLens = manifest.contracts?.healthLens;

  if (!isAddress(keeper) || !isAddress(vault)) return null;

  const [currentSeriesRaw, pendingSeriesRaw, maxRollRaw] = await Promise.all([
    ethCall(rpcUrl, keeper, SELECTORS.keeperCurrentSeriesId),
    ethCall(rpcUrl, keeper, SELECTORS.keeperPendingSeriesId),
    ethCall(rpcUrl, keeper, SELECTORS.keeperMaxRollSellAmount),
  ]);
  const state = {
    key,
    ...config,
    keeper,
    vault,
    currentSeriesId: decodeBytes32(currentSeriesRaw),
    pendingSeriesId: decodeBytes32(pendingSeriesRaw),
    rollActive: false,
    currentToken: manifest.series?.[config.firstTokenKey],
    rollAuctionId: null,
    rollNextToken: null,
    totalAssets: 0n,
    maxRollSellAmount: decodeUint(maxRollRaw),
    activeAuctionCountBySeller: 0n,
  };

  if (isAddress(manifest.contracts?.rollAuction)) {
    const sellerCountRaw = await ethCall(
      rpcUrl,
      manifest.contracts.rollAuction,
      `${SELECTORS.activeAuctionCountBySeller}${addressWord(vault)}`,
    );
    state.activeAuctionCountBySeller = decodeUint(sellerCountRaw);
  }

  if (isAddress(healthLens)) {
    const raw = await ethCall(rpcUrl, healthLens, encodeAddress(SELECTORS.healthWrapper, vault));
    state.currentToken = decodeAddress(raw, 3);
    state.rollActive = decodeBool(raw, 4);
    state.totalAssets = decodeUint(raw, 5);
    state.rollAuction = decodeAddress(raw, 6);
    state.rollAuctionId = decodeUint(raw, 7);
    state.rollNextToken = decodeAddress(raw, 8);
  }

  return state;
}

function matchProduct(manifest, wrappers, auction) {
  for (const wrapper of Object.values(wrappers).filter(Boolean)) {
    const fallbackBuyToken = manifest.series?.[wrapper.secondTokenKey];
    const activeMatch =
      wrapper.rollActive &&
      sameAddress(auction.sellToken, wrapper.currentToken) &&
      sameAddress(auction.buyToken, wrapper.rollNextToken);
    const fallbackMatch =
      sameAddress(auction.sellToken, manifest.series?.[wrapper.firstTokenKey]) &&
      sameAddress(auction.buyToken, fallbackBuyToken);
    if (activeMatch || fallbackMatch) return wrapper;
  }
  return null;
}

function castSend(contract, signature, args = [], extra = "") {
  const rendered = args.map(String).join(" ");
  const suffix = extra ? ` ${extra}` : "";
  return `cast send ${contract} '${signature}'${rendered ? ` ${rendered}` : ""} --rpc-url $RPC_URL --private-key $PRIVATE_KEY${suffix}`;
}

function txSpec(contract, signature, args = [], value = null) {
  return {
    contract,
    signature,
    args: args.map(String),
    value: value === null || value === undefined ? null : String(value),
  };
}

function commandFromTx(tx) {
  return castSend(tx.contract, tx.signature, tx.args, tx.value ? `--value ${tx.value}` : "");
}

function solverModelCommand(modelPath) {
  const resolved = path.resolve(modelPath);
  if (/\.(mjs|cjs|js)$/.test(resolved)) {
    return { command: process.execPath, args: [resolved], label: resolved };
  }
  return { command: resolved, args: [], label: resolved };
}

function solverModelInput(manifest, wrapper, auction, args, auctionStoppedLevel, auctionMinSellAmount, defaultSellAmount) {
  return {
    version: 1,
    product: wrapper.key,
    productLabel: wrapper.label,
    auction: {
      auctionId: auction.auctionId.toString(),
      seller: auction.seller,
      sellToken: auction.sellToken,
      buyToken: auction.buyToken,
      remainingSellAmount: auction.remainingSellAmount.toString(),
      buyTokenRaised: auction.buyTokenRaised.toString(),
      startPriceWad: auction.startPriceWad.toString(),
      endPriceWad: auction.endPriceWad.toString(),
      currentPriceWad: auction.currentPriceWad.toString(),
      elapsedSeconds: auction.elapsed.toString(),
      timeLeftSeconds: auction.timeLeft.toString(),
      cancelled: auction.cancelled,
    },
    wrapper: {
      key: wrapper.key,
      currentSeriesId: wrapper.currentSeriesId,
      pendingSeriesId: wrapper.pendingSeriesId,
      solverMethod: wrapper.solverMethod,
    },
    limits: {
      operatorMaxPriceWad: args.maxPriceWad.toString(),
      defaultSellAmount: defaultSellAmount.toString(),
      defaultMaxFillWei: args.maxFillWei === null ? null : args.maxFillWei.toString(),
      auctionMinSellAmount: auctionMinSellAmount.toString(),
      auctionStoppedLevel: auctionStoppedLevel.toString(),
      recipient: args.recipient,
    },
    contracts: {
      factory: manifest.contracts?.factory,
      rollAuction: manifest.contracts?.rollAuction,
      rollSolver: manifest.contracts?.rollSolver,
    },
  };
}

function runSolverModel(modelPath, input) {
  if (!modelPath) return { bid: true, reason: "No solver model configured." };

  const command = solverModelCommand(modelPath);
  const result = spawnSync(command.command, command.args, {
    input: `${jsonSafe(input)}\n`,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = result.stderr ? `: ${result.stderr.trim()}` : "";
    throw new Error(`Solver model ${command.label} failed with exit code ${result.status ?? "unknown"}${stderr}`);
  }

  try {
    const parsed = JSON.parse(result.stdout || "{}");
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("output must be a JSON object");
    }
    return {
      bid: parsed.bid !== false && parsed.skip !== true,
      reason: typeof parsed.reason === "string" ? parsed.reason : "Solver model returned a decision.",
      maxPriceWad: parseOptionalUint(parsed.maxPriceWad ?? parsed.priceCeilingWad, "maxPriceWad"),
      sellAmount: parseOptionalUint(parsed.sellAmountWei ?? parsed.fillAmountWei, "sellAmountWei"),
      model: command.label,
    };
  } catch (error) {
    throw new Error(`Solver model ${command.label} returned invalid JSON: ${error.message}`);
  }
}

function solverTx(manifest, wrapper, auction, sellAmount, maxBuyAmount, recipient) {
  const solverMethods = {
    mintAndFill: "mintAndFill(address,address,bytes32,uint256,uint256,uint256,address)",
    mintAndFillN: "mintAndFillN(address,address,bytes32,uint256,uint256,uint256,address)",
    mintAndFillWithCallback:
      "mintAndFillWithCallback(address,address,bytes32,uint256,uint256,uint256,address)",
    mintAndFillNWithCallback:
      "mintAndFillNWithCallback(address,address,bytes32,uint256,uint256,uint256,address)",
    mintAndFillAll: "mintAndFillAll(address,address,bytes32,uint256,uint256,address)",
    mintAndFillAllN: "mintAndFillAllN(address,address,bytes32,uint256,uint256,address)",
    mintAndFillAllWithCallback:
      "mintAndFillAllWithCallback(address,address,bytes32,uint256,uint256,address)",
    mintAndFillAllNWithCallback:
      "mintAndFillAllNWithCallback(address,address,bytes32,uint256,uint256,address)",
  };
  const seriesId =
    wrapper.pendingSeriesId && isBytes32(wrapper.pendingSeriesId) && wrapper.pendingSeriesId !== `0x${"0".repeat(64)}`
      ? wrapper.pendingSeriesId
      : manifest.series.secondSeriesId;
  const fillAllMethodByBase = {
    mintAndFill: "mintAndFillAll",
    mintAndFillN: "mintAndFillAllN",
    mintAndFillWithCallback: "mintAndFillAllWithCallback",
    mintAndFillNWithCallback: "mintAndFillAllNWithCallback",
  };
  const useFillAll = sellAmount === auction.remainingSellAmount;
  const methodKey = useFillAll ? (fillAllMethodByBase[wrapper.solverMethod] || "mintAndFillAll") : wrapper.solverMethod;
  const method = solverMethods[methodKey] || solverMethods.mintAndFill;
  const methodArgs = useFillAll
    ? [
        manifest.contracts.factory,
        manifest.contracts.rollAuction,
        seriesId,
        auction.auctionId,
        maxBuyAmount,
        recipient,
      ]
    : [
        manifest.contracts.factory,
        manifest.contracts.rollAuction,
        seriesId,
        auction.auctionId,
        sellAmount,
        maxBuyAmount,
        recipient,
      ];
  return txSpec(
    manifest.contracts.rollSolver,
    method,
    methodArgs,
    maxBuyAmount,
  );
}

function lpKeeperTx(manifest, wrapper, auction, sellAmount, ethToMint, maxBuyAmount) {
  const method =
    wrapper.lpMethod === "fillBoostedRoll"
      ? "fillBoostedRoll(address,address,bytes32,bytes32,uint256,uint256,uint256,uint256)"
      : "fillSteadyRoll(address,address,bytes32,bytes32,uint256,uint256,uint256,uint256)";
  return txSpec(manifest.contracts.lpKeeper, method, [
    manifest.contracts.factory,
    manifest.contracts.rollAuction,
    wrapper.currentSeriesId,
    wrapper.pendingSeriesId && isBytes32(wrapper.pendingSeriesId) && wrapper.pendingSeriesId !== `0x${"0".repeat(64)}`
      ? wrapper.pendingSeriesId
      : manifest.series.secondSeriesId,
    auction.auctionId,
    sellAmount,
    ethToMint,
    maxBuyAmount,
  ]);
}

function inventoryMarketConfigs(manifest) {
  const series = manifest.series || {};
  const markets = manifest.inventoryMarkets || {};
  return [
    {
      key: "firstP",
      label: "first-series P",
      seriesId: series.firstSeriesId,
      token: series.firstP,
      market: markets.firstP,
      sellN: false,
    },
    {
      key: "firstN",
      label: "first-series N",
      seriesId: series.firstSeriesId,
      token: series.firstN,
      market: markets.firstN,
      sellN: true,
    },
    {
      key: "secondP",
      label: "second-series P",
      seriesId: series.secondSeriesId,
      token: series.secondP,
      market: markets.secondP,
      sellN: false,
    },
    {
      key: "secondN",
      label: "second-series N",
      seriesId: series.secondSeriesId,
      token: series.secondN,
      market: markets.secondN,
      sellN: true,
    },
  ].filter((item) => isBytes32(item.seriesId) && isAddress(item.token));
}

function inventoryMarketForToken(manifest, token) {
  return inventoryMarketConfigs(manifest).find((item) => sameAddress(item.token, token)) || null;
}

function lpInventorySellTx(manifest, item, market, amount, minEthOut) {
  return txSpec(manifest.contracts.lpKeeper, "sellInventory(address,bytes32,bool,address,uint256,uint256)", [
    item.factory,
    item.seriesId,
    item.sellN,
    market,
    amount,
    minEthOut,
  ]);
}

function lpInventoryMergeTx(manifest, item, amount) {
  return txSpec(manifest.contracts.lpKeeper, "mergeSeries(address,bytes32,uint256)", [
    item.factory,
    item.seriesId,
    amount,
  ]);
}

function lpInventoryRedeemTx(manifest, item, amount) {
  const signature = item.sellN
    ? "redeemN(address,bytes32,uint256)"
    : "redeemP(address,bytes32,uint256)";
  return txSpec(manifest.contracts.lpKeeper, signature, [
    item.factory,
    item.seriesId,
    amount,
  ]);
}

function lpInventoryCloseTx(manifest) {
  return txSpec(manifest.contracts.lpKeeper, "closeStrategy()");
}

async function readLpInventoryState(rpcUrl, manifest) {
  const vault = manifest.contracts?.lpVault;
  if (!isAddress(vault)) return [];

  const length = Number(decodeUint(await ethCall(rpcUrl, vault, SELECTORS.inventorySeriesLength)));
  const cappedLength = Math.min(length, 24);
  const items = [];

  for (let index = 0; index < cappedLength; index += 1) {
    const inventoryRaw = await ethCall(rpcUrl, vault, encodeUint(SELECTORS.inventorySeries, BigInt(index)));
    const factory = decodeAddress(inventoryRaw, 0);
    const seriesId = decodeBytes32(inventoryRaw, 1);
    if (!isAddress(factory) || !isBytes32(seriesId)) continue;

    const seriesRaw = await ethCall(rpcUrl, factory, `${SELECTORS.factorySeries}${bytes32Word(seriesId)}`);
    const maturity = decodeUint(seriesRaw, 1);
    const pToken = decodeAddress(seriesRaw, 6);
    const nToken = decodeAddress(seriesRaw, 7);
    const settled = decodeBool(seriesRaw, 9);
    const settlementPrice = decodeUint(seriesRaw, 10);
    const [pBalanceRaw, nBalanceRaw] = await Promise.all([
      isAddress(pToken) ? ethCall(rpcUrl, pToken, `${SELECTORS.balanceOf}${addressWord(vault)}`) : Promise.resolve("0x"),
      isAddress(nToken) ? ethCall(rpcUrl, nToken, `${SELECTORS.balanceOf}${addressWord(vault)}`) : Promise.resolve("0x"),
    ]);

    items.push({
      factory,
      seriesId,
      token: pToken,
      tokenSide: "P",
      sellN: false,
      balance: decodeUint(pBalanceRaw),
      maturity,
      settled,
      settlementPrice,
    });
    items.push({
      factory,
      seriesId,
      token: nToken,
      tokenSide: "N",
      sellN: true,
      balance: decodeUint(nBalanceRaw),
      maturity,
      settled,
      settlementPrice,
    });
  }

  return items.filter((item) => isAddress(item.token) && item.balance > 0n);
}

function inventoryGroupKey(item) {
  return `${item.factory.toLowerCase()}:${item.seriesId.toLowerCase()}`;
}

function groupLpInventory(inventory) {
  const groups = new Map();
  for (const item of inventory) {
    const key = inventoryGroupKey(item);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        factory: item.factory,
        seriesId: item.seriesId,
        maturity: item.maturity,
        settled: item.settled,
        settlementPrice: item.settlementPrice,
        p: null,
        n: null,
      });
    }
    const group = groups.get(key);
    if (item.tokenSide === "P") group.p = item;
    if (item.tokenSide === "N") group.n = item;
  }
  return [...groups.values()];
}

function capInventoryAmount(amount, args) {
  if (args.maxInventorySellWei && args.maxInventorySellWei < amount) return args.maxInventorySellWei;
  return amount;
}

function dustBlockedFill(sellAmount, remainingSellAmount, minSellAmount) {
  if (sellAmount === remainingSellAmount) return false;
  if (sellAmount < minSellAmount) return true;

  const remainingAfter = remainingSellAmount - sellAmount;
  return remainingAfter !== 0n && remainingAfter < minSellAmount;
}

function buildAuctionActions(manifest, wrappers, auctions, args, auctionStoppedLevel, auctionMinSellAmount, lpPolicy) {
  const actions = [];

  for (const auction of auctions) {
    if (auction.cancelled || auction.remainingSellAmount === 0n) continue;
    const wrapper = matchProduct(manifest, wrappers, auction);
    if (!wrapper) {
      actions.push({
        type: "inspect-auction",
        reason: "Active auction does not match known Steady/Boosted token pairs in the manifest.",
        auctionId: auction.auctionId,
      });
      continue;
    }

    const defaultSellAmount = args.maxFillWei && args.maxFillWei < auction.remainingSellAmount
      ? args.maxFillWei
      : auction.remainingSellAmount;
    const modelInput = solverModelInput(
      manifest,
      wrapper,
      auction,
      args,
      auctionStoppedLevel,
      auctionMinSellAmount,
      defaultSellAmount,
    );
    const modelDecision = runSolverModel(args.solverModel, modelInput);
    const modelPriceWad = modelDecision.maxPriceWad == null ? args.maxPriceWad : modelDecision.maxPriceWad;
    const solverMaxPriceWad = modelPriceWad < args.maxPriceWad ? modelPriceWad : args.maxPriceWad;
    const modelSellAmount = modelDecision.sellAmount == null ? defaultSellAmount : modelDecision.sellAmount;
    const solverSellAmount = modelSellAmount > auction.remainingSellAmount ? auction.remainingSellAmount : modelSellAmount;
    const lpSellAmount = defaultSellAmount;
    const solverMaxBuyAmount = mulDivUp(solverSellAmount, solverMaxPriceWad, WAD);
    const lpMaxBuyAmount = mulDivUp(lpSellAmount, args.maxPriceWad, WAD);
    const solverCurrentPriceOk = auction.currentPriceWad <= solverMaxPriceWad;
    const lpCurrentPriceOk = auction.currentPriceWad <= args.maxPriceWad;
    const fillsPaused = auctionStoppedLevel >= 3n;
    const solverDustBlocked = dustBlockedFill(solverSellAmount, auction.remainingSellAmount, auctionMinSellAmount);
    const lpDustBlocked = dustBlockedFill(lpSellAmount, auction.remainingSellAmount, auctionMinSellAmount);
    const solverReady = modelDecision.bid && solverSellAmount > 0n && solverCurrentPriceOk && !fillsPaused && !solverDustBlocked;
    const quotedBuyAmount = mulDivUp(lpSellAmount, auction.currentPriceWad, WAD);
    const strategyCapacity = lpPolicy && lpPolicy.maxActiveStrategyEth > lpPolicy.activeStrategyEth
      ? lpPolicy.maxActiveStrategyEth - lpPolicy.activeStrategyEth
      : 0n;
    const lpPriceDropBps = priceDropBps(auction.startPriceWad, auction.currentPriceWad);
    const lpPriceOk = !lpPolicy || auction.currentPriceWad <= lpPolicy.maxRollPriceWad;
    const lpCapacityOk = !lpPolicy || (quotedBuyAmount <= lpPolicy.maxEthPerRoll && quotedBuyAmount <= strategyCapacity);
    const lpDelayOk = !lpPolicy || auction.elapsed >= lpPolicy.minBackstopDelay;
    const lpTimeOk = !lpPolicy || auction.timeLeft >= lpPolicy.minAuctionTimeLeft;
    const lpDropOk = !lpPolicy || lpPriceDropBps <= lpPolicy.maxAuctionPriceDropBps;
    const lpReady = lpCurrentPriceOk && !fillsPaused && !lpDustBlocked && lpPriceOk && lpCapacityOk && lpDelayOk && lpTimeOk && lpDropOk;
    const solverActionTx = solverTx(manifest, wrapper, auction, solverSellAmount, solverMaxBuyAmount, args.recipient);
    const lpActionTx = lpKeeperTx(manifest, wrapper, auction, lpSellAmount, quotedBuyAmount, lpMaxBuyAmount);

    actions.push({
      type: "solver-bid",
      product: wrapper.label,
      ready: solverReady,
      auctionId: auction.auctionId,
      condition: fillsPaused
        ? "Auction circuit breaker level pauses fills."
        : !modelDecision.bid
          ? modelDecision.reason
        : solverSellAmount === 0n
          ? "Solver model returned a zero fill size."
        : solverDustBlocked
          ? "Suggested partial fill is below the auction dust rules; increase --max-fill-eth or fill the remainder."
        : solverCurrentPriceOk ? modelDecision.reason : "Wait for Dutch price to decay below the solver price ceiling.",
      currentPriceWad: auction.currentPriceWad,
      remaining: weiToEthText(auction.remainingSellAmount),
      suggestedFill: weiToEthText(solverSellAmount),
      fillMode: solverSellAmount === auction.remainingSellAmount ? "fillAll" : "fixedAmount",
      maxPriceWad: solverMaxPriceWad,
      maxBuyAmount: weiToEthText(solverMaxBuyAmount),
      solverModel: modelDecision.model || null,
      tx: solverActionTx,
      command: commandFromTx(solverActionTx),
    });

    actions.push({
      type: "lp-backstop-bid",
      product: wrapper.label,
      ready: lpReady,
      auctionId: auction.auctionId,
      condition: fillsPaused
        ? "Auction circuit breaker level pauses fills."
        : lpDustBlocked
          ? "Suggested partial fill is below the auction dust rules; increase --max-fill-eth or fill the remainder."
          : !lpCurrentPriceOk ? "Wait for Dutch price to decay."
            : !lpPriceOk ? "Current price is above the ETH LP vault max roll price."
              : !lpCapacityOk ? "Suggested fill exceeds ETH LP vault per-roll or remaining strategy capacity."
                : !lpDelayOk ? "External solver priority window is still open; ETH LP vault waits before backstopping."
                  : !lpTimeOk ? "Auction has less time left than ETH LP vault policy requires."
                    : !lpDropOk ? "Auction price has decayed past the ETH LP vault backstop policy."
	                      : "Use only if external solver bids are not filling the auction and vault policy accepts the price.",
      suggestedFill: weiToEthText(lpSellAmount),
      ethToMint: weiToEthText(quotedBuyAmount),
      maxBuyAmount: weiToEthText(lpMaxBuyAmount),
      elapsedSeconds: auction.elapsed.toString(),
      timeLeftSeconds: auction.timeLeft.toString(),
      priceDropBps: lpPriceDropBps.toString(),
      tx: lpActionTx,
      command: commandFromTx(lpActionTx),
    });
  }

  return actions;
}

async function buildWrapperMaintenanceActions(
  rpcUrl,
  manifest,
  wrappers,
  args,
  auctionStoppedLevel,
  auctionMinSellAmount,
  staleResetPolicy,
  auctionCapacity,
) {
  const actions = [];
  const healthLens = manifest.contracts?.healthLens;

  for (const wrapper of Object.values(wrappers).filter(Boolean)) {
    if (!wrapper.rollActive) {
      const nextSeriesId = manifest.series?.secondSeriesId;
      const sellAmount = wrapper.totalAssets > 0n ? wrapper.totalAssets : args.maxFillWei;
      if (isBytes32(nextSeriesId) && sellAmount && sellAmount > 0n && wrapper.currentSeriesId !== nextSeriesId) {
        const newAuctionsPaused = auctionStoppedLevel >= 1n;
        const auctionListFull = Boolean(auctionCapacity?.full);
        const sellerAuctionListFull =
          Boolean(auctionCapacity?.maxPerSeller) &&
          wrapper.activeAuctionCountBySeller >= auctionCapacity.maxPerSeller;
        const dustBlocked = sellAmount < auctionMinSellAmount;
        const capBlocked = sellAmount > wrapper.maxRollSellAmount;
        const startPrice = args.startPriceWad || wrapper.startPriceWad;
        const floorPrice = args.floorPriceWad || wrapper.floorPriceWad;
        const actionTx = txSpec(wrapper.keeper, "startRoll(bytes32,uint256,uint256,uint256,uint64)", [
          nextSeriesId,
          sellAmount,
          startPrice,
          floorPrice,
          args.duration,
        ]);
        actions.push({
          type: "wrapper-start-roll",
          product: wrapper.label,
          ready: !newAuctionsPaused && !auctionListFull && !sellerAuctionListFull && !dustBlocked && !capBlocked,
          reason: "Wrapper is idle and has visible inventory to roll.",
          condition: newAuctionsPaused
            ? "Auction circuit breaker level pauses new auctions."
            : auctionListFull
              ? `Active auction list is full (${auctionCapacity.count.toString()}/${auctionCapacity.max.toString()}); clear or fill an existing auction first.`
              : sellerAuctionListFull
                ? `Wrapper already has ${wrapper.activeAuctionCountBySeller.toString()} active auction(s), which reaches the per-seller cap.`
                : dustBlocked
                  ? "Wrapper inventory is below the auction dust threshold."
                  : capBlocked ? "Wrapper inventory is above the product roll-size cap." : undefined,
          sellAmount: weiToEthText(sellAmount),
          tx: actionTx,
          command: commandFromTx(actionTx),
        });
      }
      continue;
    }

    let auctionHealth = null;
    if (isAddress(healthLens) && isAddress(manifest.contracts.rollAuction) && wrapper.rollAuctionId !== null) {
      const raw = await ethCall(rpcUrl, healthLens, encodeAuctionHealth(manifest.contracts.rollAuction, wrapper.rollAuctionId));
      auctionHealth = {
        auctionId: decodeUint(raw, 1),
        remainingSellAmount: decodeUint(raw, 6),
        buyTokenRaised: decodeUint(raw, 7),
        startPriceWad: decodeUint(raw, 8),
        currentPriceWad: decodeUint(raw, 10),
        elapsed: decodeUint(raw, 11),
        timeLeft: decodeUint(raw, 12),
        open: decodeBool(raw, 13),
        active: decodeBool(raw, 14),
        cancelled: decodeBool(raw, 16),
      };
    }

    if (auctionHealth?.remainingSellAmount === 0n) {
      const actionTx = txSpec(wrapper.keeper, "finalizeRoll()");
      actions.push({
        type: "wrapper-finalize-roll",
        product: wrapper.label,
        ready: true,
        reason: "Roll auction is filled.",
        tx: actionTx,
        command: commandFromTx(actionTx),
      });
    } else if (
      auctionHealth &&
      auctionHealth.timeLeft === 0n &&
      auctionHealth.buyTokenRaised === 0n &&
      auctionHealth.remainingSellAmount > 0n
    ) {
      const actionTx = txSpec(wrapper.keeper, "cancelUnfilledRoll()");
      actions.push({
        type: "wrapper-cancel-roll",
        product: wrapper.label,
        ready: true,
        reason: "Auction expired with no fills.",
        tx: actionTx,
        command: commandFromTx(actionTx),
      });
    } else if (auctionHealth && auctionHealth.remainingSellAmount > 0n) {
      const dropBps = priceDropBps(auctionHealth.startPriceWad, auctionHealth.currentPriceWad);
      const expired = auctionHealth.timeLeft === 0n;
      const priceStale =
        staleResetPolicy.priceDropBps !== 0n &&
        auctionHealth.elapsed >= staleResetPolicy.minDelay &&
        dropBps >= staleResetPolicy.priceDropBps;
      if (!expired && !priceStale) {
        actions.push({
          type: "watch-wrapper-roll",
          product: wrapper.label,
          ready: false,
          reason: "Roll is active but not ready for finalize/cancel/reset.",
          auctionId: wrapper.rollAuctionId,
        });
        continue;
      }

      const resetsPaused = auctionStoppedLevel >= 2n;
      const startPrice = args.startPriceWad || wrapper.startPriceWad;
      const floorPrice = args.floorPriceWad || wrapper.floorPriceWad;
      const actionTx = txSpec(wrapper.keeper, "resetRoll(uint256,uint256,uint64)", [
        startPrice,
        floorPrice,
        args.duration,
      ]);
      actions.push({
        type: "wrapper-reset-roll",
        product: wrapper.label,
        ready: !resetsPaused,
        reason: expired
          ? "Auction expired with partial fills; reset the Dutch curve so the remaining inventory can clear."
          : "Auction price decayed past the stale-reset threshold; reset the Dutch curve so the remaining inventory can clear.",
        condition: resetsPaused ? "Auction circuit breaker level pauses resets." : undefined,
        auctionId: wrapper.rollAuctionId,
        remaining: weiToEthText(auctionHealth.remainingSellAmount),
        priceDropBps: dropBps.toString(),
        tx: actionTx,
        command: commandFromTx(actionTx),
      });
    } else {
      actions.push({
        type: "watch-wrapper-roll",
        product: wrapper.label,
        ready: false,
        reason: "Roll is active but not ready for finalize/cancel.",
        auctionId: wrapper.rollAuctionId,
      });
    }
  }

  return actions;
}

async function buildLpInventoryActions(rpcUrl, manifest, inventory, args, lpPolicy) {
  const actions = [];
  const lpKeeper = manifest.contracts?.lpKeeper;
  if (!isAddress(lpKeeper)) return actions;

  const grouped = groupLpInventory(inventory);
  const deferredSellGroups = new Set();

  for (const group of grouped) {
    if (group.settled) {
      for (const item of [group.p, group.n].filter(Boolean)) {
        const amount = capInventoryAmount(item.balance, args);
        if (amount === 0n) continue;
        const actionTx = lpInventoryRedeemTx(manifest, item, amount);
        actions.push({
          type: "lp-inventory-redeem",
          product: "ETH LP Vault",
          ready: true,
          reason: `${item.tokenSide} inventory is settled and can redeem directly to ETH without finding a market buyer.`,
          token: `${item.tokenSide} token`,
          seriesId: item.seriesId,
          amount: weiToEthText(amount),
          tx: actionTx,
          command: commandFromTx(actionTx),
        });
      }
      deferredSellGroups.add(group.key);
      continue;
    }

    if (group.p && group.n) {
      const mergeable = group.p.balance < group.n.balance ? group.p.balance : group.n.balance;
      const amount = capInventoryAmount(mergeable, args);
      if (amount > 0n) {
        const actionTx = lpInventoryMergeTx(manifest, group.p, amount);
        actions.push({
          type: "lp-inventory-merge",
          product: "ETH LP Vault",
          ready: true,
          reason: "Vault holds matched P + N inventory; merge it directly back to ETH before using AMM liquidity.",
          seriesId: group.seriesId,
          amount: weiToEthText(amount),
          tx: actionTx,
          command: commandFromTx(actionTx),
        });
        deferredSellGroups.add(group.key);
      }
    }
  }

  for (const item of inventory) {
    if (deferredSellGroups.has(inventoryGroupKey(item))) continue;

    const config = inventoryMarketForToken(manifest, item.token);
    const label = config?.label || `${item.tokenSide} token`;
    const amount = capInventoryAmount(item.balance, args);
    if (amount === 0n) continue;

    if (!config || !isAddress(config.market)) {
      actions.push({
        type: "configure-lp-inventory-market",
        product: "ETH LP Vault",
        ready: false,
        reason: "Vault holds tracked option inventory, but the manifest has no matching inventoryMarkets entry.",
        token: label,
        seriesId: item.seriesId,
        amount: weiToEthText(item.balance),
        expectedManifestKey: config?.key || "unknown",
      });
      continue;
    }

    const marketToken = decodeAddress(await ethCall(rpcUrl, config.market, SELECTORS.ammToken));
    if (!sameAddress(marketToken, item.token)) {
      actions.push({
        type: "inspect-lp-inventory-market",
        product: "ETH LP Vault",
        ready: false,
        reason: "Configured inventory market does not trade the expected token.",
        token: label,
        market: config.market,
        expectedToken: item.token,
        actualToken: marketToken,
      });
      continue;
    }

    let quote;
    try {
      quote = decodeUint(await ethCall(rpcUrl, config.market, encodeUint(SELECTORS.quoteSellToken, amount)));
    } catch (error) {
      actions.push({
        type: "watch-lp-inventory-market",
        product: "ETH LP Vault",
        ready: false,
        reason: `Could not quote the configured inventory market: ${error.message}`,
        token: label,
        market: config.market,
        amount: weiToEthText(amount),
      });
      continue;
    }

    const policyMinEthOut = lpPolicy ? mulDivUp(amount, lpPolicy.minInventorySalePriceWad, WAD) : 0n;
    if (quote < policyMinEthOut) {
      actions.push({
        type: "watch-lp-inventory-market",
        product: "ETH LP Vault",
        ready: false,
        reason: "Configured inventory market quote is below the ETH LP vault sale floor; keep inventory paused, wait for a better buyer, or redeem/merge after settlement.",
        token: label,
        market: config.market,
        amount: weiToEthText(amount),
        quoteEth: weiToEthText(quote),
        policyMinEthOut: weiToEthText(policyMinEthOut),
      });
      continue;
    }

    const slippageMinEthOut = (quote * BigInt(10_000 - args.inventorySlippageBps)) / 10_000n;
    const minEthOut = policyMinEthOut > slippageMinEthOut ? policyMinEthOut : slippageMinEthOut;
    const actionTx = lpInventorySellTx(manifest, item, config.market, amount, minEthOut);
    actions.push({
      type: "lp-inventory-sell",
      product: "ETH LP Vault",
      ready: true,
      reason: "Tracked option inventory has a matching public AMM and can be unwound back to ETH.",
      token: label,
      seriesId: item.seriesId,
      market: config.market,
      amount: weiToEthText(amount),
      quoteEth: weiToEthText(quote),
      minEthOut: weiToEthText(minEthOut),
      tx: actionTx,
      command: commandFromTx(actionTx),
    });
  }

  if (inventory.length === 0 && lpPolicy && lpPolicy.activeStrategyEth > 0n) {
    const actionTx = lpInventoryCloseTx(manifest);
    actions.push({
      type: "lp-inventory-close",
      product: "ETH LP Vault",
      ready: true,
      reason: "Tracked inventory is clean; close the active LP strategy so deposits and withdrawals can reopen.",
      activeStrategyEth: weiToEthText(lpPolicy.activeStrategyEth),
      tx: actionTx,
      command: commandFromTx(actionTx),
    });
  }

  return actions;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = await readManifest(args.manifest);
  const missing = missingManifestKeys(manifest);

  if (!args.rpc || missing.length) {
    const result = {
      status: missing.length ? "manifest-incomplete" : "rpc-required",
      manifest: args.manifest,
      missing,
      nextStep: missing.length
        ? "Fill demo/contract-manifest.json after deployment."
        : "Pass --rpc or set RPC_URL to read public contract state.",
    };
    if (args.json) console.log(jsonSafe(result));
    else {
      console.log(`Status: ${result.status}`);
      if (missing.length) console.log(`Missing: ${missing.join(", ")}`);
      console.log(result.nextStep);
    }
    return;
  }

  const wrappers = {
    steady: await readWrapperState(args.rpc, manifest, "steady"),
    boosted: await readWrapperState(args.rpc, manifest, "boosted"),
  };
  const [
    auctionStoppedRaw,
    auctionMinSellRaw,
    maxActiveAuctionsRaw,
    maxActiveAuctionsPerSellerRaw,
    minStaleResetDelayRaw,
    minStaleResetPriceDropRaw,
  ] = await Promise.all([
    ethCall(args.rpc, manifest.contracts.rollAuction, SELECTORS.auctionStopped),
    ethCall(args.rpc, manifest.contracts.rollAuction, SELECTORS.minSellAmount),
    ethCall(args.rpc, manifest.contracts.rollAuction, SELECTORS.maxActiveAuctions),
    ethCall(args.rpc, manifest.contracts.rollAuction, SELECTORS.maxActiveAuctionsPerSeller),
    ethCall(args.rpc, manifest.contracts.rollAuction, SELECTORS.minStaleResetDelay),
    ethCall(args.rpc, manifest.contracts.rollAuction, SELECTORS.minStaleResetPriceDropBps),
  ]);
  const auctionStoppedLevel = decodeUint(auctionStoppedRaw);
  const auctionMinSellAmount = decodeUint(auctionMinSellRaw);
  const maxActiveAuctions = decodeUint(maxActiveAuctionsRaw);
  const maxActiveAuctionsPerSeller = decodeUint(maxActiveAuctionsPerSellerRaw);
  const staleResetPolicy = {
    minDelay: decodeUint(minStaleResetDelayRaw),
    priceDropBps: decodeUint(minStaleResetPriceDropRaw),
  };
  const globalAuctions = await readActiveAuctions(args.rpc, manifest.contracts.rollAuction);
  const wrapperSellerAuctions = await readActiveAuctionsBySellers(
    args.rpc,
    manifest.contracts.rollAuction,
    Object.values(wrappers).map((wrapper) => wrapper?.vault),
  );
  const auctions = mergeAuctions(globalAuctions, wrapperSellerAuctions);
  const auctionCapacity = {
    count: BigInt(globalAuctions.length),
    max: maxActiveAuctions,
    maxPerSeller: maxActiveAuctionsPerSeller,
    full: maxActiveAuctions > 0n && BigInt(globalAuctions.length) >= maxActiveAuctions,
  };
  const lpPolicy = await readLpVaultPolicy(args.rpc, manifest.contracts?.lpVault);
  const lpInventory = await readLpInventoryState(args.rpc, manifest);
  const actions = [
    ...buildAuctionActions(manifest, wrappers, auctions, args, auctionStoppedLevel, auctionMinSellAmount, lpPolicy),
    ...(await buildLpInventoryActions(args.rpc, manifest, lpInventory, args, lpPolicy)),
    ...(await buildWrapperMaintenanceActions(
      args.rpc,
      manifest,
      wrappers,
      args,
      auctionStoppedLevel,
      auctionMinSellAmount,
      staleResetPolicy,
      auctionCapacity,
    )),
  ];

  const result = {
    status: "ok",
    activeAuctionCount: globalAuctions.length,
    discoveredAuctionCount: auctions.length,
    wrapperSellerAuctionCount: wrapperSellerAuctions.length,
    maxActiveAuctions,
    maxActiveAuctionsPerSeller,
    auctionStoppedLevel,
    auctionMinSellAmount,
    staleResetPolicy,
    lpPolicy,
    wrappers,
    lpInventory,
    actions,
  };

  if (args.json) {
    console.log(jsonSafe(result));
    return;
  }

  console.log(
    `Active auctions: ${globalAuctions.length}/${maxActiveAuctions.toString()} (${maxActiveAuctionsPerSeller.toString()} max per seller)`,
  );
  if (wrapperSellerAuctions.length) {
    console.log(`Wrapper seller auctions discovered directly: ${wrapperSellerAuctions.length}`);
  }
  console.log(`Auction dust threshold: ${weiToEthText(auctionMinSellAmount)}`);
  if (!actions.length) {
    console.log("No keeper or solver action suggested right now.");
    return;
  }

  for (const action of actions) {
    console.log("");
    console.log(`[${action.type}] ${action.product || "Unknown product"}`);
    if (action.reason) console.log(`Reason: ${action.reason}`);
    if (action.condition) console.log(`Condition: ${action.condition}`);
    if (action.auctionId !== undefined) console.log(`Auction: ${action.auctionId.toString()}`);
    if (action.token) console.log(`Token: ${action.token}`);
    if (action.market) console.log(`Market: ${action.market}`);
    if (action.suggestedFill) console.log(`Suggested fill: ${action.suggestedFill}`);
    if (action.amount) console.log(`Amount: ${action.amount}`);
    if (action.ethToMint) console.log(`ETH to mint: ${action.ethToMint}`);
    if (action.maxBuyAmount) console.log(`Max pay: ${action.maxBuyAmount}`);
    if (action.quoteEth) console.log(`Quote: ${action.quoteEth}`);
    if (action.minEthOut) console.log(`Min ETH out: ${action.minEthOut}`);
    if (action.command) console.log(action.command);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
