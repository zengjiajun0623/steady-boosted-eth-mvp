// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EthOptionsFactory} from "../EthOptionsFactory.sol";
import {RollAuction} from "../RollAuction.sol";
import {EthTokenAMM} from "../market/EthTokenAMM.sol";
import {EthLPVault} from "./EthLPVault.sol";

/// @notice Permissionless keeper facade for an ETH LP vault.
/// @dev The keeper should be set as the vault manager. Anyone can call these
/// methods; the vault's immutable policy limits decide whether the action is
/// allowed.
contract EthLPVaultKeeper {
    address public immutable deployer;
    uint256 public immutable minRewardedOperationAmount;
    uint256 public immutable keeperRewardEth;
    EthLPVault public vault;
    address public steadyRollSeller;
    address public boostedRollSeller;
    bool public rollSellersSet;

    event VaultSet(address indexed vault);
    event RollSellersSet(address indexed steadyRollSeller, address indexed boostedRollSeller);
    event KeeperRewardFunded(address indexed funder, uint256 amount);
    event KeeperRewardPaid(address indexed keeper, bytes4 indexed selector, uint256 amount);

    error NotDeployer();
    error VaultAlreadySet();
    error RollSellersAlreadySet();
    error RollSellersNotSet();
    error UnauthorizedRollAuction();
    error InvalidVault();
    error InvalidConfig();

    constructor(uint256 minRewardedOperationAmount_, uint256 keeperRewardEth_) {
        if (minRewardedOperationAmount_ == 0) revert InvalidConfig();
        deployer = msg.sender;
        minRewardedOperationAmount = minRewardedOperationAmount_;
        keeperRewardEth = keeperRewardEth_;
    }

    receive() external payable {
        emit KeeperRewardFunded(msg.sender, msg.value);
    }

    function setVault(EthLPVault vault_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (address(vault) != address(0)) revert VaultAlreadySet();
        if (address(vault_) == address(0) || vault_.manager() != address(this)) revert InvalidVault();

        vault = vault_;
        emit VaultSet(address(vault_));
    }

    function setRollSellers(address steadyRollSeller_, address boostedRollSeller_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (rollSellersSet) revert RollSellersAlreadySet();
        if (steadyRollSeller_ == address(0) || boostedRollSeller_ == address(0)) revert InvalidConfig();

        steadyRollSeller = steadyRollSeller_;
        boostedRollSeller = boostedRollSeller_;
        rollSellersSet = true;

        emit RollSellersSet(steadyRollSeller_, boostedRollSeller_);
    }

    function fillSteadyRoll(
        EthOptionsFactory factory,
        RollAuction auction,
        bytes32 oldSeriesId,
        bytes32 newSeriesId,
        uint256 auctionId,
        uint256 oldPAmount,
        uint256 ethToMint,
        uint256 maxNewPToPay
    ) external returns (uint256 newPPaid) {
        _requireRollSeller(auction, auctionId, steadyRollSeller);
        newPPaid = vault.fillSteadyRoll(
            factory, auction, oldSeriesId, newSeriesId, auctionId, oldPAmount, ethToMint, maxNewPToPay
        );
        _payKeeper(msg.sender, this.fillSteadyRoll.selector, oldPAmount >= minRewardedOperationAmount);
    }

    function fillBoostedRoll(
        EthOptionsFactory factory,
        RollAuction auction,
        bytes32 oldSeriesId,
        bytes32 newSeriesId,
        uint256 auctionId,
        uint256 oldNAmount,
        uint256 ethToMint,
        uint256 maxNewNToPay
    ) external returns (uint256 newNPaid) {
        _requireRollSeller(auction, auctionId, boostedRollSeller);
        newNPaid = vault.fillBoostedRoll(
            factory, auction, oldSeriesId, newSeriesId, auctionId, oldNAmount, ethToMint, maxNewNToPay
        );
        _payKeeper(msg.sender, this.fillBoostedRoll.selector, oldNAmount >= minRewardedOperationAmount);
    }

    function mergeSeries(EthOptionsFactory factory, bytes32 seriesId, uint256 amount) external {
        vault.mergeSeries(factory, seriesId, amount);
        _payKeeper(msg.sender, this.mergeSeries.selector, amount >= minRewardedOperationAmount);
    }

    function redeemP(EthOptionsFactory factory, bytes32 seriesId, uint256 amount) external {
        vault.redeemP(factory, seriesId, amount);
        _payKeeper(msg.sender, this.redeemP.selector, amount >= minRewardedOperationAmount);
    }

    function redeemN(EthOptionsFactory factory, bytes32 seriesId, uint256 amount) external {
        vault.redeemN(factory, seriesId, amount);
        _payKeeper(msg.sender, this.redeemN.selector, amount >= minRewardedOperationAmount);
    }

    function sellInventory(
        EthOptionsFactory factory,
        bytes32 seriesId,
        bool sellN,
        EthTokenAMM market,
        uint256 amount,
        uint256 minEthOut
    ) external returns (uint256 ethOut) {
        ethOut = vault.sellInventory(factory, seriesId, sellN, market, amount, minEthOut);
        _payKeeper(msg.sender, this.sellInventory.selector, amount >= minRewardedOperationAmount);
    }

    function closeStrategy() external {
        bool wasActive = vault.strategyActive();
        vault.closeStrategy();
        _payKeeper(msg.sender, this.closeStrategy.selector, wasActive);
    }

    function _requireRollSeller(RollAuction auction, uint256 auctionId, address expectedSeller) internal view {
        if (!rollSellersSet) revert RollSellersNotSet();
        (address seller, address beneficiary,,,,,,,,,) = auction.auctions(auctionId);
        if (seller != expectedSeller || beneficiary != expectedSeller) revert UnauthorizedRollAuction();
    }

    function _payKeeper(address keeper, bytes4 selector, bool eligible) internal {
        uint256 reward = keeperRewardEth;
        if (!eligible || reward == 0 || address(this).balance < reward) return;

        (bool ok,) = keeper.call{value: reward}("");
        if (ok) emit KeeperRewardPaid(keeper, selector, reward);
    }
}
