import type { SolitaireGameId } from '@/stores/statsTypes'

// One game under one rule set: the unit stats are kept in and par is set for, since a 1-suit and a 4-suit Spider win
// (or a Draw 1 and a Draw 3 Klondike win) are not the same achievement. A game's DEFAULT variant (DEFAULT_SETTINGS'
// rule) keeps the bare game id as its key, so the stats recorded before variants existed carry straight over into it:
// they were mostly played on the default, and nothing had to be migrated or reset. The rest are `<game>-<rule>`.
export type VariantId = 'klondike' | 'klondike-draw3' | 'spider' | 'spider-2suit' | 'spider-4suit' | 'freecell' | 'pyramid' | 'yukon' | 'golf' | 'golf-wrap' | 'tripeaks' | 'tripeaks-wrap' | 'canfield' | 'canfield-draw1' | 'scorpion' | 'scorpion-classic' | 'fortythieves' | 'fortythieves-runs' | 'acesup'

export interface VariantInfo {
  id: VariantId
  game: SolitaireGameId
  /** The rule's name as its Settings row shows it, or null for a game with only one rule set. */
  label: string | null
}

/** Every variant, grouped by game in SOLITAIRE_GAME_IDS order, each game's default first. */
export const VARIANTS: VariantInfo[] = [
  { id: 'klondike', game: 'klondike', label: 'Draw 1' },
  { id: 'klondike-draw3', game: 'klondike', label: 'Draw 3' },
  { id: 'spider', game: 'spider', label: '1 Suit' },
  { id: 'spider-2suit', game: 'spider', label: '2 Suits' },
  { id: 'spider-4suit', game: 'spider', label: '4 Suits' },
  { id: 'freecell', game: 'freecell', label: null },
  { id: 'pyramid', game: 'pyramid', label: null },
  { id: 'yukon', game: 'yukon', label: null },
  { id: 'golf', game: 'golf', label: 'No Wrap' },
  { id: 'golf-wrap', game: 'golf', label: 'K-A Wrap' },
  { id: 'tripeaks', game: 'tripeaks', label: 'No Wrap' },
  { id: 'tripeaks-wrap', game: 'tripeaks', label: 'K-A Wrap' },
  { id: 'canfield', game: 'canfield', label: 'Draw 3' },
  { id: 'canfield-draw1', game: 'canfield', label: 'Draw 1' },
  { id: 'scorpion', game: 'scorpion', label: 'Assisted' },
  { id: 'scorpion-classic', game: 'scorpion', label: 'Classic' },
  { id: 'fortythieves', game: 'fortythieves', label: 'Single Card' },
  { id: 'fortythieves-runs', game: 'fortythieves', label: 'Allow Runs' },
  { id: 'acesup', game: 'acesup', label: null }
]

export const VARIANT_IDS: VariantId[] = VARIANTS.map((v) => v.id)

const BY_ID = Object.fromEntries(VARIANTS.map((v) => [v.id, v])) as Record<VariantId, VariantInfo>

export function variantInfo(id: VariantId): VariantInfo {
  return BY_ID[id]
}

export function gameOfVariant(id: VariantId): SolitaireGameId {
  return BY_ID[id].game
}

export function variantsOfGame(game: SolitaireGameId): VariantId[] {
  return VARIANTS.filter((v) => v.game === game).map((v) => v.id)
}

// Each screen names the variant of the deal on the board from the rule it was DEALT with (its own state, not the live
// setting, which may have changed since).
export const klondikeVariant = (draw: 1 | 3): VariantId => (draw === 3 ? 'klondike-draw3' : 'klondike')
export const spiderVariant = (suits: 1 | 2 | 4): VariantId => (suits === 4 ? 'spider-4suit' : suits === 2 ? 'spider-2suit' : 'spider')
export const canfieldVariant = (draw: 1 | 3): VariantId => (draw === 1 ? 'canfield-draw1' : 'canfield')
export const golfVariant = (rankWrap: boolean): VariantId => (rankWrap ? 'golf-wrap' : 'golf')
export const tripeaksVariant = (rankWrap: boolean): VariantId => (rankWrap ? 'tripeaks-wrap' : 'tripeaks')
export const scorpionVariant = (assistedStock: boolean): VariantId => (assistedStock ? 'scorpion' : 'scorpion-classic')
export const fortyThievesVariant = (runMoves: boolean): VariantId => (runMoves ? 'fortythieves-runs' : 'fortythieves')
