#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEMO_HTML = path.join(ROOT, "demo", "index.html");

const REQUIRED_SNIPPETS = [
  ["title", "<title>Steady ETH Demo</title>"],
  ["trade tab", 'data-page="trader" type="button">Trade</button>'],
  ["vault tab", 'data-page="lp" type="button">Vault</button>'],
  ["auctions tab", 'data-page="solver" type="button">Auctions</button>'],
  ["trader page", 'id="traderPage"'],
  ["vault page", 'id="lpPage"'],
  ["auctions page", 'id="solverPage"'],
  ["steady selector", 'data-strategy="steady"'],
  ["boosted selector", 'data-strategy="boosted"'],
  ["buy selector", 'data-side="buy"'],
  ["sell selector", 'data-side="sell"'],
  ["trade action", 'id="tradeAction"'],
  ["wallet connection", 'id="connectWallet"'],
  ["LP deposit action", 'id="lpAction"'],
  ["LP claim action", 'id="lpClaimAction"'],
  ["solver action", 'id="solverAction"'],
  ["keeper start action", 'id="keeperStartRoll"'],
  ["settlement action", 'id="settlementSettle"'],
  ["protocol health", 'id="protocolHealthMode"'],
  ["3-stable settlement copy", "Final settlement uses a 3-stable ETH TWAP median."],
  ["LP risk copy", "Estimated ETH spread if the vault helps fill a roll auction."],
  ["permissionless keeper copy", "Permissionless roll lifecycle."],
];

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function includesSnippet(html, snippet) {
  return normalizeWhitespace(html).includes(normalizeWhitespace(snippet));
}

async function main() {
  const html = await fs.readFile(DEMO_HTML, "utf8");
  const failures = [];

  for (const [label, snippet] of REQUIRED_SNIPPETS) {
    if (!includesSnippet(html, snippet)) failures.push(label);
  }

  if (failures.length) {
    console.error("Demo page smoke: FAIL");
    for (const failure of failures) console.error(`- missing ${failure}`);
    process.exit(1);
  }

  console.log(`Demo page smoke: PASS (${REQUIRED_SNIPPETS.length} checks)`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
