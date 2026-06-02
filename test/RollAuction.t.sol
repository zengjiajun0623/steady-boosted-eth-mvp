// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EthOptionsFactory} from "../src/EthOptionsFactory.sol";
import {IERC20Like, IRollAuctionCallee, RollAuction} from "../src/RollAuction.sol";
import {RollSolver} from "../src/RollSolver.sol";
import {MintBurnToken} from "../src/token/MintBurnToken.sol";
import {MockSettlementOracle} from "../src/oracle/MockSettlementOracle.sol";

interface RollVm {
    function deal(address account, uint256 amount) external;
    function prank(address account) external;
    function warp(uint256 timestamp) external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes memory revertData) external;
}

interface IERC20ApproveLike is IERC20Like {
    function approve(address spender, uint256 value) external returns (bool);
}

contract PrefundedRollCallee is IRollAuctionCallee {
    address public immutable recipient;

    error TransferFailed();

    constructor(address recipient_) {
        recipient = recipient_;
    }

    function rollAuctionCall(
        address,
        uint256,
        address sellToken,
        address buyToken,
        uint256 sellAmount,
        uint256 buyAmount,
        bytes calldata
    ) external {
        if (!IERC20Like(sellToken).transfer(recipient, sellAmount)) revert TransferFailed();
        if (!IERC20ApproveLike(buyToken).approve(msg.sender, buyAmount)) revert TransferFailed();
    }
}

contract RollAuctionTest {
    RollVm internal constant vm = RollVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    EthOptionsFactory internal factory;
    MockSettlementOracle internal oracle;
    RollAuction internal auction;
    RollSolver internal rollSolver;
    bytes32 internal oldSeriesId;
    bytes32 internal newSeriesId;
    MintBurnToken internal oldP;
    MintBurnToken internal oldN;
    MintBurnToken internal newP;
    MintBurnToken internal newN;

    address internal seller = address(0xA11CE);
    address internal solver = address(0xB0B);
    address internal helperSolver = address(0xC0DE);

    uint256 internal constant STRIKE = 1_000e18;
    uint32 internal constant TWAP_WINDOW = 72 hours;
    uint256 internal constant CAP = 100 ether;
    uint256 internal constant START_PRICE = 1.02e18;
    uint256 internal constant END_PRICE = 0.98e18;
    uint256 internal constant MIN_SELL_AMOUNT = 0.01 ether;
    uint256 internal constant MAX_ACTIVE_AUCTIONS = 16;
    uint256 internal constant MAX_ACTIVE_AUCTIONS_PER_SELLER = 4;

    function setUp() public {
        oracle = new MockSettlementOracle();
        factory = new EthOptionsFactory();
        auction = new RollAuction(address(this), MIN_SELL_AMOUNT, MAX_ACTIVE_AUCTIONS, MAX_ACTIVE_AUCTIONS_PER_SELLER);
        rollSolver = new RollSolver();

        oldSeriesId = factory.createSeries(STRIKE, uint64(block.timestamp + 30 days), TWAP_WINDOW, CAP, oracle);
        newSeriesId = factory.createSeries(STRIKE, uint64(block.timestamp + 60 days), TWAP_WINDOW, CAP, oracle);
        (oldP, oldN) = _tokens(oldSeriesId);
        (newP, newN) = _tokens(newSeriesId);

        vm.deal(seller, 10 ether);
        vm.deal(solver, 10 ether);
        vm.deal(helperSolver, 10 ether);

        vm.prank(seller);
        factory.mint{value: 2 ether}(oldSeriesId);

        vm.prank(solver);
        factory.mint{value: 2 ether}(newSeriesId);
    }

    function testCreateEscrowsOldSeriesToken() public {
        uint256 auctionId = _createAuction(1 ether);

        assertEq(auctionId, 0);
        assertEq(oldP.balanceOf(address(auction)), 1 ether);
        assertEq(oldP.balanceOf(seller), 1 ether);
        assertEq(auction.activeAuctionCount(), 1);
        assertEq(auction.activeAuctionIdAt(0), auctionId);
        require(auction.isActive(auctionId), "auction not active");
    }

    function testPriceDecaysLinearlyToFloor() public {
        uint256 auctionId = _createAuction(1 ether);

        assertEq(auction.currentPriceWad(auctionId), START_PRICE);

        vm.warp(block.timestamp + 12 hours);
        assertEq(auction.currentPriceWad(auctionId), 1e18);

        vm.warp(block.timestamp + 2 days);
        assertEq(auction.currentPriceWad(auctionId), END_PRICE);
    }

    function testSellerCanResetExpiredPartiallyFilledAuction() public {
        auction.setStaleResetPolicy(0, 0);
        uint256 auctionId = _createAuction(1 ether);
        vm.warp(block.timestamp + 12 hours);

        vm.prank(solver);
        newP.approve(address(auction), 0.25 ether);

        vm.prank(solver);
        auction.fill(auctionId, 0.25 ether, 0.25 ether, solver);

        vm.prank(seller);
        vm.expectRevert(RollAuction.AuctionStillRunning.selector);
        auction.redo(auctionId, 1.01e18, 0.99e18, 2 days);

        vm.warp(block.timestamp + 12 hours + 1);
        vm.prank(solver);
        vm.expectRevert(RollAuction.NotSeller.selector);
        auction.redo(auctionId, 1.01e18, 0.99e18, 2 days);

        vm.prank(seller);
        auction.redo(auctionId, 1.01e18, 0.99e18, 2 days);

        (
            ,,,,
            uint256 remainingSellAmount,
            uint256 buyTokenRaised,
            uint256 startPriceWad,,
            uint64 startTime,
            uint64 duration,
        ) = auction.auctions(auctionId);
        assertEq(remainingSellAmount, 0.75 ether);
        assertEq(buyTokenRaised, 0.25 ether);
        assertEq(startPriceWad, 1.01e18);
        assertEq(duration, 2 days);
        assertEq(startTime, uint64(block.timestamp));
        assertEq(auction.currentPriceWad(auctionId), 1.01e18);
    }

    function testSellerCanResetStaleAuctionAfterPriceDropThreshold() public {
        auction.setStaleResetPolicy(6 hours, 100);
        uint256 auctionId = _createAuction(1 ether);
        vm.warp(block.timestamp + 12 hours);

        (bool expired, bool priceStale, uint256 elapsed, uint256 priceWad, uint256 priceDropBps) =
            auction.resetStatus(auctionId);
        require(!expired, "auction should not be expired");
        require(priceStale, "price should be stale");
        assertEq(elapsed, 12 hours);
        assertEq(priceWad, 1e18);
        require(priceDropBps >= 100, "drop too small");

        vm.prank(seller);
        auction.redo(auctionId, 1.01e18, 0.99e18, 1 days);

        (,,,, uint256 remainingSellAmount,, uint256 startPriceWad,, uint64 startTime,,) = auction.auctions(auctionId);
        assertEq(remainingSellAmount, 1 ether);
        assertEq(startPriceWad, 1.01e18);
        assertEq(startTime, uint64(block.timestamp));
    }

    function testDisablingStaleResetPolicyRequiresFullAuctionDuration() public {
        auction.setStaleResetPolicy(0, 0);
        uint256 auctionId = _createAuction(1 ether);
        vm.warp(block.timestamp + 12 hours);

        (bool expired, bool priceStale,,,) = auction.resetStatus(auctionId);
        require(!expired, "auction should not be expired");
        require(!priceStale, "stale reset should be disabled");

        vm.prank(seller);
        vm.expectRevert(RollAuction.AuctionStillRunning.selector);
        auction.redo(auctionId, 1.01e18, 0.99e18, 1 days);

        vm.warp(block.timestamp + 12 hours + 1);
        vm.prank(seller);
        auction.redo(auctionId, 1.01e18, 0.99e18, 1 days);
    }

    function testOnlyGuardianCanSetCircuitBreaker() public {
        uint256 stopNewAuctions = auction.STOP_NEW_AUCTIONS();
        uint256 stopFills = auction.STOP_FILLS();

        vm.prank(solver);
        vm.expectRevert(RollAuction.NotGuardian.selector);
        auction.setStopped(stopNewAuctions);

        vm.expectRevert(RollAuction.InvalidConfig.selector);
        auction.setStopped(stopFills + 1);

        auction.setStopped(stopNewAuctions);
        assertEq(auction.stopped(), stopNewAuctions);
    }

    function testOnlyGuardianCanSetMinSellAmount() public {
        vm.prank(solver);
        vm.expectRevert(RollAuction.NotGuardian.selector);
        auction.setMinSellAmount(0.02 ether);

        vm.expectRevert(RollAuction.InvalidConfig.selector);
        auction.setMinSellAmount(0);

        auction.setMinSellAmount(0.02 ether);
        assertEq(auction.minSellAmount(), 0.02 ether);
    }

    function testOnlyGuardianCanSetStaleResetPolicy() public {
        vm.prank(solver);
        vm.expectRevert(RollAuction.NotGuardian.selector);
        auction.setStaleResetPolicy(6 hours, 200);

        vm.expectRevert(RollAuction.InvalidConfig.selector);
        auction.setStaleResetPolicy(0, 200);

        vm.expectRevert(RollAuction.InvalidConfig.selector);
        auction.setStaleResetPolicy(6 hours, 10_001);

        auction.setStaleResetPolicy(6 hours, 200);
        assertEq(auction.minStaleResetDelay(), 6 hours);
        assertEq(auction.minStaleResetPriceDropBps(), 200);
    }

    function testZeroGuardianDisablesAdminSettersButAuctionsStillRun() public {
        RollAuction trustlessAuction =
            new RollAuction(address(0), MIN_SELL_AMOUNT, MAX_ACTIVE_AUCTIONS, MAX_ACTIVE_AUCTIONS_PER_SELLER);
        uint256 stopNewAuctions = trustlessAuction.STOP_NEW_AUCTIONS();

        assertEq(trustlessAuction.guardian(), address(0));
        vm.expectRevert(RollAuction.NotGuardian.selector);
        trustlessAuction.setStopped(stopNewAuctions);
        vm.expectRevert(RollAuction.NotGuardian.selector);
        trustlessAuction.setMinSellAmount(0.02 ether);
        vm.expectRevert(RollAuction.NotGuardian.selector);
        trustlessAuction.setStaleResetPolicy(6 hours, 200);

        vm.prank(seller);
        oldP.approve(address(trustlessAuction), 1 ether);

        vm.prank(seller);
        uint256 auctionId = trustlessAuction.createAuction(
            IERC20Like(address(oldP)), IERC20Like(address(newP)), 1 ether, START_PRICE, END_PRICE, 1 days, seller
        );

        vm.warp(block.timestamp + 12 hours);
        vm.prank(solver);
        newP.approve(address(trustlessAuction), 1 ether);

        vm.prank(solver);
        uint256 paid = trustlessAuction.fill(auctionId, 1 ether, 1 ether, solver);

        assertEq(paid, 1 ether);
        assertEq(trustlessAuction.activeAuctionCount(), 0);
    }

    function testRejectsDustAuctionCreation() public {
        vm.prank(seller);
        oldP.approve(address(auction), MIN_SELL_AMOUNT - 1);

        vm.prank(seller);
        vm.expectRevert(RollAuction.DustAmount.selector);
        auction.createAuction(
            IERC20Like(address(oldP)),
            IERC20Like(address(newP)),
            MIN_SELL_AMOUNT - 1,
            START_PRICE,
            END_PRICE,
            1 days,
            seller
        );
    }

    function testRejectsDustPartialFill() public {
        uint256 auctionId = _createAuction(1 ether);
        auction.setMinSellAmount(0.1 ether);
        vm.warp(block.timestamp + 12 hours);

        vm.prank(solver);
        newP.approve(address(auction), 0.05 ether);

        vm.prank(solver);
        vm.expectRevert(RollAuction.DustAmount.selector);
        auction.fill(auctionId, 0.05 ether, 0.05 ether, solver);

        (,,,, uint256 remainingSellAmount,,,,,,) = auction.auctions(auctionId);
        assertEq(remainingSellAmount, 1 ether);
    }

    function testRejectsFillThatWouldLeaveDustRemainder() public {
        uint256 auctionId = _createAuction(1 ether);
        auction.setMinSellAmount(0.1 ether);
        vm.warp(block.timestamp + 12 hours);

        vm.prank(solver);
        newP.approve(address(auction), 0.95 ether);

        vm.prank(solver);
        vm.expectRevert(RollAuction.DustAmount.selector);
        auction.fill(auctionId, 0.95 ether, 0.95 ether, solver);

        (,,,, uint256 remainingSellAmount,,,,,,) = auction.auctions(auctionId);
        assertEq(remainingSellAmount, 1 ether);
    }

    function testFillAllCanClearRemainderBelowCurrentDustThreshold() public {
        uint256 auctionId = _createAuction(1 ether);
        auction.setMinSellAmount(0.1 ether);
        vm.warp(block.timestamp + 12 hours);

        vm.prank(solver);
        newP.approve(address(auction), 1 ether);

        vm.prank(solver);
        auction.fill(auctionId, 0.9 ether, 0.9 ether, solver);

        auction.setMinSellAmount(0.2 ether);

        vm.prank(solver);
        (uint256 sold, uint256 paid) = auction.fillAll(auctionId, 0.1 ether, solver);

        assertEq(sold, 0.1 ether);
        assertEq(paid, 0.1 ether);
        assertEq(auction.activeAuctionCount(), 0);
    }

    function testCircuitBreakerCanPauseNewAuctionsWithoutBlockingExistingFills() public {
        uint256 auctionId = _createAuction(1 ether);
        uint256 stopNewAuctions = auction.STOP_NEW_AUCTIONS();
        auction.setStopped(stopNewAuctions);

        vm.prank(seller);
        oldP.approve(address(auction), 0.1 ether);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(RollAuction.CircuitBreakerActive.selector, stopNewAuctions));
        auction.createAuction(
            IERC20Like(address(oldP)), IERC20Like(address(newP)), 0.1 ether, START_PRICE, END_PRICE, 1 days, seller
        );

        vm.warp(block.timestamp + 12 hours);
        vm.prank(solver);
        newP.approve(address(auction), 1 ether);
        vm.prank(solver);
        uint256 paid = auction.fill(auctionId, 1 ether, 1 ether, solver);

        assertEq(paid, 1 ether);
        assertEq(auction.activeAuctionCount(), 0);
    }

    function testCircuitBreakerCanPauseResets() public {
        uint256 auctionId = _createAuction(1 ether);
        vm.warp(block.timestamp + 1 days + 1);

        uint256 stopResets = auction.STOP_RESETS();
        auction.setStopped(stopResets);

        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(RollAuction.CircuitBreakerActive.selector, stopResets));
        auction.redo(auctionId, 1.01e18, 0.99e18, 1 days);

        vm.prank(seller);
        uint256 returned = auction.cancel(auctionId);
        assertEq(returned, 1 ether);
    }

    function testCircuitBreakerCanPauseFillsButSellerCanCancel() public {
        uint256 auctionId = _createAuction(1 ether);
        uint256 stopFills = auction.STOP_FILLS();
        auction.setStopped(stopFills);

        vm.prank(solver);
        newP.approve(address(auction), 1 ether);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(RollAuction.CircuitBreakerActive.selector, stopFills));
        auction.fill(auctionId, 1 ether, START_PRICE, solver);

        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(RollAuction.CircuitBreakerActive.selector, stopFills));
        auction.fillAll(auctionId, START_PRICE, solver);

        vm.prank(seller);
        uint256 returned = auction.cancel(auctionId);

        assertEq(returned, 1 ether);
        assertEq(auction.activeAuctionCount(), 0);
    }

    function testSolverCanPartiallyFillWithNewSeriesToken() public {
        uint256 auctionId = _createAuction(1 ether);
        vm.warp(block.timestamp + 12 hours);

        vm.prank(solver);
        newP.approve(address(auction), 0.5 ether);

        vm.prank(solver);
        uint256 paidNewP = auction.fill(auctionId, 0.5 ether, 0.5 ether, solver);

        assertEq(paidNewP, 0.5 ether);
        assertEq(oldP.balanceOf(solver), 0.5 ether);
        assertEq(newP.balanceOf(seller), 0.5 ether);
        assertEq(newP.balanceOf(solver), 1.5 ether);

        (,,,, uint256 remainingSellAmount, uint256 buyTokenRaised,,,,,) = auction.auctions(auctionId);
        assertEq(remainingSellAmount, 0.5 ether);
        assertEq(buyTokenRaised, 0.5 ether);
        require(auction.isActive(auctionId), "partial fill should stay active");
    }

    function testFullFillRemovesAuctionFromActiveList() public {
        uint256 auctionId = _createAuction(1 ether);
        vm.warp(block.timestamp + 12 hours);

        vm.prank(solver);
        newP.approve(address(auction), 1 ether);

        vm.prank(solver);
        auction.fill(auctionId, 1 ether, 1 ether, solver);

        assertEq(auction.activeAuctionCount(), 0);
        assertEq(auction.activeAuctionCountBySeller(seller), 0);
        require(!auction.isActive(auctionId), "filled auction active");
    }

    function testFillAllTakesCurrentRemainingInventory() public {
        uint256 auctionId = _createAuction(1 ether);
        vm.warp(block.timestamp + 12 hours);

        vm.prank(solver);
        newP.approve(address(auction), 1 ether);

        vm.prank(solver);
        auction.fill(auctionId, 0.25 ether, 0.25 ether, solver);

        vm.prank(solver);
        (uint256 sold, uint256 paid) = auction.fillAll(auctionId, 0.75 ether, solver);

        assertEq(sold, 0.75 ether);
        assertEq(paid, 0.75 ether);
        assertEq(oldP.balanceOf(solver), 1 ether);
        assertEq(newP.balanceOf(seller), 1 ether);
        assertEq(auction.activeAuctionCount(), 0);
    }

    function testAuctionStatusSurfacesSolverFields() public {
        uint256 auctionId = _createAuction(1 ether);
        vm.warp(block.timestamp + 12 hours);

        (
            bool open,
            bool active,
            bool priceAtFloor,
            uint256 remainingSellAmount,
            uint256 buyTokenRaised,
            uint256 priceWad,
            uint256 elapsed,
            uint256 timeLeft
        ) = auction.auctionStatus(auctionId);

        require(open, "not open");
        require(active, "not active");
        require(!priceAtFloor, "already floor");
        assertEq(remainingSellAmount, 1 ether);
        assertEq(buyTokenRaised, 0);
        assertEq(priceWad, 1e18);
        assertEq(elapsed, 12 hours);
        assertEq(timeLeft, 12 hours);
    }

    function testFillRespectsSolverMaxPrice() public {
        uint256 auctionId = _createAuction(1 ether);

        vm.prank(solver);
        newP.approve(address(auction), 1 ether);

        vm.prank(solver);
        vm.expectRevert(RollAuction.PriceTooHigh.selector);
        auction.fill(auctionId, 1 ether, 1 ether, solver);
    }

    function testSellerCanCancelRemainingInventory() public {
        uint256 auctionId = _createAuction(1 ether);

        vm.prank(seller);
        uint256 returned = auction.cancel(auctionId);

        assertEq(returned, 1 ether);
        assertEq(oldP.balanceOf(seller), 2 ether);
        assertEq(oldP.balanceOf(address(auction)), 0);
        assertEq(auction.activeAuctionCount(), 0);
        require(!auction.isActive(auctionId), "cancelled auction active");
    }

    function testActiveAuctionListHandlesMiddleRemoval() public {
        uint256 firstAuctionId = _createAuction(0.5 ether);
        uint256 secondAuctionId = _createAuction(0.5 ether);
        uint256 thirdAuctionId = _createAuction(0.5 ether);

        vm.prank(seller);
        auction.cancel(secondAuctionId);

        assertEq(auction.activeAuctionCount(), 2);
        assertEq(auction.activeAuctionIdAt(0), firstAuctionId);
        assertEq(auction.activeAuctionIdAt(1), thirdAuctionId);
        assertEq(auction.activeAuctionCountBySeller(seller), 2);
        assertEq(auction.activeAuctionIdBySellerAt(seller, 0), firstAuctionId);
        assertEq(auction.activeAuctionIdBySellerAt(seller, 1), thirdAuctionId);
        require(auction.isActive(firstAuctionId), "first removed");
        require(!auction.isActive(secondAuctionId), "second still active");
        require(auction.isActive(thirdAuctionId), "third removed");
    }

    function testRejectsNewAuctionWhenActiveListIsFull() public {
        RollAuction cappedAuction = new RollAuction(address(this), MIN_SELL_AMOUNT, 2, 2);

        vm.prank(seller);
        oldP.approve(address(cappedAuction), 2 ether);

        vm.prank(seller);
        cappedAuction.createAuction(
            IERC20Like(address(oldP)), IERC20Like(address(newP)), 0.5 ether, START_PRICE, END_PRICE, 1 days, seller
        );
        vm.prank(seller);
        cappedAuction.createAuction(
            IERC20Like(address(oldP)), IERC20Like(address(newP)), 0.5 ether, START_PRICE, END_PRICE, 1 days, seller
        );

        vm.prank(seller);
        vm.expectRevert(RollAuction.ActiveAuctionLimitReached.selector);
        cappedAuction.createAuction(
            IERC20Like(address(oldP)), IERC20Like(address(newP)), 0.5 ether, START_PRICE, END_PRICE, 1 days, seller
        );

        assertEq(cappedAuction.activeAuctionCount(), 2);
        assertEq(oldP.balanceOf(seller), 1 ether);
    }

    function testRejectsNewAuctionWhenSellerActiveListIsFull() public {
        RollAuction cappedAuction = new RollAuction(address(this), MIN_SELL_AMOUNT, 16, 2);

        vm.prank(seller);
        oldP.approve(address(cappedAuction), 2 ether);

        vm.prank(seller);
        uint256 firstAuctionId = cappedAuction.createAuction(
            IERC20Like(address(oldP)), IERC20Like(address(newP)), 0.5 ether, START_PRICE, END_PRICE, 1 days, seller
        );
        vm.prank(seller);
        cappedAuction.createAuction(
            IERC20Like(address(oldP)), IERC20Like(address(newP)), 0.5 ether, START_PRICE, END_PRICE, 1 days, seller
        );

        assertEq(cappedAuction.activeAuctionCountBySeller(seller), 2);

        vm.prank(seller);
        vm.expectRevert(RollAuction.SellerActiveAuctionLimitReached.selector);
        cappedAuction.createAuction(
            IERC20Like(address(oldP)), IERC20Like(address(newP)), 0.5 ether, START_PRICE, END_PRICE, 1 days, seller
        );

        vm.prank(seller);
        cappedAuction.cancel(firstAuctionId);
        assertEq(cappedAuction.activeAuctionCountBySeller(seller), 1);

        vm.prank(seller);
        uint256 thirdAuctionId = cappedAuction.createAuction(
            IERC20Like(address(oldP)), IERC20Like(address(newP)), 0.5 ether, START_PRICE, END_PRICE, 1 days, seller
        );

        require(cappedAuction.isActive(thirdAuctionId), "seller slot not reusable");
        assertEq(cappedAuction.activeAuctionCountBySeller(seller), 2);
    }

    function testExternalSolverHelperMintsAndFillsAtomically() public {
        uint256 auctionId = _createAuction(1 ether);
        vm.warp(block.timestamp + 12 hours);

        vm.prank(helperSolver);
        uint256 paidNewP = rollSolver.mintAndFill{value: 0.6 ether}(
            factory, auction, newSeriesId, auctionId, 0.5 ether, 0.5 ether, helperSolver
        );

        assertEq(paidNewP, 0.5 ether);
        assertEq(oldP.balanceOf(helperSolver), 0.5 ether);
        assertEq(newP.balanceOf(seller), 0.5 ether);
        assertEq(newP.balanceOf(helperSolver), 0.1 ether);
        assertEq(newN.balanceOf(helperSolver), 0.6 ether);
    }

    function testExternalSolverHelperFillAllClearsCurrentRemainder() public {
        uint256 auctionId = _createAuction(1 ether);
        vm.warp(block.timestamp + 12 hours);

        vm.prank(solver);
        newP.approve(address(auction), 0.25 ether);
        vm.prank(solver);
        auction.fill(auctionId, 0.25 ether, 0.25 ether, solver);

        vm.prank(helperSolver);
        (uint256 sold, uint256 paidNewP) = rollSolver.mintAndFillAll{value: 0.8 ether}(
            factory, auction, newSeriesId, auctionId, 0.75 ether, helperSolver
        );

        assertEq(sold, 0.75 ether);
        assertEq(paidNewP, 0.75 ether);
        assertEq(oldP.balanceOf(helperSolver), 0.75 ether);
        assertEq(newP.balanceOf(seller), 1 ether);
        assertEq(newP.balanceOf(helperSolver), 0.05 ether);
        assertEq(newN.balanceOf(helperSolver), 0.8 ether);
        assertEq(auction.activeAuctionCount(), 0);
    }

    function testExternalSolverHelperMintsAndFillsBoostedRollAtomically() public {
        uint256 auctionId = _createBoostedAuction(1 ether);
        vm.warp(block.timestamp + 12 hours);

        vm.prank(helperSolver);
        uint256 paidNewN = rollSolver.mintAndFillN{value: 0.6 ether}(
            factory, auction, newSeriesId, auctionId, 0.5 ether, 0.5 ether, helperSolver
        );

        assertEq(paidNewN, 0.5 ether);
        assertEq(oldN.balanceOf(helperSolver), 0.5 ether);
        assertEq(newN.balanceOf(seller), 0.5 ether);
        assertEq(newN.balanceOf(helperSolver), 0.1 ether);
        assertEq(newP.balanceOf(helperSolver), 0.6 ether);
    }

    function testCallbackSolverHelperMintsDuringAuctionSettlement() public {
        uint256 auctionId = _createAuction(1 ether);
        vm.warp(block.timestamp + 12 hours);

        vm.prank(helperSolver);
        uint256 paidNewP = rollSolver.mintAndFillWithCallback{value: 0.6 ether}(
            factory, auction, newSeriesId, auctionId, 0.5 ether, 0.5 ether, helperSolver
        );

        assertEq(paidNewP, 0.5 ether);
        assertEq(oldP.balanceOf(helperSolver), 0.5 ether);
        assertEq(newP.balanceOf(seller), 0.5 ether);
        assertEq(newP.balanceOf(helperSolver), 0.1 ether);
        assertEq(newN.balanceOf(helperSolver), 0.6 ether);
        assertEq(oldP.balanceOf(address(rollSolver)), 0);
        assertEq(newP.balanceOf(address(rollSolver)), 0);
        assertEq(newN.balanceOf(address(rollSolver)), 0);
    }

    function testCallbackSolverHelperMintsBoostedSideDuringAuctionSettlement() public {
        uint256 auctionId = _createBoostedAuction(1 ether);
        vm.warp(block.timestamp + 12 hours);

        vm.prank(helperSolver);
        uint256 paidNewN = rollSolver.mintAndFillNWithCallback{value: 0.6 ether}(
            factory, auction, newSeriesId, auctionId, 0.5 ether, 0.5 ether, helperSolver
        );

        assertEq(paidNewN, 0.5 ether);
        assertEq(oldN.balanceOf(helperSolver), 0.5 ether);
        assertEq(newN.balanceOf(seller), 0.5 ether);
        assertEq(newN.balanceOf(helperSolver), 0.1 ether);
        assertEq(newP.balanceOf(helperSolver), 0.6 ether);
        assertEq(oldN.balanceOf(address(rollSolver)), 0);
        assertEq(newP.balanceOf(address(rollSolver)), 0);
        assertEq(newN.balanceOf(address(rollSolver)), 0);
    }

    function testCallbackSolverHelperFillAllClearsBoostedRemainder() public {
        uint256 auctionId = _createBoostedAuction(1 ether);
        vm.warp(block.timestamp + 12 hours);

        vm.prank(solver);
        newN.approve(address(auction), 0.4 ether);
        vm.prank(solver);
        auction.fill(auctionId, 0.4 ether, 0.4 ether, solver);

        vm.prank(helperSolver);
        (uint256 sold, uint256 paidNewN) = rollSolver.mintAndFillAllNWithCallback{value: 0.65 ether}(
            factory, auction, newSeriesId, auctionId, 0.6 ether, helperSolver
        );

        assertEq(sold, 0.6 ether);
        assertEq(paidNewN, 0.6 ether);
        assertEq(oldN.balanceOf(helperSolver), 0.6 ether);
        assertEq(newN.balanceOf(seller), 1 ether);
        assertEq(newN.balanceOf(helperSolver), 0.05 ether);
        assertEq(newP.balanceOf(helperSolver), 0.65 ether);
        assertEq(oldN.balanceOf(address(rollSolver)), 0);
        assertEq(newP.balanceOf(address(rollSolver)), 0);
        assertEq(newN.balanceOf(address(rollSolver)), 0);
        assertEq(auction.activeAuctionCount(), 0);
    }

    function testCallbackSolverRejectsDirectCallbackCalls() public {
        vm.prank(address(auction));
        vm.expectRevert(RollSolver.UnauthorizedCallback.selector);
        rollSolver.rollAuctionCall(helperSolver, 0, address(oldP), address(newP), 0.1 ether, 0.1 ether, "");
    }

    function testFillAllWithCallbackLetsPrefundedRouterClearAuction() public {
        uint256 auctionId = _createAuction(1 ether);
        PrefundedRollCallee callee = new PrefundedRollCallee(helperSolver);

        vm.prank(solver);
        newP.transfer(address(callee), 1 ether);

        vm.warp(block.timestamp + 12 hours);
        vm.prank(helperSolver);
        (uint256 sold, uint256 paid) = auction.fillAllWithCallback(auctionId, 1 ether, address(callee), "");

        assertEq(sold, 1 ether);
        assertEq(paid, 1 ether);
        assertEq(oldP.balanceOf(helperSolver), 1 ether);
        assertEq(newP.balanceOf(seller), 1 ether);
        assertEq(newP.balanceOf(address(callee)), 0);
        assertEq(auction.activeAuctionCount(), 0);
    }

    function testExternalSolverHelperRequiresEnoughMintedP() public {
        uint256 auctionId = _createAuction(1 ether);

        vm.prank(helperSolver);
        vm.expectRevert(RollSolver.InsufficientMintedP.selector);
        rollSolver.mintAndFill{value: 1 ether}(factory, auction, newSeriesId, auctionId, 1 ether, 2 ether, helperSolver);

        assertEq(newP.balanceOf(helperSolver), 0);
        assertEq(newN.balanceOf(helperSolver), 0);
    }

    function testExternalSolverHelperRequiresEnoughMintedN() public {
        uint256 auctionId = _createBoostedAuction(1 ether);

        vm.prank(helperSolver);
        vm.expectRevert(RollSolver.InsufficientMintedN.selector);
        rollSolver.mintAndFillN{value: 1 ether}(
            factory, auction, newSeriesId, auctionId, 1 ether, 2 ether, helperSolver
        );

        assertEq(newP.balanceOf(helperSolver), 0);
        assertEq(newN.balanceOf(helperSolver), 0);
    }

    function _createAuction(uint256 sellAmount) internal returns (uint256 auctionId) {
        vm.prank(seller);
        oldP.approve(address(auction), sellAmount);

        vm.prank(seller);
        auctionId = auction.createAuction(
            IERC20Like(address(oldP)), IERC20Like(address(newP)), sellAmount, START_PRICE, END_PRICE, 1 days, seller
        );
    }

    function _createBoostedAuction(uint256 sellAmount) internal returns (uint256 auctionId) {
        vm.prank(seller);
        oldN.approve(address(auction), sellAmount);

        vm.prank(seller);
        auctionId = auction.createAuction(
            IERC20Like(address(oldN)), IERC20Like(address(newN)), sellAmount, START_PRICE, END_PRICE, 1 days, seller
        );
    }

    function _tokens(bytes32 seriesId) internal view returns (MintBurnToken pToken, MintBurnToken nToken) {
        (,,,,,, pToken, nToken,,,) = factory.series(seriesId);
    }

    function assertEq(uint256 actual, uint256 expected) internal pure {
        require(actual == expected, "uint mismatch");
    }

    function assertEq(address actual, address expected) internal pure {
        require(actual == expected, "address mismatch");
    }
}
