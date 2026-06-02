// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DeployLocalMvp} from "../script/DeployLocalMvp.sol";
import {EthOptionsFactory} from "../src/EthOptionsFactory.sol";
import {RollAuction} from "../src/RollAuction.sol";
import {ProtocolHealthLens} from "../src/lens/ProtocolHealthLens.sol";
import {EthTokenAMM} from "../src/market/EthTokenAMM.sol";
import {MintBurnToken} from "../src/token/MintBurnToken.sol";
import {EthLPVault} from "../src/vault/EthLPVault.sol";
import {EthLPVaultKeeper} from "../src/vault/EthLPVaultKeeper.sol";
import {SeriesExposureVault} from "../src/vault/SeriesExposureVault.sol";
import {SeriesExposureVaultKeeper} from "../src/vault/SeriesExposureVaultKeeper.sol";

interface Vm {
    function deal(address account, uint256 amount) external;
    function warp(uint256 timestamp) external;
}

contract ProtocolHealthLensTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function testReadsSeededMarketVaultWrapperAndSeriesHealth() public {
        DeployLocalMvp deployer = _seededLocalDeployment();
        ProtocolHealthLens lens = deployer.healthLens();
        assertNonzero(address(lens));

        (EthOptionsFactory factory,,,,, EthLPVault lpVault) = deployer.core();
        (bytes32 firstSeriesId,, MintBurnToken firstP,,,) = deployer.series();
        (SeriesExposureVault steadyVault,, EthTokenAMM steadyMarket,) = deployer.products();

        ProtocolHealthLens.MarketHealth memory market = lens.marketHealth(steadyMarket, 0.1 ether, 0.1 ether);
        assertEq(market.market, address(steadyMarket));
        assertEq(market.token, address(steadyVault.share()));
        assertEq(market.ethReserve, 1.2 ether);
        assertEq(market.tokenReserve, 1 ether);
        require(market.hasLiquidity, "missing liquidity");
        require(market.sampleBuyTokenOut > 0, "missing buy quote");
        require(market.sampleSellEthOut > 0, "missing sell quote");

        ProtocolHealthLens.LpVaultHealth memory lp = lens.lpVaultHealth(lpVault);
        assertEq(lp.vault, address(lpVault));
        assertEq(lp.managedAssets, 0);
        assertEq(lp.maxActiveStrategyEth, 3 ether);
        assertEq(lp.minBackstopDelay, 4 hours);
        assertEq(lp.minAuctionTimeLeft, 6 hours);
        assertEq(lp.maxAuctionPriceDropBps, 10);
        assertEq(lp.minInventorySalePriceWad, 0.999e18);
        assertEq(lp.strategyUtilizationBps, 0);
        assertEq(lp.totalShares, 0);
        assertEq(lp.sharePriceWad, 1e18);
        assertEq(lp.inventoryMarketsLength, 0);
        assertEq(lp.openInventorySeriesCount, 0);
        assertEq(lp.openInventoryMarketCount, 0);
        require(!lp.depositsPaused, "lp deposits paused");

        ProtocolHealthLens.WrapperHealth memory wrapper = lens.wrapperHealth(steadyVault);
        assertEq(wrapper.vault, address(steadyVault));
        assertEq(wrapper.share, address(steadyVault.share()));
        assertEq(wrapper.currentToken, address(firstP));
        assertEq(wrapper.totalAssets, 1 ether);
        assertEq(wrapper.maxAssets, 5 ether);
        assertEq(wrapper.remainingCapacity, 4 ether);
        require(!wrapper.rollActive, "wrapper rolling");
        require(!wrapper.depositsPaused, "wrapper deposits paused");

        ProtocolHealthLens.SeriesHealth memory series = lens.seriesHealth(factory, firstSeriesId);
        assertEq(series.seriesId, firstSeriesId);
        assertEq(series.factory, address(factory));
        assertEq(series.pToken, address(firstP));
        assertEq(series.openInterestEth, 1 ether);
        assertEq(series.capEth, 100 ether);
        assertEq(series.capUsedBps, 100);
        require(!series.matured, "series mature");
    }

    function testReadsAuctionAndWrapperKeeperPolicyHealth() public {
        DeployLocalMvp deployer = _seededLocalDeployment();
        ProtocolHealthLens lens = deployer.healthLens();
        (,, RollAuction rollAuction,,,) = deployer.core();
        (bytes32 firstSeriesId,,,,,) = deployer.series();
        (SeriesExposureVaultKeeper steadyKeeper, SeriesExposureVaultKeeper boostedKeeper) = deployer.wrapperKeepers();

        ProtocolHealthLens.AuctionPolicyHealth memory auctionPolicy = lens.auctionPolicyHealth(rollAuction);
        assertEq(auctionPolicy.auction, address(rollAuction));
        assertEq(auctionPolicy.guardian, address(0));
        assertEq(auctionPolicy.stopped, 0);
        assertEq(auctionPolicy.minSellAmount, 0.01 ether);
        assertEq(auctionPolicy.minStaleResetDelay, 12 hours);
        assertEq(auctionPolicy.minStaleResetPriceDropBps, 5);
        assertEq(auctionPolicy.activeAuctionCount, 0);
        assertEq(auctionPolicy.maxActiveAuctions, 16);
        assertEq(auctionPolicy.maxActiveAuctionsPerSeller, 4);
        require(!auctionPolicy.newAuctionsPaused, "new auctions paused");
        require(!auctionPolicy.resetsPaused, "resets paused");
        require(!auctionPolicy.fillsPaused, "fills paused");

        ProtocolHealthLens.WrapperKeeperHealth memory steady = lens.wrapperKeeperHealth(steadyKeeper);
        assertEq(steady.keeper, address(steadyKeeper));
        assertEq(steady.auction, address(rollAuction));
        assertEq(steady.currentSeriesId, firstSeriesId);
        assertEq(steady.minRollSellAmount, 0.01 ether);
        assertEq(steady.maxRollSellAmount, 5 ether);
        assertEq(steady.maxStartPriceWad, 1e18);
        assertEq(steady.minEndPriceWad, 0.999e18);
        require(steady.vaultSet, "steady vault unset");
        require(!steady.boostedSide, "steady side mismatch");
        require(!steady.rollPending, "steady roll pending");

        ProtocolHealthLens.WrapperKeeperHealth memory boosted = lens.wrapperKeeperHealth(boostedKeeper);
        assertEq(boosted.minEndPriceWad, 0.999e18);
        require(boosted.boostedSide, "boosted side mismatch");
    }

    function testReadsActiveWrapperRollAndAuctionHealth() public {
        DeployLocalMvp deployer = _seededLocalDeployment();
        ProtocolHealthLens lens = deployer.healthLens();

        (,, RollAuction rollAuction,,,) = deployer.core();
        (bytes32 firstSeriesId, bytes32 secondSeriesId,,,,) = deployer.series();
        (SeriesExposureVault steadyVault,,,) = deployer.products();
        (SeriesExposureVaultKeeper steadyKeeper,) = deployer.wrapperKeepers();

        uint256 auctionId = steadyKeeper.startRoll(secondSeriesId, 1 ether, 1e18, 0.999e18, 1 days);

        ProtocolHealthLens.WrapperHealth memory wrapper = lens.wrapperHealth(steadyVault);
        require(wrapper.rollActive, "wrapper not rolling");
        assertEq(wrapper.rollAuction, address(rollAuction));
        assertEq(wrapper.rollAuctionId, auctionId);
        assertNonzero(wrapper.rollNextToken);
        require(!wrapper.depositsPaused, "wrapper deposits growth-paused");

        ProtocolHealthLens.AuctionHealth memory auction = lens.auctionHealth(rollAuction, auctionId);
        assertEq(auction.auction, address(rollAuction));
        assertEq(auction.auctionId, auctionId);
        assertEq(auction.seller, address(steadyVault));
        assertEq(auction.beneficiary, address(steadyVault));
        assertEq(auction.remainingSellAmount, 1 ether);
        assertEq(auction.startPriceWad, 1e18);
        assertEq(auction.endPriceWad, 0.999e18);
        assertEq(auction.currentPriceWad, 1e18);
        assertEq(auction.resetPriceDropBps, 0);
        require(auction.open, "auction not open");
        require(auction.active, "auction not active");
        require(!auction.resetEligible, "fresh auction reset eligible");
        require(!auction.cancelled, "auction cancelled");

        vm.warp(block.timestamp + 13 hours);
        ProtocolHealthLens.AuctionHealth memory staleAuction = lens.auctionHealth(rollAuction, auctionId);
        require(staleAuction.resetPriceStale, "auction should be price stale");
        require(staleAuction.resetEligible, "auction should be reset eligible");

        ProtocolHealthLens.SeriesHealth memory firstSeries = lens.seriesHealth(_factory(deployer), firstSeriesId);
        assertEq(firstSeries.seriesId, firstSeriesId);
    }

    function testReadsWrapperDepositPauseAfterCancelledRoll() public {
        DeployLocalMvp deployer = _seededLocalDeployment();
        ProtocolHealthLens lens = deployer.healthLens();
        (, bytes32 secondSeriesId,,,,) = deployer.series();
        (SeriesExposureVault steadyVault,,,) = deployer.products();
        (SeriesExposureVaultKeeper steadyKeeper,) = deployer.wrapperKeepers();

        steadyKeeper.startRoll(secondSeriesId, 1 ether, 1e18, 0.999e18, 1 days);
        vm.warp(block.timestamp + 1 days + 1);
        steadyKeeper.cancelUnfilledRoll();

        ProtocolHealthLens.WrapperHealth memory wrapper = lens.wrapperHealth(steadyVault);
        require(wrapper.depositsPaused, "wrapper deposits not paused");
        assertEq(wrapper.remainingCapacity, 0);
        assertEq(wrapper.totalAssets, 1 ether);
        require(!wrapper.rollActive, "wrapper still rolling");
    }

    function testReadsLpVaultInventoryHealth() public {
        DeployLocalMvp deployer = _seededLocalDeployment();
        ProtocolHealthLens lens = deployer.healthLens();

        (
            EthOptionsFactory factory,
            ,
            RollAuction rollAuction,
            ,
            EthLPVaultKeeper lpKeeper,
            EthLPVault lpVault
        ) = deployer.core();
        (bytes32 firstSeriesId, bytes32 secondSeriesId,,,,) = deployer.series();
        (SeriesExposureVaultKeeper steadyKeeper,) = deployer.wrapperKeepers();

        vm.deal(address(this), 2 ether);
        lpVault.deposit{value: 2 ether}();
        ProtocolHealthLens.LpAccountHealth memory accountBefore = lens.lpAccountHealth(lpVault, address(this));
        assertEq(accountBefore.vault, address(lpVault));
        assertEq(accountBefore.account, address(this));
        assertEq(accountBefore.share, address(lpVault.share()));
        assertEq(accountBefore.shareBalance, 2 ether);
        assertEq(accountBefore.claimableAssets, 2 ether);
        assertEq(accountBefore.pendingWithdrawAssets, 0);
        require(accountBefore.hasPosition, "account position missing");

        uint256 auctionId = steadyKeeper.startRoll(secondSeriesId, 1 ether, 1e18, 0.999e18, 1 days);

        vm.warp(block.timestamp + 12 hours);
        lpKeeper.fillSteadyRoll(
            factory, rollAuction, firstSeriesId, secondSeriesId, auctionId, 0.5 ether, 0.6 ether, 0.5 ether
        );

        ProtocolHealthLens.LpVaultHealth memory vault = lens.lpVaultHealth(lpVault);
        assertEq(vault.inventorySeriesLength, 2);
        assertEq(vault.openInventorySeriesCount, 2);
        assertEq(vault.totalShares, 2 ether);
        assertEq(vault.sharePriceWad, 0.7e18);
        require(vault.strategyActive, "strategy inactive");
        require(vault.depositsPaused, "lp deposits should pause");

        ProtocolHealthLens.LpInventoryHealth memory oldSeries = lens.lpInventoryHealth(lpVault, 0);
        assertEq(oldSeries.vault, address(lpVault));
        assertEq(oldSeries.index, 0);
        assertEq(oldSeries.factory, address(factory));
        assertEq(oldSeries.seriesId, firstSeriesId);
        assertEq(oldSeries.pBalance, 0.5 ether);
        assertEq(oldSeries.nBalance, 0);
        assertEq(oldSeries.unpairedP, 0.5 ether);
        require(oldSeries.hasInventory, "old inventory missing");
        require(!oldSeries.matured, "old series mature");

        ProtocolHealthLens.LpInventoryHealth memory newSeries = lens.lpInventoryHealth(lpVault, 1);
        assertEq(newSeries.seriesId, secondSeriesId);
        assertEq(newSeries.pBalance, 0.10025 ether);
        assertEq(newSeries.nBalance, 0.6 ether);
        assertEq(newSeries.mergeableAmount, 0.10025 ether);
        assertEq(newSeries.unpairedN, 0.49975 ether);
        require(newSeries.hasInventory, "new inventory missing");
    }

    function testReadsLpVaultMarketLiquidityHealth() public {
        DeployLocalMvp deployer = _seededLocalDeployment();
        ProtocolHealthLens lens = deployer.healthLens();
        (,,,,, EthLPVault lpVault) = deployer.core();

        {
            (
                EthOptionsFactory factory,
                ,
                RollAuction rollAuction,
                ,
                EthLPVaultKeeper lpKeeper,
            ) = deployer.core();
            (bytes32 firstSeriesId, bytes32 secondSeriesId,,,,) = deployer.series();
            (,,, EthTokenAMM secondNMarket) = deployer.inventoryMarkets();
            (SeriesExposureVaultKeeper steadyKeeper,) = deployer.wrapperKeepers();

            vm.deal(address(this), 4 ether);
            lpVault.deposit{value: 2 ether}();
            uint256 auctionId = steadyKeeper.startRoll(secondSeriesId, 1 ether, 1e18, 0.999e18, 1 days);

            vm.warp(block.timestamp + 12 hours);
            lpKeeper.fillSteadyRoll(
                factory, rollAuction, firstSeriesId, secondSeriesId, auctionId, 0.5 ether, 0.6 ether, 0.5 ether
            );

            deployer.seedInventoryMarket{value: 2 ether}(true, true, 1 ether, 1 ether, address(this));
            lpKeeper.addInventoryLiquidity(factory, secondSeriesId, true, secondNMarket, 0.1 ether, 0.1 ether, 0);
        }

        ProtocolHealthLens.LpVaultHealth memory vaultHealth = lens.lpVaultHealth(lpVault);
        assertEq(vaultHealth.inventoryMarketsLength, 1);
        assertEq(vaultHealth.openInventoryMarketCount, 1);

        ProtocolHealthLens.LpMarketLiquidityHealth memory market = lens.lpMarketLiquidityHealth(lpVault, 0);
        assertEq(market.vault, address(lpVault));
        assertEq(market.index, 0);
        assertEq(market.vaultMarketShares, 0.1 ether);
        require(market.hasMarketLiquidity, "missing market liquidity");
        require(market.hasVaultLiquidity, "missing vault market liquidity");
    }

    function testReadsLpAccountPendingWithdrawalHealth() public {
        DeployLocalMvp deployer = _seededLocalDeployment();
        ProtocolHealthLens lens = deployer.healthLens();
        (,,,,, EthLPVault lpVault) = deployer.core();

        vm.deal(address(this), 2 ether);
        lpVault.deposit{value: 2 ether}();
        lpVault.requestWithdraw(0.75 ether);

        ProtocolHealthLens.LpAccountHealth memory pending = lens.lpAccountHealth(lpVault, address(this));
        assertEq(pending.shareBalance, 1.25 ether);
        assertEq(pending.claimableAssets, 1.25 ether);
        assertEq(pending.pendingWithdrawAssets, 0.75 ether);
        require(!pending.pendingClaimable, "pending early");
        require(pending.pendingUnlockAt > block.timestamp, "unlock missing");

        vm.warp(pending.pendingUnlockAt);
        ProtocolHealthLens.LpAccountHealth memory claimable = lens.lpAccountHealth(lpVault, address(this));
        require(claimable.pendingClaimable, "pending not claimable");
    }

    function _seededLocalDeployment() internal returns (DeployLocalMvp deployer) {
        deployer = new DeployLocalMvp();
        deployer.deployDefault();
        deployer.seedMarkets{value: 3.5 ether}(1 ether, 0.5 ether, 1.2 ether, 1.3 ether, address(0xBEEF));
    }

    function _factory(DeployLocalMvp deployer) internal view returns (EthOptionsFactory factory) {
        (factory,,,,,) = deployer.core();
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

    function assertEq(bytes32 actual, bytes32 expected) internal pure {
        require(actual == expected, "bytes32 mismatch");
    }
}
