// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EthOptionsFactory} from "../src/EthOptionsFactory.sol";
import {MintBurnToken} from "../src/token/MintBurnToken.sol";
import {MockSettlementOracle} from "../src/oracle/MockSettlementOracle.sol";
import {ISettlementOracle, ISeriesSettlementOracle} from "../src/oracle/ISettlementOracle.sol";

interface Vm {
    function warp(uint256 timestamp) external;
    function expectRevert(bytes4 selector) external;
}

contract OracleWithoutRegistration is ISettlementOracle {
    function settlementPrice(bytes32) external pure returns (bool settled, uint256 price) {
        return (false, 0);
    }
}

contract ReentrantRegistrationOracle is ISeriesSettlementOracle {
    EthOptionsFactory public immutable factory;
    bool public tryMintDuringRegistration;
    bool public tryCreateDuringRegistration;
    bool public mintSucceeded;
    bool public createSucceeded;

    constructor(EthOptionsFactory factory_) {
        factory = factory_;
    }

    receive() external payable {}

    function configure(bool tryMintDuringRegistration_, bool tryCreateDuringRegistration_) external {
        tryMintDuringRegistration = tryMintDuringRegistration_;
        tryCreateDuringRegistration = tryCreateDuringRegistration_;
    }

    function registerSeries(bytes32 seriesId, uint64 maturity, uint32 twapWindow) external {
        if (tryMintDuringRegistration) {
            try factory.mint{value: 1 wei}(seriesId) {
                mintSucceeded = true;
            } catch {}
        }
        if (tryCreateDuringRegistration) {
            try factory.createSeries(1_000e18, maturity + 1 days, twapWindow, 1 ether, this) returns (bytes32) {
                createSucceeded = true;
            } catch {}
        }
    }

    function settlementPrice(bytes32) external pure returns (bool settled, uint256 price) {
        return (false, 0);
    }
}

contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertEq(uint256 actual, uint256 expected) internal pure {
        require(actual == expected, "uint mismatch");
    }

    function assertEq(address actual, address expected) internal pure {
        require(actual == expected, "address mismatch");
    }

    function assertLe(uint256 actual, uint256 expected) internal pure {
        require(actual <= expected, "uint too large");
    }

    receive() external payable {}
}

contract EthOptionsFactoryTest is TestBase {
    EthOptionsFactory internal factory;
    MockSettlementOracle internal oracle;
    bytes32 internal seriesId;

    uint256 internal constant STRIKE = 1_000e18;
    uint64 internal constant MATURITY = 30 days;
    uint32 internal constant TWAP_WINDOW = 72 hours;
    uint256 internal constant CAP = 10 ether;

    function setUp() public {
        oracle = new MockSettlementOracle();
        factory = new EthOptionsFactory();
        seriesId = factory.createSeries(STRIKE, uint64(block.timestamp + MATURITY), TWAP_WINDOW, CAP, oracle);
    }

    function testMintCreatesMatchedPandN() public {
        (MintBurnToken pToken, MintBurnToken nToken) = _tokens();

        factory.mint{value: 1 ether}(seriesId);

        assertEq(pToken.balanceOf(address(this)), 1 ether);
        assertEq(nToken.balanceOf(address(this)), 1 ether);
        assertEq(address(factory).balance, 1 ether);
        (,,,, uint256 openInterestEth, uint256 collateralEth,,,,,) = factory.series(seriesId);
        assertEq(openInterestEth, 1 ether);
        assertEq(collateralEth, 1 ether);
    }

    function testCreateSeriesRequiresOracleRegistration() public {
        OracleWithoutRegistration badOracle = new OracleWithoutRegistration();

        vm.expectRevert(EthOptionsFactory.OracleRegistrationFailed.selector);
        factory.createSeries(STRIKE, uint64(block.timestamp + MATURITY), TWAP_WINDOW, CAP, badOracle);
    }

    function testMockOracleRecordsSeriesMetadata() public view {
        (uint64 maturity, uint32 twapWindow, bool registered) = oracle.seriesConfigs(seriesId);

        assertEq(registered ? uint256(1) : uint256(0), 1);
        assertEq(uint256(maturity), block.timestamp + MATURITY);
        assertEq(uint256(twapWindow), uint256(TWAP_WINDOW));
    }

    function testOracleRegistrationCannotMintHalfCreatedSeries() public {
        ReentrantRegistrationOracle reentrantOracle = new ReentrantRegistrationOracle(factory);
        reentrantOracle.configure(true, false);
        payable(address(reentrantOracle)).transfer(1 wei);

        bytes32 reentrantSeriesId =
            factory.createSeries(STRIKE, uint64(block.timestamp + MATURITY + 1 days), TWAP_WINDOW, CAP, reentrantOracle);

        (,,,, uint256 openInterestEth, uint256 collateralEth, MintBurnToken pToken, MintBurnToken nToken,,,) =
            factory.series(reentrantSeriesId);
        assertEq(reentrantOracle.mintSucceeded() ? uint256(1) : uint256(0), 0);
        assertEq(openInterestEth, 0);
        assertEq(collateralEth, 0);
        assertEq(pToken.balanceOf(address(reentrantOracle)), 0);
        assertEq(nToken.balanceOf(address(reentrantOracle)), 0);
    }

    function testOracleRegistrationCannotReenterSeriesCreation() public {
        ReentrantRegistrationOracle reentrantOracle = new ReentrantRegistrationOracle(factory);
        reentrantOracle.configure(false, true);
        uint256 seriesCountBefore = factory.seriesCount();

        factory.createSeries(STRIKE, uint64(block.timestamp + MATURITY + 1 days), TWAP_WINDOW, CAP, reentrantOracle);

        assertEq(reentrantOracle.createSucceeded() ? uint256(1) : uint256(0), 0);
        assertEq(factory.seriesCount(), seriesCountBefore + 1);
    }

    function testMergeBeforeMaturityReturnsEth() public {
        (MintBurnToken pToken, MintBurnToken nToken) = _tokens();
        factory.mint{value: 1 ether}(seriesId);

        uint256 balanceBefore = address(this).balance;
        factory.merge(seriesId, 0.4 ether);

        assertEq(address(this).balance, balanceBefore + 0.4 ether);
        assertEq(pToken.balanceOf(address(this)), 0.6 ether);
        assertEq(nToken.balanceOf(address(this)), 0.6 ether);
        (,,,, uint256 openInterestEth, uint256 collateralEth,,,,,) = factory.series(seriesId);
        assertEq(openInterestEth, 0.6 ether);
        assertEq(collateralEth, 0.6 ether);
    }

    function testMergeAfterMaturityBeforeSettlementReturnsEth() public {
        (MintBurnToken pToken, MintBurnToken nToken) = _tokens();
        factory.mint{value: 1 ether}(seriesId);

        vm.warp(block.timestamp + MATURITY);
        vm.expectRevert(EthOptionsFactory.OracleNotReady.selector);
        factory.settle(seriesId);

        uint256 balanceBefore = address(this).balance;
        factory.merge(seriesId, 0.4 ether);

        assertEq(address(this).balance, balanceBefore + 0.4 ether);
        assertEq(pToken.balanceOf(address(this)), 0.6 ether);
        assertEq(nToken.balanceOf(address(this)), 0.6 ether);
        (,,,, uint256 openInterestEth, uint256 collateralEth,,,,,) = factory.series(seriesId);
        assertEq(openInterestEth, 0.6 ether);
        assertEq(collateralEth, 0.6 ether);
    }

    function testHighPriceSettlementSplitsCollateral() public {
        (MintBurnToken pToken, MintBurnToken nToken) = _tokens();
        factory.mint{value: 1 ether}(seriesId);

        vm.warp(block.timestamp + MATURITY);
        oracle.setSettlementPrice(seriesId, 2_000e18);
        factory.settle(seriesId);

        uint256 balanceBefore = address(this).balance;
        factory.redeemP(seriesId, 1 ether);
        factory.redeemN(seriesId, 1 ether);

        assertEq(address(this).balance, balanceBefore + 1 ether);
        assertEq(pToken.balanceOf(address(this)), 0);
        assertEq(nToken.balanceOf(address(this)), 0);
        (,,,,, uint256 collateralEth,,,,,) = factory.series(seriesId);
        assertEq(collateralEth, 0);
    }

    function testLowPriceSettlementPaysPAllCollateral() public {
        (MintBurnToken pToken, MintBurnToken nToken) = _tokens();
        factory.mint{value: 1 ether}(seriesId);

        vm.warp(block.timestamp + MATURITY);
        oracle.setSettlementPrice(seriesId, 500e18);
        factory.settle(seriesId);

        uint256 balanceBefore = address(this).balance;
        factory.redeemP(seriesId, 1 ether);
        factory.redeemN(seriesId, 1 ether);

        assertEq(address(this).balance, balanceBefore + 1 ether);
        assertEq(pToken.balanceOf(address(this)), 0);
        assertEq(nToken.balanceOf(address(this)), 0);
        (,,,,, uint256 collateralEth,,,,,) = factory.series(seriesId);
        assertEq(collateralEth, 0);
    }

    function testMergeAfterSettlementIsRejected() public {
        factory.mint{value: 1 ether}(seriesId);

        vm.warp(block.timestamp + MATURITY);
        oracle.setSettlementPrice(seriesId, 2_000e18);
        factory.settle(seriesId);

        vm.expectRevert(EthOptionsFactory.SeriesSettled.selector);
        factory.merge(seriesId, 0.4 ether);
    }

    function testCannotSettleBeforeMaturity() public {
        oracle.setSettlementPrice(seriesId, 2_000e18);
        vm.expectRevert(EthOptionsFactory.SeriesNotMatured.selector);
        factory.settle(seriesId);
    }

    function testFuzzPayoffsAreComplementary(uint256 rawStrike, uint256 rawSettlementPrice) public view {
        uint256 strike = 1 + (rawStrike % 1_000_000e18);
        uint256 settlementPrice = 1 + (rawSettlementPrice % 1_000_000e18);

        uint256 pPayoff = factory.pPayoffWad(strike, settlementPrice);
        uint256 nPayoff = factory.nPayoffWad(strike, settlementPrice);

        assertEq(pPayoff + nPayoff, 1e18);
        assertLe(pPayoff, 1e18);
        assertLe(nPayoff, 1e18);
    }

    function testFuzzMintAndMergePreserveMatchedAccounting(uint256 rawMintAmount, uint256 rawMergeAmount) public {
        (MintBurnToken pToken, MintBurnToken nToken) = _tokens();
        uint256 mintAmount = _boundedAmount(rawMintAmount);
        uint256 mergeAmount = 1 + (rawMergeAmount % mintAmount);

        factory.mint{value: mintAmount}(seriesId);
        uint256 balanceBefore = address(this).balance;
        factory.merge(seriesId, mergeAmount);

        uint256 remaining = mintAmount - mergeAmount;
        assertEq(address(this).balance, balanceBefore + mergeAmount);
        assertEq(pToken.balanceOf(address(this)), remaining);
        assertEq(nToken.balanceOf(address(this)), remaining);
        (,,,, uint256 openInterestEth, uint256 collateralEth,,,,,) = factory.series(seriesId);
        assertEq(openInterestEth, remaining);
        assertEq(collateralEth, remaining);
        assertEq(address(factory).balance, remaining);
    }

    function testFuzzSettledRedemptionsNeverOverpayCollateral(
        uint256 rawMintAmount,
        uint256 rawSettlementPrice,
        bool redeemNFirst
    ) public {
        (MintBurnToken pToken, MintBurnToken nToken) = _tokens();
        uint256 mintAmount = _boundedAmount(rawMintAmount);
        uint256 settlementPrice = 1 + (rawSettlementPrice % 1_000_000e18);

        factory.mint{value: mintAmount}(seriesId);
        vm.warp(block.timestamp + MATURITY);
        oracle.setSettlementPrice(seriesId, settlementPrice);
        factory.settle(seriesId);

        uint256 balanceBefore = address(this).balance;
        if (redeemNFirst) {
            factory.redeemN(seriesId, mintAmount);
            factory.redeemP(seriesId, mintAmount);
        } else {
            factory.redeemP(seriesId, mintAmount);
            factory.redeemN(seriesId, mintAmount);
        }

        uint256 paid = address(this).balance - balanceBefore;
        (,,,,, uint256 collateralEth,,,,,) = factory.series(seriesId);
        assertLe(paid, mintAmount);
        assertEq(paid + collateralEth, mintAmount);
        assertLe(collateralEth, 1);
        assertEq(pToken.balanceOf(address(this)), 0);
        assertEq(nToken.balanceOf(address(this)), 0);
        assertEq(address(factory).balance, collateralEth);
    }

    function _tokens() internal view returns (MintBurnToken pToken, MintBurnToken nToken) {
        (,,,,,, pToken, nToken,,,) = factory.series(seriesId);
    }

    function _boundedAmount(uint256 rawAmount) internal pure returns (uint256) {
        return 1 + (rawAmount % CAP);
    }
}
