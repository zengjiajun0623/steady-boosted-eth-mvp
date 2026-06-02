// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EthOptionsFactory} from "../src/EthOptionsFactory.sol";
import {IERC20Like, RollAuction} from "../src/RollAuction.sol";
import {RollSolver} from "../src/RollSolver.sol";
import {ProtocolHealthLens} from "../src/lens/ProtocolHealthLens.sol";
import {EthTokenAMM} from "../src/market/EthTokenAMM.sol";
import {MockSettlementOracle} from "../src/oracle/MockSettlementOracle.sol";
import {MintBurnToken} from "../src/token/MintBurnToken.sol";
import {EthLPVault} from "../src/vault/EthLPVault.sol";
import {EthLPVaultKeeper} from "../src/vault/EthLPVaultKeeper.sol";
import {SeriesExposureVault} from "../src/vault/SeriesExposureVault.sol";
import {SeriesExposureVaultKeeper} from "../src/vault/SeriesExposureVaultKeeper.sol";

interface ManifestVm {
    function startBroadcast() external;
    function stopBroadcast() external;
    function toString(address value) external returns (string memory);
    function writeFile(string memory path, string memory data) external;
}

/// @notice Broadcast-friendly local MVP deployment script.
/// @dev The script deploys each component directly, then deploys a small topology
/// registry. Export the full demo manifest with `ops/export-manifest.mjs`.
contract DeployLocalMvpManifest {
    ManifestVm internal constant vm = ManifestVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint16 internal constant MAX_NORMAL_ROLL_COST_BPS = 10;
    uint256 internal constant MIN_NORMAL_ROLL_PRICE_WAD = 0.999e18;

    EthOptionsFactory internal factory;
    MockSettlementOracle internal oracle;
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
    LocalMvpTopology internal topology;

    function run() external {
        runTo("demo/deployment-registry.txt");
    }

    function runTo(string memory outputPath) public {
        vm.startBroadcast();
        _deployCore();
        _deploySeries();
        _deployProducts();
        _deployTopology();
        vm.stopBroadcast();

        vm.writeFile(outputPath, vm.toString(address(topology)));
    }

    function _deployCore() internal {
        factory = new EthOptionsFactory();
        oracle = new MockSettlementOracle();
        healthLens = new ProtocolHealthLens();
        rollAuction = new RollAuction(address(0), 0.01 ether, 16, 4);
        rollSolver = new RollSolver();
        lpKeeper = new EthLPVaultKeeper(0.01 ether, 0);
        lpVault = new EthLPVault(
            address(lpKeeper),
            4 days,
            1 ether,
            3 ether,
            1e18,
            MIN_NORMAL_ROLL_PRICE_WAD,
            12 hours,
            4 hours,
            6 hours,
            MAX_NORMAL_ROLL_COST_BPS,
            30
        );
        lpKeeper.setVault(lpVault);
    }

    function _deploySeries() internal {
        firstSeriesId = factory.createSeries(1_000e18, uint64(block.timestamp + 30 days), 72 hours, 100 ether, oracle);
        secondSeriesId = factory.createSeries(1_000e18, uint64(block.timestamp + 60 days), 72 hours, 100 ether, oracle);
        (firstP, firstN) = _tokens(firstSeriesId);
        (secondP, secondN) = _tokens(secondSeriesId);
    }

    function _deployProducts() internal {
        steadyKeeper = new SeriesExposureVaultKeeper(
            factory, rollAuction, false, 1e18, MIN_NORMAL_ROLL_PRICE_WAD, 12 hours, 3 days, 0.01 ether, 5 ether, 0
        );
        boostedKeeper = new SeriesExposureVaultKeeper(
            factory, rollAuction, true, 1e18, MIN_NORMAL_ROLL_PRICE_WAD, 12 hours, 3 days, 0.01 ether, 5 ether, 0
        );

        steadyVault = new SeriesExposureVault(firstP, address(steadyKeeper), "Steady ETH", "steadyETH", 5 ether);
        boostedVault = new SeriesExposureVault(firstN, address(boostedKeeper), "Boosted ETH", "boostedETH", 5 ether);
        steadyKeeper.setVault(steadyVault, firstSeriesId);
        boostedKeeper.setVault(boostedVault, firstSeriesId);
        lpKeeper.setRollSellers(address(steadyVault), address(boostedVault));

        steadyMarket =
            new EthTokenAMM(IERC20Like(address(steadyVault.share())), "Steady ETH Market LP", "stETHM-LP", 30);
        boostedMarket =
            new EthTokenAMM(IERC20Like(address(boostedVault.share())), "Boosted ETH Market LP", "bstETHM-LP", 30);
        firstPMarket = new EthTokenAMM(IERC20Like(address(firstP)), "First P Inventory LP", "firstP-LP", 30);
        firstNMarket = new EthTokenAMM(IERC20Like(address(firstN)), "First N Inventory LP", "firstN-LP", 30);
        secondPMarket = new EthTokenAMM(IERC20Like(address(secondP)), "Second P Inventory LP", "secondP-LP", 30);
        secondNMarket = new EthTokenAMM(IERC20Like(address(secondN)), "Second N Inventory LP", "secondN-LP", 30);
    }

    function _deployTopology() internal {
        topology = new LocalMvpTopology(
            LocalMvpTopology.CoreConfig({
                factory: factory,
                oracle: oracle,
                rollAuction: rollAuction,
                rollSolver: rollSolver,
                lpKeeper: lpKeeper,
                lpVault: lpVault
            }),
            LocalMvpTopology.SeriesConfig({
                firstSeriesId: firstSeriesId,
                secondSeriesId: secondSeriesId,
                firstP: firstP,
                firstN: firstN,
                secondP: secondP,
                secondN: secondN
            }),
            LocalMvpTopology.ProductConfig({
                steadyVault: steadyVault,
                boostedVault: boostedVault,
                steadyMarket: steadyMarket,
                boostedMarket: boostedMarket
            }),
            LocalMvpTopology.InventoryMarketConfig({
                firstPMarket: firstPMarket,
                firstNMarket: firstNMarket,
                secondPMarket: secondPMarket,
                secondNMarket: secondNMarket
            }),
            LocalMvpTopology.WrapperKeeperConfig({steadyKeeper: steadyKeeper, boostedKeeper: boostedKeeper}),
            healthLens
        );
    }

    function _tokens(bytes32 seriesId) internal view returns (MintBurnToken pToken, MintBurnToken nToken) {
        (,,,,,, pToken, nToken,,,) = factory.series(seriesId);
    }
}

/// @notice Constructor-filled address registry plus market seeding helper for
/// directly deployed local MVP topologies.
contract LocalMvpTopology {
    struct CoreConfig {
        EthOptionsFactory factory;
        MockSettlementOracle oracle;
        RollAuction rollAuction;
        RollSolver rollSolver;
        EthLPVaultKeeper lpKeeper;
        EthLPVault lpVault;
    }

    struct SeriesConfig {
        bytes32 firstSeriesId;
        bytes32 secondSeriesId;
        MintBurnToken firstP;
        MintBurnToken firstN;
        MintBurnToken secondP;
        MintBurnToken secondN;
    }

    struct ProductConfig {
        SeriesExposureVault steadyVault;
        SeriesExposureVault boostedVault;
        EthTokenAMM steadyMarket;
        EthTokenAMM boostedMarket;
    }

    struct InventoryMarketConfig {
        EthTokenAMM firstPMarket;
        EthTokenAMM firstNMarket;
        EthTokenAMM secondPMarket;
        EthTokenAMM secondNMarket;
    }

    struct WrapperKeeperConfig {
        SeriesExposureVaultKeeper steadyKeeper;
        SeriesExposureVaultKeeper boostedKeeper;
    }

    event CoreRegistered(
        address indexed factory,
        address indexed rollAuction,
        address indexed lpVault,
        address oracle,
        address rollSolver,
        address lpKeeper
    );
    event SeriesRegistered(
        bytes32 indexed firstSeriesId,
        bytes32 indexed secondSeriesId,
        address firstP,
        address firstN,
        address secondP,
        address secondN
    );
    event ProductsRegistered(address steadyVault, address boostedVault, address steadyMarket, address boostedMarket);
    event InventoryMarketsRegistered(
        address firstPMarket, address firstNMarket, address secondPMarket, address secondNMarket
    );
    event WrapperKeepersRegistered(address steadyKeeper, address boostedKeeper);
    event HealthLensRegistered(address healthLens);
    event MarketsSeeded(
        address indexed recipient,
        uint256 optionMintEth,
        uint256 steadyShares,
        uint256 boostedShares,
        uint256 steadyMarketEth,
        uint256 boostedMarketEth
    );
    event InventoryMarketSeeded(
        bytes32 indexed seriesId,
        address indexed token,
        address indexed market,
        address recipient,
        uint256 tokenAmount,
        uint256 marketEth
    );

    error InvalidConfig();
    error NothingDeployed();
    error InsufficientEth();
    error EthTransferFailed();
    error TransferFailed();

    EthOptionsFactory private storedFactory;
    MockSettlementOracle private storedOracle;
    RollAuction private storedRollAuction;
    RollSolver private storedRollSolver;
    EthLPVaultKeeper private storedLpKeeper;
    EthLPVault private storedLpVault;
    SeriesExposureVaultKeeper private storedSteadyKeeper;
    SeriesExposureVaultKeeper private storedBoostedKeeper;
    SeriesExposureVault private storedSteadyVault;
    SeriesExposureVault private storedBoostedVault;
    EthTokenAMM private storedSteadyMarket;
    EthTokenAMM private storedBoostedMarket;
    EthTokenAMM private storedFirstPMarket;
    EthTokenAMM private storedFirstNMarket;
    EthTokenAMM private storedSecondPMarket;
    EthTokenAMM private storedSecondNMarket;
    ProtocolHealthLens private storedHealthLens;
    bytes32 private storedFirstSeriesId;
    bytes32 private storedSecondSeriesId;
    MintBurnToken private storedFirstP;
    MintBurnToken private storedFirstN;
    MintBurnToken private storedSecondP;
    MintBurnToken private storedSecondN;

    constructor(
        CoreConfig memory core_,
        SeriesConfig memory series_,
        ProductConfig memory products_,
        InventoryMarketConfig memory inventory_,
        WrapperKeeperConfig memory keepers_,
        ProtocolHealthLens healthLens_
    ) {
        storedFactory = core_.factory;
        storedOracle = core_.oracle;
        storedRollAuction = core_.rollAuction;
        storedRollSolver = core_.rollSolver;
        storedLpKeeper = core_.lpKeeper;
        storedLpVault = core_.lpVault;
        storedFirstSeriesId = series_.firstSeriesId;
        storedSecondSeriesId = series_.secondSeriesId;
        storedFirstP = series_.firstP;
        storedFirstN = series_.firstN;
        storedSecondP = series_.secondP;
        storedSecondN = series_.secondN;
        storedSteadyVault = products_.steadyVault;
        storedBoostedVault = products_.boostedVault;
        storedSteadyMarket = products_.steadyMarket;
        storedBoostedMarket = products_.boostedMarket;
        storedFirstPMarket = inventory_.firstPMarket;
        storedFirstNMarket = inventory_.firstNMarket;
        storedSecondPMarket = inventory_.secondPMarket;
        storedSecondNMarket = inventory_.secondNMarket;
        storedSteadyKeeper = keepers_.steadyKeeper;
        storedBoostedKeeper = keepers_.boostedKeeper;
        storedHealthLens = healthLens_;

        emit CoreRegistered(
            address(core_.factory),
            address(core_.rollAuction),
            address(core_.lpVault),
            address(core_.oracle),
            address(core_.rollSolver),
            address(core_.lpKeeper)
        );
        emit SeriesRegistered(
            series_.firstSeriesId,
            series_.secondSeriesId,
            address(series_.firstP),
            address(series_.firstN),
            address(series_.secondP),
            address(series_.secondN)
        );
        emit ProductsRegistered(
            address(products_.steadyVault),
            address(products_.boostedVault),
            address(products_.steadyMarket),
            address(products_.boostedMarket)
        );
        emit InventoryMarketsRegistered(
            address(inventory_.firstPMarket),
            address(inventory_.firstNMarket),
            address(inventory_.secondPMarket),
            address(inventory_.secondNMarket)
        );
        emit WrapperKeepersRegistered(address(keepers_.steadyKeeper), address(keepers_.boostedKeeper));
        emit HealthLensRegistered(address(healthLens_));
    }

    receive() external payable {}

    function seedMarkets(
        uint256 steadyShares,
        uint256 boostedShares,
        uint256 steadyMarketEth,
        uint256 boostedMarketEth,
        address recipient
    ) external payable {
        _requireSeedable(steadyShares, boostedShares, steadyMarketEth, boostedMarketEth, recipient);

        uint256 optionMintEth = steadyShares > boostedShares ? steadyShares : boostedShares;
        uint256 requiredEth = optionMintEth + steadyMarketEth + boostedMarketEth;
        if (msg.value < requiredEth) revert InsufficientEth();

        storedFactory.mint{value: optionMintEth}(storedFirstSeriesId);

        storedFirstP.approve(address(storedSteadyVault), steadyShares);
        storedSteadyVault.deposit(steadyShares, steadyShares, address(this));
        storedFirstP.approve(address(storedSteadyVault), 0);

        storedFirstN.approve(address(storedBoostedVault), boostedShares);
        storedBoostedVault.deposit(boostedShares, boostedShares, address(this));
        storedFirstN.approve(address(storedBoostedVault), 0);

        MintBurnToken steadyShare = storedSteadyVault.share();
        MintBurnToken boostedShare = storedBoostedVault.share();

        steadyShare.approve(address(storedSteadyMarket), steadyShares);
        storedSteadyMarket.addLiquidity{value: steadyMarketEth}(steadyShares, 0, recipient);
        steadyShare.approve(address(storedSteadyMarket), 0);

        boostedShare.approve(address(storedBoostedMarket), boostedShares);
        storedBoostedMarket.addLiquidity{value: boostedMarketEth}(boostedShares, 0, recipient);
        boostedShare.approve(address(storedBoostedMarket), 0);

        _flushLeftovers(recipient);

        if (msg.value > requiredEth) _sendEth(msg.sender, msg.value - requiredEth);

        emit MarketsSeeded(recipient, optionMintEth, steadyShares, boostedShares, steadyMarketEth, boostedMarketEth);
    }

    function seedInventoryMarket(
        bool secondSeries,
        bool nSide,
        uint256 tokenAmount,
        uint256 marketEth,
        address recipient
    ) external payable {
        if (address(storedFactory) == address(0) || address(storedFirstPMarket) == address(0)) {
            revert NothingDeployed();
        }
        if (tokenAmount == 0 || marketEth == 0 || recipient == address(0)) revert InvalidConfig();

        bytes32 seriesId = secondSeries ? storedSecondSeriesId : storedFirstSeriesId;
        MintBurnToken token =
            secondSeries ? (nSide ? storedSecondN : storedSecondP) : (nSide ? storedFirstN : storedFirstP);
        MintBurnToken pairedToken =
            secondSeries ? (nSide ? storedSecondP : storedSecondN) : (nSide ? storedFirstP : storedFirstN);
        EthTokenAMM market = secondSeries
            ? (nSide ? storedSecondNMarket : storedSecondPMarket)
            : (nSide ? storedFirstNMarket : storedFirstPMarket);

        uint256 requiredEth = tokenAmount + marketEth;
        if (msg.value < requiredEth) revert InsufficientEth();

        storedFactory.mint{value: tokenAmount}(seriesId);
        token.approve(address(market), tokenAmount);
        market.addLiquidity{value: marketEth}(tokenAmount, 0, recipient);
        token.approve(address(market), 0);

        uint256 leftoverPaired = pairedToken.balanceOf(address(this));
        if (leftoverPaired != 0 && !pairedToken.transfer(recipient, leftoverPaired)) revert TransferFailed();

        if (msg.value > requiredEth) _sendEth(msg.sender, msg.value - requiredEth);

        emit InventoryMarketSeeded(seriesId, address(token), address(market), recipient, tokenAmount, marketEth);
    }

    function core()
        external
        view
        returns (
            EthOptionsFactory factory,
            MockSettlementOracle oracle,
            RollAuction rollAuction,
            RollSolver rollSolver,
            EthLPVaultKeeper lpKeeper,
            EthLPVault lpVault
        )
    {
        return (storedFactory, storedOracle, storedRollAuction, storedRollSolver, storedLpKeeper, storedLpVault);
    }

    function products()
        external
        view
        returns (
            SeriesExposureVault steadyVault,
            SeriesExposureVault boostedVault,
            EthTokenAMM steadyMarket,
            EthTokenAMM boostedMarket
        )
    {
        return (storedSteadyVault, storedBoostedVault, storedSteadyMarket, storedBoostedMarket);
    }

    function wrapperKeepers()
        external
        view
        returns (SeriesExposureVaultKeeper steadyKeeper, SeriesExposureVaultKeeper boostedKeeper)
    {
        return (storedSteadyKeeper, storedBoostedKeeper);
    }

    function inventoryMarkets()
        external
        view
        returns (
            EthTokenAMM firstPMarket,
            EthTokenAMM firstNMarket,
            EthTokenAMM secondPMarket,
            EthTokenAMM secondNMarket
        )
    {
        return (storedFirstPMarket, storedFirstNMarket, storedSecondPMarket, storedSecondNMarket);
    }

    function healthLens() external view returns (ProtocolHealthLens) {
        return storedHealthLens;
    }

    function series()
        external
        view
        returns (
            bytes32 firstSeriesId,
            bytes32 secondSeriesId,
            MintBurnToken firstP,
            MintBurnToken firstN,
            MintBurnToken secondP,
            MintBurnToken secondN
        )
    {
        return (storedFirstSeriesId, storedSecondSeriesId, storedFirstP, storedFirstN, storedSecondP, storedSecondN);
    }

    function _requireSeedable(
        uint256 steadyShares,
        uint256 boostedShares,
        uint256 steadyMarketEth,
        uint256 boostedMarketEth,
        address recipient
    ) internal view {
        if (
            address(storedFactory) == address(0) || address(storedSteadyVault) == address(0)
                || address(storedBoostedVault) == address(0) || address(storedSteadyMarket) == address(0)
                || address(storedBoostedMarket) == address(0)
        ) {
            revert NothingDeployed();
        }
        if (
            steadyShares == 0 || boostedShares == 0 || steadyMarketEth == 0 || boostedMarketEth == 0
                || recipient == address(0)
        ) {
            revert InvalidConfig();
        }
    }

    function _flushLeftovers(address recipient) internal {
        uint256 leftoverP = storedFirstP.balanceOf(address(this));
        if (leftoverP != 0 && !storedFirstP.transfer(recipient, leftoverP)) revert TransferFailed();

        uint256 leftoverN = storedFirstN.balanceOf(address(this));
        if (leftoverN != 0 && !storedFirstN.transfer(recipient, leftoverN)) revert TransferFailed();
    }

    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }
}
