import { Card } from '@/engine/types'

// PileView's fan geometry, on its own so the deals that place cards in a column analytically (FreeCell's) use the very
// same function PileView lays the column out with - and a test's PileView stand-in cannot take it away from them.

/** A card that has just left a column while its ghost is not on screen yet, drawn where it was (see PileView's PileViewImpl). */
export interface DepartingCard {
  card: Card
  /** Where it was drawn when it left, kept as it is for as long as it is held (it never moves while it is on screen). */
  top: number
  /** Its slot in the column when it left (its index there) - also its paint order, as every card's index is. */
  zIndex: number
  /** How many slots the fan it was drawn in had (columnTops' `slots` for that layout): `top` is its place in THAT fan, so the
   * column keeps that fan under it for as long as it is held (see columnTops). */
  slots: number
}

/** The tightest a column's face-up steps are ever compressed, as a fraction of the natural step. The whole corner index has
 * to stay readable on a covered card: @tastic/cards' glyph ranks (0.3.0) reach 0.417W down the card at their lowest (the
 * tail of a Q, the hook of a J), and the natural strip is faceUpFanOffset's 0.45W, so 0.95 (0.4275W) leaves ~0.5pt above
 * the next card's edge. It was 0.8 (0.36W, chosen for the older, smaller rank): the crowding audit of 2026-10-22 found a
 * covered Q reading as an O and a J as an I in FreeCell and Yukon on a phone held sideways, and in Aces Up after a few
 * rounds. A column that needs more than this runs past its `maxHeight` instead (see columnTops). */
export const MIN_FACE_UP_FAN_SCALE = 0.95

/** The tightest a column's face-down steps are ever compressed: a face-down card only has to show that it is there, so these
 * give way first (columnTops), down to ~0.1 of a card's width. */
export const MIN_FACE_DOWN_FAN_SCALE = 0.55

/**
 * Each card's top (already compressed) in a column of `cards`: the fan, scaled down to fit `maxHeight` if it must be, and
 * how many slots that fan has (`slots`).
 *
 * `held` are the cards that have left the column but are still drawn over it (PileView's `departing`), each in the
 * slot it left, frozen at its top in the fan it was drawn in (its own `slots`). While any is held, the column is laid out
 * in the largest of those fans - so a compressed column doesn't re-spread under a card still drawn there - and no larger:
 *   - A card ARRIVING while one is held takes the slot that card left (the slot is the newcomer's now; the held card is
 *     only drawn over it until its ghost shows). Counting the held card on top of the newcomer squeezed every card under
 *     them one card tighter for a frame or two, then spread them back out when the hold ended - and a flight into the
 *     column that measured its slot in between aimed a few points off.
 *   - It is the fan each held card was DRAWN in, not one only as tall as the highest slot still held. Two cards leaving
 *     one after the other (the next card of an auto-play stream going while the first's ghost still waits for its face)
 *     are both drawn in the fan from before either left, and the first one's ghost shows first; sized by the highest slot
 *     left, the column then re-spread to one card fewer under the second card, still frozen in the old fan - the card
 *     under it slid ~12pt up beneath it, its corner index mostly covered, until the second ghost showed too.
 * The cost of the second: a card arriving after the first of two such holds ends but before the second does lands in the
 * older, tighter fan and moves once the second ends. That needs an arrival inside what is left of the second card's hold
 * (a frame or two: its ghost shows once its face paints, GHOST_PAINT_MAX_MS after it mounts at most), where the case it
 * fixes follows every overlap of two holds. A slot above the top that no held card is in counts as face-up, as whatever is
 * above a column's top is: it is a held card's that has gone (only a face-up card's ghost waits for its face, so that card
 * was face-up too), or - practically unreachable - one that left without a hold from under one that has one.
 *
 * The fan is as tall as the top of its LAST slot plus one card: the top card shows whole, so its own step is not part of
 * it. To fit `maxHeight` the face-down steps give way first, down to MIN_FACE_DOWN_FAN_SCALE, then the face-up ones, down
 * to MIN_FACE_UP_FAN_SCALE. Past that the column grows taller than `maxHeight` (`totalHeight`, which PileView sizes its box
 * to) and GameChrome's board scrolls to it, rather than squeezing every covered card's index until it can no longer be
 * read or tapped (a 40-card Yukon column fitted to a phone left ~12pt per card).
 */
export function columnTops(cards: readonly Card[], held: readonly DepartingCard[], faceUpOffset: number, faceDownOffset: number, cardHeight: number, maxHeight: number | undefined) {
  const slots = held.reduce((most, d) => Math.max(most, d.slots), cards.length)
  // Every step below a slot, natural size, and how much of the fan each kind makes up.
  const faceUpSteps: boolean[] = []
  let up = 0
  let down = 0
  for (let slot = 1; slot < slots; slot++) {
    const faceUp = isFaceUpSlot(cards, held, slot - 1)
    faceUpSteps.push(faceUp)
    if (faceUp) up += faceUpOffset
    else down += faceDownOffset
  }
  let upScale = 1
  let downScale = 1
  if (maxHeight !== undefined && up + down + cardHeight > maxHeight) {
    const room = maxHeight - cardHeight
    downScale = down > 0 ? Math.max(MIN_FACE_DOWN_FAN_SCALE, Math.min(1, (room - up) / down)) : 1
    if (up + down * downScale > room) upScale = up > 0 ? Math.max(MIN_FACE_UP_FAN_SCALE, (room - down * downScale) / up) : 1
  }
  const tops: number[] = []
  // The top of the slot being laid out; after the loop, the top of the last one.
  let y = 0
  for (let slot = 0; slot < slots; slot++) {
    if (slot > 0) y += faceUpSteps[slot - 1] ? faceUpOffset * upScale : faceDownOffset * downScale
    if (slot < cards.length) tops.push(y)
  }
  return { tops, totalHeight: y + cardHeight, slots }
}

// Whether the card in `slot` (or the held card drawn there) is face-up; a slot above the top no held card is in counts as
// face-up (see columnTops).
function isFaceUpSlot(cards: readonly Card[], held: readonly DepartingCard[], slot: number): boolean {
  return slot < cards.length ? cards[slot].faceUp : held.find((d) => d.zIndex === slot)?.card.faceUp !== false
}
