#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const REQUIREMENTS = [
  {
    area: "trader",
    name: "Traders can buy and sell Steady ETH and Boosted ETH with ETH",
    evidence: [
      {
        file: "src/vault/EthLPVault.sol",
        patterns: [
          /function buySteady\(/,
          /function buyBoosted\(/,
          /function sellSteady\(/,
          /function sellBoosted\(/,
          /function quoteBuyProduct\(/,
          /function quoteSellProduct\(/,
        ],
      },
      {
        file: "ops/local-live-smoke.mjs",
        patterns: [
          /Trader bought and sold Steady ETH through protocol vault/,
          /Trader bought and sold Boosted ETH through protocol vault/,
        ],
      },
      {
        file: "ops/frontend-live-surface-check.mjs",
        patterns: [
          /SELECTORS\.buySteady/,
          /SELECTORS\.buyBoosted/,
          /SELECTORS\.sellSteady/,
          /SELECTORS\.sellBoosted/,
          /SELECTORS\.quoteBuyProduct/,
          /SELECTORS\.quoteSellProduct/,
        ],
      },
    ],
  },
  {
    area: "lp",
    name: "LPs deposit ETH into a risky protocol LP vault with visible accounting",
    evidence: [
      {
        file: "src/vault/EthLPVault.sol",
        patterns: [
          /function deposit\(\) external payable/,
          /function requestWithdraw\(/,
          /function claimWithdraw\(/,
          /function managedAssets\(/,
          /function fillSteadyRoll\(/,
          /function fillBoostedRoll\(/,
          /function closeStrategy\(/,
        ],
      },
      {
        file: "ops/local-live-smoke.mjs",
        patterns: [
          /ETH LP vault funded/,
          /LP inventory settled and vault return is positive/,
        ],
      },
      {
        file: "SECURITY.md",
        patterns: [
          /vault share price can go down/,
          /market-making PnL with risk/,
          /not as guaranteed yield/,
        ],
      },
      {
        file: "README.md",
        patterns: [
          /There is no guaranteed yield/,
          /LP returns are market-making PnL with risk, not promised yield/,
        ],
      },
    ],
  },
  {
    area: "solver",
    name: "External solvers can permissionlessly bid into public roll auctions",
    evidence: [
      {
        file: "src/RollAuction.sol",
        patterns: [
          /function createAuction\(/,
          /function fill\(/,
          /function fillAll\(/,
          /function fillWithCallback\(/,
          /function activeAuctionIdAt\(/,
          /function activeAuctionIdBySellerAt\(/,
        ],
      },
      {
        file: "src/RollSolver.sol",
        patterns: [
          /function mintAndFill/,
          /function mintAndFillAll/,
          /function mintAndFillWithCallback/,
        ],
      },
      {
        file: "ops/local-live-smoke.mjs",
        patterns: [
          /Solver report confirms external fill before vault/,
          /Solver report confirms vault-only bootstrap/,
        ],
      },
      {
        file: "solver_market.md",
        patterns: [
          /exclusive market makers/,
          /do not need a backend approval path/,
        ],
      },
    ],
  },
  {
    area: "roll-cost",
    name: "Normal rolls stay within <= 10 bps or the system pauses/shrinks/requires liquidity",
    evidence: [
      {
        file: "script/DeployEthereumPilot.sol",
        patterns: [
          /MAX_NORMAL_ROLL_COST_BPS = 10/,
          /MIN_NORMAL_ROLL_PRICE_WAD = 0\.999e18/,
          /maxLpAuctionPriceDropBps > MAX_NORMAL_ROLL_COST_BPS/,
        ],
      },
      {
        file: "ops/readiness-check.mjs",
        patterns: [
          /maxNormalRollCostBps: 10/,
          /LP backstop decay stays within normal-roll target/,
          /normal roll floor stays within target cost/,
          /LP inventory sales cannot dump below normal-roll target/,
        ],
      },
      {
        file: "ops/vault-strategy-plan.mjs",
        patterns: [
          /maxNormalRollBps: 10/,
          /action = "pause-rolls"/,
          /shrink capacity/,
          /require more solver\/backstop liquidity/,
        ],
      },
      {
        file: "ops/mvp-acceptance.mjs",
        patterns: [
          /"--max-weighted-bps",\s*"10"/,
          /ETH LP vault rejects expensive roll smoke/,
          /"--expect-action",\s*"pause-rolls"/,
        ],
      },
    ],
  },
  {
    area: "settlement",
    name: "Settlement uses a median of USDC, USDT, and DAI Uniswap TWAP oracles for production-style readiness",
    evidence: [
      {
        file: "src/oracle/MedianStableTwapSettlementOracle.sol",
        patterns: [
          /median of three stablecoin\/WETH Uniswap v3 TWAPs/,
          /return \(true, _median\(prices\[0\], prices\[1\], prices\[2\]\)\)/,
          /function _median\(/,
        ],
      },
      {
        file: "src/oracle/EthereumMainnetOracleConfig.sol",
        patterns: [
          /usdcPool/,
          /usdtPool/,
          /daiPool/,
          /0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640/,
          /0x11b815efB8f581194ae79006d24E0d814B7697F6/,
          /0x60594a405d53811d3BC4766596EFD80fd545A270/,
        ],
      },
      {
        file: "test/MedianStableTwapSettlementOracle.t.sol",
        patterns: [
          /testSettlesToMedianStableTwap/,
          /testMedianIgnoresOneIssuerOutlier/,
          /testMedianIgnoresOneHighIssuerOutlier/,
          /testFuzzSettlesToMedianOfThreeStableSources/,
          /testRequiresAllThreeStableSourcesReady/,
          /testRejectsDuplicateSourcePools/,
        ],
      },
      {
        file: "ops/local-live-smoke.mjs",
        patterns: [
          /Readiness rejects live-mode mock settlement automatically/,
          /Readiness rejects mock settlement when median oracle is required/,
        ],
      },
    ],
  },
  {
    area: "decentralization",
    name: "The MVP avoids trusted manual settlement, exclusive market makers, hidden emergency costs, and centralized roll execution",
    evidence: [
      {
        file: "ops/no-admin-surface-check.mjs",
        patterns: [
          /Ownable/,
          /AccessControl/,
          /RollAuction must be deployed with guardian address\(0\)/,
          /Ethereum pilot deployment must not use MockSettlementOracle/,
        ],
      },
      {
        file: "ops/readiness-check.mjs",
        patterns: [
          /auction guardian is disabled/,
          /one-time deployment setup is closed/,
          /protocol liveness surface is permissionless/,
          /Protocol ETH Liquidity Vault trader quotes\/capacity/,
          /settlement oracle wiring/,
        ],
      },
      {
        file: "ops/local-live-smoke.mjs",
        patterns: [
          /Readiness accepts vault-backed trader route without secondary AMMs/,
          /Readiness rejects unpinned LP roll sellers/,
          /Readiness rejects nonzero auction guardian by default/,
          /Readiness rejects LP backstop premium above par/,
        ],
      },
      {
        file: "SECURITY.md",
        patterns: [
          /trusted manual settlement fallback/,
          /exclusive market maker dependency/,
          /hidden expensive roll fallback/,
          /centralized roll execution path/,
        ],
      },
    ],
  },
];

async function read(file) {
  return fs.readFile(path.join(ROOT, file), "utf8");
}

function patternLabel(pattern) {
  return pattern.source.replaceAll("\\", "");
}

async function checkEvidence(group) {
  const source = await read(group.file);
  const missing = group.patterns.filter((pattern) => !pattern.test(source));
  return {
    file: group.file,
    status: missing.length ? "fail" : "pass",
    missing,
  };
}

async function main() {
  const results = [];
  for (const requirement of REQUIREMENTS) {
    const evidence = [];
    for (const group of requirement.evidence) {
      evidence.push(await checkEvidence(group));
    }
    results.push({
      area: requirement.area,
      name: requirement.name,
      evidence,
      status: evidence.some((item) => item.status === "fail") ? "fail" : "pass",
    });
  }

  const failures = results.filter((item) => item.status === "fail");
  if (failures.length) {
    console.error(`MVP objective audit: FAIL (${results.length - failures.length} pass, ${failures.length} fail)`);
    for (const failure of failures) {
      console.error(`- [${failure.area}] ${failure.name}`);
      for (const evidence of failure.evidence.filter((item) => item.status === "fail")) {
        console.error(`  ${evidence.file}`);
        for (const pattern of evidence.missing) console.error(`    missing: ${patternLabel(pattern)}`);
      }
    }
    process.exit(1);
  }

  const evidenceCount = results.reduce((count, item) => count + item.evidence.length, 0);
  console.log(`MVP objective audit: PASS (${results.length} requirements, ${evidenceCount} evidence groups)`);
  for (const result of results) console.log(`PASS [${result.area}] ${result.name}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
