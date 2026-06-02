// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EthOptionsFactory} from "../src/EthOptionsFactory.sol";
import {IERC20Like, RollAuction} from "../src/RollAuction.sol";
import {RollSolver} from "../src/RollSolver.sol";
import {ProtocolHealthLens} from "../src/lens/ProtocolHealthLens.sol";
import {EthTokenAMM} from "../src/market/EthTokenAMM.sol";
import {EthereumMainnetOracleConfig} from "../src/oracle/EthereumMainnetOracleConfig.sol";
import {MedianStableTwapSettlementOracle} from "../src/oracle/MedianStableTwapSettlementOracle.sol";
import {MintBurnToken} from "../src/token/MintBurnToken.sol";
import {EthLPVault} from "../src/vault/EthLPVault.sol";
import {EthLPVaultKeeper} from "../src/vault/EthLPVaultKeeper.sol";
import {SeriesExposureVault} from "../src/vault/SeriesExposureVault.sol";
import {SeriesExposureVaultKeeper} from "../src/vault/SeriesExposureVaultKeeper.sol";

interface PilotManifestVm {
    function startBroadcast() external;
    function stopBroadcast() external;
    function toString(address value) external returns (string memory);
    function writeFile(string memory path, string memory data) external;
    function envOr(string memory key, uint256 defaultValue) external returns (uint256 value);
}

/// @notice Broadcast-friendly Ethereum pilot deployment script.
/// @dev Deploys individual production components, then writes a small topology
/// registry address that can be exported with `ops/export-manifest.mjs`.
contract DeployEthereumPilotManifest {
    PilotManifestVm internal constant vm = PilotManifestVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant WAD = 1e18;
    uint256 internal constant MIN_NORMAL_ROLL_PRICE_WAD = 0.999e18;
    uint16 internal constant MAX_NORMAL_ROLL_COST_BPS = 10;

    struct Config {
        uint256 strike;
        uint64 firstMaturity;
        uint64 secondMaturity;
        uint256 capEth;
        uint64 withdrawDelay;
        uint256 maxEthPerRoll;
        uint256 maxActiveStrategyEth;
        uint256 maxRollPriceWad;
        uint256 minInventorySalePriceWad;
        uint256 steadyFloorPriceWad;
        uint256 boostedFloorPriceWad;
        uint64 minAuctionDuration;
        uint64 minLpBackstopDelay;
        uint64 minLpAuctionTimeLeft;
        uint16 maxLpAuctionPriceDropBps;
        uint64 maxAuctionDuration;
        uint256 minWrapperRollAmount;
        uint256 maxWrapperRollAmount;
        uint256 maxActiveRollAuctions;
        uint256 maxActiveRollAuctionsPerSeller;
        uint256 minRewardedOperationAmount;
        uint256 keeperRewardEth;
        uint256 ammFeeBps;
    }

    error WrongChain();
    error InvalidConfig();
    error CapAbovePilotLimit();

    event PilotManifestCoreDeployed(
        address indexed factory,
        address indexed oracle,
        address indexed rollAuction,
        address rollSolver,
        address lpKeeper,
        address lpVault
    );
    event PilotManifestTopologyDeployed(address indexed topology);

    EthOptionsFactory internal factory;
    MedianStableTwapSettlementOracle internal oracle;
    ProtocolHealthLens internal healthLens;
    RollAuction internal rollAuction;
    RollSolver internal rollSolver;
    EthLPVaultKeeper internal lpKeeper;
    EthLPVault internal lpVault;
    SeriesExposureVaultKeeper internal steadyKeeper;
    SeriesExposureVaultKeeper internal boostedKeeper;
    SeriesExposureVault internal steadyVault;
    SeriesExposureVault internal boostedVault;
    EthTokenAMM internal steadyMarket;
    EthTokenAMM internal boostedMarket;
    EthTokenAMM internal firstPMarket;
    EthTokenAMM internal firstNMarket;
    EthTokenAMM internal secondPMarket;
    EthTokenAMM internal secondNMarket;
    bytes32 internal firstSeriesId;
    bytes32 internal secondSeriesId;
    MintBurnToken internal firstP;
    MintBurnToken internal firstN;
    MintBurnToken internal secondP;
    MintBurnToken internal secondN;
    EthereumPilotTopology internal topology;

    function run() external {
        runTo("manifests/ethereum-pilot-registry.txt");
    }

    function runTo(string memory outputPath) public {
        if (block.chainid != 1) revert WrongChain();

        Config memory config = _envConfig();
        EthereumMainnetOracleConfig.MedianOracleConfig memory oracleConfig =
            EthereumMainnetOracleConfig.mainnetEthStableMedian005();
        _validateConfig(config, oracleConfig);

        vm.startBroadcast();

        _deployCore(config);
        _deploySeries(config, oracleConfig.defaultTwapWindow);
        _deployProducts(config);
        _deployTopology();

        vm.stopBroadcast();
        vm.writeFile(outputPath, vm.toString(address(topology)));

        emit PilotManifestCoreDeployed(
            address(factory),
            address(oracle),
            address(rollAuction),
            address(rollSolver),
            address(lpKeeper),
            address(lpVault)
        );
        emit PilotManifestTopologyDeployed(address(topology));
    }

    function _deployCore(Config memory config) internal {
        factory = new EthOptionsFactory();
        oracle = EthereumMainnetOracleConfig.deployMainnetEthStableMedian005(address(factory));
        healthLens = new ProtocolHealthLens();
        rollAuction = new RollAuction(
            address(0), config.minWrapperRollAmount, config.maxActiveRollAuctions, config.maxActiveRollAuctionsPerSeller
        );
        rollSolver = new RollSolver();
        lpKeeper = new EthLPVaultKeeper(config.minRewardedOperationAmount, config.keeperRewardEth);
        lpVault = new EthLPVault(
            address(lpKeeper),
            config.withdrawDelay,
            config.maxEthPerRoll,
            config.maxActiveStrategyEth,
            config.maxRollPriceWad,
            config.minInventorySalePriceWad,
            config.minAuctionDuration,
            config.minLpBackstopDelay,
            config.minLpAuctionTimeLeft,
            config.maxLpAuctionPriceDropBps,
            uint16(config.ammFeeBps)
        );
        lpKeeper.setVault(lpVault);
    }

    function _deploySeries(Config memory config, uint32 twapWindow) internal {
        firstSeriesId = factory.createSeries(config.strike, config.firstMaturity, twapWindow, config.capEth, oracle);
        secondSeriesId = factory.createSeries(config.strike, config.secondMaturity, twapWindow, config.capEth, oracle);
        (firstP, firstN) = _tokens(factory, firstSeriesId);
        (secondP, secondN) = _tokens(factory, secondSeriesId);
    }

    function _deployProducts(Config memory config) internal {
        steadyKeeper = new SeriesExposureVaultKeeper(
            factory,
            rollAuction,
            false,
            config.maxRollPriceWad,
            config.steadyFloorPriceWad,
            config.minAuctionDuration,
            config.maxAuctionDuration,
            config.minWrapperRollAmount,
            config.maxWrapperRollAmount,
            config.keeperRewardEth
        );
        boostedKeeper = new SeriesExposureVaultKeeper(
            factory,
            rollAuction,
            true,
            config.maxRollPriceWad,
            config.boostedFloorPriceWad,
            config.minAuctionDuration,
            config.maxAuctionDuration,
            config.minWrapperRollAmount,
            config.maxWrapperRollAmount,
            config.keeperRewardEth
        );
        steadyVault = new SeriesExposureVault(
            firstP, address(steadyKeeper), "Steady ETH", "steadyETH", config.maxWrapperRollAmount
        );
        boostedVault = new SeriesExposureVault(
            firstN, address(boostedKeeper), "Boosted ETH", "boostedETH", config.maxWrapperRollAmount
        );
        steadyKeeper.setVault(steadyVault, firstSeriesId);
        boostedKeeper.setVault(boostedVault, firstSeriesId);
        lpKeeper.setRollSellers(address(steadyVault), address(boostedVault));

        steadyMarket = new EthTokenAMM(
            IERC20Like(address(steadyVault.share())), "Steady ETH Market LP", "stETHM-LP", config.ammFeeBps
        );
        boostedMarket = new EthTokenAMM(
            IERC20Like(address(boostedVault.share())), "Boosted ETH Market LP", "bstETHM-LP", config.ammFeeBps
        );
        firstPMarket =
            new EthTokenAMM(IERC20Like(address(firstP)), "First P Inventory LP", "firstP-LP", config.ammFeeBps);
        firstNMarket =
            new EthTokenAMM(IERC20Like(address(firstN)), "First N Inventory LP", "firstN-LP", config.ammFeeBps);
        secondPMarket =
            new EthTokenAMM(IERC20Like(address(secondP)), "Second P Inventory LP", "secondP-LP", config.ammFeeBps);
        secondNMarket =
            new EthTokenAMM(IERC20Like(address(secondN)), "Second N Inventory LP", "secondN-LP", config.ammFeeBps);
    }

    function _deployTopology() internal {
        topology = new EthereumPilotTopology(
            EthereumPilotTopology.CoreConfig({
                factory: address(factory),
                oracle: address(oracle),
                rollAuction: address(rollAuction),
                rollSolver: address(rollSolver),
                lpKeeper: address(lpKeeper),
                lpVault: address(lpVault)
            }),
            EthereumPilotTopology.SeriesConfig({
                firstSeriesId: firstSeriesId,
                secondSeriesId: secondSeriesId,
                firstP: address(firstP),
                firstN: address(firstN),
                secondP: address(secondP),
                secondN: address(secondN)
            }),
            EthereumPilotTopology.ProductConfig({
                steadyVault: address(steadyVault),
                boostedVault: address(boostedVault),
                steadyMarket: address(steadyMarket),
                boostedMarket: address(boostedMarket)
            }),
            EthereumPilotTopology.InventoryMarketConfig({
                firstPMarket: address(firstPMarket),
                firstNMarket: address(firstNMarket),
                secondPMarket: address(secondPMarket),
                secondNMarket: address(secondNMarket)
            }),
            EthereumPilotTopology.WrapperKeeperConfig({
                steadyKeeper: address(steadyKeeper), boostedKeeper: address(boostedKeeper)
            }),
            address(healthLens)
        );
    }

    function _envConfig() internal returns (Config memory config) {
        uint256 firstMaturity = vm.envOr("PILOT_FIRST_MATURITY", block.timestamp + 30 days);
        uint256 secondMaturity = vm.envOr("PILOT_SECOND_MATURITY", block.timestamp + 60 days);
        config = Config({
            strike: vm.envOr("PILOT_STRIKE_WAD", 1_000e18),
            firstMaturity: _toUint64(firstMaturity),
            secondMaturity: _toUint64(secondMaturity),
            capEth: vm.envOr("PILOT_CAP_ETH_WEI", 25 ether),
            withdrawDelay: _toUint64(vm.envOr("PILOT_WITHDRAW_DELAY", 4 days)),
            maxEthPerRoll: vm.envOr("PILOT_MAX_ETH_PER_ROLL_WEI", 1 ether),
            maxActiveStrategyEth: vm.envOr("PILOT_MAX_ACTIVE_STRATEGY_ETH_WEI", 3 ether),
            maxRollPriceWad: vm.envOr("PILOT_MAX_ROLL_PRICE_WAD", WAD),
            minInventorySalePriceWad: vm.envOr("PILOT_MIN_INVENTORY_SALE_PRICE_WAD", MIN_NORMAL_ROLL_PRICE_WAD),
            steadyFloorPriceWad: vm.envOr("PILOT_STEADY_FLOOR_PRICE_WAD", MIN_NORMAL_ROLL_PRICE_WAD),
            boostedFloorPriceWad: vm.envOr("PILOT_BOOSTED_FLOOR_PRICE_WAD", MIN_NORMAL_ROLL_PRICE_WAD),
            minAuctionDuration: _toUint64(vm.envOr("PILOT_MIN_AUCTION_DURATION", 12 hours)),
            minLpBackstopDelay: _toUint64(vm.envOr("PILOT_MIN_LP_BACKSTOP_DELAY", 4 hours)),
            minLpAuctionTimeLeft: _toUint64(vm.envOr("PILOT_MIN_LP_AUCTION_TIME_LEFT", 6 hours)),
            maxLpAuctionPriceDropBps: _toUint16(
                vm.envOr("PILOT_MAX_LP_AUCTION_PRICE_DROP_BPS", MAX_NORMAL_ROLL_COST_BPS)
            ),
            maxAuctionDuration: _toUint64(vm.envOr("PILOT_MAX_AUCTION_DURATION", 3 days)),
            minWrapperRollAmount: vm.envOr("PILOT_MIN_WRAPPER_ROLL_AMOUNT_WEI", 0.01 ether),
            maxWrapperRollAmount: vm.envOr("PILOT_MAX_WRAPPER_ROLL_AMOUNT_WEI", 5 ether),
            maxActiveRollAuctions: vm.envOr("PILOT_MAX_ACTIVE_ROLL_AUCTIONS", 16),
            maxActiveRollAuctionsPerSeller: vm.envOr("PILOT_MAX_ACTIVE_ROLL_AUCTIONS_PER_SELLER", 4),
            minRewardedOperationAmount: vm.envOr("PILOT_MIN_REWARDED_OPERATION_AMOUNT_WEI", 0.01 ether),
            keeperRewardEth: vm.envOr("PILOT_KEEPER_REWARD_ETH_WEI", 0),
            ammFeeBps: vm.envOr("PILOT_AMM_FEE_BPS", 30)
        });
    }

    function _validateConfig(Config memory config, EthereumMainnetOracleConfig.MedianOracleConfig memory oracleConfig)
        internal
        pure
    {
        if (
            config.strike == 0 || config.firstMaturity == 0 || config.secondMaturity <= config.firstMaturity
                || config.capEth == 0 || config.withdrawDelay == 0 || config.maxEthPerRoll == 0
                || config.maxActiveStrategyEth < config.maxEthPerRoll || config.maxRollPriceWad == 0
                || config.maxRollPriceWad > WAD || config.steadyFloorPriceWad == 0
                || config.minInventorySalePriceWad < MIN_NORMAL_ROLL_PRICE_WAD
                || config.minInventorySalePriceWad > config.maxRollPriceWad || config.boostedFloorPriceWad == 0
                || config.steadyFloorPriceWad < MIN_NORMAL_ROLL_PRICE_WAD
                || config.boostedFloorPriceWad < MIN_NORMAL_ROLL_PRICE_WAD
                || config.steadyFloorPriceWad > config.maxRollPriceWad
                || config.boostedFloorPriceWad > config.maxRollPriceWad || config.minAuctionDuration == 0
                || config.minLpBackstopDelay + config.minLpAuctionTimeLeft > config.minAuctionDuration
                || config.maxLpAuctionPriceDropBps > MAX_NORMAL_ROLL_COST_BPS
                || config.maxAuctionDuration < config.minAuctionDuration || config.minWrapperRollAmount == 0
                || config.minRewardedOperationAmount == 0 || config.maxWrapperRollAmount < config.minWrapperRollAmount
                || config.maxWrapperRollAmount > config.capEth || config.maxActiveRollAuctions == 0
                || config.maxActiveRollAuctionsPerSeller == 0
        ) {
            revert InvalidConfig();
        }
        if (config.capEth > oracleConfig.initialSeriesCapEth) revert CapAbovePilotLimit();
    }

    function _tokens(EthOptionsFactory optionsFactory, bytes32 seriesId)
        internal
        view
        returns (MintBurnToken pToken, MintBurnToken nToken)
    {
        (,,,,,, pToken, nToken,,,) = optionsFactory.series(seriesId);
    }

    function _toUint64(uint256 value) internal pure returns (uint64) {
        if (value > type(uint64).max) revert InvalidConfig();
        return uint64(value);
    }

    function _toUint16(uint256 value) internal pure returns (uint16) {
        if (value > type(uint16).max) revert InvalidConfig();
        return uint16(value);
    }
}

/// @notice Small manifest registry for directly deployed Ethereum pilot components.
contract EthereumPilotTopology {
    struct CoreConfig {
        address factory;
        address oracle;
        address rollAuction;
        address rollSolver;
        address lpKeeper;
        address lpVault;
    }

    struct SeriesConfig {
        bytes32 firstSeriesId;
        bytes32 secondSeriesId;
        address firstP;
        address firstN;
        address secondP;
        address secondN;
    }

    struct ProductConfig {
        address steadyVault;
        address boostedVault;
        address steadyMarket;
        address boostedMarket;
    }

    struct InventoryMarketConfig {
        address firstPMarket;
        address firstNMarket;
        address secondPMarket;
        address secondNMarket;
    }

    struct WrapperKeeperConfig {
        address steadyKeeper;
        address boostedKeeper;
    }

    CoreConfig private storedCore;
    SeriesConfig private storedSeries;
    ProductConfig private storedProducts;
    InventoryMarketConfig private storedInventoryMarkets;
    WrapperKeeperConfig private storedWrapperKeepers;
    address private storedHealthLens;

    constructor(
        CoreConfig memory core_,
        SeriesConfig memory series_,
        ProductConfig memory products_,
        InventoryMarketConfig memory inventory_,
        WrapperKeeperConfig memory keepers_,
        address healthLens_
    ) {
        storedCore = core_;
        storedSeries = series_;
        storedProducts = products_;
        storedInventoryMarkets = inventory_;
        storedWrapperKeepers = keepers_;
        storedHealthLens = healthLens_;
    }

    function core()
        external
        view
        returns (
            address factory,
            address oracle,
            address rollAuction,
            address rollSolver,
            address lpKeeper,
            address lpVault
        )
    {
        return (
            storedCore.factory,
            storedCore.oracle,
            storedCore.rollAuction,
            storedCore.rollSolver,
            storedCore.lpKeeper,
            storedCore.lpVault
        );
    }

    function products()
        external
        view
        returns (address steadyVault, address boostedVault, address steadyMarket, address boostedMarket)
    {
        return (
            storedProducts.steadyVault,
            storedProducts.boostedVault,
            storedProducts.steadyMarket,
            storedProducts.boostedMarket
        );
    }

    function wrapperKeepers() external view returns (address steadyKeeper, address boostedKeeper) {
        return (storedWrapperKeepers.steadyKeeper, storedWrapperKeepers.boostedKeeper);
    }

    function inventoryMarkets()
        external
        view
        returns (address firstPMarket, address firstNMarket, address secondPMarket, address secondNMarket)
    {
        return (
            storedInventoryMarkets.firstPMarket,
            storedInventoryMarkets.firstNMarket,
            storedInventoryMarkets.secondPMarket,
            storedInventoryMarkets.secondNMarket
        );
    }

    function healthLens() external view returns (address) {
        return storedHealthLens;
    }

    function series()
        external
        view
        returns (
            bytes32 firstSeriesId,
            bytes32 secondSeriesId,
            address firstP,
            address firstN,
            address secondP,
            address secondN
        )
    {
        return (
            storedSeries.firstSeriesId,
            storedSeries.secondSeriesId,
            storedSeries.firstP,
            storedSeries.firstN,
            storedSeries.secondP,
            storedSeries.secondN
        );
    }
}
