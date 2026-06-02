#!/usr/bin/env node

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const SELECTORS = {
  getPool: "0x1698ee82",
  token0: "0x0dfe1681",
  token1: "0xd21220a7",
  fee: "0xddca3f43",
};

const MAINNET_CHAIN_ID = "0x1";
const UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const FEE_005 = 500n;

const SOURCES = [
  {
    label: "USDC/WETH 0.05%",
    stable: "USDC",
    stableAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    expectedPool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
    expectedToken0: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    expectedToken1: WETH,
    priceAtTickZeroWad: "1000000000000000000000000000000",
    invertPrice: true,
    minUsableTick: 175_000,
    maxUsableTick: 221_200,
  },
  {
    label: "WETH/USDT 0.05%",
    stable: "USDT",
    stableAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    expectedPool: "0x11b815efB8f581194ae79006d24E0d814B7697F6",
    expectedToken0: WETH,
    expectedToken1: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    priceAtTickZeroWad: "1000000000000000000000000000000",
    invertPrice: false,
    minUsableTick: -221_200,
    maxUsableTick: -175_000,
  },
  {
    label: "DAI/WETH 0.05%",
    stable: "DAI",
    stableAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    expectedPool: "0x60594a405d53811d3BC4766596EFD80fd545A270",
    expectedToken0: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    expectedToken1: WETH,
    priceAtTickZeroWad: "1000000000000000000",
    invertPrice: true,
    minUsableTick: -106_500,
    maxUsableTick: -53_000,
  },
];

function usage() {
  return `Usage:
  node ops/mainnet-oracle-preflight.mjs --rpc <MAINNET_RPC_URL> [options]

Options:
  --json              Print machine-readable JSON
  --allow-non-mainnet Allow running against non-mainnet RPC for debugging

Examples:
  node ops/mainnet-oracle-preflight.mjs --rpc $MAINNET_RPC_URL
  node ops/mainnet-oracle-preflight.mjs --rpc $MAINNET_RPC_URL --json`;
}

function parseArgs(argv) {
  const args = {
    rpc: process.env.MAINNET_RPC_URL || process.env.RPC_URL || "",
    json: false,
    allowNonMainnet: false,
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
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--allow-non-mainnet") {
      args.allowNonMainnet = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!args.rpc) throw new Error("Pass --rpc or set MAINNET_RPC_URL/RPC_URL.");
  return args;
}

function cleanHex(hex) {
  return (hex || "0x").replace(/^0x/, "");
}

function word(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function addressWord(address) {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function decodeWord(hex, index = 0) {
  return cleanHex(hex).slice(index * 64, index * 64 + 64).padStart(64, "0");
}

function decodeAddress(hex, index = 0) {
  return `0x${decodeWord(hex, index).slice(24)}`;
}

function decodeUint(hex, index = 0) {
  return BigInt(`0x${decodeWord(hex, index)}`);
}

function sameAddress(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

function getPoolCalldata(tokenA, tokenB, fee) {
  return `${SELECTORS.getPool}${addressWord(tokenA)}${addressWord(tokenB)}${word(fee)}`;
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

async function readSource(rpcUrl, source) {
  const [poolFromFactoryRaw, token0Raw, token1Raw, feeRaw] = await Promise.all([
    ethCall(rpcUrl, UNISWAP_V3_FACTORY, getPoolCalldata(source.stableAddress, WETH, FEE_005)),
    ethCall(rpcUrl, source.expectedPool, SELECTORS.token0),
    ethCall(rpcUrl, source.expectedPool, SELECTORS.token1),
    ethCall(rpcUrl, source.expectedPool, SELECTORS.fee),
  ]);

  return {
    ...source,
    poolFromFactory: decodeAddress(poolFromFactoryRaw),
    token0: decodeAddress(token0Raw),
    token1: decodeAddress(token1Raw),
    fee: decodeUint(feeRaw),
  };
}

function sourceChecks(source) {
  return [
    {
      name: `${source.label} factory pool`,
      ok: sameAddress(source.poolFromFactory, source.expectedPool),
      detail: `factory returned ${source.poolFromFactory}; expected ${source.expectedPool}`,
    },
    {
      name: `${source.label} token0`,
      ok: sameAddress(source.token0, source.expectedToken0),
      detail: `token0=${source.token0}; expected ${source.expectedToken0}`,
    },
    {
      name: `${source.label} token1`,
      ok: sameAddress(source.token1, source.expectedToken1),
      detail: `token1=${source.token1}; expected ${source.expectedToken1}`,
    },
    {
      name: `${source.label} fee`,
      ok: source.fee === FEE_005,
      detail: `fee=${source.fee.toString()}; expected ${FEE_005.toString()}`,
    },
  ];
}

function distinctPoolChecks(sources) {
  const pools = sources.map((source) => source.expectedPool.toLowerCase());
  return [{
    name: "median source pools are distinct",
    ok: new Set(pools).size === pools.length,
    detail: pools.join(", "),
  }];
}

function jsonSafe(value) {
  return JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item), 2);
}

async function buildReport(args) {
  const chainId = (await rpcCall(args.rpc, "eth_chainId", [])).toLowerCase();
  const sources = await Promise.all(SOURCES.map((source) => readSource(args.rpc, source)));
  const checks = [
    {
      name: "RPC is Ethereum mainnet",
      ok: args.allowNonMainnet || chainId === MAINNET_CHAIN_ID,
      detail: `chainId=${chainId}`,
    },
    ...distinctPoolChecks(sources),
    ...sources.flatMap(sourceChecks),
  ];
  const failures = checks.filter((check) => !check.ok);

  return {
    status: failures.length === 0 ? "pass" : "fail",
    chainId,
    uniswapV3Factory: UNISWAP_V3_FACTORY,
    sources,
    checks,
    failures,
  };
}

function printReport(report) {
  console.log(`Mainnet oracle preflight: ${report.status.toUpperCase()}`);
  console.log(`Chain id: ${report.chainId}`);
  for (const check of report.checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await buildReport(args);
  if (args.json) {
    console.log(jsonSafe(report));
  } else {
    printReport(report);
  }
  if (report.status !== "pass") process.exit(1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
