// Every distinct baked color used across the decorated pack's suit/court-figure art (confirmed via
// `grep -ohE 'fill: "[^"]*"' decorated/*.ts | sort | uniq -c`), named by role so
// generate-decorated-custom-pack.mjs can relabel decoratedCustom/*.ts's literals against them.

/** Suit ink for black suits (spades/clubs): pip glyphs, rank-corner numerals, the card's own
 * border/frame stroke, and each court figure's one hair/moustache accent shape (courtFigures.ts
 * has exactly one black-filled shape per figure, always drawn last - not suit ink, but bucketed
 * with this same handle so it doesn't sit unchanged against an inverted near-black face; a
 * visual-taste call, not a technical constraint, since it's the only black shape in that file).
 * Flips to a light tone for "invert dark mode colors" (see stores/settings.tsx). */
export const INK_BLACK = '#000000'
/** Suit ink for red suits (hearts/diamonds): the big center pip. Never touched by invert. */
export const INK_RED = '#E6180A'
/** A second, very slightly different red used elsewhere in the baked art (e.g. per-rank index
 * pips) - role not independently confirmed beyond "it's red," but it doesn't matter for this
 * feature: neither red is ever touched by invert. */
export const INK_RED_ALT = '#E61408'
/** Court-figure crown/jewelry/trim accent. Fixed - never touched by invert. */
export const GOLD = '#F8C20F'
/** Court-figure robe/hose lining accent. Fixed - never touched by invert. */
export const NAVY = '#1C1585'
/** The card's own white frame/background fill. Flips to near-black for invert. */
export const CARD_WHITE = '#FFFFFF'

export interface DecoratedPackColors {
  inkBlack: string
  inkRed: string
  inkRedAlt: string
  gold: string
  navy: string
  cardWhite: string
}

export const DEFAULT_PACK_COLORS: DecoratedPackColors = {
  inkBlack: INK_BLACK,
  inkRed: INK_RED,
  inkRedAlt: INK_RED_ALT,
  gold: GOLD,
  navy: NAVY,
  cardWhite: CARD_WHITE
}

/**
 * Builds the literal-to-literal substitution map DecoratedShapeRenderer's resolveColor consumes,
 * from a semantic partial override - e.g. `{ inkBlack: '#F2F2F2' }` becomes `{ '#000000':
 * '#F2F2F2' }`. Only handles present in `overrides` produce a substitution; every other handle's
 * default literal passes through unchanged, so omitting a key (or the whole object) reproduces the
 * pack's default look exactly, pixel for pixel.
 */
export function buildColorOverrideMap(overrides?: Partial<DecoratedPackColors>): Record<string, string> | undefined {
  if (!overrides) return undefined
  const map: Record<string, string> = {}
  for (const key of Object.keys(overrides) as (keyof DecoratedPackColors)[]) {
    const replacement = overrides[key]
    if (replacement) map[DEFAULT_PACK_COLORS[key]] = replacement
  }
  return map
}
