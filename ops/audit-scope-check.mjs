#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const AUDIT_SCOPE = path.join(ROOT, "audit_scope.md");
const SIZE_CHECK = path.join(ROOT, "ops", "contract-size-check.mjs");

const REQUIRED_SECTIONS = [
  "## Production Contracts",
  "## Script Helpers",
  "## Primary Invariants",
  "## Required Commands",
  "## Known Launch Blockers",
];

const REQUIRED_COMMANDS = [
  "node ops/mvp-acceptance.mjs --local-live",
  "node ops/contract-size-check.mjs",
  "node ops/no-admin-surface-check.mjs",
  "node ops/production-readiness.mjs",
];

function extractSet(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s+=\\s+new\\s+Set\\s*\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)`));
  if (!match) throw new Error(`Could not find ${name} in ops/contract-size-check.mjs.`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

function main() {
  const failures = [];
  if (!fs.existsSync(AUDIT_SCOPE)) failures.push("audit_scope.md is missing.");
  if (!fs.existsSync(SIZE_CHECK)) failures.push("ops/contract-size-check.mjs is missing.");
  if (failures.length) {
    console.error(`Audit scope check: FAIL\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }

  const scope = fs.readFileSync(AUDIT_SCOPE, "utf8");
  const sizeCheck = fs.readFileSync(SIZE_CHECK, "utf8");
  const productionContracts = extractSet(sizeCheck, "PRODUCTION_CONTRACTS");
  const scriptHelpers = extractSet(sizeCheck, "SCRIPT_HELPERS");

  for (const section of REQUIRED_SECTIONS) {
    if (!scope.includes(section)) failures.push(`Missing section: ${section}`);
  }
  for (const contract of productionContracts) {
    if (!scope.includes(contract)) failures.push(`Production contract missing from audit scope: ${contract}`);
  }
  for (const helper of scriptHelpers) {
    if (!scope.includes(helper)) failures.push(`Script helper missing from audit scope: ${helper}`);
  }
  for (const command of REQUIRED_COMMANDS) {
    if (!scope.includes(command)) failures.push(`Required command missing from audit scope: ${command}`);
  }

  if (failures.length) {
    console.error("Audit scope check: FAIL");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    `Audit scope check: PASS (${productionContracts.length} production contracts, ${scriptHelpers.length} script helpers)`,
  );
}

main();
