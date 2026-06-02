#!/usr/bin/env node

const WAD = 10n ** 18n;

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", reject);
  });
}

function ethToWei(value) {
  const text = String(value);
  const [whole, fraction = ""] = text.split(".");
  const padded = `${fraction}000000000000000000`.slice(0, 18);
  return BigInt(whole || "0") * WAD + BigInt(padded);
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function minBigInt(...values) {
  return values.reduce((best, value) => (value < best ? value : best));
}

const input = JSON.parse(await readStdin());
const currentPriceWad = BigInt(input.auction.currentPriceWad);
const remainingSellAmount = BigInt(input.auction.remainingSellAmount);
const operatorMaxPriceWad = BigInt(input.limits.operatorMaxPriceWad);
const defaultSellAmount = BigInt(input.limits.defaultSellAmount);
const edgeBps = envInt("SOLVER_EDGE_BPS", 25);
const fairRollPriceWad = BigInt(process.env.SOLVER_FAIR_PRICE_WAD || WAD.toString());
const edgePriceWad = fairRollPriceWad - (fairRollPriceWad * BigInt(edgeBps)) / 10_000n;
const maxPriceWad = edgePriceWad < operatorMaxPriceWad ? edgePriceWad : operatorMaxPriceWad;
const envMaxFill = process.env.SOLVER_MAX_FILL_ETH ? ethToWei(process.env.SOLVER_MAX_FILL_ETH) : defaultSellAmount;
const sellAmountWei = minBigInt(defaultSellAmount, envMaxFill, remainingSellAmount);
const bid = currentPriceWad <= maxPriceWad && sellAmountWei > 0n;

process.stdout.write(JSON.stringify({
  bid,
  maxPriceWad: maxPriceWad.toString(),
  sellAmountWei: sellAmountWei.toString(),
  reason: bid
    ? `Current Dutch price is inside the model price after ${edgeBps} bps edge.`
    : `Waiting for at least ${edgeBps} bps model edge.`,
}));
