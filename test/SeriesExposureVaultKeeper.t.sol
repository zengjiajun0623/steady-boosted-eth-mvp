// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EthOptionsFactory} from "../src/EthOptionsFactory.sol";
import {RollAuction} from "../src/RollAuction.sol";
import {MockSettlementOracle} from "../src/oracle/MockSettlementOracle.sol";
import {MintBurnToken} from "../src/token/MintBurnToken.sol";
import {SeriesExposureVault} from "../src/vault/SeriesExposureVault.sol";
import {SeriesExposureVaultKeeper} from "../src/vault/SeriesExposureVaultKeeper.sol";

interface SeriesKeeperVm {
    function deal(address account, uint256 amount) external;
    function prank(address account) external;
    function warp(uint256 timestamp) external;
    function expectRevert(bytes4 selector) external;
}

contract SeriesExposureVaultKeeperTest {
    SeriesKeeperVm internal constant vm = SeriesKeeperVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    EthOptionsFactory internal factory;
    MockSettlementOracle internal oracle;
    RollAuction internal auction;
    SeriesExposureVaultKeeper internal steadyKeeper;
    SeriesExposureVaultKeeper internal boostedKeeper;
    SeriesExposureVault internal steadyVault;
    SeriesExposureVault internal boostedVault;

    bytes32 internal oldSeriesId;
    bytes32 internal newSeriesId;
    MintBurnToken internal oldP;
    MintBurnToken internal oldN;
    MintBurnToken internal newP;
    MintBurnToken internal newN;

    address internal user = address(0xA11CE);
    address internal solver = address(0xB0B);
    address internal caller = address(0xCA11);

    uint256 internal constant STRIKE = 1_000e18;
    uint32 internal constant TWAP_WINDOW = 72 hours;
    uint256 internal constant CAP = 100 ether;
    uint256 internal constant MIN_ROLL_AMOUNT = 0.1 ether;
    uint256 internal constant MAX_ROLL_AMOUNT = 1.5 ether;
    uint256 internal constant KEEPER_REWARD = 0.01 ether;

    function setUp() public {
        factory = new EthOptionsFactory();
        oracle = new MockSettlementOracle();
        auction = new RollAuction(address(this), 0.01 ether, 16, 4);

        oldSeriesId = factory.createSeries(STRIKE, uint64(block.timestamp + 30 days), TWAP_WINDOW, CAP, oracle);
        newSeriesId = factory.createSeries(STRIKE, uint64(block.timestamp + 60 days), TWAP_WINDOW, CAP, oracle);
        (oldP, oldN) = _tokens(oldSeriesId);
        (newP, newN) = _tokens(newSeriesId);

        steadyKeeper = new SeriesExposureVaultKeeper(
            factory, auction, false, 1.03e18, 0.98e18, 12 hours, 3 days, MIN_ROLL_AMOUNT, MAX_ROLL_AMOUNT, KEEPER_REWARD
        );
        boostedKeeper = new SeriesExposureVaultKeeper(
            factory, auction, true, 1.04e18, 0.97e18, 12 hours, 3 days, MIN_ROLL_AMOUNT, MAX_ROLL_AMOUNT, KEEPER_REWARD
        );
        steadyVault = new SeriesExposureVault(oldP, address(steadyKeeper), "Steady ETH", "steadyETH", MAX_ROLL_AMOUNT);
        boostedVault =
            new SeriesExposureVault(oldN, address(boostedKeeper), "Boosted ETH", "boostedETH", MAX_ROLL_AMOUNT);
        steadyKeeper.setVault(steadyVault, oldSeriesId);
        boostedKeeper.setVault(boostedVault, oldSeriesId);

        vm.deal(user, 10 ether);
        vm.deal(solver, 10 ether);

        vm.prank(user);
        factory.mint{value: 2 ether}(oldSeriesId);

        vm.prank(solver);
        factory.mint{value: 2 ether}(newSeriesId);
    }

    function testAnyCallerCanStartAndFinalizeSteadyRollThroughKeeper() public {
        _deposit(steadyVault, oldP, 1 ether);

        vm.prank(caller);
        uint256 auctionId = steadyKeeper.startRoll(newSeriesId, 1 ether, 1.01e18, 0.99e18, 1 days);

        vm.prank(solver);
        newP.approve(address(auction), 1.01 ether);

        vm.prank(solver);
        auction.fill(auctionId, 1 ether, 1.01 ether, solver);

        vm.prank(caller);
        steadyKeeper.finalizeRoll();

        assertEq(address(steadyVault.currentToken()), address(newP));
        assertEq(steadyKeeper.currentSeriesId(), newSeriesId);
        assertEq(steadyKeeper.pendingSeriesId(), bytes32(0));
    }

    function testAnyCallerCanStartAndFinalizeBoostedRollThroughKeeper() public {
        _deposit(boostedVault, oldN, 1 ether);

        vm.prank(caller);
        uint256 auctionId = boostedKeeper.startRoll(newSeriesId, 1 ether, 1.02e18, 0.98e18, 1 days);

        vm.prank(solver);
        newN.approve(address(auction), 1.02 ether);

        vm.prank(solver);
        auction.fill(auctionId, 1 ether, 1.02 ether, solver);

        vm.prank(caller);
        boostedKeeper.finalizeRoll();

        assertEq(address(boostedVault.currentToken()), address(newN));
        assertEq(boostedKeeper.currentSeriesId(), newSeriesId);
    }

    function testFundedKeeperRewardPaysOnFinalize() public {
        _deposit(steadyVault, oldP, 1 ether);
        vm.deal(address(steadyKeeper), 2 * KEEPER_REWARD);

        vm.prank(caller);
        uint256 auctionId = steadyKeeper.startRoll(newSeriesId, 1 ether, 1.01e18, 0.99e18, 1 days);

        vm.prank(solver);
        newP.approve(address(auction), 1.01 ether);

        vm.prank(solver);
        auction.fill(auctionId, 1 ether, 1.01 ether, solver);

        uint256 callerBefore = caller.balance;
        vm.prank(caller);
        steadyKeeper.finalizeRoll();

        assertEq(caller.balance, callerBefore + KEEPER_REWARD);
        assertEq(address(steadyKeeper).balance, 0);
    }

    function testFundedKeeperRewardPaysOnStartRoll() public {
        _deposit(steadyVault, oldP, 1 ether);
        vm.deal(address(steadyKeeper), KEEPER_REWARD);

        uint256 callerBefore = caller.balance;
        vm.prank(caller);
        steadyKeeper.startRoll(newSeriesId, 1 ether, 1.01e18, 0.99e18, 1 days);

        assertEq(caller.balance, callerBefore + KEEPER_REWARD);
        assertEq(address(steadyKeeper).balance, 0);
    }

    function testDirectWrapperRollStillRequiresKeeperManager() public {
        _deposit(steadyVault, oldP, 1 ether);

        vm.prank(caller);
        vm.expectRevert(SeriesExposureVault.NotManager.selector);
        steadyVault.startRoll(auction, newP, 1 ether, 1e18, 1e18, 1 days);
    }

    function testKeeperRejectsRollsOutsidePolicy() public {
        _deposit(steadyVault, oldP, 1 ether);

        vm.prank(caller);
        vm.expectRevert(SeriesExposureVaultKeeper.RollPolicyViolation.selector);
        steadyKeeper.startRoll(newSeriesId, 1 ether, 1.04e18, 0.99e18, 1 days);

        vm.prank(caller);
        vm.expectRevert(SeriesExposureVaultKeeper.RollPolicyViolation.selector);
        steadyKeeper.startRoll(newSeriesId, 1 ether, 1.01e18, 0.97e18, 1 days);

        vm.prank(caller);
        vm.expectRevert(SeriesExposureVaultKeeper.RollPolicyViolation.selector);
        steadyKeeper.startRoll(newSeriesId, 1 ether, 1.01e18, 0.99e18, 1 hours);
    }

    function testKeeperRejectsDustRolls() public {
        _deposit(steadyVault, oldP, 1 ether);

        vm.prank(caller);
        vm.expectRevert(SeriesExposureVaultKeeper.RollPolicyViolation.selector);
        steadyKeeper.startRoll(newSeriesId, MIN_ROLL_AMOUNT - 1, 1.01e18, 0.99e18, 1 days);
    }

    function testKeeperRejectsOversizedWrapperRolls() public {
        _deposit(steadyVault, oldP, MAX_ROLL_AMOUNT);

        vm.prank(user);
        oldP.transfer(address(steadyVault), 0.5 ether);

        vm.prank(caller);
        vm.expectRevert(SeriesExposureVaultKeeper.RollPolicyViolation.selector);
        steadyKeeper.startRoll(newSeriesId, 2 ether, 1.01e18, 0.99e18, 1 days);
    }

    function testWrapperDepositCannotGrowPastRollCapacity() public {
        _deposit(steadyVault, oldP, 1 ether);

        vm.prank(user);
        oldP.approve(address(steadyVault), 0.6 ether);

        vm.prank(user);
        vm.expectRevert(SeriesExposureVault.CapacityExceeded.selector);
        steadyVault.deposit(0.6 ether, 0, user);
    }

    function testKeeperRejectsVaultWithWrongSeriesSide() public {
        SeriesExposureVaultKeeper keeper = new SeriesExposureVaultKeeper(
            factory, auction, false, 1.03e18, 0.98e18, 12 hours, 3 days, MIN_ROLL_AMOUNT, MAX_ROLL_AMOUNT, KEEPER_REWARD
        );
        SeriesExposureVault wrongVault = new SeriesExposureVault(oldN, address(keeper), "Wrong", "WRONG", CAP);

        vm.expectRevert(SeriesExposureVaultKeeper.InvalidVault.selector);
        keeper.setVault(wrongVault, oldSeriesId);
    }

    function testKeeperRejectsIncompatibleSeriesMetadata() public {
        _deposit(steadyVault, oldP, 1 ether);

        bytes32 differentStrike =
            factory.createSeries(1_100e18, uint64(block.timestamp + 75 days), TWAP_WINDOW, CAP, oracle);
        vm.prank(caller);
        vm.expectRevert(SeriesExposureVaultKeeper.InvalidSeries.selector);
        steadyKeeper.startRoll(differentStrike, 1 ether, 1.01e18, 0.99e18, 1 days);

        bytes32 differentTwap = factory.createSeries(STRIKE, uint64(block.timestamp + 90 days), 48 hours, CAP, oracle);
        vm.prank(caller);
        vm.expectRevert(SeriesExposureVaultKeeper.InvalidSeries.selector);
        steadyKeeper.startRoll(differentTwap, 1 ether, 1.01e18, 0.99e18, 1 days);

        MockSettlementOracle otherOracle = new MockSettlementOracle();
        bytes32 differentOracle =
            factory.createSeries(STRIKE, uint64(block.timestamp + 105 days), TWAP_WINDOW, CAP, otherOracle);
        vm.prank(caller);
        vm.expectRevert(SeriesExposureVaultKeeper.InvalidSeries.selector);
        steadyKeeper.startRoll(differentOracle, 1 ether, 1.01e18, 0.99e18, 1 days);
    }

    function testUnfilledRollCanOnlyBeCancelledAfterAuctionDuration() public {
        _deposit(steadyVault, oldP, 1 ether);
        vm.deal(address(steadyKeeper), 2 * KEEPER_REWARD);

        vm.prank(caller);
        uint256 auctionId = steadyKeeper.startRoll(newSeriesId, 1 ether, 1.01e18, 0.99e18, 1 days);

        vm.prank(caller);
        vm.expectRevert(SeriesExposureVaultKeeper.AuctionStillRunning.selector);
        steadyKeeper.cancelUnfilledRoll();

        uint256 callerBefore = caller.balance;
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(caller);
        steadyKeeper.cancelUnfilledRoll();

        assertEq(caller.balance, callerBefore + KEEPER_REWARD);
        assertEq(steadyKeeper.pendingSeriesId(), bytes32(0));
        assertEq(steadyVault.rollActive() ? 1 : 0, 0);
        assertEq(steadyVault.depositsPaused() ? 1 : 0, 1);
        assertEq(steadyVault.remainingCapacity(), 0);
        vm.expectRevert(RollAuction.AuctionClosed.selector);
        auction.quote(auctionId, 1 ether);
    }

    function testKeeperCanResetExpiredPartiallyFilledRoll() public {
        auction.setStaleResetPolicy(0, 0);
        _deposit(steadyVault, oldP, 1 ether);
        vm.deal(address(steadyKeeper), 2 * KEEPER_REWARD);

        vm.prank(caller);
        uint256 auctionId = steadyKeeper.startRoll(newSeriesId, 1 ether, 1.01e18, 0.99e18, 1 days);
        vm.warp(block.timestamp + 12 hours);

        vm.prank(solver);
        newP.approve(address(auction), 0.5 ether);

        vm.prank(solver);
        auction.fill(auctionId, 0.5 ether, 0.5 ether, solver);

        vm.prank(caller);
        vm.expectRevert(RollAuction.AuctionStillRunning.selector);
        steadyKeeper.resetRoll(1.01e18, 0.99e18, 1 days);

        uint256 callerBefore = caller.balance;
        vm.warp(block.timestamp + 12 hours + 1);
        vm.prank(caller);
        steadyKeeper.resetRoll(1.01e18, 0.99e18, 1 days);

        assertEq(caller.balance, callerBefore + KEEPER_REWARD);
        assertEq(auction.currentPriceWad(auctionId), 1.01e18);
        assertEq(steadyKeeper.pendingSeriesId(), newSeriesId);

        vm.prank(solver);
        newP.approve(address(auction), 0.505 ether);

        vm.prank(solver);
        auction.fill(auctionId, 0.5 ether, 0.505 ether, solver);

        vm.prank(caller);
        steadyKeeper.finalizeRoll();

        assertEq(address(steadyVault.currentToken()), address(newP));
        assertEq(steadyKeeper.currentSeriesId(), newSeriesId);
        assertEq(steadyKeeper.pendingSeriesId(), bytes32(0));
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

    function assertEq(bytes32 actual, bytes32 expected) internal pure {
        require(actual == expected, "bytes32 mismatch");
    }
}
