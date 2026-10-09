import { CARD_ASPECT, CardSizeProvider } from '@tastic/cards'
import { useRotation } from '@tastic/core'
import React, { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { makeMutable, SharedValue, useAnimatedStyle, withSpring, WithSpringConfig } from 'react-native-reanimated'

import { Card } from '@/engine/types'

import { FaceLoadTrackingContext, LANDED_GHOST_MAX_MS, markGhostPending, useGhostPaintGate, whenCardsSettled } from '../cardFacePaint'
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
   * once, each animating independently to its own destination. The one thing they share is a
   * place in DragGhostProvider's start queue (startQueueRef): a show() flight's motion is never let
   * go before every show() flight started before it has shown its ghost. Its motion then starts at
   * the later of that and its own flyTo - the queue orders when each flight MAY start, not the
   * flyTo calls themselves. So callers that call flyTo in start order land in start order (every
   * one of them takes the same FLIGHT_SPRING): every screen's streams do, since their destination
   * measurements resolve first-in, first-out. A flight shown earlier whose flyTo comes later starts,
   * and lands, later.
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

/** Holds a flight's motion back until its ghost is on screen (see FlightGhostCard's onVisible) - and, for a show() flight, until every show()
 * flight started before it has had its own gate opened (DragGhostProvider's startQueueRef; an open gate only lets a flight move once its flyTo
 * or snapBack asks it to). Otherwise a flight the caller starts in the very stretch that shows its
 * ghost - flyTo right after show(), the screen's own re-render and commit still ahead - would be moving for however long that commit
 * takes (tens to hundreds of ms on a phone) before there was anything to see, and the ghost would first appear already partway along its path. */
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

/** A show() flight's place in DragGhostProvider's start queue (startQueueRef): `ready` once its ghost is visible, `open`
 * starts its motion (its MountGate). */
interface StartTicket {
  id: number
  ready: boolean
  open: () => void
}

interface FlightEntry {
  id: number
  /** The ghost's React key: the flight's id, or - when this flight ADOPTED a landed ghost of the same cards (see
   * adoptable) - that ghost's key, so the already-painted ghost instance carries on instead of a fresh, blank one. */
  key: number
  mountGate: MountGate
  /** Ends this flight's take-off hold (cardFacePaint.ts's ghost-pending mark on its face-up cards): called once the ghost
   * is visible, or when the flight goes before it ever was. A no-op for an adopted ghost (nothing was marked). */
  releasePending: () => void
  /** The ghost is already painted (an adopted landed ghost): visible from its first render. */
  prePainted: boolean
  /** See FlightGhostCardProps.onVisible: shown + releasePending, and mountGate.open - for a show() flight, once its turn in the start queue
   * comes (DragGhostProvider's startQueueRef). */
  onVisible: () => void
  /** Whether this ghost has been on screen (set by onVisible) - only a ghost that has can be adopted (it is painted). */
  shown: { current: boolean }
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
  /** Set in the commit that reveals the real card under this ghost (its settle): the flight is over, and the ghost only
   * stays until that card's face has painted - see LANDED_GHOST_MAX_MS. */
  landed?: boolean
  /** Where a flyTo flight came to rest (screen space, top-left + size), so a newer card landing on the same spot can
   * retire it - see land(). Unset for a snap-back. */
  rest?: { x: number; y: number; width: number; height: number }
}

// How long a landed ghost may wait for the card under it to paint: cardFacePaint.ts's LANDED_GHOST_MAX_MS (re-exported).
export { LANDED_GHOST_MAX_MS }

/** The cards a ghost must have painted before it shows: its face-up cards, or - for a group stacked with no fan
 * (offsetStep 0, e.g. a recycle's whole waste) - only the top one, the only one anyone can see. */
function visibleFaceIds(content: GhostContent): string[] {
  const seen = content.offsetStep === 0 ? content.cards.slice(-1) : content.cards
  return seen.filter((c) => c.faceUp).map((c) => c.id)
}

/** A ghost that has been on screen, of exactly these cards (same ids in the same order, same faces, size and fan): a new
 * flight can carry on with it - it is painted, so the new flight needs no take-off hold at all. */
function adoptable(entry: FlightEntry, content: GhostContent): boolean {
  if (!entry.shown.current || entry.content.cardWidth !== content.cardWidth || entry.content.offsetStep !== content.offsetStep) return false
  const a = entry.content.cards
  const b = content.cards
  return a.length === b.length && a.every((c, i) => c.id === b[i].id && c.faceUp === b[i].faceUp)
}

// No shadow on a landed ghost: the real card under it draws its own, and two would darken it for as long as both show.
const LANDED_CARD_STYLE = { shadowOpacity: 0, elevation: 0 }

/** A landed group's screen-space footprint, from its head card's measured screen top-left: `width` x `height`
 * (the fan runs down) unrotated. Under a quarter turn the head card is `cardHeight` wide and `width` tall on screen and the
 * fan runs sideways - which way depends on the turn - so the rect covers the fan's length on both sides of the head card
 * (a little too wide rather than missing an overlap). */
function restRect(x: number, y: number, width: number, height: number, cardHeight: number, quarterTurn: boolean) {
  if (!quarterTurn) return { x, y, width, height }
  const fan = height - cardHeight
  return { x: x - fan, y, width: cardHeight + 2 * fan, height: width }
}

function rectsOverlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

interface FlightGhostCardProps {
  /** Called in the commit the ghost becomes visible (a layout effect): releases its take-off hold and lets the flight start
   * moving (opens its MountGate - at once, unless an earlier show() flight's gate has not opened yet, i.e. its ghost has not
   * shown: see startQueueRef). */
  onVisible: () => void
  /** Releases the take-off hold if the ghost goes (or is handed to another flight) before it ever showed. */
  releasePending: () => void
  prePainted: boolean
  content: GhostContent
  live: FlightValues
  own: FlightValues
  handedOff: SharedValue<number>
  frame: OverlayFrame
  landed: boolean
}

// Memoized: several of these can be mounted at once (see DragGhostProvider's `flights`), and every
// still-flying entry's own props here stay referentially stable across a sibling landing (content
// is only ever set once at creation; the shared values and `frame` never change
// identity) - without this, every remaining ghost would re-render whenever any sibling's own
// landing removed it from `flights`, same reasoning as DealLayer.tsx's GhostSlot.
const FlightGhostCard = memo(function FlightGhostCard({ onVisible, releasePending, prePainted, content, live, own, handedOff, frame, landed }: FlightGhostCardProps) {
  const cardHeight = content.cardWidth / CARD_ASPECT
  // Invisible until its visible faces have painted (visibleFaceIds; see useGhostPaintGate): a ghost is a freshly mounted
  // Image, blank for a frame or two, while the source keeps drawing the departing card meanwhile (cardFacePaint.ts's ghost
  // pending). A face-down card is SVG and draws at once; an adopted ghost is painted already. onVisible runs in the commit
  // it shows - see MountGate (and startQueueRef: a ghost can be on screen, still at its origin, waiting for its turn to move).
  const faceIds = useMemo(() => (prePainted ? [] : visibleFaceIds(content)), [prePainted, content])
  const { shown: visible, markPainted } = useGhostPaintGate(faceIds, onVisible)
  // A ghost removed before it ever showed (hide() mid-take-off, a New Game) must not leave its source holding.
  useEffect(() => releasePending, [releasePending])
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
      <FaceLoadTrackingContext.Provider value={false}>
        <Animated.View style={[styles.ghostLayer, { width: content.cardWidth, height: groupHeight }, !visible && styles.unpainted, animatedStyle]}>
          {content.cards.map((c, i) => (
            <View key={c.id} style={[styles.stackedCard, { top: i * content.offsetStep }]}>
              <PlayingCard card={c} style={landed ? LANDED_CARD_STYLE : undefined} onFacePainted={c.faceUp ? () => markPainted(c.id) : undefined} />
            </View>
          ))}
        </Animated.View>
      </FaceLoadTrackingContext.Provider>
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
  // Read when a flight lands (its rest rect): a card's screen footprint is its height x width under a quarter turn.
  const rotation = useRotation()
  const rotationRef = useRef(rotation)
  useEffect(() => {
    rotationRef.current = rotation
  }, [rotation])
  const nextIdRef = useRef(0)
  // originX/Y and flyTo's targetX/Y are all screen-space (measureInWindow/Reanimated's own
  // measure(), both viewport-relative on web - see CardRegistry.ts/PileView.tsx), but this overlay
  // - a screen-level sibling of {children}, not a descendant - isn't necessarily anchored at the true
  // viewport origin (it can sit below a native header on this app's web target - confirmed live), and
  // under a landscape hold it lives inside FakeLandscapeView's rotated frame, so a screen-space point
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

  // The show() flights whose MountGate has not opened yet, in the order they were started - so a flight is never let go
  // before every flight started ahead of it has been.
  //
  // A flight can start moving once its ghost turns visible (onVisible, see FlightGhostCard), and that moment varies per
  // flight: a fresh ghost waits for its face Image's bitmap (useGhostPaintGate - a frame or two, up to GHOST_PAINT_MAX_MS
  // counted from its OWN commit), while an adopted ghost (already painted) or a face-down one is visible in its first
  // commit. Left to that alone, a card started later could start first: an auto-play stream's next card (sent 96ms after
  // the last, often adopting its own just-landed ghost) against a card whose fresh face was slow to come back on a busy JS
  // thread. Landing first on a shared foundation, it drew the earlier, still-airborne card on the pile (FoundationCell's
  // settledCard counts the cards in the air by position) with that card's ghost over it - the later card blinked to the
  // earlier one's rank until it landed: the overtaking the fixed flight time exists to rule out. Before the paint gate,
  // gates opened in commit order (at the ghost's mount), which is show() order; this keeps that.
  //
  // So a show() flight's MountGate opens only once its ghost is visible AND every flight queued before it has opened.
  // onVisible still marks the ghost shown and releases its take-off hold at once (the ghost is on screen, exactly at its
  // origin, so the source can let go), then waits here for its turn. The wait is bounded: the head of the queue opens at
  // its own paint, or GHOST_PAINT_MAX_MS after its own commit, and a flight that goes - hide() (a New Game, a refused
  // move), even before its ghost ever mounted - leaves the queue (applyFlights prunes every flight no longer in the model)
  // and lets the next one go. A flight with no unopened gate ahead of it opens in its own onVisible, exactly as before.
  // An adopted flight takes its turn too: being visible in its first commit is precisely how it could overtake.
  //
  // What this orders is gate OPENINGS, not motion: an open gate runs a flight's spring only once its flyTo (or snapBack)
  // asks for it (settleAfter), so a flight moves at the later of its gate and its flyTo. A flight that has shown but is
  // not sent anywhere yet (its destination still being measured) does not hold later ones back, and if a later flight's
  // flyTo comes first, the later flight starts and lands first. Holding every later flight until each earlier one's
  // flyTo as well was not done: a caller sits between show() and flyTo for as long as its destination takes to measure
  // (Pyramid's draws wait a whole render and commit first, see its pendingFlightRef), so every unrelated flight would
  // queue behind every earlier one's measurement, and a flight that was never sent anywhere nor hidden would hold every
  // later one back for good - where the wait for a gate is bounded (GHOST_PAINT_MAX_MS, above).
  // Landing order therefore also needs the callers to call flyTo in start order, which every screen's streams do (their
  // destination measurements resolve first-in, first-out), so - every flight taking the same FLIGHT_SPRING - a stream
  // lands in the order it was started.
  //
  // showLive (drag) flights are left out: the ghost follows the finger whatever its gate does, and a drop settles over the
  // distance the finger left (dropSpringFor), so their landings were never in start order anyway.
  const startQueueRef = useRef<StartTicket[]>([])
  const drainStarts = useCallback(() => {
    const queue = startQueueRef.current
    while (queue.length > 0 && queue[0].ready) queue.shift()!.open()
  }, [])

  // `flights` as of now, not the last render - every change goes through applyFlights, which updates this first. Adoption
  // reads it: a ghost can land and its card take off again in one task (a deferred King on a just-drawn card, an
  // auto-play poll), before any commit. It also drops a flight that has left the model from the start queue, whichever
  // way it left, so nothing queued behind it waits on a ghost that will never show.
  const modelRef = useRef<FlightEntry[]>([])
  const applyFlights = useCallback(
    (update: (prev: FlightEntry[]) => FlightEntry[]) => {
      modelRef.current = update(modelRef.current)
      const queue = startQueueRef.current
      if (queue.length > 0) {
        const ids = new Set(modelRef.current.map((f) => f.id))
        const before = queue.length
        for (let i = queue.length - 1; i >= 0; i--) if (!ids.has(queue[i].id)) queue.splice(i, 1)
        if (queue.length !== before) drainStarts()
      }
      setFlights(modelRef.current)
    },
    [drainStarts]
  )
  // The flight id behind each handle, for showLive's adoption of the snap-back it ends.
  const handleIdsRef = useRef(new WeakMap<DragFlightHandle, number>())

  const removeFlight = useCallback(
    (id: number) => {
      applyFlights((prev) => prev.filter((f) => f.id !== id))
    },
    [applyFlights]
  )

  // The settle of a flight: marks it landed (in the same commit as the caller's reveal of the real card - both are set
  // from the settle timer) instead of removing it; the effect below removes it once that card's face has painted. A
  // ghost still waiting over a spot a newer card has just landed on is retired here: the newer ghost covers it now, and
  // it would otherwise be drawn over the newer real card once that ghost was gone (the overlay sits above the board).
  const land = useCallback(
    (id: number, rest: FlightEntry['rest']) => {
      applyFlights((prev) => prev.filter((f) => f.id === id || !(f.landed && rest && f.rest && rectsOverlap(f.rest, rest))).map((f) => (f.id === id ? { ...f, landed: true, rest } : f)))
    },
    [applyFlights]
  )

  // Adds a new flight's ghost. If a ghost of exactly these cards that has been on screen is still there - a landed one
  // waiting over the spot the card is now leaving, or (showLive) the snap-back a re-grab ends - the flight carries on
  // with that ghost instance (its key): it is painted, so nothing needs holding. Otherwise the flight's visible face-up
  // cards are marked as taking off (cardFacePaint.ts) right here, synchronously - before the move's own commit renders -
  // so their sources (and any other landed ghost of them, see the paint wait below) keep drawing them until this ghost
  // shows. A show() flight (`inStartOrder`) also joins the start queue (startQueueRef), adopted or not.
  const addFlight = useCallback(
    (id: number, mountGate: MountGate, content: GhostContent, live: FlightValues, own: FlightValues, handedOff: SharedValue<number>, inStartOrder: boolean, candidate?: FlightEntry) => {
      const adopted = candidate && adoptable(candidate, content) ? candidate : modelRef.current.find((f) => f.landed && adoptable(f, content))
      const releasePending = adopted ? () => {} : markGhostPending(visibleFaceIds(content))
      const shown = { current: false }
      const ticket: StartTicket | null = inStartOrder ? { id, ready: false, open: () => mountGate.open() } : null
      const onVisible = () => {
        shown.current = true
        if (ticket) {
          ticket.ready = true
          drainStarts()
        } else mountGate.open()
        releasePending()
      }
      const entry: FlightEntry = { id, key: adopted ? adopted.key : id, mountGate, releasePending, prePainted: !!adopted, onVisible, shown, content, live, own, handedOff }
      // Queued before the model changes, so the prune in applyFlights finds it among the flights it keeps.
      if (ticket) startQueueRef.current.push(ticket)
      applyFlights((prev) => [...(adopted ? prev.filter((f) => f.id !== adopted.id) : prev), entry])
      return releasePending
    },
    [applyFlights, drainStarts]
  )

  // Retires each landed ghost once none of its cards has a face still loading on the board and none is taking off with a
  // ghost not on screen yet (whenCardsSettled - at once if neither: a layout effect, so in the same frame as the reveal,
  // exactly as before), or after LANDED_GHOST_MAX_MS. Runs after the board's own layout effects in the landing commit
  // (this provider is an ancestor of the board), so the face the reveal mounted has already reported itself as loading.
  // A newer flight of the same card leaves it in place until that flight's ghost shows (it is drawn above this one), so
  // a card that takes off again right after landing is never missing or blank for a frame.
  const paintWaitsRef = useRef(new Map<number, () => void>())
  useLayoutEffect(() => {
    const waits = paintWaitsRef.current
    for (const [id, cancel] of waits) {
      if (!flights.some((f) => f.id === id)) {
        cancel()
        waits.delete(id)
      }
    }
    for (const f of flights) {
      if (!f.landed || waits.has(f.id)) continue
      // Every card of the ghost, whatever its own face: only the board's faces are ever loading (a ghost's are not
      // tracked), so a card that lands face-down simply has nothing to wait for, and one the reveal turns face-up does.
      const ids = f.content.cards.map((c) => c.id)
      let painted = false
      const cancel = whenCardsSettled(ids, LANDED_GHOST_MAX_MS, () => {
        painted = true
        waits.delete(f.id)
        removeFlight(f.id)
      })
      if (!painted) waits.set(f.id, cancel)
    }
  }, [flights, removeFlight])
  useEffect(() => {
    const waits = paintWaitsRef.current
    return () => {
      waits.forEach((cancel) => cancel())
      waits.clear()
    }
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
    (id: number, mountGate: MountGate, content: GhostContent, live: FlightValues, own: FlightValues, handedOff: SharedValue<number>, source: SharedValue<number> | null, releasePending: () => void): DragFlightHandle => {
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
      // `animate` (the withSpring writes) and this timer both start once the ghost is on screen (MountGate) - a flight started in the same
      // stretch as show() would otherwise be moving, unseen, for as long as the commit that mounts its ghost takes - and, for a show() flight,
      // its turn in the start queue has come (startQueueRef), so it can never start before a flight started ahead of it has shown its ghost.
      // Called before the gate opens, it waits for it; called after, it starts at once - so a flight starts at the later of the two, and one
      // whose flyTo comes after a later flight's lands after it (see startQueueRef).
      function settleAfter(config: WithSpringConfig, onSettled: () => void, animate: () => void, rest?: FlightEntry['rest']) {
        const gen = ++generation
        pendingSettle = onSettled
        mountGate.run(() => {
          if (generation !== gen) return // hidden (or superseded) before it could start: nothing to move, nothing to settle
          animate()
          setTimeout(() => {
            if (generation !== gen) return
            pendingSettle = null
            // Landed, not removed: the ghost stays over the card onSettled reveals until that card's face has painted
            // (see the paint-wait effect in DragGhostProvider). Same task as onSettled, so one commit.
            land(id, rest)
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
          settleAfter(
            config,
            onArrived,
            () => {
              own.dx.value = withSpring(targetX - own.originX.value, config)
              own.dy.value = withSpring(targetY - own.originY.value, config)
            },
            restRect(targetX, targetY, content.cardWidth, content.cardWidth / CARD_ASPECT + Math.max(0, content.cards.length - 1) * content.offsetStep, content.cardWidth / CARD_ASPECT, Math.abs(rotationRef.current) === 90)
          )
        },
        hide() {
          // Also lets go of the persistent values (copying the position, so a later read still
          // answers) - a hidden ghost must never keep a claim on them.
          release()
          unregisterOwner()
          flushPendingSettle()
          generation += 1
          // And of its take-off hold: a ghost hidden before it ever mounted has no unmount to release it.
          releasePending()
          removeFlight(id)
        }
      }
      handleIdsRef.current.set(handle, id)
      return handle
    },
    [playInvalidSound, hapticInvalid, removeFlight, land]
  )

  const controller = useMemo<DragGhostController>(
    () => ({
      cardRegistry,
      show(content, origin) {
        const id = ++nextIdRef.current
        const own = { originX: makeMutable(origin.x), originY: makeMutable(origin.y), dx: makeMutable(0), dy: makeMutable(0) }
        const handedOff = makeMutable(1)
        const mountGate = createMountGate()
        const releasePending = addFlight(id, mountGate, content, own, own, handedOff, true)
        return createFlight(id, mountGate, content, own, own, handedOff, null, releasePending)
      },
      showLive(content, values) {
        // A flight still on these values is a snap-back to be ended by this pick-up (or a drag that
        // never released) - see liveOwnersRef. A released, in-flight one is not in the map. Its ghost (painted, showing
        // this very card) carries on as the new drag's: a fresh one would leave the card back at its source for the
        // frame or two it takes to paint.
        const claimed = liveOwnersRef.current.get(values.originX)
        const claimedId = claimed && handleIdsRef.current.get(claimed)
        const candidate = claimedId === undefined ? undefined : modelRef.current.find((f) => f.id === claimedId)
        claimed?.hide()
        const id = ++nextIdRef.current
        const own = { originX: makeMutable(0), originY: makeMutable(0), dx: makeMutable(0), dy: makeMutable(0) }
        const handedOff = makeMutable(0)
        const mountGate = createMountGate()
        const releasePending = addFlight(id, mountGate, content, values, own, handedOff, false, candidate)
        const handle = createFlight(id, mountGate, content, values, own, handedOff, values.originX, releasePending)
        liveOwnersRef.current.set(values.originX, handle)
        return handle
      }
    }),
    [cardRegistry, createFlight, addFlight]
  )

  return (
    <DragGhostContext.Provider value={controller}>
      {children}
      {/* Always mounted (regardless of `flights`) so `frame` above can measure its real
      position - a card's own screen-space origin is only correct once this measurement lands,
      which needs the view to already exist. */}
      <View ref={overlayRef} pointerEvents='none' style={StyleSheet.absoluteFill}>
        {flights.map((flight) => (
          <FlightGhostCard key={flight.key} onVisible={flight.onVisible} releasePending={flight.releasePending} prePainted={flight.prePainted} content={flight.content} live={flight.live} own={flight.own} handedOff={flight.handedOff} frame={frame} landed={!!flight.landed} />
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
  },
  unpainted: {
    opacity: 0
  }
})
