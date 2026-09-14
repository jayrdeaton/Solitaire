import { CardSizeProvider } from '@tastic/cards'
import React, { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import Animated, { makeMutable, SharedValue, useAnimatedStyle, useSharedValue, withSpring, WithSpringConfig } from 'react-native-reanimated'

import { Card } from '@/engine/types'

import { PlayingCard } from '../PlayingCard'
import { useCardSoundEffects } from '../useCardSounds'
import { CardRegistry, useCardRegistry } from './CardRegistry'
import { autoMoveSpringFor, autoPlaySpringFor, SNAP_BACK_SPRING } from './dragSpring'

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
   * flies from where the card was tapped to wherever it actually landed). `fast` uses the quicker
   * auto-play-to-foundation timing (see dragSpring.ts's autoPlaySpringFor) instead of the normal
   * tap-to-move/drag/undo one. */
  flyTo(targetX: number, targetY: number, onArrived: () => void, opts?: { fast?: boolean }): void
  /** Hide immediately (used when a drop was applied and the source has already disappeared). */
  hide(): void
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

interface FlightEntry {
  id: number
  content: GhostContent
  originX: SharedValue<number>
  originY: SharedValue<number>
  dx: SharedValue<number>
  dy: SharedValue<number>
}

interface FlightGhostCardProps {
  content: GhostContent
  originX: SharedValue<number>
  originY: SharedValue<number>
  dx: SharedValue<number>
  dy: SharedValue<number>
  containerOffsetX: SharedValue<number>
  containerOffsetY: SharedValue<number>
}

// Memoized: several of these can be mounted at once (see DragGhostProvider's `flights`), and every
// still-flying entry's own props here stay referentially stable across a sibling landing (content
// is only ever set once at creation; the shared values and containerOffsetX/Y never change
// identity) - without this, every remaining ghost would re-render whenever any sibling's own
// landing removed it from `flights`, same reasoning as DealLayer.tsx's DealGhostCard.
const FlightGhostCard = memo(function FlightGhostCard({ content, originX, originY, dx, dy, containerOffsetX, containerOffsetY }: FlightGhostCardProps) {
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: originX.value + dx.value - containerOffsetX.value }, { translateY: originY.value + dy.value - containerOffsetY.value }]
  }))
  return (
    <CardSizeProvider width={content.cardWidth}>
      <Animated.View style={[styles.ghostLayer, animatedStyle]}>
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
  const overlayRef = useRef<View>(null)
  const nextIdRef = useRef(0)
  // originX/Y and flyTo's targetX/Y are all screen-space (measureInWindow/Reanimated's own
  // measure(), both viewport-relative on web - see CardRegistry.ts/PileView.tsx). But this
  // overlay - a screen-level sibling of {children}, not a descendant - isn't necessarily
  // anchored at the true viewport origin itself: it renders whichever containing block wraps
  // this whole screen, which can sit below a native header. Confirmed live: an absolutely
  // positioned probe planted at this exact DOM position rendered at viewport y=64 for top:0, not
  // y=0, on this app's web target. Left uncorrected, every screen-space coordinate above lands
  // that same amount too low - "flies to a spot below the real target, then snaps up" once the
  // real card (in normal flow, unaffected by this) is revealed. Measured once the overlay is
  // mounted (and re-measured if the window resizes) rather than assumed zero.
  const containerOffsetX = useSharedValue(0)
  const containerOffsetY = useSharedValue(0)
  const { width: winWidth, height: winHeight } = useWindowDimensions()
  useEffect(() => {
    overlayRef.current?.measureInWindow((x, y) => {
      containerOffsetX.value = x
      containerOffsetY.value = y
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [winWidth, winHeight])

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
  const createFlight = useCallback((id: number, values: { originX: SharedValue<number>; originY: SharedValue<number>; dx: SharedValue<number>; dy: SharedValue<number> }): DragFlightHandle => {
    let generation = 0
    let pendingSettle: (() => void) | null = null

    function flushPendingSettle() {
      const settle = pendingSettle
      if (!settle) return
      pendingSettle = null
      settle()
    }

    // Reveals the real card (and removes this ghost) `config.duration` after a flight starts,
    // instead of waiting on withSpring's own per-axis completion callback: that callback was found
    // to never fire at all for these duration-based springs when run through this app's web target
    // (confirmed live - the ghost visibly animates to its target via the shared-value-driven
    // transform below, which doesn't depend on the callback, but then never gets removed,
    // permanently masking the real card it's standing in for). Passing the very same config that
    // drives the withSpring calls keeps the timer and the motion it's covering for the same
    // length, and it fires regardless of whether dx/dy had anything to actually move (a
    // stock-to-waste draw has dy already at its target, since the two sit on the same row).
    function settleAfter(config: WithSpringConfig, onSettled: () => void) {
      const gen = ++generation
      pendingSettle = onSettled
      setTimeout(() => {
        if (generation !== gen) return
        pendingSettle = null
        removeFlight(id)
        onSettled()
      }, config.duration ?? 0)
    }

    return {
      originX: values.originX,
      originY: values.originY,
      dx: values.dx,
      dy: values.dy,
      snapBack(onSettled) {
        settleAfter(SNAP_BACK_SPRING, () => {
          playInvalidSound()
          hapticInvalid()
          onSettled()
        })
        values.dx.value = withSpring(0, SNAP_BACK_SPRING)
        values.dy.value = withSpring(0, SNAP_BACK_SPRING)
      },
      flyTo(targetX, targetY, onArrived, opts) {
        // Distance actually left to travel from wherever the ghost is sitting right now - not
        // always originX/Y (that's only the flight's start point; a manual drag has already
        // moved dx/dy away from it by the time flyTo runs) - see autoMoveSpringFor's doc comment
        // in dragSpring.ts for why this determines the settle duration instead of a fixed one.
        const curX = values.originX.value + values.dx.value
        const curY = values.originY.value + values.dy.value
        const distance = Math.hypot(targetX - curX, targetY - curY)
        const config = opts?.fast ? autoPlaySpringFor(distance) : autoMoveSpringFor(distance)
        // No hapticCard() here (unlike snapBack's own hapticInvalid above) - a successful flight's
        // sound+haptic pair now fires together the instant the move was confirmed (see
        // useCardSounds.ts), not on arrival, so there's nothing left for this settle to trigger
        // beyond the caller's own onArrived.
        settleAfter(config, onArrived)
        values.dx.value = withSpring(targetX - values.originX.value, config)
        values.dy.value = withSpring(targetY - values.originY.value, config)
      },
      hide() {
        flushPendingSettle()
        generation += 1
        removeFlight(id)
      }
    }
  }, [playInvalidSound, hapticInvalid, removeFlight])

  const controller = useMemo<DragGhostController>(
    () => ({
      cardRegistry,
      show(content, origin) {
        const id = ++nextIdRef.current
        const values = { originX: makeMutable(origin.x), originY: makeMutable(origin.y), dx: makeMutable(0), dy: makeMutable(0) }
        setFlights((prev) => [...prev, { id, content, ...values }])
        return createFlight(id, values)
      },
      showLive(content, values) {
        const id = ++nextIdRef.current
        setFlights((prev) => [...prev, { id, content, ...values }])
        return createFlight(id, values)
      }
    }),
    [cardRegistry, createFlight]
  )

  return (
    <DragGhostContext.Provider value={controller}>
      {children}
      {/* Always mounted (regardless of `flights`) so containerOffsetX/Y above can measure its real
      position - a card's own screen-space origin is only correct once this measurement lands,
      which needs the view to already exist. */}
      <View ref={overlayRef} pointerEvents='none' style={StyleSheet.absoluteFill}>
        {flights.map((flight) => (
          <FlightGhostCard key={flight.id} content={flight.content} originX={flight.originX} originY={flight.originY} dx={flight.dx} dy={flight.dy} containerOffsetX={containerOffsetX} containerOffsetY={containerOffsetY} />
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
