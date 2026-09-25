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
// what every seed's own tint gets blended toward. tableFelt/tableFeltDark, by contrast, ARE rendered
// as-is, for every player: the app's one felt. They are the same two greens as the native splash
// screen's `backgroundColor` in app.json (`expo-splash-screen` plugin, light + dark) - the splash is
// compiled into the binary and shown before any JS runs, so it can't know which profile is active,
// and the felt has to be that same green for the launch to hand off seamlessly. Change one, change
// the other (src/__tests__/components/splashMatchesFelt.test.ts fails if they drift).
export const lightColors: TableColors = {
  tableFelt: '#0B6E4F',
  tableFeltDark: '#08573F',
  cardFace: '#EEEEEE',
  // Not '#EEEEEE' (cardFace's own value) - CardFace.tsx's real card background is a hardcoded
  // '#FFFFFF' literal (cardFace itself is currently unused by real gameplay cards), and that's also
  // decoratedCustom's CARD_WHITE default - matching '#FFFFFF' here is what makes this a true no-op.
  cardFaceInverted: '#FFFFFF',
  cardBack: '#1B4B91',
  cardBackPattern: '#2E63B8',
  cardBackPatternInverted: '#2E63B8',
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
  cardBack: '#14346B',
  cardBackPattern: '#22437F',
  cardBackPatternInverted: '#22437F',
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
