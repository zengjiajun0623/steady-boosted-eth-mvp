// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EthOptionsFactory} from "../EthOptionsFactory.sol";
import {RollAuction, IERC20Like} from "../RollAuction.sol";
import {EthTokenAMM} from "../market/EthTokenAMM.sol";
import {MintBurnToken} from "../token/MintBurnToken.sol";

/// @notice ETH-denominated LP vault shell for roll liquidity providers.
/// @dev The vault pauses new deposits and withdrawal requests while strategy
/// inventory is open, avoiding a trusted mark-to-market oracle for LP shares.
contract EthLPVault {
    uint256 public constant WAD = 1e18;
    uint256 public constant BPS = 10_000;

    MintBurnToken public immutable share;
    address public immutable manager;
    uint64 public immutable withdrawDelay;
    uint64 public immutable minAuctionDuration;
    uint64 public immutable minBackstopDelay;
    uint64 public immutable minAuctionTimeLeft;
    uint256 public immutable maxEthPerRoll;
    uint256 public immutable maxActiveStrategyEth;
    uint256 public immutable maxRollPriceWad;
    uint256 public immutable minInventorySalePriceWad;
    uint16 public immutable maxAuctionPriceDropBps;
    uint256 public reservedEth;
    uint256 public activeStrategyEth;
    bool public strategyActive;

    struct WithdrawalRequest {
        uint256 assets;
        uint64 unlockAt;
    }

    struct InventorySeries {
        EthOptionsFactory factory;
        bytes32 seriesId;
    }

    mapping(address => WithdrawalRequest) public withdrawalRequests;
    mapping(bytes32 => bool) public inventoryTracked;
    mapping(bytes32 => bool) public inventoryOpen;
    InventorySeries[] public inventorySeries;
    uint256 public openInventorySeriesCount;

    event Deposited(address indexed account, uint256 assets, uint256 shares);
    event WithdrawalRequested(address indexed account, uint256 assets, uint256 shares, uint64 unlockAt);
    event WithdrawalClaimed(address indexed account, uint256 assets);
    event StrategyPolicySet(
        uint256 maxEthPerRoll,
        uint256 maxActiveStrategyEth,
        uint256 maxRollPriceWad,
        uint256 minInventorySalePriceWad,
        uint64 minAuctionDuration,
        uint64 minBackstopDelay,
        uint64 minAuctionTimeLeft,
        uint16 maxAuctionPriceDropBps
    );
    event SteadyRollFilled(
        bytes32 indexed oldSeriesId,
        bytes32 indexed newSeriesId,
        uint256 indexed auctionId,
        uint256 ethMinted,
        uint256 oldPReceived,
        uint256 newPPaid
    );
    event BoostedRollFilled(
        bytes32 indexed oldSeriesId,
        bytes32 indexed newSeriesId,
        uint256 indexed auctionId,
        uint256 ethMinted,
        uint256 oldNReceived,
        uint256 newNPaid
    );
    event SeriesMerged(address indexed factory, bytes32 indexed seriesId, uint256 amount);
    event SeriesRedeemed(address indexed factory, bytes32 indexed seriesId, address indexed token, uint256 amount);
    event InventorySold(
        address indexed market, bytes32 indexed seriesId, address indexed token, uint256 tokenIn, uint256 ethOut
    );
    event InventoryStatusChanged(address indexed factory, bytes32 indexed seriesId, bool open);
    event StrategyClosed();

    error ZeroAmount();
    error NotManager();
    error StrategyActive();
    error InventoryOpen();
    error AuctionTokenMismatch();
    error MarketTokenMismatch();
    error StrategyPolicyViolation();
    error InsufficientManagedAssets();
    error WithdrawNotReady();
    error EthTransferFailed();

    constructor(
        address manager_,
        uint64 withdrawDelay_,
        uint256 maxEthPerRoll_,
        uint256 maxActiveStrategyEth_,
        uint256 maxRollPriceWad_,
        uint256 minInventorySalePriceWad_,
        uint64 minAuctionDuration_,
        uint64 minBackstopDelay_,
        uint64 minAuctionTimeLeft_,
        uint16 maxAuctionPriceDropBps_
    ) {
        if (
            manager_ == address(0) || maxEthPerRoll_ == 0 || maxActiveStrategyEth_ < maxEthPerRoll_
                || maxRollPriceWad_ == 0 || minInventorySalePriceWad_ > WAD || minAuctionDuration_ == 0
                || minBackstopDelay_ + minAuctionTimeLeft_ > minAuctionDuration_ || maxAuctionPriceDropBps_ > BPS
        ) {
            revert StrategyPolicyViolation();
        }

        manager = manager_;
        withdrawDelay = withdrawDelay_;
        maxEthPerRoll = maxEthPerRoll_;
        maxActiveStrategyEth = maxActiveStrategyEth_;
        maxRollPriceWad = maxRollPriceWad_;
        minInventorySalePriceWad = minInventorySalePriceWad_;
        minAuctionDuration = minAuctionDuration_;
        minBackstopDelay = minBackstopDelay_;
        minAuctionTimeLeft = minAuctionTimeLeft_;
        maxAuctionPriceDropBps = maxAuctionPriceDropBps_;
        share = new MintBurnToken("Steady Roll LP ETH", "srLP-ETH", address(this));

        emit StrategyPolicySet(
            maxEthPerRoll_,
            maxActiveStrategyEth_,
            maxRollPriceWad_,
            minInventorySalePriceWad_,
            minAuctionDuration_,
            minBackstopDelay_,
            minAuctionTimeLeft_,
            maxAuctionPriceDropBps_
        );
    }

    receive() external payable {}

    modifier onlyManager() {
        if (msg.sender != manager) revert NotManager();
        _;
    }

    function deposit() external payable returns (uint256 shares) {
        if (strategyActive) revert StrategyActive();
        if (msg.value == 0) revert ZeroAmount();

        uint256 supply = share.totalSupply();
        uint256 managedBefore = managedAssets() - msg.value;
        shares = supply == 0 || managedBefore == 0 ? msg.value : (msg.value * supply) / managedBefore;
        if (shares == 0) revert ZeroAmount();

        share.mint(msg.sender, shares);
        emit Deposited(msg.sender, msg.value, shares);
    }

    function requestWithdraw(uint256 shares) external returns (uint256 assets) {
        if (strategyActive) revert StrategyActive();
        if (shares == 0) revert ZeroAmount();

        uint256 supply = share.totalSupply();
        assets = (shares * managedAssets()) / supply;
        if (assets == 0) revert ZeroAmount();

        share.burn(msg.sender, shares);
        reservedEth += assets;

        WithdrawalRequest storage request = withdrawalRequests[msg.sender];
        request.assets += assets;
        request.unlockAt = uint64(block.timestamp) + withdrawDelay;

        emit WithdrawalRequested(msg.sender, assets, shares, request.unlockAt);
    }

    function claimWithdraw() external returns (uint256 assets) {
        WithdrawalRequest memory request = withdrawalRequests[msg.sender];
        if (request.assets == 0) revert ZeroAmount();
        if (block.timestamp < request.unlockAt) revert WithdrawNotReady();

        delete withdrawalRequests[msg.sender];
        reservedEth -= request.assets;
        _sendEth(msg.sender, request.assets);

        emit WithdrawalClaimed(msg.sender, request.assets);
        return request.assets;
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
    ) external onlyManager returns (uint256 newPPaid) {
        if (oldPAmount == 0 || ethToMint == 0) revert ZeroAmount();
        if (ethToMint > managedAssets()) revert InsufficientManagedAssets();
        if (ethToMint > maxEthPerRoll || activeStrategyEth + ethToMint > maxActiveStrategyEth) {
            revert StrategyPolicyViolation();
        }

        (,,,,,, MintBurnToken oldP,,,,) = factory.series(oldSeriesId);
        (,,,,,, MintBurnToken newP,,,,) = factory.series(newSeriesId);
        (,, IERC20Like auctionSellToken, IERC20Like auctionBuyToken,,,,,,,) = auction.auctions(auctionId);
        if (address(auctionSellToken) != address(oldP) || address(auctionBuyToken) != address(newP)) {
            revert AuctionTokenMismatch();
        }
        _validateAuctionPolicy(auction, auctionId);

        _trackInventory(factory, oldSeriesId);
        _trackInventory(factory, newSeriesId);
        strategyActive = true;

        newPPaid = auction.quote(auctionId, oldPAmount);
        if (newPPaid > ethToMint) revert InsufficientManagedAssets();
        if (newPPaid > _mulDivUp(oldPAmount, maxRollPriceWad, WAD)) revert StrategyPolicyViolation();

        factory.mint{value: ethToMint}(newSeriesId);
        newP.approve(address(auction), maxNewPToPay);
        newPPaid = auction.fill(auctionId, oldPAmount, maxNewPToPay, address(this));
        newP.approve(address(auction), 0);
        activeStrategyEth += ethToMint;
        _refreshInventoryStatus(factory, oldSeriesId);
        _refreshInventoryStatus(factory, newSeriesId);

        emit SteadyRollFilled(oldSeriesId, newSeriesId, auctionId, ethToMint, oldPAmount, newPPaid);
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
    ) external onlyManager returns (uint256 newNPaid) {
        if (oldNAmount == 0 || ethToMint == 0) revert ZeroAmount();
        if (ethToMint > managedAssets()) revert InsufficientManagedAssets();
        if (ethToMint > maxEthPerRoll || activeStrategyEth + ethToMint > maxActiveStrategyEth) {
            revert StrategyPolicyViolation();
        }

        (,,,,,,, MintBurnToken oldN,,,) = factory.series(oldSeriesId);
        (,,,,,,, MintBurnToken newN,,,) = factory.series(newSeriesId);
        (,, IERC20Like auctionSellToken, IERC20Like auctionBuyToken,,,,,,,) = auction.auctions(auctionId);
        if (address(auctionSellToken) != address(oldN) || address(auctionBuyToken) != address(newN)) {
            revert AuctionTokenMismatch();
        }
        _validateAuctionPolicy(auction, auctionId);

        _trackInventory(factory, oldSeriesId);
        _trackInventory(factory, newSeriesId);
        strategyActive = true;

        newNPaid = auction.quote(auctionId, oldNAmount);
        if (newNPaid > ethToMint) revert InsufficientManagedAssets();
        if (newNPaid > _mulDivUp(oldNAmount, maxRollPriceWad, WAD)) revert StrategyPolicyViolation();

        factory.mint{value: ethToMint}(newSeriesId);
        newN.approve(address(auction), maxNewNToPay);
        newNPaid = auction.fill(auctionId, oldNAmount, maxNewNToPay, address(this));
        newN.approve(address(auction), 0);
        activeStrategyEth += ethToMint;
        _refreshInventoryStatus(factory, oldSeriesId);
        _refreshInventoryStatus(factory, newSeriesId);

        emit BoostedRollFilled(oldSeriesId, newSeriesId, auctionId, ethToMint, oldNAmount, newNPaid);
    }

    function mergeSeries(EthOptionsFactory factory, bytes32 seriesId, uint256 amount) external onlyManager {
        if (amount == 0) revert ZeroAmount();
        _trackInventory(factory, seriesId);
        factory.merge(seriesId, amount);
        _refreshInventoryStatus(factory, seriesId);
        emit SeriesMerged(address(factory), seriesId, amount);
    }

    function redeemP(EthOptionsFactory factory, bytes32 seriesId, uint256 amount) external onlyManager {
        if (amount == 0) revert ZeroAmount();
        _trackInventory(factory, seriesId);
        (,,,,,, MintBurnToken pToken,,,,) = factory.series(seriesId);
        factory.redeemP(seriesId, amount);
        _refreshInventoryStatus(factory, seriesId);
        emit SeriesRedeemed(address(factory), seriesId, address(pToken), amount);
    }

    function redeemN(EthOptionsFactory factory, bytes32 seriesId, uint256 amount) external onlyManager {
        if (amount == 0) revert ZeroAmount();
        _trackInventory(factory, seriesId);
        (,,,,,,, MintBurnToken nToken,,,) = factory.series(seriesId);
        factory.redeemN(seriesId, amount);
        _refreshInventoryStatus(factory, seriesId);
        emit SeriesRedeemed(address(factory), seriesId, address(nToken), amount);
    }

    function sellInventory(
        EthOptionsFactory factory,
        bytes32 seriesId,
        bool sellN,
        EthTokenAMM market,
        uint256 amount,
        uint256 minEthOut
    ) external onlyManager returns (uint256 ethOut) {
        if (amount == 0) revert ZeroAmount();
        _trackInventory(factory, seriesId);

        (MintBurnToken pToken, MintBurnToken nToken) = _tokens(factory, seriesId);
        MintBurnToken token = sellN ? nToken : pToken;
        if (address(market) == address(0) || address(market.token()) != address(token)) revert MarketTokenMismatch();

        uint256 policyMinEthOut = _mulDivUp(amount, minInventorySalePriceWad, WAD);
        if (market.quoteSellToken(amount) < policyMinEthOut) revert StrategyPolicyViolation();
        uint256 effectiveMinEthOut = minEthOut > policyMinEthOut ? minEthOut : policyMinEthOut;

        token.approve(address(market), amount);
        ethOut = market.sellToken(amount, effectiveMinEthOut, address(this));
        token.approve(address(market), 0);
        _refreshInventoryStatus(factory, seriesId);

        emit InventorySold(address(market), seriesId, address(token), amount, ethOut);
    }

    function closeStrategy() external onlyManager {
        if (openInventorySeriesCount != 0) revert InventoryOpen();

        strategyActive = false;
        activeStrategyEth = 0;
        emit StrategyClosed();
    }

    function managedAssets() public view returns (uint256) {
        uint256 balance = address(this).balance;
        if (balance < reservedEth) revert InsufficientManagedAssets();
        return balance - reservedEth;
    }

    function convertToShares(uint256 assets) external view returns (uint256) {
        uint256 supply = share.totalSupply();
        uint256 managed = managedAssets();
        return supply == 0 || managed == 0 ? assets : (assets * supply) / managed;
    }

    function convertToAssets(uint256 shares) external view returns (uint256) {
        uint256 supply = share.totalSupply();
        return supply == 0 ? shares : (shares * managedAssets()) / supply;
    }

    function inventorySeriesLength() external view returns (uint256) {
        return inventorySeries.length;
    }

    function _trackInventory(EthOptionsFactory factory, bytes32 seriesId) internal {
        bytes32 key = _inventoryKey(factory, seriesId);
        if (inventoryTracked[key]) return;

        _tokens(factory, seriesId);
        inventoryTracked[key] = true;
        inventorySeries.push(InventorySeries({factory: factory, seriesId: seriesId}));
    }

    function _refreshInventoryStatus(EthOptionsFactory factory, bytes32 seriesId) internal {
        bytes32 key = _inventoryKey(factory, seriesId);
        (MintBurnToken pToken, MintBurnToken nToken) = _tokens(factory, seriesId);
        bool currentlyOpen = pToken.balanceOf(address(this)) != 0 || nToken.balanceOf(address(this)) != 0;
        bool wasOpen = inventoryOpen[key];
        if (currentlyOpen == wasOpen) return;

        inventoryOpen[key] = currentlyOpen;
        if (currentlyOpen) {
            openInventorySeriesCount += 1;
        } else {
            openInventorySeriesCount -= 1;
        }
        emit InventoryStatusChanged(address(factory), seriesId, currentlyOpen);
    }

    function _inventoryKey(EthOptionsFactory factory, bytes32 seriesId) internal pure returns (bytes32) {
        return keccak256(abi.encode(factory, seriesId));
    }

    function _tokens(EthOptionsFactory factory, bytes32 seriesId)
        internal
        view
        returns (MintBurnToken pToken, MintBurnToken nToken)
    {
        (,,,,,, pToken, nToken,,,) = factory.series(seriesId);
    }

    function _mulDivUp(uint256 x, uint256 y, uint256 denominator) internal pure returns (uint256) {
        return (x * y + denominator - 1) / denominator;
    }

    function _validateAuctionPolicy(RollAuction auction, uint256 auctionId) internal view {
        (,,,,,, uint256 startPriceWad, uint256 endPriceWad, uint64 startTime, uint64 duration,) =
            auction.auctions(auctionId);
        if (startTime == 0 || duration < minAuctionDuration) revert StrategyPolicyViolation();

        uint256 elapsed = block.timestamp > startTime ? block.timestamp - startTime : 0;
        if (elapsed < minBackstopDelay) revert StrategyPolicyViolation();
        if (elapsed >= duration || duration - elapsed < minAuctionTimeLeft) revert StrategyPolicyViolation();
        if (_auctionPriceDropBps(startPriceWad, endPriceWad, elapsed, duration) > maxAuctionPriceDropBps) {
            revert StrategyPolicyViolation();
        }
    }

    function _auctionPriceDropBps(uint256 startPriceWad, uint256 endPriceWad, uint256 elapsed, uint64 duration)
        internal
        pure
        returns (uint256)
    {
        uint256 priceWad = elapsed >= duration
            ? endPriceWad
            : startPriceWad - ((startPriceWad - endPriceWad) * elapsed) / duration;
        if (priceWad >= startPriceWad) return 0;
        return ((startPriceWad - priceWad) * BPS) / startPriceWad;
    }

    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }
}
