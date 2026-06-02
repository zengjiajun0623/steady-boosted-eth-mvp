#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_DEPLOYER_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const DEFAULT_TRADER_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000001001";
const DEFAULT_LP_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000001002";
const DEFAULT_SOLVER_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000001003";
const DEFAULT_KEEPER_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000001004";
const CHAIN_ID = "31337";
const ONE_ETH = 10n ** 18n;
const STRIKE_PRICE_WAD = "1000000000000000000000";

function usage() {
  return `Usage:
  node ops/local-live-smoke.mjs [options]

Options:
  --private-key <key>       Deployer key alias (default: first Anvil account)
  --deployer-private-key <key>
                            Deployer/seeder key (default: PRIVATE_KEY env or first Anvil account)
  --trader-private-key <key>
                            Trader key (default: deterministic funded smoke key)
  --lp-private-key <key>    LP depositor key (default: deterministic funded smoke key)
  --solver-private-key <key>
                            External solver key (default: deterministic funded smoke key)
  --keeper-private-key <key>
                            Permissionless keeper key (default: deterministic funded smoke key)
  --no-solver-launch        Skip external solver fill and let the ETH LP vault clear the roll
  --readiness-only          Deploy, fund the LP vault, run strict readiness, then stop
  --negative-readiness      Also prove strict readiness rejects known-bad trust topology
  --port <port>             Anvil port (default: pick a free local port)
  --keep-anvil              Leave Anvil running after the smoke test
  --json                    Print machine-readable JSON

This starts a fresh Anvil chain, deploys the local MVP, funds the ETH LP vault,
runs strict live readiness, uses separate trader/LP/solver/keeper accounts,
buys/sells Steady and Boosted ETH, starts a public roll auction, then either
fills it with an external solver plus the ETH LP vault or, with
--no-solver-launch, lets the ETH LP vault clear the roll alone. It finalizes
the Steady wrapper roll, settles the inventory, and verifies the LP vault earned
a positive market-making return.`;
}

function parseArgs(argv) {
  const args = {
    deployerPrivateKey: process.env.PRIVATE_KEY || DEFAULT_DEPLOYER_PRIVATE_KEY,
    traderPrivateKey: process.env.TRADER_PRIVATE_KEY || DEFAULT_TRADER_PRIVATE_KEY,
    lpPrivateKey: process.env.LP_PRIVATE_KEY || DEFAULT_LP_PRIVATE_KEY,
    solverPrivateKey: process.env.SOLVER_PRIVATE_KEY || DEFAULT_SOLVER_PRIVATE_KEY,
    keeperPrivateKey:
      process.env.WRAPPER_KEEPER_PRIVATE_KEY || process.env.LP_KEEPER_PRIVATE_KEY || DEFAULT_KEEPER_PRIVATE_KEY,
    port: 0,
    keepAnvil: false,
    noSolverLaunch: false,
    readinessOnly: false,
    negativeReadiness: false,
    json: false,
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
    } else if (arg === "--private-key" || arg === "--deployer-private-key") {
      args.deployerPrivateKey = next();
    } else if (arg === "--trader-private-key") {
      args.traderPrivateKey = next();
    } else if (arg === "--lp-private-key") {
      args.lpPrivateKey = next();
    } else if (arg === "--solver-private-key") {
      args.solverPrivateKey = next();
    } else if (arg === "--keeper-private-key") {
      args.keeperPrivateKey = next();
    } else if (arg === "--no-solver-launch") {
      args.noSolverLaunch = true;
    } else if (arg === "--readiness-only") {
      args.readinessOnly = true;
    } else if (arg === "--negative-readiness") {
      args.negativeReadiness = true;
    } else if (arg === "--port") {
      args.port = Number(next());
      if (!Number.isInteger(args.port) || args.port <= 0) throw new Error("--port must be a positive integer");
    } else if (arg === "--keep-anvil") {
      args.keepAnvil = true;
    } else if (arg === "--json") {
      args.json = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return args;
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function rpcCall(rpcUrl, method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload.error) throw new Error(`${method}: ${payload.error.message || JSON.stringify(payload.error)}`);
  return payload.result;
}

async function waitForRpc(rpcUrl) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await rpcCall(rpcUrl, "eth_chainId");
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`Anvil did not become ready at ${rpcUrl}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(command, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: options.env ? { ...process.env, ...options.env } : process.env,
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeoutMs || 180_000,
    });
    if (options.echo) {
      if (stdout.trim()) process.stdout.write(stdout);
      if (stderr.trim()) process.stderr.write(stderr);
    }
    return `${stdout}${stderr}`.trim();
  } catch (error) {
    const output = `${error.stdout || ""}${error.stderr || ""}`.trim();
    error.message = output ? `${error.message}\n${output}` : error.message;
    throw error;
  }
}

async function cast(args, options = {}) {
  return run("cast", args, options);
}

async function runKeeperRunner({ rpcUrl, manifestPath, action, env, decisionArgs = [], maxActions = 1 }) {
  return run(process.execPath, [
    "ops/keeper-runner.mjs",
    "--execute",
    "--action",
    action,
    "--max-actions",
    String(maxActions),
    "--manifest",
    manifestPath,
    "--rpc",
    rpcUrl,
    ...decisionArgs,
  ], {
    env,
    timeoutMs: 180_000,
  });
}

async function castSend(rpcUrl, privateKey, to, signature, args = [], options = {}) {
  const sendArgs = [
    "send",
    to,
    signature,
    ...args.map(String),
    "--rpc-url",
    rpcUrl,
    "--private-key",
    privateKey,
    "--confirmations",
    "1",
    "--timeout",
    "60",
  ];
  if (options.value !== undefined) sendArgs.push("--value", String(options.value));
  return cast(sendArgs, { timeoutMs: options.timeoutMs || 120_000 });
}

async function sendEth(rpcUrl, privateKey, to, value) {
  return cast([
    "send",
    to,
    "--rpc-url",
    rpcUrl,
    "--private-key",
    privateKey,
    "--value",
    String(value),
    "--confirmations",
    "1",
    "--timeout",
    "60",
  ]);
}

async function castCall(rpcUrl, to, signature, args = []) {
  return cast(["call", to, signature, ...args.map(String), "--rpc-url", rpcUrl]);
}

function parseAddress(output) {
  const match = output.match(/0x[a-fA-F0-9]{40}/);
  if (!match) throw new Error(`Could not parse address from: ${output}`);
  return match[0];
}

function parseDeployedAddress(output) {
  const match = output.match(/Deployed to:\s*(0x[a-fA-F0-9]{40})/i);
  if (match) return match[1];
  return parseAddress(output);
}

function parseUint(output) {
  const hex = output.match(/0x[a-fA-F0-9]+/);
  if (hex) return BigInt(hex[0]);
  const decimal = output.match(/\b\d+\b/);
  if (!decimal) throw new Error(`Could not parse uint from: ${output}`);
  return BigInt(decimal[0]);
}

function wei(decimalEth) {
  const [whole, fraction = ""] = String(decimalEth).split(".");
  const padded = `${fraction}000000000000000000`.slice(0, 18);
  return BigInt(whole || "0") * ONE_ETH + BigInt(padded);
}

async function accountFromKey(privateKey) {
  return parseAddress(await cast(["wallet", "address", privateKey]));
}

function assertDistinctRoles(roles) {
  const seen = new Map();
  for (const [name, address] of Object.entries(roles)) {
    const key = address.toLowerCase();
    if (seen.has(key)) throw new Error(`Smoke role ${name} shares address with ${seen.get(key)}: ${address}`);
    seen.set(key, name);
  }
}

async function readTokenBalance(rpcUrl, token, account) {
  return parseUint(await castCall(rpcUrl, token, "balanceOf(address)(uint256)", [account]));
}

async function readManagedAssets(rpcUrl, lpVault) {
  return parseUint(await castCall(rpcUrl, lpVault, "managedAssets()(uint256)"));
}

function strictReadinessArgs({ manifestPath, rpcUrl, noSolverLaunch }) {
  return [
    "ops/readiness-check.mjs",
    "--manifest",
    manifestPath,
    "--rpc",
    rpcUrl,
    "--boosted-demand-eth",
    noSolverLaunch ? "0" : "5000",
    "--solver-float-eth",
    noSolverLaunch ? "0" : "250",
    "--capacity-strict",
    "--strict",
    "--expect-chain-id",
    "0x7a69",
    ...(noSolverLaunch ? ["--no-solver-launch"] : []),
  ];
}

async function writeTamperedManifest(tempDir, manifest, suffix, mutate) {
  const clone = JSON.parse(JSON.stringify(manifest));
  mutate(clone);
  const outputPath = path.join(tempDir, `contract-manifest.${suffix}.json`);
  await fs.writeFile(outputPath, `${JSON.stringify(clone, null, 2)}\n`);
  return outputPath;
}

async function expectReadinessFailure({ name, manifestPath, rpcUrl, noSolverLaunch, expectedText }) {
  try {
    await run(process.execPath, strictReadinessArgs({ manifestPath, rpcUrl, noSolverLaunch }), {
      timeoutMs: 180_000,
    });
  } catch (error) {
    if (expectedText && !error.message.includes(expectedText)) {
      throw new Error(`${name} failed, but not for the expected reason "${expectedText}".\n${error.message}`);
    }
    return error.message.split(/\r?\n/).slice(-20).join("\n");
  }
  throw new Error(`${name} unexpectedly passed strict readiness.`);
}

async function deployGuardedRollAuction(rpcUrl, privateKey, guardian) {
  const output = await run("forge", [
    "create",
    "--rpc-url",
    rpcUrl,
    "--private-key",
    privateKey,
    "--broadcast",
    "src/RollAuction.sol:RollAuction",
    "--constructor-args",
    guardian,
    String(wei("0.01")),
    "16",
    "4",
  ], { timeoutMs: 300_000 });
  return parseDeployedAddress(output);
}

async function exerciseMarket({ rpcUrl, privateKey, account, market, buyWei, sellFractionBps }) {
  const token = parseAddress(await castCall(rpcUrl, market, "token()(address)"));
  const before = await readTokenBalance(rpcUrl, token, account);
  await castSend(rpcUrl, privateKey, market, "buyToken(uint256,address)", [0, account], { value: buyWei });
  const afterBuy = await readTokenBalance(rpcUrl, token, account);
  const acquired = afterBuy - before;
  if (acquired <= 0n) throw new Error(`Market ${market} buy returned no product tokens`);

  const sellAmount = (acquired * BigInt(sellFractionBps)) / 10_000n;
  if (sellAmount <= 0n) throw new Error(`Market ${market} sell amount rounded to zero`);
  await castSend(rpcUrl, privateKey, token, "approve(address,uint256)", [market, sellAmount]);
  await castSend(rpcUrl, privateKey, market, "sellToken(uint256,uint256,address)", [sellAmount, 0, account]);

  return { market, token, acquired: acquired.toString(), sold: sellAmount.toString() };
}

async function runLiveSmoke(args) {
  const port = args.port || (await getFreePort());
  const rpcUrl = `http://127.0.0.1:${port}`;
  await fs.mkdir(path.join("demo", ".tmp"), { recursive: true });
  const tempDir = await fs.mkdtemp(path.join("demo", ".tmp", "local-live-smoke-"));
  const registryPath = path.join(tempDir, "deployment-registry.txt");
  const manifestPath = path.join(tempDir, "contract-manifest.json");

  const anvil = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", CHAIN_ID, "--silent"], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let anvilLog = "";
  anvil.stdout.on("data", (chunk) => {
    anvilLog += chunk.toString();
  });
  anvil.stderr.on("data", (chunk) => {
    anvilLog += chunk.toString();
  });

  const steps = [];
  const record = (name, data = {}) => steps.push({ name, ...data });

  try {
    await waitForRpc(rpcUrl);
    record("Anvil started", { rpcUrl });

    const roles = {
      deployer: await accountFromKey(args.deployerPrivateKey),
      trader: await accountFromKey(args.traderPrivateKey),
      lp: await accountFromKey(args.lpPrivateKey),
      solver: await accountFromKey(args.solverPrivateKey),
      keeper: await accountFromKey(args.keeperPrivateKey),
    };
    assertDistinctRoles(roles);
    record("Smoke role accounts derived", roles);

    await sendEth(rpcUrl, args.deployerPrivateKey, roles.trader, wei("5"));
    await sendEth(rpcUrl, args.deployerPrivateKey, roles.lp, wei("1002"));
    await sendEth(rpcUrl, args.deployerPrivateKey, roles.solver, wei("5"));
    await sendEth(rpcUrl, args.deployerPrivateKey, roles.keeper, wei("5"));
    record("Smoke roles funded", {
      trader: "5 ETH",
      lp: "1002 ETH",
      solver: "5 ETH",
      keeper: "5 ETH",
    });

    await run(process.execPath, [
      "ops/deploy-local-demo.mjs",
      "--rpc",
      rpcUrl,
      "--private-key",
      args.deployerPrivateKey,
      "--registry-out",
      registryPath,
      "--out",
      manifestPath,
      "--seed-recipient",
      roles.deployer,
    ], { timeoutMs: 300_000 });
    record("Local MVP deployed and seeded", { manifestPath });

    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const { contracts, series } = manifest;

    await castSend(rpcUrl, args.lpPrivateKey, contracts.lpVault, "deposit()", [], { value: wei("1000") });
    const managedAtStart = await readManagedAssets(rpcUrl, contracts.lpVault);
    record("ETH LP vault funded", { lpVault: contracts.lpVault, amountWei: managedAtStart.toString() });

    await run(process.execPath, strictReadinessArgs({
      manifestPath,
      rpcUrl,
      noSolverLaunch: args.noSolverLaunch,
    }), { timeoutMs: 180_000 });
    record(args.noSolverLaunch ? "Strict no-solver live readiness passed" : "Strict live readiness passed");

    if (args.negativeReadiness) {
      const unpinnedLpManifestPath = await writeTamperedManifest(
        tempDir,
        manifest,
        "unpinned-lp-seller",
        (draft) => {
          draft.contracts.steadyVault = contracts.boostedVault;
        },
      );
      await expectReadinessFailure({
        name: "Unpinned LP roll seller manifest",
        manifestPath: unpinnedLpManifestPath,
        rpcUrl,
        noSolverLaunch: args.noSolverLaunch,
        expectedText: "LP keeper only backstops protocol wrapper rolls",
      });
      record("Readiness rejects unpinned LP roll sellers", { manifestPath: unpinnedLpManifestPath });

      const guardedAuction = await deployGuardedRollAuction(rpcUrl, args.deployerPrivateKey, roles.deployer);
      const guardedAuctionManifestPath = await writeTamperedManifest(
        tempDir,
        manifest,
        "guarded-auction",
        (draft) => {
          draft.contracts.rollAuction = guardedAuction;
        },
      );
      await expectReadinessFailure({
        name: "Guarded auction manifest",
        manifestPath: guardedAuctionManifestPath,
        rpcUrl,
        noSolverLaunch: args.noSolverLaunch,
        expectedText: "auction guardian is disabled for trust-minimized launch",
      });
      record("Readiness rejects nonzero auction guardian by default", {
        guardedAuction,
        manifestPath: guardedAuctionManifestPath,
      });
    }

    if (args.readinessOnly) {
      return {
        status: "pass",
        mode: args.noSolverLaunch ? "no-solver-readiness" : "manifest-readiness",
        rpcUrl,
        tempDir,
        manifestPath,
        steps,
      };
    }

    const steadyTrade = await exerciseMarket({
      rpcUrl,
      privateKey: args.traderPrivateKey,
      account: roles.trader,
      market: contracts.steadyMarket,
      buyWei: wei("0.1"),
      sellFractionBps: 5_000,
    });
    record("Trader bought and sold Steady ETH", steadyTrade);

    const boostedTrade = await exerciseMarket({
      rpcUrl,
      privateKey: args.traderPrivateKey,
      account: roles.trader,
      market: contracts.boostedMarket,
      buyWei: wei("0.05"),
      sellFractionBps: 10_000,
    });
    record("Trader bought and sold Boosted ETH", boostedTrade);

    const auctionId = parseUint(await castCall(rpcUrl, contracts.rollAuction, "auctionCount()(uint256)"));
    await runKeeperRunner({
      rpcUrl,
      manifestPath,
      action: "wrapper",
      env: { WRAPPER_KEEPER_PRIVATE_KEY: args.keeperPrivateKey },
      decisionArgs: [
        "--start-price-wad",
        "999000000000000000",
        "--floor-price-wad",
        "999000000000000000",
        "--duration",
        "86400",
      ],
    });
    record("Public Steady roll auction started", { auctionId: auctionId.toString() });

    if (args.noSolverLaunch) {
      record("No external solver fill used", {
        auctionId: auctionId.toString(),
        mode: "ETH LP vault clears the roll",
      });
    } else {
      await runKeeperRunner({
        rpcUrl,
        manifestPath,
        action: "solver",
        env: { SOLVER_PRIVATE_KEY: args.solverPrivateKey },
        decisionArgs: [
          "--recipient",
          roles.solver,
          "--max-fill-eth",
          "0.4",
          "--max-price-wad",
          "1000000000000000000",
        ],
      });
      record("External solver filled part of the roll", {
        auctionId: auctionId.toString(),
        maxFillEth: "0.4",
      });
    }

    await rpcCall(rpcUrl, "evm_increaseTime", [14_400]);
    await rpcCall(rpcUrl, "evm_mine");

    await runKeeperRunner({
      rpcUrl,
      manifestPath,
      action: "lp",
      env: { LP_KEEPER_PRIVATE_KEY: args.keeperPrivateKey },
      decisionArgs: [
        "--max-fill-eth",
        args.noSolverLaunch ? "1.0" : "0.6",
        "--max-price-wad",
        "1000000000000000000",
        "--strategy-no-solver-launch",
      ],
    });
    record(args.noSolverLaunch ? "ETH LP vault cleared the roll" : "ETH LP vault backstopped the remaining roll", {
      auctionId: auctionId.toString(),
      maxFillEth: args.noSolverLaunch ? "1.0" : "0.6",
    });

    const solverReportRaw = await run(process.execPath, [
      "ops/solver-improvement-report.mjs",
      "--manifest",
      manifestPath,
      "--rpc",
      rpcUrl,
      "--auction-id",
      auctionId.toString(),
      ...(args.noSolverLaunch ? [] : ["--require-external-fill"]),
      "--json",
    ]);
    const solverReport = JSON.parse(solverReportRaw);
    record(args.noSolverLaunch ? "Solver report confirms vault-only bootstrap" : "Solver report confirms external fill before vault", {
      auctionId: auctionId.toString(),
      externalSolverFillWei: solverReport.totals.externalSolver.sellAmount,
      lpVaultFillWei: solverReport.totals.lpVault.sellAmount,
      solverSavedBuyAmountWei: solverReport.totals.externalSolver.savedBuyAmount,
    });

    await runKeeperRunner({
      rpcUrl,
      manifestPath,
      action: "wrapper",
      env: { WRAPPER_KEEPER_PRIVATE_KEY: args.keeperPrivateKey },
    });
    const currentSeries = (await castCall(rpcUrl, contracts.steadyKeeper, "currentSeriesId()(bytes32)")).trim();
    if (currentSeries.toLowerCase() !== series.secondSeriesId.toLowerCase()) {
      throw new Error(`Steady keeper current series mismatch: ${currentSeries}`);
    }
    record("Steady wrapper finalized into the next series", { currentSeries });

    await rpcCall(rpcUrl, "evm_increaseTime", [60 * 24 * 60 * 60]);
    await rpcCall(rpcUrl, "evm_mine");
    await castSend(
      rpcUrl,
      args.keeperPrivateKey,
      contracts.oracle,
      "setSettlementPrice(bytes32,uint256)",
      [series.firstSeriesId, STRIKE_PRICE_WAD],
    );
    await castSend(
      rpcUrl,
      args.keeperPrivateKey,
      contracts.oracle,
      "setSettlementPrice(bytes32,uint256)",
      [series.secondSeriesId, STRIKE_PRICE_WAD],
    );
    await castSend(rpcUrl, args.keeperPrivateKey, contracts.factory, "settle(bytes32)", [series.firstSeriesId]);
    await castSend(rpcUrl, args.keeperPrivateKey, contracts.factory, "settle(bytes32)", [series.secondSeriesId]);

    await runKeeperRunner({
      rpcUrl,
      manifestPath,
      action: "inventory",
      maxActions: 10,
      env: { INVENTORY_KEEPER_PRIVATE_KEY: args.keeperPrivateKey },
    });
    await runKeeperRunner({
      rpcUrl,
      manifestPath,
      action: "inventory",
      maxActions: 10,
      env: { INVENTORY_KEEPER_PRIVATE_KEY: args.keeperPrivateKey },
    });

    const managedAfterSettlement = await readManagedAssets(rpcUrl, contracts.lpVault);
    if (managedAfterSettlement <= managedAtStart) {
      throw new Error(
        `LP vault did not earn a positive return: start=${managedAtStart}, after=${managedAfterSettlement}`,
      );
    }
    record("LP inventory settled and vault return is positive", {
      managedAtStart: managedAtStart.toString(),
      managedAfterSettlement: managedAfterSettlement.toString(),
      profitWei: (managedAfterSettlement - managedAtStart).toString(),
    });

    return {
      status: "pass",
      mode: args.noSolverLaunch ? "no-solver-launch" : "solver-plus-vault",
      rpcUrl,
      tempDir,
      manifestPath,
      steps,
    };
  } catch (error) {
    return {
      status: "fail",
      rpcUrl,
      tempDir,
      manifestPath,
      error: error.message,
      anvilLog: anvilLog.slice(-4000),
      steps,
    };
  } finally {
    if (!args.keepAnvil) anvil.kill("SIGTERM");
  }
}

function printReport(result) {
  console.log(`Local live smoke: ${result.status.toUpperCase()}`);
  if (result.mode) console.log(`Mode: ${result.mode}`);
  console.log(`RPC: ${result.rpcUrl}`);
  console.log(`Manifest: ${result.manifestPath}`);
  console.log("");
  for (const step of result.steps) {
    console.log(`PASS ${step.name}`);
  }
  if (result.status !== "pass") {
    console.log("");
    console.log(`FAIL ${result.error}`);
    if (result.anvilLog) console.log(result.anvilLog);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runLiveSmoke(args);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printReport(result);
  }

  if (result.status !== "pass") process.exit(1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
