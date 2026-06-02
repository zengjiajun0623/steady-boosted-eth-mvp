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

/// @notice Dependency-free local MVP wiring contract.
/// @dev Use with `forge create` or import into a Foundry Script when forge-std
/// is added. This deploys the complete mock-oracle topology used by the tests.
contract DeployLocalMvp {
    uint16 public constant MAX_NORMAL_ROLL_COST_BPS = 10;
    uint256 public constant MIN_NORMAL_ROLL_PRICE_WAD = 0.999e18;

    struct Config {
        uint256 strike;
        uint64 firstMaturity;
        uint64 secondMaturity;
        uint32 twapWindow;
        uint256 capEth;
        uint64 withdrawDelay;
        uint256 maxEthPerRoll;
        uint256 maxActiveStrategyEth;
        uint256 maxRollPriceWad;
        uint256 minInventorySalePriceWad;
        address auctionGuardian;
        uint64 minAuctionDuration;
        uint64 minLpBackstopDelay;
        uint64 minLpAuctionTimeLeft;
        uint16 maxLpAuctionPriceDropBps;
        uint256 minWrapperRollAmount;
        uint256 maxWrapperRollAmount;
        uint256 maxActiveRollAuctions;
        uint256 maxActiveRollAuctionsPerSeller;
        uint256 minRewardedOperationAmount;
        uint256 keeperRewardEth;
        uint256 ammFeeBps;
    }

    struct Deployment {
        EthOptionsFactory factory;
        MockSettlementOracle oracle;
        ProtocolHealthLens healthLens;
        RollAuction rollAuction;
        RollSolver rollSolver;
        EthLPVaultKeeper lpKeeper;
        EthLPVault lpVault;
        SeriesExposureVaultKeeper steadyKeeper;
        SeriesExposureVaultKeeper boostedKeeper;
        SeriesExposureVault steadyVault;
        SeriesExposureVault boostedVault;
        EthTokenAMM steadyMarket;
        EthTokenAMM boostedMarket;
        EthTokenAMM firstPMarket;
        EthTokenAMM firstNMarket;
        EthTokenAMM secondPMarket;
        EthTokenAMM secondNMarket;
        bytes32 firstSeriesId;
        bytes32 secondSeriesId;
        MintBurnToken firstP;
        MintBurnToken firstN;
        MintBurnToken secondP;
        MintBurnToken secondN;
    }

    event CoreDeployed(
        address indexed factory,
        address indexed rollAuction,
        address indexed lpVault,
        address oracle,
        address rollSolver,
        address lpKeeper
    );
    event SeriesDeployed(
        bytes32 indexed firstSeriesId,
        bytes32 indexed secondSeriesId,
        address firstP,
        address firstN,
        address secondP,
        address secondN
    );
    event ProductsDeployed(address steadyVault, address boostedVault, address steadyMarket, address boostedMarket);
    event InventoryMarketsDeployed(
        address firstPMarket, address firstNMarket, address secondPMarket, address secondNMarket
    );
    event WrapperKeepersDeployed(address steadyKeeper, address boostedKeeper);
    event HealthLensDeployed(address healthLens);
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

    Deployment private lastDeployment;

    receive() external payable {}

    function deployDefault() external {
        Config memory config = Config({
            strike: 1_000e18,
            firstMaturity: uint64(block.timestamp + 30 days),
            secondMaturity: uint64(block.timestamp + 60 days),
            twapWindow: 72 hours,
            capEth: 100 ether,
            withdrawDelay: 4 days,
            maxEthPerRoll: 1 ether,
            maxActiveStrategyEth: 3 ether,
            maxRollPriceWad: 1e18,
            minInventorySalePriceWad: MIN_NORMAL_ROLL_PRICE_WAD,
            auctionGuardian: address(0),
            minAuctionDuration: 12 hours,
            minLpBackstopDelay: 4 hours,
            minLpAuctionTimeLeft: 6 hours,
            maxLpAuctionPriceDropBps: MAX_NORMAL_ROLL_COST_BPS,
            minWrapperRollAmount: 0.01 ether,
            maxWrapperRollAmount: 5 ether,
            maxActiveRollAuctions: 16,
            maxActiveRollAuctionsPerSeller: 4,
            minRewardedOperationAmount: 0.01 ether,
            keeperRewardEth: 0,
            ammFeeBps: 30
        });

        deploy(config);
    }

    function deploy(Config memory config) public {
        if (
            config.strike == 0 || config.firstMaturity <= block.timestamp
                || config.secondMaturity <= config.firstMaturity || config.twapWindow == 0 || config.capEth == 0
                || config.minWrapperRollAmount == 0 || config.minRewardedOperationAmount == 0
                || config.minInventorySalePriceWad < MIN_NORMAL_ROLL_PRICE_WAD
                || config.minInventorySalePriceWad > config.maxRollPriceWad
                || config.minLpBackstopDelay + config.minLpAuctionTimeLeft > config.minAuctionDuration
                || config.maxLpAuctionPriceDropBps > MAX_NORMAL_ROLL_COST_BPS
                || config.maxWrapperRollAmount < config.minWrapperRollAmount
                || config.maxWrapperRollAmount > config.capEth || config.maxActiveRollAuctions == 0
                || config.maxActiveRollAuctionsPerSeller == 0
        ) {
            revert InvalidConfig();
        }

        delete lastDeployment;
        Deployment storage stored = lastDeployment;

        stored.factory = new EthOptionsFactory();
        stored.oracle = new MockSettlementOracle();
        stored.healthLens = new ProtocolHealthLens();
        stored.rollAuction =
            new RollAuction(
                config.auctionGuardian,
                config.minWrapperRollAmount,
                config.maxActiveRollAuctions,
                config.maxActiveRollAuctionsPerSeller
            );
        stored.rollSolver = new RollSolver();
        stored.lpKeeper = new EthLPVaultKeeper(config.minRewardedOperationAmount, config.keeperRewardEth);
        stored.lpVault = new EthLPVault(
            address(stored.lpKeeper),
            config.withdrawDelay,
            config.maxEthPerRoll,
            config.maxActiveStrategyEth,
            config.maxRollPriceWad,
            config.minInventorySalePriceWad,
            config.minAuctionDuration,
            config.minLpBackstopDelay,
            config.minLpAuctionTimeLeft,
            config.maxLpAuctionPriceDropBps
        );
        stored.lpKeeper.setVault(stored.lpVault);

        stored.firstSeriesId = stored.factory
            .createSeries(config.strike, config.firstMaturity, config.twapWindow, config.capEth, stored.oracle);
        stored.secondSeriesId = stored.factory
            .createSeries(config.strike, config.secondMaturity, config.twapWindow, config.capEth, stored.oracle);

        (stored.firstP, stored.firstN) = _tokens(stored.factory, stored.firstSeriesId);
        (stored.secondP, stored.secondN) = _tokens(stored.factory, stored.secondSeriesId);

        stored.steadyKeeper = new SeriesExposureVaultKeeper(
            stored.factory,
            stored.rollAuction,
            false,
            config.maxRollPriceWad,
            MIN_NORMAL_ROLL_PRICE_WAD,
            config.minAuctionDuration,
            3 days,
            config.minWrapperRollAmount,
            config.maxWrapperRollAmount,
            config.keeperRewardEth
        );
        stored.boostedKeeper = new SeriesExposureVaultKeeper(
            stored.factory,
            stored.rollAuction,
            true,
            config.maxRollPriceWad,
            MIN_NORMAL_ROLL_PRICE_WAD,
            config.minAuctionDuration,
            3 days,
            config.minWrapperRollAmount,
            config.maxWrapperRollAmount,
            config.keeperRewardEth
        );
        stored.steadyVault = new SeriesExposureVault(
            stored.firstP, address(stored.steadyKeeper), "Steady ETH", "steadyETH", config.maxWrapperRollAmount
        );
        stored.boostedVault = new SeriesExposureVault(
            stored.firstN, address(stored.boostedKeeper), "Boosted ETH", "boostedETH", config.maxWrapperRollAmount
        );
        stored.steadyKeeper.setVault(stored.steadyVault, stored.firstSeriesId);
        stored.boostedKeeper.setVault(stored.boostedVault, stored.firstSeriesId);
        stored.lpKeeper.setRollSellers(address(stored.steadyVault), address(stored.boostedVault));
        stored.steadyMarket = new EthTokenAMM(
            IERC20Like(address(stored.steadyVault.share())), "Steady ETH Market LP", "stETHM-LP", config.ammFeeBps
        );
        stored.boostedMarket = new EthTokenAMM(
            IERC20Like(address(stored.boostedVault.share())), "Boosted ETH Market LP", "bstETHM-LP", config.ammFeeBps
        );
        stored.firstPMarket =
            new EthTokenAMM(IERC20Like(address(stored.firstP)), "First P Inventory LP", "firstP-LP", config.ammFeeBps);
        stored.firstNMarket =
            new EthTokenAMM(IERC20Like(address(stored.firstN)), "First N Inventory LP", "firstN-LP", config.ammFeeBps);
        stored.secondPMarket = new EthTokenAMM(
            IERC20Like(address(stored.secondP)), "Second P Inventory LP", "secondP-LP", config.ammFeeBps
        );
        stored.secondNMarket = new EthTokenAMM(
            IERC20Like(address(stored.secondN)), "Second N Inventory LP", "secondN-LP", config.ammFeeBps
        );

        emit CoreDeployed(
            address(stored.factory),
            address(stored.rollAuction),
            address(stored.lpVault),
            address(stored.oracle),
            address(stored.rollSolver),
            address(stored.lpKeeper)
        );
        emit SeriesDeployed(
            stored.firstSeriesId,
            stored.secondSeriesId,
            address(stored.firstP),
            address(stored.firstN),
            address(stored.secondP),
            address(stored.secondN)
        );
        emit ProductsDeployed(
            address(stored.steadyVault),
            address(stored.boostedVault),
            address(stored.steadyMarket),
            address(stored.boostedMarket)
        );
        emit InventoryMarketsDeployed(
            address(stored.firstPMarket),
            address(stored.firstNMarket),
            address(stored.secondPMarket),
            address(stored.secondNMarket)
        );
        emit WrapperKeepersDeployed(address(stored.steadyKeeper), address(stored.boostedKeeper));
        emit HealthLensDeployed(address(stored.healthLens));
    }

    function seedMarkets(
        uint256 steadyShares,
        uint256 boostedShares,
        uint256 steadyMarketEth,
        uint256 boostedMarketEth,
        address recipient
    ) external payable {
        Deployment storage stored = lastDeployment;
        if (
            address(stored.factory) == address(0) || address(stored.steadyVault) == address(0)
                || address(stored.boostedVault) == address(0) || address(stored.steadyMarket) == address(0)
                || address(stored.boostedMarket) == address(0)
        ) {
            revert NothingDeployed();
        }
        if (
            steadyShares == 0 || boostedShares == 0 || steadyMarketEth == 0 || boostedMarketEth == 0
                || recipient == address(0)
        ) {
            revert InvalidConfig();
        }

        uint256 optionMintEth = steadyShares > boostedShares ? steadyShares : boostedShares;
        uint256 requiredEth = optionMintEth + steadyMarketEth + boostedMarketEth;
        if (msg.value < requiredEth) revert InsufficientEth();

        stored.factory.mint{value: optionMintEth}(stored.firstSeriesId);

        stored.firstP.approve(address(stored.steadyVault), steadyShares);
        stored.steadyVault.deposit(steadyShares, steadyShares, address(this));
        stored.firstP.approve(address(stored.steadyVault), 0);

        stored.firstN.approve(address(stored.boostedVault), boostedShares);
        stored.boostedVault.deposit(boostedShares, boostedShares, address(this));
        stored.firstN.approve(address(stored.boostedVault), 0);

        MintBurnToken steadyShare = stored.steadyVault.share();
        MintBurnToken boostedShare = stored.boostedVault.share();

        steadyShare.approve(address(stored.steadyMarket), steadyShares);
        stored.steadyMarket.addLiquidity{value: steadyMarketEth}(steadyShares, 0, recipient);
        steadyShare.approve(address(stored.steadyMarket), 0);

        boostedShare.approve(address(stored.boostedMarket), boostedShares);
        stored.boostedMarket.addLiquidity{value: boostedMarketEth}(boostedShares, 0, recipient);
        boostedShare.approve(address(stored.boostedMarket), 0);

        uint256 leftoverP = stored.firstP.balanceOf(address(this));
        if (leftoverP != 0) stored.firstP.transfer(recipient, leftoverP);

        uint256 leftoverN = stored.firstN.balanceOf(address(this));
        if (leftoverN != 0) stored.firstN.transfer(recipient, leftoverN);

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
        Deployment storage stored = lastDeployment;
        if (address(stored.factory) == address(0) || address(stored.firstPMarket) == address(0)) {
            revert NothingDeployed();
        }
        if (tokenAmount == 0 || marketEth == 0 || recipient == address(0)) revert InvalidConfig();

        bytes32 seriesId = secondSeries ? stored.secondSeriesId : stored.firstSeriesId;
        MintBurnToken token =
            secondSeries ? (nSide ? stored.secondN : stored.secondP) : (nSide ? stored.firstN : stored.firstP);
        MintBurnToken pairedToken =
            secondSeries ? (nSide ? stored.secondP : stored.secondN) : (nSide ? stored.firstP : stored.firstN);
        EthTokenAMM market = secondSeries
            ? (nSide ? stored.secondNMarket : stored.secondPMarket)
            : (nSide ? stored.firstNMarket : stored.firstPMarket);

        uint256 requiredEth = tokenAmount + marketEth;
        if (msg.value < requiredEth) revert InsufficientEth();

        stored.factory.mint{value: tokenAmount}(seriesId);
        token.approve(address(market), tokenAmount);
        market.addLiquidity{value: marketEth}(tokenAmount, 0, recipient);
        token.approve(address(market), 0);

        uint256 leftoverPaired = pairedToken.balanceOf(address(this));
        if (leftoverPaired != 0) pairedToken.transfer(recipient, leftoverPaired);

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
        return (
            lastDeployment.factory,
            lastDeployment.oracle,
            lastDeployment.rollAuction,
            lastDeployment.rollSolver,
            lastDeployment.lpKeeper,
            lastDeployment.lpVault
        );
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
        return (
            lastDeployment.steadyVault,
            lastDeployment.boostedVault,
            lastDeployment.steadyMarket,
            lastDeployment.boostedMarket
        );
    }

    function wrapperKeepers()
        external
        view
        returns (SeriesExposureVaultKeeper steadyKeeper, SeriesExposureVaultKeeper boostedKeeper)
    {
        return (lastDeployment.steadyKeeper, lastDeployment.boostedKeeper);
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
        return (
            lastDeployment.firstPMarket,
            lastDeployment.firstNMarket,
            lastDeployment.secondPMarket,
            lastDeployment.secondNMarket
        );
    }

    function healthLens() external view returns (ProtocolHealthLens) {
        return lastDeployment.healthLens;
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
        return (
            lastDeployment.firstSeriesId,
            lastDeployment.secondSeriesId,
            lastDeployment.firstP,
            lastDeployment.firstN,
            lastDeployment.secondP,
            lastDeployment.secondN
        );
    }

    function _tokens(EthOptionsFactory factory, bytes32 seriesId)
        internal
        view
        returns (MintBurnToken pToken, MintBurnToken nToken)
    {
        (,,,,,, pToken, nToken,,,) = factory.series(seriesId);
    }

    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }
}
