import { getBlendedColor, getTonalColor, getTriadicPalette } from '@rific/auto-paper'
import type { TableColors } from '@tastic/cards'
import { useMemo } from 'react'
import { useTheme } from 'react-native-paper'

import { DEFAULT_SEED_COLOR, HINT_RING_TONE, THEME_HARMONY } from '@/constants/theme'
import { useProfiles } from '@/stores/profiles'

import { darkColors, lightColors } from './palettes'

// The felt (derivePlayerTableColors below) is dark-toned in every appearance mode and for every
// profile color (unlike the flat
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

// Matches @tastic/cards' own CardFace/CardBack corner radius (width * 0.06 - see
// node_modules/@tastic/cards/src/CardFace.tsx and CardBack.tsx). The outer clip/shadow/ring
// around a card has to scale with that same formula off the card's own live rendered width, not a
// flat constant - a fixed radius falls inside the card face's own drawn curve once a card renders
// wide enough (few-pile layouts like Aces Up), clipping the border's rounded corner short and
// leaving a visible white gap between the two curves.
export function cardRadiusForWidth(width: number): number {
  return width * 0.06
}
// Radius for CARD_WIDTH-fixed contexts (e.g. HeroCards' home-screen fan, always rendered at
// CARD_WIDTH regardless of any in-game layout) - real gameplay cards use
// cardRadiusForWidth(width) with their own live width instead, since that varies per game/layout.
export const CARD_RADIUS = cardRadiusForWidth(CARD_WIDTH)

export { darkColors, lightColors }

// How strongly a profile's own bright/saturated color tints the base cardBack/cardBackPattern (neutral
// greys, so the blend keeps the profile's hue) - low enough to read as "muted," not as the profile's own
// vivid swatch, but high enough that 20 different seed hues still read as 20 different colors rather
// than washing out toward the same grey.
const PROFILE_TINT_ALPHA = 0.55

// How much further cardBackPattern gets pushed toward white on top of its own PROFILE_TINT_ALPHA
// blend above - blending cardBack/cardBackPattern at the same alpha toward two anchors that differ
// only a little doesn't reliably separate the two by much once a bright enough seed dominates both
// (CardBack.tsx's border frame/medallion render cardBackPattern at full opacity and still read as
// barely-there against cardBack for a seed like pure orange), so the accent gets its own explicit
// lighten instead of relying on the anchors' difference alone.
const ACCENT_LIGHTEN_ALPHA = 0.25

// getTonalColor targets (0-1 lightness), per appearance mode, for the felt/chrome pair.
// tableFeltDark is the darker accent already used for the Toaster and the felt's vignette in both
// palettes - reused here as "chrome" rather than inventing a third TableColors field. Both modes keep
// the same felt-stays-darker-than-chrome-is-light relationship - dark mode's felt is darker than light
// mode's own (not lighter, which read as too bright/washed out for an actual dark theme), while
// staying a bit above chrome's own tone so the play surface still reads distinctly against it.
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
 * cardBack/cardBackPattern/cardBackPatternInverted/tableFelt/tableFeltDark/hintGreen are overridden - every
 * other token is spread from `base` untouched, so legibility-critical tokens (text/borders/glow)
 * never shift with a profile's color. The felt is the card back's opposite hue, darkened, so each
 * profile plays on its own complementary table (the default pink's is green). */
function derivePlayerTableColors(profileColor: string, dark: boolean, base: TableColors): TableColors {
  const cardBack = previewCardBack(profileColor, dark)
  const cardBackPattern = getBlendedColor('#FFFFFF', getBlendedColor(profileColor, base.cardBackPattern, PROFILE_TINT_ALPHA), ACCENT_LIGHTEN_ALPHA)
  // The back's detail keeps its accent with Invert Dark Mode Colors on (Jay, 2026-10-16): it used to be pushed 30%
  // toward black there, which left the pattern barely showing against the dark-mode card back.
  const cardBackPatternInverted = cardBackPattern

  // 'complementary' harmony's own `tertiary` output is the true 180°-opposite hue of cardBack, so
  // this generalizes to whatever hue cardBack ends up as, not just today's blue.
  const complementaryHue = getTriadicPalette(cardBack, 'complementary').tertiary

  return {
    ...base,
    cardBack,
    cardBackPattern,
    cardBackPatternInverted,
    tableFelt: getTonalColor(complementaryHue, dark ? FELT_TONE.dark : FELT_TONE.light),
    // TableColors names this slot hintGreen (@tastic/cards' type; nothing in that package draws it). It is the hint
    // ring's color: the app theme's own tertiary (ProfileThemeSync seeds the theme with this same cardBack and
    // THEME_HARMONY, so it is already muted), lifted to HINT_RING_TONE.
    hintGreen: getTonalColor(getTriadicPalette(cardBack, THEME_HARMONY).tertiary, HINT_RING_TONE),
    tableFeltDark: getTonalColor(complementaryHue, dark ? CHROME_TONE.dark : CHROME_TONE.light)
  }
}

/** Read the OS/user-selected appearance and active player profile, returning the matching
 * palette - always derived (see derivePlayerTableColors), from the active profile/guest's own
 * color where one's been picked, or DEFAULT_SEED_COLOR otherwise. Must be called from inside both
 * auto-paper's <Provider> and <ProfilesProvider> (both mounted in src/app/_layout.tsx).
 *
 * Memoized on [dark, tableColorOverride] - derivePlayerTableColors runs a real RGB/HSL color-blend
 * pipeline (several getBlendedColor/getTonalColor/getTriadicPalette calls, each doing regex-backed
 * hex/rgb string parsing), and this hook is called directly by every PlayingCard/EmptySlot/
 * FoundationSlot instance (not just once per screen) - unmemoized, a single move/tap/drag-drop
 * redid that full derivation independently for every one of the ~40-52+ visible cards on the
 * board, every time, and returned a brand-new TableColors object each time even when nothing about
 * the theme/profile actually changed. That defeated every downstream useMemo/React.memo keyed on
 * `colors` too - including @tastic/cards' own CardFace/CardBack memoization, whose whole premise is
 * a stable `colors` reference across unrelated re-renders. Confirmed as a real, live perf cost via
 * a dedicated audit, not just a theoretical one. */
export function useTableColors(): TableColors {
  const { dark } = useTheme()
  const { tableColorOverride } = useProfiles()
  return useMemo(() => {
    const base = dark ? darkColors : lightColors
    return derivePlayerTableColors(tableColorOverride ?? DEFAULT_SEED_COLOR, dark, base)
  }, [dark, tableColorOverride])
}

/** A representative slice of the active palette for @tastic/sprites' Fireworks background -
 * pulled from theme tokens rather than hardcoded so the show matches the active profile's tint. */
export function fireworksColors(colors: TableColors): string[] {
  return [colors.selectedGlow, colors.hintGreen, colors.cardBackPattern, colors.textRed]
}
