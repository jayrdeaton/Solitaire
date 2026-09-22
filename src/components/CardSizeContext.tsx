/** Vertical fan offsets as a fraction of card height - used by the Pyramid/TriPeaks triangle
 * geometry and by GamePreview's thumbnails, where a covered card shows only its top strip.
 * (PileView and the screens' multi-card ghost `offsetStep` use `faceUpFanOffset(cardWidth)` from
 * `@tastic/cards` instead, a fraction of card WIDTH.)
 *
 * FACE_UP_OFFSET_RATIO must equal `faceUpFanOffset(1) * CARD_ASPECT`, i.e. the corner-row strip of
 * `@tastic/cards` (0.45 of the card's width) re-expressed per unit of card height: 0.45 * 64/93 =
 * 0.3097. A strip shorter than the corner row clips it - the old 0.26 (= 0.378W) left the Jack's
 * index ~0.045W too tall for its strip. Pinned by cardSizeContext.test.ts. */
export const FACE_UP_OFFSET_RATIO = 0.31
export const FACE_DOWN_OFFSET_RATIO = 0.13
