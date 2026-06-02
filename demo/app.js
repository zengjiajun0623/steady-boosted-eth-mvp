const DATA_URL = "../data/eth-usd-2018-01-01-2026-06-01.csv";
const CONTRACT_MANIFEST_URL = "./contract-manifest.json";
const BASE_USD = 1000;
const IV = 0.9;
const CAPACITY_POLICY = {
  rlpCapitalRatio: 10,
  nExternalFill: 0.95,
  avgNDemandRatio: 2.1152,
  stressNDemandRatio: 16.0364,
  noSolverLaunch: true,
};
const SELECTORS = {
  buyToken: "0x9134709e",
  sellToken: "0x88036ac5",
  ammToken: "0xfc0c546a",
  deposit: "0xd0e30db0",
  approve: "0x095ea7b3",
  quoteBuyToken: "0xdef151a1",
  quoteSellToken: "0x80870de0",
  balanceOf: "0x70a08231",
  vaultShare: "0xa8d5fd65",
  activeStrategyEth: "0x3271f123",
  strategyActive: "0xbd2a8b07",
  managedAssets: "0xf4a0877f",
  convertToShares: "0xc6e6f592",
  convertToAssets: "0x07a2d13a",
  requestWithdraw: "0x745400c9",
  claimWithdraw: "0x0e8584aa",
  withdrawalRequests: "0x27b380f3",
  rollAuctionAuction: "0x571a26a0",
  rollAuctionPrice: "0xedae47cf",
  rollAuctionResetStatus: "0xb5ce6399",
  rollAuctionStopped: "0x75f12b21",
  rollAuctionFill: "0x7c5a9f02",
  activeAuctionCount: "0x72e2867d",
  activeAuctionIdAt: "0xb3588a17",
  activeAuctionCountBySeller: "0x9f4fd695",
  activeAuctionIdBySellerAt: "0x38750e9a",
  rollSolverMintAndFillP: "0x416dd356",
  rollSolverMintAndFillN: "0x17a7c0db",
  rollSolverMintAndFillPCallback: "0xafc91894",
  rollSolverMintAndFillNCallback: "0x13b1e683",
  wrapperCurrentToken: "0x836c081d",
  wrapperRollActive: "0xaf14c49f",
  wrapperRoll: "0xcd5e3c5d",
  keeperCurrentSeriesId: "0xc9777451",
  keeperPendingSeriesId: "0xe2f6f51a",
  keeperStartRoll: "0x586ac13f",
  keeperResetRoll: "0x0f3358c0",
  keeperFinalizeRoll: "0xdc0600e1",
  keeperCancelRoll: "0x9c8196ea",
  factorySeries: "0xf5de118e",
  factorySettle: "0x987757dd",
  factoryMerge: "0x7682caa3",
  factoryRedeemP: "0x38312c9b",
  factoryRedeemN: "0x5f91bf73",
  healthMarket: "0x80b7f991",
  healthLpVault: "0x48bd419c",
  healthWrapper: "0x254fe68f",
  healthSeries: "0x43f7b47e",
  healthAuction: "0x71ea82c9",
};
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;

const AUCTIONS = {
  steady: {
    title: "Steady roll",
    product: "Steady ETH",
    oldToken: "old Steady ETH",
    nextToken: "next Steady ETH",
    pairedInventory: "Boosted ETH",
    availableEth: 18.4,
    startPrice: 1.012,
    floorPrice: 0.986,
    progress: 0.62,
    durationHours: 8,
    backstop: "ETH LP vault",
    helper: "RollSolver can receive inventory and mint the payment inside one settlement transaction.",
  },
  boosted: {
    title: "Boosted roll",
    product: "Boosted ETH",
    oldToken: "old Boosted ETH",
    nextToken: "next Boosted ETH",
    pairedInventory: "Steady ETH",
    availableEth: 7.8,
    startPrice: 1.018,
    floorPrice: 0.976,
    progress: 0.72,
    durationHours: 6,
    backstop: "ETH LP vault",
    helper: "Solvers receive inventory, mint next Boosted ETH for payment, and keep the paired Steady ETH.",
  },
};

const state = {
  page: "trader",
  strategy: "steady",
  tradeSide: "buy",
  activeAuction: "steady",
  costBps: 10,
  candles: [],
  simulation: null,
  forwardConfigured: false,
  lpMode: "deposit",
  lpDeposit: 0,
  lpEarned: 0,
  lpPendingWithdraw: {
    assets: 0,
    unlockAt: 0,
  },
  demoWrapperRolls: {
    steady: { active: false, filled: false, auctionId: null },
    boosted: { active: false, filled: false, auctionId: null },
  },
  auctionFills: {
    steady: 0,
    boosted: 0,
  },
  contracts: {
    manifest: null,
    account: null,
    chainId: null,
    walletAvailable: false,
  },
  onchain: {
    lastRefresh: 0,
    refreshing: false,
    refreshTimer: null,
    pendingIncludeQuote: false,
    balances: null,
    quote: null,
    lp: null,
    marketTokens: {},
    auctions: {},
    auctionDirectory: [],
    wrapperRolls: {},
    settlements: {},
    health: null,
  },
  balances: {
    eth: 12.5,
    steady: 12_000,
    boosted: 8_000,
  },
};

const els = {
  appTitle: document.querySelector("#appTitle"),
  connectionMode: document.querySelector("#connectionMode"),
  connectionStatus: document.querySelector("#connectionStatus"),
  contractNetwork: document.querySelector("#contractNetwork"),
  connectWallet: document.querySelector("#connectWallet"),
  audienceTabs: document.querySelectorAll(".audience-tab"),
  pages: {
    trader: document.querySelector("#traderPage"),
    lp: document.querySelector("#lpPage"),
    solver: document.querySelector("#solverPage"),
  },
  auctionRows: document.querySelectorAll("[data-auction]"),
  auctionBoardMode: document.querySelector("#auctionBoardMode"),
  auctionEmptyState: document.querySelector("#auctionEmptyState"),
  steadyAuctionSize: document.querySelector("#steadyAuctionSize"),
  boostedAuctionSize: document.querySelector("#boostedAuctionSize"),
  steadyAuctionPrice: document.querySelector("#steadyAuctionPrice"),
  boostedAuctionPrice: document.querySelector("#boostedAuctionPrice"),
  steadyAuctionEdge: document.querySelector("#steadyAuctionEdge"),
  boostedAuctionEdge: document.querySelector("#boostedAuctionEdge"),
  steadyAuctionTime: document.querySelector("#steadyAuctionTime"),
  boostedAuctionTime: document.querySelector("#boostedAuctionTime"),
  steadyAuctionState: document.querySelector("#steadyAuctionState"),
  boostedAuctionState: document.querySelector("#boostedAuctionState"),
  solverTitle: document.querySelector("#solverTitle"),
  solverSub: document.querySelector("#solverSub"),
  solverMode: document.querySelector("#solverMode"),
  solverFill: document.querySelector("#solverFill"),
  solverFillValue: document.querySelector("#solverFillValue"),
  solverPayLabel: document.querySelector("#solverPayLabel"),
  solverPay: document.querySelector("#solverPay"),
  solverPaySub: document.querySelector("#solverPaySub"),
  solverReceive: document.querySelector("#solverReceive"),
  solverReceiveSub: document.querySelector("#solverReceiveSub"),
  solverEdge: document.querySelector("#solverEdge"),
  solverEdgeSub: document.querySelector("#solverEdgeSub"),
  solverPrice: document.querySelector("#solverPrice"),
  solverFloor: document.querySelector("#solverFloor"),
  solverTimeLeft: document.querySelector("#solverTimeLeft"),
  solverBackstop: document.querySelector("#solverBackstop"),
  solverRoute: document.querySelector("#solverRoute"),
  solverRouteSub: document.querySelector("#solverRouteSub"),
  solverInventory: document.querySelector("#solverInventory"),
  solverAction: document.querySelector("#solverAction"),
  solverStatus: document.querySelector("#solverStatus"),
  keeperSub: document.querySelector("#keeperSub"),
  keeperMode: document.querySelector("#keeperMode"),
  keeperProduct: document.querySelector("#keeperProduct"),
  keeperInventory: document.querySelector("#keeperInventory"),
  keeperNextSeries: document.querySelector("#keeperNextSeries"),
  keeperAuction: document.querySelector("#keeperAuction"),
  keeperStartRoll: document.querySelector("#keeperStartRoll"),
  keeperResetRoll: document.querySelector("#keeperResetRoll"),
  keeperFinalizeRoll: document.querySelector("#keeperFinalizeRoll"),
  keeperCancelRoll: document.querySelector("#keeperCancelRoll"),
  keeperStatus: document.querySelector("#keeperStatus"),
  keeperStartPrice: document.querySelector("#keeperStartPrice"),
  keeperFloorPrice: document.querySelector("#keeperFloorPrice"),
  keeperDuration: document.querySelector("#keeperDuration"),
  settlementSub: document.querySelector("#settlementSub"),
  settlementMode: document.querySelector("#settlementMode"),
  settlementProduct: document.querySelector("#settlementProduct"),
  settlementSeries: document.querySelector("#settlementSeries"),
  settlementMaturity: document.querySelector("#settlementMaturity"),
  settlementPrice: document.querySelector("#settlementPrice"),
  settlementBalance: document.querySelector("#settlementBalance"),
  settlementBalanceSub: document.querySelector("#settlementBalanceSub"),
  settlementRedeemable: document.querySelector("#settlementRedeemable"),
  settlementRedeemableSub: document.querySelector("#settlementRedeemableSub"),
  settlementMergeable: document.querySelector("#settlementMergeable"),
  settlementMergeableSub: document.querySelector("#settlementMergeableSub"),
  settlementMerge: document.querySelector("#settlementMerge"),
  settlementSettle: document.querySelector("#settlementSettle"),
  settlementRedeem: document.querySelector("#settlementRedeem"),
  settlementStatus: document.querySelector("#settlementStatus"),
  operatorSub: document.querySelector("#operatorSub"),
  operatorMode: document.querySelector("#operatorMode"),
  operatorMarketDepth: document.querySelector("#operatorMarketDepth"),
  operatorMarketDepthSub: document.querySelector("#operatorMarketDepthSub"),
  operatorVaultUtil: document.querySelector("#operatorVaultUtil"),
  operatorVaultUtilSub: document.querySelector("#operatorVaultUtilSub"),
  operatorRollState: document.querySelector("#operatorRollState"),
  operatorRollStateSub: document.querySelector("#operatorRollStateSub"),
  operatorSeriesCap: document.querySelector("#operatorSeriesCap"),
  operatorSeriesCapSub: document.querySelector("#operatorSeriesCapSub"),
  strategyButtons: document.querySelectorAll(".strategy-button"),
  sideButtons: document.querySelectorAll(".side-button"),
  tradePresetButtons: document.querySelectorAll("[data-trade-preset]"),
  deposit: document.querySelector("#deposit"),
  depositValue: document.querySelector("#depositValue"),
  tradeAmountLabel: document.querySelector("#tradeAmountLabel"),
  walletLabel: document.querySelector("#walletLabel"),
  walletBalance: document.querySelector("#walletBalance"),
  rollStatus: document.querySelector("#rollStatus"),
  tradeCapacity: document.querySelector("#tradeCapacity"),
  tradeAction: document.querySelector("#tradeAction"),
  tradeStatus: document.querySelector("#tradeStatus"),
  resultTitle: document.querySelector("#resultTitle"),
  resultSub: document.querySelector("#resultSub"),
  quotePayLabel: document.querySelector("#quotePayLabel"),
  quotePay: document.querySelector("#quotePay"),
  quotePayAsset: document.querySelector("#quotePayAsset"),
  quoteReceiveLabel: document.querySelector("#quoteReceiveLabel"),
  quoteReceive: document.querySelector("#quoteReceive"),
  quoteReceiveAsset: document.querySelector("#quoteReceiveAsset"),
  quoteFee: document.querySelector("#quoteFee"),
  routeText: document.querySelector("#routeText"),
  quoteNote: document.querySelector("#quoteNote"),
  seriesSummary: document.querySelector("#seriesSummary"),
  seriesStrike: document.querySelector("#seriesStrike"),
  seriesMaturity: document.querySelector("#seriesMaturity"),
  seriesRoll: document.querySelector("#seriesRoll"),
  futurePreviewLabel: document.querySelector("#futurePreviewLabel"),
  primaryLabel: document.querySelector("#primaryLabel"),
  primaryValue: document.querySelector("#primaryValue"),
  primarySub: document.querySelector("#primarySub"),
  traderDrawdown: document.querySelector("#traderDrawdown"),
  traderBadCase: document.querySelector("#traderBadCase"),
  traderTypicalCase: document.querySelector("#traderTypicalCase"),
  traderGoodCase: document.querySelector("#traderGoodCase"),
  traderChartTitle: document.querySelector("#traderChartTitle"),
  traderChartSub: document.querySelector("#traderChartSub"),
  scenarioBadActive: document.querySelector("#scenarioBadActive"),
  scenarioTypicalActive: document.querySelector("#scenarioTypicalActive"),
  scenarioGoodActive: document.querySelector("#scenarioGoodActive"),
  scenarioBadEth: document.querySelector("#scenarioBadEth"),
  scenarioTypicalEth: document.querySelector("#scenarioTypicalEth"),
  scenarioGoodEth: document.querySelector("#scenarioGoodEth"),
  explainTitle: document.querySelector("#explainTitle"),
  explainText: document.querySelector("#explainText"),
  currentSpot: document.querySelector("#currentSpot"),
  futureDays: document.querySelector("#futureDays"),
  futureDaysValue: document.querySelector("#futureDaysValue"),
  futurePrice: document.querySelector("#futurePrice"),
  futurePriceValue: document.querySelector("#futurePriceValue"),
  simQuestion: document.querySelector("#simQuestion"),
  simQuestionDate: document.querySelector("#simQuestionDate"),
  simRows: document.querySelectorAll("[data-sim-row]"),
  activeProductLabel: document.querySelector("#activeProductLabel"),
  simSteady: document.querySelector("#simSteady"),
  simEth: document.querySelector("#simEth"),
  simBoosted: document.querySelector("#simBoosted"),
  simSteadySub: document.querySelector("#simSteadySub"),
  simEthSub: document.querySelector("#simEthSub"),
  simBoostedSub: document.querySelector("#simBoostedSub"),
  simSteadyBar: document.querySelector("#simSteadyBar"),
  simEthBar: document.querySelector("#simEthBar"),
  simBoostedBar: document.querySelector("#simBoostedBar"),
  lpCapital: document.querySelector("#lpCapital"),
  lpModeButtons: document.querySelectorAll("[data-lp-mode]"),
  lpPresetButtons: document.querySelectorAll("[data-lp-preset]"),
  lpAmountLabel: document.querySelector("#lpAmountLabel"),
  lpCapitalValue: document.querySelector("#lpCapitalValue"),
  lpBalanceLabel: document.querySelector("#lpBalanceLabel"),
  lpWalletValue: document.querySelector("#lpWalletValue"),
  lpAprPreview: document.querySelector("#lpAprPreview"),
  lpUserDeposit: document.querySelector("#lpUserDeposit"),
  lpUserEarned: document.querySelector("#lpUserEarned"),
  lpEarningsPreview: document.querySelector("#lpEarningsPreview"),
  lpEarningsSub: document.querySelector("#lpEarningsSub"),
  lpAction: document.querySelector("#lpAction"),
  lpClaimAction: document.querySelector("#lpClaimAction"),
  lpStatus: document.querySelector("#lpStatus"),
  lpDepositDialog: document.querySelector("#lpDepositDialog"),
  lpModalTitle: document.querySelector("#lpModalTitle"),
  lpModalText: document.querySelector("#lpModalText"),
  lpModalAmountLabel: document.querySelector("#lpModalAmountLabel"),
  lpModalAmount: document.querySelector("#lpModalAmount"),
  lpPendingClaim: document.querySelector("#lpPendingClaim"),
  lpCancelDeposit: document.querySelector("#lpCancelDeposit"),
  lpConfirmDeposit: document.querySelector("#lpConfirmDeposit"),
  nFill: document.querySelector("#nFill"),
  nFillValue: document.querySelector("#nFillValue"),
  lpDepth: document.querySelector("#lpDepth"),
  lpDepthValue: document.querySelector("#lpDepthValue"),
  steadyCapacity: document.querySelector("#steadyCapacity"),
  rollQuote: document.querySelector("#rollQuote"),
  quoteStatus: document.querySelector("#quoteStatus"),
  rlpUtilization: document.querySelector("#rlpUtilization"),
  lpSeriesCap: document.querySelector("#lpSeriesCap"),
  lpChart: document.querySelector("#lpChart"),
  lpCapFill: document.querySelector("#lpCapFill"),
  lpCapText: document.querySelector("#lpCapText"),
};

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-ax * ax));
  return sign * y;
}

function normCdf(x) {
  return 0.5 * (1 + erf(x / Math.sqrt(2)));
}

function bsPut(spot, strike, years, vol) {
  if (years <= 0) return Math.max(strike - spot, 0);
  const sqrtT = Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + 0.5 * vol * vol * years) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;
  return strike * normCdf(-d2) - spot * normCdf(-d1);
}

function pPrice(spot, strike, daysToMaturity) {
  const years = Math.max(daysToMaturity, 0) / 365.25;
  const put = bsPut(spot, strike, years, IV);
  const price = 1 - put / strike;
  const collateralValue = spot / strike;
  return Math.max(0, Math.min(price, collateralValue, 1));
}

function nPrice(spot, strike, daysToMaturity) {
  return Math.max(0, spot / strike - pPrice(spot, strike, daysToMaturity));
}

function parseCsv(csv) {
  return csv
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const [date, close] = line.split(",");
      return { date, close: Number(close) };
    })
    .filter((row) => Number.isFinite(row.close));
}

function simulate(costBps) {
  const candles = state.candles;
  const n = candles.length;
  const spot0 = candles[0].close;
  let strike = spot0 / 2;
  let maturity = Math.min(n - 1, 60);
  let units = BASE_USD / pPrice(spot0, strike, maturity);

  let boostStrike = strike;
  let boostMaturity = maturity;
  let boostUnits = BASE_USD / Math.max(nPrice(spot0, boostStrike, boostMaturity), 0.000001);

  const steady = [];
  const eth = [];
  const boosted = [];
  let rolls = 0;
  let dangerRolls = 0;

  for (let i = 0; i < n; i += 1) {
    const spot = candles[i].close;
    const daysLeft = Math.max(maturity - i, 0);
    const oldPrice = pPrice(spot, strike, daysLeft);
    const value = units * oldPrice;
    steady.push(value);
    eth.push((BASE_USD * spot) / spot0);

    const boostDays = Math.max(boostMaturity - i, 0);
    boosted.push(boostUnits * nPrice(spot, boostStrike, boostDays));

    const danger = spot < strike * 1.5;
    const tooClose = daysLeft <= 14;
    if (i === n - 1 || (!danger && !tooClose)) continue;

    const factor = danger ? 4 : 2;
    const newStrike = spot / factor;
    const newMaturity = Math.min(n - 1, i + 60);
    const newPrice = pPrice(spot, newStrike, newMaturity - i);
    const cost = costBps / 10000;
    const net = value * (1 - cost);
    const newUnits = net / (newPrice * (1 + cost));

    const boostValue = boosted.at(-1) || BASE_USD;
    const nextN = Math.max(nPrice(spot, newStrike, newMaturity - i), 0.000001);
    boostUnits = Math.max(boostValue, 0.01) / nextN;
    boostStrike = newStrike;
    boostMaturity = newMaturity;

    units = newUnits;
    strike = newStrike;
    maturity = newMaturity;
    rolls += 1;
    dangerRolls += danger ? 1 : 0;
  }

  return { steady, eth, boosted, rolls, dangerRolls };
}

function money(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function formatEth(value) {
  return value >= 10 ? value.toFixed(2) : value.toFixed(4);
}

function ethAmountText(value) {
  if (Math.abs(value) < 0.00005) return "0 ETH";
  return `${formatEth(value)} ETH`;
}

function tinyEthAmountText(value) {
  if (value > 0 && value < 0.0001) return "<0.0001 ETH";
  return ethAmountText(value);
}

function ethValueText(usdValue) {
  return ethAmountText(usdValue / latestSpot());
}

function productValueText(usdValue, productLabel = activeProductLabelText()) {
  return `${formatEth(usdValue / latestSpot())} ${productLabel}`;
}

function usdApproxText(usdValue) {
  return `~ ${money(usdValue)}`;
}

function ethApproxText(usdValue) {
  return `~ ${ethValueText(usdValue)}`;
}

function compactNumber(value) {
  if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(2)}b`;
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)}m`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);
}

function isAddress(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function sameAddress(a, b) {
  return isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
}

function isBytes32(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value);
}

function contractAddress(key) {
  return state.contracts.manifest?.contracts?.[key] || null;
}

function seriesAddress(key) {
  return state.contracts.manifest?.series?.[key] || null;
}

function manifestAuction(key) {
  return state.contracts.manifest?.auctions?.[key] || null;
}

function wrapperConfig(key) {
  const isBoosted = key === "boosted";
  return {
    key: isBoosted ? "boosted" : "steady",
    product: isBoosted ? "Boosted ETH" : "Steady ETH",
    keeperKey: isBoosted ? "boostedKeeper" : "steadyKeeper",
    vaultKey: isBoosted ? "boostedVault" : "steadyVault",
    startPrice: isBoosted ? 1.02 : 1.01,
    floorPrice: isBoosted ? 0.98 : 0.99,
    duration: 24 * 60 * 60,
  };
}

function hasDeployManifest() {
  return Boolean(
    isAddress(contractAddress("steadyMarket")) &&
      isAddress(contractAddress("boostedMarket")) &&
      isAddress(contractAddress("lpVault")) &&
      isAddress(seriesAddress("firstP")) &&
      isAddress(seriesAddress("firstN")),
  );
}

function normalizedChainId(chainId) {
  if (typeof chainId !== "string" || !chainId) return null;
  if (!chainId.startsWith("0x")) return null;
  try {
    return `0x${BigInt(chainId).toString(16)}`;
  } catch {
    return null;
  }
}

function manifestChainId() {
  return normalizedChainId(state.contracts.manifest?.chainId);
}

function walletChainId() {
  return normalizedChainId(state.contracts.chainId);
}

function walletChainMatchesManifest() {
  if (!hasDeployManifest()) return false;
  const expected = manifestChainId();
  const actual = walletChainId();
  return Boolean(expected && actual && expected === actual);
}

function walletChainMismatch() {
  return Boolean(state.contracts.account && hasDeployManifest() && !walletChainMatchesManifest());
}

function chainMismatchText() {
  const expected = manifestChainId();
  const actual = walletChainId();
  if (!expected) return "Manifest is missing a chain id. Export a fresh deployed manifest before live actions.";
  if (!actual) return `Wallet network unknown. Switch to ${chainLabel(expected)}.`;
  return `Wallet is on ${chainLabel(actual)}. Switch to ${chainLabel(expected)} for this deployment.`;
}

function onchainReady() {
  return Boolean(state.contracts.account && hasDeployManifest() && walletChainMatchesManifest());
}

function healthLensReady() {
  return Boolean(onchainReady() && isAddress(contractAddress("healthLens")));
}

function activeMarketAddress() {
  return contractAddress(state.strategy === "boosted" ? "boostedMarket" : "steadyMarket");
}

function activeTokenAddress() {
  return productTokenAddress(state.strategy);
}

function productMarketAddress(key) {
  return contractAddress(key === "boosted" ? "boostedMarket" : "steadyMarket");
}

function fallbackProductTokenAddress(key) {
  const shareKey = key === "boosted" ? "boostedShare" : "steadyShare";
  const rawSeriesKey = key === "boosted" ? "firstN" : "firstP";
  return seriesAddress(shareKey) || seriesAddress(rawSeriesKey);
}

function productTokenAddress(key) {
  return state.onchain.marketTokens[key] || fallbackProductTokenAddress(key);
}

function activeLiveAuction() {
  return manifestAuction(state.activeAuction);
}

function auctionIdForKey(key) {
  const id = manifestAuction(key)?.auctionId;
  if (id !== null && typeof id !== "undefined" && id !== "") {
    try {
      const manifestId = typeof id === "string" && id.startsWith("0x") ? BigInt(id) : BigInt(id);
      if (manifestId >= 0n) return manifestId;
    } catch {
      // Fall through to a live wrapper-created roll auction.
    }
  }
  const discoveredId = state.onchain.auctions[key]?.auctionId;
  if (discoveredId !== null && typeof discoveredId !== "undefined") return discoveredId;
  return state.onchain.wrapperRolls[key]?.auctionId ?? null;
}

function activeAuctionId() {
  return auctionIdForKey(state.activeAuction);
}

function defaultAuctionBuyToken() {
  return seriesAddress(state.activeAuction === "boosted" ? "secondN" : "secondP");
}

function liveAuctionReady() {
  const liveAuction = activeLiveAuction();
  const fillMode =
    liveAuction?.fillMode || (state.activeAuction === "boosted" ? "mintAndFillNWithCallback" : "mintAndFillWithCallback");
  const hasBase = Boolean(
    onchainReady() &&
      activeAuctionId() !== null &&
      isAddress(contractAddress("rollAuction")) &&
      (fillMode === "directFill" || isAddress(contractAddress("factory"))) &&
      (fillMode === "directFill" || isAddress(contractAddress("rollSolver"))),
  );
  if (!hasBase) return false;
  if (fillMode === "directFill") return isAddress(liveAuction?.buyToken || defaultAuctionBuyToken());
  return isBytes32(liveAuction?.newSeriesId || seriesIdForNextAuction());
}

function seriesIdForNextAuction() {
  const pending = state.onchain.wrapperRolls[state.activeAuction]?.pendingSeriesId;
  if (isBytes32(pending) && pending !== ZERO_BYTES32) return pending;
  return state.contracts.manifest?.series?.secondSeriesId || null;
}

function shortAddress(address) {
  if (!address) return "Not connected";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function shortBytes32(value) {
  if (!isBytes32(value) || value === ZERO_BYTES32) return "Not set";
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function chainLabel(chainId) {
  const normalized = normalizedChainId(chainId);
  if (!normalized) return "Local demo";
  const labels = {
    "0x1": "Ethereum mainnet",
    "0x7a69": "Local Anvil",
  };
  return labels[normalized] || `Chain ${Number.parseInt(normalized, 16)}`;
}

function decimalToWei(value) {
  const scaled = BigInt(Math.max(0, Math.round(value * 1e9)));
  return scaled * 1_000_000_000n;
}

function toHex(value) {
  return `0x${value.toString(16)}`;
}

function word(value) {
  const hex = BigInt(value).toString(16);
  return hex.padStart(64, "0");
}

function addressWord(address) {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function bytes32Word(value) {
  return value.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function encodeBuyToken(minTokenOut, recipient) {
  return `${SELECTORS.buyToken}${word(minTokenOut)}${addressWord(recipient)}`;
}

function encodeSellToken(tokenIn, minEthOut, recipient) {
  return `${SELECTORS.sellToken}${word(tokenIn)}${word(minEthOut)}${addressWord(recipient)}`;
}

function encodeApprove(spender, amount) {
  return `${SELECTORS.approve}${addressWord(spender)}${word(amount)}`;
}

function encodeRollAuctionFill(auctionId, sellAmount, maxBuyAmount, recipient) {
  return `${SELECTORS.rollAuctionFill}${word(auctionId)}${word(sellAmount)}${word(maxBuyAmount)}${addressWord(recipient)}`;
}

function encodeRollSolverMintAndFill(selector, factory, auction, newSeriesId, auctionId, sellAmount, maxBuyAmount, recipient) {
  return `${selector}${addressWord(factory)}${addressWord(auction)}${bytes32Word(newSeriesId)}${word(auctionId)}${word(sellAmount)}${word(maxBuyAmount)}${addressWord(recipient)}`;
}

function encodeKeeperStartRoll(nextSeriesId, sellAmount, startPriceWad, endPriceWad, duration) {
  return `${SELECTORS.keeperStartRoll}${bytes32Word(nextSeriesId)}${word(sellAmount)}${word(startPriceWad)}${word(endPriceWad)}${word(duration)}`;
}

function encodeKeeperResetRoll(startPriceWad, endPriceWad, duration) {
  return `${SELECTORS.keeperResetRoll}${word(startPriceWad)}${word(endPriceWad)}${word(duration)}`;
}

function encodeSeries(seriesId) {
  return `${SELECTORS.factorySeries}${bytes32Word(seriesId)}`;
}

function encodeSettle(seriesId) {
  return `${SELECTORS.factorySettle}${bytes32Word(seriesId)}`;
}

function encodeRedeem(selector, seriesId, amount) {
  return `${selector}${bytes32Word(seriesId)}${word(amount)}`;
}

function encodeMerge(seriesId, amount) {
  return `${SELECTORS.factoryMerge}${bytes32Word(seriesId)}${word(amount)}`;
}

function encodeUintCall(selector, value) {
  return `${selector}${word(value)}`;
}

function encodeAddressCall(selector, address) {
  return `${selector}${addressWord(address)}`;
}

function encodeMarketHealth(market, sampleEthIn, sampleTokenIn) {
  return `${SELECTORS.healthMarket}${addressWord(market)}${word(sampleEthIn)}${word(sampleTokenIn)}`;
}

function encodeSeriesHealth(factory, seriesId) {
  return `${SELECTORS.healthSeries}${addressWord(factory)}${bytes32Word(seriesId)}`;
}

function encodeAuctionHealth(auction, auctionId) {
  return `${SELECTORS.healthAuction}${addressWord(auction)}${word(auctionId)}`;
}

function encodeBalanceOf(account) {
  return `${SELECTORS.balanceOf}${addressWord(account)}`;
}

function decodeWord(hex, index = 0) {
  const clean = (hex || "0x").replace(/^0x/, "");
  return clean.slice(index * 64, index * 64 + 64).padStart(64, "0");
}

function hasWords(hex, count) {
  return (hex || "0x").replace(/^0x/, "").length >= count * 64;
}

function decodeUint(hex, index = 0) {
  return BigInt(`0x${decodeWord(hex, index)}`);
}

function decodeAddress(hex, index = 0) {
  return `0x${decodeWord(hex, index).slice(24)}`;
}

function decodeBool(hex, index = 0) {
  return decodeUint(hex, index) !== 0n;
}

function weiToEth(value) {
  const scale = 1_000_000_000_000_000_000n;
  const whole = value / scale;
  const fraction = value % scale;
  return Number(whole) + Number(fraction) / Number(scale);
}

async function callRpc(method, params = []) {
  if (!window.ethereum) throw new Error("Wallet provider not found");
  return window.ethereum.request({ method, params });
}

async function ethCall(to, data) {
  if (!isAddress(to)) throw new Error("Invalid contract address");
  return callRpc("eth_call", [{ to, data }, "latest"]);
}

async function readTokenBalanceWei(token, account) {
  if (!isAddress(token) || !isAddress(account)) return 0n;
  const raw = await ethCall(token, encodeBalanceOf(account));
  return decodeUint(raw);
}

async function readTokenBalance(token, account) {
  return weiToEth(await readTokenBalanceWei(token, account));
}

async function readMarketTokenAddress(key) {
  const market = productMarketAddress(key);
  if (!isAddress(market)) return fallbackProductTokenAddress(key);

  try {
    const raw = await ethCall(market, SELECTORS.ammToken);
    const token = decodeAddress(raw);
    return isAddress(token) ? token : fallbackProductTokenAddress(key);
  } catch (error) {
    console.warn(`Could not read ${key} market token`, error);
    return fallbackProductTokenAddress(key);
  }
}

function tradeQuoteKey() {
  if (!onchainReady()) return null;
  const market = activeMarketAddress();
  if (!isAddress(market)) return null;
  return [
    state.contracts.account,
    market,
    state.tradeSide,
    decimalToWei(Number(els.deposit.value)).toString(),
  ].join(":");
}

async function readActiveTradeQuote() {
  const market = activeMarketAddress();
  const key = tradeQuoteKey();
  if (!key || !isAddress(market)) return null;

  const amount = decimalToWei(Number(els.deposit.value));
  if (amount === 0n) return null;
  const selector = state.tradeSide === "buy" ? SELECTORS.quoteBuyToken : SELECTORS.quoteSellToken;
  const raw = await ethCall(market, encodeUintCall(selector, amount));
  return { key, outputEth: weiToEth(decodeUint(raw)), updatedAt: Date.now() };
}

async function readAccountBalances(account) {
  const [ethRaw, steadyToken, boostedToken] = await Promise.all([
    callRpc("eth_getBalance", [account, "latest"]),
    readMarketTokenAddress("steady"),
    readMarketTokenAddress("boosted"),
  ]);
  const [steady, boosted] = await Promise.all([
    readTokenBalance(steadyToken, account),
    readTokenBalance(boostedToken, account),
  ]);
  return {
    eth: weiToEth(BigInt(ethRaw)),
    steady,
    boosted,
    marketTokens: {
      steady: steadyToken,
      boosted: boostedToken,
    },
  };
}

async function readLpState(account) {
  const lpVault = contractAddress("lpVault");
  if (!isAddress(lpVault)) return null;

  const [shareRaw, managedRaw, activeRaw, strategyRaw, requestRaw] = await Promise.all([
    ethCall(lpVault, SELECTORS.vaultShare),
    ethCall(lpVault, SELECTORS.managedAssets),
    ethCall(lpVault, SELECTORS.activeStrategyEth),
    ethCall(lpVault, SELECTORS.strategyActive),
    ethCall(lpVault, `${SELECTORS.withdrawalRequests}${addressWord(account)}`),
  ]);
  const share = decodeAddress(shareRaw);
  const shareBalanceRaw = await ethCall(share, encodeBalanceOf(account));
  const shareBalance = decodeUint(shareBalanceRaw);
  const assetsRaw =
    shareBalance === 0n ? `0x${word(0)}` : await ethCall(lpVault, encodeUintCall(SELECTORS.convertToAssets, shareBalance));

  return {
    share,
    shareBalanceWei: shareBalance,
    shareBalanceEth: weiToEth(shareBalance),
    depositEth: weiToEth(decodeUint(assetsRaw)),
    managedEth: weiToEth(decodeUint(managedRaw)),
    activeStrategyEth: weiToEth(decodeUint(activeRaw)),
    strategyActive: decodeBool(strategyRaw),
    pendingWithdrawEth: weiToEth(decodeUint(requestRaw, 0)),
    pendingUnlockAt: Number(decodeUint(requestRaw, 1)),
  };
}

function auctionTimeLeftSeconds(startTime, duration) {
  if (!startTime || !duration) return null;
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - startTime);
  return Math.max(0, duration - elapsed);
}

function auctionTimeLeftFromState(startTime, duration) {
  const left = auctionTimeLeftSeconds(startTime, duration);
  if (left === null) return null;
  if (left < 60) return `${left}s`;
  if (left < 3600) return `${Math.ceil(left / 60)}m`;
  return `${(left / 3600).toFixed(1)}h`;
}

function unixDateLabel(timestamp) {
  if (!timestamp) return "Not set";
  return new Date(timestamp * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function maturityStatusText(timestamp) {
  if (!timestamp) return "Not set";
  const seconds = timestamp - Math.floor(Date.now() / 1000);
  if (seconds <= 0) return "Matured";
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.ceil(seconds / 3600)}h`;
  return `${Math.ceil(seconds / 86_400)}d`;
}

async function readAuctionState(key) {
  const rollAuction = contractAddress("rollAuction");
  const auctionId = auctionIdForKey(key);
  if (!isAddress(rollAuction) || auctionId === null) return null;

  return readAuctionById(rollAuction, auctionId);
}

async function readAuctionById(rollAuction, auctionId) {
  const raw = await ethCall(rollAuction, encodeUintCall(SELECTORS.rollAuctionAuction, auctionId));
  const startTime = Number(decodeUint(raw, 8));
  const duration = Number(decodeUint(raw, 9));
  if (startTime === 0 || duration === 0) return null;

  const [priceRaw, resetRaw, stoppedRaw] = await Promise.all([
    ethCall(rollAuction, encodeUintCall(SELECTORS.rollAuctionPrice, auctionId)),
    ethCall(rollAuction, encodeUintCall(SELECTORS.rollAuctionResetStatus, auctionId)),
    ethCall(rollAuction, SELECTORS.rollAuctionStopped),
  ]);
  const remainingEth = weiToEth(decodeUint(raw, 4));
  const cancelled = decodeBool(raw, 10);
  const resetExpired = decodeBool(resetRaw, 0);
  const resetPriceStale = decodeBool(resetRaw, 1);
  const resetsPaused = decodeUint(stoppedRaw) >= 2n;
  return {
    seller: decodeAddress(raw, 0),
    beneficiary: decodeAddress(raw, 1),
    sellToken: decodeAddress(raw, 2),
    buyToken: decodeAddress(raw, 3),
    remainingEth,
    buyRaisedEth: weiToEth(decodeUint(raw, 5)),
    startPrice: weiToEth(decodeUint(raw, 6)),
    floorPrice: weiToEth(decodeUint(raw, 7)),
    price: weiToEth(decodeUint(priceRaw)),
    auctionId,
    timeLeftSeconds: auctionTimeLeftSeconds(startTime, duration),
    timeLeft: auctionTimeLeftFromState(startTime, duration),
    cancelled,
    resetExpired,
    resetPriceStale,
    resetPriceDropBps: Number(decodeUint(resetRaw, 4)),
    resetEligible: remainingEth > 0 && !cancelled && (resetExpired || resetPriceStale) && !resetsPaused,
    resetsPaused,
  };
}

async function readRollAuctionDirectory() {
  const rollAuction = contractAddress("rollAuction");
  if (!isAddress(rollAuction)) return [];

  try {
    const count = Number(decodeUint(await ethCall(rollAuction, SELECTORS.activeAuctionCount)));
    const cappedCount = Math.min(count, 24);
    const globalIds = await Promise.all(
      Array.from({ length: cappedCount }, (_, index) =>
        ethCall(rollAuction, encodeUintCall(SELECTORS.activeAuctionIdAt, BigInt(index))).then((raw) => decodeUint(raw)),
      ),
    );
    const sellerIds = [];
    for (const seller of [contractAddress("steadyVault"), contractAddress("boostedVault")].filter(isAddress)) {
      const sellerCount = Number(
        decodeUint(await ethCall(rollAuction, `${SELECTORS.activeAuctionCountBySeller}${addressWord(seller)}`)),
      );
      const sellerCappedCount = Math.min(sellerCount, 8);
      const ids = await Promise.all(
        Array.from({ length: sellerCappedCount }, (_, index) => {
          const data = `${SELECTORS.activeAuctionIdBySellerAt}${addressWord(seller)}${word(BigInt(index))}`;
          return ethCall(rollAuction, data).then((raw) => decodeUint(raw));
        }),
      );
      sellerIds.push(...ids);
    }
    const uniqueIds = [...new Map([...globalIds, ...sellerIds].map((auctionId) => [auctionId.toString(), auctionId])).values()];
    const auctions = await Promise.all(uniqueIds.map((auctionId) => readAuctionById(rollAuction, auctionId)));
    return auctions.filter((auction) => auction && !auction.cancelled && auction.remainingEth > 0);
  } catch (error) {
    console.warn("Active auction discovery unavailable on this deployment", error);
    return [];
  }
}

function staticAuctionPair(key) {
  const boosted = key === "boosted";
  return {
    sellToken: seriesAddress(boosted ? "firstN" : "firstP"),
    buyToken: seriesAddress(boosted ? "secondN" : "secondP"),
  };
}

function auctionMatchesKey(auction, key) {
  const wrapper = state.onchain.wrapperRolls[key];
  if (
    wrapper?.rollActive &&
    sameAddress(auction.sellToken, wrapper.currentToken) &&
    sameAddress(auction.buyToken, wrapper.nextToken)
  ) {
    return true;
  }

  const pair = staticAuctionPair(key);
  return sameAddress(auction.sellToken, pair.sellToken) && sameAddress(auction.buyToken, pair.buyToken);
}

function applyDiscoveredAuctions(directory) {
  if (!directory.length) return;
  for (const key of Object.keys(AUCTIONS)) {
    const discovered = directory.find((auction) => auctionMatchesKey(auction, key));
    if (discovered) state.onchain.auctions[key] = discovered;
  }
}

async function readWrapperRollState(key) {
  const config = wrapperConfig(key);
  const keeper = contractAddress(config.keeperKey);
  const vault = contractAddress(config.vaultKey);
  if (!isAddress(keeper) || !isAddress(vault)) return null;

  const [currentSeriesRaw, pendingSeriesRaw, rollActiveRaw, currentTokenRaw] = await Promise.all([
    ethCall(keeper, SELECTORS.keeperCurrentSeriesId),
    ethCall(keeper, SELECTORS.keeperPendingSeriesId),
    ethCall(vault, SELECTORS.wrapperRollActive),
    ethCall(vault, SELECTORS.wrapperCurrentToken),
  ]);
  const currentSeriesId = `0x${decodeWord(currentSeriesRaw, 0)}`;
  const pendingSeriesId = `0x${decodeWord(pendingSeriesRaw, 0)}`;
  const rollActive = decodeBool(rollActiveRaw);
  const currentToken = decodeAddress(currentTokenRaw);
  const inventoryEth = await readTokenBalance(currentToken, vault);
  const result = {
    product: config.product,
    currentSeriesId,
    pendingSeriesId,
    rollActive,
    currentToken,
    inventoryEth,
    auctionId: null,
    auction: null,
  };

  if (rollActive) {
    const rollRaw = await ethCall(vault, SELECTORS.wrapperRoll);
    const auctionAddress = decodeAddress(rollRaw, 0);
    const auctionId = decodeUint(rollRaw, 1);
    result.auctionId = auctionId;
    result.nextToken = decodeAddress(rollRaw, 2);
    if (isAddress(auctionAddress)) result.auction = await readAuctionById(auctionAddress, auctionId);
  }

  return result;
}

function settlementSeriesId(key) {
  const wrapperSeries = state.onchain.wrapperRolls[key]?.currentSeriesId;
  if (isBytes32(wrapperSeries) && wrapperSeries !== ZERO_BYTES32) return wrapperSeries;
  return state.contracts.manifest?.series?.firstSeriesId || null;
}

async function readSeriesState(seriesId) {
  const factory = contractAddress("factory");
  if (!isAddress(factory) || !isBytes32(seriesId)) return null;

  const raw = await ethCall(factory, encodeSeries(seriesId));
  return {
    seriesId,
    strike: weiToEth(decodeUint(raw, 0)),
    maturity: Number(decodeUint(raw, 1)),
    twapWindow: Number(decodeUint(raw, 2)),
    capEth: weiToEth(decodeUint(raw, 3)),
    openInterestEth: weiToEth(decodeUint(raw, 4)),
    collateralEth: weiToEth(decodeUint(raw, 5)),
    pToken: decodeAddress(raw, 6),
    nToken: decodeAddress(raw, 7),
    oracle: decodeAddress(raw, 8),
    settled: decodeBool(raw, 9),
    settlementPrice: weiToEth(decodeUint(raw, 10)),
  };
}

function payoffForSettlement(series, key) {
  if (!series?.settled || series.settlementPrice <= 0) return 0;
  const pPayoff = series.settlementPrice <= series.strike ? 1 : series.strike / series.settlementPrice;
  return key === "boosted" ? Math.max(0, 1 - pPayoff) : pPayoff;
}

async function readSettlementState(key) {
  const account = state.contracts.account;
  const seriesId = settlementSeriesId(key);
  const series = await readSeriesState(seriesId);
  if (!series || !isAddress(account)) return null;

  const token = key === "boosted" ? series.nToken : series.pToken;
  const [pBalanceWei, nBalanceWei] = await Promise.all([
    readTokenBalanceWei(series.pToken, account),
    readTokenBalanceWei(series.nToken, account),
  ]);
  const balanceWei = key === "boosted" ? nBalanceWei : pBalanceWei;
  const balanceEth = weiToEth(balanceWei);
  const mergeableWei = pBalanceWei < nBalanceWei ? pBalanceWei : nBalanceWei;
  const payoff = payoffForSettlement(series, key);
  return {
    ...series,
    key,
    product: key === "boosted" ? "Boosted ETH" : "Steady ETH",
    token,
    pBalanceWei,
    nBalanceWei,
    mergeableWei,
    mergeableEth: weiToEth(mergeableWei),
    balanceWei,
    balanceEth,
    payoff,
    redeemableEth: balanceEth * payoff,
    matured: Math.floor(Date.now() / 1000) >= series.maturity,
  };
}

function decodeMarketHealth(raw) {
  return {
    market: decodeAddress(raw, 0),
    token: decodeAddress(raw, 1),
    lpToken: decodeAddress(raw, 2),
    feeBps: Number(decodeUint(raw, 3)),
    ethReserve: weiToEth(decodeUint(raw, 4)),
    tokenReserve: weiToEth(decodeUint(raw, 5)),
    sampleEthIn: weiToEth(decodeUint(raw, 6)),
    sampleBuyTokenOut: weiToEth(decodeUint(raw, 7)),
    sampleTokenIn: weiToEth(decodeUint(raw, 8)),
    sampleSellEthOut: weiToEth(decodeUint(raw, 9)),
    hasLiquidity: decodeBool(raw, 10),
  };
}

function decodeLpVaultHealth(raw) {
  return {
    vault: decodeAddress(raw, 0),
    share: decodeAddress(raw, 1),
    manager: decodeAddress(raw, 2),
    managedEth: weiToEth(decodeUint(raw, 3)),
    reservedEth: weiToEth(decodeUint(raw, 4)),
    activeStrategyEth: weiToEth(decodeUint(raw, 5)),
    maxEthPerRoll: weiToEth(decodeUint(raw, 6)),
    maxActiveStrategyEth: weiToEth(decodeUint(raw, 7)),
    maxRollPrice: weiToEth(decodeUint(raw, 8)),
    minInventorySalePrice: hasWords(raw, 21) ? weiToEth(decodeUint(raw, 9)) : 0,
    minAuctionDuration: Number(decodeUint(raw, hasWords(raw, 21) ? 10 : 9)),
    minBackstopDelay: Number(decodeUint(raw, hasWords(raw, 21) ? 11 : 10)),
    minAuctionTimeLeft: Number(decodeUint(raw, hasWords(raw, 21) ? 12 : 11)),
    maxAuctionPriceDropBps: Number(decodeUint(raw, hasWords(raw, 21) ? 13 : 12)),
    inventorySeriesLength: Number(decodeUint(raw, hasWords(raw, 21) ? 14 : 13)),
    utilizationBps: Number(decodeUint(raw, hasWords(raw, 21) ? 15 : 14)),
    strategyActive: decodeBool(raw, hasWords(raw, 21) ? 16 : 15),
    depositsPaused: decodeBool(raw, hasWords(raw, 21) ? 17 : 16),
    totalShares: weiToEth(decodeUint(raw, hasWords(raw, 21) ? 18 : 17)),
    sharePriceEth: weiToEth(decodeUint(raw, hasWords(raw, 21) ? 19 : 18)),
  };
}

function decodeWrapperHealth(raw) {
  return {
    vault: decodeAddress(raw, 0),
    share: decodeAddress(raw, 1),
    manager: decodeAddress(raw, 2),
    currentToken: decodeAddress(raw, 3),
    rollActive: decodeBool(raw, 4),
    totalAssets: weiToEth(decodeUint(raw, 5)),
    rollAuction: decodeAddress(raw, 6),
    rollAuctionId: decodeUint(raw, 7),
    rollNextToken: decodeAddress(raw, 8),
    maxAssets: weiToEth(decodeUint(raw, 9)),
    remainingCapacity: weiToEth(decodeUint(raw, 10)),
  };
}

function decodeSeriesHealth(raw) {
  return {
    seriesId: `0x${decodeWord(raw, 0)}`,
    factory: decodeAddress(raw, 1),
    strike: weiToEth(decodeUint(raw, 2)),
    maturity: Number(decodeUint(raw, 3)),
    twapWindow: Number(decodeUint(raw, 4)),
    capEth: weiToEth(decodeUint(raw, 5)),
    openInterestEth: weiToEth(decodeUint(raw, 6)),
    collateralEth: weiToEth(decodeUint(raw, 7)),
    pToken: decodeAddress(raw, 8),
    nToken: decodeAddress(raw, 9),
    oracle: decodeAddress(raw, 10),
    settlementPrice: weiToEth(decodeUint(raw, 11)),
    capUsedBps: Number(decodeUint(raw, 12)),
    settled: decodeBool(raw, 13),
    matured: decodeBool(raw, 14),
  };
}

function decodeAuctionHealth(raw) {
  return {
    auction: decodeAddress(raw, 0),
    auctionId: decodeUint(raw, 1),
    seller: decodeAddress(raw, 2),
    beneficiary: decodeAddress(raw, 3),
    sellToken: decodeAddress(raw, 4),
    buyToken: decodeAddress(raw, 5),
    remainingEth: weiToEth(decodeUint(raw, 6)),
    buyRaisedEth: weiToEth(decodeUint(raw, 7)),
    startPrice: weiToEth(decodeUint(raw, 8)),
    endPrice: weiToEth(decodeUint(raw, 9)),
    currentPrice: weiToEth(decodeUint(raw, 10)),
    elapsed: Number(decodeUint(raw, 11)),
    timeLeft: Number(decodeUint(raw, 12)),
    open: decodeBool(raw, 13),
    active: decodeBool(raw, 14),
    priceAtFloor: decodeBool(raw, 15),
    cancelled: decodeBool(raw, 16),
    resetPriceDropBps: Number(decodeUint(raw, 17)),
    resetExpired: decodeBool(raw, 18),
    resetPriceStale: decodeBool(raw, 19),
    resetEligible: decodeBool(raw, 20),
    resetsPaused: decodeBool(raw, 21),
  };
}

async function readOperatorHealthState() {
  if (!healthLensReady()) return null;

  const lens = contractAddress("healthLens");
  const factory = contractAddress("factory");
  const rollAuction = contractAddress("rollAuction");
  const firstSeriesId = state.contracts.manifest?.series?.firstSeriesId;
  const addresses = {
    steadyMarket: contractAddress("steadyMarket"),
    boostedMarket: contractAddress("boostedMarket"),
    lpVault: contractAddress("lpVault"),
    steadyVault: contractAddress("steadyVault"),
    boostedVault: contractAddress("boostedVault"),
  };

  if (
    !Object.values(addresses).every(isAddress) ||
    !isAddress(factory) ||
    !isBytes32(firstSeriesId)
  ) {
    return null;
  }

  const sample = decimalToWei(0.1);
  const auctionId = activeAuctionId();
  const auctionJob =
    isAddress(rollAuction) && auctionId !== null
      ? ethCall(lens, encodeAuctionHealth(rollAuction, auctionId)).then(decodeAuctionHealth)
      : Promise.resolve(null);

  const [steadyMarket, boostedMarket, lpVault, steadyWrapper, boostedWrapper, firstSeries, auction] =
    await Promise.all([
      ethCall(lens, encodeMarketHealth(addresses.steadyMarket, sample, sample)).then(decodeMarketHealth),
      ethCall(lens, encodeMarketHealth(addresses.boostedMarket, sample, sample)).then(decodeMarketHealth),
      ethCall(lens, encodeAddressCall(SELECTORS.healthLpVault, addresses.lpVault)).then(decodeLpVaultHealth),
      ethCall(lens, encodeAddressCall(SELECTORS.healthWrapper, addresses.steadyVault)).then(decodeWrapperHealth),
      ethCall(lens, encodeAddressCall(SELECTORS.healthWrapper, addresses.boostedVault)).then(decodeWrapperHealth),
      ethCall(lens, encodeSeriesHealth(factory, firstSeriesId)).then(decodeSeriesHealth),
      auctionJob,
    ]);

  return {
    source: "live",
    steadyMarket,
    boostedMarket,
    lpVault,
    steadyWrapper,
    boostedWrapper,
    firstSeries,
    auction,
    updatedAt: Date.now(),
  };
}

function scheduleOnchainRefresh({ includeQuote = true, force = false } = {}) {
  if (!onchainReady()) return;
  const quoteKey = tradeQuoteKey();
  const quoteStale = includeQuote && quoteKey && state.onchain.quote?.key !== quoteKey;
  const stale = force || quoteStale || Date.now() - state.onchain.lastRefresh > 15_000;
  if (!stale || state.onchain.refreshing) return;

  state.onchain.pendingIncludeQuote = state.onchain.pendingIncludeQuote || includeQuote;
  window.clearTimeout(state.onchain.refreshTimer);
  state.onchain.refreshTimer = window.setTimeout(() => {
    const pendingIncludeQuote = state.onchain.pendingIncludeQuote;
    state.onchain.pendingIncludeQuote = false;
    refreshOnchainReads({ includeQuote: pendingIncludeQuote }).catch((error) => console.warn("Live read failed", error));
  }, force ? 0 : 150);
}

async function refreshOnchainReads({ includeQuote = true, renderAfter = true } = {}) {
  if (!onchainReady() || state.onchain.refreshing) return;

  state.onchain.refreshing = true;
  try {
    const jobs = [
      readAccountBalances(state.contracts.account),
      readLpState(state.contracts.account),
      readAuctionState("steady"),
      readAuctionState("boosted"),
      readWrapperRollState("steady"),
      readWrapperRollState("boosted"),
      readRollAuctionDirectory(),
      readSettlementState("steady"),
      readSettlementState("boosted"),
      readOperatorHealthState(),
      includeQuote ? readActiveTradeQuote() : Promise.resolve(null),
    ];
    const [
      balances,
      lp,
      steadyAuction,
      boostedAuction,
      steadyWrapper,
      boostedWrapper,
      auctionDirectory,
      steadySettlement,
      boostedSettlement,
      operatorHealth,
      quote,
    ] =
      await Promise.allSettled(jobs);

    if (balances.status === "fulfilled") {
      state.onchain.balances = balances.value;
      state.onchain.marketTokens = balances.value.marketTokens || state.onchain.marketTokens;
    }
    if (lp.status === "fulfilled") state.onchain.lp = lp.value;
    if (steadyAuction.status === "fulfilled") state.onchain.auctions.steady = steadyAuction.value;
    if (boostedAuction.status === "fulfilled") state.onchain.auctions.boosted = boostedAuction.value;
    if (steadyWrapper.status === "fulfilled" && steadyWrapper.value) {
      state.onchain.wrapperRolls.steady = steadyWrapper.value;
      if (steadyWrapper.value.auction) state.onchain.auctions.steady = steadyWrapper.value.auction;
    }
    if (boostedWrapper.status === "fulfilled" && boostedWrapper.value) {
      state.onchain.wrapperRolls.boosted = boostedWrapper.value;
      if (boostedWrapper.value.auction) state.onchain.auctions.boosted = boostedWrapper.value.auction;
    }
    if (auctionDirectory.status === "fulfilled") {
      state.onchain.auctionDirectory = auctionDirectory.value;
      applyDiscoveredAuctions(auctionDirectory.value);
    }
    if (steadySettlement.status === "fulfilled" && steadySettlement.value) {
      state.onchain.settlements.steady = steadySettlement.value;
    }
    if (boostedSettlement.status === "fulfilled" && boostedSettlement.value) {
      state.onchain.settlements.boosted = boostedSettlement.value;
    }
    if (operatorHealth.status === "fulfilled") state.onchain.health = operatorHealth.value;
    if (quote.status === "fulfilled" && quote.value) state.onchain.quote = quote.value;
    state.onchain.lastRefresh = Date.now();
  } finally {
    state.onchain.refreshing = false;
  }

  if (renderAfter) render();
}

function clearOnchainCache() {
  window.clearTimeout(state.onchain.refreshTimer);
  state.onchain.lastRefresh = 0;
  state.onchain.pendingIncludeQuote = false;
  state.onchain.balances = null;
  state.onchain.quote = null;
  state.onchain.lp = null;
  state.onchain.marketTokens = {};
  state.onchain.auctions = {};
  state.onchain.auctionDirectory = [];
  state.onchain.wrapperRolls = {};
  state.onchain.settlements = {};
  state.onchain.health = null;
}

async function loadContractManifest() {
  try {
    const response = await fetch(CONTRACT_MANIFEST_URL);
    if (!response.ok) return;
    state.contracts.manifest = await response.json();
  } catch (error) {
    console.warn("No contract manifest found; staying in demo mode.", error);
  }
}

async function connectWallet() {
  const ethereum = window.ethereum;
  if (!ethereum) {
    els.connectionStatus.textContent = "No injected wallet found";
    return;
  }

  const accounts = await ethereum.request({ method: "eth_requestAccounts" });
  state.contracts.account = accounts[0] || null;
  state.contracts.chainId = await ethereum.request({ method: "eth_chainId" });
  renderConnectionStatus();
  render();
  scheduleOnchainRefresh({ includeQuote: true, force: true });
}

async function sendTransaction(tx) {
  if (!state.contracts.account || !window.ethereum) throw new Error("Wallet not connected");
  if (walletChainMismatch()) throw new Error(chainMismatchText());
  return window.ethereum.request({
    method: "eth_sendTransaction",
    params: [{ from: state.contracts.account, ...tx }],
  });
}

function renderConnectionStatus() {
  state.contracts.walletAvailable = Boolean(window.ethereum);
  const hasManifest = hasDeployManifest();
  const connected = Boolean(state.contracts.account);

  if (!hasManifest) {
    els.connectionMode.textContent = "Simulation mode";
    els.connectionStatus.textContent = "Add deployed addresses to contract-manifest.json";
  } else if (!connected) {
    els.connectionMode.textContent = "Contracts loaded";
    els.connectionStatus.textContent = "Connect wallet to use deployed markets";
  } else if (walletChainMismatch()) {
    els.connectionMode.textContent = "Wrong network";
    els.connectionStatus.textContent = chainMismatchText();
  } else {
    els.connectionMode.textContent = "Wallet connected";
    els.connectionStatus.textContent = shortAddress(state.contracts.account);
  }

  const expected = manifestChainId();
  const actual = walletChainId();
  els.contractNetwork.textContent =
    expected && actual && expected !== actual
      ? `${chainLabel(actual)} / needs ${chainLabel(expected)}`
      : chainLabel(actual || expected);
  els.connectWallet.textContent = connected ? shortAddress(state.contracts.account) : "Connect wallet";
  els.connectWallet.disabled = !state.contracts.walletAvailable;
}

function lpCapitalEth() {
  return Number(els.lpCapital.value);
}

function lpCapitalUsd() {
  return lpCapitalEth() * latestSpot();
}

function compactMoney(value) {
  if (Math.abs(value) >= 1e9) return `$${(value / 1e9).toFixed(2)}b`;
  if (Math.abs(value) >= 1e6) return `$${(value / 1e6).toFixed(2)}m`;
  if (Math.abs(value) >= 1e3) return `$${(value / 1e3).toFixed(1)}k`;
  return money(value);
}

function pct(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function maxDrawdown(values) {
  let peak = values[0] || 1;
  let worst = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    if (peak > 0) worst = Math.max(worst, 1 - value / peak);
  }
  return worst;
}

function rollingReturns(values, horizon) {
  const out = [];
  for (let i = 0; i < values.length - horizon; i += 1) {
    if (values[i] > 0) out.push(values[i + horizon] / values[i] - 1);
  }
  return out;
}

function quantile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * q)));
  return sorted[index];
}

function activeTraderSeries() {
  if (state.strategy === "boosted") return state.simulation.boosted;
  return state.simulation.steady;
}

function scaled(values, deposit) {
  return values.map((value) => (value / BASE_USD) * deposit);
}

function activeProductKey() {
  return state.strategy === "boosted" ? "boosted" : "steady";
}

function activeProductLabelText() {
  return state.strategy === "boosted" ? "Boosted ETH" : "Steady ETH";
}

function activeAuctionConfig() {
  return auctionConfig(state.activeAuction);
}

function auctionConfig(key) {
  const base = AUCTIONS[key] || AUCTIONS.steady;
  const live = manifestAuction(key) || {};
  const onchain = state.onchain.auctions[key] || null;
  const ui = Object.fromEntries(
    Object.entries(live.ui || {}).filter(([, value]) => value !== null && typeof value !== "undefined"),
  );
  const liveUi = onchain
    ? {
        floorPrice: onchain.floorPrice,
        timeLeft: onchain.timeLeft,
      }
    : {};
  return { ...base, ...ui, ...liveUi, live, onchain };
}

function auctionRemainingEth(key) {
  const liveRemaining = state.onchain.auctions[key]?.remainingEth;
  if (Number.isFinite(liveRemaining)) return Math.max(0, liveRemaining);
  const auction = auctionConfig(key);
  if (auction.live?.remainingEth !== null && Number.isFinite(Number(auction.live?.remainingEth))) {
    return Math.max(0, Number(auction.live.remainingEth));
  }
  return Math.max(0, auction.availableEth - (state.auctionFills[key] || 0));
}

function auctionPrice(auction) {
  if (Number.isFinite(auction.onchain?.price)) return auction.onchain.price;
  if (auction.live?.price !== null && Number.isFinite(Number(auction.live?.price))) return Number(auction.live.price);
  return auction.startPrice - (auction.startPrice - auction.floorPrice) * auction.progress;
}

function auctionEdgeBps(price) {
  return (1 - price) * 10000;
}

function signedBpsText(value) {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(0)} bps`;
}

function auctionStateText(key, remaining, price) {
  if (remaining <= 0) return "Filled";
  if (state.onchain.auctions[key]?.active || state.demoWrapperRolls[key]?.active) return price <= 1 ? "Bidable" : "Early";
  return "Open";
}

function auctionTimeLeftText(auction) {
  if (typeof auction.onchain?.timeLeft === "string") return auction.onchain.timeLeft;
  if (typeof auction.live?.timeLeft === "string") return auction.live.timeLeft;
  const left = Math.max(0, auction.durationHours * (1 - auction.progress));
  if (left < 1) return `${Math.round(left * 60)}m`;
  return `${left.toFixed(1)}h`;
}

function activeWrapperRoll() {
  return state.onchain.wrapperRolls[state.activeAuction] || null;
}

function activeSettlementState() {
  return state.onchain.settlements[state.activeAuction] || null;
}

function demoWrapperRoll() {
  return state.demoWrapperRolls[state.activeAuction];
}

function keeperNextSeriesId(key = state.activeAuction) {
  const pending = state.onchain.wrapperRolls[key]?.pendingSeriesId;
  if (isBytes32(pending) && pending !== ZERO_BYTES32) return pending;
  return manifestAuction(key)?.newSeriesId || state.contracts.manifest?.series?.secondSeriesId || null;
}

function keeperPolicyText(config) {
  return {
    start: `${config.startPrice.toFixed(3)}x`,
    floor: `${config.floorPrice.toFixed(3)}x`,
    duration: `${Math.round(config.duration / 3600)}h`,
  };
}

function liveKeeperReady() {
  const config = wrapperConfig(state.activeAuction);
  return Boolean(
    onchainReady() &&
      isAddress(contractAddress(config.keeperKey)) &&
      isAddress(contractAddress(config.vaultKey)) &&
      isBytes32(keeperNextSeriesId()),
  );
}

function tokenAmountText(value, tokenLabel) {
  return `${formatEth(value)} ${tokenLabel}`;
}

function quoteBps() {
  return state.strategy === "boosted" ? 18 : 10;
}

function liquidityMetrics() {
  const capital = lpCapitalUsd();
  const nFill = Number(els.nFill.value) / 100;
  const depth = Number(els.lpDepth.value) * 1_000_000;
  const riskBudget = capital * 0.4;
  const steadyCapacity = Math.max(0, Math.min(capital * 0.35, capital * (0.08 + nFill * 0.28)));
  const capByTwap = attackCapital(depth, 72) / 10;
  const startingCap = Math.min(steadyCapacity, capByTwap);
  const vaultLaunchCapacity = capital / CAPACITY_POLICY.rlpCapitalRatio;
  const quoteCapacity = Math.min(startingCap, vaultLaunchCapacity);
  const unsoldN = quoteCapacity * 2.2 * (1 - nFill);
  const oldPRisk = quoteCapacity * 0.25 * 0.35;
  const requiredRisk = unsoldN + oldPRisk;
  const utilization = requiredRisk / Math.max(riskBudget, 1);
  const rollBps = 3 + 20 * Math.sqrt(Math.max(utilization, 0));

  return {
    capital,
    nFill,
    depth,
    riskBudget,
    steadyCapacity,
    requiredRisk,
    utilization,
    rollBps,
    capByTwap,
    startingCap,
  };
}

function liveCapacityPolicy(extraLpEth = 0) {
  const live = state.onchain.health?.source === "live" ? state.onchain.health : null;
  if (!live) return null;

  const managedEth = Math.max(0, (live.lpVault?.managedEth || 0) + extraLpEth);
  const visibleBoostedDemandEth = Math.max(0, live.boostedMarket?.ethReserve || 0);
  const seriesCapEth = Math.max(0, live.firstSeries?.capEth || 0);
  const lpCapEth = managedEth / CAPACITY_POLICY.rlpCapitalRatio;
  const avgDemandCapEth =
    visibleBoostedDemandEth / (CAPACITY_POLICY.avgNDemandRatio * CAPACITY_POLICY.nExternalFill);
  const stressDemandCapEth =
    visibleBoostedDemandEth / (CAPACITY_POLICY.stressNDemandRatio * CAPACITY_POLICY.nExternalFill);
  const vaultLaunchCapEth = Math.min(lpCapEth, seriesCapEth);
  const scaleCapEth = Math.min(lpCapEth, avgDemandCapEth, seriesCapEth);
  const stressScaleCapEth = Math.min(lpCapEth, stressDemandCapEth, seriesCapEth);
  const launchCapEth = CAPACITY_POLICY.noSolverLaunch ? vaultLaunchCapEth : scaleCapEth;
  const stressCapEth = CAPACITY_POLICY.noSolverLaunch ? vaultLaunchCapEth : stressScaleCapEth;
  const caps = CAPACITY_POLICY.noSolverLaunch
    ? [
        ["LP capital", lpCapEth],
        ["Series cap", seriesCapEth],
      ]
    : [
        ["LP capital", lpCapEth],
        ["Boosted demand", avgDemandCapEth],
        ["Series cap", seriesCapEth],
      ];
  caps.sort((a, b) => a[1] - b[1]);

  return {
    noSolverLaunch: CAPACITY_POLICY.noSolverLaunch,
    managedEth,
    visibleBoostedDemandEth,
    seriesCapEth,
    lpCapEth,
    avgDemandCapEth,
    stressDemandCapEth,
    vaultLaunchCapEth: Math.max(0, vaultLaunchCapEth),
    scaleCapEth: Math.max(0, scaleCapEth),
    stressScaleCapEth: Math.max(0, stressScaleCapEth),
    launchCapEth: Math.max(0, launchCapEth),
    stressCapEth: Math.max(0, stressCapEth),
    limiter: caps[0][0],
  };
}

function lpIsWithdrawMode() {
  return state.lpMode === "withdraw";
}

function currentLpDepositEth() {
  const live = onchainReady() ? state.onchain.lp : null;
  return live ? live.depositEth : state.lpDeposit;
}

function currentLpPendingRequest() {
  const live = onchainReady() ? state.onchain.lp : null;
  if (live) {
    return {
      assets: live.pendingWithdrawEth || 0,
      unlockAt: live.pendingUnlockAt || 0,
    };
  }
  return state.lpPendingWithdraw;
}

function claimReady(request = currentLpPendingRequest()) {
  return request.assets > 0 && (!request.unlockAt || Math.floor(Date.now() / 1000) >= request.unlockAt);
}

function unlockText(unlockAt) {
  if (!unlockAt) return "Ready";
  const seconds = Math.max(0, unlockAt - Math.floor(Date.now() / 1000));
  if (seconds === 0) return "Ready";
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.ceil(seconds / 3600)}h`;
  return `${Math.ceil(seconds / 86_400)}d`;
}

function maxLpAmount() {
  if (lpIsWithdrawMode()) return currentLpDepositEth();
  const live = onchainReady() ? state.onchain.balances : null;
  if (!live) return 10;
  return Math.max(0, Math.floor(Math.max(0, live.eth - 0.01) * 100) / 100);
}

function clampLpAmount() {
  const max = maxLpAmount();
  els.lpCapital.min = max <= 0 ? "0" : "0.01";
  els.lpCapital.max = String(max <= 0 ? 0 : Math.max(0.01, max));
  els.lpCapital.disabled = max <= 0;
  if (Number(els.lpCapital.value) > max) els.lpCapital.value = String(max);
  if (Number(els.lpCapital.value) < Number(els.lpCapital.min)) els.lpCapital.value = els.lpCapital.min;
}

function availableBalance() {
  const live = onchainReady() ? state.onchain.balances : null;
  if (live) {
    if (state.tradeSide === "buy") return live.eth * latestSpot();
    return live[activeProductKey()] * latestSpot();
  }
  if (state.tradeSide === "buy") return state.balances.eth * latestSpot();
  return state.balances[activeProductKey()];
}

function walletBalanceText(availableUsd) {
  const live = onchainReady() ? state.onchain.balances : null;
  if (live) {
    if (state.tradeSide === "buy") return `${formatEth(live.eth)} ETH`;
    return `${formatEth(live[activeProductKey()])} ${activeProductLabelText()}`;
  }
  if (state.tradeSide === "buy") return `${formatEth(state.balances.eth)} ETH`;
  return productValueText(availableUsd);
}

function currentQuote() {
  const sizeEth = Number(els.deposit.value);
  const amount = sizeEth * latestSpot();
  const quoteKey = tradeQuoteKey();
  if (onchainReady() && quoteKey && state.onchain.quote?.key === quoteKey) {
    const receiveEth = state.onchain.quote.outputEth;
    const receive = receiveEth * latestSpot();
    const fee = Math.max(0, amount - receive);
    const bps = amount > 0 ? Math.round((fee / amount) * 10000) : 0;
    return { sizeEth, amount, bps, fee, receive, receiveEth, source: "live" };
  }
  const bps = quoteBps();
  const fee = amount * (bps / 10000);
  const receive = Math.max(0, amount - fee);
  return { sizeEth, amount, bps, fee, receive, receiveEth: receive / latestSpot(), source: "demo" };
}

function rollStatusText(rollBps) {
  if (rollBps <= 20) return "Normal";
  if (rollBps <= 35) return "Stressed";
  return "Emergency";
}

function routeText(productLabel, isBuy) {
  if (isBuy) return `ETH → ${productLabel}`;
  return `${productLabel} → ETH`;
}

function managedSeriesDetails() {
  return {
    strike: latestSpot() / 2,
    maturity: futureDateLabel(60),
    roll: futureDateLabel(46),
  };
}

function clampTradeAmount() {
  const max = maxTradeEth();
  els.deposit.min = max <= 0 ? "0" : "0.01";
  els.deposit.max = String(max <= 0 ? 0 : Math.max(0.01, max));
  els.deposit.disabled = max <= 0;
  if (Number(els.deposit.value) > max) els.deposit.value = String(max);
  if (Number(els.deposit.value) < Number(els.deposit.min)) els.deposit.value = els.deposit.min;
}

function maxTradeEth() {
  return Math.max(0, Math.floor((availableBalance() / latestSpot()) * 100) / 100);
}

function clampRangeValue(input, target) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 0;
  const step = Number(input.step) || 1;
  const bounded = Math.max(min, Math.min(target, max));
  const stepped = Math.round(bounded / step) * step;
  const decimals = (String(step).split(".")[1] || "").length;
  return Number(stepped.toFixed(decimals));
}

function updatePresetButtons() {
  const tradeValue = Number(els.deposit.value);
  const tradeMax = maxTradeEth();
  els.tradePresetButtons.forEach((button) => {
    const isMax = button.dataset.tradePreset === "max";
    const target = isMax ? tradeMax : Number(button.dataset.tradePreset);
    button.disabled = target <= 0 || (!isMax && target > tradeMax);
    const isActive = Math.abs(tradeValue - target) < 0.005;
    const isDuplicateMax = !isMax && Math.abs(target - tradeMax) < 0.005;
    button.classList.toggle("is-active", !button.disabled && isActive && !isDuplicateMax);
  });

  const lpValue = Number(els.lpCapital.value);
  const lpMax = Number(els.lpCapital.max);
  els.lpPresetButtons.forEach((button) => {
    const isMax = button.dataset.lpPreset === "max";
    const target = isMax ? lpMax : Number(button.dataset.lpPreset);
    button.disabled = target <= 0 || (!isMax && target > lpMax);
    const isActive = Math.abs(lpValue - target) < 0.005;
    const isDuplicateMax = !isMax && Math.abs(target - lpMax) < 0.005;
    button.classList.toggle("is-active", !button.disabled && isActive && !isDuplicateMax);
  });
}

function setTradePreset(preset) {
  clampTradeAmount();
  const tradeMax = maxTradeEth();
  const target = preset === "max" ? tradeMax : Number(preset);
  els.deposit.value = String(clampRangeValue(els.deposit, target));
  updateTrader();
}

function setLpPreset(preset) {
  clampLpAmount();
  const target = preset === "max" ? Number(els.lpCapital.max) : Number(preset);
  els.lpCapital.value = String(clampRangeValue(els.lpCapital, target));
  updateLp();
}

function updateTradeTicket() {
  clampTradeAmount();
  const productLabel = activeProductLabelText();
  const quote = currentQuote();
  const isBuy = state.tradeSide === "buy";
  const available = availableBalance();
  const chainBlocked = walletChainMismatch();
  const canTrade = quote.amount > 0 && quote.amount <= available && !chainBlocked;
  const liquidity = liquidityMetrics();

  document.body.dataset.side = state.tradeSide;
  els.depositValue.textContent = `${formatEth(quote.sizeEth)} ETH`;
  els.tradeAmountLabel.textContent = isBuy ? "ETH size" : `${productLabel} size`;
  els.walletLabel.textContent = isBuy ? "Available ETH" : `Available ${productLabel}`;
  els.walletBalance.textContent = walletBalanceText(available);
  els.rollStatus.textContent = rollStatusText(liquidity.rollBps);
  els.tradeCapacity.textContent = ethValueText(liquidity.startingCap);
  els.quotePayLabel.textContent = isBuy ? "You pay" : "You sell";
  els.quotePay.textContent = isBuy ? ethValueText(quote.amount) : productValueText(quote.amount, productLabel);
  els.quotePayAsset.textContent = usdApproxText(quote.amount);
  els.quoteReceiveLabel.textContent = "You receive";
  els.quoteReceive.textContent = isBuy ? productValueText(quote.receive, productLabel) : ethValueText(quote.receive);
  els.quoteReceiveAsset.textContent = usdApproxText(quote.receive);
  els.quoteFee.textContent = `${quote.bps} bps`;
  els.routeText.textContent = routeText(productLabel, isBuy);
  els.quoteNote.textContent = isBuy
    ? "Auto-rolls before maturity. Final settlement uses a 3-stable ETH TWAP median."
    : "This is a market sell. Protocol redemption settles back to ETH.";
  const series = managedSeriesDetails();
  els.seriesSummary.textContent = "Rolling vault share";
  els.seriesStrike.textContent = money(series.strike);
  els.seriesMaturity.textContent = series.maturity;
  els.seriesRoll.textContent = series.roll;
  els.tradeAction.textContent = `${isBuy ? "Buy" : "Sell"} ${productLabel}`;
  els.tradeAction.disabled = !canTrade;
  if (chainBlocked) {
    els.tradeStatus.textContent = chainMismatchText();
  } else if (!canTrade) {
    const neededAsset = isBuy ? "ETH" : productLabel;
    els.tradeStatus.textContent = `Not enough ${neededAsset} for this trade.`;
  } else if (onchainReady() && quote.source !== "live") {
    els.tradeStatus.textContent = "Refreshing live AMM quote...";
  } else if (onchainReady()) {
    els.tradeStatus.textContent = isBuy
      ? "Ready to send an AMM buy transaction."
      : "Ready to approve and sell through the AMM.";
  } else if (hasDeployManifest()) {
    els.tradeStatus.textContent = "Connect wallet to trade against deployed contracts.";
  } else {
    els.tradeStatus.textContent = "Demo only.";
  }
  els.resultTitle.textContent = isBuy ? "Buy preview" : "Sell preview";
  els.resultSub.textContent = isBuy ? "What you pay and receive." : "What you sell and receive.";
  els.futurePreviewLabel.textContent = isBuy ? "Scenario" : "Hidden";
  updatePresetButtons();
  scheduleOnchainRefresh({ includeQuote: true });
}

function latestSpot() {
  return state.candles.at(-1)?.close || 3000;
}

function roundTo(value, step) {
  return Math.round(value / step) * step;
}

function futureDateLabel(days) {
  const dateText = state.candles.at(-1)?.date;
  if (!dateText) return `in ${days} days`;
  const [year, month, day] = dateText.split("-").map(Number);
  const future = new Date(Date.UTC(year, month - 1, day + days));
  return future.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function configureForwardInputs() {
  if (state.forwardConfigured || !state.candles.length) return;
  const spot = latestSpot();
  const min = Math.max(100, roundTo(spot * 0.25, 50));
  const max = Math.max(min + 500, roundTo(spot * 2.5, 50));
  els.futurePrice.min = String(min);
  els.futurePrice.max = String(max);
  els.futurePrice.value = String(roundTo(spot, 50));
  state.forwardConfigured = true;
}

function makeForwardPath(startSpot, endSpot, days) {
  const totalDays = Math.max(1, Math.round(days));
  return Array.from({ length: totalDays + 1 }, (_, i) => ({
    close: startSpot + ((endSpot - startSpot) * i) / totalDays,
  }));
}

function simulateForwardPath(path, costBps) {
  const spot0 = path[0].close;
  let strike = spot0 / 2;
  let maturity = 60;
  let units = BASE_USD / pPrice(spot0, strike, maturity);

  let boostStrike = strike;
  let boostMaturity = maturity;
  let boostUnits = BASE_USD / Math.max(nPrice(spot0, boostStrike, boostMaturity), 0.000001);

  let steady = BASE_USD;
  let boosted = BASE_USD;
  const eth = (BASE_USD * path.at(-1).close) / spot0;

  for (let i = 0; i < path.length; i += 1) {
    const spot = path[i].close;
    const daysLeft = Math.max(maturity - i, 0);
    steady = units * pPrice(spot, strike, daysLeft);

    const boostDays = Math.max(boostMaturity - i, 0);
    boosted = boostUnits * nPrice(spot, boostStrike, boostDays);

    const danger = spot < strike * 1.5;
    const tooClose = daysLeft <= 14;
    if (i === path.length - 1 || (!danger && !tooClose)) continue;

    const factor = danger ? 4 : 2;
    const newStrike = spot / factor;
    const newMaturity = i + 60;
    const newPrice = pPrice(spot, newStrike, newMaturity - i);
    const cost = costBps / 10000;
    const net = steady * (1 - cost);
    units = net / (newPrice * (1 + cost));
    strike = newStrike;
    maturity = newMaturity;

    const nextN = Math.max(nPrice(spot, newStrike, newMaturity - i), 0.000001);
    boostUnits = Math.max(boosted, 0.01) / nextN;
    boostStrike = newStrike;
    boostMaturity = newMaturity;
  }

  return { steady, eth, boosted };
}

function simReturnText(value, deposit) {
  const change = value / deposit - 1;
  const sign = change >= 0 ? "+" : "";
  return `${sign}${(change * 100).toFixed(1)}%`;
}

function setBarWidth(el, value, max) {
  const width = (value / Math.max(max, 1)) * 100;
  el.style.width = `${value <= 0 ? 0 : Math.max(4, Math.min(100, width))}%`;
}

function updateForwardSimulator() {
  configureForwardInputs();
  const quote = currentQuote();
  const deposit = state.tradeSide === "buy" ? quote.receive : quote.amount;
  const holdDeposit = quote.amount;
  const days = Number(els.futureDays.value);
  const endSpot = Number(els.futurePrice.value);
  const path = makeForwardPath(latestSpot(), endSpot, days);
  const projected = simulateForwardPath(path, state.costBps);
  const values = {
    steady: (projected.steady / BASE_USD) * deposit,
    eth: (projected.eth / BASE_USD) * holdDeposit,
    boosted: (projected.boosted / BASE_USD) * deposit,
  };
  const activeValue = state.strategy === "boosted" ? values.boosted : values.steady;
  const activeLabel = state.strategy === "boosted" ? "Boosted ETH" : "Steady ETH";
  const maxValue = Math.max(deposit, activeValue, values.eth);

  document.body.dataset.product = state.strategy;
  els.currentSpot.textContent = `ETH today ${money(latestSpot())}`;
  els.futureDaysValue.textContent = `${days} days`;
  els.futurePriceValue.textContent = money(endSpot);
  els.simQuestion.textContent = money(endSpot);
  els.simQuestionDate.textContent = `on ${futureDateLabel(days)}`;

  els.primaryLabel.textContent = `${activeLabel} balance`;
  els.primaryValue.textContent = money(activeValue);
  els.primarySub.textContent = `Hold ETH: ${money(values.eth)} (${simReturnText(values.eth, holdDeposit)})`;
  els.activeProductLabel.textContent = activeLabel;
  els.simSteady.textContent = money(activeValue);
  els.simEth.textContent = money(values.eth);
  els.simBoosted.textContent = money(values.boosted);
  els.simSteadySub.textContent = simReturnText(activeValue, holdDeposit);
  els.simEthSub.textContent = simReturnText(values.eth, holdDeposit);
  els.simBoostedSub.textContent = simReturnText(values.boosted, holdDeposit);

  setBarWidth(els.simSteadyBar, activeValue, maxValue);
  setBarWidth(els.simEthBar, values.eth, maxValue);
  setBarWidth(els.simBoostedBar, values.boosted, maxValue);

  els.simRows.forEach((row) => {
    row.classList.toggle("is-selected", row.dataset.simRow === "active");
  });
}

function updateTrader() {
  updateTradeTicket();
  const quote = currentQuote();
  const deposit = quote.amount;
  const series = scaled(activeTraderSeries(), deposit);
  const ending = series.at(-1) || 0;
  const ninetyDay = rollingReturns(series, 90);
  const ethNinetyDay = rollingReturns(scaled(state.simulation.eth, deposit), 90);
  const badCase = quantile(ninetyDay, 0.05);
  const typicalCase = quantile(ninetyDay, 0.5);
  const goodCase = quantile(ninetyDay, 0.95);

  els.primaryLabel.textContent =
    state.strategy === "boosted" ? "Estimated upside balance" : "Estimated steady balance";
  els.primaryValue.textContent = money(ending);
  els.primarySub.textContent =
    state.strategy === "boosted" ? "High variance historical path" : "Lower variance historical path";
  els.traderDrawdown.textContent = pct(maxDrawdown(series));
  els.traderBadCase.textContent = pct(badCase);
  els.traderTypicalCase.textContent = pct(typicalCase);
  els.traderGoodCase.textContent = pct(goodCase);
  updateOutcomeCards(
    deposit,
    { bad: badCase, typical: typicalCase, good: goodCase },
    {
      bad: quantile(ethNinetyDay, 0.05),
      typical: quantile(ethNinetyDay, 0.5),
      good: quantile(ethNinetyDay, 0.95),
    },
  );

  if (state.strategy === "boosted") {
    els.appTitle.textContent = "Boosted ETH";
    els.traderChartTitle.textContent = "Boosted 90-day examples";
    els.traderChartSub.textContent = "More upside, wider outcomes.";
    els.explainTitle.textContent = "Boosted ETH is for more upside.";
    els.explainText.textContent =
      "It can grow faster when ETH rallies, but it can fall harder when ETH drops.";
  } else {
    els.appTitle.textContent = "Steady ETH";
    els.traderChartTitle.textContent = "Steady 90-day examples";
    els.traderChartSub.textContent = "Calmer outcomes than holding ETH.";
    els.explainTitle.textContent = "Steady ETH is for calmer balances.";
    els.explainText.textContent = "It tries to reduce downside and gives up part of a big ETH rally.";
  }

  updateForwardSimulator();
}

function updateOutcomeCards(deposit, active, eth) {
  const activeName = state.strategy === "boosted" ? "Boosted" : "Steady";
  els.scenarioBadActive.textContent = money(deposit * (1 + active.bad));
  els.scenarioTypicalActive.textContent = money(deposit * (1 + active.typical));
  els.scenarioGoodActive.textContent = money(deposit * (1 + active.good));
  els.scenarioBadEth.textContent = `Hold ETH: ${money(deposit * (1 + eth.bad))}`;
  els.scenarioTypicalEth.textContent = `Hold ETH: ${money(deposit * (1 + eth.typical))}`;
  els.scenarioGoodEth.textContent = `Hold ETH: ${money(deposit * (1 + eth.good))}`;
  els.primarySub.textContent =
    state.strategy === "boosted"
      ? `${activeName} historical path, high variance`
      : `${activeName} historical path, lower variance`;
}

function quoteReserveFromDepth(depth1Pct) {
  return depth1Pct / (Math.sqrt(1.01) - 1);
}

function attackCapital(depth1Pct, windowHours) {
  const quoteReserve = quoteReserveFromDepth(depth1Pct);
  const factor = 1.01 ** windowHours;
  return quoteReserve * (Math.sqrt(factor) - 1);
}

function updateLp() {
  const liveLp = onchainReady() ? state.onchain.lp : null;
  const liveBalances = onchainReady() ? state.onchain.balances : null;
  const isWithdraw = lpIsWithdrawMode();
  const pending = currentLpPendingRequest();
  const chainBlocked = walletChainMismatch();
  clampLpAmount();
  const capitalEth = lpCapitalEth();
  const capital = lpCapitalUsd();
  const nFill = Number(els.nFill.value) / 100;
  const depth = Number(els.lpDepth.value) * 1_000_000;
  const riskBudget = capital * 0.4;
  const steadyCapacity = Math.max(0, Math.min(capital * 0.35, capital * (0.08 + nFill * 0.28)));
  const capByTwap = attackCapital(depth, 72) / 10;
  const scaleCap = Math.min(steadyCapacity, capByTwap);
  const startingCap = scaleCap;
  const vaultLaunchCapacityEth = capitalEth / CAPACITY_POLICY.rlpCapitalRatio;
  const vaultLaunchCapacity = vaultLaunchCapacityEth * latestSpot();
  const quoteCapacity = Math.min(scaleCap, vaultLaunchCapacity);
  const unsoldN = quoteCapacity * 2.2 * (1 - nFill);
  const oldPRisk = quoteCapacity * 0.25 * 0.35;
  const requiredRisk = unsoldN + oldPRisk;
  const utilization = requiredRisk / Math.max(riskBudget, 1);
  const rollBps = 3 + 20 * Math.sqrt(Math.max(utilization, 0));
  const estimatedRollEarnings = quoteCapacity * (rollBps / 10000);
  const estimatedRollEarningsEth = estimatedRollEarnings / latestSpot();
  const estimatedApr = capital > 0 ? (estimatedRollEarnings * 24) / capital : 0;
  const lpDepositEth = currentLpDepositEth();
  const pendingReady = claimReady(pending);
  const liveCapacity = liveCapacityPolicy(!isWithdraw ? capitalEth : 0);

  els.lpModeButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.lpMode === state.lpMode);
  });
  document.body.dataset.lpMode = state.lpMode;
  els.lpAmountLabel.textContent = isWithdraw ? "Withdraw size" : "Deposit size";
  els.lpCapitalValue.textContent = ethAmountText(capitalEth);
  els.lpBalanceLabel.textContent = isWithdraw ? "Available to withdraw" : liveBalances ? "Available ETH" : "USD equivalent";
  els.lpWalletValue.textContent = isWithdraw
    ? ethAmountText(lpDepositEth)
    : liveBalances
      ? ethAmountText(liveBalances.eth)
      : usdApproxText(capital);
  els.lpAprPreview.textContent = pct(estimatedApr);
  els.lpUserDeposit.textContent = ethAmountText(lpDepositEth);
  els.lpUserEarned.textContent = ethAmountText(state.lpEarned);
  els.lpEarningsPreview.textContent = `${tinyEthAmountText(estimatedRollEarningsEth)} per roll`;
  els.lpEarningsSub.textContent = `Estimate only (${money(estimatedRollEarnings)}). Returns vary with roll demand and inventory risk.`;
  els.lpModalTitle.textContent = isWithdraw ? "Request withdrawal" : "Deposit";
  els.lpModalText.textContent = isWithdraw
    ? "Burn LP shares to request ETH back from the vault. The ETH can be claimed after the unlock delay."
    : "Deposit ETH into the protocol liquidity engine. Withdrawals unlock after 4 days.";
  els.lpModalAmountLabel.textContent = isWithdraw ? "Withdrawal request" : "Amount";
  els.lpModalAmount.textContent = ethAmountText(capitalEth);
  els.lpConfirmDeposit.textContent = isWithdraw ? "Confirm Withdrawal" : "Confirm Deposit";
  els.lpPendingClaim.textContent =
    pending.assets > 0 ? `${ethAmountText(pending.assets)} / ${unlockText(pending.unlockAt)}` : "0 ETH";
  els.nFillValue.textContent = String(Math.round(nFill * 100));
  els.lpDepthValue.textContent = String(depth / 1_000_000);
  els.steadyCapacity.textContent = liveCapacity
    ? ethAmountText(liveCapacity.launchCapEth)
    : ethAmountText(vaultLaunchCapacityEth);
  els.rollQuote.textContent = `${rollBps.toFixed(1)} bps`;
  els.quoteStatus.textContent = rollBps <= 10 ? "Tight" : rollBps <= 20 ? "Usable" : "Wide";
  els.rlpUtilization.textContent = pct(utilization);
  els.lpSeriesCap.textContent = liveCapacity
    ? ethAmountText(liveCapacity.noSolverLaunch ? liveCapacity.scaleCapEth : liveCapacity.stressCapEth)
    : ethValueText(scaleCap);

  const capRatio = liveCapacity
    ? Math.min(1, liveCapacity.launchCapEth / Math.max(liveCapacity.seriesCapEth, 0.0001))
    : Math.min(1, vaultLaunchCapacity / Math.max(scaleCap, 1));
  els.lpCapFill.style.width = `${Math.max(3, capRatio * 100)}%`;
  els.lpCapFill.style.background = capRatio > 0.8 ? "var(--amber)" : "var(--teal)";
  if (liveCapacity) {
    els.lpCapText.textContent = liveCapacity.noSolverLaunch
      ? `${liveCapacity.limiter} sets the launch cap. Solver-backed scale cap: ${ethAmountText(liveCapacity.scaleCapEth)}.`
      : `${liveCapacity.limiter} is the active limit. Visible Boosted demand: ${ethAmountText(
          liveCapacity.visibleBoostedDemandEth,
        )}.`;
  } else {
    els.lpCapText.textContent =
      scaleCap < steadyCapacity
        ? `Vault launch cap. Settlement depth sets scale cap: ${ethValueText(scaleCap)}.`
        : `Vault launch cap. Solver fill can scale this toward ${ethValueText(scaleCap)}.`;
  }
  const canPrimaryAction =
    capitalEth > 0 &&
    !chainBlocked &&
    (!isWithdraw || capitalEth <= lpDepositEth) &&
    (!isWithdraw || !liveLp?.strategyActive) &&
    (isWithdraw || !liveBalances || capitalEth <= Math.max(0, liveBalances.eth - 0.01));
  els.lpAction.disabled = !canPrimaryAction;
  els.lpAction.textContent = isWithdraw ? "Request Withdrawal" : "Deposit ETH";
  els.lpClaimAction.disabled = !pendingReady || chainBlocked || (hasDeployManifest() && !state.contracts.account);

  if (chainBlocked) {
    els.lpStatus.textContent = chainMismatchText();
  } else if (isWithdraw && hasDeployManifest() && !state.contracts.account) {
    els.lpStatus.textContent = "Connect wallet to request a vault withdrawal.";
  } else if (isWithdraw && onchainReady() && liveLp?.strategyActive) {
    els.lpStatus.textContent = `Withdraw requests pause while ${ethAmountText(liveLp.activeStrategyEth)} is in strategy.`;
  } else if (isWithdraw && lpDepositEth <= 0) {
    els.lpStatus.textContent = "No vault balance available to withdraw.";
  } else if (isWithdraw && onchainReady()) {
    els.lpStatus.textContent = "Ready to request a withdrawal. Claim after the unlock delay.";
  } else if (isWithdraw) {
    els.lpStatus.textContent = "Demo withdrawal request available.";
  } else if (onchainReady()) {
    els.lpStatus.textContent = liveLp
      ? `Ready to deposit. Vault managed assets: ${ethAmountText(liveLp.managedEth)}.`
      : "Ready to deposit into deployed ETH LP vault.";
  } else if (hasDeployManifest()) {
    els.lpStatus.textContent = "Connect wallet to deposit into deployed vault.";
  } else {
    els.lpStatus.textContent = "Demo only.";
  }

  updatePresetButtons();
  drawLpChart({ capital, steadyCapacity, startingCap, capByTwap, requiredRisk, riskBudget });
}

function updateAuctionRows() {
  let openAuctions = 0;
  for (const key of Object.keys(AUCTIONS)) {
    const auction = auctionConfig(key);
    const remaining = auctionRemainingEth(key);
    const price = auctionPrice(auction);
    const edge = auctionEdgeBps(price);
    const sizeEl = key === "boosted" ? els.boostedAuctionSize : els.steadyAuctionSize;
    const priceEl = key === "boosted" ? els.boostedAuctionPrice : els.steadyAuctionPrice;
    const edgeEl = key === "boosted" ? els.boostedAuctionEdge : els.steadyAuctionEdge;
    const timeEl = key === "boosted" ? els.boostedAuctionTime : els.steadyAuctionTime;
    const stateEl = key === "boosted" ? els.boostedAuctionState : els.steadyAuctionState;
    if (remaining > 0) openAuctions += 1;
    sizeEl.textContent = ethAmountText(remaining);
    priceEl.textContent = `${price.toFixed(3)}x`;
    edgeEl.textContent = signedBpsText(edge);
    edgeEl.style.color = edge >= 0 ? "var(--teal)" : "var(--amber)";
    timeEl.textContent = auctionTimeLeftText(auction);
    stateEl.textContent = auctionStateText(key, remaining, price);
  }

  els.auctionRows.forEach((row) => {
    row.classList.toggle("is-active", row.dataset.auction === state.activeAuction);
    row.classList.toggle("is-filled", auctionRemainingEth(row.dataset.auction) <= 0);
  });
  els.auctionBoardMode.textContent = onchainReady() ? "Live" : "Public";
  els.auctionEmptyState.hidden = openAuctions > 0;
}

function updateKeeper() {
  const config = wrapperConfig(state.activeAuction);
  const live = activeWrapperRoll();
  const demo = demoWrapperRoll();
  const nextSeriesId = keeperNextSeriesId();
  const policy = keeperPolicyText(config);
  const liveReady = liveKeeperReady();
  const chainBlocked = walletChainMismatch();
  const rollActive = live ? live.rollActive : demo.active;
  const inventoryEth = live ? live.inventoryEth : rollActive ? 0 : auctionRemainingEth(state.activeAuction);
  const auctionId = live?.auctionId ?? demo.auctionId;
  const remaining = live?.auction?.remainingEth ?? (rollActive ? auctionRemainingEth(state.activeAuction) : 0);
  const canStart = !chainBlocked && (liveReady ? !rollActive && inventoryEth > 0 : !rollActive && inventoryEth > 0);
  const canFinalize = !chainBlocked && (liveReady ? Boolean(rollActive && live?.auction && live.auction.remainingEth <= 0) : rollActive);
  const canCancel = liveReady
    ? Boolean(
        !chainBlocked &&
        rollActive &&
          live?.auction &&
          live.auction.buyRaisedEth <= 0 &&
          live.auction.remainingEth > 0 &&
          live.auction.timeLeftSeconds === 0,
      )
    : !chainBlocked && rollActive && !demo.filled;
  const canReset = liveReady
    ? Boolean(
        !chainBlocked &&
        rollActive &&
          live?.auction &&
          live.auction.remainingEth > 0 &&
          live.auction.resetEligible,
      )
    : false;

  els.keeperProduct.textContent = config.product;
  els.keeperSub.textContent = rollActive
    ? "Wrapper deposits are paused until this roll finishes."
    : "Anyone can start the next policy-checked roll.";
  els.keeperMode.textContent = rollActive ? "Rolling" : "Idle";
  els.keeperInventory.textContent = rollActive ? `${ethAmountText(remaining)} left` : ethAmountText(inventoryEth);
  els.keeperNextSeries.textContent = shortBytes32(nextSeriesId);
  els.keeperAuction.textContent = auctionId === null || typeof auctionId === "undefined" ? "None" : `#${auctionId.toString()}`;
  els.keeperStartPrice.textContent = policy.start;
  els.keeperFloorPrice.textContent = policy.floor;
  els.keeperDuration.textContent = policy.duration;
  els.keeperStartRoll.disabled = !canStart;
  els.keeperResetRoll.disabled = !canReset;
  els.keeperFinalizeRoll.disabled = !canFinalize;
  els.keeperCancelRoll.disabled = !canCancel;
  els.keeperStartRoll.textContent = liveReady ? "Start roll" : "Simulate start";
  els.keeperResetRoll.textContent = liveReady ? "Reset" : "Simulate reset";
  els.keeperFinalizeRoll.textContent = liveReady ? "Finalize" : "Simulate finalize";
  els.keeperCancelRoll.textContent = liveReady ? "Cancel" : "Simulate cancel";

  if (chainBlocked) {
    els.keeperStatus.textContent = chainMismatchText();
  } else if (liveReady && canReset) {
    const resetReason = live.auction.resetPriceStale ? "price curve is stale" : "auction expired";
    els.keeperStatus.textContent = `Reset ready: ${resetReason}, ${ethAmountText(live.auction.remainingEth)} left.`;
  } else if (liveReady && rollActive && live?.auction?.remainingEth > 0) {
    els.keeperStatus.textContent = `Active roll needs ${ethAmountText(live.auction.remainingEth)} filled by solvers or the ETH LP vault.`;
  } else if (liveReady && rollActive) {
    els.keeperStatus.textContent = "Roll is filled and ready to finalize.";
  } else if (liveReady && inventoryEth > 0) {
    els.keeperStatus.textContent = "Ready to start a permissionless wrapper roll.";
  } else if (liveReady) {
    els.keeperStatus.textContent = "Wrapper has no current inventory to roll.";
  } else if (hasDeployManifest()) {
    els.keeperStatus.textContent = "Manifest is missing wrapper keeper, wrapper vault, or next series.";
  } else {
    els.keeperStatus.textContent = rollActive ? "Demo roll active." : "Demo only.";
  }
}

function updateSettlement() {
  const config = wrapperConfig(state.activeAuction);
  const live = activeSettlementState();
  const seriesId = live?.seriesId || settlementSeriesId(state.activeAuction);
  const product = live?.product || config.product;
  const isLive = Boolean(live);
  const settled = Boolean(live?.settled);
  const matured = Boolean(live?.matured);
  const chainBlocked = walletChainMismatch();
  const balanceEth = live?.balanceEth || 0;
  const redeemableEth = live?.redeemableEth || 0;
  const mergeableEth = live?.mergeableEth || 0;
  const canMerge = Boolean(onchainReady() && live && !settled && live.mergeableWei > 0n);
  const canSettle = Boolean(onchainReady() && live && matured && !settled);
  const canRedeem = Boolean(onchainReady() && live && settled && live.balanceWei > 0n);

  els.settlementProduct.textContent = product;
  els.settlementSeries.textContent = shortBytes32(seriesId);
  els.settlementMode.textContent = settled ? "Settled" : matured ? "Matured" : "Waiting";
  els.settlementSub.textContent = settled
    ? "Redeem settled tokens back to ETH."
    : matured
      ? "Anyone can settle this series."
      : "Series settlement opens after maturity.";
  els.settlementMaturity.textContent = live
    ? `${maturityStatusText(live.maturity)} · ${unixDateLabel(live.maturity)}`
    : "Not due";
  els.settlementPrice.textContent = settled ? money(live.settlementPrice) : "Pending";
  els.settlementBalance.textContent = tokenAmountText(balanceEth, product);
  els.settlementBalanceSub.textContent = isLive ? "Direct wallet token balance" : "Connect wallet for live balance";
  els.settlementRedeemable.textContent = settled ? ethAmountText(redeemableEth) : "0 ETH";
  els.settlementRedeemableSub.textContent = settled
    ? `${(live.payoff * 100).toFixed(2)}% payoff per token`
    : "After settlement";
  els.settlementMergeable.textContent = ethAmountText(mergeableEth);
  els.settlementMergeableSub.textContent = settled
    ? "Series already settled"
    : mergeableEth > 0
      ? "P + N can exit directly"
      : "Need both P and N";
  els.settlementMerge.disabled = !canMerge;
  els.settlementSettle.disabled = !canSettle;
  els.settlementRedeem.disabled = !canRedeem;
  els.settlementMerge.textContent = "Merge pair";
  els.settlementSettle.textContent = "Settle series";
  els.settlementRedeem.textContent = `Redeem ${product}`;

  if (canRedeem) {
    els.settlementStatus.textContent = `Ready to redeem ${tokenAmountText(balanceEth, product)} for ${ethAmountText(redeemableEth)}.`;
  } else if (canMerge && matured) {
    els.settlementStatus.textContent = `Oracle not needed for matched pairs: merge ${ethAmountText(mergeableEth)} P+N back to ETH.`;
  } else if (canMerge) {
    els.settlementStatus.textContent = `Matched direct pair can merge ${ethAmountText(mergeableEth)} back to ETH before settlement.`;
  } else if (canSettle) {
    els.settlementStatus.textContent = "Ready to submit permissionless settlement.";
  } else if (isLive && settled && balanceEth <= 0) {
    els.settlementStatus.textContent = `Series is settled. No ${product} balance to redeem.`;
  } else if (isLive && matured) {
    els.settlementStatus.textContent = "Series is mature, but settlement price is not available yet.";
  } else if (isLive) {
    els.settlementStatus.textContent = "Series has not reached maturity yet.";
  } else if (chainBlocked) {
    els.settlementStatus.textContent = chainMismatchText();
  } else if (onchainReady()) {
    els.settlementStatus.textContent = "Manifest is missing factory or series data for settlement.";
  } else if (hasDeployManifest()) {
    els.settlementStatus.textContent = "Connect wallet to read settlement and redemption state.";
  } else {
    els.settlementStatus.textContent = "Demo only.";
  }
}

function updateOperatorHealth() {
  const live = state.onchain.health?.source === "live" ? state.onchain.health : null;
  const lensPending = healthLensReady() && !live;

  if (live) {
    const steadyDepth = live.steadyMarket.hasLiquidity ? live.steadyMarket.ethReserve : 0;
    const boostedDepth = live.boostedMarket.hasLiquidity ? live.boostedMarket.ethReserve : 0;
    const totalDepth = steadyDepth + boostedDepth;
    const rollingCount = [live.steadyWrapper, live.boostedWrapper].filter((wrapper) => wrapper.rollActive).length;
    const auctionOpen = Boolean(live.auction?.open && live.auction?.active && !live.auction?.cancelled);
    const capacity = liveCapacityPolicy();
    const wrapperCaps = [live.steadyWrapper, live.boostedWrapper].filter((wrapper) => wrapper.maxAssets > 0);
    const wrapperCapacityLeft = wrapperCaps.length
      ? Math.min(...wrapperCaps.map((wrapper) => wrapper.remainingCapacity))
      : null;

    els.operatorMode.textContent = "Live";
    els.operatorSub.textContent = "Read from ProtocolHealthLens.";
	    els.operatorMarketDepth.textContent = ethAmountText(totalDepth);
	    els.operatorMarketDepthSub.textContent = `Steady ${ethAmountText(steadyDepth)} / Boosted ${ethAmountText(boostedDepth)}`;
	    els.operatorVaultUtil.textContent = pct((live.lpVault.utilizationBps || 0) / 10000);
	    els.operatorVaultUtilSub.textContent = live.lpVault.strategyActive
	      ? `${ethAmountText(live.lpVault.activeStrategyEth)} active / share ${ethAmountText(live.lpVault.sharePriceEth || 1)}`
	      : `${ethAmountText(live.lpVault.managedEth)} managed / share ${ethAmountText(live.lpVault.sharePriceEth || 1)}`;
    els.operatorRollState.textContent = auctionOpen
      ? `${ethAmountText(live.auction.remainingEth)} open`
      : rollingCount
        ? `${rollingCount} rolling`
        : "Idle";
    els.operatorRollStateSub.textContent = auctionOpen
      ? live.auction.resetEligible
        ? `Auction #${live.auction.auctionId.toString()} reset-ready`
        : `Auction #${live.auction.auctionId.toString()} at ${live.auction.currentPrice.toFixed(3)}x`
      : rollingCount
        ? "Wrapper deposits paused while rolling"
        : "No wrapper roll active";
    els.operatorSeriesCap.textContent = capacity ? ethAmountText(capacity.launchCapEth) : `${pct((live.firstSeries.capUsedBps || 0) / 10000)} used`;
    els.operatorSeriesCapSub.textContent = capacity
      ? capacity.noSolverLaunch
        ? `${capacity.limiter} sets launch · scale ${ethAmountText(capacity.scaleCapEth)}`
        : `${capacity.limiter} limits · wrapper ${ethAmountText(wrapperCapacityLeft ?? capacity.stressCapEth)} left`
      : `${ethAmountText(live.firstSeries.openInterestEth)} / ${ethAmountText(live.firstSeries.capEth)} minted`;
    return;
  }

  const metrics = liquidityMetrics();
  const auctionNeed = auctionRemainingEth("steady") + auctionRemainingEth("boosted");
  const rollingCount = Object.values(state.demoWrapperRolls).filter((roll) => roll.active).length;

  els.operatorMode.textContent = lensPending ? "Syncing" : "Demo";
  els.operatorSub.textContent = lensPending
    ? "Reading ProtocolHealthLens..."
    : "Simulation metrics for public roll health.";
  els.operatorMarketDepth.textContent = ethAmountText(auctionNeed);
  els.operatorMarketDepthSub.textContent = "Open roll demand";
  els.operatorVaultUtil.textContent = pct(metrics.utilization);
  els.operatorVaultUtilSub.textContent = `${ethValueText(metrics.requiredRisk)} risk / ${ethValueText(
    metrics.riskBudget,
  )} budget`;
  els.operatorRollState.textContent = rollingCount ? `${rollingCount} rolling` : "Idle";
  els.operatorRollStateSub.textContent = rollingCount ? "Demo wrapper roll active" : "No wrapper roll active";
  els.operatorSeriesCap.textContent = ethValueText(metrics.startingCap);
  els.operatorSeriesCapSub.textContent = "Demo safe starting capacity";
}

function updateSolver() {
  updateAuctionRows();
  updateKeeper();
  updateSettlement();
  updateOperatorHealth();

  const auction = activeAuctionConfig();
  const remaining = auctionRemainingEth(state.activeAuction);
  const maxFill = Math.max(0, Math.floor(remaining * 10) / 10);
  els.solverFill.max = String(Math.max(0.1, maxFill));
  els.solverFill.disabled = remaining <= 0;
  if (Number(els.solverFill.value) > maxFill) els.solverFill.value = String(Math.max(0.1, maxFill));

  const fill = remaining <= 0 ? 0 : Number(els.solverFill.value);
  const price = auctionPrice(auction);
  const pay = fill * price;
  const edge = auctionEdgeBps(price);
  const pairedInventory = pay;
  const directRoute = liveAuctionReady() && auction.live?.fillMode === "directFill";
  const chainBlocked = walletChainMismatch();

  els.solverTitle.textContent = auction.title;
  els.solverSub.textContent = auction.helper;
  els.solverMode.textContent = "Dutch price";
  els.solverFillValue.textContent = ethAmountText(fill);
  els.solverPayLabel.textContent = "You pay";
  els.solverPay.textContent = tokenAmountText(pay, auction.nextToken);
  els.solverPaySub.textContent = `${price.toFixed(3)} ${auction.nextToken} per old token`;
  els.solverReceive.textContent = tokenAmountText(fill, auction.oldToken);
  els.solverReceiveSub.textContent = `Keep about ${tokenAmountText(pairedInventory, auction.pairedInventory)}`;
  els.solverEdge.textContent = signedBpsText(edge);
  els.solverEdgeSub.textContent = edge >= 0 ? "Price is below 1:1" : "May be early for solvers";
  els.solverPrice.textContent = `${price.toFixed(3)}x`;
  els.solverFloor.textContent = `${auction.floorPrice.toFixed(3)}x`;
  els.solverTimeLeft.textContent = auctionTimeLeftText(auction);
  els.solverBackstop.textContent = auction.backstop;
  els.solverRoute.textContent = directRoute ? "Direct auction fill" : "Atomic mint + fill";
  els.solverRouteSub.textContent = directRoute
    ? "Use an existing next-token balance to fill this lot."
    : "Mint the next pair and pay the auction in one transaction.";
  els.solverInventory.textContent = auction.pairedInventory;
  els.solverAction.disabled = chainBlocked || remaining <= 0 || fill <= 0;
  els.solverAction.textContent = liveAuctionReady() ? "Submit bid" : "Simulate bid";

  if (chainBlocked) {
    els.solverStatus.textContent = chainMismatchText();
  } else if (remaining <= 0) {
    els.solverStatus.textContent = "Auction filled in the demo.";
  } else if (liveAuctionReady()) {
    els.solverStatus.textContent =
      auction.live?.fillMode === "directFill"
        ? "Ready to approve and fill the public auction."
        : "Ready to mint the next pair and fill atomically.";
  } else if (state.contracts.account && manifestAuction(state.activeAuction)) {
    els.solverStatus.textContent = "Auction manifest is missing an id, next series, or contract address.";
  } else {
    els.solverStatus.textContent = "Demo only.";
  }
  scheduleOnchainRefresh({ includeQuote: false });
}

function chartSetup(canvas) {
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(640, Math.floor(rect.width * dpr));
  canvas.height = Math.max(320, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.fillStyle = "#fbfcfa";
  ctx.fillRect(0, 0, rect.width, rect.height);
  return { ctx, width: rect.width, height: rect.height };
}

function drawLine(ctx, values, xFor, yFor, color, alpha, lineWidth) {
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  values.forEach((value, i) => {
    const x = xFor(i);
    const y = yFor(value);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawLpChart(values) {
  const { ctx, width, height } = chartSetup(els.lpChart);
  const pad = { left: 40, right: 20, top: 20, bottom: 30 };
  const labels = ["RLP capital", "Risk budget", "Risk used", "Steady cap"];
  const bars = [values.capital, values.riskBudget, values.requiredRisk, values.startingCap];
  const colors = ["#4b58b8", "#0d867f", values.requiredRisk > values.riskBudget ? "#df654d" : "#b77b12", "#0d867f"];
  const max = Math.max(...bars, values.capital * 0.25);
  const gap = 16;
  const barH = (height - pad.top - pad.bottom - gap * (bars.length - 1)) / bars.length;

  ctx.font = "800 13px Inter, system-ui";
  bars.forEach((bar, i) => {
    const y = pad.top + i * (barH + gap);
    const w = ((width - pad.left - pad.right) * bar) / max;
    ctx.fillStyle = "#edf1ed";
    ctx.fillRect(pad.left, y, width - pad.left - pad.right, barH);
    ctx.fillStyle = colors[i];
    ctx.fillRect(pad.left, y, Math.max(3, w), barH);
    ctx.fillStyle = "#17201d";
    ctx.fillText(labels[i], pad.left + 10, y + barH / 2 + 5);
    ctx.textAlign = "right";
    ctx.fillText(compactMoney(bar), width - pad.right - 10, y + barH / 2 + 5);
    ctx.textAlign = "left";
  });
}

async function submitOnchainTrade() {
  const market = activeMarketAddress();
  const account = state.contracts.account;
  const productLabel = activeProductLabelText();
  if (!isAddress(market) || !account) return;

  els.tradeAction.disabled = true;
  try {
    await refreshOnchainReads({ includeQuote: true, renderAfter: false });
    const quote = currentQuote();
    if (quote.source !== "live") {
      els.tradeStatus.textContent = "Could not read a live AMM quote. Check pool liquidity.";
      return;
    }

    if (state.tradeSide === "buy") {
      const minTokenOut = decimalToWei(quote.receiveEth * 0.995);
      const hash = await sendTransaction({
        to: market,
        value: toHex(decimalToWei(quote.sizeEth)),
        data: encodeBuyToken(minTokenOut, account),
      });
      els.tradeStatus.textContent = `Submitted buy transaction: ${shortAddress(hash)}.`;
    } else {
      const token = activeTokenAddress();
      if (!isAddress(token)) {
        els.tradeStatus.textContent = "Could not find the deployed product token for this market.";
        return;
      }
      const tokenIn = decimalToWei(quote.sizeEth);
      const minEthOut = decimalToWei(quote.receiveEth * 0.995);
      const approveHash = await sendTransaction({
        to: token,
        data: encodeApprove(market, tokenIn),
      });
      els.tradeStatus.textContent = `Approval submitted: ${shortAddress(approveHash)}. Confirm sell in wallet next.`;
      const sellHash = await sendTransaction({
        to: market,
        data: encodeSellToken(tokenIn, minEthOut, account),
      });
      els.tradeStatus.textContent = `Submitted sell transaction: ${shortAddress(sellHash)}.`;
    }
    window.setTimeout(() => refreshOnchainReads({ includeQuote: true }).catch(console.warn), 2500);
  } catch (error) {
    els.tradeStatus.textContent = `Wallet action cancelled or failed for ${productLabel}.`;
    console.error(error);
  } finally {
    els.tradeAction.disabled = false;
  }
}

async function submitOnchainLpDeposit() {
  const lpVault = contractAddress("lpVault");
  if (!isAddress(lpVault)) return;

  els.lpConfirmDeposit.disabled = true;
  try {
    const hash = await sendTransaction({
      to: lpVault,
      value: toHex(decimalToWei(lpCapitalEth())),
      data: SELECTORS.deposit,
    });
    els.lpDepositDialog.close();
    els.lpStatus.textContent = `Submitted vault deposit: ${shortAddress(hash)}.`;
    window.setTimeout(() => refreshOnchainReads({ includeQuote: false }).catch(console.warn), 2500);
  } catch (error) {
    els.lpStatus.textContent = "Wallet deposit cancelled or failed.";
    console.error(error);
  } finally {
    els.lpConfirmDeposit.disabled = false;
  }
}

async function submitOnchainLpWithdraw() {
  const lpVault = contractAddress("lpVault");
  if (!isAddress(lpVault)) return;

  els.lpConfirmDeposit.disabled = true;
  try {
    await refreshOnchainReads({ includeQuote: false, renderAfter: false });
    const liveLp = state.onchain.lp;
    if (!liveLp || liveLp.depositEth <= 0) {
      els.lpStatus.textContent = "No vault balance available to withdraw.";
      return;
    }
    if (liveLp.strategyActive) {
      els.lpStatus.textContent = "Withdraw requests pause while the vault is rolling inventory.";
      return;
    }

    const requestedAssets = decimalToWei(lpCapitalEth());
    const maxAssets = decimalToWei(liveLp.depositEth);
    let shares = decodeUint(await ethCall(lpVault, encodeUintCall(SELECTORS.convertToShares, requestedAssets)));
    if (requestedAssets >= maxAssets - 1_000_000_000n) shares = liveLp.shareBalanceWei;
    if (shares === 0n) {
      els.lpStatus.textContent = "Withdrawal amount is too small.";
      return;
    }

    const hash = await sendTransaction({
      to: lpVault,
      data: encodeUintCall(SELECTORS.requestWithdraw, shares),
    });
    els.lpDepositDialog.close();
    els.lpStatus.textContent = `Submitted withdrawal request: ${shortAddress(hash)}.`;
    window.setTimeout(() => refreshOnchainReads({ includeQuote: false }).catch(console.warn), 2500);
  } catch (error) {
    els.lpStatus.textContent = "Wallet withdrawal request cancelled or failed.";
    console.error(error);
  } finally {
    els.lpConfirmDeposit.disabled = false;
  }
}

async function submitOnchainLpClaim() {
  const lpVault = contractAddress("lpVault");
  if (!isAddress(lpVault)) return;

  els.lpClaimAction.disabled = true;
  try {
    await refreshOnchainReads({ includeQuote: false, renderAfter: false });
    if (!claimReady(currentLpPendingRequest())) {
      els.lpStatus.textContent = "Withdrawal is not ready to claim yet.";
      return;
    }
    const hash = await sendTransaction({
      to: lpVault,
      data: SELECTORS.claimWithdraw,
    });
    els.lpStatus.textContent = `Submitted withdrawal claim: ${shortAddress(hash)}.`;
    window.setTimeout(() => refreshOnchainReads({ includeQuote: false }).catch(console.warn), 2500);
  } catch (error) {
    els.lpStatus.textContent = "Wallet claim cancelled or failed.";
    console.error(error);
  } finally {
    els.lpClaimAction.disabled = false;
  }
}

async function submitOnchainKeeperStartRoll() {
  const config = wrapperConfig(state.activeAuction);
  const keeper = contractAddress(config.keeperKey);
  if (!isAddress(keeper)) return;

  els.keeperStartRoll.disabled = true;
  try {
    await refreshOnchainReads({ includeQuote: false, renderAfter: false });
    const live = activeWrapperRoll();
    const nextSeriesId = keeperNextSeriesId();
    if (!live || live.rollActive || !isBytes32(nextSeriesId) || live.inventoryEth <= 0) {
      els.keeperStatus.textContent = "Wrapper is not ready to start a roll.";
      return;
    }

    const hash = await sendTransaction({
      to: keeper,
      data: encodeKeeperStartRoll(
        nextSeriesId,
        decimalToWei(live.inventoryEth),
        decimalToWei(config.startPrice),
        decimalToWei(config.floorPrice),
        BigInt(config.duration),
      ),
    });
    els.keeperStatus.textContent = `Submitted wrapper roll start: ${shortAddress(hash)}.`;
    window.setTimeout(() => refreshOnchainReads({ includeQuote: false }).catch(console.warn), 2500);
  } catch (error) {
    els.keeperStatus.textContent = "Wallet roll start cancelled or failed.";
    console.error(error);
  } finally {
    els.keeperStartRoll.disabled = false;
  }
}

async function submitOnchainKeeperFinalize() {
  const config = wrapperConfig(state.activeAuction);
  const keeper = contractAddress(config.keeperKey);
  if (!isAddress(keeper)) return;

  els.keeperFinalizeRoll.disabled = true;
  try {
    await refreshOnchainReads({ includeQuote: false, renderAfter: false });
    const live = activeWrapperRoll();
    if (!live?.rollActive || !live.auction || live.auction.remainingEth > 0) {
      els.keeperStatus.textContent = "Roll is not fully filled yet.";
      return;
    }

    const hash = await sendTransaction({
      to: keeper,
      data: SELECTORS.keeperFinalizeRoll,
    });
    els.keeperStatus.textContent = `Submitted roll finalization: ${shortAddress(hash)}.`;
    window.setTimeout(() => refreshOnchainReads({ includeQuote: false }).catch(console.warn), 2500);
  } catch (error) {
    els.keeperStatus.textContent = "Wallet finalization cancelled or failed.";
    console.error(error);
  } finally {
    els.keeperFinalizeRoll.disabled = false;
  }
}

async function submitOnchainKeeperReset() {
  const config = wrapperConfig(state.activeAuction);
  const keeper = contractAddress(config.keeperKey);
  if (!isAddress(keeper)) return;

  els.keeperResetRoll.disabled = true;
  try {
    await refreshOnchainReads({ includeQuote: false, renderAfter: false });
    const live = activeWrapperRoll();
    if (!live?.rollActive || !live.auction || live.auction.remainingEth <= 0) {
      els.keeperStatus.textContent = "No expired roll inventory to reset.";
      return;
    }
    if (!live.auction.resetEligible) {
      els.keeperStatus.textContent = "Auction is not reset-ready yet.";
      return;
    }

    const hash = await sendTransaction({
      to: keeper,
      data: encodeKeeperResetRoll(decimalToWei(config.startPrice), decimalToWei(config.floorPrice), BigInt(config.duration)),
    });
    els.keeperStatus.textContent = `Submitted roll reset: ${shortAddress(hash)}.`;
    window.setTimeout(() => refreshOnchainReads({ includeQuote: false }).catch(console.warn), 2500);
  } catch (error) {
    els.keeperStatus.textContent = "Wallet reset cancelled or failed.";
    console.error(error);
  } finally {
    els.keeperResetRoll.disabled = false;
  }
}

async function submitOnchainKeeperCancel() {
  const config = wrapperConfig(state.activeAuction);
  const keeper = contractAddress(config.keeperKey);
  if (!isAddress(keeper)) return;

  els.keeperCancelRoll.disabled = true;
  try {
    await refreshOnchainReads({ includeQuote: false, renderAfter: false });
    const live = activeWrapperRoll();
    if (!live?.rollActive) {
      els.keeperStatus.textContent = "No active roll to cancel.";
      return;
    }
    if (live.auction?.buyRaisedEth > 0) {
      els.keeperStatus.textContent = "Partially filled rolls cannot be cancelled.";
      return;
    }

    const hash = await sendTransaction({
      to: keeper,
      data: SELECTORS.keeperCancelRoll,
    });
    els.keeperStatus.textContent = `Submitted roll cancel: ${shortAddress(hash)}.`;
    window.setTimeout(() => refreshOnchainReads({ includeQuote: false }).catch(console.warn), 2500);
  } catch (error) {
    els.keeperStatus.textContent = "Wallet cancel cancelled or failed. The auction may still be running.";
    console.error(error);
  } finally {
    els.keeperCancelRoll.disabled = false;
  }
}

async function submitOnchainSettlement() {
  const factory = contractAddress("factory");
  const live = activeSettlementState();
  if (!isAddress(factory) || !live) return;

  els.settlementSettle.disabled = true;
  try {
    await refreshOnchainReads({ includeQuote: false, renderAfter: false });
    const refreshed = activeSettlementState();
    if (!refreshed?.matured || refreshed.settled) {
      els.settlementStatus.textContent = refreshed?.settled
        ? "Series is already settled."
        : "Series has not reached maturity yet.";
      return;
    }

    const hash = await sendTransaction({
      to: factory,
      data: encodeSettle(refreshed.seriesId),
    });
    els.settlementStatus.textContent = `Submitted settlement: ${shortAddress(hash)}.`;
    window.setTimeout(() => refreshOnchainReads({ includeQuote: false }).catch(console.warn), 2500);
  } catch (error) {
    els.settlementStatus.textContent = "Wallet settlement cancelled or failed.";
    console.error(error);
  } finally {
    els.settlementSettle.disabled = false;
  }
}

async function submitOnchainMerge() {
  const factory = contractAddress("factory");
  const live = activeSettlementState();
  if (!isAddress(factory) || !live) return;

  els.settlementMerge.disabled = true;
  try {
    await refreshOnchainReads({ includeQuote: false, renderAfter: false });
    const refreshed = activeSettlementState();
    if (!refreshed || refreshed.settled || refreshed.mergeableWei === 0n) {
      els.settlementStatus.textContent = refreshed?.settled
        ? "Series is already settled. Redeem each side instead."
        : "No matched P+N balance available to merge.";
      return;
    }

    const hash = await sendTransaction({
      to: factory,
      data: encodeMerge(refreshed.seriesId, refreshed.mergeableWei),
    });
    els.settlementStatus.textContent = `Submitted pair merge: ${shortAddress(hash)}.`;
    window.setTimeout(() => refreshOnchainReads({ includeQuote: false }).catch(console.warn), 2500);
  } catch (error) {
    els.settlementStatus.textContent = "Wallet merge cancelled or failed.";
    console.error(error);
  } finally {
    els.settlementMerge.disabled = false;
  }
}

async function submitOnchainRedeem() {
  const factory = contractAddress("factory");
  const live = activeSettlementState();
  if (!isAddress(factory) || !live) return;

  els.settlementRedeem.disabled = true;
  try {
    await refreshOnchainReads({ includeQuote: false, renderAfter: false });
    const refreshed = activeSettlementState();
    if (!refreshed?.settled || refreshed.balanceWei === 0n) {
      els.settlementStatus.textContent = refreshed?.settled
        ? "No settled token balance to redeem."
        : "Settle the series before redeeming.";
      return;
    }

    const selector = state.activeAuction === "boosted" ? SELECTORS.factoryRedeemN : SELECTORS.factoryRedeemP;
    const hash = await sendTransaction({
      to: factory,
      data: encodeRedeem(selector, refreshed.seriesId, refreshed.balanceWei),
    });
    els.settlementStatus.textContent = `Submitted redemption: ${shortAddress(hash)}.`;
    window.setTimeout(() => refreshOnchainReads({ includeQuote: false }).catch(console.warn), 2500);
  } catch (error) {
    els.settlementStatus.textContent = "Wallet redemption cancelled or failed.";
    console.error(error);
  } finally {
    els.settlementRedeem.disabled = false;
  }
}

async function submitOnchainSolverBid() {
  if (!liveAuctionReady()) return;

  els.solverAction.disabled = true;
  try {
    await refreshOnchainReads({ includeQuote: false, renderAfter: false });
  } catch (error) {
    console.warn("Could not refresh auction before bid", error);
  }

  const liveAuction = activeLiveAuction();
  const auctionId = activeAuctionId();
  const fillMode =
    liveAuction?.fillMode || (state.activeAuction === "boosted" ? "mintAndFillNWithCallback" : "mintAndFillWithCallback");
  const account = state.contracts.account;
  const auctionAddress = contractAddress("rollAuction");
  const quoteAuction = activeAuctionConfig();
  const fill = Math.min(Number(els.solverFill.value), auctionRemainingEth(state.activeAuction));
  const price = auctionPrice(quoteAuction);
  const pay = fill * price;
  const slippageBps = Number.isFinite(Number(liveAuction?.slippageBps)) ? Number(liveAuction.slippageBps) : 50;
  const sellAmount = decimalToWei(fill);
  const maxBuyAmount = decimalToWei(pay * (1 + slippageBps / 10000));

  try {
    if (fillMode === "directFill") {
      const buyToken = liveAuction?.buyToken || defaultAuctionBuyToken();
      const approveHash = await sendTransaction({
        to: buyToken,
        data: encodeApprove(auctionAddress, maxBuyAmount),
      });
      els.solverStatus.textContent = `Approval submitted: ${shortAddress(approveHash)}. Confirm fill in wallet next.`;
      const fillHash = await sendTransaction({
        to: auctionAddress,
        data: encodeRollAuctionFill(auctionId, sellAmount, maxBuyAmount, account),
      });
      els.solverStatus.textContent = `Submitted auction fill: ${shortAddress(fillHash)}.`;
      window.setTimeout(() => refreshOnchainReads({ includeQuote: false }).catch(console.warn), 2500);
      return;
    }

    const boostedFill = fillMode === "mintAndFillN" || fillMode === "mintAndFillNWithCallback";
    const callbackFill = fillMode === "mintAndFillWithCallback" || fillMode === "mintAndFillNWithCallback";
    let selector = SELECTORS.rollSolverMintAndFillP;
    if (boostedFill && callbackFill) selector = SELECTORS.rollSolverMintAndFillNCallback;
    else if (boostedFill) selector = SELECTORS.rollSolverMintAndFillN;
    else if (callbackFill) selector = SELECTORS.rollSolverMintAndFillPCallback;
    const newSeriesId = liveAuction?.newSeriesId || seriesIdForNextAuction();
    const fillHash = await sendTransaction({
      to: contractAddress("rollSolver"),
      value: toHex(maxBuyAmount),
      data: encodeRollSolverMintAndFill(
        selector,
        contractAddress("factory"),
        auctionAddress,
        newSeriesId,
        auctionId,
        sellAmount,
        maxBuyAmount,
        account,
      ),
    });
    els.solverStatus.textContent = `Submitted atomic solver bid: ${shortAddress(fillHash)}.`;
    window.setTimeout(() => refreshOnchainReads({ includeQuote: false }).catch(console.warn), 2500);
  } catch (error) {
    els.solverStatus.textContent = "Wallet solver action cancelled or failed.";
    console.error(error);
  } finally {
    els.solverAction.disabled = false;
  }
}

function bindEvents() {
  els.connectWallet.addEventListener("click", () => {
    connectWallet().catch((error) => {
      els.connectionStatus.textContent = "Wallet connection cancelled";
      console.error(error);
    });
  });

  window.ethereum?.on?.("accountsChanged", (accounts) => {
    state.contracts.account = accounts[0] || null;
    clearOnchainCache();
    renderConnectionStatus();
    render();
    scheduleOnchainRefresh({ includeQuote: true, force: true });
  });

  window.ethereum?.on?.("chainChanged", (chainId) => {
    state.contracts.chainId = chainId;
    clearOnchainCache();
    renderConnectionStatus();
    render();
    scheduleOnchainRefresh({ includeQuote: true, force: true });
  });

  els.audienceTabs.forEach((button) => {
    button.addEventListener("click", () => {
      els.audienceTabs.forEach((tab) => tab.classList.remove("is-active"));
      button.classList.add("is-active");
      state.page = button.dataset.page;
      Object.entries(els.pages).forEach(([page, el]) => {
        el.classList.toggle("is-active", state.page === page);
      });
      render();
    });
  });

  els.strategyButtons.forEach((button) => {
    button.addEventListener("click", () => {
      els.strategyButtons.forEach((tab) => tab.classList.remove("is-active"));
      button.classList.add("is-active");
      state.strategy = button.dataset.strategy;
      state.page = "trader";
      els.audienceTabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.page === "trader"));
      Object.entries(els.pages).forEach(([page, el]) => {
        el.classList.toggle("is-active", page === "trader");
      });
      updateTrader();
    });
  });

  els.auctionRows.forEach((button) => {
    button.addEventListener("click", () => {
      state.activeAuction = button.dataset.auction;
      updateSolver();
    });
  });

  els.sideButtons.forEach((button) => {
    button.addEventListener("click", () => {
      els.sideButtons.forEach((tab) => tab.classList.remove("is-active"));
      button.classList.add("is-active");
      state.tradeSide = button.dataset.side;
      updateTrader();
    });
  });

  els.tradePresetButtons.forEach((button) => {
    button.addEventListener("click", () => setTradePreset(button.dataset.tradePreset));
  });

  els.lpPresetButtons.forEach((button) => {
    button.addEventListener("click", () => setLpPreset(button.dataset.lpPreset));
  });

  els.lpModeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.lpMode = button.dataset.lpMode;
      updateLp();
    });
  });

  els.tradeAction.addEventListener("click", () => {
    if (walletChainMismatch()) {
      els.tradeStatus.textContent = chainMismatchText();
      return;
    }
    if (onchainReady()) {
      submitOnchainTrade();
      return;
    }

    const quote = currentQuote();
    const productKey = activeProductKey();
    const productLabel = activeProductLabelText();
    if (quote.amount <= 0 || quote.amount > availableBalance()) return;

    if (state.tradeSide === "buy") {
      state.balances.eth -= quote.amount / latestSpot();
      state.balances[productKey] += quote.receive;
    } else {
      state.balances[productKey] -= quote.amount;
      state.balances.eth += quote.receive / latestSpot();
    }

    updateTrader();
    els.tradeStatus.textContent =
      state.tradeSide === "buy"
        ? `Demo filled: bought ${productValueText(quote.receive, productLabel)}.`
        : `Demo filled: sold ${productValueText(quote.amount, productLabel)}.`;
  });

  els.lpAction.addEventListener("click", () => {
    if (walletChainMismatch()) {
      els.lpStatus.textContent = chainMismatchText();
      return;
    }
    updateLp();
    els.lpModalAmount.textContent = ethAmountText(lpCapitalEth());
    if (typeof els.lpDepositDialog.showModal === "function") {
      els.lpDepositDialog.showModal();
    } else {
      els.lpStatus.textContent = `${lpIsWithdrawMode() ? "Demo withdrawal" : "Demo deposit"} ready: ${ethAmountText(lpCapitalEth())}.`;
    }
  });

  els.lpCancelDeposit.addEventListener("click", () => {
    els.lpDepositDialog.close();
  });

  els.lpConfirmDeposit.addEventListener("click", () => {
    if (walletChainMismatch()) {
      els.lpStatus.textContent = chainMismatchText();
      return;
    }
    if (onchainReady()) {
      if (lpIsWithdrawMode()) submitOnchainLpWithdraw();
      else submitOnchainLpDeposit();
      return;
    }

    const amount = lpCapitalEth();
    if (lpIsWithdrawMode()) {
      const requested = Math.min(amount, state.lpDeposit);
      state.lpDeposit -= requested;
      state.lpPendingWithdraw.assets += requested;
      state.lpPendingWithdraw.unlockAt = Math.floor(Date.now() / 1000) + 4 * 86_400;
      els.lpDepositDialog.close();
      updateLp();
      els.lpStatus.textContent = `Demo withdrawal requested: ${ethAmountText(requested)}.`;
      return;
    }

    state.lpDeposit += amount;
    els.lpDepositDialog.close();
    updateLp();
    els.lpStatus.textContent = `Demo deposit confirmed: ${ethAmountText(amount)}.`;
  });

  els.lpClaimAction.addEventListener("click", () => {
    if (walletChainMismatch()) {
      els.lpStatus.textContent = chainMismatchText();
      return;
    }
    if (onchainReady()) {
      submitOnchainLpClaim();
      return;
    }

    if (!claimReady(state.lpPendingWithdraw)) return;
    const amount = state.lpPendingWithdraw.assets;
    state.lpPendingWithdraw = { assets: 0, unlockAt: 0 };
    updateLp();
    els.lpStatus.textContent = `Demo claim complete: ${ethAmountText(amount)}.`;
  });

  els.deposit.addEventListener("input", updateTrader);
  els.solverFill.addEventListener("input", updateSolver);
  els.solverAction.addEventListener("click", () => {
    if (walletChainMismatch()) {
      els.solverStatus.textContent = chainMismatchText();
      return;
    }
    if (liveAuctionReady()) {
      submitOnchainSolverBid();
      return;
    }

    const auction = activeAuctionConfig();
    const fill = Math.min(Number(els.solverFill.value), auctionRemainingEth(state.activeAuction));
    if (fill <= 0) return;
    state.auctionFills[state.activeAuction] += fill;
    if (demoWrapperRoll().active && auctionRemainingEth(state.activeAuction) <= 0) {
      demoWrapperRoll().filled = true;
    }
    updateSolver();
    els.solverStatus.textContent = `Demo bid filled: ${ethAmountText(fill)} of ${auction.product} roll inventory.`;
  });
  els.keeperStartRoll.addEventListener("click", () => {
    if (walletChainMismatch()) {
      els.keeperStatus.textContent = chainMismatchText();
      return;
    }
    if (liveKeeperReady()) {
      submitOnchainKeeperStartRoll();
      return;
    }

    const demo = demoWrapperRoll();
    if (demo.active) return;
    demo.active = true;
    demo.filled = false;
    demo.auctionId = `${state.activeAuction}-demo`;
    state.auctionFills[state.activeAuction] = 0;
    updateSolver();
    els.keeperStatus.textContent = `Demo roll started for ${wrapperConfig(state.activeAuction).product}.`;
  });
  els.keeperFinalizeRoll.addEventListener("click", () => {
    if (walletChainMismatch()) {
      els.keeperStatus.textContent = chainMismatchText();
      return;
    }
    if (liveKeeperReady()) {
      submitOnchainKeeperFinalize();
      return;
    }

    const demo = demoWrapperRoll();
    if (!demo.active) return;
    demo.active = false;
    demo.filled = false;
    demo.auctionId = null;
    updateSolver();
    els.keeperStatus.textContent = "Demo roll finalized.";
  });
  els.keeperResetRoll.addEventListener("click", () => {
    if (walletChainMismatch()) {
      els.keeperStatus.textContent = chainMismatchText();
      return;
    }
    if (liveKeeperReady()) {
      submitOnchainKeeperReset();
      return;
    }

    els.keeperStatus.textContent = "Reset is only needed for expired partially filled live rolls.";
  });
  els.keeperCancelRoll.addEventListener("click", () => {
    if (walletChainMismatch()) {
      els.keeperStatus.textContent = chainMismatchText();
      return;
    }
    if (liveKeeperReady()) {
      submitOnchainKeeperCancel();
      return;
    }

    const demo = demoWrapperRoll();
    if (!demo.active) return;
    demo.active = false;
    demo.filled = false;
    demo.auctionId = null;
    state.auctionFills[state.activeAuction] = 0;
    updateSolver();
    els.keeperStatus.textContent = "Demo roll cancelled.";
  });
  els.settlementSettle.addEventListener("click", () => {
    if (walletChainMismatch()) {
      els.settlementStatus.textContent = chainMismatchText();
      return;
    }
    if (onchainReady()) {
      submitOnchainSettlement();
      return;
    }
    els.settlementStatus.textContent = "Connect wallet to settle a deployed series.";
  });
  els.settlementMerge.addEventListener("click", () => {
    if (walletChainMismatch()) {
      els.settlementStatus.textContent = chainMismatchText();
      return;
    }
    if (onchainReady()) {
      submitOnchainMerge();
      return;
    }
    els.settlementStatus.textContent = "Connect wallet to merge matched P+N from a deployed series.";
  });
  els.settlementRedeem.addEventListener("click", () => {
    if (walletChainMismatch()) {
      els.settlementStatus.textContent = chainMismatchText();
      return;
    }
    if (onchainReady()) {
      submitOnchainRedeem();
      return;
    }
    els.settlementStatus.textContent = "Connect wallet to redeem a deployed series.";
  });
  [els.futureDays, els.futurePrice].forEach((input) => input.addEventListener("input", updateForwardSimulator));
  [els.lpCapital, els.nFill, els.lpDepth].forEach((input) => input.addEventListener("input", updateLp));
  document.querySelector(".lp-mechanics")?.addEventListener("toggle", updateLp);
  window.addEventListener("resize", render);
}

function render() {
  if (!state.simulation) state.simulation = simulate(state.costBps);
  renderConnectionStatus();
  updateTrader();
  updateLp();
  updateSolver();
  if (state.page === "lp") {
    els.appTitle.textContent = "Liquidity Vault";
    document.body.dataset.product = "lp";
  } else if (state.page === "solver") {
    els.appTitle.textContent = "Roll Auctions";
    document.body.dataset.product = "solver";
  }
}

async function init() {
  bindEvents();
  await loadContractManifest();
  state.contracts.walletAvailable = Boolean(window.ethereum);
  const response = await fetch(DATA_URL);
  state.candles = parseCsv(await response.text());
  render();
}

init().catch((error) => {
  console.error(error);
});
