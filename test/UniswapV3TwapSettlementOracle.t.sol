// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EthOptionsFactory} from "../src/EthOptionsFactory.sol";
import {IUniswapV3PoolOracleLike, UniswapV3TwapSettlementOracle} from "../src/oracle/UniswapV3TwapSettlementOracle.sol";

interface OracleVm {
    function warp(uint256 timestamp) external;
    function expectRevert(bytes4 selector) external;
}

contract MockUniswapV3PoolOracle {
    int24 public tick;
    bool public shouldRevert;

    function setTick(int24 tick_) external {
        tick = tick_;
    }

    function setShouldRevert(bool shouldRevert_) external {
        shouldRevert = shouldRevert_;
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        if (shouldRevert) revert("OLD");

        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);

        for (uint256 i = 0; i < secondsAgos.length; i++) {
            uint256 timestamp = block.timestamp - secondsAgos[i];
            tickCumulatives[i] = int56(int256(tick) * int256(timestamp));
        }
    }
}

contract UniswapV3TwapSettlementOracleTest {
    OracleVm internal constant vm = OracleVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    EthOptionsFactory internal factory;
    MockUniswapV3PoolOracle internal pool;
    UniswapV3TwapSettlementOracle internal oracle;
    bytes32 internal seriesId;

    uint256 internal constant STRIKE = 1_000e18;
    uint256 internal constant PRICE_AT_TICK_ZERO = 2_000e18;
    uint64 internal constant MATURITY_DELAY = 30 days;
    uint32 internal constant TWAP_WINDOW = 72 hours;
    uint256 internal constant CAP = 10 ether;

    function setUp() public {
        factory = new EthOptionsFactory();
        pool = new MockUniswapV3PoolOracle();
        oracle = new UniswapV3TwapSettlementOracle(
            address(factory), IUniswapV3PoolOracleLike(address(pool)), PRICE_AT_TICK_ZERO, false, -100_000, 100_000
        );
        seriesId = factory.createSeries(STRIKE, uint64(block.timestamp + MATURITY_DELAY), TWAP_WINDOW, CAP, oracle);
    }

    function testFactoryRegistersSeriesMetadata() public view {
        (uint64 maturity, uint32 twapWindow, bool registered) = oracle.seriesConfigs(seriesId);

        assertEq(registered ? uint256(1) : uint256(0), 1);
        assertEq(uint256(maturity), block.timestamp + MATURITY_DELAY);
        assertEq(twapWindow, TWAP_WINDOW);
    }

    function testSettlesFromMaturityAnchoredTwap() public {
        factory.mint{value: 1 ether}(seriesId);

        vm.warp(block.timestamp + MATURITY_DELAY + 1 days);
        factory.settle(seriesId);

        (,,,,,,,,, bool settled, uint256 settlementPrice) = factory.series(seriesId);
        assertEq(settled ? uint256(1) : uint256(0), 1);
        assertEq(settlementPrice, PRICE_AT_TICK_ZERO);
    }

    function testOracleNotReadyWhenPoolCannotServeHistory() public {
        pool.setShouldRevert(true);

        vm.warp(block.timestamp + MATURITY_DELAY);
        vm.expectRevert(EthOptionsFactory.OracleNotReady.selector);
        factory.settle(seriesId);
    }

    function testOracleRejectsAverageTickOutsideConfiguredBounds() public {
        pool.setTick(101);
        UniswapV3TwapSettlementOracle narrowOracle = new UniswapV3TwapSettlementOracle(
            address(factory), IUniswapV3PoolOracleLike(address(pool)), PRICE_AT_TICK_ZERO, false, -100, 100
        );
        bytes32 narrowSeriesId =
            factory.createSeries(STRIKE, uint64(block.timestamp + MATURITY_DELAY), TWAP_WINDOW, CAP, narrowOracle);

        vm.warp(block.timestamp + MATURITY_DELAY);
        vm.expectRevert(EthOptionsFactory.OracleNotReady.selector);
        factory.settle(narrowSeriesId);
    }

    function testOnlyFactoryCanRegisterSeries() public {
        vm.expectRevert(UniswapV3TwapSettlementOracle.NotFactory.selector);
        oracle.registerSeries(bytes32(uint256(123)), uint64(block.timestamp + MATURITY_DELAY), TWAP_WINDOW);
    }

    function assertEq(uint256 actual, uint256 expected) internal pure {
        require(actual == expected, "uint mismatch");
    }
}
