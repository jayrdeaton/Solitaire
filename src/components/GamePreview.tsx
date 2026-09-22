import { cardColor, type TableColors } from '@tastic/cards'
import React from 'react'
import { StyleSheet, View, ViewStyle } from 'react-native'
import Svg, { Path, Rect } from 'react-native-svg'

import { Card } from '@/engine/types'
import { useSettings } from '@/stores/settings'

import { FACE_DOWN_OFFSET_RATIO, FACE_UP_OFFSET_RATIO } from './CardSizeContext'
import { buildMergedPreview, type MergedPreview, SUIT_PIP_PATHS } from './previewGeometry'
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

const PIP_SCALE = 0.85
const PIP_INSET_X = 3.2
// Small enough that a pip sits entirely inside the strip of a covered face-up card (FACE_UP_OFFSET_RATIO of the
// card's height, ~12.7 design units) - the strip is all that shows of a card once the next one overlaps it.
const PIP_INSET_Y = 1.8
const CARD_RX = 2.6
const BACK_FRAME = 1.4
const BACK_MEDALLION_HALF = 6
// One diamond in the middle of a back - just enough of the real back's medallion to read as "the same card back".
const BACK_MEDALLION = `M${PREVIEW_CARD_WIDTH / 2} ${PREVIEW_CARD_HEIGHT / 2 - BACK_MEDALLION_HALF} L${PREVIEW_CARD_WIDTH / 2 + BACK_MEDALLION_HALF} ${PREVIEW_CARD_HEIGHT / 2} L${PREVIEW_CARD_WIDTH / 2} ${PREVIEW_CARD_HEIGHT / 2 + BACK_MEDALLION_HALF} L${PREVIEW_CARD_WIDTH / 2 - BACK_MEDALLION_HALF} ${PREVIEW_CARD_HEIGHT / 2} Z`

const METRICS = { cardWidth: PREVIEW_CARD_WIDTH, cardHeight: PREVIEW_CARD_HEIGHT }
const STYLE_CONSTANTS = { cardRadius: CARD_RX, backFrame: BACK_FRAME, pipScale: PIP_SCALE, pipInsetX: PIP_INSET_X, pipInsetY: PIP_INSET_Y, medallionHalf: BACK_MEDALLION_HALF }

// Theme-independent, so built once per placements array (each game's is a module-level constant on Home) and
// reused for every theme change, re-render and remount.
const mergedCache = new WeakMap<PreviewCardPlacement[], MergedPreview | null>()
function mergedFor(placements: PreviewCardPlacement[]): MergedPreview | null {
  if (!mergedCache.has(placements)) mergedCache.set(placements, buildMergedPreview(placements, METRICS, STYLE_CONSTANTS))
  return mergedCache.get(placements) ?? null
}

/** Renders a small, static, non-interactive snapshot of a game's starting deal for the home
 * screen's game list, laid out per-game by each game's own previewLayout.ts (built from that game's
 * own newGame(PREVIEW_SEED), so it can never drift out of sync with how the game actually deals).
 *
 * Drawn as ONE Svg per tile - deliberately NOT the real @tastic/cards CardFace/CardBack. Those are the
 * full-detail cards used in play (court-card figures alone are ~200KB of SVG path text each), and a menu of
 * eleven such decks is ~370 of them drawn about 7pt wide: several thousand native nodes and megabytes of path
 * strings, which measured at 1.3-1.5s of blocked JS thread on a fast Mac in a production bundle (2.6s in dev)
 * every time Home was mounted. At this size no rank or figure is legible anyway, so this keeps everything that
 * is (the face/back split, suit colors, the theme's card-back color, invert-dark-mode) at a small fraction of the
 * cost. Every react-native-svg element is a real native view, so node count is what matters: a column layout
 * (everything but Pyramid/TriPeaks) is merged into at most five Paths by drawing only each card's VISIBLE strip
 * (see previewGeometry.ts - with strips nothing overlaps, so shapes of the same kind can share one Path), while
 * the two overlapping layouts draw a Rect (+ pip Path) per card. Also needs no onLayout round trip: the Svg
 * scales its own viewBox to whatever size the tile gives it, so the very first frame already shows cards.
 *
 * Memoized: `placements` are module-level constants and `colors` is a stable reference until the theme
 * changes, so an unrelated Home re-render (a setting, a profile change) never re-walks eleven decks. */
export const GamePreview = React.memo(function GamePreview({ placements, colors, style }: GamePreviewProps) {
  const { settings } = useSettings()
  const invert = settings.invertDarkModeColors
  const faceFill = invert ? colors.cardFaceInverted : '#FFFFFF'
  const faceStroke = invert ? colors.textBlackInverted : '#000000'
  const blackInk = invert ? colors.textBlackInverted : colors.textBlack
  const patternColor = invert ? colors.cardBackPatternInverted : colors.cardBackPattern
  const merged = mergedFor(placements)

  return (
    <View style={[styles.canvas, style]}>
      <Svg width='100%' height='100%' viewBox={`0 0 ${PREVIEW_CANVAS_WIDTH} ${PREVIEW_CANVAS_HEIGHT}`}>
        {merged ? (
          <>
            {merged.backs !== '' && <Path d={merged.backs} fill={colors.cardBack} stroke={faceFill} strokeWidth={BACK_FRAME} />}
            {merged.medallions !== '' && <Path d={merged.medallions} fill={patternColor} opacity={0.6} />}
            {merged.faces !== '' && <Path d={merged.faces} fill={faceFill} stroke={faceStroke} strokeWidth={0.8} />}
            {merged.redPips !== '' && <Path d={merged.redPips} fill={colors.textRed} />}
            {merged.blackPips !== '' && <Path d={merged.blackPips} fill={blackInk} />}
          </>
        ) : (
          placements.map((p, i) =>
            p.faceUp && p.card ? (
              <React.Fragment key={i}>
                <Rect x={p.x} y={p.y} width={PREVIEW_CARD_WIDTH} height={PREVIEW_CARD_HEIGHT} rx={CARD_RX} fill={faceFill} stroke={faceStroke} strokeWidth={0.8} />
                <Path d={SUIT_PIP_PATHS[p.card.suit]} transform={`translate(${p.x + PIP_INSET_X} ${p.y + PIP_INSET_Y}) scale(${PIP_SCALE})`} fill={cardColor(p.card.suit) === 'red' ? colors.textRed : blackInk} />
              </React.Fragment>
            ) : (
              <React.Fragment key={i}>
                <Rect x={p.x + BACK_FRAME / 2} y={p.y + BACK_FRAME / 2} width={PREVIEW_CARD_WIDTH - BACK_FRAME} height={PREVIEW_CARD_HEIGHT - BACK_FRAME} rx={CARD_RX} fill={colors.cardBack} stroke={faceFill} strokeWidth={BACK_FRAME} />
                <Path d={BACK_MEDALLION} transform={`translate(${p.x} ${p.y})`} fill={patternColor} opacity={0.6} />
              </React.Fragment>
            )
          )
        )}
      </Svg>
    </View>
  )
})

const styles = StyleSheet.create({
  canvas: {
    aspectRatio: PREVIEW_CANVAS_WIDTH / PREVIEW_CANVAS_HEIGHT,
    overflow: 'hidden',
    position: 'relative',
    width: '100%'
  }
})
