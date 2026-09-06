import { getBlendedColor, getTonalColor, getTriadicPalette } from '@rific/auto-paper'
import { useTheme } from 'react-native-paper'

import { useProfiles } from '@/stores/profiles'

// Both felt palettes below are dark-toned green in every appearance mode (unlike the flat
// literal-white/black backgrounds some other @tastic apps flip between), so the chrome buttons
// (achievements/settings/back) always want the same fixed foreground rather than one derived from
// `dark` - this is what the old native header already used unconditionally.
export const CHROME_FG = '#fff'

// Translucent-white variants of CHROME_FG, for chrome surfaces that need a muted text tone or a
// lightly-raised card background (e.g. achievements.tsx's stat/achievement sections) instead of
// CHROME_FG's full-contrast use - tuned against the felt palettes above, not derived from `dark`,
// for the same reason CHROME_FG itself isn't.
export const CHROME_FG_MUTED = 'rgba(255,255,255,0.82)'
export const CHROME_SECTION_BG = 'rgba(255,255,255,0.12)'

export const CARD_WIDTH = 64
// Chosen aspect ratio for the card face; can be revisited once real hand-drawn
// court/number art exists and it's clear whether this still looks proportionate.
export const CARD_HEIGHT = 93
export const CARD_RADIUS = 4

// Card ink stays fixed across both palettes - cardFace itself is nearly the same near-white in
// light and dark mode, so a card should read like a physical card regardless of the felt/chrome
// theme around it, rather than a dark-mode-tuned red that lands on that same light face and ends
// up washed out.
const CARD_INK_RED = '#C41E3A'
const CARD_INK_BLACK = '#1A1A1A'

export interface TableColors {
  tableFelt: string
  tableFeltDark: string
  cardFace: string
  /** cardFace's counterpart for "invert dark mode colors" - a near-black face, real only on
   * darkColors; lightColors' copy just mirrors cardFace. */
  cardFaceInverted: string
  cardBack: string
  cardBackPattern: string
  /** cardBackPattern's counterpart for "invert dark mode colors" - the same profile-tinted accent,
   * pulled toward black instead of white, so a card back's pattern reads as darkened rather than
   * unchanged next to its now-near-black frame (see CardBack.tsx/DecoratedCardBack.tsx). Unlike
   * this file's other *Inverted tokens, this one is never rendered directly (same as cardBackPattern
   * itself) - it's always computed fresh in derivePlayerTableColors, gated on `dark` there (not via
   * a light/dark anchor difference), since it depends on the live profile-blended accent rather than
   * a fixed palette constant. The anchor value here is a placeholder only. */
  cardBackPatternInverted: string
  cardBorder: string
  selectedGlow: string
  textRed: string
  textBlack: string
  /** textBlack's counterpart for the "invert dark mode colors" setting (see stores/settings.tsx) -
   * a near-white ink, real only on darkColors; lightColors' copy just mirrors textBlack, so this is
   * always safe to read regardless of the setting or current appearance. Also doubles as the
   * inverted card-frame border color (compact/tarot, Decorated's #base stroke). Red suits never
   * get an inverted counterpart - the setting only ever touches black ink. */
  textBlackInverted: string
  emptySlot: string
  hintGreen: string
  /** Scrim drawn over a not-yet-playable card (e.g. a buried Pyramid card) - a translucent
   * overlay on top of the full-opacity face, rather than fading the card itself, so its rank/suit
   * stay crisp and legible instead of washing out toward the felt color. */
  dimOverlay: string
  /** dimOverlay's counterpart for "invert dark mode colors" - a translucent *black* dimOverlay
   * barely darkens an already near-black inverted face, silently erasing the dimmed/full-strength
   * distinction in exactly the mode where it matters most, so this is a translucent white wash
   * instead. Real only on darkColors; lightColors' copy mirrors dimOverlay. */
  dimOverlayInverted: string
}

// Blend anchors only - never rendered directly (see useTableColors below, which always derives
// through derivePlayerTableColors using at least DEFAULT_SEED_COLOR). cardBack/cardBackPattern
// here are what every seed's own tint gets blended toward; tableFelt/tableFeltDark are likewise
// only ever read as derivePlayerTableColors' own `base` input, never returned as-is.
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

// The seed every fresh install/guest effectively starts on - Material Pink 500, chosen because its
// derived felt (see derivePlayerTableColors) lands on a pleasant green close to this app's original
// hand-picked felt, rather than leaving cardBack/tableFelt on the flatter blue/green blend anchors
// above. Also what a brand-new profile's own color starts as (see app/profiles.tsx's defaultColor)
// - a real seed a picker can match against, not a pre-blended value nothing in the swatch grid
// equals.
export const DEFAULT_SEED_COLOR = '#e91e63'

// How strongly a profile's own bright/saturated color tints the base cardBack/cardBackPattern -
// low enough to read as "muted," not as the profile's own vivid swatch, but high enough that 20
// different seed hues still read as 20 different colors rather than collapsing toward base's own
// blue (too low a value pulls every result toward the same hue, not just toward "less vivid").
const PROFILE_TINT_ALPHA = 0.55

// How much further cardBackPattern gets pushed toward white on top of its own PROFILE_TINT_ALPHA
// blend above - blending cardBack/cardBackPattern at the same alpha toward two merely-different-
// hued anchors doesn't reliably separate the two by much once a bright enough seed dominates both
// (CardBack.tsx's border frame/medallion render cardBackPattern at full opacity and still read as
// barely-there against cardBack for a seed like pure orange), so the accent gets its own explicit
// lighten instead of relying on anchor-hue difference alone.
const ACCENT_LIGHTEN_ALPHA = 0.25

// How far cardBackPatternInverted gets pushed toward black instead - "invert dark mode colors"'s
// darkened counterpart to the lighten above. Slightly stronger than ACCENT_LIGHTEN_ALPHA (was equal
// at 0.25, kept symmetric with the lighten above) - bumped up on request, but there's real headroom
// tension here: cardBackPattern's own un-inverted luminance is fixed regardless of alpha, while this
// blend's luminance falls linearly as alpha grows, so past a seed-color-dependent threshold (~0.4
// measured against one profile's tint) the darkened accent's brightness converges on cardBack's own
// and the pattern silently loses all contrast against it, rather than degrading gracefully. 0.4 hit
// exactly that wall (confirmed unreadable); this is a smaller, safer step up from the original.
const ACCENT_DARKEN_ALPHA = 0.3

// getTonalColor targets (0-1 lightness), per appearance mode, for the felt/chrome pair.
// tableFeltDark is the darker accent already used for the Stack header/Toaster in both palettes -
// reused here as "chrome" rather than inventing a third TableColors field. Both modes keep the
// same felt-stays-darker-than-chrome-is-light relationship - dark mode's felt is darker than light
// mode's own (not lighter, as an earlier version of this had it, which read as too bright/washed
// out for an actual dark theme), while staying a bit above chrome's own tone so the play surface
// still reads distinctly against it.
const FELT_TONE = { light: 0.24, dark: 0.16 }
const CHROME_TONE = { light: 0.15, dark: 0.08 }

/** The card-back color a given seed hex actually resolves to once blended toward the base palette
 * - the same blend derivePlayerTableColors applies to `cardBack`, exported so a color picker can
 * preview this result per-swatch instead of the raw, too-vibrant seed hue. */
export function previewCardBack(seedHex: string, dark: boolean): string {
  const base = dark ? darkColors : lightColors
  return getBlendedColor(seedHex, base.cardBack, PROFILE_TINT_ALPHA)
}

/** Derives a full TableColors palette tinted toward a seed color (an active player profile's
 * color, or DEFAULT_SEED_COLOR when nothing's been picked - see useTableColors below). Only
 * cardBack/cardBackPattern/cardBackPatternInverted/tableFelt/tableFeltDark are overridden - every
 * other token is spread from `base` untouched, so legibility-critical tokens (text/borders/glow)
 * never shift with a profile's color. */
function derivePlayerTableColors(profileColor: string, dark: boolean, base: TableColors): TableColors {
  const cardBack = previewCardBack(profileColor, dark)
  const cardBackPattern = getBlendedColor('#FFFFFF', getBlendedColor(profileColor, base.cardBackPattern, PROFILE_TINT_ALPHA), ACCENT_LIGHTEN_ALPHA)
  // Only actually darkened in dark mode - in light mode this is an exact no-op (equals
  // cardBackPattern itself), same contract as this file's other *Inverted tokens, just expressed
  // via `dark` here instead of a light/dark anchor difference (see the interface doc for why).
  const cardBackPatternInverted = dark ? getBlendedColor('#000000', cardBackPattern, ACCENT_DARKEN_ALPHA) : cardBackPattern

  // 'complementary' harmony's own `tertiary` output is the true 180°-opposite hue of cardBack, so
  // this generalizes to whatever hue cardBack ends up as, not just today's blue.
  const complementaryHue = getTriadicPalette(cardBack, 'complementary').tertiary

  return {
    ...base,
    cardBack,
    cardBackPattern,
    cardBackPatternInverted,
    tableFelt: getTonalColor(complementaryHue, dark ? FELT_TONE.dark : FELT_TONE.light),
    tableFeltDark: getTonalColor(complementaryHue, dark ? CHROME_TONE.dark : CHROME_TONE.light)
  }
}

/** Read the OS/user-selected appearance and active player profile, returning the matching
 * palette - always derived (see derivePlayerTableColors), from the active profile/guest's own
 * color where one's been picked, or DEFAULT_SEED_COLOR otherwise. Must be called from inside both
 * auto-paper's <Provider> and <ProfilesProvider> (both mounted in src/app/_layout.tsx). */
export function useTableColors(): TableColors {
  const { dark } = useTheme()
  const base = dark ? darkColors : lightColors
  const { tableColorOverride } = useProfiles()
  return derivePlayerTableColors(tableColorOverride ?? DEFAULT_SEED_COLOR, dark, base)
}

/** A representative slice of the active palette for @tastic/animations' Fireworks background -
 * pulled from theme tokens rather than hardcoded so the show matches the active profile's tint. */
export function fireworksColors(colors: TableColors): string[] {
  return [colors.selectedGlow, colors.hintGreen, colors.cardBackPattern, colors.textRed]
}
