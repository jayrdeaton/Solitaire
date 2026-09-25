// The home screen previews' design-space canvas and the layout helpers every game's previewLayout.ts places its cards
// with. Kept free of any runtime dependency (no settings store, no react-native-svg) so
// scripts/generate-card-face-bitmaps.mjs can bundle the layouts on their own - it pre-renders each preview's face-up
// cards. GamePreview.tsx re-exports all of it.
import { CARD_ASPECT } from '@tastic/cards'

import { Card } from '@/engine/types'

import { FACE_DOWN_OFFSET_RATIO, FACE_UP_OFFSET_RATIO } from './CardSizeContext'

/** Fixed seed every game's previewLayout.ts deals from, so the home screen's starting-deal
 * thumbnails are stable across app launches rather than reshuffling on every mount - these are
 * decoration, not a real game, so nothing ever advances or reshuffles them. */
export const PREVIEW_SEED = 7

// Canonical design-space canvas every game's previewLayout.ts places its cards into, in pixel
// coordinates. GamePreview scales this whole canvas down (via percentage-based positioning) to
// fit whatever width the home screen grid actually gives it - so every game's thumbnail uses the
// identical card size/proportions regardless of that game's own column count (Spider's 10 columns
// end up tighter than Klondike's 7, rather than Spider's cards shrinking to compensate).
export const PREVIEW_CANVAS_WIDTH = 360
export const PREVIEW_CANVAS_HEIGHT = 200
export const PREVIEW_CARD_WIDTH = 28
export const PREVIEW_CARD_HEIGHT = Math.round(PREVIEW_CARD_WIDTH / CARD_ASPECT)

export interface PreviewCardPlacement {
  /** Top-left corner, in PREVIEW_CANVAS_WIDTH/HEIGHT design-space pixels. */
  x: number
  y: number
  /** Omitted for a face-down card - only CardBack needs no card data to render. */
  card?: Card
  faceUp: boolean
}

/** Spreads `columns` left-to-right, evenly filling the full canvas width regardless of column
 * count, and fans each column straight down - face-down cards packed tighter than face-up ones,
 * mirroring PileView's own FACE_DOWN_OFFSET_RATIO/FACE_UP_OFFSET_RATIO so a tableau's silhouette
 * (which rows are still face-down at deal) reads the same in miniature as it does in the real
 * game. */
export function layoutColumns(columns: Card[][], top: number): PreviewCardPlacement[] {
  const n = columns.length
  if (n === 0) return []
  const gap = (PREVIEW_CANVAS_WIDTH - n * PREVIEW_CARD_WIDTH) / (n + 1)
  const placements: PreviewCardPlacement[] = []
  columns.forEach((col, i) => {
    const x = gap + i * (PREVIEW_CARD_WIDTH + gap)
    let y = top
    col.forEach((card) => {
      placements.push({ x, y, card, faceUp: card.faceUp })
      y += PREVIEW_CARD_HEIGHT * (card.faceUp ? FACE_UP_OFFSET_RATIO : FACE_DOWN_OFFSET_RATIO)
    })
  })
  return placements
}

/** A compact overlapping stack for a single-slot pile (stock/waste/reserve/a foundation/freecell)
 * - capped at 3 drawn layers regardless of the pile's real depth, since a literal card-per-layer
 * stack is illegible at thumbnail scale. Pass `cards` top-last (same convention as every pile in
 * this app - the last entry is what's actually showing). Currently unused - every game's preview
 * shows tableau only (see each previewLayout.ts), but kept for whichever game wants a pile shown
 * again. */
export function layoutStack(x: number, y: number, cards: Card[]): PreviewCardPlacement[] {
  if (cards.length === 0) return []
  const layers = Math.min(cards.length, 3)
  const placements: PreviewCardPlacement[] = []
  for (let i = 0; i < layers; i++) {
    const card = i === layers - 1 ? cards[cards.length - 1] : undefined
    const offset = i * 2
    placements.push({ x: x + offset, y: y - offset, card, faceUp: card?.faceUp ?? false })
  }
  return placements
}

/** Shifts a whole layout so its own vertical bounding box sits centered within the canvas -
 * every previewLayout.ts calls this as its final step, since none of them reserve a top row for
 * a stock/waste pile anymore (the previews show tableau only) and each game's tableau is a very
 * different natural height (Canfield's 1-card-deep columns vs. Yukon's 11-card ones). Without
 * this, every preview would just top-align, leaving the shorter ones looking sparse. */
export function centerVertically(placements: PreviewCardPlacement[]): PreviewCardPlacement[] {
  if (placements.length === 0) return placements
  const minY = Math.min(...placements.map((p) => p.y))
  const maxY = Math.max(...placements.map((p) => p.y + PREVIEW_CARD_HEIGHT))
  const offset = (PREVIEW_CANVAS_HEIGHT - (maxY - minY)) / 2 - minY
  return placements.map((p) => ({ ...p, y: p.y + offset }))
}
