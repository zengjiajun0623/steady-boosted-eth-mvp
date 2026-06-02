#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function usage() {
  return `Usage:
  node ops/production-readiness.mjs --manifest <path> --rpc <MAINNET_RPC_URL> [options]

Required production evidence:
  --audit-report <path>          Structured final external audit evidence JSON
  --incident-runbook <path>      Incident response and emergency communications runbook
  --security-intake <path>       Structured vulnerability intake / bug bounty JSON evidence
  --solver-commitments <path>    Structured solver/liquidity commitment JSON evidence
  --boosted-demand-eth <eth>     Credible committed Boosted/N demand
  --solver-float-eth <eth>       Credible external solver balance sheet

Options:
  --manifest <path>              Production deployment manifest
  --rpc <url>                    Ethereum mainnet RPC URL
  --json                         Print machine-readable JSON
  --skip-live                    Skip mainnet/live checks only
  --skip-local-acceptance        Skip local acceptance check; this still fails production approval
  --skip-oracle-preflight        Skip mainnet Uniswap pool preflight
  --skip-readiness               Skip strict live readiness

Environment fallbacks:
  MAINNET_RPC_URL or RPC_URL
  PRODUCTION_MANIFEST
  PRODUCTION_AUDIT_REPORT
  PRODUCTION_INCIDENT_RUNBOOK
  PRODUCTION_SECURITY_INTAKE
  PRODUCTION_SOLVER_COMMITMENTS

Example:
  node ops/production-readiness.mjs \\
    --manifest manifests/production.json \\
    --rpc $MAINNET_RPC_URL \\
    --audit-report evidence/audit-final.json \\
    --incident-runbook ops/incident-runbook.md \\
    --security-intake evidence/security-intake-final.json \\
    --solver-commitments evidence/solver-commitments-final.json \\
    --boosted-demand-eth 5000 \\
    --solver-float-eth 250`;
}

function parseArgs(argv) {
  const args = {
    manifest: process.env.PRODUCTION_MANIFEST || "",
    rpc: process.env.MAINNET_RPC_URL || process.env.RPC_URL || "",
    auditReport: process.env.PRODUCTION_AUDIT_REPORT || "",
    incidentRunbook: process.env.PRODUCTION_INCIDENT_RUNBOOK || "",
    securityIntake: process.env.PRODUCTION_SECURITY_INTAKE || "",
    solverCommitments: process.env.PRODUCTION_SOLVER_COMMITMENTS || "",
    boostedDemandEth: "",
    solverFloatEth: "",
    json: false,
    skipLive: false,
    skipLocalAcceptance: false,
    skipOraclePreflight: false,
    skipReadiness: false,
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
    } else if (arg === "--audit-report") {
      args.auditReport = next();
    } else if (arg === "--incident-runbook") {
      args.incidentRunbook = next();
    } else if (arg === "--security-intake") {
      args.securityIntake = next();
    } else if (arg === "--solver-commitments") {
      args.solverCommitments = next();
    } else if (arg === "--boosted-demand-eth") {
      args.boostedDemandEth = next();
    } else if (arg === "--solver-float-eth") {
      args.solverFloatEth = next();
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--skip-live") {
      args.skipLive = true;
    } else if (arg === "--skip-local-acceptance") {
      args.skipLocalAcceptance = true;
    } else if (arg === "--skip-oracle-preflight") {
      args.skipOraclePreflight = true;
    } else if (arg === "--skip-readiness") {
      args.skipReadiness = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return args;
}

function resolveRepoPath(file) {
  if (!file) return "";
  return path.isAbsolute(file) ? file : path.join(ROOT, file);
}

function exists(file) {
  return Boolean(file) && fs.existsSync(resolveRepoPath(file));
}

function readText(file) {
  return fs.readFileSync(resolveRepoPath(file), "utf8");
}

function parseJsonFile(file) {
  return JSON.parse(readText(file));
}

function positiveEth(value) {
  if (!value) return false;
  if (!/^\d+(\.\d+)?$/.test(value)) return false;
  return Number(value) > 0;
}

function ethToWei(value) {
  if (typeof value === "number") value = String(value);
  if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value)) return null;
  const [whole, rawFraction = ""] = value.split(".");
  if (rawFraction.length > 18) return null;
  return BigInt(whole) * 10n ** 18n + BigInt(rawFraction.padEnd(18, "0"));
}

function weiToEthText(value) {
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction ? `${whole.toString()}.${fraction}` : whole.toString();
}

function pass(checks, area, name, detail, meta = {}) {
  checks.push({ level: "pass", area, name, detail, meta });
}

function fail(checks, area, name, detail, meta = {}) {
  checks.push({ level: "fail", area, name, detail, meta });
}

function warn(checks, area, name, detail, meta = {}) {
  checks.push({ level: "warn", area, name, detail, meta });
}

function runNode(checks, area, name, args, options = {}) {
  const result = spawnSync("node", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (result.status === 0) {
    pass(checks, area, name, options.passDetail || "Command passed.", { command: ["node", ...args].join(" ") });
  } else {
    fail(
      checks,
      area,
      name,
      options.failDetail || `Command failed with exit code ${result.status}.`,
      { command: ["node", ...args].join(" "), output: output.slice(-4000) },
    );
  }
}

function checkSecurityStatus(checks) {
  const file = "SECURITY.md";
  if (!exists(file)) {
    fail(checks, "security", "security policy exists", "SECURITY.md is missing.");
    return;
  }

  const text = readText(file);
  const blockers = [
    [/not ready for public funds/i, "SECURITY.md still says the repo is not ready for public funds."],
    [/Real-fund deployment:\s*not approved/i, "Real-fund deployment is still marked not approved."],
    [/External audit:\s*not complete/i, "External audit is still marked not complete."],
    [/Bug bounty:\s*not active/i, "Bug bounty is still marked not active."],
  ].filter(([pattern]) => pattern.test(text));

  if (blockers.length === 0) {
    pass(checks, "security", "security policy production status", "SECURITY.md no longer carries MVP launch blockers.");
  } else {
    fail(
      checks,
      "security",
      "security policy production status",
      blockers.map(([, detail]) => detail).join(" "),
      { file },
    );
  }
}

function validateEvidenceFile(checks, area, name, file, detail) {
  if (!file) {
    fail(checks, area, name, `${detail} Pass the evidence path explicitly.`);
    return null;
  }
  if (/(template|example|sample|schema)/i.test(path.basename(file))) {
    fail(checks, area, name, `${detail} Refusing placeholder evidence path: ${file}.`, { file });
    return null;
  }
  if (!exists(file)) {
    fail(checks, area, name, `${detail} File not found: ${file}.`, { file });
    return null;
  }
  const size = fs.statSync(resolveRepoPath(file)).size;
  if (size === 0) {
    fail(checks, area, name, `${detail} File is empty: ${file}.`, { file });
    return null;
  }
  const text = readText(file);
  const placeholderPatterns = [
    [/\bTODO\b/i, "TODO"],
    [/\bTBD\b/i, "TBD"],
    [/\bplaceholder\b/i, "placeholder"],
    [/\btemplate\b/i, "template"],
    [/\bexample\b/i, "example"],
    [/\bsample\b/i, "sample"],
    [/\bnot complete\b/i, "not complete"],
    [/\bnot approved\b/i, "not approved"],
    [/\bnot signed\b/i, "not signed"],
    [/\bdraft only\b/i, "draft only"],
  ];
  const placeholders = placeholderPatterns.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  if (placeholders.length) {
    fail(
      checks,
      area,
      name,
      `${detail} Evidence still looks like a placeholder or draft: ${placeholders.join(", ")}.`,
      { file, placeholders },
    );
    return null;
  }
  return { text, size };
}

function checkEvidenceFile(checks, area, name, file, detail) {
  const evidence = validateEvidenceFile(checks, area, name, file, detail);
  if (!evidence) return;
  const { size } = evidence;
  pass(checks, area, name, `Evidence file exists: ${file}.`, { file, bytes: size });
}

const REQUIRED_AUDIT_SCOPE = [
  "smart-contracts",
  "frontend-wallet",
  "deployment-ops",
  "oracle-settlement",
  "solver-auctions",
  "lp-vault",
];

const REQUIRED_AUDIT_CONTRACTS = [
  "EthOptionsFactory",
  "EthLPVault",
  "EthLPVaultKeeper",
  "EthTokenAMM",
  "EthereumMainnetOracleConfig",
  "EthereumPilotTopology",
  "MedianStableTwapSettlementOracle",
  "MintBurnToken",
  "ProtocolHealthLens",
  "RollAuction",
  "RollSolver",
  "SeriesExposureVault",
  "SeriesExposureVaultKeeper",
  "UniswapV3TwapSettlementOracle",
];

function checkAuditEvidence(checks, file) {
  const evidence = validateEvidenceFile(
    checks,
    "security",
    "external audit evidence",
    file,
    "Production requires structured final external audit evidence.",
  );
  if (!evidence) return;

  let parsed;
  try {
    parsed = JSON.parse(evidence.text);
  } catch (error) {
    fail(checks, "security", "external audit evidence", `Audit evidence must be JSON: ${error.message}.`, { file });
    return;
  }

  const failures = [];
  const scope = Array.isArray(parsed?.scope) ? parsed.scope.map((item) => String(item)) : [];
  const contractsReviewed = Array.isArray(parsed?.contractsReviewed)
    ? parsed.contractsReviewed.map((item) => String(item))
    : [];
  const completedAtMs = Date.parse(String(parsed?.completedAt || ""));
  const findings = parsed?.findings || {};
  const remediation = parsed?.remediation || {};
  const retest = parsed?.retest || {};
  const riskAcceptance = parsed?.riskAcceptance || {};
  const reportRef = String(parsed?.reportUrl || parsed?.reportHash || "").trim();

  if (parsed?.version !== 1) failures.push("version must be 1");
  if (parsed?.status !== "complete") failures.push("status must be complete");
  if (!String(parsed?.auditor || "").trim()) failures.push("auditor is missing");
  if (!Number.isFinite(completedAtMs) || completedAtMs > Date.now()) {
    failures.push("completedAt must be an ISO timestamp in the past");
  }
  if (reportRef.length < 12) failures.push("reportUrl or reportHash needs a concrete reference");
  for (const requiredScope of REQUIRED_AUDIT_SCOPE) {
    if (!scope.includes(requiredScope)) failures.push(`scope must include ${requiredScope}`);
  }
  for (const contractName of REQUIRED_AUDIT_CONTRACTS) {
    if (!contractsReviewed.includes(contractName)) failures.push(`contractsReviewed must include ${contractName}`);
  }

  const count = (severity, key) => Number(findings?.[severity]?.[key]);
  for (const severity of ["critical", "high", "medium", "low"]) {
    for (const key of ["total", "unresolved"]) {
      const value = count(severity, key);
      if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
        failures.push(`findings.${severity}.${key} must be a non-negative integer`);
      }
    }
  }
  if (count("critical", "unresolved") > 0) failures.push("critical findings must have zero unresolved issues");
  if (count("high", "unresolved") > 0) failures.push("high findings must have zero unresolved issues");
  if (count("medium", "unresolved") > 0) {
    if (riskAcceptance.approved !== true || String(riskAcceptance.evidence || "").trim().length < 12) {
      failures.push("unresolved medium findings require approved riskAcceptance evidence");
    }
  }
  if (remediation.completed !== true) failures.push("remediation.completed must be true");
  if (String(remediation.evidence || "").trim().length < 12) {
    failures.push("remediation.evidence needs a concrete reference");
  }
  if (retest.completed !== true) failures.push("retest.completed must be true");
  if (String(retest.evidence || "").trim().length < 12) failures.push("retest.evidence needs a concrete reference");

  if (failures.length) {
    fail(checks, "security", "external audit evidence", failures.join("; "), { file });
    return;
  }

  pass(
    checks,
    "security",
    "external audit evidence",
    `Audit complete by ${parsed.auditor}; reviewed ${contractsReviewed.length} contracts with zero unresolved critical/high findings.`,
    {
      file,
      auditor: parsed.auditor,
      scope,
      contractsReviewed: contractsReviewed.length,
    },
  );
}

function checkSecurityIntake(checks, file) {
  const evidence = validateEvidenceFile(
    checks,
    "security",
    "vulnerability intake and bounty",
    file,
    "Production requires active vulnerability intake / bug bounty evidence.",
  );
  if (!evidence) return;

  let parsed;
  try {
    parsed = JSON.parse(evidence.text);
  } catch (error) {
    fail(
      checks,
      "security",
      "vulnerability intake and bounty",
      `Security intake evidence must be JSON: ${error.message}.`,
      { file },
    );
    return;
  }

  const failures = [];
  const contacts = Array.isArray(parsed?.contacts) ? parsed.contacts : [];
  const scope = Array.isArray(parsed?.scope) ? parsed.scope.map((item) => String(item)) : [];
  const bounty = parsed?.bounty || {};
  const sla = parsed?.sla || {};
  const launchedAtMs = Date.parse(String(parsed?.launchedAt || ""));
  const responseSlaHours = Number(sla.responseHours);
  const criticalTriageHours = Number(sla.criticalTriageHours);
  const hasIntakeRoute = Boolean(
    String(parsed?.intakeUrl || "").startsWith("https://") || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(parsed?.email || "")),
  );

  if (parsed?.version !== 1) failures.push("version must be 1");
  if (parsed?.status !== "active") failures.push("status must be active");
  if (!Number.isFinite(launchedAtMs) || launchedAtMs > Date.now()) {
    failures.push("launchedAt must be an ISO timestamp in the past");
  }
  if (!hasIntakeRoute) failures.push("intakeUrl must be https:// or email must be valid");
  if (contacts.length < 2) failures.push("at least two security contacts are required");
  contacts.forEach((contact, index) => {
    if (!String(contact?.name || "").trim()) failures.push(`contacts[${index}].name is missing`);
    if (!String(contact?.role || "").trim()) failures.push(`contacts[${index}].role is missing`);
    if (!String(contact?.contact || "").trim()) failures.push(`contacts[${index}].contact is missing`);
  });
  for (const requiredScope of ["smart-contracts", "frontend-wallet", "deployment-ops"]) {
    if (!scope.includes(requiredScope)) failures.push(`scope must include ${requiredScope}`);
  }
  if (!Number.isFinite(responseSlaHours) || responseSlaHours <= 0 || responseSlaHours > 72) {
    failures.push("sla.responseHours must be > 0 and <= 72");
  }
  if (!Number.isFinite(criticalTriageHours) || criticalTriageHours <= 0 || criticalTriageHours > 24) {
    failures.push("sla.criticalTriageHours must be > 0 and <= 24");
  }
  if (bounty.active !== true) failures.push("bounty.active must be true");
  if (!String(bounty.policyUrl || "").startsWith("https://")) failures.push("bounty.policyUrl must be https://");
  if (bounty.rewardsDefined !== true) failures.push("bounty.rewardsDefined must be true");

  if (failures.length) {
    fail(checks, "security", "vulnerability intake and bounty", failures.join("; "), { file });
    return;
  }

  pass(
    checks,
    "security",
    "vulnerability intake and bounty",
    `Active intake with ${contacts.length} contacts, ${scope.length} scope areas, ${responseSlaHours}h response SLA, and ${criticalTriageHours}h critical triage SLA.`,
    { file, contactCount: contacts.length, scope },
  );
}

function checkSolverCommitments(checks, file, boostedDemandEth, solverFloatEth) {
  const evidence = validateEvidenceFile(
    checks,
    "liquidity",
    "solver and liquidity commitments",
    file,
    "Production requires structured solver/liquidity commitment evidence.",
  );
  if (!evidence) return;

  let parsed;
  try {
    parsed = JSON.parse(evidence.text);
  } catch (error) {
    fail(
      checks,
      "liquidity",
      "solver and liquidity commitments",
      `Solver/liquidity evidence must be JSON: ${error.message}.`,
      { file },
    );
    return;
  }

  const commitments = Array.isArray(parsed?.commitments) ? parsed.commitments : [];
  if (parsed?.version !== 1 || commitments.length === 0) {
    fail(
      checks,
      "liquidity",
      "solver and liquidity commitments",
      "Commitment evidence must include version: 1 and a non-empty commitments array.",
      { file },
    );
    return;
  }

  const allowedKinds = new Set(["solver-float", "boosted-demand"]);
  const allowedStatuses = new Set(["signed", "funded", "onchain-funded", "live"]);
  const failures = [];
  let solverFloatWei = 0n;
  let boostedDemandWei = 0n;
  const now = Date.now();

  commitments.forEach((commitment, index) => {
    const kind = String(commitment?.kind || "");
    const status = String(commitment?.status || "");
    const counterparty = String(commitment?.counterparty || "").trim();
    const evidenceRef = String(commitment?.evidence || "").trim();
    const amountWei = ethToWei(commitment?.amountEth);
    const expiresAt = String(commitment?.expiresAt || "");
    const expiryMs = Date.parse(expiresAt);

    if (!allowedKinds.has(kind)) failures.push(`commitments[${index}].kind must be solver-float or boosted-demand`);
    if (!allowedStatuses.has(status)) {
      failures.push(`commitments[${index}].status must be signed, funded, onchain-funded, or live`);
    }
    if (counterparty.length < 2) failures.push(`commitments[${index}].counterparty is missing`);
    if (!amountWei || amountWei <= 0n) failures.push(`commitments[${index}].amountEth must be positive`);
    if (evidenceRef.length < 12) failures.push(`commitments[${index}].evidence needs a concrete reference`);
    if (!Number.isFinite(expiryMs) || expiryMs <= now) {
      failures.push(`commitments[${index}].expiresAt must be a future ISO timestamp`);
    }

    if (amountWei && amountWei > 0n && kind === "solver-float") solverFloatWei += amountWei;
    if (amountWei && amountWei > 0n && kind === "boosted-demand") boostedDemandWei += amountWei;
  });

  const requiredBoostedWei = ethToWei(boostedDemandEth);
  const requiredSolverWei = ethToWei(solverFloatEth);
  if (requiredBoostedWei && boostedDemandWei < requiredBoostedWei) {
    failures.push(
      `boosted-demand total ${weiToEthText(boostedDemandWei)} ETH is below required ${weiToEthText(requiredBoostedWei)} ETH`,
    );
  }
  if (requiredSolverWei && solverFloatWei < requiredSolverWei) {
    failures.push(
      `solver-float total ${weiToEthText(solverFloatWei)} ETH is below required ${weiToEthText(requiredSolverWei)} ETH`,
    );
  }

  if (failures.length) {
    fail(
      checks,
      "liquidity",
      "solver and liquidity commitments",
      failures.join("; "),
      {
        file,
        solverFloatEth: weiToEthText(solverFloatWei),
        boostedDemandEth: weiToEthText(boostedDemandWei),
      },
    );
    return;
  }

  pass(
    checks,
    "liquidity",
    "solver and liquidity commitments",
    `Structured commitments cover ${weiToEthText(boostedDemandWei)} ETH Boosted demand and ${weiToEthText(solverFloatWei)} ETH solver float.`,
    {
      file,
      commitments: commitments.length,
      solverFloatEth: weiToEthText(solverFloatWei),
      boostedDemandEth: weiToEthText(boostedDemandWei),
    },
  );
}

function checkManifest(checks, manifestPath) {
  if (!manifestPath) {
    fail(checks, "deployment", "production manifest provided", "Pass --manifest for the production deployment.");
    return null;
  }
  if (!exists(manifestPath)) {
    fail(checks, "deployment", "production manifest provided", `Manifest file not found: ${manifestPath}.`, {
      manifest: manifestPath,
    });
    return null;
  }

  let manifest;
  try {
    manifest = parseJsonFile(manifestPath);
  } catch (error) {
    fail(checks, "deployment", "production manifest parses", `Manifest JSON parse failed: ${error.message}.`, {
      manifest: manifestPath,
    });
    return null;
  }

  pass(checks, "deployment", "production manifest parses", `Manifest parsed: ${manifestPath}.`, {
    manifest: manifestPath,
  });

  if (manifest.mode === "production") {
    pass(checks, "deployment", "manifest mode is production", "Manifest mode is production.");
  } else {
    fail(
      checks,
      "deployment",
      "manifest mode is production",
      `Manifest mode is '${manifest.mode || "unset"}'. Production launch requires mode 'production'.`,
      { mode: manifest.mode || null },
    );
  }

  if (path.normalize(manifestPath) === path.normalize(path.join("demo", "contract-manifest.json"))) {
    fail(
      checks,
      "deployment",
      "manifest is not demo manifest",
      "demo/contract-manifest.json is a local demo manifest and cannot be used for production approval.",
    );
  } else {
    pass(checks, "deployment", "manifest is not demo manifest", "Production gate is pointed at a non-demo manifest.");
  }

  return manifest;
}

function runLiveChecks(checks, args, manifestReady) {
  if (args.skipLive) {
    warn(checks, "live", "live production gates", "Skipped by --skip-live.");
    return;
  }
  if (!args.rpc) {
    fail(checks, "live", "mainnet RPC provided", "Pass --rpc or MAINNET_RPC_URL/RPC_URL.");
    return;
  }
  pass(checks, "live", "mainnet RPC provided", "RPC URL was provided.");

  if (!args.skipOraclePreflight) {
    runNode(
      checks,
      "oracle",
      "mainnet oracle preflight",
      ["ops/mainnet-oracle-preflight.mjs", "--rpc", args.rpc, "--json"],
      {
        passDetail: "Mainnet Uniswap oracle pool facts matched the expected USDC/USDT/DAI configuration.",
        failDetail: "Mainnet oracle preflight failed.",
      },
    );
  } else {
    warn(checks, "oracle", "mainnet oracle preflight", "Skipped by --skip-oracle-preflight.");
  }

  if (!manifestReady) {
    fail(checks, "readiness", "strict production readiness", "Cannot run live readiness without a valid manifest.");
    return;
  }

  if (!args.skipReadiness) {
    runNode(
      checks,
      "readiness",
      "strict production readiness",
      [
        "ops/readiness-check.mjs",
        "--manifest",
        args.manifest,
        "--rpc",
        args.rpc,
        "--strict",
        "--require-median-oracle",
        "--capacity-strict",
        "--expect-chain-id",
        "0x1",
        "--boosted-demand-eth",
        args.boostedDemandEth,
        "--solver-float-eth",
        args.solverFloatEth,
        "--json",
      ],
      {
        passDetail: "Strict live readiness passed with median oracle and capacity gates.",
        failDetail: "Strict live readiness failed.",
      },
    );
  } else {
    warn(checks, "readiness", "strict production readiness", "Skipped by --skip-readiness.");
  }
}

function runLocalAcceptance(checks, args) {
  if (args.skipLocalAcceptance) {
    warn(
      checks,
      "acceptance",
      "full local acceptance",
      "Skipped by --skip-local-acceptance. Production approval requires this check.",
    );
    return;
  }

  runNode(checks, "acceptance", "full local acceptance", ["ops/mvp-acceptance.mjs", "--local-live"], {
    passDetail: "Full local acceptance passed at this commit.",
    failDetail: "Full local acceptance failed.",
  });
}

function summarize(checks) {
  return checks.reduce(
    (counts, check) => {
      counts[check.level] += 1;
      return counts;
    },
    { pass: 0, warn: 0, fail: 0 },
  );
}

function printText(checks) {
  const counts = summarize(checks);
  const status = counts.fail > 0 ? "FAIL" : counts.warn > 0 ? "WARN" : "PASS";
  console.log(`Production readiness: ${status} (${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail)`);
  for (const check of checks) {
    const label = check.level.toUpperCase();
    console.log(`${label} [${check.area}] ${check.name}`);
    console.log(`     ${check.detail}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const checks = [];

  checkSecurityStatus(checks);
  checkAuditEvidence(checks, args.auditReport);
  checkEvidenceFile(
    checks,
    "operations",
    "incident response runbook",
    args.incidentRunbook,
    "Production requires an incident response runbook.",
  );
  checkSecurityIntake(checks, args.securityIntake);
  checkSolverCommitments(checks, args.solverCommitments, args.boostedDemandEth, args.solverFloatEth);

  if (positiveEth(args.boostedDemandEth)) {
    pass(checks, "liquidity", "committed Boosted/N demand", `Boosted demand commitment: ${args.boostedDemandEth} ETH.`);
  } else {
    fail(
      checks,
      "liquidity",
      "committed Boosted/N demand",
      "Pass --boosted-demand-eth with a positive committed ETH amount.",
      { boostedDemandEth: args.boostedDemandEth || null },
    );
  }
  if (positiveEth(args.solverFloatEth)) {
    pass(checks, "liquidity", "committed solver float", `Solver float commitment: ${args.solverFloatEth} ETH.`);
  } else {
    fail(
      checks,
      "liquidity",
      "committed solver float",
      "Pass --solver-float-eth with a positive committed ETH amount.",
      { solverFloatEth: args.solverFloatEth || null },
    );
  }

  const manifest = checkManifest(checks, args.manifest);
  runLocalAcceptance(checks, args);
  runLiveChecks(checks, args, Boolean(manifest));

  if (args.json) {
    const counts = summarize(checks);
    const status = counts.fail > 0 ? "fail" : counts.warn > 0 ? "warn" : "pass";
    console.log(JSON.stringify({ status, checks }, null, 2));
  } else {
    printText(checks);
  }

  if (checks.some((check) => check.level !== "pass")) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
