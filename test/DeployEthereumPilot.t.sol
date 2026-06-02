// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DeployEthereumPilot} from "../script/DeployEthereumPilot.sol";
import {EthOptionsFactory} from "../src/EthOptionsFactory.sol";
import {RollAuction} from "../src/RollAuction.sol";
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

interface PilotDeployVm {
    function chainId(uint256 chainId) external;
    function expectRevert(bytes4 selector) external;
}

contract DeployEthereumPilotTest {
    PilotDeployVm internal constant vm = PilotDeployVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function testRejectsNonMainnetChain() public {
        vm.chainId(31_337);
        DeployEthereumPilot deployer = new DeployEthereumPilot();

        vm.expectRevert(DeployEthereumPilot.WrongChain.selector);
        deployer.deploy(_config());
    }

    function testRejectsCapAbovePilotLimit() public {
        vm.chainId(1);
        DeployEthereumPilot deployer = new DeployEthereumPilot();
        DeployEthereumPilot.Config memory config = _config();
        config.capEth = EthereumMainnetOracleConfig.mainnetEthStableMedian005().initialSeriesCapEth + 1;

        vm.expectRevert(DeployEthereumPilot.CapAbovePilotLimit.selector);
        deployer.deploy(config);
    }

    function testRejectsLooseNormalRollCostPolicy() public {
        vm.chainId(1);
        DeployEthereumPilot deployer = new DeployEthereumPilot();

        DeployEthereumPilot.Config memory premiumConfig = _config();
        premiumConfig.maxRollPriceWad = 1.001e18;
        vm.expectRevert(DeployEthereumPilot.InvalidConfig.selector);
        deployer.deploy(premiumConfig);

        DeployEthereumPilot.Config memory looseFloorConfig = _config();
        looseFloorConfig.steadyFloorPriceWad = 0.998e18;
        vm.expectRevert(DeployEthereumPilot.InvalidConfig.selector);
        deployer.deploy(looseFloorConfig);

        DeployEthereumPilot.Config memory looseBackstopConfig = _config();
        looseBackstopConfig.maxLpAuctionPriceDropBps = 11;
        vm.expectRevert(DeployEthereumPilot.InvalidConfig.selector);
        deployer.deploy(looseBackstopConfig);

        DeployEthereumPilot.Config memory looseInventoryConfig = _config();
        looseInventoryConfig.minInventorySalePriceWad = 0.998e18;
        vm.expectRevert(DeployEthereumPilot.InvalidConfig.selector);
        deployer.deploy(looseInventoryConfig);
    }

    function testDeploysMainnetTwapPilotTopology() public {
        vm.chainId(1);
        DeployEthereumPilot deployer = new DeployEthereumPilot();
        DeployEthereumPilot.Config memory config = _config();
        EthereumMainnetOracleConfig.MedianOracleConfig memory oracleConfig =
            EthereumMainnetOracleConfig.mainnetEthStableMedian005();

        deployer.deploy(config);

        {
            ProtocolHealthLens healthLens = deployer.healthLens();
            assertNonzero(address(healthLens));
        }

        {
            (
                EthOptionsFactory factory,
                MedianStableTwapSettlementOracle oracle,
                RollAuction rollAuction,
                RollSolver rollSolver,
                EthLPVaultKeeper lpKeeper,
                EthLPVault lpVault
            ) = deployer.core();

            assertNonzero(address(factory));
            assertNonzero(address(oracle));
            assertNonzero(address(rollAuction));
            assertNonzero(address(rollSolver));
            assertNonzero(address(lpKeeper));
            assertNonzero(address(lpVault));
            assertEq(oracle.factory(), address(factory));
            _assertOraclePoolConfig(oracle, oracleConfig, 0);
            _assertOraclePoolConfig(oracle, oracleConfig, 1);
            _assertOraclePoolConfig(oracle, oracleConfig, 2);
            assertEq(rollAuction.guardian(), address(0));
            assertEq(rollAuction.maxActiveAuctions(), config.maxActiveRollAuctions);
            assertEq(rollAuction.maxActiveAuctionsPerSeller(), config.maxActiveRollAuctionsPerSeller);
            assertEq(rollAuction.minStaleResetDelay(), 12 hours);
            assertEq(rollAuction.minStaleResetPriceDropBps(), 5);
            assertEq(address(lpKeeper.vault()), address(lpVault));
            assertEq(lpVault.manager(), address(lpKeeper));
            assertEq(uint256(lpVault.minBackstopDelay()), uint256(config.minLpBackstopDelay));
            assertEq(uint256(lpVault.minAuctionTimeLeft()), uint256(config.minLpAuctionTimeLeft));
            assertEq(uint256(lpVault.maxAuctionPriceDropBps()), uint256(config.maxLpAuctionPriceDropBps));
            assertEq(lpVault.minInventorySalePriceWad(), config.minInventorySalePriceWad);
        }

        _assertPilotSeriesState(
            deployer, config.capEth, config.firstMaturity, config.secondMaturity, oracleConfig.defaultTwapWindow
        );

        (SeriesExposureVaultKeeper steadyKeeper, SeriesExposureVaultKeeper boostedKeeper) = deployer.wrapperKeepers();
        assertEq(steadyKeeper.minRollSellAmount(), config.minWrapperRollAmount);
        assertEq(boostedKeeper.minRollSellAmount(), config.minWrapperRollAmount);
        assertEq(steadyKeeper.maxRollSellAmount(), config.maxWrapperRollAmount);
        assertEq(boostedKeeper.maxRollSellAmount(), config.maxWrapperRollAmount);
        assertEq(steadyKeeper.maxStartPriceWad(), config.maxRollPriceWad);
        assertEq(boostedKeeper.maxStartPriceWad(), config.maxRollPriceWad);
        assertEq(steadyKeeper.minEndPriceWad(), config.steadyFloorPriceWad);
        assertEq(boostedKeeper.minEndPriceWad(), config.boostedFloorPriceWad);

        (SeriesExposureVault steadyVault, SeriesExposureVault boostedVault,,) = deployer.products();
        assertEq(steadyVault.maxAssets(), config.maxWrapperRollAmount);
        assertEq(boostedVault.maxAssets(), config.maxWrapperRollAmount);
        (,,,, EthLPVaultKeeper sellerPinnedLpKeeper,) = deployer.core();
        assertEq(sellerPinnedLpKeeper.rollSellersSet() ? uint256(1) : uint256(0), 1);
        assertEq(sellerPinnedLpKeeper.steadyRollSeller(), address(steadyVault));
        assertEq(sellerPinnedLpKeeper.boostedRollSeller(), address(boostedVault));
    }

    function testCanDeployTrustMinimizedPilotWithNoAuctionGuardian() public {
        vm.chainId(1);
        DeployEthereumPilot deployer = new DeployEthereumPilot();
        DeployEthereumPilot.Config memory config = _config();

        deployer.deploy(config);

        (,, RollAuction rollAuction,,,) = deployer.core();
        uint256 stopNewAuctions = rollAuction.STOP_NEW_AUCTIONS();
        assertEq(rollAuction.guardian(), address(0));

        vm.expectRevert(RollAuction.NotGuardian.selector);
        rollAuction.setStopped(stopNewAuctions);
        vm.expectRevert(RollAuction.NotGuardian.selector);
        rollAuction.setMinSellAmount(config.minWrapperRollAmount * 2);
        vm.expectRevert(RollAuction.NotGuardian.selector);
        rollAuction.setStaleResetPolicy(6 hours, 200);
    }

    function testSeedMarketsWrapsFirstSeriesAndAddsShareLiquidity() public {
        vm.chainId(1);
        DeployEthereumPilot deployer = new DeployEthereumPilot();
        deployer.deploy(_config());

        address lp = address(0xBEEF);
        deployer.seedMarkets{value: 3.5 ether}(1 ether, 0.5 ether, 1.2 ether, 1.3 ether, lp);

        (,, MintBurnToken firstP, MintBurnToken firstN,,) = deployer.series();
        (
            SeriesExposureVault steadyVault,
            SeriesExposureVault boostedVault,
            EthTokenAMM steadyMarket,
            EthTokenAMM boostedMarket
        ) = deployer.products();

        MintBurnToken steadyShare = steadyVault.share();
        MintBurnToken boostedShare = boostedVault.share();

        require(address(steadyMarket.token()) == address(steadyShare), "steady share market mismatch");
        require(address(boostedMarket.token()) == address(boostedShare), "boosted share market mismatch");

        assertEq(steadyVault.totalAssets(), 1 ether);
        assertEq(boostedVault.totalAssets(), 0.5 ether);
        assertEq(steadyMarket.ethReserve(), 1.2 ether);
        assertEq(steadyMarket.tokenReserve(), 1 ether);
        assertEq(boostedMarket.ethReserve(), 1.3 ether);
        assertEq(boostedMarket.tokenReserve(), 0.5 ether);
        assertEq(steadyShare.balanceOf(address(steadyMarket)), 1 ether);
        assertEq(boostedShare.balanceOf(address(boostedMarket)), 0.5 ether);
        assertEq(steadyMarket.lpToken().balanceOf(lp), 1.2 ether);
        assertEq(boostedMarket.lpToken().balanceOf(lp), 1.3 ether);
        assertEq(firstP.balanceOf(lp), 0);
        assertEq(firstN.balanceOf(lp), 0.5 ether);
    }

    function testSeedInventoryMarketAddsDirectSeriesLiquidity() public {
        vm.chainId(1);
        DeployEthereumPilot deployer = new DeployEthereumPilot();
        deployer.deploy(_config());

        address lp = address(0xBEEF);
        deployer.seedInventoryMarket{value: 1.25 ether}(true, true, 0.5 ether, 0.75 ether, lp);

        (,,,, MintBurnToken secondP, MintBurnToken secondN) = deployer.series();
        (,,, EthTokenAMM secondNMarket) = deployer.inventoryMarkets();

        require(address(secondNMarket.token()) == address(secondN), "second N market mismatch");
        assertEq(secondNMarket.ethReserve(), 0.75 ether);
        assertEq(secondNMarket.tokenReserve(), 0.5 ether);
        assertEq(secondNMarket.lpToken().balanceOf(lp), 0.75 ether);
        assertEq(secondP.balanceOf(lp), 0.5 ether);
    }

    function _assertProductTopology(
        DeployEthereumPilot deployer,
        bytes32 firstSeriesId,
        MintBurnToken firstP,
        MintBurnToken firstN
    ) internal view {
        (
            SeriesExposureVault steadyVault,
            SeriesExposureVault boostedVault,
            EthTokenAMM steadyMarket,
            EthTokenAMM boostedMarket
        ) = deployer.products();
        (SeriesExposureVaultKeeper steadyKeeper, SeriesExposureVaultKeeper boostedKeeper) = deployer.wrapperKeepers();

        assertNonzero(address(steadyVault));
        assertNonzero(address(boostedVault));
        assertNonzero(address(steadyKeeper));
        assertNonzero(address(boostedKeeper));
        assertNonzero(address(steadyMarket));
        assertNonzero(address(boostedMarket));
        require(address(steadyVault.currentToken()) == address(firstP), "steady token mismatch");
        require(address(boostedVault.currentToken()) == address(firstN), "boosted token mismatch");
        require(steadyVault.manager() == address(steadyKeeper), "steady keeper mismatch");
        require(boostedVault.manager() == address(boostedKeeper), "boosted keeper mismatch");
        require(steadyKeeper.currentSeriesId() == firstSeriesId, "steady series mismatch");
        require(boostedKeeper.currentSeriesId() == firstSeriesId, "boosted series mismatch");
        require(address(steadyMarket.token()) == address(steadyVault.share()), "steady market mismatch");
        require(address(boostedMarket.token()) == address(boostedVault.share()), "boosted market mismatch");
    }

    function _assertPilotSeriesState(
        DeployEthereumPilot deployer,
        uint256 capEth,
        uint64 firstMaturity,
        uint64 secondMaturity,
        uint32 twapWindow
    ) internal view {
        (
            bytes32 firstSeriesId,
            bytes32 secondSeriesId,
            MintBurnToken firstP,
            MintBurnToken firstN,
            MintBurnToken secondP,
            MintBurnToken secondN
        ) = deployer.series();
        (EthOptionsFactory factory, MedianStableTwapSettlementOracle oracle,,,,) = deployer.core();

        assertNonzero(address(firstP));
        assertNonzero(address(firstN));
        assertNonzero(address(secondP));
        assertNonzero(address(secondN));
        require(firstSeriesId != bytes32(0), "missing first series");
        require(secondSeriesId != bytes32(0), "missing second series");

        _assertInventoryMarketTopology(deployer, firstP, firstN, secondP, secondN);
        _assertProductTopology(deployer, firstSeriesId, firstP, firstN);
        _assertSeries(factory, firstSeriesId, capEth, twapWindow);
        _assertSeries(factory, secondSeriesId, capEth, twapWindow);
        _assertOracleRegistration(oracle, firstSeriesId, firstMaturity, twapWindow);
        _assertOracleRegistration(oracle, secondSeriesId, secondMaturity, twapWindow);
    }

    function _assertInventoryMarketTopology(
        DeployEthereumPilot deployer,
        MintBurnToken firstP,
        MintBurnToken firstN,
        MintBurnToken secondP,
        MintBurnToken secondN
    ) internal view {
        (EthTokenAMM firstPMarket, EthTokenAMM firstNMarket, EthTokenAMM secondPMarket, EthTokenAMM secondNMarket) =
            deployer.inventoryMarkets();

        assertNonzero(address(firstPMarket));
        assertNonzero(address(firstNMarket));
        assertNonzero(address(secondPMarket));
        assertNonzero(address(secondNMarket));
        require(address(firstPMarket.token()) == address(firstP), "first P market mismatch");
        require(address(firstNMarket.token()) == address(firstN), "first N market mismatch");
        require(address(secondPMarket.token()) == address(secondP), "second P market mismatch");
        require(address(secondNMarket.token()) == address(secondN), "second N market mismatch");
    }

    function _assertSeries(EthOptionsFactory factory, bytes32 seriesId, uint256 capEth, uint32 twapWindow)
        internal
        view
    {
        (,, uint32 actualTwapWindow, uint256 actualCap,,,,,,,) = factory.series(seriesId);
        assertEq(uint256(actualTwapWindow), uint256(twapWindow));
        assertEq(actualCap, capEth);
    }

    function _assertOracleRegistration(
        MedianStableTwapSettlementOracle oracle,
        bytes32 seriesId,
        uint64 maturity,
        uint32 twapWindow
    ) internal view {
        (uint64 registeredMaturity, uint32 registeredWindow, bool registered) = oracle.seriesConfigs(seriesId);
        assertEq(registered ? uint256(1) : uint256(0), 1);
        assertEq(uint256(registeredMaturity), uint256(maturity));
        assertEq(uint256(registeredWindow), uint256(twapWindow));
    }

    function _assertOraclePoolConfig(
        MedianStableTwapSettlementOracle oracle,
        EthereumMainnetOracleConfig.MedianOracleConfig memory oracleConfig,
        uint256 index
    ) internal view {
        (
            ,
            uint256 priceAtTickZeroWad,
            bool invertPrice,
            int24 minUsableTick,
            int24 maxUsableTick
        ) = oracle.poolConfigs(index);

        assertEq(priceAtTickZeroWad, oracleConfig.pools[index].priceAtTickZeroWad);
        assertEq(invertPrice ? uint256(1) : uint256(0), oracleConfig.pools[index].invertPrice ? uint256(1) : uint256(0));
        assertEq(int256(minUsableTick), int256(oracleConfig.pools[index].minUsableTick));
        assertEq(int256(maxUsableTick), int256(oracleConfig.pools[index].maxUsableTick));
    }

    function _config() internal view returns (DeployEthereumPilot.Config memory config) {
        config = DeployEthereumPilot.Config({
            strike: 1_000e18,
            firstMaturity: uint64(block.timestamp + 30 days),
            secondMaturity: uint64(block.timestamp + 60 days),
            capEth: 25 ether,
            withdrawDelay: 4 days,
            maxEthPerRoll: 1 ether,
            maxActiveStrategyEth: 3 ether,
            maxRollPriceWad: 1e18,
            minInventorySalePriceWad: 0.999e18,
            steadyFloorPriceWad: 0.999e18,
            boostedFloorPriceWad: 0.999e18,
            minAuctionDuration: 12 hours,
            minLpBackstopDelay: 4 hours,
            minLpAuctionTimeLeft: 6 hours,
            maxLpAuctionPriceDropBps: 10,
            maxAuctionDuration: 3 days,
            minWrapperRollAmount: 0.01 ether,
            maxWrapperRollAmount: 5 ether,
            maxActiveRollAuctions: 16,
            maxActiveRollAuctionsPerSeller: 4,
            minRewardedOperationAmount: 0.01 ether,
            keeperRewardEth: 0,
            ammFeeBps: 30
        });
    }

    function assertNonzero(address value) internal pure {
        require(value != address(0), "zero address");
    }

    function assertEq(uint256 actual, uint256 expected) internal pure {
        require(actual == expected, "uint mismatch");
    }

    function assertEq(int256 actual, int256 expected) internal pure {
        require(actual == expected, "int mismatch");
    }

    function assertEq(address actual, address expected) internal pure {
        require(actual == expected, "address mismatch");
    }
}
