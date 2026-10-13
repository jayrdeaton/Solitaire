import { columnBoardModel } from '@/components/gameLayout'

/** The tallest tableau column at the start of a deal: rules.ts's newGame deals every one of the 10
 * columns exactly 4 cards, all face up. */
export const TALLEST_COLUMN = { faceDown: 0, faceUp: 4 }

/** Forty Thieves' board height as a function of card width, for fitting the cards to a short
 * (landscape) window - see gameLayout.ts's fitCardWidthToHeight. */
export const BOARD_MODEL = columnBoardModel({
  // One card row above the tableau: the 8 foundations and the stock/waste pair share a single row
  // (FortyThievesScreen's topRow), so it is exactly one card tall.
  topRowCards: 1,
  ...TALLEST_COLUMN,
  // More headroom than the default 3: columns build down by suit one card at a time and routinely grow
  // well past the 4 they're dealt, so budgeting 5 extra face-up cards (a 9-card column stays
  // uncompressed) keeps the fan readable through the middle game. The margins are the defaults - topRow
  // marginBottom 16, tableauRow paddingBottom 20 (FortyThievesScreen's makeStyles).
  headroomFaceUp: 5,
  // The longest column real play builds: 10 cards, the 90th percentile of each game's tallest column over 1,000
  // simulated deals with a greedy player (2026-10-13). The headroom above already fits it at PileView's minimum fan
  // spacing, so it changes nothing today; it is here so a smaller headroom can't quietly make it scroll.
  longColumn: { faceDown: 0, faceUp: 10 }
})
