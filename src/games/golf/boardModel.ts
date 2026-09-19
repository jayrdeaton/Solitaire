import { columnBoardModel } from '@/components/gameLayout'

/** The tallest tableau column at the start of a deal: rules.ts's newGame deals every one of the 7
 * columns exactly 5 cards, all face up. */
export const TALLEST_COLUMN = { faceDown: 0, faceUp: 5 }

/** Golf's board height as a function of card width, for fitting the cards to a short (landscape)
 * window - see gameLayout.ts's fitCardWidthToHeight. */
export const BOARD_MODEL = columnBoardModel({
  // One card row above the tableau: just the stock/waste pair (GolfScreen's topRow) - Golf has no
  // foundation row at all.
  topRowCards: 1,
  ...TALLEST_COLUMN,
  // No headroom at all, unlike the default 3: a Golf column can only ever lose cards (rules.ts's
  // tryMove only moves a column's top card onto the waste pile, and nothing ever returns to the
  // tableau), so the dealt 5-card column IS the worst case and any extra budget would just shrink the
  // cards for nothing. The margins are the defaults - topRow marginBottom 16, tableauRow paddingBottom
  // 20 (GolfScreen's makeStyles).
  headroomFaceUp: 0
})
