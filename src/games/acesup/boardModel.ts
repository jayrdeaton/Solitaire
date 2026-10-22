import { columnBoardModel } from '@/components/gameLayout'

/** The tallest pile at the START of a deal: every pile holds just its one face-up card (rules.ts's
 * newGame deals 4 cards, one per pile, and keeps the other 48 in the stock). */
export const TALLEST_COLUMN = { faceDown: 0, faceUp: 1 }

/** AcesUpScreen's board: a top row one card tall (the discard pile on the left, the stock on the
 * right) plus its marginBottom 16, then the 4 piles with the shared 20 paddingBottom.
 *
 * More headroom than the default 3, because this is the one board whose deal says almost nothing
 * about how tall it gets: a pile starts as a single card and gains one more (face-up, fanned like any
 * other) on every stock round, 12 rounds in all, only shrinking as discards clear cards away. Budgeting
 * the default 3 would start compressing the fan by round 4, well before a normal game's piles peak, so
 * this leaves room for a 6-card pile (1 + 5). It deliberately stops well short of the 13 a pile could
 * reach with no discards at all - that would shrink four cards to a size nobody would choose to play
 * at - and a pile that outgrows the budget compresses like every other column. */
/** The longest pile real play builds, which still fits at PileView's minimum fan spacing (see columnBoardModel): 9 cards -
 * the 90th percentile of each game's tallest pile over 5,000 simulated deals with the app's Hint (2026-10-13).
 * AcesUpScreen fits it in portrait too. */
export const LONG_COLUMN = { faceDown: 0, faceUp: 9 }

/** The least gap between the four piles. The board-wide floor (CARD_GAP_MIN, 2pt) left four 95pt piles 2pt apart on a
 * 390pt phone, where 375 and 430pt phones get ~14pt (their cards are fitted to the height, or capped): the crowding
 * audit of 2026-10-22. */
export const PILE_MIN_GAP = 12

export const BOARD_MODEL = columnBoardModel({ ...TALLEST_COLUMN, headroomFaceUp: 5, longColumn: LONG_COLUMN })
