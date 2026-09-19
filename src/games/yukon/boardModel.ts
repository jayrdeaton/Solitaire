import { columnBoardModel } from '@/components/gameLayout'

/** The tallest tableau column at the START of a deal (rules.ts's newGame): the seventh column gets
 * the Klondike-shaped base of 7 cards (6 face-down + 1 face-up) plus 4 more dealt face up on top, so
 * 6 face-down and 5 face-up. The other columns are strictly shorter (1, 6, 7, 8, 9, 10 cards, with
 * proportionally fewer of each kind), so this one alone sets the board's height. */
export const TALLEST_COLUMN = { faceDown: 6, faceUp: 5 }

/** What YukonScreen's board is made of, for sizing cards to a short (landscape) window - see
 * gameLayout.ts's columnBoardModel. The row above the tableau is exactly ONE card tall: the four
 * foundations, plus (only while dealing) a single deck-placeholder card standing in for the deal's
 * origin - never a second row - so the default topRowCards of 1 is right. The paddings are the
 * screen's own topRow marginBottom (16) and tableauRow paddingBottom (20), the model's defaults.
 * The default face-up headroom is kept on purpose: this deal already starts 11 cards deep, so the
 * headroom sits on top of the deepest start of any Klondike-family game, and budgeting more would
 * shrink cards well past what a phone held sideways can afford (see boardModel.test.ts's floor). */
export const BOARD_MODEL = columnBoardModel({ ...TALLEST_COLUMN })
