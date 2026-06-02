// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EthOptionsFactory} from "../src/EthOptionsFactory.sol";
import {EthTokenAMM} from "../src/market/EthTokenAMM.sol";
import {IERC20Like} from "../src/RollAuction.sol";
import {MockSettlementOracle} from "../src/oracle/MockSettlementOracle.sol";
import {MintBurnToken} from "../src/token/MintBurnToken.sol";

interface MarketVm {
    function deal(address account, uint256 amount) external;
    function prank(address account) external;
    function expectRevert(bytes4 selector) external;
}

contract EthTokenAMMTest {
    MarketVm internal constant vm = MarketVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    EthOptionsFactory internal factory;
    MockSettlementOracle internal oracle;
    bytes32 internal seriesId;
    MintBurnToken internal steady;
    MintBurnToken internal boosted;
    EthTokenAMM internal steadyMarket;
    EthTokenAMM internal boostedMarket;

    address internal lp = address(0x11);
    address internal trader = address(0x22);

    uint256 internal constant STRIKE = 1_000e18;
    uint32 internal constant TWAP_WINDOW = 72 hours;
    uint256 internal constant CAP = 100 ether;

    function setUp() public {
        factory = new EthOptionsFactory();
        oracle = new MockSettlementOracle();
        seriesId = factory.createSeries(STRIKE, uint64(block.timestamp + 30 days), TWAP_WINDOW, CAP, oracle);
        (steady, boosted) = _tokens(seriesId);

        steadyMarket = new EthTokenAMM(IERC20Like(address(steady)), "Steady ETH LP", "stETH-LP", 30);
        boostedMarket = new EthTokenAMM(IERC20Like(address(boosted)), "Boosted ETH LP", "bstETH-LP", 30);

        vm.deal(lp, 20 ether);
        vm.deal(trader, 10 ether);

        vm.prank(lp);
        factory.mint{value: 10 ether}(seriesId);
    }

    function testTraderCanBuyAndSellSteadyEth() public {
        _seedMarket(steadyMarket, steady, 5 ether, 5 ether);

        uint256 quotedSteady = steadyMarket.quoteBuyToken(1 ether);

        vm.prank(trader);
        uint256 steadyBought = steadyMarket.buyToken{value: 1 ether}(quotedSteady, trader);

        assertEq(steady.balanceOf(trader), steadyBought);
        assertEq(steadyBought, quotedSteady);
        assertEq(steadyMarket.ethReserve(), 6 ether);
        assertEq(steadyMarket.tokenReserve(), 5 ether - steadyBought);

        vm.prank(trader);
        steady.approve(address(steadyMarket), steadyBought);

        uint256 quotedEth = steadyMarket.quoteSellToken(steadyBought / 2);
        uint256 balanceBefore = trader.balance;

        vm.prank(trader);
        uint256 ethOut = steadyMarket.sellToken(steadyBought / 2, quotedEth, trader);

        assertEq(ethOut, quotedEth);
        assertEq(trader.balance, balanceBefore + ethOut);
        assertEq(steady.balanceOf(trader), steadyBought - steadyBought / 2);
    }

    function testTraderCanBuyAndSellBoostedEth() public {
        _seedMarket(boostedMarket, boosted, 5 ether, 2.5 ether);

        uint256 quotedBoosted = boostedMarket.quoteBuyToken(0.5 ether);

        vm.prank(trader);
        uint256 boostedBought = boostedMarket.buyToken{value: 0.5 ether}(quotedBoosted, trader);

        assertEq(boosted.balanceOf(trader), boostedBought);
        assertEq(boostedBought, quotedBoosted);

        vm.prank(trader);
        boosted.approve(address(boostedMarket), boostedBought);

        uint256 quotedEth = boostedMarket.quoteSellToken(boostedBought);
        uint256 balanceBefore = trader.balance;

        vm.prank(trader);
        uint256 ethOut = boostedMarket.sellToken(boostedBought, quotedEth, trader);

        assertEq(ethOut, quotedEth);
        assertEq(trader.balance, balanceBefore + ethOut);
        assertEq(boosted.balanceOf(trader), 0);
    }

    function testLiquidityProviderCanRemoveEarnedFees() public {
        _seedMarket(steadyMarket, steady, 5 ether, 5 ether);
        MintBurnToken lpToken = steadyMarket.lpToken();

        vm.prank(trader);
        steadyMarket.buyToken{value: 1 ether}(0, trader);

        vm.prank(lp);
        lpToken.approve(address(steadyMarket), lpToken.balanceOf(lp));

        uint256 balanceBefore = lp.balance;
        uint256 shares = lpToken.balanceOf(lp);

        vm.prank(lp);
        (uint256 ethOut, uint256 tokenOut) = steadyMarket.removeLiquidity(shares, 0, 0, lp);

        assertEq(lp.balance, balanceBefore + ethOut);
        assertEq(steady.balanceOf(lp), 5 ether + tokenOut);
        assertEq(lpToken.balanceOf(lp), 0);
    }

    function testSlippageLimitProtectsTrader() public {
        _seedMarket(steadyMarket, steady, 5 ether, 5 ether);

        uint256 quotedSteady = steadyMarket.quoteBuyToken(1 ether);

        vm.prank(trader);
        vm.expectRevert(EthTokenAMM.Slippage.selector);
        steadyMarket.buyToken{value: 1 ether}(quotedSteady + 1, trader);
    }

    function _seedMarket(EthTokenAMM market, MintBurnToken token, uint256 tokenAmount, uint256 ethAmount) internal {
        vm.prank(lp);
        token.approve(address(market), tokenAmount);

        vm.prank(lp);
        market.addLiquidity{value: ethAmount}(tokenAmount, 0, lp);
    }

    function _tokens(bytes32 id) internal view returns (MintBurnToken pToken, MintBurnToken nToken) {
        (,,,,,, pToken, nToken,,,) = factory.series(id);
    }

    function assertEq(uint256 actual, uint256 expected) internal pure {
        require(actual == expected, "uint mismatch");
    }
}
