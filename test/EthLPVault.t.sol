// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EthOptionsFactory} from "../src/EthOptionsFactory.sol";
import {RollAuction, IERC20Like} from "../src/RollAuction.sol";
import {MockSettlementOracle} from "../src/oracle/MockSettlementOracle.sol";
import {EthTokenAMM} from "../src/market/EthTokenAMM.sol";
import {EthLPVault} from "../src/vault/EthLPVault.sol";
import {SeriesExposureVault} from "../src/vault/SeriesExposureVault.sol";
import {MintBurnToken} from "../src/token/MintBurnToken.sol";

interface Vm {
    function deal(address account, uint256 amount) external;
    function prank(address account) external;
    function warp(uint256 timestamp) external;
    function expectRevert(bytes4 selector) external;
}

contract VaultTestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertEq(uint256 actual, uint256 expected) internal pure {
        require(actual == expected, "uint mismatch");
    }

    function assertGt(uint256 actual, uint256 minimum) internal pure {
        require(actual > minimum, "not greater");
    }

    function assertEq(address actual, address expected) internal pure {
        require(actual == expected, "address mismatch");
    }
}

contract EthLPVaultTest is VaultTestBase {
    EthLPVault internal vault;
    EthOptionsFactory internal factory;
    MockSettlementOracle internal oracle;
    RollAuction internal auction;
    bytes32 internal oldSeriesId;
    bytes32 internal newSeriesId;
    MintBurnToken internal oldP;
    MintBurnToken internal oldN;
    MintBurnToken internal newP;
    MintBurnToken internal newN;

    address internal alice = address(0xA11CE);
    address internal steadyVault = address(0x5757);
    address internal boostedVault = address(0xB0057);
    address internal marketMaker = address(0xD00D);

    uint256 internal constant STRIKE = 1_000e18;
    uint32 internal constant TWAP_WINDOW = 72 hours;
    uint256 internal constant CAP = 100 ether;
    uint64 internal constant OLD_MATURITY = 30 days;
    uint64 internal constant NEW_MATURITY = 60 days;
    uint256 internal constant MAX_ETH_PER_ROLL = 1 ether;
    uint256 internal constant MAX_ACTIVE_STRATEGY_ETH = 1.2 ether;
    uint256 internal constant MAX_ROLL_PRICE = 1.05e18;
    uint256 internal constant MIN_INVENTORY_SALE_PRICE = 0.95e18;
    uint64 internal constant MIN_AUCTION_DURATION = 12 hours;
    uint64 internal constant MIN_BACKSTOP_DELAY = 4 hours;
    uint64 internal constant MIN_AUCTION_TIME_LEFT = 6 hours;
    uint16 internal constant MAX_AUCTION_PRICE_DROP_BPS = 200;
    uint16 internal constant PRODUCT_TRADE_FEE_BPS = 30;

    function setUp() public {
        vault = new EthLPVault(
            address(this),
            4 days,
            MAX_ETH_PER_ROLL,
            MAX_ACTIVE_STRATEGY_ETH,
            MAX_ROLL_PRICE,
            MIN_INVENTORY_SALE_PRICE,
            MIN_AUCTION_DURATION,
            MIN_BACKSTOP_DELAY,
            MIN_AUCTION_TIME_LEFT,
            MAX_AUCTION_PRICE_DROP_BPS,
            PRODUCT_TRADE_FEE_BPS
        );
        factory = new EthOptionsFactory();
        oracle = new MockSettlementOracle();
        auction = new RollAuction(address(this), 0.01 ether, 16, 4);
        oldSeriesId = factory.createSeries(STRIKE, uint64(block.timestamp + OLD_MATURITY), TWAP_WINDOW, CAP, oracle);
        newSeriesId = factory.createSeries(STRIKE, uint64(block.timestamp + NEW_MATURITY), TWAP_WINDOW, CAP, oracle);
        (oldP, oldN) = _tokens(oldSeriesId);
        (newP, newN) = _tokens(newSeriesId);

        vm.deal(alice, 10 ether);
        vm.deal(steadyVault, 10 ether);
        vm.deal(boostedVault, 10 ether);
        vm.deal(marketMaker, 20 ether);
    }

    function testDepositMintsEthShares() public {
        vm.prank(alice);
        vault.deposit{value: 1 ether}();

        MintBurnToken share = vault.share();
        assertEq(share.balanceOf(alice), 1 ether);
        assertEq(vault.managedAssets(), 1 ether);
    }

    function testWithdrawRequiresUnlockDelay() public {
        vm.prank(alice);
        vault.deposit{value: 1 ether}();

        vm.prank(alice);
        vault.requestWithdraw(0.4 ether);

        assertEq(vault.reservedEth(), 0.4 ether);
        assertEq(vault.managedAssets(), 0.6 ether);

        vm.prank(alice);
        vm.expectRevert(EthLPVault.WithdrawNotReady.selector);
        vault.claimWithdraw();

        uint256 balanceBefore = alice.balance;
        vm.warp(block.timestamp + 4 days);
        vm.prank(alice);
        vault.claimWithdraw();

        assertEq(alice.balance, balanceBefore + 0.4 ether);
        assertEq(vault.reservedEth(), 0);
    }

    function testManagerCanFillSteadyRollWithVaultEth() public {
        _depositFromAlice(2 ether);
        uint256 auctionId = _createOldPAuction(1 ether);

        vm.warp(block.timestamp + 12 hours);
        uint256 newPPaid = vault.fillSteadyRoll(
            factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.6 ether, 0.5 ether
        );

        assertEq(newPPaid, 0.5 ether);
        assertEq(vault.strategyActive() ? 1 : 0, 1);
        assertEq(vault.managedAssets(), 1.4 ether);
        assertEq(oldP.balanceOf(address(vault)), 0.5 ether);
        assertEq(newP.balanceOf(address(vault)), 0.1 ether);
        assertEq(newN.balanceOf(address(vault)), 0.6 ether);
        assertEq(newP.balanceOf(steadyVault), 0.5 ether);
        assertEq(vault.inventorySeriesLength(), 2);
        assertEq(vault.openInventorySeriesCount(), 2);
    }

    function testManagerCanFillBoostedRollWithVaultEth() public {
        _depositFromAlice(2 ether);
        uint256 auctionId = _createOldNAuction(1 ether);

        vm.warp(block.timestamp + 12 hours);
        uint256 newNPaid = vault.fillBoostedRoll(
            factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.6 ether, 0.5 ether
        );

        assertEq(newNPaid, 0.5 ether);
        assertEq(vault.strategyActive() ? 1 : 0, 1);
        assertEq(vault.managedAssets(), 1.4 ether);
        assertEq(oldN.balanceOf(address(vault)), 0.5 ether);
        assertEq(newP.balanceOf(address(vault)), 0.6 ether);
        assertEq(newN.balanceOf(address(vault)), 0.1 ether);
        assertEq(newN.balanceOf(boostedVault), 0.5 ether);
        assertEq(vault.inventorySeriesLength(), 2);
        assertEq(vault.openInventorySeriesCount(), 2);
    }

    function testManagerCanSellTrackedInventoryThroughPublicAmm() public {
        _depositFromAlice(2 ether);
        uint256 auctionId = _createOldPAuction(1 ether);

        vm.warp(block.timestamp + 12 hours);
        vault.fillSteadyRoll(factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.6 ether, 0.5 ether);

        EthTokenAMM market = _seedMarket(newN, "newN direct market", "newN-LP");
        uint256 quote = market.quoteSellToken(0.2 ether);
        uint256 managedBefore = vault.managedAssets();

        uint256 ethOut = vault.sellInventory(factory, newSeriesId, true, market, 0.2 ether, quote);

        assertEq(ethOut, quote);
        assertEq(vault.managedAssets(), managedBefore + quote);
        assertEq(newN.balanceOf(address(vault)), 0.4 ether);
        assertEq(vault.openInventorySeriesCount(), 2);
    }

    function testManagerCanProvideTrackedInventoryAsPublicAmmLiquidity() public {
        _depositFromAlice(2 ether);
        uint256 auctionId = _createOldPAuction(1 ether);

        vm.warp(block.timestamp + 12 hours);
        vault.fillSteadyRoll(factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.6 ether, 0.5 ether);

        EthTokenAMM market = _seedMarket(newN, "newN direct market", "newN-LP");
        uint256 managedBefore = vault.managedAssets();
        (uint256 shares, uint256 ethIn, uint256 tokenIn) =
            vault.addInventoryLiquidity(factory, newSeriesId, true, market, 0.2 ether, 0.2 ether, 0.2 ether);

        assertEq(shares, 0.2 ether);
        assertEq(ethIn, 0.2 ether);
        assertEq(tokenIn, 0.2 ether);
        assertEq(vault.managedAssets(), managedBefore - 0.2 ether);
        assertEq(vault.activeStrategyEth(), 0.8 ether);
        assertEq(vault.inventoryMarketsLength(), 1);
        assertEq(vault.openInventoryMarketCount(), 1);
        assertEq(market.lpToken().balanceOf(address(vault)), 0.2 ether);
        assertEq(newN.balanceOf(address(vault)), 0.4 ether);

        vm.expectRevert(EthLPVault.InventoryOpen.selector);
        vault.closeStrategy();

        (uint256 ethOut, uint256 tokenOut) =
            vault.removeInventoryLiquidity(factory, newSeriesId, true, market, shares, 0.2 ether, 0.2 ether);

        assertEq(ethOut, 0.2 ether);
        assertEq(tokenOut, 0.2 ether);
        assertEq(vault.openInventoryMarketCount(), 0);
        assertEq(market.lpToken().balanceOf(address(vault)), 0);
        assertEq(newN.balanceOf(address(vault)), 0.6 ether);
    }

    function testInventoryLiquidityRejectsUnseededOrBadPriceMarket() public {
        _depositFromAlice(2 ether);
        uint256 auctionId = _createOldPAuction(1 ether);

        vm.warp(block.timestamp + 12 hours);
        vault.fillSteadyRoll(factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.6 ether, 0.5 ether);

        EthTokenAMM emptyMarket = new EthTokenAMM(IERC20Like(address(newN)), "empty newN market", "emptyN-LP", 30);
        vm.expectRevert(EthLPVault.MarketLiquidityMissing.selector);
        vault.addInventoryLiquidity(factory, newSeriesId, true, emptyMarket, 0.2 ether, 0.2 ether, 0);

        EthTokenAMM badMarket = _seedBadMarket(newN, "bad newN liquidity market", "badN-LP");
        vm.expectRevert(EthLPVault.StrategyPolicyViolation.selector);
        vault.addInventoryLiquidity(factory, newSeriesId, true, badMarket, 0.2 ether, 0.2 ether, 0);
    }

    function testInventoryLiquidityRejectsEthAbovePerActionLimit() public {
        EthLPVault riskVault = new EthLPVault(
            address(this),
            4 days,
            MAX_ETH_PER_ROLL,
            5 ether,
            MAX_ROLL_PRICE,
            MIN_INVENTORY_SALE_PRICE,
            MIN_AUCTION_DURATION,
            MIN_BACKSTOP_DELAY,
            MIN_AUCTION_TIME_LEFT,
            MAX_AUCTION_PRICE_DROP_BPS,
            PRODUCT_TRADE_FEE_BPS
        );
        vm.prank(alice);
        riskVault.deposit{value: 4 ether}();
        uint256 auctionId = _createOldPAuction(1 ether);

        vm.warp(block.timestamp + 12 hours);
        riskVault.fillSteadyRoll(
            factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.6 ether, 0.5 ether
        );

        EthTokenAMM market = _seedMarket(newN, "newN direct market", "newN-LP");

        vm.expectRevert(EthLPVault.StrategyPolicyViolation.selector);
        riskVault.addInventoryLiquidity(factory, newSeriesId, true, market, 0.2 ether, MAX_ETH_PER_ROLL + 1, 0);
    }

    function testUserCanBuySteadyFromLpVaultWithEth() public {
        _depositFromAlice(2 ether);
        SeriesExposureVault steady = new SeriesExposureVault(oldP, address(this), "Steady ETH", "steadyETH", 5 ether);

        vm.prank(alice);
        uint256 sharesOut = vault.buySteady{value: 0.5 ether}(factory, oldSeriesId, steady, 0.498 ether, alice);

        assertEq(sharesOut, 0.4985 ether);
        assertEq(steady.share().balanceOf(alice), 0.4985 ether);
        assertEq(steady.totalAssets(), 0.4985 ether);
        assertEq(oldN.balanceOf(address(vault)), 0.4985 ether);
        assertEq(vault.activeStrategyEth(), 0.4985 ether);
        assertEq(vault.managedAssets(), 2.0015 ether);
    }

    function testUserCanSellSteadyBackToLpVaultForEth() public {
        _depositFromAlice(2 ether);
        SeriesExposureVault steady = new SeriesExposureVault(oldP, address(this), "Steady ETH", "steadyETH", 5 ether);

        vm.prank(alice);
        uint256 sharesOut = vault.buySteady{value: 0.5 ether}(factory, oldSeriesId, steady, 0, alice);

        MintBurnToken steadyShare = steady.share();
        vm.prank(alice);
        steadyShare.approve(address(vault), sharesOut);

        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        uint256 ethOut = vault.sellSteady(factory, oldSeriesId, steady, sharesOut, 0.497 ether, alice);

        assertEq(ethOut, 0.4970045 ether);
        assertEq(alice.balance, aliceBefore + ethOut);
        assertEq(steadyShare.balanceOf(alice), 0);
        assertEq(oldP.balanceOf(address(vault)), 0.4985 ether);
        assertEq(vault.activeStrategyEth(), 0.997 ether);
    }

    function testUserCanBuyBoostedFromLpVaultWithEth() public {
        _depositFromAlice(2 ether);
        SeriesExposureVault boosted =
            new SeriesExposureVault(oldN, address(this), "Boosted ETH", "boostedETH", 5 ether);

        vm.prank(alice);
        uint256 sharesOut = vault.buyBoosted{value: 0.5 ether}(factory, oldSeriesId, boosted, 0.498 ether, alice);

        assertEq(sharesOut, 0.4985 ether);
        assertEq(boosted.share().balanceOf(alice), 0.4985 ether);
        assertEq(boosted.totalAssets(), 0.4985 ether);
        assertEq(oldP.balanceOf(address(vault)), 0.4985 ether);
        assertEq(vault.activeStrategyEth(), 0.4985 ether);
        assertEq(vault.managedAssets(), 2.0015 ether);
    }

    function testUserCanSellBoostedBackToLpVaultForEth() public {
        _depositFromAlice(2 ether);
        SeriesExposureVault boosted =
            new SeriesExposureVault(oldN, address(this), "Boosted ETH", "boostedETH", 5 ether);

        vm.prank(alice);
        uint256 sharesOut = vault.buyBoosted{value: 0.5 ether}(factory, oldSeriesId, boosted, 0, alice);

        MintBurnToken boostedShare = boosted.share();
        vm.prank(alice);
        boostedShare.approve(address(vault), sharesOut);

        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        uint256 ethOut = vault.sellBoosted(factory, oldSeriesId, boosted, sharesOut, 0.497 ether, alice);

        assertEq(ethOut, 0.4970045 ether);
        assertEq(alice.balance, aliceBefore + ethOut);
        assertEq(boostedShare.balanceOf(alice), 0);
        assertEq(oldP.balanceOf(address(vault)), 0.4985 ether);
        assertEq(oldN.balanceOf(address(vault)), 0.4985 ether);
        assertEq(vault.activeStrategyEth(), 0.997 ether);
    }

    function testVaultBackedProductQuotesMatchExecution() public {
        _depositFromAlice(2 ether);
        SeriesExposureVault steady = new SeriesExposureVault(oldP, address(this), "Steady ETH", "steadyETH", 5 ether);
        SeriesExposureVault boosted =
            new SeriesExposureVault(oldN, address(this), "Boosted ETH", "boostedETH", 5 ether);

        uint256 steadyBuyQuote = vault.quoteBuyProduct(steady, 0.5 ether);
        uint256 boostedBuyQuote = vault.quoteBuyProduct(boosted, 0.25 ether);
        assertEq(steadyBuyQuote, 0.4985 ether);
        assertEq(boostedBuyQuote, 0.24925 ether);

        vm.prank(alice);
        uint256 steadyShares = vault.buySteady{value: 0.5 ether}(factory, oldSeriesId, steady, steadyBuyQuote, alice);
        vm.prank(alice);
        uint256 boostedShares =
            vault.buyBoosted{value: 0.25 ether}(factory, oldSeriesId, boosted, boostedBuyQuote, alice);

        assertEq(steadyShares, steadyBuyQuote);
        assertEq(boostedShares, boostedBuyQuote);

        (uint256 steadyEthOut, uint256 steadyFeeEth, uint256 steadyProductAmount) =
            vault.quoteSellProduct(steady, steadyShares);
        (uint256 boostedEthOut, uint256 boostedFeeEth, uint256 boostedProductAmount) =
            vault.quoteSellProduct(boosted, boostedShares);

        assertEq(steadyProductAmount, 0.4985 ether);
        assertEq(steadyFeeEth, 0.0014955 ether);
        assertEq(steadyEthOut, 0.4970045 ether);
        assertEq(boostedProductAmount, 0.24925 ether);
        assertEq(boostedFeeEth, 0.00074775 ether);
        assertEq(boostedEthOut, 0.24850225 ether);
    }

    function testVaultBackedProductTradesRespectSlippageLimits() public {
        _depositFromAlice(2 ether);
        SeriesExposureVault steady = new SeriesExposureVault(oldP, address(this), "Steady ETH", "steadyETH", 5 ether);

        vm.prank(alice);
        vm.expectRevert(SeriesExposureVault.Slippage.selector);
        vault.buySteady{value: 0.5 ether}(factory, oldSeriesId, steady, 0.499 ether, alice);

        vm.prank(alice);
        uint256 sharesOut = vault.buySteady{value: 0.5 ether}(factory, oldSeriesId, steady, 0, alice);

        MintBurnToken steadyShare = steady.share();
        vm.prank(alice);
        steadyShare.approve(address(vault), sharesOut);

        vm.prank(alice);
        vm.expectRevert(EthLPVault.Slippage.selector);
        vault.sellSteady(factory, oldSeriesId, steady, sharesOut, 0.498 ether, alice);
    }

    function testVaultBackedProductTradesRespectStrategyCaps() public {
        _depositFromAlice(3 ether);
        SeriesExposureVault steady = new SeriesExposureVault(oldP, address(this), "Steady ETH", "steadyETH", 5 ether);

        vm.prank(alice);
        vm.expectRevert(EthLPVault.StrategyPolicyViolation.selector);
        vault.buySteady{value: 1.1 ether}(factory, oldSeriesId, steady, 0, alice);

        vm.prank(alice);
        vault.buySteady{value: 0.9 ether}(factory, oldSeriesId, steady, 0, alice);

        vm.prank(alice);
        vm.expectRevert(EthLPVault.StrategyPolicyViolation.selector);
        vault.buySteady{value: 0.4 ether}(factory, oldSeriesId, steady, 0, alice);
    }

    function testVaultCanMergeAndCloseInventoryAfterSteadyProductRoundTrip() public {
        _depositFromAlice(2 ether);
        SeriesExposureVault steady = new SeriesExposureVault(oldP, address(this), "Steady ETH", "steadyETH", 5 ether);

        vm.prank(alice);
        uint256 sharesOut = vault.buySteady{value: 0.5 ether}(factory, oldSeriesId, steady, 0, alice);

        MintBurnToken steadyShare = steady.share();
        vm.prank(alice);
        steadyShare.approve(address(vault), sharesOut);
        vm.prank(alice);
        vault.sellSteady(factory, oldSeriesId, steady, sharesOut, 0, alice);

        assertEq(vault.strategyActive() ? 1 : 0, 1);
        assertEq(vault.openInventorySeriesCount(), 1);
        assertEq(oldP.balanceOf(address(vault)), 0.4985 ether);
        assertEq(oldN.balanceOf(address(vault)), 0.4985 ether);

        vm.expectRevert(EthLPVault.InventoryOpen.selector);
        vault.closeStrategy();

        vault.mergeSeries(factory, oldSeriesId, 0.4985 ether);
        assertEq(vault.openInventorySeriesCount(), 0);
        assertEq(oldP.balanceOf(address(vault)), 0);
        assertEq(oldN.balanceOf(address(vault)), 0);

        vault.closeStrategy();
        assertEq(vault.strategyActive() ? 1 : 0, 0);
        assertEq(vault.activeStrategyEth(), 0);
        assertEq(vault.managedAssets(), 2.0029955 ether);
    }

    function testVaultCanMergeAndCloseInventoryAfterBoostedProductRoundTrip() public {
        _depositFromAlice(2 ether);
        SeriesExposureVault boosted =
            new SeriesExposureVault(oldN, address(this), "Boosted ETH", "boostedETH", 5 ether);

        vm.prank(alice);
        uint256 sharesOut = vault.buyBoosted{value: 0.5 ether}(factory, oldSeriesId, boosted, 0, alice);

        MintBurnToken boostedShare = boosted.share();
        vm.prank(alice);
        boostedShare.approve(address(vault), sharesOut);
        vm.prank(alice);
        vault.sellBoosted(factory, oldSeriesId, boosted, sharesOut, 0, alice);

        assertEq(vault.strategyActive() ? 1 : 0, 1);
        assertEq(vault.openInventorySeriesCount(), 1);
        assertEq(oldP.balanceOf(address(vault)), 0.4985 ether);
        assertEq(oldN.balanceOf(address(vault)), 0.4985 ether);

        vm.expectRevert(EthLPVault.InventoryOpen.selector);
        vault.closeStrategy();

        vault.mergeSeries(factory, oldSeriesId, 0.4985 ether);
        assertEq(vault.openInventorySeriesCount(), 0);
        assertEq(oldP.balanceOf(address(vault)), 0);
        assertEq(oldN.balanceOf(address(vault)), 0);

        vault.closeStrategy();
        assertEq(vault.strategyActive() ? 1 : 0, 0);
        assertEq(vault.activeStrategyEth(), 0);
        assertEq(vault.managedAssets(), 2.0029955 ether);
    }

    function testUserProductTradeRejectsWrongWrapperSide() public {
        _depositFromAlice(2 ether);
        SeriesExposureVault boosted = new SeriesExposureVault(oldN, address(this), "Boosted ETH", "boostedETH", 5 ether);

        vm.prank(alice);
        vm.expectRevert(EthLPVault.ProductTokenMismatch.selector);
        vault.buySteady{value: 0.5 ether}(factory, oldSeriesId, boosted, 0, alice);
    }

    function testInventorySaleRejectsBelowVaultPriceFloor() public {
        _depositFromAlice(2 ether);
        uint256 auctionId = _createOldPAuction(1 ether);

        vm.warp(block.timestamp + 12 hours);
        vault.fillSteadyRoll(factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.6 ether, 0.5 ether);

        EthTokenAMM badMarket = _seedBadMarket(newN, "bad newN direct market", "badN-LP");
        vm.expectRevert(EthLPVault.StrategyPolicyViolation.selector);
        vault.sellInventory(factory, newSeriesId, true, badMarket, 0.2 ether, 0);
    }

    function testInventorySaleRejectsMismatchedMarketToken() public {
        _depositFromAlice(2 ether);
        uint256 auctionId = _createOldPAuction(1 ether);

        vm.warp(block.timestamp + 12 hours);
        vault.fillSteadyRoll(factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.6 ether, 0.5 ether);

        EthTokenAMM wrongMarket = _seedMarket(newP, "newP direct market", "newP-LP");

        vm.expectRevert(EthLPVault.MarketTokenMismatch.selector);
        vault.sellInventory(factory, newSeriesId, true, wrongMarket, 0.2 ether, 0);
    }

    function testDepositsAndWithdrawRequestsPauseWhileStrategyInventoryIsOpen() public {
        _depositFromAlice(2 ether);
        uint256 auctionId = _createOldPAuction(1 ether);

        vm.warp(block.timestamp + 12 hours);
        vault.fillSteadyRoll(factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.6 ether, 0.5 ether);

        vm.prank(alice);
        vm.expectRevert(EthLPVault.StrategyActive.selector);
        vault.deposit{value: 0.1 ether}();

        vm.prank(alice);
        vm.expectRevert(EthLPVault.StrategyActive.selector);
        vault.requestWithdraw(0.1 ether);
    }

    function testStrategyCannotCloseUntilInventoryIsRedeemed() public {
        _depositFromAlice(2 ether);
        uint256 auctionId = _createOldPAuction(1 ether);

        vm.warp(block.timestamp + 12 hours);
        vault.fillSteadyRoll(factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.6 ether, 0.5 ether);

        vm.expectRevert(EthLPVault.InventoryOpen.selector);
        vault.closeStrategy();

        vm.warp(block.timestamp + NEW_MATURITY);
        oracle.setSettlementPrice(oldSeriesId, 2_000e18);
        oracle.setSettlementPrice(newSeriesId, 2_000e18);
        factory.settle(oldSeriesId);
        factory.settle(newSeriesId);

        vault.redeemP(factory, oldSeriesId, 0.5 ether);
        assertEq(vault.openInventorySeriesCount(), 1);
        vault.redeemP(factory, newSeriesId, 0.1 ether);
        assertEq(vault.openInventorySeriesCount(), 1);
        vault.redeemN(factory, newSeriesId, 0.6 ether);
        assertEq(vault.openInventorySeriesCount(), 0);
        vault.closeStrategy();

        assertEq(vault.strategyActive() ? 1 : 0, 0);
        assertEq(oldP.balanceOf(address(vault)), 0);
        assertEq(newP.balanceOf(address(vault)), 0);
        assertEq(newN.balanceOf(address(vault)), 0);
        assertEq(vault.managedAssets(), 2 ether);

        vm.prank(alice);
        vault.requestWithdraw(1 ether);
        assertEq(vault.reservedEth(), 1 ether);
    }

    function testDiscountedSteadyRollCanIncreaseLpShareValueAfterSettlement() public {
        _depositFromAlice(2 ether);
        uint256 auctionId = _createOldPAuction(1 ether, 0.98e18, 0.98e18, 1 days);

        vm.warp(block.timestamp + 12 hours);
        uint256 newPPaid = vault.fillSteadyRoll(
            factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.5 ether, 0.49 ether
        );
        assertEq(newPPaid, 0.49 ether);

        vm.warp(block.timestamp + NEW_MATURITY);
        oracle.setSettlementPrice(oldSeriesId, 2_000e18);
        oracle.setSettlementPrice(newSeriesId, 2_000e18);
        factory.settle(oldSeriesId);
        factory.settle(newSeriesId);

        vault.redeemP(factory, oldSeriesId, 0.5 ether);
        vault.redeemP(factory, newSeriesId, 0.01 ether);
        vault.redeemN(factory, newSeriesId, 0.5 ether);
        vault.closeStrategy();

        assertEq(vault.strategyActive() ? 1 : 0, 0);
        assertEq(vault.managedAssets(), 2.005 ether);
        assertGt(vault.convertToAssets(1 ether), 1 ether);
    }

    function testParSteadyRollCanReduceLpShareValueFromSeriesBasisRisk() public {
        bytes32 higherStrikeSeriesId =
            factory.createSeries(1_500e18, uint64(block.timestamp + NEW_MATURITY), TWAP_WINDOW, CAP, oracle);
        (MintBurnToken higherP, MintBurnToken higherN) = _tokens(higherStrikeSeriesId);

        _depositFromAlice(2 ether);
        uint256 auctionId = _createOldPAuctionForBuyToken(higherP, 1 ether, 1e18, 1e18, 1 days);

        vm.warp(block.timestamp + 12 hours);
        uint256 newPPaid = vault.fillSteadyRoll(
            factory, auction, oldSeriesId, higherStrikeSeriesId, auctionId, 0.5 ether, 0.5 ether, 0.5 ether
        );
        assertEq(newPPaid, 0.5 ether);

        vm.warp(block.timestamp + NEW_MATURITY);
        oracle.setSettlementPrice(oldSeriesId, 2_000e18);
        oracle.setSettlementPrice(higherStrikeSeriesId, 2_000e18);
        factory.settle(oldSeriesId);
        factory.settle(higherStrikeSeriesId);

        vault.redeemP(factory, oldSeriesId, 0.5 ether);
        vault.redeemN(factory, higherStrikeSeriesId, 0.5 ether);
        vault.closeStrategy();

        assertEq(vault.strategyActive() ? 1 : 0, 0);
        assertEq(oldP.balanceOf(address(vault)), 0);
        assertEq(higherP.balanceOf(address(vault)), 0);
        assertEq(higherN.balanceOf(address(vault)), 0);
        assertEq(vault.managedAssets(), 1.875 ether);
        assertEq(vault.convertToAssets(1 ether), 0.9375 ether);
    }

    function testFuzzSteadyRollCleanupMatchesFactoryPayoffs(
        uint256 rawOldSettlementPrice,
        uint256 rawNewSettlementPrice,
        uint256 rawRollPriceWad
    ) public {
        uint256 oldSettlementPrice = _boundedSettlementPrice(rawOldSettlementPrice);
        uint256 newSettlementPrice = _boundedSettlementPrice(rawNewSettlementPrice);
        uint256 rollPriceWad = 0.98e18 + (rawRollPriceWad % 0.07e18);
        uint256 oldPAmount = 0.5 ether;
        uint256 ethToMint = 0.6 ether;

        _depositFromAlice(2 ether);
        uint256 auctionId = _createOldPAuction(oldPAmount, rollPriceWad, rollPriceWad, 1 days);

        vm.warp(block.timestamp + 12 hours);
        uint256 quotedNewP = auction.quote(auctionId, oldPAmount);
        uint256 newPPaid =
            vault.fillSteadyRoll(factory, auction, oldSeriesId, newSeriesId, auctionId, oldPAmount, ethToMint, quotedNewP);
        assertEq(newPPaid, quotedNewP);

        uint256 leftoverNewP = ethToMint - newPPaid;
        uint256 expectedManagedAssets = 2 ether - ethToMint
            + (oldPAmount * factory.pPayoffWad(STRIKE, oldSettlementPrice)) / 1e18
            + (leftoverNewP * factory.pPayoffWad(STRIKE, newSettlementPrice)) / 1e18
            + (ethToMint * factory.nPayoffWad(STRIKE, newSettlementPrice)) / 1e18;

        vm.warp(block.timestamp + NEW_MATURITY);
        oracle.setSettlementPrice(oldSeriesId, oldSettlementPrice);
        oracle.setSettlementPrice(newSeriesId, newSettlementPrice);
        factory.settle(oldSeriesId);
        factory.settle(newSeriesId);

        vault.redeemP(factory, oldSeriesId, oldPAmount);
        vault.redeemP(factory, newSeriesId, leftoverNewP);
        vault.redeemN(factory, newSeriesId, ethToMint);
        vault.closeStrategy();

        assertEq(vault.managedAssets(), expectedManagedAssets);
        assertEq(vault.openInventorySeriesCount(), 0);
        assertEq(oldP.balanceOf(address(vault)), 0);
        assertEq(newP.balanceOf(address(vault)), 0);
        assertEq(newN.balanceOf(address(vault)), 0);
    }

    function testFuzzBoostedRollCleanupMatchesFactoryPayoffs(
        uint256 rawOldSettlementPrice,
        uint256 rawNewSettlementPrice,
        uint256 rawRollPriceWad
    ) public {
        uint256 oldSettlementPrice = _boundedSettlementPrice(rawOldSettlementPrice);
        uint256 newSettlementPrice = _boundedSettlementPrice(rawNewSettlementPrice);
        uint256 rollPriceWad = 0.98e18 + (rawRollPriceWad % 0.07e18);
        uint256 oldNAmount = 0.5 ether;
        uint256 ethToMint = 0.6 ether;

        _depositFromAlice(2 ether);
        uint256 auctionId = _createOldNAuction(oldNAmount, rollPriceWad, rollPriceWad, 1 days);

        vm.warp(block.timestamp + 12 hours);
        uint256 quotedNewN = auction.quote(auctionId, oldNAmount);
        uint256 newNPaid =
            vault.fillBoostedRoll(factory, auction, oldSeriesId, newSeriesId, auctionId, oldNAmount, ethToMint, quotedNewN);
        assertEq(newNPaid, quotedNewN);

        uint256 leftoverNewN = ethToMint - newNPaid;
        uint256 expectedManagedAssets = 2 ether - ethToMint
            + (oldNAmount * factory.nPayoffWad(STRIKE, oldSettlementPrice)) / 1e18
            + (ethToMint * factory.pPayoffWad(STRIKE, newSettlementPrice)) / 1e18
            + (leftoverNewN * factory.nPayoffWad(STRIKE, newSettlementPrice)) / 1e18;

        vm.warp(block.timestamp + NEW_MATURITY);
        oracle.setSettlementPrice(oldSeriesId, oldSettlementPrice);
        oracle.setSettlementPrice(newSeriesId, newSettlementPrice);
        factory.settle(oldSeriesId);
        factory.settle(newSeriesId);

        vault.redeemN(factory, oldSeriesId, oldNAmount);
        vault.redeemP(factory, newSeriesId, ethToMint);
        vault.redeemN(factory, newSeriesId, leftoverNewN);
        vault.closeStrategy();

        assertEq(vault.managedAssets(), expectedManagedAssets);
        assertEq(vault.openInventorySeriesCount(), 0);
        assertEq(oldN.balanceOf(address(vault)), 0);
        assertEq(newP.balanceOf(address(vault)), 0);
        assertEq(newN.balanceOf(address(vault)), 0);
    }

    function testManagerCanMergeMatchedInventoryAfterMaturityBeforeSettlement() public {
        _depositFromAlice(2 ether);
        uint256 auctionId = _createOldPAuction(1 ether);

        vm.warp(block.timestamp + 12 hours);
        vault.fillSteadyRoll(factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.6 ether, 0.5 ether);

        uint256 managedBefore = vault.managedAssets();
        vm.warp(block.timestamp + NEW_MATURITY);
        vault.mergeSeries(factory, newSeriesId, 0.1 ether);

        assertEq(vault.managedAssets(), managedBefore + 0.1 ether);
        assertEq(newP.balanceOf(address(vault)), 0);
        assertEq(newN.balanceOf(address(vault)), 0.5 ether);
        assertEq(vault.openInventorySeriesCount(), 2);
    }

    function testStrategyCloseUsesOpenInventoryCounterNotHistoricalList() public {
        _depositFromAlice(2 ether);
        uint256 auctionId = _createOldPAuction(1 ether);

        vm.warp(block.timestamp + 12 hours);
        vault.fillSteadyRoll(factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.6 ether, 0.5 ether);
        assertEq(vault.inventorySeriesLength(), 2);
        assertEq(vault.openInventorySeriesCount(), 2);

        vm.warp(block.timestamp + NEW_MATURITY);
        oracle.setSettlementPrice(oldSeriesId, 2_000e18);
        oracle.setSettlementPrice(newSeriesId, 2_000e18);
        factory.settle(oldSeriesId);
        factory.settle(newSeriesId);

        vault.redeemP(factory, oldSeriesId, 0.5 ether);
        vault.redeemP(factory, newSeriesId, 0.1 ether);
        vault.redeemN(factory, newSeriesId, 0.6 ether);

        assertEq(vault.inventorySeriesLength(), 2);
        assertEq(vault.openInventorySeriesCount(), 0);
        vault.closeStrategy();
        assertEq(vault.strategyActive() ? 1 : 0, 0);
    }

    function testBoostedStrategyCannotCloseUntilInventoryIsRedeemed() public {
        _depositFromAlice(2 ether);
        uint256 auctionId = _createOldNAuction(1 ether);

        vm.warp(block.timestamp + 12 hours);
        vault.fillBoostedRoll(factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.6 ether, 0.5 ether);

        vm.expectRevert(EthLPVault.InventoryOpen.selector);
        vault.closeStrategy();

        vm.warp(block.timestamp + NEW_MATURITY);
        oracle.setSettlementPrice(oldSeriesId, 2_000e18);
        oracle.setSettlementPrice(newSeriesId, 2_000e18);
        factory.settle(oldSeriesId);
        factory.settle(newSeriesId);

        vault.redeemN(factory, oldSeriesId, 0.5 ether);
        assertEq(vault.openInventorySeriesCount(), 1);
        vault.redeemP(factory, newSeriesId, 0.6 ether);
        assertEq(vault.openInventorySeriesCount(), 1);
        vault.redeemN(factory, newSeriesId, 0.1 ether);
        assertEq(vault.openInventorySeriesCount(), 0);
        vault.closeStrategy();

        assertEq(vault.strategyActive() ? 1 : 0, 0);
        assertEq(oldN.balanceOf(address(vault)), 0);
        assertEq(newP.balanceOf(address(vault)), 0);
        assertEq(newN.balanceOf(address(vault)), 0);
        assertEq(vault.managedAssets(), 2 ether);
    }

    function testStrategyPolicyRejectsOversizedRoll() public {
        _depositFromAlice(2 ether);
        uint256 auctionId = _createOldPAuction(2 ether);

        vm.expectRevert(EthLPVault.StrategyPolicyViolation.selector);
        vault.fillSteadyRoll(factory, auction, oldSeriesId, newSeriesId, auctionId, 1 ether, 1.1 ether, 1 ether);
    }

    function testStrategyPolicyRejectsExpensiveRoll() public {
        _depositFromAlice(2 ether);
        uint256 auctionId = _createOldPAuction(1 ether, 1.1e18, 1.1e18, 1 days);

        vm.expectRevert(EthLPVault.StrategyPolicyViolation.selector);
        vault.fillSteadyRoll(factory, auction, oldSeriesId, newSeriesId, auctionId, 1 ether, 1.1 ether, 1.1 ether);
    }

    function testStrategyPolicyRejectsTooShortAuction() public {
        _depositFromAlice(2 ether);
        uint256 auctionId = _createOldPAuction(1 ether, 1e18, 1e18, 1 hours);

        vm.expectRevert(EthLPVault.StrategyPolicyViolation.selector);
        vault.fillSteadyRoll(factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.5 ether, 0.5 ether);
    }

    function testStrategyPolicyRejectsAuctionBeforeBackstopDelay() public {
        _depositFromAlice(2 ether);
        uint256 auctionId = _createOldPAuction(1 ether, 1e18, 0.999e18, 1 days);

        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(EthLPVault.StrategyPolicyViolation.selector);
        vault.fillSteadyRoll(factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.5 ether, 0.5 ether);
    }

    function testStrategyPolicyRejectsAuctionWithTooLittleTimeLeft() public {
        _depositFromAlice(2 ether);
        uint256 auctionId = _createOldPAuction(1 ether, 1e18, 0.999e18, 1 days);

        vm.warp(block.timestamp + 23 hours);
        vm.expectRevert(EthLPVault.StrategyPolicyViolation.selector);
        vault.fillSteadyRoll(factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.5 ether, 0.5 ether);
    }

    function testStrategyPolicyRejectsAuctionAfterLargePriceDrop() public {
        _depositFromAlice(2 ether);
        uint256 auctionId = _createOldPAuction(1 ether, 1.02e18, 0.98e18, 3 days);

        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(EthLPVault.StrategyPolicyViolation.selector);
        vault.fillSteadyRoll(factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.5 ether, 0.5 ether);
    }

    function testStrategyPolicyRejectsActiveInventoryCapBreach() public {
        _depositFromAlice(3 ether);
        uint256 firstAuctionId = _createOldPAuction(1 ether);
        uint256 secondAuctionId = _createOldPAuction(1 ether);

        vm.warp(block.timestamp + 12 hours);
        vault.fillSteadyRoll(
            factory, auction, oldSeriesId, newSeriesId, firstAuctionId, 0.6 ether, 0.7 ether, 0.6 ether
        );

        vm.expectRevert(EthLPVault.StrategyPolicyViolation.selector);
        vault.fillSteadyRoll(
            factory, auction, oldSeriesId, newSeriesId, secondAuctionId, 0.5 ether, 0.6 ether, 0.5 ether
        );
    }

    function _depositFromAlice(uint256 amount) internal {
        vm.prank(alice);
        vault.deposit{value: amount}();
    }

    function _createOldPAuction(uint256 oldPAmount) internal returns (uint256 auctionId) {
        return _createOldPAuction(oldPAmount, 1.02e18, 0.98e18, 1 days);
    }

    function _createOldPAuction(uint256 oldPAmount, uint256 startPrice, uint256 endPrice, uint64 duration)
        internal
        returns (uint256 auctionId)
    {
        return _createOldPAuctionForBuyToken(newP, oldPAmount, startPrice, endPrice, duration);
    }

    function _createOldPAuctionForBuyToken(
        MintBurnToken buyToken,
        uint256 oldPAmount,
        uint256 startPrice,
        uint256 endPrice,
        uint64 duration
    ) internal returns (uint256 auctionId)
    {
        vm.prank(steadyVault);
        factory.mint{value: oldPAmount}(oldSeriesId);

        vm.prank(steadyVault);
        oldP.approve(address(auction), oldPAmount);

        vm.prank(steadyVault);
        auctionId = auction.createAuction(
            IERC20Like(address(oldP)),
            IERC20Like(address(buyToken)),
            oldPAmount,
            startPrice,
            endPrice,
            duration,
            steadyVault
        );
    }

    function _createOldNAuction(uint256 oldNAmount) internal returns (uint256 auctionId) {
        return _createOldNAuction(oldNAmount, 1.02e18, 0.98e18, 1 days);
    }

    function _createOldNAuction(uint256 oldNAmount, uint256 startPrice, uint256 endPrice, uint64 duration)
        internal
        returns (uint256 auctionId)
    {
        vm.prank(boostedVault);
        factory.mint{value: oldNAmount}(oldSeriesId);

        vm.prank(boostedVault);
        oldN.approve(address(auction), oldNAmount);

        vm.prank(boostedVault);
        auctionId = auction.createAuction(
            IERC20Like(address(oldN)),
            IERC20Like(address(newN)),
            oldNAmount,
            startPrice,
            endPrice,
            duration,
            boostedVault
        );
    }

    function _tokens(bytes32 seriesId) internal view returns (MintBurnToken pToken, MintBurnToken nToken) {
        (,,,,,, pToken, nToken,,,) = factory.series(seriesId);
    }

    function _boundedSettlementPrice(uint256 rawPrice) internal pure returns (uint256) {
        return 1 + (rawPrice % 1_000_000e18);
    }

    function _seedMarket(MintBurnToken token, string memory lpName, string memory lpSymbol)
        internal
        returns (EthTokenAMM market)
    {
        market = new EthTokenAMM(IERC20Like(address(token)), lpName, lpSymbol, 30);

        vm.prank(marketMaker);
        factory.mint{value: 10 ether}(newSeriesId);

        vm.prank(marketMaker);
        token.approve(address(market), 10 ether);

        vm.prank(marketMaker);
        market.addLiquidity{value: 10 ether}(10 ether, 10 ether, marketMaker);
    }

    function _seedBadMarket(MintBurnToken token, string memory lpName, string memory lpSymbol)
        internal
        returns (EthTokenAMM market)
    {
        market = new EthTokenAMM(IERC20Like(address(token)), lpName, lpSymbol, 30);

        vm.prank(marketMaker);
        factory.mint{value: 10 ether}(newSeriesId);

        vm.prank(marketMaker);
        token.approve(address(market), 10 ether);

        vm.prank(marketMaker);
        market.addLiquidity{value: 0.1 ether}(10 ether, 0, marketMaker);
    }
}
