import type { Suit } from '@tastic/cards'

import type { PreviewCardPlacement } from './GamePreview'

/** Design-space constants shared with GamePreview (kept here so this module stays a pure, dependency-light
 * function of the placements - GamePreview imports the geometry, never the other way round at runtime). */
export interface PreviewMetrics {
  cardWidth: number
  cardHeight: number
}

// Suit pips, drawn in a 10x10 box, expressed only with absolute M/L/C/Z so they can be scaled and translated
// straight into path data (see transformPath) - a merged Path has no per-pip transform.
function circle(cx: number, cy: number, r: number): string {
  const k = 0.5523 * r
  return `M${cx + r} ${cy} C${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} C${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} C${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} C${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} Z`
}

export const SUIT_PIP_PATHS: Record<Suit, string> = {
  hearts: 'M5 9.2 C1 6 0.2 4.2 0.2 2.9 C0.2 1.4 1.4 0.6 2.7 0.6 C3.8 0.6 4.6 1.2 5 2 C5.4 1.2 6.2 0.6 7.3 0.6 C8.6 0.6 9.8 1.4 9.8 2.9 C9.8 4.2 9 6 5 9.2 Z',
  diamonds: 'M5 0.4 L9.2 5 L5 9.6 L0.8 5 Z',
  spades: 'M5 0.4 C5 0.4 0.4 3.8 0.4 6.3 C0.4 7.9 1.7 8.6 2.8 8.2 C3.5 7.9 4.1 7.5 4.3 7 C4.3 8.5 3.9 9.2 3.1 9.7 L6.9 9.7 C6.1 9.2 5.7 8.5 5.7 7 C5.9 7.5 6.5 7.9 7.2 8.2 C8.3 8.6 9.6 7.9 9.6 6.3 C9.6 3.8 5 0.4 5 0.4 Z',
  clubs: `${circle(5, 2.7, 2.3)} ${circle(2.5, 6.3, 2.3)} ${circle(7.5, 6.3, 2.3)} M4.6 6 L3.9 9.7 L6.1 9.7 L5.4 6 Z`
}

/** Scales then translates every coordinate of an absolute M/L/C/Z path. */
export function transformPath(d: string, scale: number, dx: number, dy: number): string {
  let axis = 0
  return d.replace(/[MLCZ]|-?\d*\.?\d+/g, (token) => {
    if (/[MLCZ]/.test(token)) {
      axis = 0
      return token
    }
    const value = parseFloat(token)
    const out = (value * scale + (axis % 2 === 0 ? dx : dy)).toFixed(2)
    axis++
    return out
  })
}

/** A rounded rectangle as path data - every corner rounded, or only the top two (for a strip whose bottom edge is
 * hidden under the next card, so the covered corners must stay square to leave no wedge of felt showing). */
export function roundedRectPath(x: number, y: number, w: number, h: number, r: number, topOnly: boolean): string {
  const rr = Math.min(r, w / 2, h)
  const bottom = topOnly ? `L${x + w} ${y + h} L${x} ${y + h}` : `L${x + w} ${y + h - rr} A${rr} ${rr} 0 0 1 ${x + w - rr} ${y + h} L${x + rr} ${y + h} A${rr} ${rr} 0 0 1 ${x} ${y + h - rr}`
  return `M${x + rr} ${y} L${x + w - rr} ${y} A${rr} ${rr} 0 0 1 ${x + w} ${y + rr} ${bottom} L${x} ${y + rr} A${rr} ${rr} 0 0 1 ${x + rr} ${y} Z`
}

export interface MergedPreview {
  kind: 'merged'
  /** Visible strips of face-up cards (one path, one fill+stroke). */
  faces: string
  /** Visible strips of face-down cards. */
  backs: string
  /** Medallion diamonds of the (fully visible) face-down cards. */
  medallions: string
  redPips: string
  blackPips: string
}

export interface PerCardPreview {
  kind: 'cards'
}

export interface PreviewStyleConstants {
  cardRadius: number
  /** Inset of a face-down card's frame from its edge (the frame is stroked, so the rect sits half a stroke inside). */
  backFrame: number
  pipScale: number
  pipInsetX: number
  pipInsetY: number
  medallionHalf: number
}

const EPS = 0.01

/**
 * Whether every card's visible part is exactly its top strip down to the next card in the SAME column (or the
 * whole card, for the last one) - i.e. no two cards overlap sideways, and overlapping cards stack in draw order
 * (later = lower). That is what lets a whole tile be merged into a few paths: with strips, nothing overlaps, so
 * the paint order between shapes no longer matters. Pyramid/TriPeaks (staggered rows that overlap in both
 * axes) are not strip-safe and stay per-card.
 */
export function isStripSafe(placements: PreviewCardPlacement[], m: PreviewMetrics): boolean {
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      const a = placements[i]
      const b = placements[j]
      const dx = Math.abs(a.x - b.x)
      const dy = b.y - a.y
      const overlaps = dx < m.cardWidth - EPS && Math.abs(dy) < m.cardHeight - EPS
      if (!overlaps) continue
      // Overlapping cards must be the same column, with the later one below.
      if (dx > EPS || dy <= EPS) return false
    }
  }
  return true
}

/** Builds the merged paths, or null if the layout isn't strip-safe. */
export function buildMergedPreview(placements: PreviewCardPlacement[], m: PreviewMetrics, s: PreviewStyleConstants): MergedPreview | null {
  if (!isStripSafe(placements, m)) return null

  // Next card below each placement, in its own column.
  const nextBelow = new Map<PreviewCardPlacement, PreviewCardPlacement>()
  const columns = new Map<string, PreviewCardPlacement[]>()
  for (const p of placements) {
    const key = p.x.toFixed(2)
    const col = columns.get(key)
    if (col) col.push(p)
    else columns.set(key, [p])
  }
  columns.forEach((col) => {
    col.sort((a, b) => a.y - b.y)
    for (let i = 0; i < col.length - 1; i++) nextBelow.set(col[i], col[i + 1])
  })

  const faces: string[] = []
  const backs: string[] = []
  const medallions: string[] = []
  const red: string[] = []
  const black: string[] = []

  for (const p of placements) {
    const next = nextBelow.get(p)
    const covered = !!next && next.y - p.y < m.cardHeight - EPS
    const visibleH = covered ? next!.y - p.y : m.cardHeight
    if (p.faceUp && p.card) {
      faces.push(roundedRectPath(p.x, p.y, m.cardWidth, visibleH, s.cardRadius, covered))
      const pip = transformPath(SUIT_PIP_PATHS[p.card.suit], s.pipScale, p.x + s.pipInsetX, p.y + s.pipInsetY)
      const isRed = p.card.suit === 'hearts' || p.card.suit === 'diamonds'
      ;(isRed ? red : black).push(pip)
    } else {
      const inset = s.backFrame / 2
      backs.push(roundedRectPath(p.x + inset, p.y + inset, m.cardWidth - s.backFrame, Math.max(visibleH - s.backFrame, 0.5), s.cardRadius, covered))
      if (!covered) {
        const cx = p.x + m.cardWidth / 2
        const cy = p.y + m.cardHeight / 2
        const h = s.medallionHalf
        medallions.push(`M${cx} ${cy - h} L${cx + h} ${cy} L${cx} ${cy + h} L${cx - h} ${cy} Z`)
      }
    }
  }

  return { kind: 'merged', faces: faces.join(' '), backs: backs.join(' '), medallions: medallions.join(' '), redPips: red.join(' '), blackPips: black.join(' ') }
}
