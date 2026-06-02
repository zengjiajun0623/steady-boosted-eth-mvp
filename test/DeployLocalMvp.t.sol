// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DeployLocalMvp} from "../script/DeployLocalMvp.sol";
import {EthOptionsFactory} from "../src/EthOptionsFactory.sol";
import {RollAuction} from "../src/RollAuction.sol";
import {RollSolver} from "../src/RollSolver.sol";
import {ProtocolHealthLens} from "../src/lens/ProtocolHealthLens.sol";
import {EthTokenAMM} from "../src/market/EthTokenAMM.sol";
import {MockSettlementOracle} from "../src/oracle/MockSettlementOracle.sol";
import {MintBurnToken} from "../src/token/MintBurnToken.sol";
import {EthLPVault} from "../src/vault/EthLPVault.sol";
import {EthLPVaultKeeper} from "../src/vault/EthLPVaultKeeper.sol";
import {SeriesExposureVault} from "../src/vault/SeriesExposureVault.sol";
import {SeriesExposureVaultKeeper} from "../src/vault/SeriesExposureVaultKeeper.sol";

interface LocalMvpVm {
    function deal(address account, uint256 amount) external;
    function prank(address account) external;
    function warp(uint256 timestamp) external;
    function expectRevert(bytes4 selector) external;
}

contract DeployLocalMvpTest {
    LocalMvpVm internal constant vm = LocalMvpVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant PRODUCT_LP = address(0xBEEF);
    address internal constant TRADER = address(0xA11CE);
    address internal constant VAULT_LP = address(0x1A9);
    address internal constant SOLVER = address(0x501);
    address internal constant KEEPER_CALLER = address(0xCA11);

    EthOptionsFactory internal loopFactory;
    MockSettlementOracle internal loopOracle;
    RollAuction internal loopRollAuction;
    RollSolver internal loopRollSolver;
    EthLPVaultKeeper internal loopLpKeeper;
    EthLPVault internal loopLpVault;
    SeriesExposureVaultKeeper internal loopSteadyKeeper;
    SeriesExposureVault internal loopSteadyVault;
    SeriesExposureVault internal loopBoostedVault;
    EthTokenAMM internal loopSteadyMarket;
    EthTokenAMM internal loopBoostedMarket;
    EthTokenAMM internal loopSecondNMarket;
    bytes32 internal loopFirstSeriesId;
    bytes32 internal loopSecondSeriesId;
    MintBurnToken internal loopFirstP;
    MintBurnToken internal loopFirstN;
    MintBurnToken internal loopSecondP;
    MintBurnToken internal loopSecondN;

    function testDeployDefaultWiresCoreTopology() public {
        DeployLocalMvp deployer = new DeployLocalMvp();
        deployer.deployDefault();

        {
            (
                EthOptionsFactory factory,
                MockSettlementOracle oracle,
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
            require(rollAuction.guardian() == address(0), "roll guardian mismatch");
            require(rollAuction.maxActiveAuctions() == 16, "active auction cap mismatch");
            require(rollAuction.maxActiveAuctionsPerSeller() == 4, "seller auction cap mismatch");
            require(rollAuction.minStaleResetDelay() == 12 hours, "stale delay mismatch");
            require(rollAuction.minStaleResetPriceDropBps() == 5, "stale drop mismatch");
            require(lpVault.manager() == address(lpKeeper), "keeper manager mismatch");
            require(lpVault.minBackstopDelay() == 4 hours, "lp backstop delay mismatch");
            require(lpVault.minAuctionTimeLeft() == 6 hours, "lp time-left mismatch");
            require(lpVault.maxAuctionPriceDropBps() == 10, "lp drop mismatch");
            require(lpKeeper.vault() == lpVault, "keeper vault mismatch");
        }

        {
            ProtocolHealthLens healthLens = deployer.healthLens();
            assertNonzero(address(healthLens));
        }

        {
            (bytes32 firstSeriesId, bytes32 secondSeriesId, MintBurnToken firstP, MintBurnToken firstN,,) =
                deployer.series();
            (
                SeriesExposureVault steadyVault,
                SeriesExposureVault boostedVault,
                EthTokenAMM steadyMarket,
                EthTokenAMM boostedMarket
            ) = deployer.products();
            (SeriesExposureVaultKeeper steadyKeeper, SeriesExposureVaultKeeper boostedKeeper) =
                deployer.wrapperKeepers();

            assertNonzero(address(steadyVault));
            assertNonzero(address(boostedVault));
            assertNonzero(address(steadyKeeper));
            assertNonzero(address(boostedKeeper));
            assertNonzero(address(steadyMarket));
            assertNonzero(address(boostedMarket));
            assertNonzero(address(firstP));
            assertNonzero(address(firstN));

            require(firstSeriesId != bytes32(0), "missing first series");
            require(secondSeriesId != bytes32(0), "missing second series");
            require(address(steadyVault.currentToken()) == address(firstP), "steady token mismatch");
            require(address(boostedVault.currentToken()) == address(firstN), "boosted token mismatch");
            require(steadyVault.manager() == address(steadyKeeper), "steady keeper mismatch");
            require(boostedVault.manager() == address(boostedKeeper), "boosted keeper mismatch");
            assertEq(steadyVault.maxAssets(), 5 ether);
            assertEq(boostedVault.maxAssets(), 5 ether);
            require(steadyKeeper.currentSeriesId() == firstSeriesId, "steady current series mismatch");
            require(boostedKeeper.currentSeriesId() == firstSeriesId, "boosted current series mismatch");
            assertEq(steadyKeeper.minRollSellAmount(), 0.01 ether);
            assertEq(boostedKeeper.minRollSellAmount(), 0.01 ether);
            assertEq(steadyKeeper.maxRollSellAmount(), 5 ether);
            assertEq(boostedKeeper.maxRollSellAmount(), 5 ether);
            (,,,, EthLPVaultKeeper lpKeeper, EthLPVault lpVault) = deployer.core();
            assertEq(lpVault.minInventorySalePriceWad(), 0.999e18);
            assertEq(lpKeeper.rollSellersSet() ? uint256(1) : uint256(0), 1);
            assertEq(lpKeeper.steadyRollSeller(), address(steadyVault));
            assertEq(lpKeeper.boostedRollSeller(), address(boostedVault));
            require(address(steadyMarket.token()) == address(steadyVault.share()), "steady market share mismatch");
            require(address(boostedMarket.token()) == address(boostedVault.share()), "boosted market share mismatch");
        }

        {
            (,, MintBurnToken firstP, MintBurnToken firstN, MintBurnToken secondP, MintBurnToken secondN) =
                deployer.series();
            (EthTokenAMM firstPMarket, EthTokenAMM firstNMarket, EthTokenAMM secondPMarket, EthTokenAMM secondNMarket) =
                deployer.inventoryMarkets();

            assertNonzero(address(firstPMarket));
            assertNonzero(address(firstNMarket));
            assertNonzero(address(secondPMarket));
            assertNonzero(address(secondNMarket));
            assertNonzero(address(secondP));
            assertNonzero(address(secondN));
            require(address(firstPMarket.token()) == address(firstP), "first P market mismatch");
            require(address(firstNMarket.token()) == address(firstN), "first N market mismatch");
            require(address(secondPMarket.token()) == address(secondP), "second P market mismatch");
            require(address(secondNMarket.token()) == address(secondN), "second N market mismatch");
        }
    }

    function testRejectsLooseLocalLpBackstopCostPolicy() public {
        DeployLocalMvp deployer = new DeployLocalMvp();
        DeployLocalMvp.Config memory config = _config();
        config.maxLpAuctionPriceDropBps = 11;

        vm.expectRevert(DeployLocalMvp.InvalidConfig.selector);
        deployer.deploy(config);
    }

    function testRejectsLooseLocalInventorySalePolicy() public {
        DeployLocalMvp deployer = new DeployLocalMvp();
        DeployLocalMvp.Config memory config = _config();
        config.minInventorySalePriceWad = 0.998e18;

        vm.expectRevert(DeployLocalMvp.InvalidConfig.selector);
        deployer.deploy(config);
    }

    function testSeedMarketsWrapsFirstSeriesAndAddsShareLiquidity() public {
        DeployLocalMvp deployer = new DeployLocalMvp();
        deployer.deployDefault();

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
        DeployLocalMvp deployer = new DeployLocalMvp();
        deployer.deployDefault();

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

    function testLocalMvpRunsTraderSolverLpRollAndUnwindLoop() public {
        DeployLocalMvp deployer = new DeployLocalMvp();
        deployer.deployDefault();

        deployer.seedMarkets{value: 3.5 ether}(1 ether, 0.5 ether, 1.2 ether, 1.3 ether, PRODUCT_LP);
        deployer.seedInventoryMarket{value: 2 ether}(true, true, 1 ether, 1 ether, PRODUCT_LP);

        vm.deal(TRADER, 3 ether);
        vm.deal(VAULT_LP, 3 ether);
        vm.deal(SOLVER, 2 ether);

        _cacheLoopDeployment(deployer);
        _assertOpenSeriesAccountingInvariant();
        _depositLpIntoVault();
        _assertOpenSeriesAccountingInvariant();
        _exerciseTraderMarkets();
        _assertOpenSeriesAccountingInvariant();
        _runSteadyRollWithSolverAndLp();
        _assertOpenSeriesAccountingInvariant();
        _redeemTraderSteadyAfterRoll();
        _assertOpenSeriesAccountingInvariant();
        _rejectBadLpInventorySaleThroughDirectMarket();
        _assertOpenSeriesAccountingInvariant();
        _settleAndCloseLpInventoryDirectly();
    }

    function _depositLpIntoVault() internal {
        vm.prank(VAULT_LP);
        uint256 lpShares = loopLpVault.deposit{value: 2 ether}();
        assertEq(loopLpVault.share().balanceOf(VAULT_LP), lpShares);
        assertEq(loopLpVault.managedAssets(), 2 ether);
    }

    function _exerciseTraderMarkets() internal {
        MintBurnToken steadyShare = loopSteadyVault.share();
        vm.prank(TRADER);
        uint256 steadyBought = loopSteadyMarket.buyToken{value: 0.1 ether}(0, TRADER);
        assertGt(steadyBought, 0);

        vm.prank(TRADER);
        steadyShare.approve(address(loopSteadyMarket), steadyBought / 2);
        vm.prank(TRADER);
        uint256 steadyEthBack = loopSteadyMarket.sellToken(steadyBought / 2, 0, TRADER);
        assertGt(steadyEthBack, 0);

        MintBurnToken boostedShare = loopBoostedVault.share();
        vm.prank(TRADER);
        uint256 boostedBought = loopBoostedMarket.buyToken{value: 0.05 ether}(0, TRADER);
        assertGt(boostedBought, 0);

        vm.prank(TRADER);
        boostedShare.approve(address(loopBoostedMarket), boostedBought);
        vm.prank(TRADER);
        uint256 boostedEthBack = loopBoostedMarket.sellToken(boostedBought, 0, TRADER);
        assertGt(boostedEthBack, 0);
        assertEq(boostedShare.balanceOf(TRADER), 0);
        assertEq(loopFirstN.balanceOf(address(loopBoostedVault)), 0.5 ether);
    }

    function _runSteadyRollWithSolverAndLp() internal {
        uint256 auctionId = loopSteadyKeeper.startRoll(loopSecondSeriesId, 1 ether, 1e18, 0.999e18, 1 days);
        uint256 solverQuote = loopRollAuction.quote(auctionId, 0.4 ether);

        vm.prank(SOLVER);
        uint256 solverPaid = loopRollSolver.mintAndFillWithCallback{value: solverQuote + 0.05 ether}(
            loopFactory, loopRollAuction, loopSecondSeriesId, auctionId, 0.4 ether, solverQuote, SOLVER
        );
        assertEq(solverPaid, solverQuote);

        vm.warp(block.timestamp + 4 hours);
        uint256 vaultQuote = loopRollAuction.quote(auctionId, 0.6 ether);
        vm.prank(KEEPER_CALLER);
        uint256 vaultPaid = loopLpKeeper.fillSteadyRoll(
            loopFactory,
            loopRollAuction,
            loopFirstSeriesId,
            loopSecondSeriesId,
            auctionId,
            0.6 ether,
            vaultQuote + 0.1 ether,
            vaultQuote
        );
        assertEq(vaultPaid, vaultQuote);
        require(!loopRollAuction.isActive(auctionId), "auction still active");

        loopSteadyKeeper.finalizeRoll();
        require(address(loopSteadyVault.currentToken()) == address(loopSecondP), "steady did not roll");
        require(!loopSteadyVault.rollActive(), "steady roll still active");
    }

    function _redeemTraderSteadyAfterRoll() internal {
        MintBurnToken steadyShare = loopSteadyVault.share();
        uint256 traderSecondPBefore = loopSecondP.balanceOf(TRADER);
        uint256 traderSteadyShares = steadyShare.balanceOf(TRADER);
        vm.prank(TRADER);
        uint256 redeemedSecondP = loopSteadyVault.redeem(traderSteadyShares, 0, TRADER);
        assertGt(redeemedSecondP, 0);
        assertEq(loopSecondP.balanceOf(TRADER), traderSecondPBefore + redeemedSecondP);
    }

    function _rejectBadLpInventorySaleThroughDirectMarket() internal {
        uint256 inventoryQuote = loopSecondNMarket.quoteSellToken(0.2 ether);
        vm.prank(KEEPER_CALLER);
        vm.expectRevert(EthLPVault.StrategyPolicyViolation.selector);
        loopLpKeeper.sellInventory(
            loopFactory, loopSecondSeriesId, true, loopSecondNMarket, 0.2 ether, inventoryQuote
        );
        require(loopLpVault.strategyActive(), "strategy should remain active after blocked inventory sale");
    }

    function _settleAndCloseLpInventoryDirectly() internal {
        vm.warp(block.timestamp + 60 days);
        loopOracle.setSettlementPrice(loopFirstSeriesId, 1_000e18);
        loopOracle.setSettlementPrice(loopSecondSeriesId, 1_000e18);
        loopFactory.settle(loopFirstSeriesId);
        loopFactory.settle(loopSecondSeriesId);

        uint256 firstPBalance = loopFirstP.balanceOf(address(loopLpVault));
        if (firstPBalance > 0) {
            vm.prank(KEEPER_CALLER);
            loopLpKeeper.redeemP(loopFactory, loopFirstSeriesId, firstPBalance);
        }

        uint256 secondPBalance = loopSecondP.balanceOf(address(loopLpVault));
        if (secondPBalance > 0) {
            vm.prank(KEEPER_CALLER);
            loopLpKeeper.redeemP(loopFactory, loopSecondSeriesId, secondPBalance);
        }

        uint256 secondNBalance = loopSecondN.balanceOf(address(loopLpVault));
        if (secondNBalance > 0) {
            vm.prank(KEEPER_CALLER);
            loopLpKeeper.redeemN(loopFactory, loopSecondSeriesId, secondNBalance);
        }

        vm.prank(KEEPER_CALLER);
        loopLpKeeper.closeStrategy();

        assertEq(loopLpVault.openInventorySeriesCount(), 0);
        require(!loopLpVault.strategyActive(), "strategy should close after direct cleanup");
        assertGt(loopLpVault.managedAssets(), 2 ether);
    }

    function _cacheLoopDeployment(DeployLocalMvp deployer) internal {
        (loopFactory, loopOracle, loopRollAuction, loopRollSolver, loopLpKeeper, loopLpVault) = deployer.core();
        (loopSteadyVault, loopBoostedVault, loopSteadyMarket, loopBoostedMarket) = deployer.products();
        (loopSteadyKeeper,) = deployer.wrapperKeepers();
        (loopFirstSeriesId, loopSecondSeriesId, loopFirstP, loopFirstN, loopSecondP, loopSecondN) = deployer.series();
        (,,, loopSecondNMarket) = deployer.inventoryMarkets();
    }

    function _assertOpenSeriesAccountingInvariant() internal view {
        uint256 firstCollateral = _assertOpenSeriesAccounting(loopFirstSeriesId);
        uint256 secondCollateral = _assertOpenSeriesAccounting(loopSecondSeriesId);
        assertEq(address(loopFactory).balance, firstCollateral + secondCollateral);
    }

    function _assertOpenSeriesAccounting(bytes32 seriesId) internal view returns (uint256 collateralEth) {
        (,,,, uint256 openInterestEth, uint256 storedCollateral, MintBurnToken pToken, MintBurnToken nToken,,,) =
            loopFactory.series(seriesId);

        assertEq(storedCollateral, openInterestEth);
        assertEq(pToken.totalSupply(), openInterestEth);
        assertEq(nToken.totalSupply(), openInterestEth);
        return storedCollateral;
    }

    function _config() internal view returns (DeployLocalMvp.Config memory config) {
        config = DeployLocalMvp.Config({
            strike: 1_000e18,
            firstMaturity: uint64(block.timestamp + 30 days),
            secondMaturity: uint64(block.timestamp + 60 days),
            twapWindow: 72 hours,
            capEth: 100 ether,
            withdrawDelay: 4 days,
            maxEthPerRoll: 1 ether,
            maxActiveStrategyEth: 3 ether,
            maxRollPriceWad: 1e18,
            minInventorySalePriceWad: 0.999e18,
            auctionGuardian: address(0),
            minAuctionDuration: 12 hours,
            minLpBackstopDelay: 4 hours,
            minLpAuctionTimeLeft: 6 hours,
            maxLpAuctionPriceDropBps: 10,
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

    function assertEq(address actual, address expected) internal pure {
        require(actual == expected, "address mismatch");
    }

    function assertGt(uint256 actual, uint256 minimum) internal pure {
        require(actual > minimum, "not greater");
    }
}
