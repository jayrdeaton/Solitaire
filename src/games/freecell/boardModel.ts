import { columnBoardModel } from '@/components/gameLayout'

/** The tallest tableau column at the start of a deal: rules.ts's newGame gives the first four columns 7
 * cards and the last four 6, and FreeCell deals every card face up - so nothing is face-down. */
export const TALLEST_COLUMN = { faceDown: 0, faceUp: 7 }

/** FreeCell's board height as a function of card width, for fitting the cards to a short (landscape)
 * window - see gameLayout.ts's fitCardWidthToHeight. */
export const BOARD_MODEL = columnBoardModel({
  // One card row above the tableau: the 4 foundations and 4 freecells sit side by side in a single
  // row (FreeCellScreen's topRow) - there is no stock or second row.
  topRowCards: 1,
  // Default headroom (3 extra face-up cards) and default margins: a FreeCell column grows past its dealt
  // depth as runs are built, but PileView compresses a long fan gracefully, so the default is enough to
  // keep the first few moves from squeezing anything. topRow marginBottom is 16 and tableauRow
  // paddingBottom 20 (FreeCellScreen's makeStyles) - the same numbers the defaults assume.
  ...TALLEST_COLUMN
})
