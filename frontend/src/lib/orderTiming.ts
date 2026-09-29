/**
 * The two clocks an order lives on, mirrored from OrderbookMarket.sol.
 *
 * Kept in a module of their own, with no imports, so the pure order logic
 * (lib/orderModel.ts) and its tests can use them without loading wagmi and
 * viem. lib/contracts.ts re-exports both, which is where the rest of the app
 * reads them from.
 */

/**
 * OrderbookMarket.MATCH_TIMEOUT (5 minutes). An order that is still not fully
 * matched this long after it was placed can be refunded by anyone through
 * refundExpired, and the keeper does it on its own. The trader does not have to
 * wait: cancelOrder returns the unmatched part at any time.
 */
export const MATCH_TIMEOUT_SEC = 300

/**
 * OrderbookMarket.SETTLE_GRACE (24 hours). Past settleAt plus this, the
 * contract refuses to settle ("settlement window expired") and the only way to
 * get a stake back is the permissionless emergencyRefundMatch. The UI needs the
 * number to know when to offer that. Since the resolver started refunding
 * unpriceable matches on its own right after settleAt, this is a backstop for a
 * dead keeper, not the normal path.
 */
export const SETTLE_GRACE_SEC = 24 * 60 * 60
