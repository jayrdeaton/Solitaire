import { getBlendedColor } from '@rific/auto-paper'
import type { TableColors } from '@tastic/cards'
import { useMemo } from 'react'
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

// Card ink stays fixed across both palettes - cardFace itself is nearly the same near-white in
// light and dark mode, so a card should read like a physical card regardless of the felt/chrome
// theme around it, rather than a dark-mode-tuned red that lands on that same light face and ends
// up washed out.
const CARD_INK_RED = '#C41E3A'
const CARD_INK_BLACK = '#1A1A1A'

// cardBack/cardBackPattern here are only blend anchors - never rendered directly (see useTableColors
// below, which always derives through derivePlayerTableColors using at least DEFAULT_SEED_COLOR),
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

// The seed every fresh install/guest effectively starts on - Material Pink 500 - rather than leaving
// cardBack on the flatter blue blend anchor above; it is what gives the default card back its
// magenta. (It was originally picked for the felt it used to derive too; the felt is now the fixed
// splash-matching green regardless of seed, so today it only sets the card back.) Also what a
// brand-new profile's own color starts as (see app/profiles.tsx's defaultColor) - a real seed a
// picker can match against, not a pre-blended value nothing in the swatch grid equals.
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

/** The card-back color a given seed hex actually resolves to once blended toward the base palette
 * - the same blend derivePlayerTableColors applies to `cardBack`, exported so a color picker can
 * preview this result per-swatch instead of the raw, too-vibrant seed hue. */
export function previewCardBack(seedHex: string, dark: boolean): string {
  const base = dark ? darkColors : lightColors
  return getBlendedColor(seedHex, base.cardBack, PROFILE_TINT_ALPHA)
}

/** Derives a full TableColors palette tinted toward a seed color (an active player profile's
 * color, or DEFAULT_SEED_COLOR when nothing's been picked - see useTableColors below). Only
 * cardBack/cardBackPattern/cardBackPatternInverted are overridden - every other token is spread from
 * `base` untouched, so legibility-critical tokens (text/borders/glow) never shift with a profile's
 * color, and neither does the felt (tableFelt/tableFeltDark): it is always `base`'s own green, the
 * one the native splash screen is painted in (see the anchors' comment above). */
function derivePlayerTableColors(profileColor: string, dark: boolean, base: TableColors): TableColors {
  const cardBack = previewCardBack(profileColor, dark)
  const cardBackPattern = getBlendedColor('#FFFFFF', getBlendedColor(profileColor, base.cardBackPattern, PROFILE_TINT_ALPHA), ACCENT_LIGHTEN_ALPHA)
  // Only actually darkened in dark mode - in light mode this is an exact no-op (equals
  // cardBackPattern itself), same contract as this file's other *Inverted tokens, just expressed
  // via `dark` here instead of a light/dark anchor difference (see the interface doc for why).
  const cardBackPatternInverted = dark ? getBlendedColor('#000000', cardBackPattern, ACCENT_DARKEN_ALPHA) : cardBackPattern

  return {
    ...base,
    cardBack,
    cardBackPattern,
    cardBackPatternInverted
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

/** A representative slice of the active palette for @tastic/animations' Fireworks background -
 * pulled from theme tokens rather than hardcoded so the show matches the active profile's tint. */
export function fireworksColors(colors: TableColors): string[] {
  return [colors.selectedGlow, colors.hintGreen, colors.cardBackPattern, colors.textRed]
}
