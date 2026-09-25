import { type TableColors } from '@tastic/cards'
import React from 'react'
import { Image, StyleSheet, View, ViewStyle } from 'react-native'
import { useTheme } from 'react-native-paper'
import Svg, { Path, Rect } from 'react-native-svg'

import { useSettings } from '@/stores/settings'

import { PREVIEW_CANVAS_HEIGHT, PREVIEW_CANVAS_WIDTH, PREVIEW_CARD_HEIGHT, PREVIEW_CARD_WIDTH, type PreviewCardPlacement } from './previewCanvas'
import { PREVIEW_FACE_BITMAPS, type PreviewGame } from './previewFaceBitmaps'
import { buildBackStrips } from './previewGeometry'

export * from './previewCanvas'

interface GamePreviewProps {
  /** Which game's pre-rendered face layer to draw (previewFaceBitmaps.ts) - it must be the layout `placements` is. */
  game: PreviewGame
  placements: PreviewCardPlacement[]
  colors: TableColors
  style?: ViewStyle
}

const CARD_RX = 2.6
const BACK_FRAME = 1.4

const METRICS = { cardWidth: PREVIEW_CARD_WIDTH, cardHeight: PREVIEW_CARD_HEIGHT }
const STYLE_CONSTANTS = { cardRadius: CARD_RX, backFrame: BACK_FRAME }

// Theme-independent, so built once per placements array (each game's is a module-level constant on Home) and
// reused for every theme change, re-render and remount.
const backStripsCache = new WeakMap<PreviewCardPlacement[], string | null>()
function backStripsFor(placements: PreviewCardPlacement[]): string | null {
  if (!backStripsCache.has(placements)) backStripsCache.set(placements, buildBackStrips(placements, METRICS, STYLE_CONSTANTS))
  return backStripsCache.get(placements) ?? null
}

/** Renders a small, static, non-interactive snapshot of a game's starting deal for the home
 * screen's game list, laid out per-game by each game's own previewLayout.ts (built from that game's
 * own newGame(PREVIEW_SEED), so it can never drift out of sync with how the game actually deals).
 *
 * Two layers. The face-up cards are ONE pre-rendered Image per tile (previewFaceBitmaps.ts, drawn by the real
 * CardFace in the chosen card style and ink by scripts/generate-card-face-bitmaps.mjs, transparent everywhere else).
 * Under it, the face-down cards are live SVG - a plain back in the active profile's card-back colour with a
 * face-coloured frame - since that colour is a runtime choice no image can bake in (a tint would flatten the frame
 * too). The generator fails if a layout ever paints a back ABOVE a face, which two layers could not draw.
 *
 * Why not the real CardFace/CardBack per card: a menu of eleven decks is ~370 cards drawn about 7pt wide - the live art
 * was ~12k native views (1.3-1.5s of blocked JS thread in a production bundle every time Home mounted), and even one
 * card Image each would be ~370 views. Here a column layout's backs are merged into one Path by drawing only each
 * back's VISIBLE strip (see previewGeometry.ts), and Pyramid/TriPeaks (overlapping, not strip-safe) draw a Rect per
 * back - so a tile is a View, an Svg, a Path or a few Rects, and an Image. The Svg scales its own viewBox, so the very
 * first frame already shows cards.
 *
 * Memoized: `placements` are module-level constants and `colors` is a stable reference until the theme
 * changes, so an unrelated Home re-render (a setting, a profile change) never re-walks eleven decks. */
export const GamePreview = React.memo(function GamePreview({ game, placements, colors, style }: GamePreviewProps) {
  const { settings } = useSettings()
  const { dark } = useTheme()
  const invert = settings.invertDarkModeColors
  const frame = invert ? colors.cardFaceInverted : '#FFFFFF'
  const backStrips = backStripsFor(placements)
  const faces = PREVIEW_FACE_BITMAPS[game][settings.cardStyle][invert && dark ? 'invert' : 'normal']

  return (
    <View style={[styles.canvas, style]}>
      <Svg width='100%' height='100%' viewBox={`0 0 ${PREVIEW_CANVAS_WIDTH} ${PREVIEW_CANVAS_HEIGHT}`}>
        {backStrips !== null ? backStrips !== '' && <Path d={backStrips} fill={colors.cardBack} stroke={frame} strokeWidth={BACK_FRAME} /> : placements.map((p, i) => (p.faceUp && p.card ? null : <Rect key={i} x={p.x + BACK_FRAME / 2} y={p.y + BACK_FRAME / 2} width={PREVIEW_CARD_WIDTH - BACK_FRAME} height={PREVIEW_CARD_HEIGHT - BACK_FRAME} rx={CARD_RX} fill={colors.cardBack} stroke={frame} strokeWidth={BACK_FRAME} />))}
      </Svg>
      {/* Only once the tile has cards: Home passes [] for its first frame (previewsRevealed) to keep that commit light. */}
      {placements.length > 0 && <Image source={faces} style={styles.faces} resizeMode='stretch' />}
    </View>
  )
})

const styles = StyleSheet.create({
  canvas: {
    aspectRatio: PREVIEW_CANVAS_WIDTH / PREVIEW_CANVAS_HEIGHT,
    overflow: 'hidden',
    position: 'relative',
    width: '100%'
  },
  faces: {
    height: '100%',
    left: 0,
    position: 'absolute',
    top: 0,
    width: '100%'
  }
})
