import { CARD_ASPECT, CardSizeProvider } from '@tastic/cards'
import React, { createContext, memo, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { makeMutable, SharedValue, useAnimatedStyle, withSpring, WithSpringConfig } from 'react-native-reanimated'

import { Card } from '@/engine/types'

import { OverlayFrame, toLocal, useOverlayFrame } from '../overlayFrame'
import { PlayingCard } from '../PlayingCard'
import { useCardSoundEffects } from '../useCardSounds'
import { CardRegistry, useCardRegistry } from './CardRegistry'
import { dropSpringFor, FLIGHT_SPRING, SNAP_BACK_SPRING, springSettleMs } from './dragSpring'

interface GhostContent {
  cards: Card[]
  /** Vertical fan offset between stacked ghost cards, for a multi-card run. */
  offsetStep: number
  /** The caller screen's actual current card width - the ghost renders inside its own
   * CardSizeProvider fed by this value (see DealLayer.tsx's identical need), since
   * DragGhostProvider renders as a sibling of its own {children}, outside whatever
   * CardSizeProvider the screen itself sets up. Without it, the ghost falls back to
   * CardSizeContext's static default size instead of matching the screen's real cards. */
  cardWidth: number
}

/** A single in-flight ghost card (or fanned run) - fully independent of every other one. Starting
 * a new flight anywhere else in the app never interrupts this one; it always runs to its own
 * completion on its own schedule. See DragGhostController.show/showLive for how one of these gets
 * created. */
export interface DragFlightHandle {
  /**
   * Screen-space origin and position-delta, settable directly from a gesture worklet with no JS
   * hop. Origin must be set (via Reanimated's `measure()`, not RN's `measureInWindow`) in the SAME
   * worklet call as the first `dx`/`dy` write - see showLive's doc comment for why.
   */
  originX: SharedValue<number>
  originY: SharedValue<number>
  dx: SharedValue<number>
  dy: SharedValue<number>
  /** Animate back to the origin, then hide and invoke onSettled (used to restore the source card). */
  snapBack(onSettled: () => void): void
  /** Animate to an arbitrary screen point, then hide and invoke onArrived (used for tap-to-move:
   * flies from where the card was tapped to wherever it actually landed). A flight started by
   * show() - a tap, an undo, a draw, an auto-played card - takes dragSpring.ts's FLIGHT_SPRING, the
   * same time at any distance; a drag's drop (a showLive() flight) settles over dropSpringFor the
   * distance it has left, since the finger has usually brought it most of the way already. */
  flyTo(targetX: number, targetY: number, onArrived: () => void): void
  /** Hide immediately (used when a drop was applied and the source has already disappeared). */
  hide(): void
  /**
   * Cut this flight loose from the caller's persistent gesture values (a showLive() flight; a no-op
   * for show(), and once done). From here the ghost runs on values of its OWN, starting at exactly
   * the position it has now, so nothing a later drag from the same slot/column writes to the
   * persistent ones can touch it - it keeps flying to its own landing. Call it the moment the drag
   * ENDS, before anything awaits (DraggableCard/PileView do): a drop can sit in a hit test, a
   * measurement or a deferral for a while before flyTo, and a quick next drag from the same source
   * would otherwise hijack the persistent values under it (the ghost vanished partway and its card
   * just appeared at the destination). flyTo/snapBack/hide do it themselves if it hasn't happened.
   */
  release(): void
}

export interface DragGhostController {
  /** Tracks every currently-rendered card's on-screen rect by id, for measuring a tap-to-move
   * destination once it's mounted in its new pile (see flyTo). */
  cardRegistry: CardRegistry
  /**
   * Begin an independent flight with a known starting point - for a JS-driven flight with no
   * continuous pointer to track (tap-to-move, auto-play, undo, stock draw/recycle). Allocates its
   * own position tracking internally; never interrupted by another show()/showLive() call
   * happening anywhere else, and never interrupts one either - many of these can be in flight at
   * once, each animating independently to its own destination.
   */
  show(content: GhostContent, origin: { x: number; y: number }): DragFlightHandle
  /**
   * Begin an independent flight using SharedValues the caller already owns, so a gesture worklet
   * can write dx/dy every frame with no JS hop (see DraggableCard.tsx/PileView.tsx, which each
   * create their own persistent originX/originY/dx/dy once, tied to their own component's
   * lifetime, and pass them in fresh every time a drag begins). Functionally identical to show()
   * otherwise - just as independent of every other concurrent flight.
   */
  showLive(content: GhostContent, values: { originX: SharedValue<number>; originY: SharedValue<number>; dx: SharedValue<number>; dy: SharedValue<number> }): DragFlightHandle
}

const DragGhostContext = createContext<DragGhostController | null>(null)

export function useDragGhost(): DragGhostController {
  const ctx = useContext(DragGhostContext)
  if (!ctx) throw new Error('useDragGhost must be used within a DragGhostProvider')
  return ctx
}

/** One set of position-tracking SharedValues: the flight's screen-space origin plus its live delta. */
interface FlightValues {
  originX: SharedValue<number>
  originY: SharedValue<number>
  dx: SharedValue<number>
  dy: SharedValue<number>
}

/** Holds a flight's motion back until its ghost view exists (see FlightGhostCard's onMounted): a flight the caller starts in the very stretch that
 * shows its ghost - flyTo right after show(), the screen's own re-render and commit still ahead - would otherwise be moving for however long that
 * commit takes (tens to hundreds of ms on a phone) before there was anything to see, and the ghost would first appear already partway along its path. */
interface MountGate {
  run(fn: () => void): void
  open(): void
}
function createMountGate(): MountGate {
  let isOpen = false
  const queued: (() => void)[] = []
  return {
    run(fn) {
      if (isOpen) fn()
      else queued.push(fn)
    },
    open() {
      isOpen = true
      queued.splice(0).forEach((fn) => fn())
    }
  }
}

interface FlightEntry {
  id: number
  mountGate: MountGate
  content: GhostContent
  /** What the ghost follows while a drag is in progress: the caller's persistent gesture values for a
   * showLive() flight, the flight's own for a show() one (the same object as `own`). */
  live: FlightValues
  /** The flight's own values - what every terminal animation (flyTo/snapBack) drives, and what the
   * ghost follows once `handedOff` is 1. */
  own: FlightValues
  /** 0 while the ghost follows `live`, 1 once it follows `own` (see DragFlightHandle.release). Flipped
   * from JS AFTER `own` has been written, so the switch lands on the identical position with no
   * re-render and no remount - the ghost reads both sets from its very first render. */
  handedOff: SharedValue<number>
}

interface FlightGhostCardProps {
  onMounted: () => void
  content: GhostContent
  live: FlightValues
  own: FlightValues
  handedOff: SharedValue<number>
  frame: OverlayFrame
}

// Memoized: several of these can be mounted at once (see DragGhostProvider's `flights`), and every
// still-flying entry's own props here stay referentially stable across a sibling landing (content
// is only ever set once at creation; the shared values and `frame` never change
// identity) - without this, every remaining ghost would re-render whenever any sibling's own
// landing removed it from `flights`, same reasoning as DealLayer.tsx's GhostSlot.
const FlightGhostCard = memo(function FlightGhostCard({ onMounted, content, live, own, handedOff, frame }: FlightGhostCardProps) {
  const cardHeight = content.cardWidth / CARD_ASPECT
  // In the commit that mounts the ghost (a layout effect: the view is in the tree by then) - see MountGate.
  useLayoutEffect(() => onMounted(), [onMounted])
  // Plain locals rather than the two objects: the worklet below should capture each SharedValue on
  // its own, exactly like every other ghost in this app.
  const { originX: liveOriginX, originY: liveOriginY, dx: liveDx, dy: liveDy } = live
  const { originX: ownOriginX, originY: ownOriginY, dx: ownDx, dy: ownDy } = own
  const animatedStyle = useAnimatedStyle(() => {
    // origin + delta is the ghost's live screen-space position (see toLocal for how that becomes a
    // position inside this overlay, which lives in the rotated frame under a landscape hold).
    const handed = handedOff.value === 1
    const sx = handed ? ownOriginX.value + ownDx.value : liveOriginX.value + liveDx.value
    const sy = handed ? ownOriginY.value + ownDy.value : liveOriginY.value + liveDy.value
    const p = toLocal(sx, sy, content.cardWidth, cardHeight, frame)
    return { transform: [{ translateX: p.x }, { translateY: p.y }] }
  })
  // An explicit size for the container - its only children are absolutely positioned, so without it this lays out as
  // an exactly-zero frame at the overlay's origin, which trips a React Native (Fabric, iOS) view-recycling bug that
  // leaves a recycled UIView at its PREVIOUS life's position (a recycled view's stored layout is reset to a zero
  // frame, so a new zero frame reads as "unchanged" and its center/bounds are never reset). See DealLayer.tsx's
  // slotSize for the full account; a ghost mounted into such a view would fly on the wrong row for its whole flight.
  const groupHeight = cardHeight + Math.max(0, content.cards.length - 1) * content.offsetStep
  return (
    <CardSizeProvider width={content.cardWidth}>
      <Animated.View style={[styles.ghostLayer, { width: content.cardWidth, height: groupHeight }, animatedStyle]}>
        {content.cards.map((c, i) => (
          <View key={c.id} style={[styles.stackedCard, { top: i * content.offsetStep }]}>
            <PlayingCard card={c} />
          </View>
        ))}
      </Animated.View>
    </CardSizeProvider>
  )
})

/**
 * Wraps a game screen so any number of independently-flying cards can be rendered as a
 * screen-level overlay instead of in-place. zIndex/elevation only wins against sibling elements
 * within the same stacking context, so a card dragged out of e.g. a FreeCell slot has no way to
 * paint above the unrelated tableau branch of the tree just by raising its own z-index - it needs
 * to actually live outside both branches, as the last child of the screen, which paints on top of
 * everything by plain DOM order.
 *
 * Every flight (drag, tap-to-move, auto-play, undo, ...) is fully independent, each with its own
 * position tracking and settle lifecycle (see DragFlightHandle) - starting a new one never
 * interrupts an older one still in the air, the bug this used to have when everything shared one
 * singleton ghost.
 */
export function DragGhostProvider({ children }: { children: React.ReactNode }) {
  const { playInvalidSound, hapticInvalid } = useCardSoundEffects()
  const [flights, setFlights] = useState<FlightEntry[]>([])
  const cardRegistry = useCardRegistry()
  const { overlayRef, frame } = useOverlayFrame()
  const nextIdRef = useRef(0)
  // originX/Y and flyTo's targetX/Y are all screen-space (measureInWindow/Reanimated's own
  // measure(), both viewport-relative on web - see CardRegistry.ts/PileView.tsx), but this overlay
  // - a screen-level sibling of {children}, not a descendant - isn't necessarily anchored at the true
  // viewport origin (it can sit below a native header on this app's web target - confirmed live), and
  // under a landscape hold it lives inside RotatedGameView's rotated frame, so a screen-space point
  // isn't a valid position inside it as-is. useOverlayFrame measures the overlay once mounted (and
  // again on resize/rotation) and toLocal converts each ghost's screen-space position accordingly -
  // see overlayFrame.ts.

  // showLive's caller (DraggableCard/PileView) owns ONE persistent set of SharedValues per
  // draggable slot/column, reused for every drag that ever starts from there - necessary so the
  // gesture worklet always has a stable value to write to (see showLive's own doc comment). Two
  // flights sharing those exact SharedValue objects would hijack each other: a second drag's
  // worklet writing fresh origin/dx the instant it starts silently moved the FIRST flight's
  // still-mounted, still-settling ghost out from under it (confirmed live - dragging repeatedly from
  // the same waste slot or tableau column faster than one flight's settle time made the earlier
  // ghost vanish partway, its card just appearing at the destination).
  //
  // So a flight only ever sits on the persistent values WHILE ITS DRAG IS IN PROGRESS. The instant
  // the drag ends, DragFlightHandle.release() hands the ghost values of its own, holding the same
  // position (see FlightEntry.handedOff for why that needs no re-render). After that the flight is
  // completely independent of the source, applied or not, and a new drag from the same slot can never
  // reach it. (Tried cloning onto fresh SharedValues at hand-off first, git history - the ghost, still
  // mounted, kept rendering its OLD values until React re-rendered, so every flight ran invisibly for
  // a render cycle and then jumped to wherever it had got to. Here the ghost reads both sets from its
  // first render, so nothing has to re-render.)
  //
  // The only flights still cut off by a new claim are the ones that never released (a drag whose
  // end never arrived) and a SNAP-BACK in progress: that ghost is returning the very card the new
  // drag has just picked up again, so the pick-up correctly ends it (its onSettled runs at once,
  // like it always did, so the source card is revealed before the new drag hides it). This map keys
  // each such flight by its persistent originX.
  const liveOwnersRef = useRef(new Map<SharedValue<number>, DragFlightHandle>())

  const removeFlight = useCallback((id: number) => {
    setFlights((prev) => prev.filter((f) => f.id !== id))
  }, [])

  // Builds the imperative handle for one flight - entirely self-contained (its own generation
  // counter and pending-settle callback, closed over here rather than stored in a shared ref),
  // since unlike the old single-ghost design, nothing else can ever interrupt this specific
  // flight's own timers. The generation counter still matters within a single flight's own
  // lifetime: `hide()` can race a still-pending settleAfter timer from an earlier flyTo/snapBack
  // call on this SAME handle, and must stop that stale timer from firing after this flight has
  // already been torn down.
  //
  // `source` is the caller's persistent originX (a showLive flight) or null (a show flight, which
  // never had persistent values and is born released).
  const createFlight = useCallback(
    (id: number, mountGate: MountGate, live: FlightValues, own: FlightValues, handedOff: SharedValue<number>, source: SharedValue<number> | null): DragFlightHandle => {
      let generation = 0
      let pendingSettle: (() => void) | null = null
      let released = source === null

      function flushPendingSettle() {
        const settle = pendingSettle
        if (!settle) return
        pendingSettle = null
        settle()
      }

      function unregisterOwner() {
        if (source && liveOwnersRef.current.get(source) === handle) liveOwnersRef.current.delete(source)
      }

      // See DragFlightHandle.release. `own` is written BEFORE `handedOff` flips (writes reach the UI
      // thread in order), so the ghost only switches once its own values already hold the position.
      function release() {
        if (released) return
        released = true
        own.originX.value = live.originX.value
        own.originY.value = live.originY.value
        own.dx.value = live.dx.value
        own.dy.value = live.dy.value
        handedOff.value = 1
        unregisterOwner()
      }

      // Reveals the real card (and removes this ghost) once a flight has ACTUALLY finished, instead of
      // waiting on withSpring's own per-axis completion callback: that callback was found
      // to never fire at all for these duration-based springs when run through this app's web target
      // (confirmed live - the ghost visibly animates to its target via the shared-value-driven
      // transform below, which doesn't depend on the callback, but then never gets removed,
      // permanently masking the real card it's standing in for). The timer must be springSettleMs(),
      // not the bare `config.duration`: `duration` is only the spring's PERCEPTUAL length (it really
      // runs 1.5x that) and the UI-thread spring starts a frame or two after this timer does, so a
      // timer of exactly `duration` retired the ghost with up to tens of pixels still to go. It fires
      // regardless of whether dx/dy had anything to actually move (a stock-to-waste draw has dy
      // already at its target, since the two sit on the same row).
      //
      // `animate` (the withSpring writes) and this timer both start once the ghost view exists (MountGate) - a flight started in the same
      // stretch as show() would otherwise be moving, unseen, for as long as the commit that mounts its ghost takes.
      function settleAfter(config: WithSpringConfig, onSettled: () => void, animate: () => void) {
        const gen = ++generation
        pendingSettle = onSettled
        mountGate.run(() => {
          if (generation !== gen) return // hidden (or superseded) before it could start: nothing to move, nothing to settle
          animate()
          setTimeout(() => {
            if (generation !== gen) return
            pendingSettle = null
            removeFlight(id)
            onSettled()
          }, springSettleMs(config))
        })
      }

      // What a caller reads/animates: the persistent values until the drag ends, the flight's own after.
      function values(): FlightValues {
        return released ? own : live
      }

      const handle: DragFlightHandle = {
        get originX() {
          return values().originX
        },
        get originY() {
          return values().originY
        },
        get dx() {
          return values().dx
        },
        get dy() {
          return values().dy
        },
        release,
        snapBack(onSettled) {
          release()
          // A drag that picks the same source up again ends this return at once (see liveOwnersRef).
          if (source) liveOwnersRef.current.set(source, handle)
          settleAfter(
            SNAP_BACK_SPRING,
            () => {
              unregisterOwner()
              playInvalidSound()
              hapticInvalid()
              onSettled()
            },
            () => {
              own.dx.value = withSpring(0, SNAP_BACK_SPRING)
              own.dy.value = withSpring(0, SNAP_BACK_SPRING)
            }
          )
        },
        flyTo(targetX, targetY, onArrived) {
          release()
          unregisterOwner()
          // Every flight takes FLIGHT_SPRING's one fixed time, except a drag's drop (`source`: a showLive flight), whose settle scales with the
          // distance actually left from wherever the finger let go - own.dx/dy, already moved away from the origin by the drag (see
          // dropSpringFor's comment in dragSpring.ts).
          const config = source ? dropSpringFor(Math.hypot(targetX - own.originX.value - own.dx.value, targetY - own.originY.value - own.dy.value)) : FLIGHT_SPRING
          // No hapticCard() here (unlike snapBack's own hapticInvalid above) - a successful flight's
          // sound+haptic pair now fires together the instant the move was confirmed (see
          // useCardSounds.ts), not on arrival, so there's nothing left for this settle to trigger
          // beyond the caller's own onArrived.
          settleAfter(config, onArrived, () => {
            own.dx.value = withSpring(targetX - own.originX.value, config)
            own.dy.value = withSpring(targetY - own.originY.value, config)
          })
        },
        hide() {
          // Also lets go of the persistent values (copying the position, so a later read still
          // answers) - a hidden ghost must never keep a claim on them.
          release()
          unregisterOwner()
          flushPendingSettle()
          generation += 1
          removeFlight(id)
        }
      }
      return handle
    },
    [playInvalidSound, hapticInvalid, removeFlight]
  )

  const controller = useMemo<DragGhostController>(
    () => ({
      cardRegistry,
      show(content, origin) {
        const id = ++nextIdRef.current
        const own = { originX: makeMutable(origin.x), originY: makeMutable(origin.y), dx: makeMutable(0), dy: makeMutable(0) }
        const handedOff = makeMutable(1)
        const mountGate = createMountGate()
        setFlights((prev) => [...prev, { id, mountGate, content, live: own, own, handedOff }])
        return createFlight(id, mountGate, own, own, handedOff, null)
      },
      showLive(content, values) {
        // A flight still on these values is a snap-back to be ended by this pick-up (or a drag that
        // never released) - see liveOwnersRef. A released, in-flight one is not in the map.
        liveOwnersRef.current.get(values.originX)?.hide()
        const id = ++nextIdRef.current
        const own = { originX: makeMutable(0), originY: makeMutable(0), dx: makeMutable(0), dy: makeMutable(0) }
        const handedOff = makeMutable(0)
        const mountGate = createMountGate()
        setFlights((prev) => [...prev, { id, mountGate, content, live: values, own, handedOff }])
        const handle = createFlight(id, mountGate, values, own, handedOff, values.originX)
        liveOwnersRef.current.set(values.originX, handle)
        return handle
      }
    }),
    [cardRegistry, createFlight]
  )

  return (
    <DragGhostContext.Provider value={controller}>
      {children}
      {/* Always mounted (regardless of `flights`) so `frame` above can measure its real
      position - a card's own screen-space origin is only correct once this measurement lands,
      which needs the view to already exist. */}
      <View ref={overlayRef} pointerEvents='none' style={StyleSheet.absoluteFill}>
        {flights.map((flight) => (
          <FlightGhostCard key={flight.id} onMounted={flight.mountGate.open} content={flight.content} live={flight.live} own={flight.own} handedOff={flight.handedOff} frame={frame} />
        ))}
      </View>
    </DragGhostContext.Provider>
  )
}

const styles = StyleSheet.create({
  ghostLayer: {
    left: 0,
    position: 'absolute',
    top: 0
  },
  stackedCard: {
    left: 0,
    position: 'absolute'
  }
})
