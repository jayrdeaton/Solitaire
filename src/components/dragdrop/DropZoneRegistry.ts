import { RefObject, useState } from 'react'
import { View } from 'react-native'

import { PileRef } from '@/engine/gameTypes'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

function key(ref: PileRef): string {
  return `${ref.zone}:${ref.index}`
}

function measure(view: View): Promise<Rect | null> {
  return new Promise((resolve) => {
    view.measureInWindow((x, y, width, height) => {
      resolve(width === 0 && height === 0 ? null : { x, y, width, height })
    })
  })
}

/**
 * Tracks the on-screen rect of every pile/slot a card can be dropped on, keyed by PileRef.
 * Views register themselves (see DropZone.tsx) and re-measure live at drop time, so this
 * stays correct across scrolling, layout changes, and orientation changes.
 */
export class DropZoneRegistry {
  private zones = new Map<string, RefObject<View | null>>()

  register(ref: PileRef, view: RefObject<View | null>) {
    this.zones.set(key(ref), view)
  }

  unregister(ref: PileRef) {
    this.zones.delete(key(ref))
  }

  /** The registered zone's current on-screen rect (or null if unregistered/unmeasurable) - the same
   * per-zone measurement hitTest already does internally, exposed directly for a caller that already
   * knows which zone it wants (a deal computing a column's own container position analytically, for
   * instance) rather than needing to hit-test a point against every zone on the board. */
  async measure(ref: PileRef): Promise<Rect | null> {
    const view = this.zones.get(key(ref))?.current
    if (!view) return null
    return measure(view)
  }

  /** Find the registered zone (if any) whose current screen rect contains (x, y). */
  async hitTest(x: number, y: number): Promise<PileRef | null> {
    const entries = Array.from(this.zones.entries())
    const results = await Promise.all(
      entries.map(async ([k, ref]) => {
        const view = ref.current
        if (!view) return null
        const rect = await measure(view)
        if (!rect) return null
        const hit = x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
        return hit ? { k, area: rect.width * rect.height } : null
      })
    )
    const hits = results.filter((r): r is { k: string; area: number } => r !== null)
    if (hits.length === 0) return null
    // Prefer the smallest/most specific zone if more than one rect contains the point.
    hits.sort((a, b) => a.area - b.area)
    const [zone, index] = hits[0].k.split(':')
    return { zone, index: Number(index) }
  }
}

export function useDropZoneRegistry(): DropZoneRegistry {
  // A lazy useState initializer (not useRef) - it runs exactly once on mount, same as the old
  // ref-based lazy-init, but without mutating a ref during render (the setter is never called, so
  // this never actually re-renders).
  const [registry] = useState(() => new DropZoneRegistry())
  return registry
}
