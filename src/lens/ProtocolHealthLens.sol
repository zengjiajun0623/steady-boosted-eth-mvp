// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EthOptionsFactory} from "../EthOptionsFactory.sol";
import {IERC20Like, RollAuction} from "../RollAuction.sol";
import {EthTokenAMM} from "../market/EthTokenAMM.sol";
import {ISettlementOracle} from "../oracle/ISettlementOracle.sol";
import {MintBurnToken} from "../token/MintBurnToken.sol";
import {EthLPVault} from "../vault/EthLPVault.sol";
import {SeriesExposureVault} from "../vault/SeriesExposureVault.sol";
import {SeriesExposureVaultKeeper} from "../vault/SeriesExposureVaultKeeper.sol";

/// @notice Read-only helper for decentralized protocol health dashboards.
/// @dev This contract has no authority. It only packages existing public state
/// into dashboard-friendly structs for keepers, solvers, and risk monitors.
contract ProtocolHealthLens {
    uint256 public constant BPS = 10_000;

    struct MarketHealth {
        address market;
        address token;
        address lpToken;
        uint256 feeBps;
        uint256 ethReserve;
        uint256 tokenReserve;
        uint256 sampleEthIn;
        uint256 sampleBuyTokenOut;
        uint256 sampleTokenIn;
        uint256 sampleSellEthOut;
        bool hasLiquidity;
    }

    struct LpVaultHealth {
        address vault;
        address share;
        address manager;
        uint256 managedAssets;
        uint256 reservedEth;
        uint256 activeStrategyEth;
        uint256 maxEthPerRoll;
        uint256 maxActiveStrategyEth;
        uint256 maxRollPriceWad;
        uint256 minInventorySalePriceWad;
        uint64 minAuctionDuration;
        uint64 minBackstopDelay;
        uint64 minAuctionTimeLeft;
        uint16 maxAuctionPriceDropBps;
        uint256 inventorySeriesLength;
        uint256 inventoryMarketsLength;
        uint256 strategyUtilizationBps;
        bool strategyActive;
        bool depositsPaused;
        uint256 totalShares;
        uint256 sharePriceWad;
        uint256 openInventorySeriesCount;
        uint256 openInventoryMarketCount;
    }

    struct LpInventoryHealth {
        address vault;
        uint256 index;
        address factory;
        bytes32 seriesId;
        uint64 maturity;
        address pToken;
        address nToken;
        uint256 pBalance;
        uint256 nBalance;
        uint256 mergeableAmount;
        uint256 unpairedP;
        uint256 unpairedN;
        uint256 settlementPrice;
        bool settled;
        bool matured;
        bool hasInventory;
    }

    struct LpMarketLiquidityHealth {
        address vault;
        uint256 index;
        address market;
        address token;
        address lpToken;
        uint256 ethReserve;
        uint256 tokenReserve;
        uint256 totalMarketShares;
        uint256 vaultMarketShares;
        uint256 vaultShareBps;
        bool hasMarketLiquidity;
        bool hasVaultLiquidity;
    }

    struct LpAccountHealth {
        address vault;
        address account;
        address share;
        uint256 shareBalance;
        uint256 claimableAssets;
        uint256 pendingWithdrawAssets;
        uint64 pendingUnlockAt;
        bool pendingClaimable;
        bool hasPosition;
    }

    struct WrapperHealth {
        address vault;
        address share;
        address manager;
        address currentToken;
        bool rollActive;
        uint256 totalAssets;
        address rollAuction;
        uint256 rollAuctionId;
        address rollNextToken;
        uint256 maxAssets;
        uint256 remainingCapacity;
        bool depositsPaused;
    }

    struct SeriesHealth {
        bytes32 seriesId;
        address factory;
        uint256 strike;
        uint64 maturity;
        uint32 twapWindow;
        uint256 capEth;
        uint256 openInterestEth;
        uint256 collateralEth;
        address pToken;
        address nToken;
        address oracle;
        uint256 settlementPrice;
        uint256 capUsedBps;
        bool settled;
        bool matured;
    }

    struct AuctionHealth {
        address auction;
        uint256 auctionId;
        address seller;
        address beneficiary;
        address sellToken;
        address buyToken;
        uint256 remainingSellAmount;
        uint256 buyTokenRaised;
        uint256 startPriceWad;
        uint256 endPriceWad;
        uint256 currentPriceWad;
        uint256 elapsed;
        uint256 timeLeft;
        bool open;
        bool active;
        bool priceAtFloor;
        bool cancelled;
        uint256 resetPriceDropBps;
        bool resetExpired;
        bool resetPriceStale;
        bool resetEligible;
        bool resetsPaused;
    }

    struct AuctionPolicyHealth {
        address auction;
        address guardian;
        uint256 stopped;
        uint256 minSellAmount;
        uint64 minStaleResetDelay;
        uint16 minStaleResetPriceDropBps;
        uint256 activeAuctionCount;
        uint256 maxActiveAuctions;
        uint256 maxActiveAuctionsPerSeller;
        bool newAuctionsPaused;
        bool resetsPaused;
        bool fillsPaused;
    }

    struct WrapperKeeperHealth {
        address keeper;
        address vault;
        address factory;
        address auction;
        bool boostedSide;
        bytes32 currentSeriesId;
        bytes32 pendingSeriesId;
        uint256 maxStartPriceWad;
        uint256 minEndPriceWad;
        uint64 minDuration;
        uint64 maxDuration;
        uint256 minRollSellAmount;
        uint256 maxRollSellAmount;
        uint256 keeperRewardEth;
        bool vaultSet;
        bool rollPending;
    }

    function marketHealth(EthTokenAMM market, uint256 sampleEthIn, uint256 sampleTokenIn)
        external
        view
        returns (MarketHealth memory health)
    {
        health.market = address(market);
        health.token = address(market.token());
        health.lpToken = address(market.lpToken());
        health.feeBps = market.feeBps();
        health.ethReserve = market.ethReserve();
        health.tokenReserve = market.tokenReserve();
        health.sampleEthIn = sampleEthIn;
        health.sampleTokenIn = sampleTokenIn;
        health.hasLiquidity = health.ethReserve != 0 && health.tokenReserve != 0;

        if (health.hasLiquidity && sampleEthIn != 0) {
            health.sampleBuyTokenOut = market.quoteBuyToken(sampleEthIn);
        }
        if (health.hasLiquidity && sampleTokenIn != 0) {
            health.sampleSellEthOut = market.quoteSellToken(sampleTokenIn);
        }
    }

    function lpVaultHealth(EthLPVault vault) external view returns (LpVaultHealth memory health) {
        MintBurnToken share = vault.share();
        uint256 totalShares = share.totalSupply();
        uint256 managedAssets = vault.managedAssets();
        health.vault = address(vault);
        health.share = address(share);
        health.manager = vault.manager();
        health.managedAssets = managedAssets;
        health.reservedEth = vault.reservedEth();
        health.activeStrategyEth = vault.activeStrategyEth();
        health.maxEthPerRoll = vault.maxEthPerRoll();
        health.maxActiveStrategyEth = vault.maxActiveStrategyEth();
        health.maxRollPriceWad = vault.maxRollPriceWad();
        health.minInventorySalePriceWad = vault.minInventorySalePriceWad();
        health.minAuctionDuration = vault.minAuctionDuration();
        health.minBackstopDelay = vault.minBackstopDelay();
        health.minAuctionTimeLeft = vault.minAuctionTimeLeft();
        health.maxAuctionPriceDropBps = vault.maxAuctionPriceDropBps();
        health.inventorySeriesLength = vault.inventorySeriesLength();
        health.inventoryMarketsLength = vault.inventoryMarketsLength();
        health.openInventorySeriesCount = vault.openInventorySeriesCount();
        health.openInventoryMarketCount = vault.openInventoryMarketCount();
        health.strategyActive = vault.strategyActive();
        health.depositsPaused = health.strategyActive;
        health.strategyUtilizationBps =
            health.maxActiveStrategyEth == 0 ? 0 : (health.activeStrategyEth * BPS) / health.maxActiveStrategyEth;
        health.totalShares = totalShares;
        health.sharePriceWad = _sharePriceWad(managedAssets, totalShares);
    }

    function lpInventoryHealth(EthLPVault vault, uint256 index)
        external
        view
        returns (LpInventoryHealth memory health)
    {
        (EthOptionsFactory factory, bytes32 seriesId) = vault.inventorySeries(index);
        (
            ,
            uint64 maturity,
            ,
            ,
            ,
            ,
            MintBurnToken pToken,
            MintBurnToken nToken,
            ,
            bool settled,
            uint256 settlementPrice
        ) = factory.series(seriesId);

        uint256 pBalance = pToken.balanceOf(address(vault));
        uint256 nBalance = nToken.balanceOf(address(vault));
        uint256 mergeableAmount = pBalance < nBalance ? pBalance : nBalance;

        health = LpInventoryHealth({
            vault: address(vault),
            index: index,
            factory: address(factory),
            seriesId: seriesId,
            maturity: maturity,
            pToken: address(pToken),
            nToken: address(nToken),
            pBalance: pBalance,
            nBalance: nBalance,
            mergeableAmount: mergeableAmount,
            unpairedP: pBalance - mergeableAmount,
            unpairedN: nBalance - mergeableAmount,
            settlementPrice: settlementPrice,
            settled: settled,
            matured: block.timestamp >= maturity,
            hasInventory: pBalance != 0 || nBalance != 0
        });
    }

    function lpMarketLiquidityHealth(EthLPVault vault, uint256 index)
        external
        view
        returns (LpMarketLiquidityHealth memory health)
    {
        EthTokenAMM market = vault.inventoryMarkets(index);
        MintBurnToken lpToken = market.lpToken();
        uint256 totalShares = lpToken.totalSupply();
        uint256 vaultShares = lpToken.balanceOf(address(vault));

        health = LpMarketLiquidityHealth({
            vault: address(vault),
            index: index,
            market: address(market),
            token: address(market.token()),
            lpToken: address(lpToken),
            ethReserve: market.ethReserve(),
            tokenReserve: market.tokenReserve(),
            totalMarketShares: totalShares,
            vaultMarketShares: vaultShares,
            vaultShareBps: totalShares == 0 ? 0 : (vaultShares * BPS) / totalShares,
            hasMarketLiquidity: market.ethReserve() != 0 && market.tokenReserve() != 0,
            hasVaultLiquidity: vaultShares != 0
        });
    }

    function lpAccountHealth(EthLPVault vault, address account)
        external
        view
        returns (LpAccountHealth memory health)
    {
        MintBurnToken share = vault.share();
        uint256 shareBalance = share.balanceOf(account);
        (uint256 pendingWithdrawAssets, uint64 pendingUnlockAt) = vault.withdrawalRequests(account);

        health = LpAccountHealth({
            vault: address(vault),
            account: account,
            share: address(share),
            shareBalance: shareBalance,
            claimableAssets: shareBalance == 0 ? 0 : vault.convertToAssets(shareBalance),
            pendingWithdrawAssets: pendingWithdrawAssets,
            pendingUnlockAt: pendingUnlockAt,
            pendingClaimable: pendingWithdrawAssets != 0 && block.timestamp >= pendingUnlockAt,
            hasPosition: shareBalance != 0 || pendingWithdrawAssets != 0
        });
    }

    function wrapperHealth(SeriesExposureVault vault) external view returns (WrapperHealth memory health) {
        health.vault = address(vault);
        health.share = address(vault.share());
        health.manager = vault.manager();
        health.currentToken = address(vault.currentToken());
        health.rollActive = vault.rollActive();
        health.depositsPaused = vault.depositsPaused();
        health.maxAssets = vault.maxAssets();
        health.remainingCapacity = vault.remainingCapacity();
        if (!health.rollActive) {
            health.totalAssets = vault.totalAssets();
            return health;
        }

        (RollAuction auction, uint256 auctionId, MintBurnToken nextToken) = vault.roll();
        health.rollAuction = address(auction);
        health.rollAuctionId = auctionId;
        health.rollNextToken = address(nextToken);
    }

    function seriesHealth(EthOptionsFactory factory, bytes32 seriesId)
        external
        view
        returns (SeriesHealth memory health)
    {
        (
            uint256 strike,
            uint64 maturity,
            uint32 twapWindow,
            uint256 capEth,
            uint256 openInterestEth,
            uint256 collateralEth,
            MintBurnToken pToken,
            MintBurnToken nToken,
            ISettlementOracle oracle,
            bool settled,
            uint256 settlementPrice
        ) = factory.series(seriesId);

        health = SeriesHealth({
            seriesId: seriesId,
            factory: address(factory),
            strike: strike,
            maturity: maturity,
            twapWindow: twapWindow,
            capEth: capEth,
            openInterestEth: openInterestEth,
            collateralEth: collateralEth,
            pToken: address(pToken),
            nToken: address(nToken),
            oracle: address(oracle),
            settlementPrice: settlementPrice,
            capUsedBps: capEth == 0 ? 0 : (openInterestEth * BPS) / capEth,
            settled: settled,
            matured: block.timestamp >= maturity
        });
    }

    function auctionHealth(RollAuction auction, uint256 auctionId) external view returns (AuctionHealth memory health) {
        health.auction = address(auction);
        health.auctionId = auctionId;
        health = _withAuctionConfig(health, auction, auctionId);
        health = _withAuctionStatus(health, auction, auctionId);
    }

    function auctionPolicyHealth(RollAuction auction) external view returns (AuctionPolicyHealth memory health) {
        uint256 stopped = auction.stopped();
        health = AuctionPolicyHealth({
            auction: address(auction),
            guardian: auction.guardian(),
            stopped: stopped,
            minSellAmount: auction.minSellAmount(),
            minStaleResetDelay: auction.minStaleResetDelay(),
            minStaleResetPriceDropBps: auction.minStaleResetPriceDropBps(),
            activeAuctionCount: auction.activeAuctionCount(),
            maxActiveAuctions: auction.maxActiveAuctions(),
            maxActiveAuctionsPerSeller: auction.maxActiveAuctionsPerSeller(),
            newAuctionsPaused: stopped >= auction.STOP_NEW_AUCTIONS(),
            resetsPaused: stopped >= auction.STOP_RESETS(),
            fillsPaused: stopped >= auction.STOP_FILLS()
        });
    }

    function wrapperKeeperHealth(SeriesExposureVaultKeeper keeper)
        external
        view
        returns (WrapperKeeperHealth memory health)
    {
        SeriesExposureVault vault = keeper.vault();
        bytes32 pendingSeriesId = keeper.pendingSeriesId();
        health = WrapperKeeperHealth({
            keeper: address(keeper),
            vault: address(vault),
            factory: address(keeper.factory()),
            auction: address(keeper.auction()),
            boostedSide: keeper.boostedSide(),
            currentSeriesId: keeper.currentSeriesId(),
            pendingSeriesId: pendingSeriesId,
            maxStartPriceWad: keeper.maxStartPriceWad(),
            minEndPriceWad: keeper.minEndPriceWad(),
            minDuration: keeper.minDuration(),
            maxDuration: keeper.maxDuration(),
            minRollSellAmount: keeper.minRollSellAmount(),
            maxRollSellAmount: keeper.maxRollSellAmount(),
            keeperRewardEth: keeper.keeperRewardEth(),
            vaultSet: address(vault) != address(0),
            rollPending: pendingSeriesId != bytes32(0)
        });
    }

    function _withAuctionConfig(AuctionHealth memory health, RollAuction auction, uint256 auctionId)
        internal
        view
        returns (AuctionHealth memory)
    {
        (
            address seller,
            address beneficiary,
            IERC20Like sellToken,
            IERC20Like buyToken,
            uint256 remainingSellAmount,
            uint256 buyTokenRaised,
            uint256 startPriceWad,
            uint256 endPriceWad,,,
            bool cancelled
        ) = auction.auctions(auctionId);

        health.seller = seller;
        health.beneficiary = beneficiary;
        health.sellToken = address(sellToken);
        health.buyToken = address(buyToken);
        health.remainingSellAmount = remainingSellAmount;
        health.buyTokenRaised = buyTokenRaised;
        health.startPriceWad = startPriceWad;
        health.endPriceWad = endPriceWad;
        health.cancelled = cancelled;
        return health;
    }

    function _withAuctionStatus(AuctionHealth memory health, RollAuction auction, uint256 auctionId)
        internal
        view
        returns (AuctionHealth memory)
    {
        (bool open, bool active, bool priceAtFloor,,, uint256 currentPriceWad, uint256 elapsed, uint256 timeLeft) =
            auction.auctionStatus(auctionId);
        (bool resetExpired, bool resetPriceStale,,, uint256 resetPriceDropBps) = auction.resetStatus(auctionId);
        bool resetsPaused = auction.stopped() >= auction.STOP_RESETS();

        health.currentPriceWad = currentPriceWad;
        health.elapsed = elapsed;
        health.timeLeft = timeLeft;
        health.open = open;
        health.active = active;
        health.priceAtFloor = priceAtFloor;
        health.resetPriceDropBps = resetPriceDropBps;
        health.resetExpired = resetExpired;
        health.resetPriceStale = resetPriceStale;
        health.resetEligible = open && (resetExpired || resetPriceStale) && !resetsPaused;
        health.resetsPaused = resetsPaused;
        return health;
    }

    function _sharePriceWad(uint256 managedAssets, uint256 totalShares) internal pure returns (uint256) {
        return totalShares == 0 ? 1e18 : (managedAssets * 1e18) / totalShares;
    }
}
