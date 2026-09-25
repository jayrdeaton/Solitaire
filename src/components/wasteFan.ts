import { faceUpFanOffset, RANK_INK_RIGHT_FRACTION } from '@tastic/cards'

/** Clear air, as a fraction of card width, left between the widest rank ink and the edge of the card
 * that covers it, so the last stroke of a '10' doesn't sit hard against the next card's border. */
export const WASTE_FAN_CLEAR_MARGIN_FRACTION = 0.02

/** How far apart a draw-3 waste fan's cards sit: each card behind the top one shows only its left `step` points. The plain face-up
 * strip (`faceUpFanOffset`, sized to clear a VERTICAL fan's corner row) is a floor, but a HORIZONTAL fan also has to show the whole
 * rank: `rankInkRight` is where the widest rank's ink ends (a fraction of card width; 0/undefined = unknown, i.e. the strip alone),
 * and the step widens to clear it plus WASTE_FAN_CLEAR_MARGIN_FRACTION. Never narrower than the strip. */
export function wasteFanStep(cardWidth: number, rankInkRight = 0): number {
  return Math.max(faceUpFanOffset(cardWidth), cardWidth * (rankInkRight + WASTE_FAN_CLEAR_MARGIN_FRACTION))
}

/** The waste fan's step, widened to clear @tastic/cards' `RANK_INK_RIGHT_FRACTION` (where the '10' ink ends). The one value StockWaste lays the behind cards out with AND the draw-3
 * flights (Klondike/Canfield draw, undo) offset their ghosts by, so a ghost always lands exactly on the fanned position. `widen` false
 * is for a screen whose fan has no clear room to spread into (see StockWaste's `widenFan`): the plain strip, as before the rank
 * outlines - the caller must then pass the same `widenFan={false}` to StockWaste, or the ghosts land off the fanned cards. */
export function wasteFanStepFor(cardWidth: number, widen = true): number {
  return wasteFanStep(cardWidth, widen ? RANK_INK_RIGHT_FRACTION : 0)
}
