#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

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
      "readOperatorHealthState",
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

function assertIncludes(haystack, needle, label, failures) {
  if (!haystack.includes(needle)) failures.push(`${label}: missing "${needle}"`);
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
