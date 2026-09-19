import { columnBoardModel } from '@/components/gameLayout'

/** The tallest tableau column at the START of a deal (rules.ts's newGame): all four columns get a
 * single face-up card. The 13-card reserve is NOT a tableau column - it is shown as one card slot in
 * the top row (see below) - so it doesn't count here. */
export const TALLEST_COLUMN = { faceDown: 0, faceUp: 1 }

/** Face-up cards of headroom on top of that single starting card. Canfield needs more than the
 * default 3 because its tableau starts nearly empty and then IS the game: four columns that every
 * waste, reserve and foundation-blocked card is built onto, in wrapping alternating-colour runs, so
 * they routinely reach 6-8 cards in normal play. A default-headroom model would size the cards for a
 * 4-card column and start compressing the fan (hiding the ranks the player needs to read) almost
 * immediately. 6 gives a tableau column the same absolute height budget Klondike's model gives its
 * tallest one (about 4.1 vs 3.9 card widths), so the two games' cards come out a similar size in the
 * same window (about 59pt vs 61pt on a phone held sideways). */
export const HEADROOM_FACE_UP = 6

/** What CanfieldScreen's board is made of, for sizing cards to a short (landscape) window - see
 * gameLayout.ts's columnBoardModel. The row above the tableau is exactly ONE card tall: 4 foundations,
 * the reserve (a single DraggableCard showing only its top card - the other 12 are never drawn) and
 * the stock/waste pair (a draw-3 waste fans out sideways, so it adds no height). The paddings are the
 * screen's own topRow marginBottom (16) and tableauRow paddingBottom (20), the model's defaults.
 * Cards here are ALSO width-limited, unlike the other column games: cardWidth is derived from the
 * top row's 7 slots (see TOP_ROW_UNITS in CanfieldScreen), not the 4-column tableau, so in a wide
 * window the width-derived size is large and the height fit is what actually binds. */
export const BOARD_MODEL = columnBoardModel({ ...TALLEST_COLUMN, headroomFaceUp: HEADROOM_FACE_UP })
