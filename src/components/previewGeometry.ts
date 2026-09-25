import type { PreviewCardPlacement } from './previewCanvas'

/** Design-space constants shared with GamePreview (kept here so this module stays a pure, dependency-light
 * function of the placements). */
export interface PreviewMetrics {
  cardWidth: number
  cardHeight: number
}

/** A rounded rectangle as path data - every corner rounded, or only the top two (for a strip whose bottom edge is
 * hidden under the next card, so the covered corners must stay square to leave no wedge of felt showing). */
export function roundedRectPath(x: number, y: number, w: number, h: number, r: number, topOnly: boolean): string {
  const rr = Math.min(r, w / 2, h)
  const bottom = topOnly ? `L${x + w} ${y + h} L${x} ${y + h}` : `L${x + w} ${y + h - rr} A${rr} ${rr} 0 0 1 ${x + w - rr} ${y + h} L${x + rr} ${y + h} A${rr} ${rr} 0 0 1 ${x} ${y + h - rr}`
  return `M${x + rr} ${y} L${x + w - rr} ${y} A${rr} ${rr} 0 0 1 ${x + w} ${y + rr} ${bottom} L${x} ${y + rr} A${rr} ${rr} 0 0 1 ${x + rr} ${y} Z`
}

export interface PreviewStyleConstants {
  cardRadius: number
  /** Inset of a face-down card's frame from its edge (the frame is stroked, so the rect sits half a stroke inside). */
  backFrame: number
}

const EPS = 0.01

/**
 * Whether every card's visible part is exactly its top strip down to the next card in the SAME column (or the
 * whole card, for the last one) - i.e. no two cards overlap sideways, and overlapping cards stack in draw order
 * (later = lower). That is what lets every back be merged into one stroked path: with strips, no back's frame is
 * drawn across another's. Pyramid/TriPeaks (staggered rows that overlap in both
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

/** Every face-down card's visible strip, merged into one path (the face-up cards are GamePreview's pre-rendered image,
 * drawn over this), or null if the layout isn't strip-safe. */
export function buildBackStrips(placements: PreviewCardPlacement[], m: PreviewMetrics, s: PreviewStyleConstants): string | null {
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

  const backs: string[] = []
  for (const p of placements) {
    if (p.faceUp && p.card) continue
    const next = nextBelow.get(p)
    const covered = !!next && next.y - p.y < m.cardHeight - EPS
    const visibleH = covered ? next!.y - p.y : m.cardHeight
    const inset = s.backFrame / 2
    backs.push(roundedRectPath(p.x + inset, p.y + inset, m.cardWidth - s.backFrame, Math.max(visibleH - s.backFrame, 0.5), s.cardRadius, covered))
  }
  return backs.join(' ')
}
