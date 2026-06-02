#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_MANIFEST = path.join("demo", "contract-manifest.json");
const WAD = 10n ** 18n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;

const SELECTORS = {
  healthMarket: "0x80b7f991",
  healthLpVault: "0x48bd419c",
  healthLpInventory: "0xab5aa02d",
  healthWrapper: "0x254fe68f",
  healthSeries: "0x43f7b47e",
  healthAuctionPolicy: "0x6984f01e",
  healthWrapperKeeper: "0xf524fbca",
  lpKeeperVault: "0xfbfa77cf",
  lpKeeperSteadyRollSeller: "0x94aaed33",
  lpKeeperBoostedRollSeller: "0xa6a8d265",
  lpKeeperRollSellersSet: "0x7ae9860f",
  activeAuctionCountBySeller: "0x9f4fd695",
  activeAuctionIdBySellerAt: "0x38750e9a",
  oracleFactory: "0xc45a0155",
  oraclePoolConfigs: "0x0f5ba217",
  oracleSeriesConfigs: "0xedf713db",
  oracleSourceCount: "0x911c276a",
};

const MAINNET_MEDIAN_ORACLE_POOLS = [
  {
    label: "USDC/WETH 0.05%",
    pool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
    priceAtTickZeroWad: 1_000_000_000_000_000_000_000_000_000_000n,
    invertPrice: true,
    minUsableTick: 175_000n,
    maxUsableTick: 221_200n,
  },
  {
    label: "WETH/USDT 0.05%",
    pool: "0x11b815efB8f581194ae79006d24E0d814B7697F6",
    priceAtTickZeroWad: 1_000_000_000_000_000_000_000_000_000_000n,
    invertPrice: false,
    minUsableTick: -221_200n,
    maxUsableTick: -175_000n,
  },
  {
    label: "DAI/WETH 0.05%",
    pool: "0x60594a405d53811d3BC4766596EFD80fd545A270",
    priceAtTickZeroWad: 1_000_000_000_000_000_000n,
    invertPrice: true,
    minUsableTick: -106_500n,
    maxUsableTick: -53_000n,
  },
];

const REQUIRED_CONTRACTS = [
  "factory",
  "rollAuction",
  "rollSolver",
  "healthLens",
  "lpKeeper",
  "lpVault",
  "steadyKeeper",
  "boostedKeeper",
  "steadyVault",
  "boostedVault",
  "steadyMarket",
  "boostedMarket",
];

const REQUIRED_SERIES = ["firstSeriesId", "secondSeriesId", "firstP", "firstN", "secondP", "secondN"];

function usage() {
  return `Usage:
  node ops/readiness-check.mjs --rpc <RPC_URL> [options]

Options:
  --manifest <path>          Manifest path (default: ${DEFAULT_MANIFEST})
  --json                     Print machine-readable JSON
  --strict                   Exit nonzero on warnings as well as failures
  --min-market-eth <eth>     Minimum ETH reserve per trader AMM (default: 0.1)
  --min-lp-eth <eth>         Minimum managed ETH in LP vault (default: 0.1)
  --sample-trade-eth <eth>   Sample market quote size (default: 0.01)
  --max-market-fee-bps <n>   Maximum acceptable trader AMM fee (default: 100)
  --max-cap-used-bps <n>     Warn when a series cap is above this usage (default: 9000)
  --max-normal-roll-cost-bps <n>
                             Maximum normal wrapper roll floor cost (default: 10)
  --max-lp-roll-premium-bps <n>
                             Maximum ETH LP vault premium bid over 1.0x (default: 0)
  --min-settlement-twap-hours <n>
                             Minimum series settlement TWAP window (default: 72)
  --require-median-oracle    Fail unless settlement exposes a 3-source median oracle,
                             even off mainnet. Keep this off for local mock demos.
  --boosted-demand-eth <eth> Credible committed Boosted/N buyer capacity beyond visible AMM ETH (default: 0)
  --solver-float-eth <eth>   External solver balance sheet for paired N inventory (default: 0)
  --capacity-rlp-ratio-bps <n>
                             Required LP-vault capital / Steady cap in bps (default: 100000 = 10x)
  --capacity-n-fill-bps <n>  Target external N fill used by the cap policy (default: 9500)
  --capacity-avg-n-demand-bps <n>
                             Avg historical outstanding N cost / Steady cap in bps (default: 21152)
  --capacity-stress-n-demand-bps <n>
                             Max historical outstanding N cost / Steady cap in bps (default: 160364)
  --no-solver-launch         Gate small launch capacity by LP-vault capital only
  --capacity-strict          Make capacity-policy misses fail instead of warn
  --expect-chain-id <hex>    Optional expected chain id, e.g. 0x1 or 0x7a69

Examples:
  node ops/readiness-check.mjs --rpc http://127.0.0.1:8545
  node ops/readiness-check.mjs --rpc $RPC_URL --manifest demo/contract-manifest.json --json
  node ops/readiness-check.mjs --rpc $RPC_URL --capacity-strict --boosted-demand-eth 5000 --solver-float-eth 250`;
}

function parseArgs(argv) {
  const args = {
    manifest: DEFAULT_MANIFEST,
    rpc: process.env.RPC_URL || "",
    json: false,
    strict: false,
    minMarketEthWei: ethToWei("0.1"),
    minLpEthWei: ethToWei("0.1"),
    sampleTradeEthWei: ethToWei("0.01"),
    maxMarketFeeBps: 100,
    maxCapUsedBps: 9_000,
    maxNormalRollCostBps: 10,
    maxLpRollPremiumBps: 0,
    minSettlementTwapSeconds: 72n * 60n * 60n,
    requireMedianOracle: false,
    boostedDemandWei: 0n,
    solverFloatWei: 0n,
    capacityRlpRatioBps: 100_000,
    capacityNFillBps: 9_500,
    capacityAvgNDemandBps: 21_152,
    capacityStressNDemandBps: 160_364,
    noSolverLaunch: false,
    capacityStrict: false,
    expectChainId: "",
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
    } else if (arg === "--strict") {
      args.strict = true;
    } else if (arg === "--min-market-eth") {
      args.minMarketEthWei = ethToWei(next());
    } else if (arg === "--min-lp-eth") {
      args.minLpEthWei = ethToWei(next());
    } else if (arg === "--sample-trade-eth") {
      args.sampleTradeEthWei = ethToWei(next());
    } else if (arg === "--max-market-fee-bps") {
      args.maxMarketFeeBps = parseInteger(next(), arg);
    } else if (arg === "--max-cap-used-bps") {
      args.maxCapUsedBps = parseInteger(next(), arg);
    } else if (arg === "--max-normal-roll-cost-bps") {
      args.maxNormalRollCostBps = parseInteger(next(), arg);
      if (args.maxNormalRollCostBps > 10_000) throw new Error("--max-normal-roll-cost-bps must be <= 10000");
    } else if (arg === "--max-lp-roll-premium-bps") {
      args.maxLpRollPremiumBps = parseInteger(next(), arg);
      if (args.maxLpRollPremiumBps > 10_000) throw new Error("--max-lp-roll-premium-bps must be <= 10000");
    } else if (arg === "--min-settlement-twap-hours") {
      args.minSettlementTwapSeconds = BigInt(parsePositiveInteger(next(), arg)) * 60n * 60n;
    } else if (arg === "--require-median-oracle") {
      args.requireMedianOracle = true;
    } else if (arg === "--boosted-demand-eth") {
      args.boostedDemandWei = ethToWei(next());
    } else if (arg === "--solver-float-eth") {
      args.solverFloatWei = ethToWei(next());
    } else if (arg === "--capacity-rlp-ratio-bps") {
      args.capacityRlpRatioBps = parsePositiveInteger(next(), arg);
    } else if (arg === "--capacity-n-fill-bps") {
      args.capacityNFillBps = parsePositiveInteger(next(), arg);
    } else if (arg === "--capacity-avg-n-demand-bps") {
      args.capacityAvgNDemandBps = parsePositiveInteger(next(), arg);
    } else if (arg === "--capacity-stress-n-demand-bps") {
      args.capacityStressNDemandBps = parsePositiveInteger(next(), arg);
    } else if (arg === "--no-solver-launch") {
      args.noSolverLaunch = true;
    } else if (arg === "--capacity-strict") {
      args.capacityStrict = true;
    } else if (arg === "--expect-chain-id") {
      args.expectChainId = next().toLowerCase();
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!args.rpc) throw new Error("Pass --rpc or set RPC_URL.");
  if (args.capacityNFillBps > 10_000) throw new Error("--capacity-n-fill-bps must be <= 10000");
  return args;
}

function parseInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function isAddress(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value) && value.toLowerCase() !== ZERO_ADDRESS;
}

function isZeroAddress(value) {
  return typeof value === "string" && value.toLowerCase() === ZERO_ADDRESS;
}

function isBytes32(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value) && value.toLowerCase() !== ZERO_BYTES32;
}

function sameAddress(a, b) {
  return isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
}

function isMainnetChain(rpcChainId) {
  return String(rpcChainId || "").toLowerCase() === "0x1";
}

function cleanHex(hex) {
  return (hex || "0x").replace(/^0x/, "");
}

function hasWords(hex, count) {
  return typeof hex === "string" && cleanHex(hex).length >= count * 64;
}

function decodeWord(hex, index = 0) {
  return cleanHex(hex).slice(index * 64, index * 64 + 64).padStart(64, "0");
}

function decodeUint(hex, index = 0) {
  return BigInt(`0x${decodeWord(hex, index)}`);
}

function decodeInt(hex, index = 0) {
  const value = decodeUint(hex, index);
  const signBit = 1n << 255n;
  return value >= signBit ? value - (1n << 256n) : value;
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

function word(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function addressWord(address) {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function bytes32Word(value) {
  return value.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function encodeAddress(selector, address) {
  return `${selector}${addressWord(address)}`;
}

function encodeAddressUintUint(selector, address, first, second) {
  return `${selector}${addressWord(address)}${word(first)}${word(second)}`;
}

function encodeAddressUint(selector, address, value) {
  return `${selector}${addressWord(address)}${word(value)}`;
}

function encodeAddressBytes32(selector, address, value) {
  return `${selector}${addressWord(address)}${bytes32Word(value)}`;
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

function wadText(value) {
  return `${weiToEthText(value).replace(/ ETH$/, "")}x`;
}

function bpsText(value) {
  return `${value.toString()} bps`;
}

function minBigInt(...values) {
  return values.reduce((best, value) => (value < best ? value : best));
}

function maxBigInt(...values) {
  return values.reduce((best, value) => (value > best ? value : best));
}

function divCeil(numerator, denominator) {
  return numerator === 0n ? 0n : ((numerator - 1n) / denominator) + 1n;
}

function priceFloorCostBps(priceWad) {
  return priceWad >= WAD ? 0n : divCeil((WAD - priceWad) * 10_000n, WAD);
}

function pricePremiumBps(priceWad) {
  return priceWad <= WAD ? 0n : divCeil((priceWad - WAD) * 10_000n, WAD);
}

function medianOracleMatchesMainnetConfig(oracleHealth) {
  if (!oracleHealth?.supported || oracleHealth.sourceCount !== 3n) return false;
  if (!sameAddress(oracleHealth.configuredFactory, oracleHealth.expectedFactory)) return false;
  if ((oracleHealth.poolConfigs || []).length !== MAINNET_MEDIAN_ORACLE_POOLS.length) return false;

  return MAINNET_MEDIAN_ORACLE_POOLS.every((expected, index) => {
    const actual = oracleHealth.poolConfigs[index];
    return (
      actual &&
      sameAddress(actual.pool, expected.pool) &&
      actual.priceAtTickZeroWad === expected.priceAtTickZeroWad &&
      actual.invertPrice === expected.invertPrice &&
      actual.minUsableTick === expected.minUsableTick &&
      actual.maxUsableTick === expected.maxUsableTick
    );
  });
}

function capacityFromExternalDemand(demandWei, demandBps, fillBps) {
  return (demandWei * 10_000n * 10_000n) / (BigInt(demandBps) * BigInt(fillBps));
}

function jsonSafe(value) {
  return JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item), 2);
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

async function optionalEthCall(rpcUrl, to, data) {
  try {
    return await ethCall(rpcUrl, to, data);
  } catch (error) {
    return { error: error.message };
  }
}

async function readManifest(manifestPath) {
  return JSON.parse(await fs.readFile(manifestPath, "utf8"));
}

function addCheck(checks, level, area, name, detail, evidence = {}) {
  checks.push({ level, area, name, detail, evidence });
}

function missingManifestKeys(manifest) {
  const missing = [];
  for (const key of REQUIRED_CONTRACTS) {
    if (!isAddress(manifest.contracts?.[key])) missing.push(`contracts.${key}`);
  }
  for (const key of REQUIRED_SERIES) {
    const value = manifest.series?.[key];
    const ok = key.endsWith("SeriesId") ? isBytes32(value) : isAddress(value);
    if (!ok) missing.push(`series.${key}`);
  }
  return missing;
}

async function checkCode(rpcUrl, checks, manifest) {
  const pairs = Object.entries(manifest.contracts || {}).filter(([, value]) => isAddress(value));
  for (const [key, address] of pairs) {
    const code = await rpcCall(rpcUrl, "eth_getCode", [address, "latest"]);
    addCheck(
      checks,
      code && code !== "0x" ? "pass" : "fail",
      "deployment",
      `${key} has bytecode`,
      code && code !== "0x" ? `${key} is deployed.` : `${key} has no code at ${address}.`,
      { address },
    );
  }
}

function decodeMarketHealth(raw) {
  return {
    market: decodeAddress(raw, 0),
    token: decodeAddress(raw, 1),
    lpToken: decodeAddress(raw, 2),
    feeBps: Number(decodeUint(raw, 3)),
    ethReserve: decodeUint(raw, 4),
    tokenReserve: decodeUint(raw, 5),
    sampleEthIn: decodeUint(raw, 6),
    sampleBuyTokenOut: decodeUint(raw, 7),
    sampleTokenIn: decodeUint(raw, 8),
    sampleSellEthOut: decodeUint(raw, 9),
    hasLiquidity: decodeBool(raw, 10),
  };
}

function decodeLpVaultHealth(raw) {
  return {
    vault: decodeAddress(raw, 0),
    share: decodeAddress(raw, 1),
    manager: decodeAddress(raw, 2),
    managedAssets: decodeUint(raw, 3),
    reservedEth: decodeUint(raw, 4),
    activeStrategyEth: decodeUint(raw, 5),
    maxEthPerRoll: decodeUint(raw, 6),
    maxActiveStrategyEth: decodeUint(raw, 7),
    maxRollPriceWad: decodeUint(raw, 8),
    minInventorySalePriceWad: hasWords(raw, 21) ? decodeUint(raw, 9) : 0n,
    minAuctionDuration: decodeUint(raw, hasWords(raw, 21) ? 10 : 9),
    minBackstopDelay: decodeUint(raw, hasWords(raw, 21) ? 11 : 10),
    minAuctionTimeLeft: decodeUint(raw, hasWords(raw, 21) ? 12 : 11),
    maxAuctionPriceDropBps: decodeUint(raw, hasWords(raw, 21) ? 13 : 12),
    inventorySeriesLength: decodeUint(raw, hasWords(raw, 21) ? 14 : 13),
    strategyUtilizationBps: decodeUint(raw, hasWords(raw, 21) ? 15 : 14),
    strategyActive: decodeBool(raw, hasWords(raw, 21) ? 16 : 15),
    depositsPaused: decodeBool(raw, hasWords(raw, 21) ? 17 : 16),
    totalShares: decodeUint(raw, hasWords(raw, 21) ? 18 : 17),
    sharePriceWad: decodeUint(raw, hasWords(raw, 21) ? 19 : 18),
    openInventorySeriesCount: hasWords(raw, 21) ? decodeUint(raw, 20) : hasWords(raw, 20) ? decodeUint(raw, 19) : null,
  };
}

function decodeLpInventoryHealth(raw) {
  return {
    vault: decodeAddress(raw, 0),
    index: decodeUint(raw, 1),
    factory: decodeAddress(raw, 2),
    seriesId: decodeBytes32(raw, 3),
    maturity: decodeUint(raw, 4),
    pToken: decodeAddress(raw, 5),
    nToken: decodeAddress(raw, 6),
    pBalance: decodeUint(raw, 7),
    nBalance: decodeUint(raw, 8),
    mergeableAmount: decodeUint(raw, 9),
    unpairedP: decodeUint(raw, 10),
    unpairedN: decodeUint(raw, 11),
    settlementPrice: decodeUint(raw, 12),
    settled: decodeBool(raw, 13),
    matured: decodeBool(raw, 14),
    hasInventory: decodeBool(raw, 15),
  };
}

function decodeWrapperHealth(raw) {
  return {
    vault: decodeAddress(raw, 0),
    share: decodeAddress(raw, 1),
    manager: decodeAddress(raw, 2),
    currentToken: decodeAddress(raw, 3),
    rollActive: decodeBool(raw, 4),
    totalAssets: decodeUint(raw, 5),
    rollAuction: decodeAddress(raw, 6),
    rollAuctionId: decodeUint(raw, 7),
    rollNextToken: decodeAddress(raw, 8),
    maxAssets: decodeUint(raw, 9),
    remainingCapacity: decodeUint(raw, 10),
    depositsPaused: hasWords(raw, 12) ? decodeBool(raw, 11) : false,
  };
}

function decodeSeriesHealth(raw) {
  return {
    seriesId: decodeBytes32(raw, 0),
    factory: decodeAddress(raw, 1),
    strike: decodeUint(raw, 2),
    maturity: decodeUint(raw, 3),
    twapWindow: decodeUint(raw, 4),
    capEth: decodeUint(raw, 5),
    openInterestEth: decodeUint(raw, 6),
    collateralEth: decodeUint(raw, 7),
    pToken: decodeAddress(raw, 8),
    nToken: decodeAddress(raw, 9),
    oracle: decodeAddress(raw, 10),
    settlementPrice: decodeUint(raw, 11),
    capUsedBps: decodeUint(raw, 12),
    settled: decodeBool(raw, 13),
    matured: decodeBool(raw, 14),
  };
}

function decodeAuctionPolicyHealth(raw) {
  return {
    auction: decodeAddress(raw, 0),
    guardian: decodeAddress(raw, 1),
    stopped: decodeUint(raw, 2),
    minSellAmount: decodeUint(raw, 3),
    minStaleResetDelay: decodeUint(raw, 4),
    minStaleResetPriceDropBps: decodeUint(raw, 5),
    activeAuctionCount: decodeUint(raw, 6),
    maxActiveAuctions: decodeUint(raw, 7),
    maxActiveAuctionsPerSeller: decodeUint(raw, 8),
    newAuctionsPaused: decodeBool(raw, 9),
    resetsPaused: decodeBool(raw, 10),
    fillsPaused: decodeBool(raw, 11),
  };
}

function decodeWrapperKeeperHealth(raw) {
  return {
    keeper: decodeAddress(raw, 0),
    vault: decodeAddress(raw, 1),
    factory: decodeAddress(raw, 2),
    auction: decodeAddress(raw, 3),
    boostedSide: decodeBool(raw, 4),
    currentSeriesId: decodeBytes32(raw, 5),
    pendingSeriesId: decodeBytes32(raw, 6),
    maxStartPriceWad: decodeUint(raw, 7),
    minEndPriceWad: decodeUint(raw, 8),
    minDuration: decodeUint(raw, 9),
    maxDuration: decodeUint(raw, 10),
    minRollSellAmount: decodeUint(raw, 11),
    maxRollSellAmount: decodeUint(raw, 12),
    keeperRewardEth: decodeUint(raw, 13),
    vaultSet: decodeBool(raw, 14),
    rollPending: decodeBool(raw, 15),
  };
}

async function readLpKeeperHealth(rpcUrl, lpKeeper) {
  const [vaultRaw, steadySellerRaw, boostedSellerRaw, sellersSetRaw] = await Promise.all([
    ethCall(rpcUrl, lpKeeper, SELECTORS.lpKeeperVault),
    ethCall(rpcUrl, lpKeeper, SELECTORS.lpKeeperSteadyRollSeller),
    ethCall(rpcUrl, lpKeeper, SELECTORS.lpKeeperBoostedRollSeller),
    ethCall(rpcUrl, lpKeeper, SELECTORS.lpKeeperRollSellersSet),
  ]);
  return {
    keeper: lpKeeper,
    vault: decodeAddress(vaultRaw),
    steadyRollSeller: decodeAddress(steadySellerRaw),
    boostedRollSeller: decodeAddress(boostedSellerRaw),
    rollSellersSet: decodeBool(sellersSetRaw),
  };
}

async function readSellerAuctionDiscovery(rpcUrl, rollAuction, seller) {
  if (!isAddress(rollAuction) || !isAddress(seller)) {
    return { count: 0n, visibleIds: [] };
  }
  const count = decodeUint(
    await ethCall(rpcUrl, rollAuction, `${SELECTORS.activeAuctionCountBySeller}${addressWord(seller)}`),
  );
  const visibleCount = Number(count > 24n ? 24n : count);
  const visibleIds = [];
  for (let index = 0; index < visibleCount; index += 1) {
    const data = `${SELECTORS.activeAuctionIdBySellerAt}${addressWord(seller)}${word(BigInt(index))}`;
    visibleIds.push(decodeUint(await ethCall(rpcUrl, rollAuction, data)));
  }
  return { count, visibleIds };
}

function decodeMedianPoolConfig(raw) {
  return {
    pool: decodeAddress(raw, 0),
    priceAtTickZeroWad: decodeUint(raw, 1),
    invertPrice: decodeBool(raw, 2),
    minUsableTick: decodeInt(raw, 3),
    maxUsableTick: decodeInt(raw, 4),
  };
}

function decodeOracleSeriesConfig(raw) {
  return {
    maturity: decodeUint(raw, 0),
    twapWindow: decodeUint(raw, 1),
    registered: decodeBool(raw, 2),
  };
}

async function readMedianOracleHealth(rpcUrl, oracle, factory, series) {
  if (!isAddress(oracle)) return { supported: false, error: "missing oracle address" };

  const [sourceCountRaw, factoryRaw] = await Promise.all([
    optionalEthCall(rpcUrl, oracle, SELECTORS.oracleSourceCount),
    optionalEthCall(rpcUrl, oracle, SELECTORS.oracleFactory),
  ]);
  if (typeof sourceCountRaw !== "string" || typeof factoryRaw !== "string") {
    return {
      supported: false,
      error: sourceCountRaw.error || factoryRaw.error || "oracle does not expose median-source metadata",
    };
  }
  if (!hasWords(sourceCountRaw, 1) || !hasWords(factoryRaw, 1)) {
    return { supported: false, error: "oracle does not expose median-source metadata" };
  }

  const sourceCount = decodeUint(sourceCountRaw);
  const configuredFactory = decodeAddress(factoryRaw);
  const visibleSourceCount = Number(sourceCount > 8n ? 8n : sourceCount);
  const poolConfigs = [];
  for (let index = 0; index < visibleSourceCount; index += 1) {
    const raw = await optionalEthCall(rpcUrl, oracle, `${SELECTORS.oraclePoolConfigs}${word(BigInt(index))}`);
    if (typeof raw !== "string") {
      return { supported: false, sourceCount, configuredFactory, poolConfigs, error: raw.error };
    }
    if (!hasWords(raw, 5)) {
      return { supported: false, sourceCount, configuredFactory, poolConfigs, error: "short pool config response" };
    }
    poolConfigs.push(decodeMedianPoolConfig(raw));
  }

  const seriesConfigs = {};
  for (const [key, item] of Object.entries(series || {})) {
    if (!isBytes32(item.seriesId)) continue;
    const raw = await optionalEthCall(rpcUrl, oracle, `${SELECTORS.oracleSeriesConfigs}${bytes32Word(item.seriesId)}`);
    if (typeof raw === "string" && hasWords(raw, 3)) {
      seriesConfigs[key] = decodeOracleSeriesConfig(raw);
    } else {
      seriesConfigs[key] = { registered: false, error: typeof raw === "string" ? "short series config response" : raw.error };
    }
  }

  return {
    supported: true,
    oracle,
    sourceCount,
    configuredFactory,
    expectedFactory: factory,
    poolConfigs,
    seriesConfigs,
  };
}

async function readHealth(rpcUrl, manifest, args) {
  const lens = manifest.contracts.healthLens;
  const lpVault = decodeLpVaultHealth(await ethCall(rpcUrl, lens, encodeAddress(SELECTORS.healthLpVault, manifest.contracts.lpVault)));
  const lpInventory = [];
  const inventoryLength = Number(lpVault.inventorySeriesLength > 24n ? 24n : lpVault.inventorySeriesLength);
  for (let index = 0; index < inventoryLength; index += 1) {
    lpInventory.push(
      decodeLpInventoryHealth(
        await ethCall(rpcUrl, lens, encodeAddressUint(SELECTORS.healthLpInventory, manifest.contracts.lpVault, BigInt(index))),
      ),
    );
  }

  const seriesHealth = {
    first: decodeSeriesHealth(await ethCall(rpcUrl, lens, encodeAddressBytes32(SELECTORS.healthSeries, manifest.contracts.factory, manifest.series.firstSeriesId))),
    second: decodeSeriesHealth(await ethCall(rpcUrl, lens, encodeAddressBytes32(SELECTORS.healthSeries, manifest.contracts.factory, manifest.series.secondSeriesId))),
  };

  const [steadySellerAuctions, boostedSellerAuctions, medianOracle] = await Promise.all([
    readSellerAuctionDiscovery(rpcUrl, manifest.contracts.rollAuction, manifest.contracts.steadyVault),
    readSellerAuctionDiscovery(rpcUrl, manifest.contracts.rollAuction, manifest.contracts.boostedVault),
    readMedianOracleHealth(rpcUrl, seriesHealth.first.oracle, manifest.contracts.factory, seriesHealth),
  ]);

  return {
    markets: {
      steady: decodeMarketHealth(
        await ethCall(rpcUrl, lens, encodeAddressUintUint(SELECTORS.healthMarket, manifest.contracts.steadyMarket, args.sampleTradeEthWei, args.sampleTradeEthWei)),
      ),
      boosted: decodeMarketHealth(
        await ethCall(rpcUrl, lens, encodeAddressUintUint(SELECTORS.healthMarket, manifest.contracts.boostedMarket, args.sampleTradeEthWei, args.sampleTradeEthWei)),
      ),
    },
    lpVault,
    lpInventory,
    wrappers: {
      steady: decodeWrapperHealth(await ethCall(rpcUrl, lens, encodeAddress(SELECTORS.healthWrapper, manifest.contracts.steadyVault))),
      boosted: decodeWrapperHealth(await ethCall(rpcUrl, lens, encodeAddress(SELECTORS.healthWrapper, manifest.contracts.boostedVault))),
    },
    series: seriesHealth,
    lpKeeper: await readLpKeeperHealth(rpcUrl, manifest.contracts.lpKeeper),
    auctionPolicy: decodeAuctionPolicyHealth(await ethCall(rpcUrl, lens, encodeAddress(SELECTORS.healthAuctionPolicy, manifest.contracts.rollAuction))),
    wrapperKeepers: {
      steady: decodeWrapperKeeperHealth(await ethCall(rpcUrl, lens, encodeAddress(SELECTORS.healthWrapperKeeper, manifest.contracts.steadyKeeper))),
      boosted: decodeWrapperKeeperHealth(await ethCall(rpcUrl, lens, encodeAddress(SELECTORS.healthWrapperKeeper, manifest.contracts.boostedKeeper))),
    },
    wrapperSellerAuctions: {
      steady: steadySellerAuctions,
      boosted: boostedSellerAuctions,
    },
    medianOracle,
  };
}

function checkManifestAndChain(checks, manifest, rpcChainId, args) {
  const missing = missingManifestKeys(manifest);
  addCheck(
    checks,
    missing.length ? "fail" : "pass",
    "manifest",
    "required addresses and series ids",
    missing.length ? `Missing or invalid: ${missing.join(", ")}.` : "Manifest has all required live addresses and series ids.",
    { missing },
  );

  if (manifest.chainId) {
    addCheck(
      checks,
      String(manifest.chainId).toLowerCase() === rpcChainId.toLowerCase() ? "pass" : "fail",
      "manifest",
      "manifest chain id matches RPC",
      `Manifest chain id ${manifest.chainId}; RPC chain id ${rpcChainId}.`,
      { manifestChainId: manifest.chainId, rpcChainId },
    );
  } else {
    addCheck(checks, "warn", "manifest", "manifest chain id present", "Manifest has no chain id.", { rpcChainId });
  }

  if (args.expectChainId) {
    addCheck(
      checks,
      args.expectChainId === rpcChainId.toLowerCase() ? "pass" : "fail",
      "manifest",
      "expected chain id",
      `Expected ${args.expectChainId}; RPC returned ${rpcChainId}.`,
      { expected: args.expectChainId, rpcChainId },
    );
  }
}

function checkMarkets(checks, health, args) {
  for (const [key, market] of Object.entries(health.markets)) {
    const label = key === "boosted" ? "Boosted ETH" : "Steady ETH";
    addCheck(
      checks,
      market.hasLiquidity ? "pass" : "fail",
      "trader",
      `${label} market has liquidity`,
      market.hasLiquidity
        ? `${label} market has ${weiToEthText(market.ethReserve)} and ${weiToEthText(market.tokenReserve)} token reserve.`
        : `${label} market has no usable liquidity.`,
      { market: market.market, ethReserve: market.ethReserve, tokenReserve: market.tokenReserve },
    );
    addCheck(
      checks,
      market.ethReserve >= args.minMarketEthWei ? "pass" : "warn",
      "trader",
      `${label} market depth`,
      `${label} market ETH reserve is ${weiToEthText(market.ethReserve)}; target is ${weiToEthText(args.minMarketEthWei)}.`,
      { market: market.market, ethReserve: market.ethReserve, minMarketEth: args.minMarketEthWei },
    );
    addCheck(
      checks,
      market.sampleBuyTokenOut > 0n && market.sampleSellEthOut > 0n ? "pass" : "fail",
      "trader",
      `${label} buy/sell quotes`,
      `Sample buy returns ${weiToEthText(market.sampleBuyTokenOut)}; sample sell returns ${weiToEthText(market.sampleSellEthOut)}.`,
      { sampleEthIn: market.sampleEthIn, sampleBuyTokenOut: market.sampleBuyTokenOut, sampleSellEthOut: market.sampleSellEthOut },
    );
    addCheck(
      checks,
      market.feeBps <= args.maxMarketFeeBps ? "pass" : "warn",
      "trader",
      `${label} market fee`,
      `Fee is ${bpsText(BigInt(market.feeBps))}; target max is ${args.maxMarketFeeBps} bps.`,
      { feeBps: market.feeBps, maxMarketFeeBps: args.maxMarketFeeBps },
    );
  }
}

function checkLpVault(checks, manifest, health, args) {
  const vault = health.lpVault;
  const keeper = health.lpKeeper;
  const visibleInventory = health.lpInventory || [];
  const openInventory = visibleInventory.filter((item) => item.hasInventory);
  const directMergeable = openInventory.filter((item) => !item.settled && item.mergeableAmount > 0n);
  const directRedeemable = openInventory.filter((item) => item.settled && (item.pBalance > 0n || item.nBalance > 0n));
  const residualUnsettled = openInventory.filter((item) => !item.settled && (item.unpairedP > 0n || item.unpairedN > 0n));
  addCheck(
    checks,
    sameAddress(vault.manager, manifest.contracts.lpKeeper) ? "pass" : "fail",
    "lp",
    "LP vault manager is permissionless keeper",
    `LP vault manager is ${vault.manager}; expected lpKeeper ${manifest.contracts.lpKeeper}.`,
    { manager: vault.manager, lpKeeper: manifest.contracts.lpKeeper },
  );
  addCheck(
    checks,
    sameAddress(keeper.vault, manifest.contracts.lpVault) ? "pass" : "fail",
    "lp",
    "LP keeper is attached to vault",
    `LP keeper vault is ${keeper.vault}; expected ${manifest.contracts.lpVault}.`,
    { keeper: keeper.keeper, keeperVault: keeper.vault, expectedVault: manifest.contracts.lpVault },
  );
  const allowedRollSellers =
    keeper.rollSellersSet &&
    sameAddress(keeper.steadyRollSeller, manifest.contracts.steadyVault) &&
    sameAddress(keeper.boostedRollSeller, manifest.contracts.boostedVault);
  addCheck(
    checks,
    allowedRollSellers ? "pass" : "fail",
    "lp",
    "LP keeper only backstops protocol wrapper rolls",
    allowedRollSellers
      ? "LP keeper roll sellers are pinned to the Steady and Boosted wrappers."
      : `LP keeper roll sellers are steady=${keeper.steadyRollSeller}, boosted=${keeper.boostedRollSeller}; expected ${manifest.contracts.steadyVault} and ${manifest.contracts.boostedVault}.`,
    {
      rollSellersSet: keeper.rollSellersSet,
      steadyRollSeller: keeper.steadyRollSeller,
      boostedRollSeller: keeper.boostedRollSeller,
      expectedSteadyVault: manifest.contracts.steadyVault,
      expectedBoostedVault: manifest.contracts.boostedVault,
    },
  );
  addCheck(
    checks,
    vault.managedAssets >= args.minLpEthWei ? "pass" : "warn",
    "lp",
    "LP vault has starter capital",
    `Managed assets are ${weiToEthText(vault.managedAssets)}; target is ${weiToEthText(args.minLpEthWei)}.`,
    { managedAssets: vault.managedAssets, minLpEth: args.minLpEthWei },
  );
  addCheck(
    checks,
    vault.sharePriceWad > 0n && (vault.totalShares > 0n || vault.managedAssets === 0n) ? "pass" : "fail",
    "lp",
    "LP share price is readable",
    vault.totalShares > 0n
      ? `Share price is ${weiToEthText(vault.sharePriceWad)} per LP share with ${weiToEthText(vault.totalShares)} shares.`
      : "Vault has no shares yet; initial share price is 1 ETH.",
    { totalShares: vault.totalShares, sharePriceWad: vault.sharePriceWad },
  );
  addCheck(
    checks,
    !vault.depositsPaused ? "pass" : "warn",
    "lp",
    "LP deposits are open",
    vault.depositsPaused
      ? `Deposits are paused while ${weiToEthText(vault.activeStrategyEth)} is in strategy inventory.`
      : "Deposits and withdrawal requests are open.",
    { depositsPaused: vault.depositsPaused, activeStrategyEth: vault.activeStrategyEth },
  );
  addCheck(
    checks,
    vault.inventorySeriesLength <= 24n && BigInt(visibleInventory.length) === vault.inventorySeriesLength ? "pass" : "warn",
    "lp",
    "LP inventory state is publicly readable",
    vault.inventorySeriesLength > 24n
      ? `Vault tracks ${vault.inventorySeriesLength.toString()} inventory series; readiness output is capped at 24.`
      : `Read ${visibleInventory.length.toString()} tracked inventory series from ProtocolHealthLens.`,
    { inventorySeriesLength: vault.inventorySeriesLength, visibleInventoryLength: visibleInventory.length },
  );
  addCheck(
    checks,
    vault.openInventorySeriesCount === null || vault.openInventorySeriesCount === BigInt(openInventory.length)
      ? "pass"
      : "warn",
    "lp",
    "LP open inventory counter matches visible balances",
    vault.openInventorySeriesCount === null
      ? "ProtocolHealthLens does not expose open inventory count on this deployment."
      : `Vault open inventory counter is ${vault.openInventorySeriesCount.toString()}; visible open inventory entries are ${openInventory.length.toString()}.`,
    { openInventorySeriesCount: vault.openInventorySeriesCount, visibleOpenInventoryLength: openInventory.length },
  );
  addCheck(
    checks,
    !vault.strategyActive || openInventory.length > 0 ? "pass" : "fail",
    "lp",
    "active LP strategy has visible inventory",
    vault.strategyActive
      ? `Strategy is active with ${openInventory.length.toString()} inventory entries carrying P/N balances.`
      : "Strategy is idle with no active roll inventory requirement.",
    {
      strategyActive: vault.strategyActive,
      openInventory: openInventory.map((item) => ({
        seriesId: item.seriesId,
        pBalance: item.pBalance,
        nBalance: item.nBalance,
        mergeableAmount: item.mergeableAmount,
        unpairedP: item.unpairedP,
        unpairedN: item.unpairedN,
        settled: item.settled,
        matured: item.matured,
      })),
    },
  );
  addCheck(
    checks,
    residualUnsettled.length === 0 ? "pass" : "warn",
    "lp",
    "LP inventory cleanup path",
    openInventory.length === 0
      ? "No tracked LP inventory needs cleanup."
      : residualUnsettled.length === 0
        ? `${directMergeable.length.toString()} tracked series can merge matched P+N or ${directRedeemable.length.toString()} settled series can redeem directly.`
        : `${directMergeable.length.toString()} tracked series have mergeable matched P+N and ${directRedeemable.length.toString()} settled series can redeem directly; ${residualUnsettled.length.toString()} unsettled series still has unpaired inventory that needs AMM liquidity or another counterparty.`,
    {
      directMergeable: directMergeable.map((item) => ({ seriesId: item.seriesId, mergeableAmount: item.mergeableAmount })),
      directRedeemable: directRedeemable.map((item) => ({
        seriesId: item.seriesId,
        pBalance: item.pBalance,
        nBalance: item.nBalance,
      })),
      residualUnsettled: residualUnsettled.map((item) => ({
        seriesId: item.seriesId,
        unpairedP: item.unpairedP,
        unpairedN: item.unpairedN,
      })),
    },
  );
  addCheck(
    checks,
    vault.minBackstopDelay > 0n ? "pass" : "warn",
    "solver",
    "solver-first backstop delay",
    `LP backstop delay is ${vault.minBackstopDelay.toString()} seconds.`,
    { minBackstopDelay: vault.minBackstopDelay },
  );
  addCheck(
    checks,
    vault.maxEthPerRoll > 0n && vault.maxActiveStrategyEth >= vault.maxEthPerRoll ? "pass" : "fail",
    "lp",
    "LP strategy caps are coherent",
    `maxEthPerRoll=${weiToEthText(vault.maxEthPerRoll)}, maxActiveStrategyEth=${weiToEthText(vault.maxActiveStrategyEth)}.`,
    { maxEthPerRoll: vault.maxEthPerRoll, maxActiveStrategyEth: vault.maxActiveStrategyEth },
  );
  const lpPremiumBps = pricePremiumBps(vault.maxRollPriceWad);
  addCheck(
    checks,
    lpPremiumBps <= BigInt(args.maxLpRollPremiumBps) ? "pass" : "fail",
    "sustainability",
    "LP backstop does not pay a normal-roll premium",
    `LP max roll price is ${wadText(vault.maxRollPriceWad)} (${lpPremiumBps.toString()} bps premium); target max is ${args.maxLpRollPremiumBps} bps.`,
    { maxRollPriceWad: vault.maxRollPriceWad, lpPremiumBps, maxLpRollPremiumBps: args.maxLpRollPremiumBps },
  );
  addCheck(
    checks,
    vault.maxAuctionPriceDropBps <= BigInt(args.maxNormalRollCostBps) ? "pass" : "fail",
    "sustainability",
    "LP backstop decay stays within normal-roll target",
    `LP backstop accepts at most ${vault.maxAuctionPriceDropBps.toString()} bps Dutch decay; target max is ${args.maxNormalRollCostBps} bps.`,
    { maxAuctionPriceDropBps: vault.maxAuctionPriceDropBps, maxNormalRollCostBps: args.maxNormalRollCostBps },
  );
  const inventorySaleCostBps = priceFloorCostBps(vault.minInventorySalePriceWad);
  addCheck(
    checks,
    inventorySaleCostBps <= BigInt(args.maxNormalRollCostBps) ? "pass" : "fail",
    "sustainability",
    "LP inventory sales cannot dump below normal-roll target",
    `LP inventory sale floor is ${wadText(vault.minInventorySalePriceWad)} (${inventorySaleCostBps.toString()} bps max discount); target max is ${args.maxNormalRollCostBps} bps.`,
    {
      minInventorySalePriceWad: vault.minInventorySalePriceWad,
      inventorySaleCostBps,
      maxNormalRollCostBps: args.maxNormalRollCostBps,
    },
  );
}

function checkWrappers(checks, manifest, health, args) {
  for (const [key, wrapper] of Object.entries(health.wrappers)) {
    const keeper = health.wrapperKeepers[key];
    const label = key === "boosted" ? "Boosted ETH" : "Steady ETH";
    const expectedVault = key === "boosted" ? manifest.contracts.boostedVault : manifest.contracts.steadyVault;
    const expectedKeeper = key === "boosted" ? manifest.contracts.boostedKeeper : manifest.contracts.steadyKeeper;
    const expectedToken = key === "boosted" ? manifest.series.firstN : manifest.series.firstP;
    const sellerDiscovery = health.wrapperSellerAuctions?.[key] || { count: 0n, visibleIds: [] };
    const sellerVisibleIds = sellerDiscovery.visibleIds || [];
    const activeRollDiscoverable = sellerVisibleIds.some((auctionId) => auctionId === wrapper.rollAuctionId);

    addCheck(
      checks,
      sameAddress(wrapper.manager, expectedKeeper) ? "pass" : "fail",
      "wrapper",
      `${label} wrapper manager is keeper`,
      `${label} manager is ${wrapper.manager}; expected ${expectedKeeper}.`,
      { manager: wrapper.manager, expectedKeeper },
    );
    addCheck(
      checks,
      keeper.vaultSet && sameAddress(keeper.vault, expectedVault) ? "pass" : "fail",
      "wrapper",
      `${label} keeper attached to wrapper`,
      `${label} keeper vault is ${keeper.vault}; expected ${expectedVault}.`,
      { keeper: keeper.keeper, vault: keeper.vault, expectedVault },
    );
    addCheck(
      checks,
      sameAddress(keeper.factory, manifest.contracts.factory) && sameAddress(keeper.auction, manifest.contracts.rollAuction) ? "pass" : "fail",
      "wrapper",
      `${label} keeper uses core factory and auction`,
      `${label} keeper factory=${keeper.factory}, auction=${keeper.auction}.`,
      { factory: keeper.factory, auction: keeper.auction },
    );
    addCheck(
      checks,
      keeper.minRollSellAmount > 0n && keeper.maxRollSellAmount >= keeper.minRollSellAmount ? "pass" : "fail",
      "wrapper",
      `${label} roll size policy is coherent`,
      `${label} min roll is ${weiToEthText(keeper.minRollSellAmount)}; max roll is ${weiToEthText(keeper.maxRollSellAmount)}.`,
      { minRollSellAmount: keeper.minRollSellAmount, maxRollSellAmount: keeper.maxRollSellAmount },
    );
    addCheck(
      checks,
      wrapper.maxAssets > 0n && wrapper.maxAssets <= keeper.maxRollSellAmount ? "pass" : "fail",
      "sustainability",
      `${label} deposit capacity is inside roll capacity`,
      `${label} wrapper cap is ${weiToEthText(wrapper.maxAssets)}; keeper max roll is ${weiToEthText(keeper.maxRollSellAmount)}.`,
      {
        maxAssets: wrapper.maxAssets,
        remainingCapacity: wrapper.remainingCapacity,
        maxRollSellAmount: keeper.maxRollSellAmount,
      },
    );
    addCheck(
      checks,
      !wrapper.depositsPaused ? "pass" : "warn",
      "sustainability",
      `${label} deposit growth is open`,
      wrapper.depositsPaused
        ? `${label} deposits are paused after a failed or unresolved roll; existing redemptions and keeper roll retries remain available.`
        : `${label} can accept deposits up to ${weiToEthText(wrapper.remainingCapacity)} of remaining capacity.`,
      { depositsPaused: wrapper.depositsPaused, remainingCapacity: wrapper.remainingCapacity },
    );
    addCheck(
      checks,
      keeper.maxStartPriceWad > 0n &&
        keeper.minEndPriceWad > 0n &&
        keeper.minEndPriceWad <= keeper.maxStartPriceWad &&
        keeper.minDuration > 0n &&
        keeper.maxDuration >= keeper.minDuration
        ? "pass"
        : "fail",
      "wrapper",
      `${label} roll price and duration policy is coherent`,
      `${label} start ceiling ${wadText(keeper.maxStartPriceWad)}, floor minimum ${wadText(keeper.minEndPriceWad)}, duration ${keeper.minDuration.toString()}-${keeper.maxDuration.toString()} seconds.`,
      {
        maxStartPriceWad: keeper.maxStartPriceWad,
        minEndPriceWad: keeper.minEndPriceWad,
        minDuration: keeper.minDuration,
        maxDuration: keeper.maxDuration,
      },
    );
    const floorCostBps = priceFloorCostBps(keeper.minEndPriceWad);
    addCheck(
      checks,
      floorCostBps <= BigInt(args.maxNormalRollCostBps) ? "pass" : "fail",
      "sustainability",
      `${label} normal roll floor stays within target cost`,
      `${label} roll floor is ${wadText(keeper.minEndPriceWad)} (${floorCostBps.toString()} bps max cost); target max is ${args.maxNormalRollCostBps} bps.`,
      {
        minEndPriceWad: keeper.minEndPriceWad,
        floorCostBps,
        maxNormalRollCostBps: args.maxNormalRollCostBps,
      },
    );
    addCheck(
      checks,
      !keeper.rollPending || isBytes32(keeper.pendingSeriesId) ? "pass" : "fail",
      "wrapper",
      `${label} roll state is coherent`,
      keeper.rollPending
        ? `${label} roll is pending against ${keeper.pendingSeriesId}.`
        : `${label} wrapper is idle; public runners pass the next series when starting a roll.`,
      { rollPending: keeper.rollPending, pendingSeriesId: keeper.pendingSeriesId },
    );
    addCheck(
      checks,
      sameAddress(wrapper.currentToken, expectedToken) || wrapper.rollActive ? "pass" : "warn",
      "wrapper",
      `${label} current token matches first series or is rolling`,
      `${label} current token is ${wrapper.currentToken}; expected first-series token ${expectedToken} before first roll.`,
      { currentToken: wrapper.currentToken, expectedToken, rollActive: wrapper.rollActive },
    );
    addCheck(
      checks,
      health.auctionPolicy.maxActiveAuctionsPerSeller > 0n &&
        sellerDiscovery.count <= health.auctionPolicy.maxActiveAuctionsPerSeller
        ? "pass"
        : "fail",
      "solver",
      `${label} seller auction queue is bounded`,
      `${label} wrapper seller exposes ${sellerDiscovery.count.toString()} active auction(s), max ${health.auctionPolicy.maxActiveAuctionsPerSeller.toString()} per seller.`,
      {
        seller: expectedVault,
        count: sellerDiscovery.count,
        maxActiveAuctionsPerSeller: health.auctionPolicy.maxActiveAuctionsPerSeller,
        visibleIds: sellerVisibleIds,
      },
    );
    addCheck(
      checks,
      wrapper.rollActive
        ? activeRollDiscoverable
          ? "pass"
          : "fail"
        : sellerDiscovery.count === 0n
          ? "pass"
          : "fail",
      "solver",
      wrapper.rollActive
        ? `${label} active roll is seller-discoverable`
        : `${label} seller has no orphan active auctions`,
      wrapper.rollActive
        ? `${label} roll auction ${wrapper.rollAuctionId.toString()} is ${activeRollDiscoverable ? "visible" : "missing"} in the wrapper seller queue.`
        : sellerDiscovery.count === 0n
          ? `${label} wrapper is idle and has no active seller auctions.`
          : `${label} wrapper is idle but seller queue still exposes ${sellerDiscovery.count.toString()} active auction(s).`,
      {
        rollActive: wrapper.rollActive,
        rollAuctionId: wrapper.rollAuctionId,
        seller: expectedVault,
        visibleIds: sellerVisibleIds,
      },
    );
  }
}

function checkAuctionAndSeries(checks, manifest, health, args) {
  const policy = health.auctionPolicy;
  const guardianDisabled = isZeroAddress(policy.guardian);
  addCheck(
    checks,
    guardianDisabled ? "pass" : "fail",
    "decentralized",
    "auction guardian is disabled",
    guardianDisabled
      ? "RollAuction guardian is address(0), so admin setters are permanently disabled."
      : `RollAuction guardian is ${policy.guardian}; MVP readiness requires address(0).`,
    { guardian: policy.guardian },
  );
  addCheck(
    checks,
    !policy.newAuctionsPaused ? "pass" : "fail",
    "solver",
    "new roll auctions are not paused",
    `Auction circuit-breaker level is ${policy.stopped.toString()}; new auctions paused=${policy.newAuctionsPaused}.`,
    { stopped: policy.stopped, newAuctionsPaused: policy.newAuctionsPaused },
  );
  addCheck(
    checks,
    !policy.resetsPaused ? "pass" : "fail",
    "solver",
    "roll auction resets are not paused",
    `Auction circuit-breaker level is ${policy.stopped.toString()}; resets paused=${policy.resetsPaused}.`,
    { stopped: policy.stopped, resetsPaused: policy.resetsPaused },
  );
  addCheck(
    checks,
    policy.stopped < 3n ? "pass" : "fail",
    "solver",
    "auction fills are not paused",
    `Auction circuit-breaker level is ${policy.stopped.toString()}.`,
    { stopped: policy.stopped },
  );
  addCheck(
    checks,
    policy.minSellAmount > 0n ? "pass" : "fail",
    "solver",
    "auction dust threshold configured",
    `Minimum auction/fill size is ${weiToEthText(policy.minSellAmount)}.`,
    { minSellAmount: policy.minSellAmount },
  );
  addCheck(
    checks,
    isAddress(manifest.contracts.rollSolver) ? "pass" : "fail",
    "solver",
    "external solver helper is available",
    `RollSolver is ${manifest.contracts.rollSolver}.`,
    { rollSolver: manifest.contracts.rollSolver },
  );
  const staleResetHasDelay = policy.minStaleResetPriceDropBps === 0n || policy.minStaleResetDelay > 0n;
  const staleResetWithinNormalBand =
    policy.minStaleResetPriceDropBps === 0n ||
    policy.minStaleResetPriceDropBps <= BigInt(args.maxNormalRollCostBps);
  addCheck(
    checks,
    staleResetHasDelay && staleResetWithinNormalBand ? "pass" : "warn",
    "solver",
    "stale reset policy coherent",
    `minStaleResetDelay=${policy.minStaleResetDelay.toString()} seconds, minStaleResetPriceDropBps=${policy.minStaleResetPriceDropBps.toString()}; normal roll target is ${args.maxNormalRollCostBps} bps.`,
    {
      minStaleResetDelay: policy.minStaleResetDelay,
      minStaleResetPriceDropBps: policy.minStaleResetPriceDropBps,
      maxNormalRollCostBps: args.maxNormalRollCostBps,
    },
  );
  addCheck(
    checks,
    policy.maxActiveAuctions > 0n &&
      policy.maxActiveAuctionsPerSeller > 0n &&
      policy.activeAuctionCount <= policy.maxActiveAuctions
      ? "pass"
      : "fail",
    "solver",
    "active auction discovery is bounded",
    `RollAuction reports ${policy.activeAuctionCount.toString()} active auction(s) of max ${policy.maxActiveAuctions.toString()}, with max ${policy.maxActiveAuctionsPerSeller.toString()} per seller.`,
    {
      activeAuctionCount: policy.activeAuctionCount,
      maxActiveAuctions: policy.maxActiveAuctions,
      maxActiveAuctionsPerSeller: policy.maxActiveAuctionsPerSeller,
    },
  );

  for (const [key, series] of Object.entries(health.series)) {
    addCheck(
      checks,
      series.capEth > 0n && series.openInterestEth <= series.capEth ? "pass" : "fail",
      "risk",
      `${key} series cap is valid`,
      `${key} open interest is ${weiToEthText(series.openInterestEth)} of cap ${weiToEthText(series.capEth)}.`,
      { openInterestEth: series.openInterestEth, capEth: series.capEth },
    );
    addCheck(
      checks,
      series.capUsedBps <= BigInt(args.maxCapUsedBps) ? "pass" : "warn",
      "risk",
      `${key} series has remaining cap room`,
      `${key} cap usage is ${series.capUsedBps.toString()} bps; warning threshold is ${args.maxCapUsedBps} bps.`,
      { capUsedBps: series.capUsedBps, maxCapUsedBps: args.maxCapUsedBps },
    );
    addCheck(
      checks,
      !series.matured || series.settled ? "pass" : "warn",
      "risk",
      `${key} series settlement status`,
      series.matured && !series.settled
        ? `${key} series is matured but not settled.`
        : `${key} series is ${series.settled ? "settled" : "not yet matured"}.`,
      { matured: series.matured, settled: series.settled, maturity: series.maturity },
    );
    addCheck(
      checks,
      isAddress(series.oracle) ? "pass" : "fail",
      "risk",
      `${key} series has settlement oracle`,
      `${key} series oracle is ${series.oracle}.`,
      { oracle: series.oracle },
    );
    addCheck(
      checks,
      series.twapWindow >= args.minSettlementTwapSeconds ? "pass" : "fail",
      "risk",
      `${key} series settlement TWAP window is long enough`,
      `${key} TWAP window is ${(series.twapWindow / 3600n).toString()}h; minimum is ${(args.minSettlementTwapSeconds / 3600n).toString()}h.`,
      { twapWindow: series.twapWindow, minSettlementTwapSeconds: args.minSettlementTwapSeconds },
    );
  }

  const firstSeries = health.series.first;
  const secondSeries = health.series.second;
  addCheck(
    checks,
    secondSeries.maturity > firstSeries.maturity ? "pass" : "fail",
    "risk",
    "normal wrapper roll advances maturity",
    `First maturity=${firstSeries.maturity.toString()}; second maturity=${secondSeries.maturity.toString()}.`,
    { firstMaturity: firstSeries.maturity, secondMaturity: secondSeries.maturity },
  );
  addCheck(
    checks,
    firstSeries.strike === secondSeries.strike ? "pass" : "fail",
    "risk",
    "normal wrapper roll keeps the same strike",
    `First strike=${firstSeries.strike.toString()}; second strike=${secondSeries.strike.toString()}.`,
    { firstStrike: firstSeries.strike, secondStrike: secondSeries.strike },
  );
  addCheck(
    checks,
    firstSeries.twapWindow === secondSeries.twapWindow ? "pass" : "fail",
    "risk",
    "normal wrapper roll keeps the same TWAP window",
    `First TWAP window=${firstSeries.twapWindow.toString()}s; second TWAP window=${secondSeries.twapWindow.toString()}s.`,
    { firstTwapWindow: firstSeries.twapWindow, secondTwapWindow: secondSeries.twapWindow },
  );
  addCheck(
    checks,
    sameAddress(firstSeries.oracle, secondSeries.oracle) ? "pass" : "fail",
    "risk",
    "normal wrapper roll keeps the same oracle",
    `First oracle=${firstSeries.oracle}; second oracle=${secondSeries.oracle}.`,
    { firstOracle: firstSeries.oracle, secondOracle: secondSeries.oracle },
  );
}

function medianOracleReady(manifest, health) {
  const oracle = health.medianOracle;
  if (!oracle?.supported || oracle.sourceCount !== 3n) return false;
  if (!sameAddress(oracle.configuredFactory, manifest.contracts.factory)) return false;

  return Object.entries(health.series).every(([key, series]) => {
    const registration = oracle.seriesConfigs?.[key];
    return (
      registration?.registered &&
      registration.maturity === series.maturity &&
      registration.twapWindow === series.twapWindow
    );
  });
}

function checkSettlementOracles(checks, manifest, health, rpcChainId, args) {
  const firstOracle = health.series.first.oracle;
  const secondOracle = health.series.second.oracle;
  const mainnet = isMainnetChain(rpcChainId);
  const medianRequired = mainnet || args.requireMedianOracle;
  const medianOracle = health.medianOracle;
  const medianMatches = medianOracleMatchesMainnetConfig(medianOracle);

  addCheck(
    checks,
    isAddress(firstOracle) && sameAddress(firstOracle, secondOracle) ? "pass" : "fail",
    "risk",
    "series share one settlement oracle",
    `First series oracle=${firstOracle}; second series oracle=${secondOracle}.`,
    { firstOracle, secondOracle },
  );

  if (!medianRequired && !medianOracle?.supported) {
    addCheck(
      checks,
      "pass",
      "risk",
      "non-mainnet settlement oracle accepted",
      "This is not Ethereum mainnet, so readiness allows the local/mock settlement oracle.",
      { rpcChainId, oracle: firstOracle },
    );
    return;
  }

  addCheck(
    checks,
    medianOracle?.supported ? "pass" : medianRequired ? "fail" : "warn",
    "risk",
    "settlement oracle exposes median source metadata",
    medianOracle?.supported
      ? `Oracle exposes ${medianOracle.sourceCount.toString()} source(s) and factory ${medianOracle.configuredFactory}.`
      : args.requireMedianOracle
        ? `Median oracle is required, but this oracle does not expose median source metadata: ${medianOracle?.error || "unknown error"}.`
        : `Oracle does not expose median source metadata: ${medianOracle?.error || "unknown error"}.`,
    { oracle: firstOracle, medianOracle, requireMedianOracle: args.requireMedianOracle },
  );

  if (!medianOracle?.supported) return;

  addCheck(
    checks,
    sameAddress(medianOracle.configuredFactory, manifest.contracts.factory) ? "pass" : "fail",
    "risk",
    "settlement oracle is bound to factory",
    `Oracle factory is ${medianOracle.configuredFactory}; expected ${manifest.contracts.factory}.`,
    { configuredFactory: medianOracle.configuredFactory, expectedFactory: manifest.contracts.factory },
  );

  addCheck(
    checks,
    medianOracle.sourceCount === 3n ? "pass" : "fail",
    "risk",
    "settlement oracle has three stable sources",
    `Oracle reports ${medianOracle.sourceCount.toString()} source(s).`,
    { sourceCount: medianOracle.sourceCount },
  );

  for (const [key, series] of Object.entries(health.series)) {
    const registration = medianOracle.seriesConfigs?.[key];
    const registered =
      registration?.registered &&
      registration.maturity === series.maturity &&
      registration.twapWindow === series.twapWindow;
    addCheck(
      checks,
      registered ? "pass" : "fail",
      "risk",
      `${key} series is registered in settlement oracle`,
      registered
        ? `${key} series maturity/window are registered in the oracle.`
        : `${key} series registration mismatch or missing.`,
      {
        seriesId: series.seriesId,
        seriesMaturity: series.maturity,
        seriesTwapWindow: series.twapWindow,
        registration,
      },
    );
  }

  if (mainnet) {
    addCheck(
      checks,
      medianMatches ? "pass" : "fail",
      "risk",
      "mainnet settlement oracle uses USDC USDT DAI median",
      medianMatches
        ? "Oracle source pools and conversion bounds match the bounded USDC, USDT, and DAI mainnet config."
        : "Oracle source pools or conversion bounds do not match the bounded mainnet median config.",
      { expectedPools: MAINNET_MEDIAN_ORACLE_POOLS, actualPools: medianOracle.poolConfigs },
    );
  } else if (args.requireMedianOracle) {
    addCheck(
      checks,
      medianOracleReady(manifest, health) ? "pass" : "fail",
      "risk",
      "settlement oracle satisfies required median gate",
      medianOracleReady(manifest, health)
        ? "Non-mainnet readiness requires and found a registered 3-source median settlement oracle."
        : "Median oracle is required, but source count, factory binding, or series registrations are incomplete.",
      { medianOracle, requireMedianOracle: args.requireMedianOracle },
    );
  } else if (medianMatches) {
    addCheck(
      checks,
      "pass",
      "risk",
      "settlement oracle matches bounded median config",
      "Non-mainnet deployment uses the same USDC, USDT, and DAI median source config.",
      { expectedPools: MAINNET_MEDIAN_ORACLE_POOLS, actualPools: medianOracle.poolConfigs },
    );
  }
}

function capacityLevel(ok, args) {
  return ok ? "pass" : args.capacityStrict ? "fail" : "warn";
}

function checkCapacityPolicy(checks, health, args) {
  const visibleBoostedMarketDemand = health.markets.boosted.ethReserve;
  const externalDemand =
    visibleBoostedMarketDemand + args.boostedDemandWei + args.solverFloatWei;
  const lpCap = (health.lpVault.managedAssets * 10_000n) / BigInt(args.capacityRlpRatioBps);
  const avgDemandCap = capacityFromExternalDemand(
    externalDemand,
    args.capacityAvgNDemandBps,
    args.capacityNFillBps,
  );
  const stressDemandCap = capacityFromExternalDemand(
    externalDemand,
    args.capacityStressNDemandBps,
    args.capacityNFillBps,
  );
  const launchCap = args.noSolverLaunch ? lpCap : minBigInt(lpCap, avgDemandCap);
  const stressCap = args.noSolverLaunch ? lpCap : minBigInt(lpCap, stressDemandCap);
  const steadyRollCap = health.wrapperKeepers.steady.maxRollSellAmount;
  const boostedRollCap = health.wrapperKeepers.boosted.maxRollSellAmount;
  const maxSeriesCap = maxBigInt(health.series.first.capEth, health.series.second.capEth);

  addCheck(
    checks,
    "pass",
    "sustainability",
    "capacity policy inputs are explicit",
    `${args.noSolverLaunch ? "No-solver launch mode: LP vault capital is the blocking capacity gate. " : ""}Visible Boosted market ETH is ${weiToEthText(visibleBoostedMarketDemand)}; additional Boosted demand is ${weiToEthText(args.boostedDemandWei)}; solver float is ${weiToEthText(args.solverFloatWei)}.`,
    {
      noSolverLaunch: args.noSolverLaunch,
      visibleBoostedMarketDemand,
      committedBoostedDemand: args.boostedDemandWei,
      solverFloat: args.solverFloatWei,
      externalDemand,
      capacityRlpRatioBps: args.capacityRlpRatioBps,
      capacityNFillBps: args.capacityNFillBps,
      capacityAvgNDemandBps: args.capacityAvgNDemandBps,
      capacityStressNDemandBps: args.capacityStressNDemandBps,
    },
  );
  addCheck(
    checks,
    "pass",
    "sustainability",
    "sustainable launch cap estimate",
    `Estimated launch cap is ${weiToEthText(launchCap)}; stress cap is ${weiToEthText(stressCap)}; LP-cap component is ${weiToEthText(lpCap)}${args.noSolverLaunch ? "; external demand cap is advisory in no-solver mode" : ""}.`,
    { launchCap, stressCap, lpCap, avgDemandCap, stressDemandCap },
  );
  addCheck(
    checks,
    capacityLevel(steadyRollCap <= launchCap, args),
    "sustainability",
    args.noSolverLaunch ? "Steady wrapper cap fits LP liquidity engine" : "Steady wrapper cap fits committed liquidity",
    `Steady max roll cap is ${weiToEthText(steadyRollCap)}; estimated launch cap is ${weiToEthText(launchCap)}.`,
    { steadyRollCap, launchCap, lpCap, avgDemandCap },
  );
  addCheck(
    checks,
    capacityLevel(steadyRollCap <= stressCap, args),
    "sustainability",
    "Steady wrapper cap fits stress demand",
    `Steady max roll cap is ${weiToEthText(steadyRollCap)}; stress cap is ${weiToEthText(stressCap)}.`,
    { steadyRollCap, stressCap, lpCap, stressDemandCap },
  );
  addCheck(
    checks,
    capacityLevel(boostedRollCap <= lpCap, args),
    "sustainability",
    "Boosted wrapper cap fits LP backstop capital",
    `Boosted max roll cap is ${weiToEthText(boostedRollCap)}; LP-cap component is ${weiToEthText(lpCap)}.`,
    { boostedRollCap, lpCap },
  );
  addCheck(
    checks,
    capacityLevel(maxSeriesCap <= launchCap, args),
    "sustainability",
    "factory series cap fits sustainable launch cap",
    `Largest factory series cap is ${weiToEthText(maxSeriesCap)}; estimated launch cap is ${weiToEthText(launchCap)}.`,
    { maxSeriesCap, launchCap },
  );
}

function checkDecentralizedLiveness(checks, manifest, health, rpcChainId, args) {
  const marketsReady = Object.values(health.markets).every(
    (market) => market.hasLiquidity && market.sampleBuyTokenOut > 0n && market.sampleSellEthOut > 0n,
  );
  const lpVaultAttached = sameAddress(health.lpKeeper?.vault, manifest.contracts.lpVault);
  const lpRollSellersPinned =
    health.lpKeeper?.rollSellersSet &&
    sameAddress(health.lpKeeper?.steadyRollSeller, manifest.contracts.steadyVault) &&
    sameAddress(health.lpKeeper?.boostedRollSeller, manifest.contracts.boostedVault);
  const wrapperSetupClosed = Object.entries(health.wrappers).every(([key]) => {
    const keeper = health.wrapperKeepers[key];
    const expectedVault = key === "boosted" ? manifest.contracts.boostedVault : manifest.contracts.steadyVault;
    return keeper?.vaultSet && sameAddress(keeper.vault, expectedVault);
  });
  const oneTimeSetupClosed = lpVaultAttached && lpRollSellersPinned && wrapperSetupClosed;
  const lpReady =
    sameAddress(health.lpVault.manager, manifest.contracts.lpKeeper) &&
    lpVaultAttached &&
    lpRollSellersPinned &&
    health.lpVault.sharePriceWad > 0n &&
    (!health.lpVault.strategyActive || (health.lpInventory || []).some((item) => item.hasInventory));
  const wrappersReady = Object.entries(health.wrappers).every(([key, wrapper]) => {
    const keeper = health.wrapperKeepers[key];
    const expectedVault = key === "boosted" ? manifest.contracts.boostedVault : manifest.contracts.steadyVault;
    const expectedKeeper = key === "boosted" ? manifest.contracts.boostedKeeper : manifest.contracts.steadyKeeper;
    const sellerDiscovery = health.wrapperSellerAuctions?.[key] || { count: 0n, visibleIds: [] };
    const sellerQueueReady =
      sellerDiscovery.count <= health.auctionPolicy.maxActiveAuctionsPerSeller &&
      (wrapper.rollActive
        ? (sellerDiscovery.visibleIds || []).some((auctionId) => auctionId === wrapper.rollAuctionId)
        : sellerDiscovery.count === 0n);
    return (
      keeper &&
      sameAddress(wrapper.manager, expectedKeeper) &&
      keeper.vaultSet &&
      sameAddress(keeper.vault, expectedVault) &&
      sameAddress(keeper.factory, manifest.contracts.factory) &&
      sameAddress(keeper.auction, manifest.contracts.rollAuction) &&
      sellerQueueReady
    );
  });
  const auctionReady =
    !health.auctionPolicy.newAuctionsPaused &&
    !health.auctionPolicy.resetsPaused &&
    !health.auctionPolicy.fillsPaused &&
    health.auctionPolicy.minSellAmount > 0n &&
    isZeroAddress(health.auctionPolicy.guardian);
  const solverReady = isAddress(manifest.contracts.rollSolver);
  const baseSettlementReady =
    Object.values(health.series).every((series) => isAddress(series.oracle)) &&
    sameAddress(health.series.first.oracle, health.series.second.oracle);
  const medianRequired = isMainnetChain(rpcChainId) || args.requireMedianOracle;
  const settlementReady = medianRequired
    ? baseSettlementReady && medianOracleReady(manifest, health) && (!isMainnetChain(rpcChainId) || medianOracleMatchesMainnetConfig(health.medianOracle))
    : baseSettlementReady;

  addCheck(
    checks,
    oneTimeSetupClosed ? "pass" : "fail",
    "decentralized",
    "one-time deployment setup is closed",
    oneTimeSetupClosed
      ? "LP keeper, roll sellers, and wrapper keepers are pinned, so deploy-time setup hooks cannot retarget the live MVP."
      : "Deployment setup is still open or miswired; finish/pin keeper and wrapper setup before treating the MVP as no-admin.",
    {
      lpVaultAttached,
      lpRollSellersPinned,
      wrapperSetupClosed,
      lpKeeperVault: health.lpKeeper?.vault,
      lpVault: manifest.contracts.lpVault,
      steadyRollSeller: health.lpKeeper?.steadyRollSeller,
      boostedRollSeller: health.lpKeeper?.boostedRollSeller,
    },
  );

  const missing = [];
  if (!marketsReady) missing.push("trader AMM liquidity/quotes");
  if (!lpReady) missing.push("LP vault keeper/account visibility");
  if (!wrappersReady) missing.push("wrapper keeper wiring");
  if (!oneTimeSetupClosed) missing.push("one-time deployment setup closure");
  if (!auctionReady) missing.push("auction lifecycle permissions");
  if (!solverReady) missing.push("external solver helper");
  if (!settlementReady) missing.push("settlement oracle wiring");

  addCheck(
    checks,
    missing.length === 0 ? "pass" : "fail",
    "decentralized",
    "protocol liveness surface is permissionless",
    missing.length === 0
      ? "Trader AMMs, LP vault, wrapper keepers, public auctions, solver helper, and settlement oracles are all live through on-chain public entrypoints."
      : `Missing or blocked: ${missing.join(", ")}.`,
    {
      marketsReady,
      lpReady,
      wrappersReady,
      oneTimeSetupClosed,
      auctionReady,
      guardian: health.auctionPolicy.guardian,
      solverReady,
      settlementReady,
    },
  );
}

function summarize(checks) {
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const check of checks) counts[check.level] += 1;
  const status = counts.fail > 0 ? "fail" : counts.warn > 0 ? "warn" : "pass";
  return { status, counts };
}

function printReport(result) {
  console.log(`Readiness: ${result.status.toUpperCase()} (${result.counts.pass} pass, ${result.counts.warn} warn, ${result.counts.fail} fail)`);
  for (const level of ["fail", "warn", "pass"]) {
    const checks = result.checks.filter((check) => check.level === level);
    if (!checks.length) continue;
    console.log("");
    console.log(level.toUpperCase());
    for (const check of checks) {
      console.log(`- [${check.area}] ${check.name}: ${check.detail}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const checks = [];
  const manifest = await readManifest(args.manifest);
  const rpcChainId = await rpcCall(args.rpc, "eth_chainId", []);

  checkManifestAndChain(checks, manifest, rpcChainId, args);
  if (missingManifestKeys(manifest).length === 0) {
    await checkCode(args.rpc, checks, manifest);
    const health = await readHealth(args.rpc, manifest, args);
    checkMarkets(checks, health, args);
    checkLpVault(checks, manifest, health, args);
    checkWrappers(checks, manifest, health, args);
    checkAuctionAndSeries(checks, manifest, health, args);
    checkSettlementOracles(checks, manifest, health, rpcChainId, args);
    checkCapacityPolicy(checks, health, args);
    checkDecentralizedLiveness(checks, manifest, health, rpcChainId, args);
  }

  const summary = summarize(checks);
  const result = {
    ...summary,
    manifest: args.manifest,
    rpcChainId,
    checks,
  };

  if (args.json) {
    console.log(jsonSafe(result));
  } else {
    printReport(result);
  }

  if (summary.counts.fail > 0 || (args.strict && summary.counts.warn > 0)) process.exit(1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
