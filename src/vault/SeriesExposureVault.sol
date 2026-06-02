// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RollAuction, IERC20Like} from "../RollAuction.sol";
import {MintBurnToken} from "../token/MintBurnToken.sol";

/// @notice Tokenized exposure wrapper for a single option side across maturities.
/// @dev Deploy one vault for Steady ETH (`P` exposure) and one for Boosted ETH
/// (`N` exposure). Deposits and redemptions pause during rolls so share
/// accounting never depends on a trusted mark-to-market price for mixed series.
/// A fully failed roll pauses deposit growth until a later successful roll clears.
contract SeriesExposureVault {
    MintBurnToken public immutable share;
    address public immutable manager;
    uint256 public immutable maxAssets;
    MintBurnToken public currentToken;
    bool public rollActive;
    bool public depositsPaused;

    struct RollState {
        RollAuction auction;
        uint256 auctionId;
        MintBurnToken nextToken;
    }

    RollState public roll;

    uint256 private locked = 1;

    event Deposited(address indexed account, address indexed recipient, uint256 assets, uint256 shares);
    event Redeemed(address indexed account, address indexed recipient, uint256 assets, uint256 shares);
    event CapacitySet(uint256 maxAssets);
    event RollStarted(
        uint256 indexed auctionId, address indexed oldToken, address indexed newToken, uint256 sellAmount
    );
    event RollReset(uint256 indexed auctionId, uint256 startPriceWad, uint256 endPriceWad, uint64 duration);
    event RollFinalized(address indexed newToken);
    event RollCancelled(uint256 indexed auctionId);
    event DepositsPausedSet(bool paused);

    error InvalidConfig();
    error InvalidRecipient();
    error NotManager();
    error ZeroAmount();
    error Slippage();
    error RollActive();
    error NoActiveRoll();
    error RollNotFilled();
    error PartialRoll();
    error PartialFillCannotCancel();
    error CapacityExceeded();
    error DepositsPaused();
    error TokenTransferFailed();

    constructor(
        MintBurnToken initialToken,
        address manager_,
        string memory shareName,
        string memory shareSymbol,
        uint256 maxAssets_
    ) {
        if (address(initialToken) == address(0) || manager_ == address(0) || maxAssets_ == 0) {
            revert InvalidConfig();
        }

        manager = manager_;
        maxAssets = maxAssets_;
        currentToken = initialToken;
        share = new MintBurnToken(shareName, shareSymbol, address(this));

        emit CapacitySet(maxAssets_);
    }

    modifier onlyManager() {
        if (msg.sender != manager) revert NotManager();
        _;
    }

    modifier nonReentrant() {
        require(locked == 1, "LOCKED");
        locked = 2;
        _;
        locked = 1;
    }

    function deposit(uint256 assets, uint256 minShares, address recipient)
        external
        nonReentrant
        returns (uint256 shares)
    {
        if (rollActive) revert RollActive();
        if (depositsPaused) revert DepositsPaused();
        if (recipient == address(0)) revert InvalidRecipient();
        if (assets == 0) revert ZeroAmount();
        uint256 assetsBefore = currentToken.balanceOf(address(this));
        if (assetsBefore + assets > maxAssets) revert CapacityExceeded();

        shares = _convertToShares(assets, assetsBefore);
        if (shares == 0) revert ZeroAmount();
        if (shares < minShares) revert Slippage();

        share.mint(recipient, shares);
        _pull(currentToken, msg.sender, assets);

        emit Deposited(msg.sender, recipient, assets, shares);
    }

    function redeem(uint256 shares, uint256 minAssets, address recipient)
        external
        nonReentrant
        returns (uint256 assets)
    {
        if (rollActive) revert RollActive();
        if (recipient == address(0)) revert InvalidRecipient();
        if (shares == 0) revert ZeroAmount();

        assets = convertToAssets(shares);
        if (assets == 0) revert ZeroAmount();
        if (assets < minAssets) revert Slippage();

        share.burn(msg.sender, shares);
        _push(currentToken, recipient, assets);

        emit Redeemed(msg.sender, recipient, assets, shares);
    }

    function startRoll(
        RollAuction auction,
        MintBurnToken nextToken,
        uint256 sellAmount,
        uint256 startPriceWad,
        uint256 endPriceWad,
        uint64 duration
    ) external onlyManager nonReentrant returns (uint256 auctionId) {
        if (rollActive) revert RollActive();
        if (
            address(auction) == address(0) || address(nextToken) == address(0)
                || address(nextToken) == address(currentToken)
        ) {
            revert InvalidConfig();
        }
        uint256 currentBalance = currentToken.balanceOf(address(this));
        if (sellAmount == 0 || sellAmount > currentBalance) revert ZeroAmount();
        if (sellAmount != currentBalance) revert PartialRoll();

        currentToken.approve(address(auction), sellAmount);
        auctionId = auction.createAuction(
            IERC20Like(address(currentToken)),
            IERC20Like(address(nextToken)),
            sellAmount,
            startPriceWad,
            endPriceWad,
            duration,
            address(this)
        );
        currentToken.approve(address(auction), 0);

        roll = RollState({auction: auction, auctionId: auctionId, nextToken: nextToken});
        rollActive = true;

        emit RollStarted(auctionId, address(currentToken), address(nextToken), sellAmount);
    }

    function finalizeRoll() external onlyManager {
        if (!rollActive) revert NoActiveRoll();

        (,,,, uint256 remainingSellAmount,,,,,,) = roll.auction.auctions(roll.auctionId);
        if (remainingSellAmount != 0) revert RollNotFilled();

        currentToken = roll.nextToken;
        delete roll;
        rollActive = false;
        if (depositsPaused) {
            depositsPaused = false;
            emit DepositsPausedSet(false);
        }

        emit RollFinalized(address(currentToken));
    }

    function resetRoll(uint256 startPriceWad, uint256 endPriceWad, uint64 duration) external onlyManager nonReentrant {
        if (!rollActive) revert NoActiveRoll();

        uint256 auctionId = roll.auctionId;
        roll.auction.redo(auctionId, startPriceWad, endPriceWad, duration);

        emit RollReset(auctionId, startPriceWad, endPriceWad, duration);
    }

    function cancelUnfilledRoll() external onlyManager nonReentrant {
        if (!rollActive) revert NoActiveRoll();

        (,,,,, uint256 buyTokenRaised,,,,,) = roll.auction.auctions(roll.auctionId);
        if (buyTokenRaised != 0) revert PartialFillCannotCancel();

        uint256 auctionId = roll.auctionId;
        roll.auction.cancel(auctionId);
        delete roll;
        rollActive = false;
        if (!depositsPaused) {
            depositsPaused = true;
            emit DepositsPausedSet(true);
        }

        emit RollCancelled(auctionId);
    }

    function totalAssets() public view returns (uint256) {
        if (rollActive) revert RollActive();
        return currentToken.balanceOf(address(this));
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        if (rollActive) revert RollActive();

        return _convertToShares(assets, currentToken.balanceOf(address(this)));
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        if (rollActive) revert RollActive();

        uint256 supply = share.totalSupply();
        return supply == 0 ? shares : (shares * currentToken.balanceOf(address(this))) / supply;
    }

    function remainingCapacity() external view returns (uint256) {
        if (rollActive || depositsPaused) return 0;

        uint256 assets = currentToken.balanceOf(address(this));
        return assets >= maxAssets ? 0 : maxAssets - assets;
    }

    function _convertToShares(uint256 assets, uint256 assetsBefore) internal view returns (uint256) {
        uint256 supply = share.totalSupply();
        return supply == 0 || assetsBefore == 0 ? assets : (assets * supply) / assetsBefore;
    }

    function _pull(MintBurnToken token, address from, uint256 amount) internal {
        if (!token.transferFrom(from, address(this), amount)) revert TokenTransferFailed();
    }

    function _push(MintBurnToken token, address to, uint256 amount) internal {
        if (!token.transfer(to, amount)) revert TokenTransferFailed();
    }
}
