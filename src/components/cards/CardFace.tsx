import React from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { CARD_FONT_FAMILY } from '@/components/useFontsPreload'
import { Card, cardColor, Rank, rankLabel } from '@/engine/types'

import { TableColors } from '../theme'
import { CourtRank } from './artwork/court'
import { CourtFigure } from './CourtFigure'
import { DecoratedCardFace } from './DecoratedCardFace'
import { DecoratedCourtFigure } from './DecoratedCourtFigure'
import { SuitPip } from './SuitPip'

function courtRankFor(rank: Rank): CourtRank | null {
  switch (rank) {
    case 11:
      return 'jack'
    case 12:
      return 'queen'
    case 13:
      return 'king'
    default:
      return null
  }
}

interface CardFaceProps {
  card: Card
  colors: TableColors
  width: number
  height: number
  /** Render as a colorless watermark (same faint neutral ink regardless of suit) rather than a
   * live card - e.g. the suit an empty foundation pile expects. Both styles drop their normal
   * opaque white/black card-frame background to transparent and tint their border/linework to
   * this same faint ink, so the watermark floats directly on whatever's behind it (e.g. an empty
   * foundation slot's own felt-colored backdrop) instead of reading as a solid card. Decorated
   * cards render their own actual per-suit/per-rank art this way (see DecoratedCardFace's `ink`
   * prop); compact's own full-colour court figures have no neutral form - their colour is baked
   * in, not tinted - so a muted compact court card falls back to CourtFigure's tintable
   * silhouette instead. */
  muted?: boolean
  /** 'decorated' renders the full-colour illustrated deck (DecoratedCardFace) instead of this
   * component's own compact corner-index + big-pip rendering. Defaults to 'compact'. */
  cardStyle?: 'compact' | 'decorated'
}

// Height of the top corner row, as a fraction of card width - the big pip below is
// positioned to start right after this, so it centers in the leftover space instead
// of the full card (which would skew it toward the top, under the corner row).
// Exported so PileView can derive its tableau fan overlap to clear this row with an even
// margin on both sides, rather than approximating it with an independently-tuned constant.
export const CORNER_ROW_FRACTION = 0.38
// Corner row's own inset from the card's top edge, as a fraction of card width rather than a
// fixed pixel value - keeps the row's bottom edge a consistent fraction of card height across
// viewport sizes, which PileView's tableau fan overlap relies on to clear it cleanly.
export const CORNER_ROW_TOP_FRACTION = 0.03
// Fixed width for the corner rank label, as a fraction of card width - wide enough to fit '10'
// (the only two-character rank) without crowding. Every rank centers within this same box rather
// than sizing to its own text width, so the suit pip beside it sits at a consistent x regardless
// of whether the rank above it is one or two characters.
const RANK_TEXT_WIDTH_FRACTION = 0.46
/** The vertical fan offset a face-up tableau card needs to clear the corner row of whatever's
 * stacked below it (see CORNER_ROW_FRACTION/CORNER_ROW_TOP_FRACTION above) - PileView's own resting
 * fan spacing, and the one every screen-level ghost's multi-card `offsetStep` must match exactly.
 * A ghost computing its own offset independently (e.g. from cardHeight and a fixed ratio) drifts
 * from this, since it isn't the same formula - the moving run then renders at a visibly different
 * spacing than the same cards get once they land and PileView takes back over. */
export function faceUpFanOffset(cardWidth: number): number {
  return cardWidth * (CORNER_ROW_FRACTION + 2 * CORNER_ROW_TOP_FRACTION)
}
// Court figures are cropped tight/edge-to-edge (see DecoratedCourtFigure), so they'd otherwise
// start flush with the top of the content area - right where a covered tableau card gets cut off
// by the next one - and reveal a sliver of the figure's own top edge instead of blank card
// background. Nudging the figure down (without shrinking it) clears that; the same amount then
// spills past the card's own bottom edge, which PlayingCard's overflow:hidden clips rather than
// visibly squeezing the art.
const COURT_TOP_INSET_FRACTION = 0.07

// How faint a muted card's ink reads - applied once to the whole card as a single flattened
// layer (RN `opacity` / SVG group `opacity`, see below), never baked into `color`/`ink` as a
// translucent hex. Both styles' ink is built from multiple overlapping shapes (e.g. a club pip's
// three lobes, DecoratedCardFace's linework) - a translucent fill color double-blends wherever
// those shapes overlap, reading darker/more opaque right at the overlap than the rest of the
// glyph. Compositing everything at full strength first and fading the result once avoids that.
const MUTED_OPACITY = 0.35

/**
 * The face-up content of a card: corner indices plus a single big suit pip.
 * Memoized for the same reason as its children (SuitPip) - `card`/`colors` are stable
 * references across unrelated re-renders (e.g. the per-second elapsed-time timer), so this can
 * safely skip re-rendering except when the card itself actually changes.
 *
 * Jack/Queen/King show a full-colour court figure (DecoratedCourtFigure) in place of the big suit
 * pip - or CourtFigure's tintable single-tone silhouette when muted, since the full-colour art has
 * no neutral form. Every other rank keeps the big pip.
 */
export const CardFace = React.memo(function CardFace({ card, colors, width, height, muted, cardStyle }: CardFaceProps) {
  const color = muted ? colors.textBlack : cardColor(card.suit) === 'red' ? colors.textRed : colors.textBlack
  const cornerRowHeight = width * CORNER_ROW_FRACTION
  const courtRank = courtRankFor(card.rank)

  if (cardStyle === 'decorated') {
    return <DecoratedCardFace card={card} width={width} height={height} ink={muted ? color : undefined} opacity={muted ? MUTED_OPACITY : undefined} />
  }

  return (
    <View
      style={{
        width,
        height,
        // The same baked-in white/black rounded-rect frame CardBack.tsx's geometric design and
        // DecoratedCardFace's own #base already draw - previously this relied entirely on
        // PlayingCard's own outer View for a backdrop (colors.cardFace, no border at all), which
        // is exactly what left it invisible-on-dark rather than a real card edge wherever that
        // outer View wasn't present (e.g. a bare preview swatch - see SettingsDialog.tsx). Content
        // layout below is unchanged - only the backdrop it sits on is new. Muted drops this to a
        // transparent fill with a `color`-tinted border instead, and fades the whole card
        // (border + content together, via `opacity`) as one flattened layer rather than a
        // translucent border/ink color - see MUTED_OPACITY above - so an empty foundation slot's
        // hint floats on its own felt-colored backdrop rather than sitting on an opaque white
        // card shape.
        backgroundColor: muted ? 'transparent' : '#FFFFFF',
        borderWidth: width * 0.02,
        borderColor: muted ? color : '#000000',
        borderRadius: width * 0.06,
        opacity: muted ? MUTED_OPACITY : undefined
      }}
    >
      {/* Rank (top-left) and suit (top-right) share one row, vertically centered against
          each other, rather than each being independently top-aligned - a Text glyph's
          box doesn't sit flush with its own top edge the way an SVG's does, so matching
          box tops still reads as uneven; centering the row is more forgiving. There's
          deliberately no mirrored bottom copy - these cards are never viewed upside down. */}
      <View style={[styles.cornerRow, { top: width * CORNER_ROW_TOP_FRACTION, left: -2, right: 3, height: cornerRowHeight }]}>
        <Text numberOfLines={1} style={[styles.rankText, { color, fontSize: width * 0.34, width: width * RANK_TEXT_WIDTH_FRACTION, letterSpacing: -width * 0.02 }]}>
          {rankLabel(card.rank)}
        </Text>
        <SuitPip suit={card.suit} color={color} size={width * 0.28} edgeFill />
      </View>

      {courtRank ? (
        <View style={{ position: 'absolute', left: 0, right: 0, top: cornerRowHeight + height * COURT_TOP_INSET_FRACTION }}>{muted ? <CourtFigure rank={courtRank} color={color} width={width} height={height - cornerRowHeight} /> : <DecoratedCourtFigure suit={card.suit} rank={courtRank} width={width} height={height - cornerRowHeight} />}</View>
      ) : (
        <View style={[styles.centerFill, { top: cornerRowHeight }]}>
          <SuitPip suit={card.suit} color={color} size={width * 0.74} />
        </View>
      )}
    </View>
  )
})

const styles = StyleSheet.create({
  centerFill: {
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0
  },
  cornerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    position: 'absolute',
    zIndex: 2
  },
  rankText: {
    fontFamily: CARD_FONT_FAMILY,
    fontWeight: '700',
    textAlign: 'center',
    userSelect: 'none'
  }
})
