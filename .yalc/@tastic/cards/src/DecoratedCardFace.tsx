import React from 'react'
import { StyleSheet, ViewStyle } from 'react-native'
import Svg, { G } from 'react-native-svg'

import { decoratedDeck } from './artwork/decoratedCustom'
import { buildColorOverrideMap, DecoratedPackColors } from './artwork/decoratedCustom/colors'
import { DecoratedArt, DecoratedShape } from './artwork/types'
import { MARGIN_FRACTION } from './CardBack'
import { renderDecoratedShape } from './DecoratedShapeRenderer'
import { Card, cardColor } from './types'

// The generated data's rank-corner text glyphs are hardcoded black regardless of suit (see
// renderDecoratedShape's `textFill` doc) - only hearts/diamonds need correcting, since black is
// already right for spades/clubs. #e6180a matches this same card's own already-correct pip fill
// (e.g. artwork/decorated/hearts.ts's big center pip), rather than the app's own `colors.textRed`,
// so the corrected corner digit reads as the same ink already on the card, not a second, different
// red sitting next to it.
const RANK_TEXT_RED = '#e6180a'

/**
 * Insets everything except the card's own #base border rect by MARGIN_FRACTION (the same
 * proportion CardBack.tsx's hand-drawn design uses for its own margin - see its own note) - the
 * sheet's whole-card art otherwise runs the corner index/pips right up to the border, unlike
 * DecoratedCardBack's sheet-derived backs, whose body already carries its own natural margin from
 * base (see DecoratedCardBack.tsx's own note). Every rank's `shapes` is exactly one wrapping
 * `<g transform="translate(...)">` (the sheet's own per-card offset back into this card's local
 * 0..viewBox space) whose children are, in order, that border followed by the rest of the card -
 * confirmed structurally across every rank, ace through king. The border keeps that transform
 * applied on its own, unchanged (drawn at natural, flush size); the rest gets a *second* copy of
 * the same transform nested *inside* the margin's own scale/translate, so the inset happens in the
 * card's final 0..viewBox space (where MARGIN_FRACTION*viewBox-width means what it says) rather
 * than whatever arbitrary intermediate space the sheet's own per-card offset starts from.
 */
function insetContent(art: DecoratedArt): DecoratedShape {
  const outer = art.shapes[0]
  if (outer.tag !== 'g') return outer // can't happen - see doc comment above; satisfies narrowing
  const [border, ...content] = outer.children
  const [, , vw, vh] = art.viewBox
  const margin = vw * MARGIN_FRACTION
  const scaleX = (vw - margin * 2) / vw
  const scaleY = (vh - margin * 2) / vh
  return {
    tag: 'g',
    children: [
      { tag: 'g', transform: outer.transform, children: [border] },
      {
        tag: 'g',
        transform: `translate(${margin},${margin}) scale(${scaleX},${scaleY})`,
        children: [{ tag: 'g', transform: outer.transform, children: content }]
      }
    ]
  }
}

interface DecoratedCardFaceProps {
  card: Card
  width: number
  height: number
  /** Recolors every non-white shape in the art to this one flat, fully-opaque color - for a
   * muted "watermark" render of the actual per-suit/per-rank art, rather than CardFace's generic
   * tintable pip/CourtFigure silhouette. Pair with `opacity` (below) rather than passing a
   * translucent color here. Omit to render the art's own baked-in colors. */
  ink?: string
  /** Fades the whole recolored card as one flattened layer (a single <G opacity>, applied after
   * every `ink`-recolored shape is composited together) rather than per-shape alpha - the art's
   * ink shapes often overlap (e.g. a club's three lobes), and per-shape alpha would double-blend
   * those overlaps, reading darker/more opaque there than the rest of the glyph. */
  opacity?: number
  /** Substitutes named colors from the baked art (see artwork/decoratedCustom/colors.ts) for the
   * "invert dark mode colors" setting - e.g. `{ inkBlack: '#F2F2F2', cardWhite: '#1A1A1A' }`.
   * Omit to render the pack's own default colors unchanged. Ignored whenever `ink` is set (a muted
   * watermark render already recolors everything to one flat tone). */
  colorOverrides?: Partial<DecoratedPackColors>
}

/**
 * The "decorated" card style: full-colour illustrated card art (see artwork/decoratedCustom/ - a
 * relabeled duplicate of artwork/decorated/, see generate-decorated-custom-pack.mjs). Colour is
 * baked into the art itself, unlike CardFace's compact style which tints a shared silhouette by
 * suit - so unlike CardFace's own `color` prop, this can't be tinted to an arbitrary suit color,
 * only forced to a single flat `ink` for muting, or selectively recolored via `colorOverrides`.
 */
export const DecoratedCardFace = React.memo(function DecoratedCardFace({ card, width, height, ink, opacity, colorOverrides }: DecoratedCardFaceProps) {
  const art = decoratedDeck[card.suit][card.rank]
  const [vx, vy, vw, vh] = art.viewBox
  const idPrefix = React.useId()
  const textFill = cardColor(card.suit) === 'red' ? RANK_TEXT_RED : undefined
  const valueOverrides = buildColorOverrideMap(colorOverrides)

  return (
    <Svg width={width} height={height} viewBox={`${vx} ${vy} ${vw} ${vh}`} style={styles.svg}>
      <G opacity={opacity}>{renderDecoratedShape(insetContent(art), 0, idPrefix, ink, textFill, valueOverrides)}</G>
    </Svg>
  )
})

// `userSelect` only exists on RN's own TextStyle, not ViewStyle - and Svg's own `style` prop is
// typed StyleProp<ViewStyle>. It's real on web (react-native-web renders Svg as an actual DOM
// <svg>, where this stops the card's own artwork from being text-selectable) and a harmless no-op
// on native. Needs its own explicit type here, since plain ViewStyle doesn't include it and
// TypeScript's "weak type" check rejects an object sharing zero properties with an all-optional
// target type otherwise.
const svgStyle: ViewStyle & { userSelect?: 'none' } = { userSelect: 'none' }

const styles = StyleSheet.create({
  svg: svgStyle
})
