import { Connection, Keypair, PublicKey } from '@solana/web3.js';

import {
	BN,
	ClearingHouse,
	initialize,
	PositionDirection,
	AMM_TO_QUOTE_PRECISION_RATIO,
	convertToNumber,
	AMM_RESERVE_PRECISION,
	MARK_PRICE_PRECISION,
	QUOTE_PRECISION,
	Markets,
	ZERO,
	getSwapDirection,
	calculateAmmReservesAfterSwap,
	calculateBaseAssetValue,
	calculatePositionPNL,
	PEG_PRECISION,
	Wallet,
	UserPosition,
	UserAccount,
	Market, MARGIN_PRECISION,
} from '@drift-labs/sdk';

/**
 * Calculates how much to increase k given the cost of the operation
 * @param market
 * @param cost
 */
function calculateBudgetedK(market: Market, cost: BN): [BN, BN] {
	// wolframalpha.com
	// (1/(x+d) - p/(x*p+d))*y*d*Q = C solve for p
	// p = (d(y*d*Q - C(x+d))) / (C*x(x+d) + y*y*d*Q)

	// todo: assumes k = x * y
	// otherwise use: (y(1-p) + (kp^2/(x*p+d)) - k/(x+d)) * Q = C solve for p

	const x = market.amm.baseAssetReserve;
	const y = market.amm.quoteAssetReserve;

	const d = market.baseAssetAmount;
	const Q = market.amm.pegMultiplier;

	const C = cost.mul(new BN(-1));

	const numer1 = y.mul(d).mul(Q).div(AMM_RESERVE_PRECISION).div(PEG_PRECISION);
	const numer2 = C.mul(x.add(d)).div(QUOTE_PRECISION);
	const denom1 = C.mul(x)
		.mul(x.add(d))
		.div(AMM_RESERVE_PRECISION)
		.div(QUOTE_PRECISION);
	const denom2 = y
		.mul(d)
		.mul(d)
		.mul(Q)
		.div(AMM_RESERVE_PRECISION)
		.div(AMM_RESERVE_PRECISION)
		.div(PEG_PRECISION);

	const numerator = d
		.mul(numer1.sub(numer2))
		.div(AMM_RESERVE_PRECISION)
		.div(AMM_RESERVE_PRECISION)
		.div(AMM_TO_QUOTE_PRECISION_RATIO);
	const denominator = denom1
		.add(denom2)
		.div(AMM_RESERVE_PRECISION)
		.div(AMM_TO_QUOTE_PRECISION_RATIO);

	return [numerator, denominator];
}

require('dotenv').config();

const getSummary = async (
	clearingHouse: ClearingHouse,
) => {
	await clearingHouse.subscribe();

	let allQuoteAcq = 0;
	let allQuoteAcqLong = 0;
	let allQuoteAcqShort = 0;
	let allTotalFeeMinusDistributions = 0;
	let allTotalFee = 0;

	const result = [];

	const roundDecimal = (num, decimals = 3) => {
		return Math.round(num * 10 ** decimals) / 10 ** decimals;
	};

	const programUserPositionAccounts =
		await clearingHouse.program.account.userPositions.all();
	const programUserAccounts = await clearingHouse.program.account.user.all();

	const localUserPositionsPnl = Array(Markets.length).fill(0);
	const positionLongCostBasis = Array(Markets.length).fill(0);
	const positionShortCostBasis = Array(Markets.length).fill(0);

	const markets = clearingHouse.getMarketsAccount().markets;


	const userAccountMap = new Map<string, UserAccount>();
	for (const programUserAccount of programUserAccounts) {
		userAccountMap.set(programUserAccount.publicKey.toString(), programUserAccount.account as UserAccount);
	}

	let userRealiseCollateralLocal = 0;
	let userWithdrawableCollateralLocal = 0;

	for (const positionsStr in programUserPositionAccounts) {
		const userAccount = userAccountMap.get(programUserPositionAccounts[positionsStr].account.user.toString());
		const positions = programUserPositionAccounts[positionsStr].account.positions as UserPosition[];
		let totalCollateral = userAccount.collateral;
		let initialMarginRequirement = ZERO;
		for (const positionStr in positions) {
			const position = positions[positionStr];
			if (position.baseAssetAmount.eq(ZERO)) {
				continue;
			}
			const posMarketIndex = position.marketIndex.toNumber();

			const posPnl = calculatePositionPNL(
				markets[posMarketIndex],
				position,
				true
			);

			totalCollateral = totalCollateral.add(posPnl);
			const market = clearingHouse.getMarket(posMarketIndex);
			const positionMarginRequirement = calculateBaseAssetValue(market, position)
				.mul(new BN(market.marginRatioInitial))
				.div(MARGIN_PRECISION);
			initialMarginRequirement = initialMarginRequirement.add(positionMarginRequirement);

			const posPnlNum = convertToNumber(posPnl, QUOTE_PRECISION);

			localUserPositionsPnl[posMarketIndex] += posPnlNum;

			if (position.baseAssetAmount.gt(ZERO)) {
				positionLongCostBasis[posMarketIndex] += convertToNumber(
					position.quoteAssetAmount,
					QUOTE_PRECISION
				);
			} else {
				positionShortCostBasis[posMarketIndex] += convertToNumber(
					position.quoteAssetAmount,
					QUOTE_PRECISION
				);
			}
		}

		const freeCollateral = BN.max(ZERO, totalCollateral.sub(initialMarginRequirement));
		const withdrawableCollateral = BN.min(userAccount.collateral, freeCollateral);

		userRealiseCollateralLocal += convertToNumber(
			// @ts-ignore
			userAccount.collateral,
			QUOTE_PRECISION
		);
		userWithdrawableCollateralLocal += convertToNumber(
			// @ts-ignore
			withdrawableCollateral,
			QUOTE_PRECISION
		);
	}

	let localUserUnrealisedPnl = 0; // cur @ local
	let terminalUserPnl1 = 0; // net @ terminal
	let terminalUserPnl2 = 0; //  net @ terminal (two swap)

	for (const market in markets) {
		const market0 = markets[market];
		const marketIndex = new BN(market).toNumber();
		if (!market0.initialized) {
			continue;
		}
		const market0M = clearingHouse.getMarket(marketIndex);

		const baseAssetNum = convertToNumber(
			market0.baseAssetAmount,
			AMM_RESERVE_PRECISION
		);
		const baseAssetLongNum = convertToNumber(
			market0.baseAssetAmountLong,
			AMM_RESERVE_PRECISION
		);
		const baseAssetShortNum = convertToNumber(
			market0.baseAssetAmountShort,
			AMM_RESERVE_PRECISION
		);

		const longQuoteAssetAmount = positionLongCostBasis[marketIndex];
		const shortQuoteAssetAmount = Math.abs(
			positionShortCostBasis[marketIndex]
		);
		let netQuoteAssetAmount;

		if (baseAssetNum > 0) {
			netQuoteAssetAmount = longQuoteAssetAmount - shortQuoteAssetAmount;
		} else {
			netQuoteAssetAmount = shortQuoteAssetAmount - longQuoteAssetAmount;
		}

		const netUserPosition = {
			baseAssetAmount: market0.baseAssetAmount,
			lastCumulativeFundingRate: market0.amm.cumulativeFundingRate,
			marketIndex: new BN(marketIndex),
			quoteAssetAmount: new BN(
				netQuoteAssetAmount * QUOTE_PRECISION.toNumber()
			),
			openOrders: ZERO,
		};
		const netUserLongPosition = {
			baseAssetAmount: market0.baseAssetAmountLong,
			lastCumulativeFundingRate: market0.amm.cumulativeFundingRate,
			marketIndex: new BN(marketIndex),
			quoteAssetAmount: new BN(
				longQuoteAssetAmount * QUOTE_PRECISION.toNumber()
			),
			openOrders: ZERO,
		};
		const netUserShortPosition = {
			baseAssetAmount: market0.baseAssetAmountShort,
			lastCumulativeFundingRate: market0.amm.cumulativeFundingRate,
			marketIndex: new BN(marketIndex),
			quoteAssetAmount: new BN(
				shortQuoteAssetAmount * QUOTE_PRECISION.toNumber()
			),
			openOrders: ZERO,
		};

		const reKCost = market0M.amm.totalFeeMinusDistributions;
		const [kNumer, kDenom] = calculateBudgetedK(market0M, reKCost);
		market0M.amm.totalFeeMinusDistributions =
			market0M.amm.totalFeeMinusDistributions.sub(reKCost);
		market0M.amm.sqrtK = market0M.amm.sqrtK.mul(kNumer).div(kDenom);
		market0M.amm.baseAssetReserve = market0M.amm.baseAssetReserve
			.mul(kNumer)
			.div(kDenom);

		market0M.amm.quoteAssetReserve = market0M.amm.quoteAssetReserve
			.mul(kNumer)
			.div(kDenom);

		// First way to calculate the terminal pnl
		const terminalUserPositionPnl = calculatePositionPNL(
			market0M,
			netUserPosition,
			false
		);

		const quoteAssetAcq = calculateBaseAssetValue(market0M, netUserPosition);
		const quoteAssetAcqNum = roundDecimal(
			convertToNumber(quoteAssetAcq, QUOTE_PRECISION)
		);
		allQuoteAcq += quoteAssetAcqNum;

		const quoteAssetAcqLong = calculateBaseAssetValue(
			market0M,
			netUserLongPosition
		);
		const quoteAssetAcqLongNum = roundDecimal(
			convertToNumber(quoteAssetAcqLong, QUOTE_PRECISION)
		);
		allQuoteAcqLong += quoteAssetAcqLongNum;

		const quoteAssetAcqShort = calculateBaseAssetValue(
			market0M,
			netUserShortPosition
		);
		const quoteAssetAcqShortNum = roundDecimal(
			convertToNumber(quoteAssetAcqShort, QUOTE_PRECISION)
		);
		allQuoteAcqShort += quoteAssetAcqShortNum;

		const exitPrice = quoteAssetAcq
			.mul(AMM_TO_QUOTE_PRECISION_RATIO)
			.mul(QUOTE_PRECISION)
			.div(market0.baseAssetAmount.abs());
		const directionToClose = netUserPosition.baseAssetAmount.gt(ZERO)
			? PositionDirection.SHORT
			: PositionDirection.LONG;

		const [newQuoteAssetReserve, newBaseAssetReserve] =
			calculateAmmReservesAfterSwap(
				market0M.amm,
				'base',
				netUserPosition.baseAssetAmount.abs(),
				getSwapDirection('base', directionToClose)
			);
		const terminalPrice = newQuoteAssetReserve
			.mul(MARK_PRICE_PRECISION)
			.mul(market0.amm.pegMultiplier)
			.div(PEG_PRECISION)
			.div(newBaseAssetReserve);

		const marketForLongs = Object.assign({}, market0);
		marketForLongs.amm = Object.assign({}, market0.amm);

		const marketForShorts = Object.assign({}, market0);
		marketForShorts.amm = Object.assign({}, market0.amm);

		const longPnl = calculatePositionPNL(
			marketForLongs,
			netUserLongPosition,
			false
		);
		const [quoteAsserReserveForShorts, baseAssetReserveForLongs] =
			calculateAmmReservesAfterSwap(
				marketForLongs.amm,
				'base',
				netUserLongPosition.baseAssetAmount.abs(),
				getSwapDirection('base', PositionDirection.SHORT)
			);

		marketForShorts.amm.baseAssetReserve = baseAssetReserveForLongs;
		marketForShorts.amm.quoteAssetReserve = quoteAsserReserveForShorts;
		const shortPnl = calculatePositionPNL(
			marketForShorts,
			netUserShortPosition,
			false
		);
		const terminalUserPositionPnl2 = convertToNumber(
			longPnl.add(shortPnl),
			QUOTE_PRECISION
		);

		const totalFee = convertToNumber(market0M.amm.totalFee, QUOTE_PRECISION);
		const totalFeeMinusDistributions = convertToNumber(
			market0M.amm.totalFeeMinusDistributions,
			QUOTE_PRECISION
		);
		allTotalFeeMinusDistributions += totalFeeMinusDistributions;
		allTotalFee += totalFee;

		// terminal pnl
		const terminalUserPositionPnlNum = convertToNumber(terminalUserPositionPnl, QUOTE_PRECISION);
		terminalUserPnl1 += terminalUserPositionPnlNum;

		terminalUserPnl2 += terminalUserPositionPnl2;

		// local pnl
		const localUserPositionPnl = localUserPositionsPnl[marketIndex];
		localUserUnrealisedPnl += localUserPositionPnl;

		const marketDesc = {
			marketSymbol: Markets[marketIndex].symbol,
			quoteAcq: roundDecimal(quoteAssetAcqNum),
			quoteAcqLong: roundDecimal(quoteAssetAcqLongNum),
			quoteAcqShort: roundDecimal(quoteAssetAcqShortNum),

			quotePaid: roundDecimal(netQuoteAssetAmount),
			quotePaidLong: roundDecimal(longQuoteAssetAmount),
			quotePaidShort: roundDecimal(shortQuoteAssetAmount),

			// terminal pnl
			terminalPnl1: roundDecimal(terminalUserPositionPnlNum),
			terminalPnl2: roundDecimal(terminalUserPositionPnl2),
			// local pnl
			localPnl: roundDecimal(localUserPositionPnl),
			pnlDivergence: roundDecimal(localUserPositionPnl - terminalUserPositionPnlNum),

			exitPrice: convertToNumber(exitPrice, QUOTE_PRECISION),
			terminalPrice: roundDecimal(
				convertToNumber(terminalPrice, MARK_PRICE_PRECISION)
			),
			peg: roundDecimal(
				convertToNumber(market0M.amm.pegMultiplier, PEG_PRECISION)
			),
			total_fee: roundDecimal(
				convertToNumber(market0M.amm.totalFee, QUOTE_PRECISION)
			),
			total_fee_minus_distributions: roundDecimal(
				convertToNumber(
					market0M.amm.totalFeeMinusDistributions,
					QUOTE_PRECISION
				)
			),

			baseAssetNet: baseAssetNum,
			baseAssetLong: baseAssetLongNum,
			baseAssetShort: baseAssetShortNum,

			entryPriceNet: roundDecimal(
				Math.abs(netQuoteAssetAmount / baseAssetNum)
			),
			entryPriceLong: roundDecimal(
				Math.abs(longQuoteAssetAmount / baseAssetLongNum)
			),
			entryPriceShort: roundDecimal(
				Math.abs(shortQuoteAssetAmount / baseAssetShortNum)
			),
		};

		result.push(marketDesc);
	}

	const vaultsBalance = 4937519.836505;
	const userRealisedCollateralTerminal1 = userRealiseCollateralLocal + terminalUserPnl1;
	const totalUserCollateralLocal = userRealiseCollateralLocal + localUserUnrealisedPnl;
	const totalSettledCollateral = 19493489.556705;
	const aggDesc = {
		marketSymbol: 'ALL',
		totalNetQuoteOI: allQuoteAcq,
		totalLongQuoteOI: allQuoteAcqLong,
		totalShortQuoteOI: allQuoteAcqShort,
		totalQuoteOI: allQuoteAcqLong + allQuoteAcqShort,
		vaultsBalance,
		userRealiseCollateralLocal,
		userWithdrawableCollateralLocal,
		userRealisedCollateralTerminal1,
		terminalUserPnl1,
		localUserUnrealisedPnl,
		userRealisedCollateralTerminal2: userRealiseCollateralLocal + terminalUserPnl2,
		totalUserCollateralLocal,
		leveredLoss:
			vaultsBalance - userRealisedCollateralTerminal1,
		realisedCollateralShortfall: userRealiseCollateralLocal - vaultsBalance,
		withdrawableCollateralShortfall: userWithdrawableCollateralLocal - vaultsBalance,
		totalPnlDivergence: totalUserCollateralLocal - userRealisedCollateralTerminal1,
		settledCollateralShortfall: totalSettledCollateral - vaultsBalance,
		totalSettledCollateral,
	};

	result.push(aggDesc);
	await clearingHouse.unsubscribe();

	return result;
};

//@ts-ignore
const sdkConfig = initialize({ env: process.env.ENV });
const endpoint = process.env.ENDPOINT;
const connection = new Connection(endpoint);

(async () => {
	const clearingHousePublicKey = new PublicKey(
		sdkConfig.CLEARING_HOUSE_PROGRAM_ID
	);

	const clearingHouse = ClearingHouse.from(
		connection,
		new Wallet(new Keypair()),
		clearingHousePublicKey
	);


	const res = await getSummary(clearingHouse);
	console.log(res);
	const fs = require('fs');
	const today = new Date();
	const date =
		today.getFullYear() +
		'-' +
		(today.getMonth() + 1) +
		'-' +
		today.getDate();
	const time =
		today.getHours() + '-' + today.getMinutes() + '-' + today.getSeconds();
	const dateTime = date + '_' + time;
	fs.writeFile(
		'dammDesc' + dateTime + '.json',
		JSON.stringify(res),
		function (err) {
			if (err) throw err;
			console.log('complete');
		}
	);
})();
