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

// A tile's design-space canvas (its aspect ratio, and the units PREVIEW_MARGIN is in) and the card size every
// previewLayout.ts lays its cards out at. A layout is not placed in the canvas: previewFrame picks the part of its space
// a tile shows, so each game's cards fill the tile the way its own board fills the screen (Spider's 10 columns get
// narrower cards than Klondike's 7, as in the games). GamePreview scales the canvas to whatever width Home gives it.
export const PREVIEW_CANVAS_WIDTH = 360
export const PREVIEW_CANVAS_HEIGHT = 200
export const PREVIEW_CARD_WIDTH = 28
export const PREVIEW_CARD_HEIGHT = Math.round(PREVIEW_CARD_WIDTH / CARD_ASPECT)

export interface PreviewCardPlacement {
  /** Top-left corner, in the layout's own units (a card is PREVIEW_CARD_WIDTH x PREVIEW_CARD_HEIGHT). */
  x: number
  y: number
  /** Omitted for a face-down card - only CardBack needs no card data to render. */
  card?: Card
  faceUp: boolean
}

/** The gap between neighbouring columns (and Pyramid/TriPeaks cells), in the same units as PREVIEW_CARD_WIDTH: the
 * real boards' CARD_GAP_MIN (2pt) beside a phone-sized card (~48pt), so a thumbnail's columns sit as close together as
 * the game's own. */
export const PREVIEW_GAP = PREVIEW_CARD_WIDTH * 0.04

/** Empty felt kept round a preview's cards, in canvas units (the tile has rounded corners). */
export const PREVIEW_MARGIN = 10

/** Lays `columns` out left-to-right PREVIEW_GAP apart, as the real tableau does, and fans each column straight down -
 * face-down cards packed tighter than face-up ones, mirroring PileView's own FACE_DOWN_OFFSET_RATIO/FACE_UP_OFFSET_RATIO
 * so a tableau's silhouette (which rows are still face-down at deal) reads the same in miniature as it does in the real
 * game. Not fitted to the canvas: previewFrame zooms each tile onto its own cards. */
export function layoutColumns(columns: Card[][]): PreviewCardPlacement[] {
  const placements: PreviewCardPlacement[] = []
  columns.forEach((col, i) => {
    const x = i * (PREVIEW_CARD_WIDTH + PREVIEW_GAP)
    let y = 0
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

export interface PreviewFrame {
  x: number
  y: number
  width: number
  height: number
}

/** The part of a layout's own space a tile shows: the cards' bounding box plus PREVIEW_MARGIN, grown along one axis to
 * the canvas's aspect ratio and centred, so every tile zooms onto its deal (the cards as large as the tile allows, the
 * same size relative to their gaps as in the game) whatever its column count or depth. GamePreview uses it as the
 * Svg's viewBox and the generator draws the face layer through it, so the two layers always line up. */
export function previewFrame(placements: PreviewCardPlacement[]): PreviewFrame {
  if (placements.length === 0) return { x: 0, y: 0, width: PREVIEW_CANVAS_WIDTH, height: PREVIEW_CANVAS_HEIGHT }
  const minX = Math.min(...placements.map((p) => p.x))
  const minY = Math.min(...placements.map((p) => p.y))
  const maxX = Math.max(...placements.map((p) => p.x + PREVIEW_CARD_WIDTH))
  const maxY = Math.max(...placements.map((p) => p.y + PREVIEW_CARD_HEIGHT))
  // One layout unit per canvas unit once fitted: the margin is scale-independent only if it's added after the fit.
  const scale = Math.min((PREVIEW_CANVAS_WIDTH - 2 * PREVIEW_MARGIN) / (maxX - minX), (PREVIEW_CANVAS_HEIGHT - 2 * PREVIEW_MARGIN) / (maxY - minY))
  const width = PREVIEW_CANVAS_WIDTH / scale
  const height = PREVIEW_CANVAS_HEIGHT / scale
  return { x: (minX + maxX - width) / 2, y: (minY + maxY - height) / 2, width, height }
}
