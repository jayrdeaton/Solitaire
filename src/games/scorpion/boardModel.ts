import { columnBoardModel } from '@/components/gameLayout'

/** The tallest tableau column a deal produces: 8 face-up cards (no face-down at all). Columns 0-3 hold
 * 3 face-down + 4 face-up (7 cards, a shorter fan than 8 all-face-up ones); columns 4-6 hold 8
 * face-up in the classic variant. The assisted variant deals those three columns only 7 but hands
 * over 3 more cards later (one onto each, see rules.ts's drawStock), so it reaches the same 8 the
 * moment its stock is dealt - one board model covers both variants and card size never changes
 * when the stock is dealt. */
export const TALLEST_COLUMN = { faceDown: 0, faceUp: 8 }

/** ScorpionScreen's WIDE board (the only layout that fits cards to the height): no top row at all -
 * the assisted stock packet sits beside the tableau, absolutely positioned, so it takes no part in the
 * flow - just the 7 tableau columns and the tableau row's own paddingBottom. (Portrait keeps its
 * card-tall top row but is width-sized and never consults this model.)
 *
 * Default headroom: columns grow toward a 13-card King-to-Ace run as the player stacks suits, and
 * 8 + 3 = 11 cards fit before PileView starts compressing the fan. */
export const BOARD_MODEL = columnBoardModel({ ...TALLEST_COLUMN, topRowCards: 0 })
