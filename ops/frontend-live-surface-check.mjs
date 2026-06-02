#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const execFileAsync = promisify(execFile);

const REQUIRED_DOM_IDS = [
  "connectWallet",
  "tradeAction",
  "lpAction",
  "lpClaimAction",
  "solverAction",
  "keeperStartRoll",
  "keeperResetRoll",
  "keeperFinalizeRoll",
  "keeperCancelRoll",
  "settlementSettle",
  "settlementMerge",
  "settlementRedeem",
];

const APP_REQUIREMENTS = [
  {
    area: "wallet",
    name: "wallet connection",
    patterns: ["eth_requestAccounts", "eth_sendTransaction", "accountsChanged", "chainChanged"],
  },
  {
    area: "wallet",
    name: "manifest chain guard",
    patterns: [
      "normalizedChainId",
      "manifestChainId",
      "walletChainId",
      "walletChainMatchesManifest",
      "walletChainMismatch",
      "chainMismatchText",
      "if (walletChainMismatch()) throw new Error(chainMismatchText())",
    ],
  },
  {
    area: "manifest",
    name: "deployed manifest loading",
    patterns: ["CONTRACT_MANIFEST_URL", "loadContractManifest", "hasDeployManifest", "onchainReady"],
  },
  {
    area: "trader",
    name: "live AMM buy and sell",
    patterns: [
      "submitOnchainTrade",
      "readActiveTradeQuote",
      "SELECTORS.quoteBuyToken",
      "SELECTORS.quoteSellToken",
      "encodeBuyToken",
      "encodeApprove(market",
      "encodeSellToken",
    ],
  },
  {
    area: "lp",
    name: "live ETH LP deposit, withdrawal request, and claim",
    patterns: [
      "submitOnchainLpDeposit",
      "submitOnchainLpWithdraw",
      "submitOnchainLpClaim",
      "SELECTORS.deposit",
      "SELECTORS.requestWithdraw",
      "SELECTORS.claimWithdraw",
      "SELECTORS.convertToShares",
    ],
  },
  {
    area: "solver",
    name: "live public auction solver bid",
    patterns: [
      "submitOnchainSolverBid",
      "liveAuctionReady",
      "encodeRollAuctionFill",
      "encodeRollSolverMintAndFill",
      "rollSolverMintAndFillP",
      "rollSolverMintAndFillNCallback",
    ],
  },
  {
    area: "keeper",
    name: "live wrapper keeper actions",
    patterns: [
      "submitOnchainKeeperStartRoll",
      "submitOnchainKeeperFinalize",
      "submitOnchainKeeperReset",
      "submitOnchainKeeperCancel",
      "encodeKeeperStartRoll",
      "encodeKeeperResetRoll",
      "SELECTORS.keeperFinalizeRoll",
      "SELECTORS.keeperCancelRoll",
    ],
  },
  {
    area: "settlement",
    name: "live settlement, merge, and redeem",
    patterns: [
      "submitOnchainSettlement",
      "submitOnchainMerge",
      "submitOnchainRedeem",
      "encodeSettle",
      "encodeMerge",
      "encodeRedeem",
      "SELECTORS.factoryRedeemP",
      "SELECTORS.factoryRedeemN",
    ],
  },
  {
    area: "readiness",
    name: "live health and capacity reads",
    patterns: [
      "readProtocolHealthState",
      "healthLensReady",
      "SELECTORS.healthMarket",
      "SELECTORS.healthLpVault",
      "SELECTORS.healthWrapper",
      "SELECTORS.healthAuction",
      "liveCapacityPolicy",
    ],
  },
];

const EVENT_REQUIREMENTS = [
  ["tradeAction", "submitOnchainTrade"],
  ["lpConfirmDeposit", "submitOnchainLpDeposit"],
  ["lpConfirmDeposit", "submitOnchainLpWithdraw"],
  ["lpClaimAction", "submitOnchainLpClaim"],
  ["solverAction", "submitOnchainSolverBid"],
  ["keeperStartRoll", "submitOnchainKeeperStartRoll"],
  ["keeperFinalizeRoll", "submitOnchainKeeperFinalize"],
  ["keeperResetRoll", "submitOnchainKeeperReset"],
  ["keeperCancelRoll", "submitOnchainKeeperCancel"],
  ["settlementSettle", "submitOnchainSettlement"],
  ["settlementMerge", "submitOnchainMerge"],
  ["settlementRedeem", "submitOnchainRedeem"],
];

const SELECTOR_SIGNATURES = [
  ["buyToken", "buyToken(uint256,address)"],
  ["sellToken", "sellToken(uint256,uint256,address)"],
  ["ammToken", "token()"],
  ["deposit", "deposit()"],
  ["approve", "approve(address,uint256)"],
  ["quoteBuyToken", "quoteBuyToken(uint256)"],
  ["quoteSellToken", "quoteSellToken(uint256)"],
  ["balanceOf", "balanceOf(address)"],
  ["vaultShare", "share()"],
  ["activeStrategyEth", "activeStrategyEth()"],
  ["strategyActive", "strategyActive()"],
  ["managedAssets", "managedAssets()"],
  ["convertToShares", "convertToShares(uint256)"],
  ["convertToAssets", "convertToAssets(uint256)"],
  ["requestWithdraw", "requestWithdraw(uint256)"],
  ["claimWithdraw", "claimWithdraw()"],
  ["withdrawalRequests", "withdrawalRequests(address)"],
  ["rollAuctionAuction", "auctions(uint256)"],
  ["rollAuctionPrice", "currentPriceWad(uint256)"],
  ["rollAuctionResetStatus", "resetStatus(uint256)"],
  ["rollAuctionStopped", "stopped()"],
  ["rollAuctionFill", "fill(uint256,uint256,uint256,address)"],
  ["activeAuctionCount", "activeAuctionCount()"],
  ["activeAuctionIdAt", "activeAuctionIdAt(uint256)"],
  ["activeAuctionCountBySeller", "activeAuctionCountBySeller(address)"],
  ["activeAuctionIdBySellerAt", "activeAuctionIdBySellerAt(address,uint256)"],
  ["rollSolverMintAndFillP", "mintAndFill(address,address,bytes32,uint256,uint256,uint256,address)"],
  ["rollSolverMintAndFillN", "mintAndFillN(address,address,bytes32,uint256,uint256,uint256,address)"],
  ["rollSolverMintAndFillPCallback", "mintAndFillWithCallback(address,address,bytes32,uint256,uint256,uint256,address)"],
  ["rollSolverMintAndFillNCallback", "mintAndFillNWithCallback(address,address,bytes32,uint256,uint256,uint256,address)"],
  ["wrapperCurrentToken", "currentToken()"],
  ["wrapperRollActive", "rollActive()"],
  ["wrapperRoll", "roll()"],
  ["keeperCurrentSeriesId", "currentSeriesId()"],
  ["keeperPendingSeriesId", "pendingSeriesId()"],
  ["keeperStartRoll", "startRoll(bytes32,uint256,uint256,uint256,uint64)"],
  ["keeperResetRoll", "resetRoll(uint256,uint256,uint64)"],
  ["keeperFinalizeRoll", "finalizeRoll()"],
  ["keeperCancelRoll", "cancelUnfilledRoll()"],
  ["factorySeries", "series(bytes32)"],
  ["factorySettle", "settle(bytes32)"],
  ["factoryMerge", "merge(bytes32,uint256)"],
  ["factoryRedeemP", "redeemP(bytes32,uint256)"],
  ["factoryRedeemN", "redeemN(bytes32,uint256)"],
  ["healthMarket", "marketHealth(address,uint256,uint256)"],
  ["healthLpVault", "lpVaultHealth(address)"],
  ["healthWrapper", "wrapperHealth(address)"],
  ["healthSeries", "seriesHealth(address,bytes32)"],
  ["healthAuction", "auctionHealth(address,uint256)"],
];

function assertIncludes(haystack, needle, label, failures) {
  if (!haystack.includes(needle)) failures.push(`${label}: missing "${needle}"`);
}

function selectorConstant(app, key) {
  const match = app.match(new RegExp(`${key}:\\s*"(0x[a-fA-F0-9]{8})"`));
  return match?.[1]?.toLowerCase() || null;
}

async function castSig(signature) {
  const { stdout } = await execFileAsync("cast", ["sig", signature], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
  return stdout.trim().toLowerCase();
}

function printPasses(passes) {
  console.log(`Frontend live surface: PASS (${passes.length} pass, 0 fail)`);
  for (const item of passes) console.log(`PASS [${item.area}] ${item.name}`);
}

async function main() {
  const [html, app] = await Promise.all([
    fs.readFile(path.join(ROOT, "demo", "index.html"), "utf8"),
    fs.readFile(path.join(ROOT, "demo", "app.js"), "utf8"),
  ]);

  const failures = [];
  const passes = [];

  for (const id of REQUIRED_DOM_IDS) {
    assertIncludes(html, `id="${id}"`, `DOM control ${id}`, failures);
  }
  if (!failures.length) passes.push({ area: "dom", name: "required live action controls are present" });

  for (const requirement of APP_REQUIREMENTS) {
    const before = failures.length;
    for (const pattern of requirement.patterns) {
      assertIncludes(app, pattern, `${requirement.area} ${requirement.name}`, failures);
    }
    if (failures.length === before) passes.push(requirement);
  }

  for (const [control, handler] of EVENT_REQUIREMENTS) {
    const selector = `els.${control}.addEventListener`;
    const before = failures.length;
    assertIncludes(app, selector, `event binding ${control}`, failures);
    assertIncludes(app, handler, `event binding ${control}`, failures);
    if (failures.length === before) passes.push({ area: "events", name: `${control} reaches ${handler}` });
  }

  const selectorMismatches = [];
  for (const [key, signature] of SELECTOR_SIGNATURES) {
    const actual = selectorConstant(app, key);
    if (!actual) {
      selectorMismatches.push(`${key}: selector constant missing`);
      continue;
    }
    const expected = await castSig(signature);
    if (actual !== expected) selectorMismatches.push(`${key}: ${actual} should be ${expected} for ${signature}`);
  }
  if (selectorMismatches.length) {
    for (const mismatch of selectorMismatches) failures.push(`selector drift: ${mismatch}`);
  } else {
    passes.push({ area: "selectors", name: "frontend calldata selectors match Solidity signatures" });
  }

  if (failures.length) {
    console.log(`Frontend live surface: FAIL (${passes.length} pass, ${failures.length} fail)`);
    for (const item of passes) console.log(`PASS [${item.area}] ${item.name}`);
    for (const failure of failures) console.log(`FAIL ${failure}`);
    process.exit(1);
  }

  printPasses(passes);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
