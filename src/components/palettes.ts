// The card-table palettes, kept free of any runtime dependency (no Paper, no profile store) so
// scripts/generate-card-face-bitmaps.mjs can bundle them on their own - the pre-rasterized card faces
// bake in these exact inks. theme.ts re-exports both; import them from there.
import type { TableColors } from '@tastic/cards'

// Card ink stays fixed across both palettes - cardFace itself is nearly the same near-white in
// light and dark mode, so a card should read like a physical card regardless of the felt/chrome
// theme around it, rather than a dark-mode-tuned red that lands on that same light face and ends
// up washed out.
const CARD_INK_RED = '#C41E3A'
const CARD_INK_BLACK = '#1A1A1A'

// cardBack/cardBackPattern here are only blend anchors - never rendered directly (see theme.ts's useTableColors,
// which always derives through derivePlayerTableColors using at least DEFAULT_SEED_COLOR),
// what every seed's own tint gets blended toward. They are neutral greys, so the blend only mutes a
// profile's color (less saturated, pulled toward the grey's lightness) and never shifts its hue: a red
// profile stays red. They used to be navy, which dragged every hue toward blue (red came out plum).
// Each grey has the HSL lightness of the navy it replaced, so card backs keep their old weight.
// tableFelt/tableFeltDark are never rendered either: the felt is derived from the card back too (the
// app's original hand-picked green, kept only because the TableColors shape needs a value). hintGreen is
// derived too (the hint ring: the theme's tertiary, muted and lifted), so these greens are never drawn either.
export const lightColors: TableColors = {
  tableFelt: '#0B6E4F',
  tableFeltDark: '#08573F',
  cardFace: '#EEEEEE',
  // Not '#EEEEEE' (cardFace's own value) - CardFace.tsx's real card background is a hardcoded
  // '#FFFFFF' literal (cardFace itself is currently unused by real gameplay cards), and that's also
  // decoratedCustom's CARD_WHITE default - matching '#FFFFFF' here is what makes this a true no-op.
  cardFaceInverted: '#FFFFFF',
  cardBack: '#565656',
  cardBackPattern: '#737373',
  cardBackPatternInverted: '#737373',
  cardBorder: '#00000055',
  selectedGlow: '#FFD54A',
  textRed: CARD_INK_RED,
  textBlack: CARD_INK_BLACK,
  textBlackInverted: CARD_INK_BLACK,
  emptySlot: '#00000033',
  hintGreen: '#3ECF6E',
  dimOverlay: '#00000066',
  dimOverlayInverted: '#00000066'
}

export const darkColors: TableColors = {
  tableFelt: '#08573F',
  tableFeltDark: '#053D2C',
  cardFace: '#D6D6D6',
  cardFaceInverted: CARD_INK_BLACK,
  cardBack: '#404040',
  cardBackPattern: '#515151',
  cardBackPatternInverted: '#515151',
  cardBorder: '#00000055',
  selectedGlow: '#FFD54A',
  textRed: CARD_INK_RED,
  textBlack: CARD_INK_BLACK,
  textBlackInverted: '#F2F2F2',
  emptySlot: '#FFFFFF33',
  hintGreen: '#3ECF6E',
  dimOverlay: '#00000070',
  dimOverlayInverted: '#FFFFFF70'
}
