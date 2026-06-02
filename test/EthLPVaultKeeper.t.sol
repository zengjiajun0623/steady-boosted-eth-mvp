// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EthOptionsFactory} from "../src/EthOptionsFactory.sol";
import {RollAuction, IERC20Like} from "../src/RollAuction.sol";
import {MockSettlementOracle} from "../src/oracle/MockSettlementOracle.sol";
import {MintBurnToken} from "../src/token/MintBurnToken.sol";
import {EthTokenAMM} from "../src/market/EthTokenAMM.sol";
import {EthLPVault} from "../src/vault/EthLPVault.sol";
import {EthLPVaultKeeper} from "../src/vault/EthLPVaultKeeper.sol";

interface KeeperVm {
    function deal(address account, uint256 amount) external;
    function prank(address account) external;
    function warp(uint256 timestamp) external;
    function expectRevert(bytes4 selector) external;
}

contract EthLPVaultKeeperTest {
    KeeperVm internal constant vm = KeeperVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    EthOptionsFactory internal factory;
    MockSettlementOracle internal oracle;
    RollAuction internal auction;
    EthLPVault internal vault;
    EthLPVaultKeeper internal keeper;
    bytes32 internal oldSeriesId;
    bytes32 internal newSeriesId;
    MintBurnToken internal oldP;
    MintBurnToken internal oldN;
    MintBurnToken internal newP;
    MintBurnToken internal newN;

    address internal alice = address(0xA11CE);
    address internal steadyVault = address(0x5757);
    address internal boostedVault = address(0xB0057);
    address internal caller = address(0xCA11);
    address internal marketMaker = address(0xD00D);

    uint256 internal constant STRIKE = 1_000e18;
    uint32 internal constant TWAP_WINDOW = 72 hours;
    uint256 internal constant CAP = 100 ether;
    uint256 internal constant MIN_REWARDED_AMOUNT = 0.1 ether;
    uint256 internal constant KEEPER_REWARD = 0.01 ether;
    uint256 internal constant MIN_INVENTORY_SALE_PRICE = 0.95e18;

    function setUp() public {
        keeper = new EthLPVaultKeeper(MIN_REWARDED_AMOUNT, KEEPER_REWARD);
        vault = new EthLPVault(
            address(keeper),
            4 days,
            1 ether,
            1.2 ether,
            1.05e18,
            MIN_INVENTORY_SALE_PRICE,
            12 hours,
            4 hours,
            6 hours,
            200
        );
        keeper.setVault(vault);
        keeper.setRollSellers(steadyVault, boostedVault);

        factory = new EthOptionsFactory();
        oracle = new MockSettlementOracle();
        auction = new RollAuction(address(this), 0.01 ether, 16, 4);

        oldSeriesId = factory.createSeries(STRIKE, uint64(block.timestamp + 30 days), TWAP_WINDOW, CAP, oracle);
        newSeriesId = factory.createSeries(STRIKE, uint64(block.timestamp + 60 days), TWAP_WINDOW, CAP, oracle);
        (oldP, oldN) = _tokens(oldSeriesId);
        (newP, newN) = _tokens(newSeriesId);

        vm.deal(alice, 10 ether);
        vm.deal(steadyVault, 10 ether);
        vm.deal(boostedVault, 10 ether);
        vm.deal(marketMaker, 20 ether);

        vm.prank(alice);
        vault.deposit{value: 2 ether}();
    }

    function testAnyCallerCanExecuteAllowedVaultBidThroughKeeper() public {
        uint256 auctionId = _createOldPAuction(1 ether);

        vm.warp(block.timestamp + 12 hours);
        vm.prank(caller);
        uint256 newPPaid = keeper.fillSteadyRoll(
            factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.6 ether, 0.5 ether
        );

        assertEq(newPPaid, 0.5 ether);
        assertEq(vault.strategyActive() ? 1 : 0, 1);
        assertEq(vault.manager(), address(keeper));
        assertEq(oldP.balanceOf(address(vault)), 0.5 ether);
        assertEq(newP.balanceOf(address(vault)), 0.1 ether);
        assertEq(newN.balanceOf(address(vault)), 0.6 ether);
    }

    function testAnyCallerCanExecuteBoostedVaultBidThroughKeeper() public {
        uint256 auctionId = _createOldNAuction(1 ether);

        vm.warp(block.timestamp + 12 hours);
        vm.prank(caller);
        uint256 newNPaid = keeper.fillBoostedRoll(
            factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.6 ether, 0.5 ether
        );

        assertEq(newNPaid, 0.5 ether);
        assertEq(vault.strategyActive() ? 1 : 0, 1);
        assertEq(vault.manager(), address(keeper));
        assertEq(oldN.balanceOf(address(vault)), 0.5 ether);
        assertEq(newP.balanceOf(address(vault)), 0.6 ether);
        assertEq(newN.balanceOf(address(vault)), 0.1 ether);
    }

    function testFundedKeeperRewardPaysOnUsefulVaultBid() public {
        uint256 auctionId = _createOldPAuction(1 ether);
        vm.deal(address(keeper), 3 * KEEPER_REWARD);

        uint256 callerBefore = caller.balance;
        vm.warp(block.timestamp + 12 hours);
        vm.prank(caller);
        keeper.fillSteadyRoll(factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.6 ether, 0.5 ether);

        assertEq(caller.balance, callerBefore + KEEPER_REWARD);
        assertEq(address(keeper).balance, 2 * KEEPER_REWARD);
    }

    function testDirectVaultStrategyCallStillRequiresKeeperManager() public {
        uint256 auctionId = _createOldPAuction(1 ether);

        vm.warp(block.timestamp + 12 hours);
        vm.prank(caller);
        vm.expectRevert(EthLPVault.NotManager.selector);
        vault.fillSteadyRoll(factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.6 ether, 0.5 ether);
    }

    function testKeeperRejectsRollBeforeAllowedSellersAreSet() public {
        EthLPVaultKeeper freshKeeper = new EthLPVaultKeeper(MIN_REWARDED_AMOUNT, 0);
        EthLPVault freshVault =
            new EthLPVault(
                address(freshKeeper),
                4 days,
                1 ether,
                1.2 ether,
                1.05e18,
                MIN_INVENTORY_SALE_PRICE,
                12 hours,
                4 hours,
                6 hours,
                200
            );
        freshKeeper.setVault(freshVault);
        vm.prank(alice);
        freshVault.deposit{value: 2 ether}();
        uint256 auctionId = _createOldPAuction(1 ether);

        vm.warp(block.timestamp + 12 hours);
        vm.expectRevert(EthLPVaultKeeper.RollSellersNotSet.selector);
        freshKeeper.fillSteadyRoll(
            factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.6 ether, 0.5 ether
        );
    }

    function testKeeperRejectsUnauthorizedRollSeller() public {
        address outsider = address(0xBAD);
        uint256 auctionId = _createOutsiderOldPAuction(outsider, 1 ether);

        vm.warp(block.timestamp + 12 hours);
        vm.prank(caller);
        vm.expectRevert(EthLPVaultKeeper.UnauthorizedRollAuction.selector);
        keeper.fillSteadyRoll(factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.6 ether, 0.5 ether);
    }

    function testKeeperRejectsUnauthorizedRollBeneficiary() public {
        address outsider = address(0xBAD);
        uint256 auctionId = _createOldPAuctionWithBeneficiary(1 ether, outsider);

        vm.warp(block.timestamp + 12 hours);
        vm.prank(caller);
        vm.expectRevert(EthLPVaultKeeper.UnauthorizedRollAuction.selector);
        keeper.fillSteadyRoll(factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.6 ether, 0.5 ether);
    }

    function testKeeperStillCannotBypassVaultPolicy() public {
        uint256 auctionId = _createOldPAuction(1 ether, 1.1e18, 1.1e18, 1 days);

        vm.prank(caller);
        vm.expectRevert(EthLPVault.StrategyPolicyViolation.selector);
        keeper.fillSteadyRoll(factory, auction, oldSeriesId, newSeriesId, auctionId, 1 ether, 1.1 ether, 1.1 ether);
    }

    function testPermissionlessKeeperCanRedeemAndCloseStrategy() public {
        uint256 auctionId = _createOldPAuction(1 ether);

        vm.warp(block.timestamp + 12 hours);
        vm.prank(caller);
        keeper.fillSteadyRoll(factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.6 ether, 0.5 ether);

        vm.warp(block.timestamp + 60 days);
        oracle.setSettlementPrice(oldSeriesId, 2_000e18);
        oracle.setSettlementPrice(newSeriesId, 2_000e18);
        factory.settle(oldSeriesId);
        factory.settle(newSeriesId);

        vm.prank(caller);
        keeper.redeemP(factory, oldSeriesId, 0.5 ether);
        vm.prank(caller);
        keeper.redeemP(factory, newSeriesId, 0.1 ether);
        vm.prank(caller);
        keeper.redeemN(factory, newSeriesId, 0.6 ether);
        vm.prank(caller);
        keeper.closeStrategy();

        assertEq(vault.strategyActive() ? 1 : 0, 0);
        assertEq(vault.activeStrategyEth(), 0);
    }

    function testPermissionlessKeeperCanMergeMatchedInventoryAfterMaturityBeforeSettlement() public {
        uint256 auctionId = _createOldPAuction(1 ether);
        vm.deal(address(keeper), 2 * KEEPER_REWARD);

        vm.warp(block.timestamp + 12 hours);
        vm.prank(caller);
        keeper.fillSteadyRoll(factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.6 ether, 0.5 ether);

        uint256 managedBefore = vault.managedAssets();
        uint256 callerBefore = caller.balance;
        vm.warp(block.timestamp + 60 days);
        vm.prank(caller);
        keeper.mergeSeries(factory, newSeriesId, 0.1 ether);

        assertEq(vault.managedAssets(), managedBefore + 0.1 ether);
        assertEq(newP.balanceOf(address(vault)), 0);
        assertEq(newN.balanceOf(address(vault)), 0.5 ether);
        assertEq(caller.balance, callerBefore + KEEPER_REWARD);
    }

    function testPermissionlessKeeperCanSellInventoryThroughPublicAmm() public {
        uint256 auctionId = _createOldPAuction(1 ether);
        vm.deal(address(keeper), 2 * KEEPER_REWARD);

        vm.warp(block.timestamp + 12 hours);
        vm.prank(caller);
        keeper.fillSteadyRoll(factory, auction, oldSeriesId, newSeriesId, auctionId, 0.5 ether, 0.6 ether, 0.5 ether);

        EthTokenAMM market = _seedMarket(newN, "newN direct market", "newN-LP");
        uint256 quote = market.quoteSellToken(0.2 ether);
        uint256 managedBefore = vault.managedAssets();
        uint256 callerBefore = caller.balance;

        vm.prank(caller);
        uint256 ethOut = keeper.sellInventory(factory, newSeriesId, true, market, 0.2 ether, quote);

        assertEq(ethOut, quote);
        assertEq(vault.managedAssets(), managedBefore + quote);
        assertEq(newN.balanceOf(address(vault)), 0.4 ether);
        assertEq(caller.balance, callerBefore + KEEPER_REWARD);
    }

    function testInactiveCloseDoesNotDrainKeeperRewards() public {
        vm.deal(address(keeper), KEEPER_REWARD);

        uint256 callerBefore = caller.balance;
        vm.prank(caller);
        keeper.closeStrategy();

        assertEq(caller.balance, callerBefore);
        assertEq(address(keeper).balance, KEEPER_REWARD);
    }

    function testOnlyDeployerCanAttachVaultOnce() public {
        EthLPVaultKeeper freshKeeper = new EthLPVaultKeeper(MIN_REWARDED_AMOUNT, 0);
        EthLPVault freshVault =
            new EthLPVault(
                address(freshKeeper),
                4 days,
                1 ether,
                1.2 ether,
                1.05e18,
                MIN_INVENTORY_SALE_PRICE,
                12 hours,
                4 hours,
                6 hours,
                200
            );

        vm.prank(caller);
        vm.expectRevert(EthLPVaultKeeper.NotDeployer.selector);
        freshKeeper.setVault(freshVault);

        freshKeeper.setVault(freshVault);

        vm.expectRevert(EthLPVaultKeeper.VaultAlreadySet.selector);
        freshKeeper.setVault(freshVault);

        vm.expectRevert(EthLPVaultKeeper.InvalidConfig.selector);
        freshKeeper.setRollSellers(address(0), boostedVault);

        freshKeeper.setRollSellers(steadyVault, boostedVault);
        assertEq(freshKeeper.steadyRollSeller(), steadyVault);
        assertEq(freshKeeper.boostedRollSeller(), boostedVault);
        assertEq(freshKeeper.rollSellersSet() ? uint256(1) : uint256(0), 1);

        vm.expectRevert(EthLPVaultKeeper.RollSellersAlreadySet.selector);
        freshKeeper.setRollSellers(steadyVault, boostedVault);
    }

    function _createOldPAuction(uint256 oldPAmount) internal returns (uint256 auctionId) {
        return _createOldPAuction(oldPAmount, 1.02e18, 0.98e18, 1 days);
    }

    function _createOldPAuction(uint256 oldPAmount, uint256 startPrice, uint256 endPrice, uint64 duration)
        internal
        returns (uint256 auctionId)
    {
        return _createOldPAuctionWithBeneficiary(oldPAmount, steadyVault, startPrice, endPrice, duration);
    }

    function _createOldPAuctionWithBeneficiary(uint256 oldPAmount, address beneficiary)
        internal
        returns (uint256 auctionId)
    {
        return _createOldPAuctionWithBeneficiary(oldPAmount, beneficiary, 1.02e18, 0.98e18, 1 days);
    }

    function _createOldPAuctionWithBeneficiary(
        uint256 oldPAmount,
        address beneficiary,
        uint256 startPrice,
        uint256 endPrice,
        uint64 duration
    ) internal returns (uint256 auctionId) {
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
            beneficiary
        );
    }

    function _createOutsiderOldPAuction(address outsider, uint256 oldPAmount) internal returns (uint256 auctionId) {
        vm.deal(outsider, 10 ether);
        vm.prank(outsider);
        factory.mint{value: oldPAmount}(oldSeriesId);

        vm.prank(outsider);
        oldP.approve(address(auction), oldPAmount);

        vm.prank(outsider);
        auctionId = auction.createAuction(
            IERC20Like(address(oldP)),
            IERC20Like(address(newP)),
            oldPAmount,
            1.02e18,
            0.98e18,
            1 days,
            outsider
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

    function assertEq(uint256 actual, uint256 expected) internal pure {
        require(actual == expected, "uint mismatch");
    }

    function assertEq(address actual, address expected) internal pure {
        require(actual == expected, "address mismatch");
    }
}
