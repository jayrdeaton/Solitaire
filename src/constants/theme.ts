import type { ColorHarmony } from '@rific/auto-paper'

// The seed every fresh install/guest effectively starts on - Material Pink 500 - chosen because its
// derived felt (see components/theme.ts's derivePlayerTableColors: the card back's opposite hue)
// lands on a pleasant green close to this app's original hand-picked felt, rather than leaving
// cardBack on the flatter blue blend anchor. It also gives the default card back its magenta. Also what a
// brand-new profile's own color starts as (see app/profiles.tsx's defaultColor) - a real seed a
// picker can match against, not a pre-blended value nothing in the swatch grid equals.
export const DEFAULT_SEED_COLOR = '#e91e63'

// How auto-paper places secondary/tertiary around the seed. Its default, split-complementary, puts both
// 150 and 210 degrees round the wheel, only 60 apart with the same saturation and lightness, so for most
// seeds the two read as one color (the default pink's were two greens). Triadic spaces them 120 apart.
// Set in the store's initial state and again by ProfileThemeSync, since a saved theme keeps the old one.
export const THEME_HARMONY: ColorHarmony = 'triadic'

// The hint ring's lightness (PlayingCard's hintRing, theme.ts's hintGreen, GuideArt's GuideHint): the
// theme's tertiary (muted, like the card back it is built from), lifted this far so a ring on the dark
// felt reads by its lightness too, not by its hue alone. Tertiary, not the card back's own primary, so a
// ring around a card in a stack never blends into the backs beside it (Jay, 2026-10-14).
export const HINT_RING_TONE = 0.62
