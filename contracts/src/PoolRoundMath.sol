// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title  PoolRoundMath
 * @notice Money arithmetic of a matched round, in integer wei.
 *
 * @dev    A line-by-line transcription of clear(), settle() and fees() in
 *         scripts/rhc/positive-ev.mts, the reference model of docs/rhc/POSITIVE-EV.md.
 *         Kept as a library of pure functions, apart from the contract that
 *         holds the money, for one reason: the reference numbers are checked
 *         against THIS code, and it has no storage, clock or oracle that could
 *         hide a difference.
 *
 *         The side cap is a parameter, as in the reference: 1 is the design
 *         (accepted = min(UP, DOWN), every accepted unit of the winning side
 *         pays 1.96x), 4 is the earlier 80:20 proposal the reference still
 *         checks. PoolRounds fixes it at deployment.
 *
 *         Every division rounds down, in the same order as the reference, so a
 *         claim is never larger than the reference payout and the remainder
 *         stays in the contract as dust. Dust is not revenue: nothing in
 *         PoolRounds can move it.
 *
 *         The one deliberate departure: the reference computes the referral
 *         part of the fee for the whole round at once, assuming every unit of
 *         fee has a referrer. The contract cannot loop over players, so the
 *         referral pot is split per ticket at claim time, in the same
 *         proportion as the prize. The per-ticket shares round down, so their
 *         sum never exceeds the pot (proof in ticketClaim below).
 */
library PoolRoundMath {
    uint256 internal constant BPS = 10_000;
    /// 2% of the accepted bank when there is a winner (POSITIVE-EV.md, rule 3).
    uint256 internal constant NORMAL_FEE_BPS = 200;
    /// 1% of the accepted bank on a tie or oracle refund of an ACTIVATED round (rule 3).
    uint256 internal constant VOID_FEE_BPS = 100;
    /// Share of the fee that goes to referrers, at most (rule 3).
    uint256 internal constant REFERRAL_BPS = 1000;
    /// Bounds of the side cap: accepted = min(own side, ratio x other side).
    uint256 internal constant MIN_SIDE_RATIO = 1;
    uint256 internal constant MAX_SIDE_RATIO = 4;
    /// The retained void fee must cover the lifecycle cost allowance twice (POSITIVE-EV.md, admission rule).
    uint256 internal constant COVER = 2;

    /// @dev positive-ev.mts fees(): gross = floor(bank * bps / BPS), referral = floor(gross * refBps / BPS).
    function fees(uint256 bank, uint256 feeBps) internal pure returns (uint256 gross, uint256 referral) {
        gross = bank * feeBps / BPS;
        referral = gross * REFERRAL_BPS / BPS;
    }

    /// @dev positive-ev.mts clear(): the excess of the larger side is not accepted.
    ///      At ratio 1 both sides accept min(rawUp, rawDown).
    function accepted(uint256 rawUp, uint256 rawDown, uint256 ratio) internal pure returns (uint256 up, uint256 down) {
        up = rawUp > ratio * rawDown ? ratio * rawDown : rawUp;
        down = rawDown > ratio * rawUp ? ratio * rawUp : rawDown;
    }

    /**
     * @dev positive-ev.mts clear() activation gate: both sides present, the
     *      accepted bank at least `minBank`, and the void fee left after the
     *      maximum referral share at least COVER x `costAllowance`. Checking the
     *      VOID fee, not the normal one, is what makes the lower bound hold for
     *      every outcome, ties and oracle refunds included.
     */
    function isActive(uint256 rawUp, uint256 rawDown, uint256 ratio, uint256 minBank, uint256 costAllowance)
        internal
        pure
        returns (bool)
    {
        if (rawUp == 0 || rawDown == 0) return false;
        (uint256 up, uint256 down) = accepted(rawUp, rawDown, ratio);
        uint256 bank = up + down;
        (uint256 gross, uint256 referral) = fees(bank, VOID_FEE_BPS);
        return bank >= minBank && gross - referral >= COVER * costAllowance;
    }

    /**
     * @notice What one ticket of an activated, settled round is owed.
     * @param  stake        the ticket's stake
     * @param  sideRaw      everything staked on the ticket's side
     * @param  sideAccepted the accepted part of that side
     * @param  bank         accepted bank, both sides
     * @param  isVoid       tie or oracle refund
     * @param  won          the ticket's side won (ignored when isVoid)
     * @return payout        unmatched part + award, what the player receives
     * @return referralShare the ticket's part of the referral pot
     *
     * @dev    positive-ev.mts settle(), per ticket:
     *           unmatched = stake * (sideRaw - sideAccepted) / sideRaw
     *           void:   award = stake * sideAccepted * prize / (sideRaw * bank)
     *           normal: award = stake * prize / sideRaw for the winning side, else 0
     *         At ratio 1 the winning side's accepted total is bank / 2 and
     *         prize = 0.98 x bank, so the award is 1.96 x the ticket's accepted
     *         part, stake * sideAccepted / sideRaw, whatever the book.
     *         mulDiv computes floor(a * b / c) with a 512-bit product, so the
     *         three-factor void formula gives the reference's exact integer for
     *         any uint96 stakes rather than overflowing.
     *
     *         referralShare uses the same proportion as the award, applied to the
     *         referral pot. Sum over tickets never exceeds the pot:
     *           normal: sum over the winning side of floor(stake * pot / sideRaw)
     *                   <= pot * (sum of stakes) / sideRaw = pot
     *           void:   sum over both sides of floor(stake * acc_s * pot / (raw_s * bank))
     *                   <= pot * (acc_up + acc_down) / bank = pot
     */
    function ticketClaim(uint256 stake, uint256 sideRaw, uint256 sideAccepted, uint256 bank, bool isVoid, bool won)
        internal
        pure
        returns (uint256 payout, uint256 referralShare)
    {
        (uint256 gross, uint256 pot) = fees(bank, isVoid ? VOID_FEE_BPS : NORMAL_FEE_BPS);
        uint256 prize = bank - gross;
        uint256 unmatched = stake * (sideRaw - sideAccepted) / sideRaw;
        uint256 award;
        if (isVoid) {
            award = Math.mulDiv(stake * sideAccepted, prize, sideRaw * bank);
            referralShare = Math.mulDiv(stake * sideAccepted, pot, sideRaw * bank);
        } else if (won) {
            award = stake * prize / sideRaw;
            referralShare = stake * pot / sideRaw;
        }
        payout = unmatched + award;
    }
}
