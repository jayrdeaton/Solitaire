import { RefObject, useState } from 'react'
import { View } from 'react-native'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

function measure(view: View): Promise<Rect | null> {
  return new Promise((resolve) => {
    view.measureInWindow((x, y, width, height) => {
      resolve(width === 0 && height === 0 ? null : { x, y, width, height })
    })
  })
}

/**
 * Tracks the on-screen rect of every currently-rendered card, keyed by card id. Cards register
 * themselves on mount/unmount (see DraggableCard.tsx/PileView.tsx). Unlike DropZoneRegistry (which
 * tracks stable pile containers), a card's registered view changes identity every time it moves to
 * a different pile - React mounts a fresh component in the new location rather than reusing the
 * old one - so `measure(id)` always reflects wherever that card is rendered *right now*, including
 * immediately after a move has just committed.
 */
export class CardRegistry {
  private cards = new Map<string, RefObject<View | null>>()

  register(cardId: string, view: RefObject<View | null>) {
    this.cards.set(cardId, view)
  }

  unregister(cardId: string, view: RefObject<View | null>) {
    // A move can mount the card's new instance before the old one's cleanup effect runs (React
    // batches this within the same commit), so only remove the entry if it's still pointing at
    // *this* instance - otherwise the fresh registration would get clobbered by the stale unmount.
    if (this.cards.get(cardId) === view) {
      this.cards.delete(cardId)
    }
  }

  async measure(cardId: string): Promise<Rect | null> {
    const view = this.cards.get(cardId)?.current
    if (!view) return null
    return measure(view)
  }
}

export function useCardRegistry(): CardRegistry {
  // A lazy useState initializer (not useRef) - it runs exactly once on mount, same as the old
  // ref-based lazy-init, but without mutating a ref during render (the setter is never called, so
  // this never actually re-renders).
  const [registry] = useState(() => new CardRegistry())
  return registry
}
