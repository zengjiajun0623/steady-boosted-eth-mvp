// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EthOptionsFactory} from "../EthOptionsFactory.sol";
import {RollAuction} from "../RollAuction.sol";
import {MintBurnToken} from "../token/MintBurnToken.sol";
import {SeriesExposureVault} from "./SeriesExposureVault.sol";

/// @notice Permissionless keeper facade for Steady/Boosted exposure wrappers.
/// @dev The keeper should be set as the wrapper manager. Anyone can call safe
/// roll lifecycle methods, while this contract validates the factory series,
/// token side, auction venue, and roll price policy.
contract SeriesExposureVaultKeeper {
    EthOptionsFactory public immutable factory;
    RollAuction public immutable auction;
    bool public immutable boostedSide;
    uint256 public immutable maxStartPriceWad;
    uint256 public immutable minEndPriceWad;
    uint64 public immutable minDuration;
    uint64 public immutable maxDuration;
    uint256 public immutable minRollSellAmount;
    uint256 public immutable maxRollSellAmount;
    uint256 public immutable keeperRewardEth;
    address public immutable deployer;

    SeriesExposureVault public vault;
    bytes32 public currentSeriesId;
    bytes32 public pendingSeriesId;

    event VaultSet(address indexed vault, bytes32 indexed initialSeriesId);
    event RollStarted(bytes32 indexed oldSeriesId, bytes32 indexed nextSeriesId, uint256 indexed auctionId);
    event RollReset(uint256 indexed auctionId);
    event RollFinalized(bytes32 indexed seriesId);
    event RollCancelled(uint256 indexed auctionId);
    event KeeperRewardFunded(address indexed funder, uint256 amount);
    event KeeperRewardPaid(address indexed keeper, bytes4 indexed selector, uint256 amount);

    error InvalidConfig();
    error InvalidVault();
    error InvalidSeries();
    error NotDeployer();
    error VaultAlreadySet();
    error RollPolicyViolation();
    error NoPendingRoll();
    error AuctionStillRunning();

    constructor(
        EthOptionsFactory factory_,
        RollAuction auction_,
        bool boostedSide_,
        uint256 maxStartPriceWad_,
        uint256 minEndPriceWad_,
        uint64 minDuration_,
        uint64 maxDuration_,
        uint256 minRollSellAmount_,
        uint256 maxRollSellAmount_,
        uint256 keeperRewardEth_
    ) {
        if (
            address(factory_) == address(0) || address(auction_) == address(0) || maxStartPriceWad_ == 0
                || minEndPriceWad_ == 0 || minEndPriceWad_ > maxStartPriceWad_ || minDuration_ == 0
                || maxDuration_ < minDuration_ || minRollSellAmount_ == 0 || maxRollSellAmount_ < minRollSellAmount_
        ) {
            revert InvalidConfig();
        }

        factory = factory_;
        auction = auction_;
        boostedSide = boostedSide_;
        maxStartPriceWad = maxStartPriceWad_;
        minEndPriceWad = minEndPriceWad_;
        minDuration = minDuration_;
        maxDuration = maxDuration_;
        minRollSellAmount = minRollSellAmount_;
        maxRollSellAmount = maxRollSellAmount_;
        keeperRewardEth = keeperRewardEth_;
        deployer = msg.sender;
    }

    receive() external payable {
        emit KeeperRewardFunded(msg.sender, msg.value);
    }

    function setVault(SeriesExposureVault vault_, bytes32 initialSeriesId) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (address(vault) != address(0)) revert VaultAlreadySet();

        (MintBurnToken expectedToken,) = _seriesToken(initialSeriesId);
        if (
            address(vault_) == address(0) || vault_.manager() != address(this)
                || address(vault_.currentToken()) != address(expectedToken)
        ) {
            revert InvalidVault();
        }

        vault = vault_;
        currentSeriesId = initialSeriesId;

        emit VaultSet(address(vault_), initialSeriesId);
    }

    function startRoll(
        bytes32 nextSeriesId,
        uint256 sellAmount,
        uint256 startPriceWad,
        uint256 endPriceWad,
        uint64 duration
    ) external returns (uint256 auctionId) {
        SeriesExposureVault wrapper = _vault();
        if (
            startPriceWad > maxStartPriceWad || endPriceWad < minEndPriceWad || duration < minDuration
                || duration > maxDuration || sellAmount < minRollSellAmount || sellAmount > maxRollSellAmount
        ) {
            revert RollPolicyViolation();
        }

        (MintBurnToken currentToken, uint64 currentMaturity) = _seriesToken(currentSeriesId);
        (MintBurnToken nextToken, uint64 nextMaturity) = _seriesToken(nextSeriesId);
        if (
            nextSeriesId == currentSeriesId || nextMaturity <= currentMaturity
                || address(wrapper.currentToken()) != address(currentToken)
        ) {
            revert InvalidSeries();
        }

        auctionId = wrapper.startRoll(auction, nextToken, sellAmount, startPriceWad, endPriceWad, duration);
        pendingSeriesId = nextSeriesId;

        emit RollStarted(currentSeriesId, nextSeriesId, auctionId);
        _payKeeper(msg.sender, this.startRoll.selector, sellAmount >= minRollSellAmount);
    }

    function finalizeRoll() external {
        if (pendingSeriesId == bytes32(0)) revert NoPendingRoll();

        bytes32 nextSeriesId = pendingSeriesId;
        _vault().finalizeRoll();

        currentSeriesId = nextSeriesId;
        pendingSeriesId = bytes32(0);

        emit RollFinalized(nextSeriesId);
        _payKeeper(msg.sender, this.finalizeRoll.selector);
    }

    function resetRoll(uint256 startPriceWad, uint256 endPriceWad, uint64 duration) external {
        if (pendingSeriesId == bytes32(0)) revert NoPendingRoll();
        if (
            startPriceWad > maxStartPriceWad || endPriceWad < minEndPriceWad || duration < minDuration
                || duration > maxDuration
        ) {
            revert RollPolicyViolation();
        }

        SeriesExposureVault wrapper = _vault();
        (RollAuction rollAuction, uint256 auctionId,) = wrapper.roll();
        (,,,, uint256 remainingSellAmount,,,,,,) = rollAuction.auctions(auctionId);

        wrapper.resetRoll(startPriceWad, endPriceWad, duration);

        emit RollReset(auctionId);
        _payKeeper(msg.sender, this.resetRoll.selector, remainingSellAmount >= minRollSellAmount);
    }

    function cancelUnfilledRoll() external {
        if (pendingSeriesId == bytes32(0)) revert NoPendingRoll();

        SeriesExposureVault wrapper = _vault();
        (RollAuction rollAuction, uint256 auctionId,) = wrapper.roll();
        (,,,,,,,, uint64 startTime, uint64 duration,) = rollAuction.auctions(auctionId);
        if (block.timestamp < startTime + duration) revert AuctionStillRunning();

        wrapper.cancelUnfilledRoll();
        pendingSeriesId = bytes32(0);

        emit RollCancelled(auctionId);
        _payKeeper(msg.sender, this.cancelUnfilledRoll.selector, true);
    }

    function _vault() internal view returns (SeriesExposureVault wrapper) {
        wrapper = vault;
        if (address(wrapper) == address(0)) revert InvalidVault();
    }

    function _seriesToken(bytes32 seriesId) internal view returns (MintBurnToken token, uint64 maturity) {
        MintBurnToken pToken;
        MintBurnToken nToken;
        (, maturity,,,,, pToken, nToken,,,) = factory.series(seriesId);
        token = boostedSide ? nToken : pToken;
        if (address(token) == address(0)) revert InvalidSeries();
    }

    function _payKeeper(address keeper, bytes4 selector) internal {
        _payKeeper(keeper, selector, true);
    }

    function _payKeeper(address keeper, bytes4 selector, bool eligible) internal {
        uint256 reward = keeperRewardEth;
        if (!eligible || reward == 0 || address(this).balance < reward) return;

        (bool ok,) = keeper.call{value: reward}("");
        if (ok) emit KeeperRewardPaid(keeper, selector, reward);
    }
}
