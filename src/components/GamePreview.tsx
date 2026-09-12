import { CardBack, CardFace, type TableColors } from '@tastic/cards'
import React from 'react'
import { LayoutChangeEvent, StyleSheet, View, ViewStyle } from 'react-native'

import { Card } from '@/engine/types'
import { useSettings } from '@/stores/settings'

import { FACE_DOWN_OFFSET_RATIO, FACE_UP_OFFSET_RATIO } from './CardSizeContext'
import { CARD_HEIGHT, CARD_WIDTH } from './theme'

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
export const PREVIEW_CARD_HEIGHT = Math.round((PREVIEW_CARD_WIDTH * CARD_HEIGHT) / CARD_WIDTH)

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

interface GamePreviewProps {
  placements: PreviewCardPlacement[]
  colors: TableColors
  style?: ViewStyle
}

/** Renders a small, static, non-interactive snapshot of a game's starting deal for the home
 * screen's game list - real card art at a fixed miniature size, laid out per-game by each game's
 * own previewLayout.ts (built from that game's own newGame(PREVIEW_SEED), so it can never drift
 * out of sync with how the game actually deals). */
export function GamePreview({ placements, colors, style }: GamePreviewProps) {
  const { settings } = useSettings()
  // Home's one call site always passes a fixed pixel `width` (see index.tsx's `preview` style) -
  // seeding from it lets card art render in this component's very first frame instead of always
  // waiting on a native onLayout round-trip, which otherwise guarantees at least one empty/green
  // frame before any cards can appear, no matter how fast the device is. Falls back to the old
  // onLayout-measured 0 (and the loading gate below) if a future caller passes a percentage/flex
  // width instead, where the pixel width genuinely isn't knowable up front.
  const initialWidth = React.useMemo(() => {
    const flat = StyleSheet.flatten(style)
    return typeof flat?.width === 'number' ? flat.width : 0
  }, [style])
  const [canvasWidth, setCanvasWidth] = React.useState(initialWidth)
  const onLayout = React.useCallback((e: LayoutChangeEvent) => setCanvasWidth(e.nativeEvent.layout.width), [])
  // Card art needs real pixel width/height (it sizes an inner SVG viewBox, not a percentage) -
  // only known once the canvas itself has been laid out once, hence the empty first frame.
  const cardWidth = (canvasWidth * PREVIEW_CARD_WIDTH) / PREVIEW_CANVAS_WIDTH
  const cardHeight = (canvasWidth * PREVIEW_CARD_HEIGHT) / PREVIEW_CANVAS_WIDTH

  return (
    <View onLayout={onLayout} style={[styles.canvas, style]}>
      {canvasWidth > 0 &&
        placements.map((p, i) => (
          <View
            key={i}
            style={[
              styles.cardWrap,
              {
                height: `${(PREVIEW_CARD_HEIGHT / PREVIEW_CANVAS_HEIGHT) * 100}%`,
                left: `${(p.x / PREVIEW_CANVAS_WIDTH) * 100}%`,
                top: `${(p.y / PREVIEW_CANVAS_HEIGHT) * 100}%`,
                width: `${(PREVIEW_CARD_WIDTH / PREVIEW_CANVAS_WIDTH) * 100}%`
              }
            ]}
          >
            {p.faceUp && p.card ? <CardFace card={p.card} colors={colors} width={cardWidth} height={cardHeight} cardStyle={settings.cardStyle} invertDarkModeColors={settings.invertDarkModeColors} /> : <CardBack colors={colors} width={cardWidth} height={cardHeight} invertDarkModeColors={settings.invertDarkModeColors} />}
          </View>
        ))}
    </View>
  )
}

const styles = StyleSheet.create({
  canvas: {
    aspectRatio: PREVIEW_CANVAS_WIDTH / PREVIEW_CANVAS_HEIGHT,
    overflow: 'hidden',
    position: 'relative',
    width: '100%'
  },
  cardWrap: {
    borderRadius: 2,
    overflow: 'hidden',
    position: 'absolute'
  }
})
