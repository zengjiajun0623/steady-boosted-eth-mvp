// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EthOptionsFactory} from "../EthOptionsFactory.sol";
import {RollAuction, IERC20Like} from "../RollAuction.sol";
import {EthTokenAMM} from "../market/EthTokenAMM.sol";
import {MintBurnToken} from "../token/MintBurnToken.sol";
import {SeriesExposureVault} from "./SeriesExposureVault.sol";

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
    uint16 public immutable productTradeFeeBps;
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
    mapping(address => bool) public inventoryMarketTracked;
    mapping(address => bool) public inventoryMarketOpen;
    EthTokenAMM[] public inventoryMarkets;
    uint256 public openInventoryMarketCount;

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
        uint16 maxAuctionPriceDropBps,
        uint16 productTradeFeeBps
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
    event ProductBought(
        address indexed wrapper,
        bytes32 indexed seriesId,
        address indexed recipient,
        bool boostedSide,
        uint256 ethIn,
        uint256 feeEth,
        uint256 sharesOut
    );
    event ProductSold(
        address indexed wrapper,
        bytes32 indexed seriesId,
        address indexed recipient,
        bool boostedSide,
        uint256 sharesIn,
        uint256 feeEth,
        uint256 ethOut
    );
    event InventoryLiquidityAdded(
        address indexed market,
        bytes32 indexed seriesId,
        address indexed token,
        uint256 ethIn,
        uint256 tokenIn,
        uint256 shares
    );
    event InventoryLiquidityRemoved(
        address indexed market,
        bytes32 indexed seriesId,
        address indexed token,
        uint256 ethOut,
        uint256 tokenOut,
        uint256 shares
    );
    event InventoryStatusChanged(address indexed factory, bytes32 indexed seriesId, bool open);
    event InventoryMarketStatusChanged(address indexed market, bool open);
    event StrategyClosed();

    error ZeroAmount();
    error NotManager();
    error StrategyActive();
    error InventoryOpen();
    error AuctionTokenMismatch();
    error MarketTokenMismatch();
    error MarketLiquidityMissing();
    error ProductTokenMismatch();
    error InvalidRecipient();
    error Slippage();
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
        uint16 maxAuctionPriceDropBps_,
        uint16 productTradeFeeBps_
    ) {
        if (
            manager_ == address(0) || maxEthPerRoll_ == 0 || maxActiveStrategyEth_ < maxEthPerRoll_
                || maxRollPriceWad_ == 0 || minInventorySalePriceWad_ > WAD || minAuctionDuration_ == 0
                || minBackstopDelay_ + minAuctionTimeLeft_ > minAuctionDuration_ || maxAuctionPriceDropBps_ > BPS
                || productTradeFeeBps_ >= BPS
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
        productTradeFeeBps = productTradeFeeBps_;
        share = new MintBurnToken("Steady Roll LP ETH", "srLP-ETH", address(this));

        emit StrategyPolicySet(
            maxEthPerRoll_,
            maxActiveStrategyEth_,
            maxRollPriceWad_,
            minInventorySalePriceWad_,
            minAuctionDuration_,
            minBackstopDelay_,
            minAuctionTimeLeft_,
            maxAuctionPriceDropBps_,
            productTradeFeeBps_
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

    function buySteady(
        EthOptionsFactory factory,
        bytes32 seriesId,
        SeriesExposureVault wrapper,
        uint256 minSharesOut,
        address recipient
    ) external payable returns (uint256 sharesOut) {
        return _buyProduct(factory, seriesId, wrapper, false, minSharesOut, recipient);
    }

    function buyBoosted(
        EthOptionsFactory factory,
        bytes32 seriesId,
        SeriesExposureVault wrapper,
        uint256 minSharesOut,
        address recipient
    ) external payable returns (uint256 sharesOut) {
        return _buyProduct(factory, seriesId, wrapper, true, minSharesOut, recipient);
    }

    function sellSteady(
        EthOptionsFactory factory,
        bytes32 seriesId,
        SeriesExposureVault wrapper,
        uint256 sharesIn,
        uint256 minEthOut,
        address recipient
    ) external returns (uint256 ethOut) {
        return _sellProduct(factory, seriesId, wrapper, false, sharesIn, minEthOut, recipient);
    }

    function sellBoosted(
        EthOptionsFactory factory,
        bytes32 seriesId,
        SeriesExposureVault wrapper,
        uint256 sharesIn,
        uint256 minEthOut,
        address recipient
    ) external returns (uint256 ethOut) {
        return _sellProduct(factory, seriesId, wrapper, true, sharesIn, minEthOut, recipient);
    }

    function quoteBuyProduct(SeriesExposureVault wrapper, uint256 ethIn) external view returns (uint256 sharesOut) {
        uint256 productAmount = _netOfFee(ethIn);
        return wrapper.convertToShares(productAmount);
    }

    function quoteSellProduct(SeriesExposureVault wrapper, uint256 sharesIn)
        external
        view
        returns (uint256 ethOut, uint256 feeEth, uint256 productAmount)
    {
        if (sharesIn == 0) revert ZeroAmount();
        productAmount = wrapper.convertToAssets(sharesIn);
        feeEth = _tradeFee(productAmount);
        ethOut = productAmount - feeEth;
    }

    function addInventoryLiquidity(
        EthOptionsFactory factory,
        bytes32 seriesId,
        bool useN,
        EthTokenAMM market,
        uint256 tokenAmount,
        uint256 ethAmount,
        uint256 minShares
    ) external onlyManager returns (uint256 shares, uint256 ethIn, uint256 tokenIn) {
        if (tokenAmount == 0 || ethAmount == 0) revert ZeroAmount();
        if (ethAmount > managedAssets()) revert InsufficientManagedAssets();
        if (ethAmount > maxEthPerRoll || activeStrategyEth + ethAmount > maxActiveStrategyEth) {
            revert StrategyPolicyViolation();
        }

        _trackInventory(factory, seriesId);
        MintBurnToken token = _matchingInventoryToken(factory, seriesId, useN, market);
        _validateMarketLiquidityPolicy(market);
        _trackMarket(market);
        strategyActive = true;

        token.approve(address(market), tokenAmount);
        (shares, ethIn, tokenIn) = market.addLiquidity{value: ethAmount}(tokenAmount, minShares, address(this));
        token.approve(address(market), 0);
        activeStrategyEth += ethIn;
        _refreshInventoryStatus(factory, seriesId);
        _refreshMarketStatus(market);

        emit InventoryLiquidityAdded(address(market), seriesId, address(token), ethIn, tokenIn, shares);
    }

    function removeInventoryLiquidity(
        EthOptionsFactory factory,
        bytes32 seriesId,
        bool useN,
        EthTokenAMM market,
        uint256 shares,
        uint256 minEthOut,
        uint256 minTokenOut
    ) external onlyManager returns (uint256 ethOut, uint256 tokenOut) {
        if (shares == 0) revert ZeroAmount();

        _trackInventory(factory, seriesId);
        MintBurnToken token = _matchingInventoryToken(factory, seriesId, useN, market);
        _trackMarket(market);

        (ethOut, tokenOut) = market.removeLiquidity(shares, minEthOut, minTokenOut, address(this));
        _refreshMarketStatus(market);
        _refreshInventoryStatus(factory, seriesId);

        emit InventoryLiquidityRemoved(address(market), seriesId, address(token), ethOut, tokenOut, shares);
    }

    function closeStrategy() external onlyManager {
        if (openInventorySeriesCount != 0 || openInventoryMarketCount != 0) revert InventoryOpen();

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

    function inventoryMarketsLength() external view returns (uint256) {
        return inventoryMarkets.length;
    }

    function _buyProduct(
        EthOptionsFactory factory,
        bytes32 seriesId,
        SeriesExposureVault wrapper,
        bool boostedSide,
        uint256 minSharesOut,
        address recipient
    ) internal returns (uint256 sharesOut) {
        if (recipient == address(0)) revert InvalidRecipient();
        if (msg.value == 0) revert ZeroAmount();

        uint256 feeEth = _tradeFee(msg.value);
        uint256 productAmount = msg.value - feeEth;
        if (productAmount == 0 || productAmount > maxEthPerRoll) revert StrategyPolicyViolation();
        if (activeStrategyEth + productAmount > maxActiveStrategyEth) revert StrategyPolicyViolation();

        (MintBurnToken pToken, MintBurnToken nToken) = _tokens(factory, seriesId);
        MintBurnToken productToken = boostedSide ? nToken : pToken;
        if (address(wrapper.currentToken()) != address(productToken)) revert ProductTokenMismatch();

        _trackInventory(factory, seriesId);
        strategyActive = true;
        activeStrategyEth += productAmount;

        factory.mint{value: productAmount}(seriesId);
        productToken.approve(address(wrapper), productAmount);
        sharesOut = wrapper.deposit(productAmount, minSharesOut, recipient);
        productToken.approve(address(wrapper), 0);
        _refreshInventoryStatus(factory, seriesId);

        emit ProductBought(address(wrapper), seriesId, recipient, boostedSide, msg.value, feeEth, sharesOut);
    }

    function _sellProduct(
        EthOptionsFactory factory,
        bytes32 seriesId,
        SeriesExposureVault wrapper,
        bool boostedSide,
        uint256 sharesIn,
        uint256 minEthOut,
        address recipient
    ) internal returns (uint256 ethOut) {
        if (recipient == address(0)) revert InvalidRecipient();
        if (sharesIn == 0) revert ZeroAmount();

        (MintBurnToken pToken, MintBurnToken nToken) = _tokens(factory, seriesId);
        MintBurnToken productToken = boostedSide ? nToken : pToken;
        MintBurnToken wrapperShare = wrapper.share();
        if (address(wrapper.currentToken()) != address(productToken)) revert ProductTokenMismatch();

        _trackInventory(factory, seriesId);
        if (!wrapperShare.transferFrom(msg.sender, address(this), sharesIn)) revert MarketTokenMismatch();
        uint256 productAmount = wrapper.redeem(sharesIn, 0, address(this));
        uint256 feeEth = _tradeFee(productAmount);
        ethOut = productAmount - feeEth;
        if (ethOut == 0) revert ZeroAmount();
        if (ethOut < minEthOut) revert Slippage();
        if (productAmount > maxEthPerRoll || activeStrategyEth + productAmount > maxActiveStrategyEth) {
            revert StrategyPolicyViolation();
        }
        if (ethOut > managedAssets()) revert InsufficientManagedAssets();

        strategyActive = true;
        activeStrategyEth += productAmount;
        _refreshInventoryStatus(factory, seriesId);
        _sendEth(recipient, ethOut);

        emit ProductSold(address(wrapper), seriesId, recipient, boostedSide, sharesIn, feeEth, ethOut);
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

    function _trackMarket(EthTokenAMM market) internal {
        address marketAddress = address(market);
        if (inventoryMarketTracked[marketAddress]) return;

        if (marketAddress == address(0)) revert MarketTokenMismatch();
        market.lpToken();
        inventoryMarketTracked[marketAddress] = true;
        inventoryMarkets.push(market);
    }

    function _refreshMarketStatus(EthTokenAMM market) internal {
        address marketAddress = address(market);
        bool currentlyOpen = market.lpToken().balanceOf(address(this)) != 0;
        bool wasOpen = inventoryMarketOpen[marketAddress];
        if (currentlyOpen == wasOpen) return;

        inventoryMarketOpen[marketAddress] = currentlyOpen;
        if (currentlyOpen) {
            openInventoryMarketCount += 1;
        } else {
            openInventoryMarketCount -= 1;
        }
        emit InventoryMarketStatusChanged(marketAddress, currentlyOpen);
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

    function _matchingInventoryToken(
        EthOptionsFactory factory,
        bytes32 seriesId,
        bool useN,
        EthTokenAMM market
    ) internal view returns (MintBurnToken token) {
        (MintBurnToken pToken, MintBurnToken nToken) = _tokens(factory, seriesId);
        token = useN ? nToken : pToken;
        if (address(market) == address(0) || address(market.token()) != address(token)) revert MarketTokenMismatch();
    }

    function _validateMarketLiquidityPolicy(EthTokenAMM market) internal view {
        uint256 ethReserve = market.ethReserve();
        uint256 tokenReserve = market.tokenReserve();
        if (ethReserve == 0 || tokenReserve == 0) revert MarketLiquidityMissing();

        uint256 poolPriceWad = (ethReserve * WAD) / tokenReserve;
        if (poolPriceWad < minInventorySalePriceWad) revert StrategyPolicyViolation();
    }

    function _tradeFee(uint256 amount) internal view returns (uint256) {
        return (amount * productTradeFeeBps) / BPS;
    }

    function _netOfFee(uint256 amount) internal view returns (uint256) {
        return amount - _tradeFee(amount);
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
