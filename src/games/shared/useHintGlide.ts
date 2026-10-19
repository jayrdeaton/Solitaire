import { faceUpFanOffset } from '@tastic/cards'
import { useCallback, useEffect, useRef } from 'react'

import { CardRegistry } from '@/components/dragdrop/CardRegistry'
import { DropZoneRegistry } from '@/components/dragdrop/DropZoneRegistry'
import { fanStep } from '@/components/dragdrop/fanTops'
import { ScreenRect, useHintGlideLayer } from '@/components/hinting/HintGlideLayer'
import { isMotionReduced } from '@/components/reducedMotionFlag'
import { PileRef } from '@/engine/gameTypes'
import { Card } from '@/engine/types'

/** What a screen knows about a hinted move, in its own board's terms. */
export interface HintGlideTarget {
  /** The cards that would move, the anchor (the one picked up) first. */
  moving: Card[]
  /** The pile they would land on, bottom to top. Its top card is the landing spot; an empty pile lands on `slot`. */
  dest: readonly Card[]
  /** Whether `dest` fans its cards (a tableau column): the run then lands one fan step below its top card. */
  destFanned: boolean
  /** The drop zone to land on when `dest` is empty. */
  slot?: PileRef
  /** Where to land when `dest` is empty and the spot isn't a drop zone (Pyramid's or Aces Up's discard). A bare point
   * (measureView) is a card-sized container: it takes the anchor card's own size. */
  measureSlot?: () => Promise<ScreenRect | { x: number; y: number } | null>
  cardWidth: number
}

/**
 * A screen's side of the hint glide (components/hinting/HintGlideLayer.tsx): `play` measures where the hinted cards are
 * and where they would land, then has the layer glide a see-through copy there. `resetKey` is the board: when it changes
 * (a move, an undo, a new deal) a glide still on screen is dropped, and one still being measured never starts.
 */
export function useHintGlide(resetKey: unknown, cardRegistry: CardRegistry, dropZones: DropZoneRegistry) {
  const layer = useHintGlideLayer()
  const keyRef = useRef(resetKey)
  useEffect(() => {
    if (keyRef.current === resetKey) return
    keyRef.current = resetKey
    layer?.clear()
  }, [resetKey, layer])

  return useCallback(
    async (target: HintGlideTarget) => {
      // Under Reduce Motion (see reducedMotion.tsx) a hint is its ring alone, with no glide.
      if (!layer || target.moving.length === 0 || isMotionReduced()) return
      const key = keyRef.current
      const anchor = target.moving[0]
      const onto = target.dest[target.dest.length - 1]
      const [from, landing] = await Promise.all([cardRegistry.measure(anchor.id), onto ? cardRegistry.measure(onto.id) : target.slot ? dropZones.measure(target.slot) : (target.measureSlot?.() ?? null)])
      if (keyRef.current !== key || !from || !landing) return
      const to: ScreenRect = 'width' in landing ? landing : { ...landing, width: from.width, height: from.height }
      const naturalStep = faceUpFanOffset(target.cardWidth)
      // A run keeps the spacing its column gives it now (fanTops.ts), like a real flight's ghost.
      const step = target.moving.length > 1 ? (fanStep(target.moving.map((c) => c.id)) ?? naturalStep) : 0
      // Landing on a fanned card: one step below it, at the step its column uses between face-up cards.
      const below = target.dest[target.dest.length - 2]
      const landingStep = below?.faceUp && onto ? (fanStep([below.id, onto.id]) ?? naturalStep) : naturalStep
      layer.play({ cards: target.moving, from, to, toOffsetY: onto && target.destFanned ? landingStep : 0, step, cardWidth: target.cardWidth })
    },
    [layer, cardRegistry, dropZones]
  )
}
