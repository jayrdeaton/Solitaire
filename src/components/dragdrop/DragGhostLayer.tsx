import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import Animated, { SharedValue, useAnimatedStyle, useSharedValue, withSpring, WithSpringConfig } from 'react-native-reanimated'

import { Card } from '@/engine/types'

import { CardSizeProvider } from '../CardSizeContext'
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

export interface DragGhostController {
  /**
   * Screen-space origin and position-delta, all settable directly from a gesture worklet with no
   * JS hop. Origin must be set (via Reanimated's `measure()`, not RN's `measureInWindow`) in the
   * SAME worklet call as the first `dx`/`dy` write - see the note on `show()` below for why.
   */
  originX: SharedValue<number>
  originY: SharedValue<number>
  dx: SharedValue<number>
  dy: SharedValue<number>
  /** Tracks every currently-rendered card's on-screen rect by id, for measuring a tap-to-move
   * destination once it's mounted in its new pile (see flyTo). */
  cardRegistry: CardRegistry
  /**
   * Reveal the floating copy at the origin/dx/dy already staged on the shared values above.
   *
   * originX/Y used to be plain numbers threaded through here from a `measureInWindow` callback
   * (RN's async, native-bridge measurement). On react-native-web `measureInWindow` is implemented
   * as `setTimeout(..., 0)` - a full event-loop turn - while the pan gesture's `onUpdate` keeps
   * firing synchronously on every pointermove in between. That let several onUpdate calls advance
   * dx/dy before the origin the ghost was about to render at had even been measured, so the ghost's
   * first paint was already offset from the real card - read as "the card jumps to a position
   * relative to the pointer" on pickup. Reanimated's `measure()` (see DraggableCard.tsx/PileView.tsx)
   * runs synchronously inside the gesture worklet itself, so origin/dx/dy are all correct before
   * this JS-side call (which only needs to supply the non-position content) ever happens.
   */
  show(content: GhostContent): void
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

const DragGhostContext = createContext<DragGhostController | null>(null)

export function useDragGhost(): DragGhostController {
  const ctx = useContext(DragGhostContext)
  if (!ctx) throw new Error('useDragGhost must be used within a DragGhostProvider')
  return ctx
}

/**
 * Wraps a game screen so a dragged card can be rendered as a screen-level overlay instead of
 * in-place. zIndex/elevation only wins against sibling elements within the same stacking context,
 * so a card dragged out of e.g. a FreeCell slot has no way to paint above the unrelated tableau
 * branch of the tree just by raising its own z-index - it needs to actually live outside both
 * branches, as the last child of the screen, which paints on top of everything by plain DOM order.
 */
export function DragGhostProvider({ children }: { children: React.ReactNode }) {
  const { playInvalidSound, hapticInvalid } = useCardSoundEffects()
  const [ghost, setGhost] = useState<GhostContent | null>(null)
  const originX = useSharedValue(0)
  const originY = useSharedValue(0)
  const dx = useSharedValue(0)
  const dy = useSharedValue(0)
  const cardRegistry = useCardRegistry()
  const overlayRef = useRef<View>(null)
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
  /** Identifies the most recently started flight (show/snapBack/flyTo all bump this), so a
   * settle timer from a superseded flight (see the comment on settleAfter below) can tell it's
   * stale and no-op instead of clobbering whatever flight replaced it. */
  const flightGenerationRef = useRef(0)
  /** The previous flight's still-pending onSettled/onArrived callback, if its settle timer (see
   * settleAfter) hasn't fired yet. A caller (e.g. FreeCellScreen) applies a move's game-state
   * change instantly and only clears its own "this destination is mid-flight" flag once this
   * callback runs - so if a new flight (another tap-to-move, or picking up a card to drag) starts
   * before it fires, the generation bump above stops the OLD timer from ever calling it, and that
   * flag would stay stuck forever: its real card invisible (or, once a later, unrelated flight
   * happens to clear the same shared flag, exposed without ever having animated in). Flushing it
   * synchronously here - as if the interrupted flight had just landed - keeps every flight's
   * bookkeeping resolved exactly once, however it gets cut short. */
  const pendingSettleRef = useRef<(() => void) | null>(null)

  function flushPendingSettle() {
    const settle = pendingSettleRef.current
    if (!settle) return
    pendingSettleRef.current = null
    settle()
  }

  const controller = useMemo<DragGhostController>(
    () => ({
      originX,
      originY,
      dx,
      dy,
      cardRegistry,
      show(content) {
        // originX/Y and dx/dy are NOT touched here - they're staged synchronously in the gesture's
        // onStart worklet (via Reanimated's measure()), before this JS-side call even happens. This
        // only needs to supply the (non-position) card content once the ghost should become visible.
        flushPendingSettle()
        flightGenerationRef.current += 1
        setGhost(content)
      },
      snapBack(onSettled) {
        settleAfter(SNAP_BACK_SPRING, () => {
          playInvalidSound()
          hapticInvalid()
          onSettled()
        })
        dx.value = withSpring(0, SNAP_BACK_SPRING)
        dy.value = withSpring(0, SNAP_BACK_SPRING)
      },
      flyTo(targetX, targetY, onArrived, opts) {
        // Distance actually left to travel from wherever the ghost is sitting right now - not
        // always originX/Y (that's only the flight's start point; a manual drag has already
        // moved dx/dy away from it by the time flyTo runs) - see autoMoveSpringFor's doc comment
        // in dragSpring.ts for why this determines the settle duration instead of a fixed one.
        const curX = originX.value + dx.value
        const curY = originY.value + dy.value
        const distance = Math.hypot(targetX - curX, targetY - curY)
        const config = opts?.fast ? autoPlaySpringFor(distance) : autoMoveSpringFor(distance)
        // No hapticCard() here (unlike snapBack's own hapticInvalid above) - a successful flight's
        // sound+haptic pair now fires together the instant the move was confirmed (see
        // useCardSounds.ts), not on arrival, so there's nothing left for this settle to trigger
        // beyond the caller's own onArrived.
        settleAfter(config, onArrived)
        dx.value = withSpring(targetX - originX.value, config)
        dy.value = withSpring(targetY - originY.value, config)
      },
      hide() {
        flushPendingSettle()
        flightGenerationRef.current += 1
        setGhost(null)
      }
    }),
    [originX, originY, dx, dy, cardRegistry, playInvalidSound, hapticInvalid]
  )

  // Reveals the real card (and hides the ghost) `config.duration` after a flight starts, instead
  // of waiting on withSpring's own per-axis completion callback the way flyTo/snapBack originally
  // did: that callback was found to never fire at all for these duration-based springs when run
  // through this app's web target (confirmed live - the ghost visibly animates to its target via
  // the shared-value-driven transform below, which doesn't depend on the callback, but then never
  // gets hidden, permanently masking the real card it's standing in for). Passing the very same
  // config that drives the withSpring calls keeps the timer and the motion it's covering for the
  // same length, and it fires regardless of whether dx/dy had anything to actually move (a
  // stock-to-waste draw has dy already at its target, since the two sit on the same row).
  function settleAfter(config: WithSpringConfig, onSettled: () => void) {
    const gen = ++flightGenerationRef.current
    pendingSettleRef.current = onSettled
    setTimeout(() => {
      if (flightGenerationRef.current !== gen) return
      pendingSettleRef.current = null
      setGhost(null)
      onSettled()
    }, config.duration ?? 0)
  }

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: originX.value + dx.value - containerOffsetX.value }, { translateY: originY.value + dy.value - containerOffsetY.value }]
  }))

  return (
    <DragGhostContext.Provider value={controller}>
      {children}
      {/* Always mounted (regardless of `ghost`) so containerOffsetX/Y above can measure it real
      position - a card's own screen-space origin is only correct once this measurement lands,
      which needs the view to already exist. */}
      <View ref={overlayRef} pointerEvents='none' style={StyleSheet.absoluteFill}>
        {ghost && (
          <CardSizeProvider width={ghost.cardWidth}>
            <Animated.View style={[{ position: 'absolute', left: 0, top: 0 }, animatedStyle]}>
              {ghost.cards.map((c, i) => (
                <View key={c.id} style={{ position: 'absolute', top: i * ghost.offsetStep, left: 0 }}>
                  <PlayingCard card={c} />
                </View>
              ))}
            </Animated.View>
          </CardSizeProvider>
        )}
      </View>
    </DragGhostContext.Provider>
  )
}
