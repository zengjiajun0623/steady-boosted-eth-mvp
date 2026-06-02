#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SOLIDITY_DIRS = ["src", "script"];
const BANNED_PATTERNS = [
  [/\bOwnable\b/, "Ownable"],
  [/\bAccessControl\b/, "AccessControl"],
  [/\bDEFAULT_ADMIN_ROLE\b/, "DEFAULT_ADMIN_ROLE"],
  [/\bonlyOwner\b/, "onlyOwner"],
  [/\bonlyAdmin\b/, "onlyAdmin"],
  [/\bonlyRole\b/, "onlyRole"],
  [/\bowner\s*\(/, "owner()"],
  [/\badmin\s*\(/, "admin()"],
  [/\btransferOwnership\b/, "transferOwnership"],
  [/\bupgradeTo\b/, "upgradeTo"],
  [/\bUUPS\b/, "UUPS"],
  [/\bTransparentUpgradeableProxy\b/, "TransparentUpgradeableProxy"],
  [/\bdelegatecall\b/, "delegatecall"],
  [/\bselfdestruct\b/, "selfdestruct"],
  [/\btx\.origin\b/, "tx.origin"],
];

const ADMIN_LIKE_FUNCTION = /\bfunction\s+((?:set|configure|upgrade|grant|revoke|pause|unpause|emergency|clear)[A-Z]\w*)\s*\(/g;
const ALLOWED_ADMIN_LIKE_FUNCTIONS = new Set([
  "src/RollAuction.sol:setStopped",
  "src/RollAuction.sol:setMinSellAmount",
  "src/RollAuction.sol:setStaleResetPolicy",
  "src/vault/EthLPVaultKeeper.sol:setVault",
  "src/vault/EthLPVaultKeeper.sol:setRollSellers",
  "src/vault/SeriesExposureVaultKeeper.sol:setVault",
  "src/oracle/MockSettlementOracle.sol:setSettlementPrice",
  "src/oracle/MockSettlementOracle.sol:clearSettlementPrice",
]);

async function listFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(fullPath);
    if (entry.isFile() && entry.name.endsWith(".sol")) return [fullPath];
    return [];
  }));
  return files.flat();
}

function repoPath(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, "/");
}

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}

function assertRollAuctionGuardianZero(source, file, failures) {
  const constructors = source.matchAll(/\bnew\s+RollAuction\s*\(/g);
  for (const match of constructors) {
    const after = source.slice(match.index, match.index + 200);
    if (!/\bnew\s+RollAuction\s*\(\s*address\s*\(\s*0\s*\)/.test(after)) {
      failures.push({
        file,
        line: lineNumber(source, match.index),
        message: "RollAuction must be deployed with guardian address(0).",
      });
    }
  }
}

async function main() {
  const files = (await Promise.all(SOLIDITY_DIRS.map((dir) => listFiles(path.join(ROOT, dir))))).flat();
  const failures = [];
  let checkedAdminPatterns = 0;
  let checkedSetters = 0;
  let checkedRollAuctionDeployments = 0;

  for (const file of files) {
    const relative = repoPath(file);
    const source = await fs.readFile(file, "utf8");

    for (const [pattern, label] of BANNED_PATTERNS) {
      checkedAdminPatterns += 1;
      const match = pattern.exec(source);
      if (match) {
        failures.push({
          file: relative,
          line: lineNumber(source, match.index),
          message: `Forbidden admin/upgradability pattern: ${label}.`,
        });
      }
      pattern.lastIndex = 0;
    }

    for (const match of source.matchAll(ADMIN_LIKE_FUNCTION)) {
      checkedSetters += 1;
      const key = `${relative}:${match[1]}`;
      if (!ALLOWED_ADMIN_LIKE_FUNCTIONS.has(key)) {
        failures.push({
          file: relative,
          line: lineNumber(source, match.index),
          message: `Unexpected admin-like function ${match[1]}(). Add a public, permissionless design or explicitly justify it in this check.`,
        });
      }
    }

    const auctionDeployments = [...source.matchAll(/\bnew\s+RollAuction\s*\(/g)];
    checkedRollAuctionDeployments += auctionDeployments.length;
    assertRollAuctionGuardianZero(source, relative, failures);
  }

  const pilot = await fs.readFile(path.join(ROOT, "script", "DeployEthereumPilot.sol"), "utf8");
  if (/\bMockSettlementOracle\b/.test(pilot)) {
    failures.push({
      file: "script/DeployEthereumPilot.sol",
      line: lineNumber(pilot, pilot.search(/\bMockSettlementOracle\b/)),
      message: "Ethereum pilot deployment must not use MockSettlementOracle.",
    });
  }

  if (failures.length) {
    console.error("No-admin surface check: FAIL");
    for (const failure of failures) {
      console.error(`- ${failure.file}:${failure.line} ${failure.message}`);
    }
    process.exit(1);
  }

  console.log(
    `No-admin surface check: PASS (${files.length} Solidity files, ${checkedAdminPatterns} forbidden-pattern scans, ${checkedSetters} allowlisted admin-like functions, ${checkedRollAuctionDeployments} guardian-zero auction deployments)`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
