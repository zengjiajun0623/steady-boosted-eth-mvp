// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Like {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

interface IRollAuctionCallee {
    function rollAuctionCall(
        address taker,
        uint256 auctionId,
        address sellToken,
        address buyToken,
        uint256 sellAmount,
        uint256 buyAmount,
        bytes calldata data
    ) external;
}

/// @notice Permissionless Dutch swap auction for rolling option inventory.
/// @dev The auctioneer escrows `sellToken` and asks takers for `buyToken`.
/// Price is quoted as buyToken per sellToken, 18 decimals, and decays linearly
/// from `startPriceWad` to `endPriceWad`. Once the floor is reached it stays
/// there until the auction is filled or cancelled by the seller.
contract RollAuction {
    uint256 public constant WAD = 1e18;
    uint256 public constant BPS = 10_000;
    uint256 public constant STOP_NEW_AUCTIONS = 1;
    uint256 public constant STOP_RESETS = 2;
    uint256 public constant STOP_FILLS = 3;

    struct Auction {
        address seller;
        address beneficiary;
        IERC20Like sellToken;
        IERC20Like buyToken;
        uint256 remainingSellAmount;
        uint256 buyTokenRaised;
        uint256 startPriceWad;
        uint256 endPriceWad;
        uint64 startTime;
        uint64 duration;
        bool cancelled;
    }

    uint256 public auctionCount;
    address public immutable guardian;
    uint256 public immutable maxActiveAuctions;
    uint256 public immutable maxActiveAuctionsPerSeller;
    uint256 public minSellAmount;
    uint64 public minStaleResetDelay = 12 hours;
    uint16 public minStaleResetPriceDropBps = 5;
    uint256 public stopped;
    mapping(uint256 => Auction) public auctions;
    mapping(address => uint256) public activeAuctionCountBySeller;
    uint256[] private activeAuctionIds;
    mapping(address => uint256[]) private activeAuctionIdsBySeller;
    mapping(uint256 => uint256) private activeIndexPlusOne;
    mapping(uint256 => uint256) private activeSellerIndexPlusOne;

    uint256 private locked = 1;

    event AuctionCreated(
        uint256 indexed auctionId,
        address indexed seller,
        address indexed beneficiary,
        address sellToken,
        address buyToken,
        uint256 sellAmount,
        uint256 startPriceWad,
        uint256 endPriceWad,
        uint64 duration
    );
    event AuctionFilled(
        uint256 indexed auctionId,
        address indexed taker,
        address indexed recipient,
        uint256 sellAmount,
        uint256 buyAmount,
        uint256 priceWad
    );
    event AuctionReset(uint256 indexed auctionId, uint256 startPriceWad, uint256 endPriceWad, uint64 duration);
    event AuctionCancelled(uint256 indexed auctionId, uint256 returnedSellAmount);
    event AuctionCompleted(uint256 indexed auctionId);
    event AuctionCallback(uint256 indexed auctionId, address indexed taker, address indexed callee, uint256 buyAmount);
    event CircuitBreakerSet(uint256 level);
    event MinSellAmountSet(uint256 amount);
    event MaxActiveAuctionsConfigured(uint256 count);
    event MaxActiveAuctionsPerSellerConfigured(uint256 count);
    event StaleResetPolicySet(uint64 minDelay, uint16 minPriceDropBps);

    error InvalidConfig();
    error ZeroAmount();
    error DustAmount();
    error AuctionClosed();
    error AuctionStillRunning();
    error NotGuardian();
    error CircuitBreakerActive(uint256 level);
    error ActiveAuctionLimitReached();
    error SellerActiveAuctionLimitReached();
    error NotSeller();
    error PriceTooHigh();
    error TransferFailed();

    constructor(
        address guardian_,
        uint256 minSellAmount_,
        uint256 maxActiveAuctions_,
        uint256 maxActiveAuctionsPerSeller_
    ) {
        if (minSellAmount_ == 0 || maxActiveAuctions_ == 0 || maxActiveAuctionsPerSeller_ == 0) {
            revert InvalidConfig();
        }
        guardian = guardian_;
        minSellAmount = minSellAmount_;
        maxActiveAuctions = maxActiveAuctions_;
        maxActiveAuctionsPerSeller = maxActiveAuctionsPerSeller_;
        emit MinSellAmountSet(minSellAmount_);
        emit MaxActiveAuctionsConfigured(maxActiveAuctions_);
        emit MaxActiveAuctionsPerSellerConfigured(maxActiveAuctionsPerSeller_);
        emit StaleResetPolicySet(minStaleResetDelay, minStaleResetPriceDropBps);
    }

    modifier nonReentrant() {
        require(locked == 1, "LOCKED");
        locked = 2;
        _;
        locked = 1;
    }

    function createAuction(
        IERC20Like sellToken,
        IERC20Like buyToken,
        uint256 sellAmount,
        uint256 startPriceWad,
        uint256 endPriceWad,
        uint64 duration,
        address beneficiary
    ) external nonReentrant returns (uint256 auctionId) {
        _requireStoppedBelow(STOP_NEW_AUCTIONS);
        if (
            address(sellToken) == address(0) || address(buyToken) == address(0)
                || address(sellToken) == address(buyToken) || beneficiary == address(0) || duration == 0
                || startPriceWad == 0 || endPriceWad == 0 || endPriceWad > startPriceWad
        ) {
            revert InvalidConfig();
        }
        if (sellAmount == 0) revert ZeroAmount();
        if (sellAmount < minSellAmount) revert DustAmount();
        if (activeAuctionIds.length >= maxActiveAuctions) revert ActiveAuctionLimitReached();
        if (activeAuctionCountBySeller[msg.sender] >= maxActiveAuctionsPerSeller) {
            revert SellerActiveAuctionLimitReached();
        }

        auctionId = auctionCount;
        auctionCount = auctionId + 1;

        auctions[auctionId] = Auction({
            seller: msg.sender,
            beneficiary: beneficiary,
            sellToken: sellToken,
            buyToken: buyToken,
            remainingSellAmount: sellAmount,
            buyTokenRaised: 0,
            startPriceWad: startPriceWad,
            endPriceWad: endPriceWad,
            startTime: uint64(block.timestamp),
            duration: duration,
            cancelled: false
        });

        _pull(sellToken, msg.sender, address(this), sellAmount);
        _activate(auctionId);

        emit AuctionCreated(
            auctionId,
            msg.sender,
            beneficiary,
            address(sellToken),
            address(buyToken),
            sellAmount,
            startPriceWad,
            endPriceWad,
            duration
        );
    }

    function fill(uint256 auctionId, uint256 sellAmount, uint256 maxBuyAmount, address recipient)
        external
        nonReentrant
        returns (uint256 buyAmount)
    {
        return _fill(auctionId, sellAmount, maxBuyAmount, recipient);
    }

    function fillAll(uint256 auctionId, uint256 maxBuyAmount, address recipient)
        external
        nonReentrant
        returns (uint256 sellAmount, uint256 buyAmount)
    {
        Auction storage auction = auctions[auctionId];
        sellAmount = auction.remainingSellAmount;
        if (auction.cancelled || sellAmount == 0) revert AuctionClosed();

        buyAmount = _fill(auctionId, sellAmount, maxBuyAmount, recipient);
    }

    function fillWithCallback(
        uint256 auctionId,
        uint256 sellAmount,
        uint256 maxBuyAmount,
        address callee,
        bytes calldata data
    ) external nonReentrant returns (uint256 buyAmount) {
        return _fillWithCallback(auctionId, sellAmount, maxBuyAmount, callee, data);
    }

    function fillAllWithCallback(uint256 auctionId, uint256 maxBuyAmount, address callee, bytes calldata data)
        external
        nonReentrant
        returns (uint256 sellAmount, uint256 buyAmount)
    {
        Auction storage auction = auctions[auctionId];
        sellAmount = auction.remainingSellAmount;
        if (auction.cancelled || sellAmount == 0) revert AuctionClosed();

        buyAmount = _fillWithCallback(auctionId, sellAmount, maxBuyAmount, callee, data);
    }

    function _fill(uint256 auctionId, uint256 sellAmount, uint256 maxBuyAmount, address recipient)
        internal
        returns (uint256 buyAmount)
    {
        if (recipient == address(0)) revert InvalidConfig();

        (Auction storage auction, uint256 priceWad) = _recordFill(auctionId, sellAmount, maxBuyAmount);
        buyAmount = _mulDivUp(sellAmount, priceWad, WAD);

        _pull(auction.buyToken, msg.sender, auction.beneficiary, buyAmount);
        _push(auction.sellToken, recipient, sellAmount);

        emit AuctionFilled(auctionId, msg.sender, recipient, sellAmount, buyAmount, priceWad);
    }

    function _fillWithCallback(
        uint256 auctionId,
        uint256 sellAmount,
        uint256 maxBuyAmount,
        address callee,
        bytes calldata data
    ) internal returns (uint256 buyAmount) {
        if (callee == address(0)) revert InvalidConfig();

        (Auction storage auction, uint256 priceWad) = _recordFill(auctionId, sellAmount, maxBuyAmount);
        buyAmount = _mulDivUp(sellAmount, priceWad, WAD);

        _push(auction.sellToken, callee, sellAmount);
        IRollAuctionCallee(callee)
            .rollAuctionCall(
                msg.sender,
                auctionId,
                address(auction.sellToken),
                address(auction.buyToken),
                sellAmount,
                buyAmount,
                data
            );
        _pull(auction.buyToken, callee, auction.beneficiary, buyAmount);

        emit AuctionCallback(auctionId, msg.sender, callee, buyAmount);
        emit AuctionFilled(auctionId, msg.sender, callee, sellAmount, buyAmount, priceWad);
    }

    function _recordFill(uint256 auctionId, uint256 sellAmount, uint256 maxBuyAmount)
        internal
        returns (Auction storage auction, uint256 priceWad)
    {
        _requireStoppedBelow(STOP_FILLS);
        if (sellAmount == 0) revert ZeroAmount();

        auction = auctions[auctionId];
        if (auction.cancelled || auction.remainingSellAmount < sellAmount) revert AuctionClosed();
        _validateFillSize(sellAmount, auction.remainingSellAmount);

        priceWad = currentPriceWad(auctionId);
        uint256 buyAmount = _mulDivUp(sellAmount, priceWad, WAD);
        if (buyAmount > maxBuyAmount) revert PriceTooHigh();

        auction.remainingSellAmount -= sellAmount;
        auction.buyTokenRaised += buyAmount;
        if (auction.remainingSellAmount == 0) {
            _deactivate(auctionId);
            emit AuctionCompleted(auctionId);
        }
    }

    function cancel(uint256 auctionId) external nonReentrant returns (uint256 returnedSellAmount) {
        Auction storage auction = auctions[auctionId];
        if (msg.sender != auction.seller) revert NotSeller();
        if (auction.cancelled || auction.remainingSellAmount == 0) revert AuctionClosed();

        returnedSellAmount = auction.remainingSellAmount;
        auction.remainingSellAmount = 0;
        auction.cancelled = true;
        _deactivate(auctionId);

        _push(auction.sellToken, auction.seller, returnedSellAmount);
        emit AuctionCancelled(auctionId, returnedSellAmount);
    }

    function redo(uint256 auctionId, uint256 startPriceWad, uint256 endPriceWad, uint64 duration)
        external
        nonReentrant
    {
        _requireStoppedBelow(STOP_RESETS);
        Auction storage auction = auctions[auctionId];
        if (msg.sender != auction.seller) revert NotSeller();
        if (auction.cancelled || auction.remainingSellAmount == 0) revert AuctionClosed();
        if (duration == 0 || startPriceWad == 0 || endPriceWad == 0 || endPriceWad > startPriceWad) {
            revert InvalidConfig();
        }
        if (!_canReset(auction)) revert AuctionStillRunning();

        auction.startPriceWad = startPriceWad;
        auction.endPriceWad = endPriceWad;
        auction.startTime = uint64(block.timestamp);
        auction.duration = duration;

        emit AuctionReset(auctionId, startPriceWad, endPriceWad, duration);
    }

    function setStopped(uint256 level) external {
        if (msg.sender != guardian) revert NotGuardian();
        if (level > STOP_FILLS) revert InvalidConfig();

        stopped = level;
        emit CircuitBreakerSet(level);
    }

    function setMinSellAmount(uint256 amount) external {
        if (msg.sender != guardian) revert NotGuardian();
        if (amount == 0) revert InvalidConfig();

        minSellAmount = amount;
        emit MinSellAmountSet(amount);
    }

    function setStaleResetPolicy(uint64 minDelay, uint16 minPriceDropBps) external {
        if (msg.sender != guardian) revert NotGuardian();
        if (minPriceDropBps > BPS || (minPriceDropBps != 0 && minDelay == 0)) revert InvalidConfig();

        minStaleResetDelay = minDelay;
        minStaleResetPriceDropBps = minPriceDropBps;
        emit StaleResetPolicySet(minDelay, minPriceDropBps);
    }

    function activeAuctionCount() external view returns (uint256) {
        return activeAuctionIds.length;
    }

    function activeAuctionIdAt(uint256 index) external view returns (uint256) {
        return activeAuctionIds[index];
    }

    function activeAuctionIdBySellerAt(address seller, uint256 index) external view returns (uint256) {
        return activeAuctionIdsBySeller[seller][index];
    }

    function isActive(uint256 auctionId) public view returns (bool) {
        return activeIndexPlusOne[auctionId] != 0;
    }

    function quote(uint256 auctionId, uint256 sellAmount) external view returns (uint256 buyAmount) {
        if (sellAmount == 0) revert ZeroAmount();
        Auction storage auction = auctions[auctionId];
        if (auction.cancelled || auction.remainingSellAmount < sellAmount) revert AuctionClosed();
        _validateFillSize(sellAmount, auction.remainingSellAmount);
        return _mulDivUp(sellAmount, currentPriceWad(auctionId), WAD);
    }

    function auctionStatus(uint256 auctionId)
        external
        view
        returns (
            bool open,
            bool active,
            bool priceAtFloor,
            uint256 remainingSellAmount,
            uint256 buyTokenRaised,
            uint256 priceWad,
            uint256 elapsed,
            uint256 timeLeft
        )
    {
        Auction storage auction = auctions[auctionId];
        if (auction.startTime == 0 && auction.duration == 0) revert AuctionClosed();

        active = isActive(auctionId);
        open = active && !auction.cancelled && auction.remainingSellAmount != 0;
        remainingSellAmount = auction.remainingSellAmount;
        buyTokenRaised = auction.buyTokenRaised;
        priceWad = currentPriceWad(auctionId);
        elapsed = block.timestamp - auction.startTime;
        if (elapsed >= auction.duration) {
            priceAtFloor = true;
            timeLeft = 0;
        } else {
            priceAtFloor = priceWad == auction.endPriceWad;
            timeLeft = auction.duration - elapsed;
        }
    }

    function currentPriceWad(uint256 auctionId) public view returns (uint256) {
        Auction storage auction = auctions[auctionId];
        if (auction.startTime == 0 && auction.duration == 0) revert AuctionClosed();

        return _currentPriceWad(auction);
    }

    function resetStatus(uint256 auctionId)
        external
        view
        returns (bool expired, bool priceStale, uint256 elapsed, uint256 priceWad, uint256 priceDropBps)
    {
        Auction storage auction = auctions[auctionId];
        if (auction.startTime == 0 && auction.duration == 0) revert AuctionClosed();

        elapsed = block.timestamp - auction.startTime;
        expired = elapsed >= auction.duration;
        priceWad = _currentPriceWad(auction);
        priceDropBps = _priceDropBps(auction.startPriceWad, priceWad);
        uint16 staleDrop = minStaleResetPriceDropBps;
        priceStale = staleDrop != 0 && elapsed >= minStaleResetDelay && priceDropBps >= staleDrop;
    }

    function _currentPriceWad(Auction storage auction) internal view returns (uint256) {
        uint256 elapsed = block.timestamp - auction.startTime;
        if (elapsed >= auction.duration) return auction.endPriceWad;

        uint256 discount = ((auction.startPriceWad - auction.endPriceWad) * elapsed) / auction.duration;
        return auction.startPriceWad - discount;
    }

    function _canReset(Auction storage auction) internal view returns (bool) {
        uint256 elapsed = block.timestamp - auction.startTime;
        if (elapsed >= auction.duration) return true;

        uint16 staleDrop = minStaleResetPriceDropBps;
        if (staleDrop == 0 || elapsed < minStaleResetDelay) return false;

        uint256 priceWad = _currentPriceWad(auction);
        return _priceDropBps(auction.startPriceWad, priceWad) >= staleDrop;
    }

    function _priceDropBps(uint256 startPriceWad, uint256 priceWad) internal pure returns (uint256) {
        if (priceWad >= startPriceWad) return 0;
        return ((startPriceWad - priceWad) * BPS) / startPriceWad;
    }

    function _activate(uint256 auctionId) internal {
        activeAuctionIds.push(auctionId);
        activeIndexPlusOne[auctionId] = activeAuctionIds.length;

        address seller = auctions[auctionId].seller;
        activeAuctionIdsBySeller[seller].push(auctionId);
        activeSellerIndexPlusOne[auctionId] = activeAuctionIdsBySeller[seller].length;
        activeAuctionCountBySeller[seller] += 1;
    }

    function _deactivate(uint256 auctionId) internal {
        uint256 indexPlusOne = activeIndexPlusOne[auctionId];
        if (indexPlusOne == 0) return;

        uint256 index = indexPlusOne - 1;
        uint256 lastIndex = activeAuctionIds.length - 1;
        if (index != lastIndex) {
            uint256 movedId = activeAuctionIds[lastIndex];
            activeAuctionIds[index] = movedId;
            activeIndexPlusOne[movedId] = indexPlusOne;
        }

        activeAuctionIds.pop();
        delete activeIndexPlusOne[auctionId];

        address seller = auctions[auctionId].seller;
        uint256 sellerIndexPlusOne = activeSellerIndexPlusOne[auctionId];
        if (sellerIndexPlusOne != 0) {
            uint256 sellerIndex = sellerIndexPlusOne - 1;
            uint256 sellerLastIndex = activeAuctionIdsBySeller[seller].length - 1;
            if (sellerIndex != sellerLastIndex) {
                uint256 movedId = activeAuctionIdsBySeller[seller][sellerLastIndex];
                activeAuctionIdsBySeller[seller][sellerIndex] = movedId;
                activeSellerIndexPlusOne[movedId] = sellerIndexPlusOne;
            }

            activeAuctionIdsBySeller[seller].pop();
            delete activeSellerIndexPlusOne[auctionId];
        }

        uint256 sellerCount = activeAuctionCountBySeller[seller];
        if (sellerCount != 0) activeAuctionCountBySeller[seller] = sellerCount - 1;
    }

    function _requireStoppedBelow(uint256 level) internal view {
        uint256 currentLevel = stopped;
        if (currentLevel >= level) revert CircuitBreakerActive(currentLevel);
    }

    function _validateFillSize(uint256 sellAmount, uint256 remainingBefore) internal view {
        uint256 minimum = minSellAmount;
        if (sellAmount != remainingBefore && sellAmount < minimum) revert DustAmount();

        uint256 remainingAfter = remainingBefore - sellAmount;
        if (remainingAfter != 0 && remainingAfter < minimum) revert DustAmount();
    }

    function _mulDivUp(uint256 x, uint256 y, uint256 denominator) internal pure returns (uint256) {
        return (x * y + denominator - 1) / denominator;
    }

    function _pull(IERC20Like token, address from, address to, uint256 amount) internal {
        if (!token.transferFrom(from, to, amount)) revert TransferFailed();
    }

    function _push(IERC20Like token, address to, uint256 amount) internal {
        if (!token.transfer(to, amount)) revert TransferFailed();
    }
}
