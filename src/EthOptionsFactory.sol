// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MintBurnToken} from "./token/MintBurnToken.sol";
import {ISettlementOracle, ISeriesSettlementOracle} from "./oracle/ISettlementOracle.sol";

/// @notice ETH-collateralized P/N option split for Steady ETH and Boosted ETH.
/// @dev One ETH deposited mints one P token and one N token. P + N can merge
/// back to one ETH until the series is settled. After settlement, P and N split
/// the same ETH collateral according to the fixed strike and settlement price.
contract EthOptionsFactory {
    uint256 public constant WAD = 1e18;

    struct Series {
        uint256 strike; // ETH/stable reference strike, 18 decimals
        uint64 maturity;
        uint32 twapWindow;
        uint256 capEth;
        uint256 openInterestEth;
        uint256 collateralEth;
        MintBurnToken pToken;
        MintBurnToken nToken;
        ISettlementOracle oracle;
        bool settled;
        uint256 settlementPrice; // ETH/stable price, 18 decimals
    }

    uint256 public seriesCount;
    mapping(bytes32 => Series) public series;
    bytes32[] public seriesIds;
    uint256 private locked = 1;

    event SeriesCreated(
        bytes32 indexed seriesId,
        address indexed pToken,
        address indexed nToken,
        address oracle,
        uint256 strike,
        uint64 maturity,
        uint32 twapWindow,
        uint256 capEth
    );
    event Minted(bytes32 indexed seriesId, address indexed account, uint256 ethAmount);
    event Merged(bytes32 indexed seriesId, address indexed account, uint256 ethAmount);
    event Settled(bytes32 indexed seriesId, uint256 settlementPrice);
    event Redeemed(
        bytes32 indexed seriesId, address indexed account, address indexed token, uint256 tokenAmount, uint256 ethAmount
    );

    error InvalidSeries();
    error InvalidConfig();
    error SeriesExists();
    error SeriesMatured();
    error SeriesNotMatured();
    error SeriesNotSettled();
    error SeriesSettled();
    error CapExceeded();
    error OracleNotReady();
    error OracleRegistrationFailed();
    error EthTransferFailed();
    error ReentrantCall();
    error ZeroAmount();

    modifier nonReentrant() {
        if (locked != 1) revert ReentrantCall();
        locked = 2;
        _;
        locked = 1;
    }

    function createSeries(uint256 strike, uint64 maturity, uint32 twapWindow, uint256 capEth, ISettlementOracle oracle)
        external
        nonReentrant
        returns (bytes32 seriesId)
    {
        if (
            strike == 0 || maturity <= block.timestamp || twapWindow == 0 || capEth == 0
                || address(oracle) == address(0)
        ) {
            revert InvalidConfig();
        }

        seriesId = keccak256(
            abi.encode(block.chainid, address(this), seriesCount, strike, maturity, twapWindow, capEth, oracle)
        );
        if (address(series[seriesId].oracle) != address(0)) revert SeriesExists();

        try ISeriesSettlementOracle(address(oracle)).registerSeries(seriesId, maturity, twapWindow) {}
        catch {
            revert OracleRegistrationFailed();
        }

        unchecked {
            seriesCount += 1;
        }

        MintBurnToken pToken = new MintBurnToken("Steady ETH Series P", "stETH-P", address(this));
        MintBurnToken nToken = new MintBurnToken("Boosted ETH Series N", "bstETH-N", address(this));

        series[seriesId] = Series({
            strike: strike,
            maturity: maturity,
            twapWindow: twapWindow,
            capEth: capEth,
            openInterestEth: 0,
            collateralEth: 0,
            pToken: pToken,
            nToken: nToken,
            oracle: oracle,
            settled: false,
            settlementPrice: 0
        });
        seriesIds.push(seriesId);

        emit SeriesCreated(
            seriesId, address(pToken), address(nToken), address(oracle), strike, maturity, twapWindow, capEth
        );
    }

    function mint(bytes32 seriesId) external payable {
        Series storage s = _series(seriesId);
        if (block.timestamp >= s.maturity) revert SeriesMatured();
        if (msg.value == 0) revert ZeroAmount();
        if (s.openInterestEth + msg.value > s.capEth) revert CapExceeded();

        s.openInterestEth += msg.value;
        s.collateralEth += msg.value;
        s.pToken.mint(msg.sender, msg.value);
        s.nToken.mint(msg.sender, msg.value);

        emit Minted(seriesId, msg.sender, msg.value);
    }

    function merge(bytes32 seriesId, uint256 amount) external {
        Series storage s = _series(seriesId);
        if (s.settled) revert SeriesSettled();
        if (amount == 0) revert ZeroAmount();

        s.openInterestEth -= amount;
        s.collateralEth -= amount;
        s.pToken.burn(msg.sender, amount);
        s.nToken.burn(msg.sender, amount);
        _sendEth(msg.sender, amount);

        emit Merged(seriesId, msg.sender, amount);
    }

    function settle(bytes32 seriesId) external {
        Series storage s = _series(seriesId);
        if (block.timestamp < s.maturity) revert SeriesNotMatured();
        if (s.settled) return;

        (bool ready, uint256 price) = s.oracle.settlementPrice(seriesId);
        if (!ready || price == 0) revert OracleNotReady();

        s.settled = true;
        s.settlementPrice = price;

        emit Settled(seriesId, price);
    }

    function redeemP(bytes32 seriesId, uint256 amount) external returns (uint256 ethAmount) {
        Series storage s = _settledSeries(seriesId);
        if (amount == 0) revert ZeroAmount();

        ethAmount = (amount * pPayoffWad(s.strike, s.settlementPrice)) / WAD;
        s.collateralEth -= ethAmount;
        s.pToken.burn(msg.sender, amount);
        _sendEth(msg.sender, ethAmount);

        emit Redeemed(seriesId, msg.sender, address(s.pToken), amount, ethAmount);
    }

    function redeemN(bytes32 seriesId, uint256 amount) external returns (uint256 ethAmount) {
        Series storage s = _settledSeries(seriesId);
        if (amount == 0) revert ZeroAmount();

        ethAmount = (amount * nPayoffWad(s.strike, s.settlementPrice)) / WAD;
        s.collateralEth -= ethAmount;
        s.nToken.burn(msg.sender, amount);
        _sendEth(msg.sender, ethAmount);

        emit Redeemed(seriesId, msg.sender, address(s.nToken), amount, ethAmount);
    }

    function pPayoffWad(uint256 strike, uint256 settlementPrice) public pure returns (uint256) {
        if (settlementPrice <= strike) return WAD;
        return (strike * WAD) / settlementPrice;
    }

    function nPayoffWad(uint256 strike, uint256 settlementPrice) public pure returns (uint256) {
        return WAD - pPayoffWad(strike, settlementPrice);
    }

    function seriesIdAt(uint256 index) external view returns (bytes32) {
        return seriesIds[index];
    }

    function seriesLength() external view returns (uint256) {
        return seriesIds.length;
    }

    function _series(bytes32 seriesId) internal view returns (Series storage s) {
        s = series[seriesId];
        if (address(s.oracle) == address(0)) revert InvalidSeries();
    }

    function _settledSeries(bytes32 seriesId) internal view returns (Series storage s) {
        s = _series(seriesId);
        if (!s.settled) revert SeriesNotSettled();
    }

    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }
}
