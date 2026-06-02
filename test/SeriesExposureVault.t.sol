// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EthOptionsFactory} from "../src/EthOptionsFactory.sol";
import {RollAuction} from "../src/RollAuction.sol";
import {MockSettlementOracle} from "../src/oracle/MockSettlementOracle.sol";
import {MintBurnToken} from "../src/token/MintBurnToken.sol";
import {SeriesExposureVault} from "../src/vault/SeriesExposureVault.sol";

interface ExposureVm {
    function deal(address account, uint256 amount) external;
    function prank(address account) external;
    function warp(uint256 timestamp) external;
    function expectRevert(bytes4 selector) external;
}

contract SeriesExposureVaultTest {
    ExposureVm internal constant vm = ExposureVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    EthOptionsFactory internal factory;
    MockSettlementOracle internal oracle;
    RollAuction internal auction;
    bytes32 internal oldSeriesId;
    bytes32 internal newSeriesId;
    MintBurnToken internal oldP;
    MintBurnToken internal oldN;
    MintBurnToken internal newP;
    MintBurnToken internal newN;
    SeriesExposureVault internal steadyVault;
    SeriesExposureVault internal boostedVault;

    address internal user = address(0xA11CE);
    address internal solver = address(0xB0B);

    uint256 internal constant STRIKE = 1_000e18;
    uint32 internal constant TWAP_WINDOW = 72 hours;
    uint256 internal constant CAP = 100 ether;

    function setUp() public {
        factory = new EthOptionsFactory();
        oracle = new MockSettlementOracle();
        auction = new RollAuction(address(this), 0.01 ether, 16, 4);

        oldSeriesId = factory.createSeries(STRIKE, uint64(block.timestamp + 30 days), TWAP_WINDOW, CAP, oracle);
        newSeriesId = factory.createSeries(STRIKE, uint64(block.timestamp + 60 days), TWAP_WINDOW, CAP, oracle);
        (oldP, oldN) = _tokens(oldSeriesId);
        (newP, newN) = _tokens(newSeriesId);

        steadyVault = new SeriesExposureVault(oldP, address(this), "Steady ETH", "steadyETH", CAP);
        boostedVault = new SeriesExposureVault(oldN, address(this), "Boosted ETH", "boostedETH", CAP);

        vm.deal(user, 10 ether);
        vm.deal(solver, 10 ether);

        vm.prank(user);
        factory.mint{value: 2 ether}(oldSeriesId);

        vm.prank(solver);
        factory.mint{value: 2 ether}(newSeriesId);
    }

    function testUserCanDepositAndRedeemCurrentSeriesToken() public {
        vm.prank(user);
        oldP.approve(address(steadyVault), 1 ether);

        vm.prank(user);
        uint256 shares = steadyVault.deposit(1 ether, 1 ether, user);

        assertEq(shares, 1 ether);
        assertEq(steadyVault.share().balanceOf(user), 1 ether);
        assertEq(steadyVault.totalAssets(), 1 ether);

        vm.prank(user);
        uint256 assets = steadyVault.redeem(0.4 ether, 0.4 ether, user);

        assertEq(assets, 0.4 ether);
        assertEq(oldP.balanceOf(user), 1.4 ether);
        assertEq(steadyVault.share().balanceOf(user), 0.6 ether);
    }

    function testDepositCannotExceedWrapperCapacity() public {
        SeriesExposureVault cappedVault = new SeriesExposureVault(oldP, address(this), "Small Steady", "small", 1 ether);

        vm.prank(user);
        oldP.approve(address(cappedVault), 1.1 ether);

        vm.prank(user);
        cappedVault.deposit(0.8 ether, 0.8 ether, user);
        assertEq(cappedVault.remainingCapacity(), 0.2 ether);

        vm.prank(user);
        vm.expectRevert(SeriesExposureVault.CapacityExceeded.selector);
        cappedVault.deposit(0.3 ether, 0, user);
    }

    function testSteadyVaultRollsOldPToNewPThroughPublicAuction() public {
        _deposit(steadyVault, oldP, 1 ether);

        uint256 auctionId = steadyVault.startRoll(auction, newP, 1 ether, 1e18, 1e18, 1 days);

        vm.prank(solver);
        newP.approve(address(auction), 1 ether);

        vm.prank(solver);
        auction.fill(auctionId, 1 ether, 1 ether, solver);

        steadyVault.finalizeRoll();

        assertEq(address(steadyVault.currentToken()), address(newP));
        assertEq(newP.balanceOf(address(steadyVault)), 1 ether);
        assertEq(oldP.balanceOf(address(steadyVault)), 0);

        vm.prank(user);
        uint256 assets = steadyVault.redeem(1 ether, 1 ether, user);

        assertEq(assets, 1 ether);
        assertEq(newP.balanceOf(user), 1 ether);
    }

    function testWrapperRollMustCoverFullCurrentTokenBalance() public {
        _deposit(steadyVault, oldP, 1 ether);

        vm.expectRevert(SeriesExposureVault.PartialRoll.selector);
        steadyVault.startRoll(auction, newP, 0.5 ether, 1e18, 1e18, 1 days);
    }

    function testBoostedVaultRollsOldNToNewNThroughPublicAuction() public {
        _deposit(boostedVault, oldN, 1 ether);

        uint256 auctionId = boostedVault.startRoll(auction, newN, 1 ether, 1e18, 1e18, 1 days);

        vm.prank(solver);
        newN.approve(address(auction), 1 ether);

        vm.prank(solver);
        auction.fill(auctionId, 1 ether, 1 ether, solver);

        boostedVault.finalizeRoll();

        assertEq(address(boostedVault.currentToken()), address(newN));
        assertEq(newN.balanceOf(address(boostedVault)), 1 ether);
        assertEq(oldN.balanceOf(address(boostedVault)), 0);

        vm.prank(user);
        uint256 assets = boostedVault.redeem(1 ether, 1 ether, user);

        assertEq(assets, 1 ether);
        assertEq(newN.balanceOf(user), 1 ether);
    }

    function testDepositsAndRedemptionsPauseDuringRoll() public {
        _deposit(steadyVault, oldP, 1 ether);
        steadyVault.startRoll(auction, newP, 1 ether, 1e18, 1e18, 1 days);

        vm.prank(user);
        oldP.approve(address(steadyVault), 0.1 ether);

        vm.prank(user);
        vm.expectRevert(SeriesExposureVault.RollActive.selector);
        steadyVault.deposit(0.1 ether, 0, user);

        vm.prank(user);
        vm.expectRevert(SeriesExposureVault.RollActive.selector);
        steadyVault.redeem(0.1 ether, 0, user);
    }

    function testUnfilledRollCanBeCancelled() public {
        _deposit(steadyVault, oldP, 1 ether);
        uint256 auctionId = steadyVault.startRoll(auction, newP, 1 ether, 1e18, 1e18, 1 days);

        steadyVault.cancelUnfilledRoll();

        assertEq(steadyVault.rollActive() ? 1 : 0, 0);
        assertEq(oldP.balanceOf(address(steadyVault)), 1 ether);

        vm.expectRevert(RollAuction.AuctionClosed.selector);
        auction.quote(auctionId, 1 ether);
    }

    function testPartiallyFilledRollCannotBeCancelledOrFinalized() public {
        _deposit(steadyVault, oldP, 1 ether);
        uint256 auctionId = steadyVault.startRoll(auction, newP, 1 ether, 1e18, 1e18, 1 days);

        vm.prank(solver);
        newP.approve(address(auction), 0.5 ether);

        vm.prank(solver);
        auction.fill(auctionId, 0.5 ether, 0.5 ether, solver);

        vm.expectRevert(SeriesExposureVault.PartialFillCannotCancel.selector);
        steadyVault.cancelUnfilledRoll();

        vm.expectRevert(SeriesExposureVault.RollNotFilled.selector);
        steadyVault.finalizeRoll();
    }

    function testExpiredPartiallyFilledRollCanBeResetAndFinished() public {
        _deposit(steadyVault, oldP, 1 ether);
        uint256 auctionId = steadyVault.startRoll(auction, newP, 1 ether, 1.02e18, 0.98e18, 1 days);
        vm.warp(block.timestamp + 12 hours);

        vm.prank(solver);
        newP.approve(address(auction), 0.5 ether);

        vm.prank(solver);
        auction.fill(auctionId, 0.5 ether, 0.5 ether, solver);

        vm.warp(block.timestamp + 12 hours + 1);
        steadyVault.resetRoll(1.01e18, 0.99e18, 1 days);
        assertEq(auction.currentPriceWad(auctionId), 1.01e18);

        vm.prank(solver);
        newP.approve(address(auction), 0.505 ether);

        vm.prank(solver);
        auction.fill(auctionId, 0.5 ether, 0.505 ether, solver);

        steadyVault.finalizeRoll();

        assertEq(address(steadyVault.currentToken()), address(newP));
        assertEq(oldP.balanceOf(address(steadyVault)), 0);
        assertEq(newP.balanceOf(address(steadyVault)), 1.005 ether);
    }

    function _deposit(SeriesExposureVault vault, MintBurnToken token, uint256 amount) internal {
        vm.prank(user);
        token.approve(address(vault), amount);

        vm.prank(user);
        vault.deposit(amount, amount, user);
    }

    function _tokens(bytes32 id) internal view returns (MintBurnToken pToken, MintBurnToken nToken) {
        (,,,,,, pToken, nToken,,,) = factory.series(id);
    }

    function assertEq(uint256 actual, uint256 expected) internal pure {
        require(actual == expected, "uint mismatch");
    }

    function assertEq(address actual, address expected) internal pure {
        require(actual == expected, "address mismatch");
    }
}
