import { cardWidthForRow } from '@tastic/cards'

/**
 * The one minimum gap every game screen's own card row/tableau uses - and, via StockWaste.tsx's
 * own internal stock/waste spacing, the same value a screen embedding <StockWaste> is implicitly
 * relying on when it folds StockWaste's footprint into its own row-width reservation math (see
 * CanfieldScreen.tsx's TOP_ROW_UNITS/TOP_ROW_GAP doc comment for why that reservation has to be
 * pixel-exact). Every game used to declare its own local TABLEAU_GAP/COL_GAP/PILE_GAP - same idea,
 * different numbers (4 to 16) picked independently per screen - now unified to one shared floor:
 * cardLayoutForRow below only ever grows the actual gap PAST this once a row's cards have already
 * hit their own max size and there's real leftover width to give them, so the common case (a phone-
 * width screen, where cards are nowhere near cardWidthForRow's 96px cap) renders identically to
 * whichever of the old per-game constants happened to equal this value already. Lives here (not
 * games/shared/) so components/StockWaste.tsx can read it too, without games/ code depending on
 * component internals or vice versa - same reasoning GAME_CONTENT_PADDING/GAME_CONTENT_MAX_WIDTH
 * already live in GameChrome.tsx rather than a games/shared/ file.
 */
export const CARD_GAP_MIN = 6

/** cardWidthForRow's own default max card width (see @tastic/cards) - re-exported so cardLayoutForRow
 * below has one named constant to compare against instead of a second hardcoded 96 magic number. */
export const CARD_WIDTH_MAX = 96

/** Ceiling on how far cardLayoutForRow will grow the gap past CARD_GAP_MIN once cards are maxed
 * out - without this, a low-column game (AcesUp's 4 piles, say) on a wide enough desktop/web window
 * would keep stretching the gap to fill every last pixel of leftover width, reading as cards
 * scattered across the table rather than a deliberately roomier layout. 4x CARD_GAP_MIN: clearly
 * more breathing room than the floor once there's real space to spare, without approaching
 * CARD_WIDTH_MAX itself (a gap as wide as the cards it separates would stop reading as one row).
 * Once this caps out, the leftover width past `columns*CARD_WIDTH_MAX + (columns-1)*CARD_GAP_MAX`
 * is simply left unused - every game's own top-level row is already centered within GameChrome's
 * content area (see tableTapCatcher's own `alignItems: 'center'`), so that leftover just becomes
 * symmetric margin on both sides rather than dead space on one. */
export const CARD_GAP_MAX = 24

/**
 * Sizes a row of `columns` cards to fill `availableWidth`, treating CARD_GAP_MIN as a FLOOR rather
 * than a fixed value: cards grow to fill the available width first (identical to a plain
 * cardWidthForRow(availableWidth, columns, CARD_GAP_MIN) call, and returned as such) right up until
 * they hit cardWidthForRow's own CARD_WIDTH_MAX cap - only past that point does any further
 * available width widen the gap between cards instead of doing nothing with it (cardWidthForRow's
 * own behavior once cardWidth is maxed: the excess just centers as unused space via ContentGutter,
 * never feeding back into that row's own internal gaps). A phone-width screen never reaches this
 * branch at all (cards there are nowhere near the 96px cap) - it only fires on a wide tablet/desktop
 * window, which is exactly where the old fixed-gap behavior looked worst: an already-maxed-out
 * card row just floating in a sea of dead space rather than the cards' own gaps breathing with it.
 * The gap itself is further clamped at CARD_GAP_MAX, so that "breathing room" has its own ceiling
 * instead of growing without bound on a very wide window with few columns.
 */
export function cardLayoutForRow(availableWidth: number, columns: number): { cardWidth: number; gap: number } {
  const cardWidth = cardWidthForRow(availableWidth, columns, CARD_GAP_MIN)
  if (cardWidth < CARD_WIDTH_MAX || columns <= 1) {
    return { cardWidth, gap: CARD_GAP_MIN }
  }
  const gap = (availableWidth - CARD_WIDTH_MAX * columns) / (columns - 1)
  return { cardWidth: CARD_WIDTH_MAX, gap: Math.min(CARD_GAP_MAX, Math.max(CARD_GAP_MIN, gap)) }
}
