// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EthOptionsFactory} from "../src/EthOptionsFactory.sol";
import {RollAuction, IERC20Like} from "../src/RollAuction.sol";
import {MockSettlementOracle} from "../src/oracle/MockSettlementOracle.sol";
import {EthTokenAMM} from "../src/market/EthTokenAMM.sol";
import {EthLPVault} from "../src/vault/EthLPVault.sol";
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
            MAX_AUCTION_PRICE_DROP_BPS
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
        vm.prank(steadyVault);
        factory.mint{value: oldPAmount}(oldSeriesId);

        vm.prank(steadyVault);
        oldP.approve(address(auction), oldPAmount);

        vm.prank(steadyVault);
        auctionId = auction.createAuction(
            IERC20Like(address(oldP)),
            IERC20Like(address(newP)),
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
