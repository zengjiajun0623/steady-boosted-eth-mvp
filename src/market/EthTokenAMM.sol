// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Like} from "../RollAuction.sol";
import {MintBurnToken} from "../token/MintBurnToken.sol";

/// @notice Minimal constant-product ETH/token AMM for product or series tokens.
/// @dev Production should use deep external DEX pools. This contract gives the
/// MVP a decentralized native-ETH buy/sell path for Steady and Boosted tokens.
contract EthTokenAMM {
    uint256 public constant BPS = 10_000;

    IERC20Like public immutable token;
    MintBurnToken public immutable lpToken;
    uint256 public immutable feeBps;

    uint256 public ethReserve;
    uint256 public tokenReserve;

    uint256 private locked = 1;

    event LiquidityAdded(
        address indexed provider, address indexed recipient, uint256 ethIn, uint256 tokenIn, uint256 shares
    );
    event LiquidityRemoved(
        address indexed provider, address indexed recipient, uint256 ethOut, uint256 tokenOut, uint256 shares
    );
    event TokenBought(address indexed buyer, address indexed recipient, uint256 ethIn, uint256 tokenOut);
    event TokenSold(address indexed seller, address indexed recipient, uint256 tokenIn, uint256 ethOut);

    error InvalidConfig();
    error InvalidRecipient();
    error ZeroAmount();
    error Slippage();
    error InsufficientLiquidity();
    error DirectEthTransfer();
    error EthTransferFailed();
    error TokenTransferFailed();

    constructor(IERC20Like token_, string memory lpName, string memory lpSymbol, uint256 feeBps_) {
        if (address(token_) == address(0) || feeBps_ >= BPS) revert InvalidConfig();
        token = token_;
        lpToken = new MintBurnToken(lpName, lpSymbol, address(this));
        feeBps = feeBps_;
    }

    receive() external payable {
        revert DirectEthTransfer();
    }

    modifier nonReentrant() {
        require(locked == 1, "LOCKED");
        locked = 2;
        _;
        locked = 1;
    }

    function addLiquidity(uint256 maxTokenIn, uint256 minShares, address recipient)
        external
        payable
        nonReentrant
        returns (uint256 shares, uint256 ethIn, uint256 tokenIn)
    {
        if (recipient == address(0)) revert InvalidRecipient();
        if (msg.value == 0 || maxTokenIn == 0) revert ZeroAmount();

        uint256 supply = lpToken.totalSupply();
        if (supply == 0) {
            shares = msg.value;
            ethIn = msg.value;
            tokenIn = maxTokenIn;
        } else {
            uint256 sharesFromEth = (msg.value * supply) / ethReserve;
            uint256 sharesFromToken = (maxTokenIn * supply) / tokenReserve;
            shares = sharesFromEth < sharesFromToken ? sharesFromEth : sharesFromToken;
            ethIn = (shares * ethReserve) / supply;
            tokenIn = (shares * tokenReserve) / supply;
        }

        if (shares == 0 || ethIn == 0 || tokenIn == 0) revert ZeroAmount();
        if (shares < minShares) revert Slippage();

        ethReserve += ethIn;
        tokenReserve += tokenIn;
        lpToken.mint(recipient, shares);

        _pullToken(msg.sender, tokenIn);
        if (msg.value > ethIn) _sendEth(msg.sender, msg.value - ethIn);

        emit LiquidityAdded(msg.sender, recipient, ethIn, tokenIn, shares);
    }

    function removeLiquidity(uint256 shares, uint256 minEthOut, uint256 minTokenOut, address recipient)
        external
        nonReentrant
        returns (uint256 ethOut, uint256 tokenOut)
    {
        if (recipient == address(0)) revert InvalidRecipient();
        if (shares == 0) revert ZeroAmount();

        uint256 supply = lpToken.totalSupply();
        ethOut = (shares * ethReserve) / supply;
        tokenOut = (shares * tokenReserve) / supply;
        if (ethOut == 0 || tokenOut == 0) revert ZeroAmount();
        if (ethOut < minEthOut || tokenOut < minTokenOut) revert Slippage();

        lpToken.burn(msg.sender, shares);
        ethReserve -= ethOut;
        tokenReserve -= tokenOut;

        _pushToken(recipient, tokenOut);
        _sendEth(recipient, ethOut);

        emit LiquidityRemoved(msg.sender, recipient, ethOut, tokenOut, shares);
    }

    function buyToken(uint256 minTokenOut, address recipient) external payable nonReentrant returns (uint256 tokenOut) {
        if (recipient == address(0)) revert InvalidRecipient();
        if (msg.value == 0) revert ZeroAmount();

        tokenOut = quoteBuyToken(msg.value);
        if (tokenOut == 0) revert ZeroAmount();
        if (tokenOut < minTokenOut) revert Slippage();

        ethReserve += msg.value;
        tokenReserve -= tokenOut;
        _pushToken(recipient, tokenOut);

        emit TokenBought(msg.sender, recipient, msg.value, tokenOut);
    }

    function sellToken(uint256 tokenIn, uint256 minEthOut, address recipient)
        external
        nonReentrant
        returns (uint256 ethOut)
    {
        if (recipient == address(0)) revert InvalidRecipient();
        if (tokenIn == 0) revert ZeroAmount();

        ethOut = quoteSellToken(tokenIn);
        if (ethOut == 0) revert ZeroAmount();
        if (ethOut < minEthOut) revert Slippage();

        tokenReserve += tokenIn;
        ethReserve -= ethOut;
        _pullToken(msg.sender, tokenIn);
        _sendEth(recipient, ethOut);

        emit TokenSold(msg.sender, recipient, tokenIn, ethOut);
    }

    function quoteBuyToken(uint256 ethIn) public view returns (uint256) {
        if (ethIn == 0) revert ZeroAmount();
        if (ethReserve == 0 || tokenReserve == 0) revert InsufficientLiquidity();

        uint256 ethInWithFee = ethIn * (BPS - feeBps);
        return (tokenReserve * ethInWithFee) / (ethReserve * BPS + ethInWithFee);
    }

    function quoteSellToken(uint256 tokenIn) public view returns (uint256) {
        if (tokenIn == 0) revert ZeroAmount();
        if (ethReserve == 0 || tokenReserve == 0) revert InsufficientLiquidity();

        uint256 tokenInWithFee = tokenIn * (BPS - feeBps);
        return (ethReserve * tokenInWithFee) / (tokenReserve * BPS + tokenInWithFee);
    }

    function _pullToken(address from, uint256 amount) internal {
        if (!token.transferFrom(from, address(this), amount)) revert TokenTransferFailed();
    }

    function _pushToken(address to, uint256 amount) internal {
        if (!token.transfer(to, amount)) revert TokenTransferFailed();
    }

    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }
}
