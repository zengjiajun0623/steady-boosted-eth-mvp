// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EthOptionsFactory} from "./EthOptionsFactory.sol";
import {IERC20Like, IRollAuctionCallee, RollAuction} from "./RollAuction.sol";
import {MintBurnToken} from "./token/MintBurnToken.sol";

/// @notice Permissionless helper for external solvers bidding roll auctions.
/// @dev A solver sends ETH, this contract mints the next option series, pays
/// the auction with the chosen newly minted side, and returns leftover
/// inventory to the solver's chosen recipient.
contract RollSolver is IRollAuctionCallee {
    uint256 private locked = 1;

    struct CallbackFillContext {
        RollAuction auction;
        EthOptionsFactory factory;
        bytes32 seriesId;
        uint256 auctionId;
        uint256 sellAmount;
        uint256 ethToMint;
        uint256 buyAmount;
        MintBurnToken buyToken;
        MintBurnToken pairedToken;
        address recipient;
        bool active;
    }

    CallbackFillContext private callbackFillContext;

    event MintedAndFilled(
        address indexed solver,
        address indexed recipient,
        uint256 indexed auctionId,
        bytes32 seriesId,
        uint256 ethMinted,
        uint256 sellAmountBought,
        uint256 buyAmountPaid
    );

    error ZeroAmount();
    error InvalidRecipient();
    error InsufficientMintedP();
    error InsufficientMintedN();
    error UnauthorizedCallback();
    error TransferFailed();

    modifier nonReentrant() {
        require(locked == 1, "LOCKED");
        locked = 2;
        _;
        locked = 1;
    }

    function mintAndFill(
        EthOptionsFactory factory,
        RollAuction auction,
        bytes32 newSeriesId,
        uint256 auctionId,
        uint256 sellAmount,
        uint256 maxBuyAmount,
        address recipient
    ) external payable nonReentrant returns (uint256 buyAmount) {
        return _mintAndFill(factory, auction, newSeriesId, auctionId, sellAmount, maxBuyAmount, recipient, false);
    }

    function mintAndFillAll(
        EthOptionsFactory factory,
        RollAuction auction,
        bytes32 newSeriesId,
        uint256 auctionId,
        uint256 maxBuyAmount,
        address recipient
    ) external payable nonReentrant returns (uint256 sellAmount, uint256 buyAmount) {
        return _mintAndFillAll(factory, auction, newSeriesId, auctionId, maxBuyAmount, recipient, false);
    }

    function mintAndFillN(
        EthOptionsFactory factory,
        RollAuction auction,
        bytes32 newSeriesId,
        uint256 auctionId,
        uint256 sellAmount,
        uint256 maxBuyAmount,
        address recipient
    ) external payable nonReentrant returns (uint256 buyAmount) {
        return _mintAndFill(factory, auction, newSeriesId, auctionId, sellAmount, maxBuyAmount, recipient, true);
    }

    function mintAndFillAllN(
        EthOptionsFactory factory,
        RollAuction auction,
        bytes32 newSeriesId,
        uint256 auctionId,
        uint256 maxBuyAmount,
        address recipient
    ) external payable nonReentrant returns (uint256 sellAmount, uint256 buyAmount) {
        return _mintAndFillAll(factory, auction, newSeriesId, auctionId, maxBuyAmount, recipient, true);
    }

    function mintAndFillWithCallback(
        EthOptionsFactory factory,
        RollAuction auction,
        bytes32 newSeriesId,
        uint256 auctionId,
        uint256 sellAmount,
        uint256 maxBuyAmount,
        address recipient
    ) external payable nonReentrant returns (uint256 buyAmount) {
        return _mintAndFillWithCallback(
            factory, auction, newSeriesId, auctionId, sellAmount, maxBuyAmount, recipient, false
        );
    }

    function mintAndFillAllWithCallback(
        EthOptionsFactory factory,
        RollAuction auction,
        bytes32 newSeriesId,
        uint256 auctionId,
        uint256 maxBuyAmount,
        address recipient
    ) external payable nonReentrant returns (uint256 sellAmount, uint256 buyAmount) {
        return _mintAndFillAllWithCallback(factory, auction, newSeriesId, auctionId, maxBuyAmount, recipient, false);
    }

    function mintAndFillNWithCallback(
        EthOptionsFactory factory,
        RollAuction auction,
        bytes32 newSeriesId,
        uint256 auctionId,
        uint256 sellAmount,
        uint256 maxBuyAmount,
        address recipient
    ) external payable nonReentrant returns (uint256 buyAmount) {
        return _mintAndFillWithCallback(
            factory, auction, newSeriesId, auctionId, sellAmount, maxBuyAmount, recipient, true
        );
    }

    function mintAndFillAllNWithCallback(
        EthOptionsFactory factory,
        RollAuction auction,
        bytes32 newSeriesId,
        uint256 auctionId,
        uint256 maxBuyAmount,
        address recipient
    ) external payable nonReentrant returns (uint256 sellAmount, uint256 buyAmount) {
        return _mintAndFillAllWithCallback(factory, auction, newSeriesId, auctionId, maxBuyAmount, recipient, true);
    }

    function rollAuctionCall(
        address,
        uint256 auctionId,
        address sellToken,
        address buyToken,
        uint256 sellAmount,
        uint256 buyAmount,
        bytes calldata
    ) external {
        CallbackFillContext memory context = callbackFillContext;
        if (
            !context.active || msg.sender != address(context.auction) || auctionId != context.auctionId
                || sellAmount != context.sellAmount || buyAmount != context.buyAmount
                || buyToken != address(context.buyToken)
        ) {
            revert UnauthorizedCallback();
        }

        context.factory.mint{value: context.ethToMint}(context.seriesId);

        uint256 remainingBuyToken = context.ethToMint - buyAmount;
        if (remainingBuyToken != 0) _push(context.buyToken, context.recipient, remainingBuyToken);
        _push(context.pairedToken, context.recipient, context.ethToMint);

        if (!IERC20Like(sellToken).transfer(context.recipient, sellAmount)) revert TransferFailed();
        context.buyToken.approve(msg.sender, buyAmount);
    }

    function _mintAndFill(
        EthOptionsFactory factory,
        RollAuction auction,
        bytes32 newSeriesId,
        uint256 auctionId,
        uint256 sellAmount,
        uint256 maxBuyAmount,
        address recipient,
        bool payWithN
    ) internal returns (uint256 buyAmount) {
        if (msg.value == 0 || sellAmount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert InvalidRecipient();

        buyAmount = auction.quote(auctionId, sellAmount);
        if (buyAmount > msg.value) {
            if (payWithN) revert InsufficientMintedN();
            revert InsufficientMintedP();
        }

        (,,,,,, MintBurnToken pToken, MintBurnToken nToken,,,) = factory.series(newSeriesId);
        MintBurnToken buyToken = payWithN ? nToken : pToken;
        MintBurnToken pairedToken = payWithN ? pToken : nToken;

        factory.mint{value: msg.value}(newSeriesId);
        buyToken.approve(address(auction), maxBuyAmount);
        buyAmount = auction.fill(auctionId, sellAmount, maxBuyAmount, recipient);
        buyToken.approve(address(auction), 0);

        uint256 remainingBuyToken = msg.value - buyAmount;
        if (remainingBuyToken != 0) _push(buyToken, recipient, remainingBuyToken);
        _push(pairedToken, recipient, msg.value);

        emit MintedAndFilled(msg.sender, recipient, auctionId, newSeriesId, msg.value, sellAmount, buyAmount);
    }

    function _mintAndFillAll(
        EthOptionsFactory factory,
        RollAuction auction,
        bytes32 newSeriesId,
        uint256 auctionId,
        uint256 maxBuyAmount,
        address recipient,
        bool payWithN
    ) internal returns (uint256 sellAmount, uint256 buyAmount) {
        sellAmount = _remainingSellAmount(auction, auctionId);
        if (sellAmount == 0) revert ZeroAmount();
        if (msg.value == 0) revert ZeroAmount();
        if (recipient == address(0)) revert InvalidRecipient();

        buyAmount = auction.quote(auctionId, sellAmount);
        if (buyAmount > msg.value) {
            if (payWithN) revert InsufficientMintedN();
            revert InsufficientMintedP();
        }

        (,,,,,, MintBurnToken pToken, MintBurnToken nToken,,,) = factory.series(newSeriesId);
        MintBurnToken buyToken = payWithN ? nToken : pToken;
        MintBurnToken pairedToken = payWithN ? pToken : nToken;

        factory.mint{value: msg.value}(newSeriesId);
        buyToken.approve(address(auction), maxBuyAmount);
        (sellAmount, buyAmount) = auction.fillAll(auctionId, maxBuyAmount, recipient);
        buyToken.approve(address(auction), 0);

        uint256 remainingBuyToken = msg.value - buyAmount;
        if (remainingBuyToken != 0) _push(buyToken, recipient, remainingBuyToken);
        _push(pairedToken, recipient, msg.value);

        emit MintedAndFilled(msg.sender, recipient, auctionId, newSeriesId, msg.value, sellAmount, buyAmount);
    }

    function _mintAndFillWithCallback(
        EthOptionsFactory factory,
        RollAuction auction,
        bytes32 newSeriesId,
        uint256 auctionId,
        uint256 sellAmount,
        uint256 maxBuyAmount,
        address recipient,
        bool payWithN
    ) internal returns (uint256 buyAmount) {
        if (msg.value == 0 || sellAmount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert InvalidRecipient();

        buyAmount = auction.quote(auctionId, sellAmount);
        if (buyAmount > msg.value) {
            if (payWithN) revert InsufficientMintedN();
            revert InsufficientMintedP();
        }

        (,,,,,, MintBurnToken pToken, MintBurnToken nToken,,,) = factory.series(newSeriesId);
        MintBurnToken buyToken = payWithN ? nToken : pToken;
        MintBurnToken pairedToken = payWithN ? pToken : nToken;

        callbackFillContext = CallbackFillContext({
            auction: auction,
            factory: factory,
            seriesId: newSeriesId,
            auctionId: auctionId,
            sellAmount: sellAmount,
            ethToMint: msg.value,
            buyAmount: buyAmount,
            buyToken: buyToken,
            pairedToken: pairedToken,
            recipient: recipient,
            active: true
        });

        buyAmount = auction.fillWithCallback(auctionId, sellAmount, maxBuyAmount, address(this), "");
        delete callbackFillContext;

        emit MintedAndFilled(msg.sender, recipient, auctionId, newSeriesId, msg.value, sellAmount, buyAmount);
    }

    function _mintAndFillAllWithCallback(
        EthOptionsFactory factory,
        RollAuction auction,
        bytes32 newSeriesId,
        uint256 auctionId,
        uint256 maxBuyAmount,
        address recipient,
        bool payWithN
    ) internal returns (uint256 sellAmount, uint256 buyAmount) {
        sellAmount = _remainingSellAmount(auction, auctionId);
        if (sellAmount == 0) revert ZeroAmount();
        if (msg.value == 0) revert ZeroAmount();
        if (recipient == address(0)) revert InvalidRecipient();

        buyAmount = auction.quote(auctionId, sellAmount);
        if (buyAmount > msg.value) {
            if (payWithN) revert InsufficientMintedN();
            revert InsufficientMintedP();
        }

        (,,,,,, MintBurnToken pToken, MintBurnToken nToken,,,) = factory.series(newSeriesId);
        MintBurnToken buyToken = payWithN ? nToken : pToken;
        MintBurnToken pairedToken = payWithN ? pToken : nToken;

        callbackFillContext = CallbackFillContext({
            auction: auction,
            factory: factory,
            seriesId: newSeriesId,
            auctionId: auctionId,
            sellAmount: sellAmount,
            ethToMint: msg.value,
            buyAmount: buyAmount,
            buyToken: buyToken,
            pairedToken: pairedToken,
            recipient: recipient,
            active: true
        });

        (sellAmount, buyAmount) = auction.fillAllWithCallback(auctionId, maxBuyAmount, address(this), "");
        delete callbackFillContext;

        emit MintedAndFilled(msg.sender, recipient, auctionId, newSeriesId, msg.value, sellAmount, buyAmount);
    }

    function _remainingSellAmount(RollAuction auction, uint256 auctionId)
        internal
        view
        returns (uint256 remainingSellAmount)
    {
        (,,,, remainingSellAmount,,,,,,) = auction.auctions(auctionId);
    }

    function _push(MintBurnToken token, address to, uint256 amount) internal {
        if (!token.transfer(to, amount)) revert TransferFailed();
    }
}
