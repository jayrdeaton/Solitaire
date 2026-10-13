import { columnBoardModel } from '@/components/gameLayout'

/** The tallest tableau column at the START of a deal (rules.ts's newGame): column `col` gets `col + 1`
 * cards with only the last face up, so the seventh column holds 6 face-down cards plus its one
 * face-up card. */
export const TALLEST_COLUMN = { faceDown: 6, faceUp: 1 }

/** What KlondikeScreen's board is made of, for sizing cards to a short (landscape) window - see
 * gameLayout.ts's columnBoardModel. The row above the tableau is exactly ONE card tall: the four
 * foundations and the stock/waste pair are all single cards (a draw-3 waste fans out sideways, into
 * the gap beside the foundations, so it adds no height), so the default topRowCards of 1 is right.
 * The paddings are the screen's own topRow marginBottom (16) and tableauRow paddingBottom (20),
 * which are the model's defaults, and the default face-up headroom is enough for a few cards to be
 * played onto the seventh column before it starts compressing - Klondike's columns grow by a run or
 * two at a time, not by the deep builds Canfield's or Forty Thieves' do. */
/** The longest column real play builds, which still fits at PileView's minimum fan spacing (see columnBoardModel): a King
 * run down to the 2 in a cleared column (the Ace goes up), 12 face-up cards - the 90th percentile of each game's tallest
 * column over 5,000 simulated deals with a greedy player (2026-10-13). */
export const LONG_COLUMN = { faceDown: 0, faceUp: 12 }

export const BOARD_MODEL = columnBoardModel({ ...TALLEST_COLUMN, longColumn: LONG_COLUMN })
