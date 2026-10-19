import { CARD_ASPECT, CardSizeProvider } from '@tastic/cards'
import { rotateInsets, useRotation } from '@tastic/core'
import { createContext, memo, ReactNode, Ref, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withDelay, withSpring, WithSpringConfig, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Card } from '@/engine/types'

import { FaceLoadTrackingContext, GHOST_PAINT_MAX_MS, whenCardsSettled } from '../cardFacePaint'
import { GAME_CONTENT_TOP_PADDING } from '../gameLayout'
import { OverlayFrame, toLocal, useOverlayFrame } from '../overlayFrame'
import { PlayingCard } from '../PlayingCard'
import { isMotionReduced } from '../reducedMotionFlag'
import { useCardSoundEffects } from '../useCardSounds'
import { DEAL_SPRING } from './dealSpring'
import { ScreenPoint } from './measureView'

export interface DealCardSpec {
  cardId: string
  card: Card
  from: ScreenPoint
  to: ScreenPoint
  delayMs: number
  /**
   * A take-off hold the caller took on this card (cardFacePaint.ts's markGhostPending) just before the commit that took it
   * out of its pile, so the pile keeps drawing it where it was (PileView's held cards) until its ghost is on screen there -
   * an undo flying dealt cards back to the stock (Spider, Scorpion, Aces Up): from that commit to a card's own take-off there
   * is the destination's measurement, this pool's mount and the card's whole stagger (plus a face-up ghost's paint wait),
   * and the card used to be drawn NOWHERE for all of it. DealLayer calls it exactly once per entry: TAKE_OFF_RELEASE_LAG_MS
   * after the card takes off (its ghost is shown over the spot it leaves - after a face-up ghost's paint wait, the instant
   * onCardDealt fires - and the lag covers the UI thread showing it a frame or so late), or at once on whatever ends the
   * card's flight before that - a skip tap, a newer start() (an empty one included), the provider unmounting, Reduce
   * Motion's instant landing - and never after the card has landed.
   */
  releasePending?: () => void
}

export interface DealAnimator {
  /** Kicks off every entry's independently-delayed spring flight in parallel. `cardWidth` is the
   * caller screen's actual current card size - ghosts render inside their own CardSizeProvider fed
   * by this value, since DealProvider (like the existing single-card DragGhostProvider) renders as
   * a sibling of its own {children}, outside whatever CardSizeProvider the screen itself sets up.
   * onCardLanded fires once per entry as its flight settles (naturally or via skip); onAllLanded
   * fires once every entry has landed. Passing an empty list calls onAllLanded immediately.
   * The optional onCardDealt is the take-off counterpart of onCardLanded: it fires once per entry at the
   * instant that card's own flight begins - its ghost is drawn over the spot it leaves, the same moment its
   * click/buzz plays - never before, and for every card that had not taken off yet when the skip tap landed
   * the whole deal at once. It is silenced by a cancel/restart exactly like onCardLanded (a caller can use it
   * to empty a source pile only once the last card has actually left it). Omitting it changes nothing.
   * The optional `spring` is every card's flight - the deal's own DEAL_SPRING when omitted. Klondike's and Canfield's
   * draw-3 fans (and their undo) pass dragSpring.ts's FLIGHT_SPRING, so a drawn card flies for the same time as every
   * other card move; deals keep the deal's pace.
   * Each entry's optional releasePending is called exactly once - TAKE_OFF_RELEASE_LAG_MS after its card's take-off, or
   * wherever its flight ends before that (see DealCardSpec). */
  start(entries: DealCardSpec[], cardWidth: number, onCardLanded: (cardId: string) => void, onAllLanded: () => void, onCardDealt?: (cardId: string) => void, spring?: WithSpringConfig): void
}

const DealContext = createContext<DealAnimator | null>(null)

// A deal used to mount a ghost (a full PlayingCard) for EVERY dealt card, a second temporary copy of the board, and
// throw each one away as it landed: ~52 mounts + ~52 unmounts of full card art per deal, measured at roughly half of
// a deal's remaining JS cost. Now the ghosts are a small fixed POOL of reusable slots. A slot is launched shortly
// before a card's flight begins (LOOKAHEAD_MS - enough for the face swap to commit), flies it, and is handed the next
// card once it lands. A face-down deal (Klondike, Spider, Scorpion...) swaps between identical card backs, so reuse
// costs no React work at all; a face-up deal only re-renders a face instead of mounting one.
const LOOKAHEAD_MS = 150
const LAUNCH_TICK_MS = 50
// A launch pass used to hand EVERY card due within the lookahead to a slot in one go, i.e. one React commit: at the start of a
// face-up deal that is ~5-9 cards, and a court card's face is ~100-150 SVG nodes, so that one commit stalled the JS thread
// for long enough to delay the departures it was meant to feed. A pass now launches at most MAX_FACE_UP_LAUNCHES_PER_PASS
// face-up cards and, when it stops short, comes back after CAPPED_TICK_MS instead of the usual LAUNCH_TICK_MS. Throughput
// stays far above what a deal needs (2 per 16ms = ~125 launches/s against ~30/s at the deal's stagger), and the lookahead
// leaves room for the delayed ones. Face-down cards swap between identical backs (nothing to commit), so they are never capped.
const MAX_FACE_UP_LAUNCHES_PER_PASS = 2
const CAPPED_TICK_MS = 16
// A slot stays occupied a little past its flight: its landing timer can fire late, and it is only offered for reuse once the
// commit that hides it (and reveals the real card) has happened. The pool is sized for that turnaround too, so a busy JS
// thread does not leave a due card waiting for a slot.
const SLOT_TURNAROUND_MS = 80
// Spare slots beyond the computed peak.
const POOL_SLACK = 2
// After a JS stall every card that came due meanwhile launches at once; cards that are LATE are spaced at least this far
// apart so they stream out instead of leaving as one blob (on-time cards always keep their own scheduled time).
const LATE_LAUNCH_MIN_GAP_MS = 12
// A landing is only revealed once the ghost's OWN shared values (tx/ty) actually read this close to
// its destination - comfortably above the spring's genuine settling residual (this app's own dragSpring
// tests require the equivalent well under 1px against Reanimated's real spring math), so this never
// fires early on a still-animating ghost. Confirmed live: a plain `wait + duration` timer (this used
// to be exactly that) fires on the JS thread's own clock, which keeps time fine even while the UI
// thread is too busy (mounting the deal's own ~52-card initial board commit, worst right at a deal's
// start) to have actually run the spring at all yet - a handful of the earliest-launched cards per
// deal reported "landed" while their ghost was still sitting at (or near) its ORIGIN, then popped to
// the real card far away the instant the swap happened. Never every card (most launch once that
// initial congestion has cleared) and never the same handful twice (which JS/UI thread scheduling
// happens to starve is real-device-timing-dependent) - "a small percentage, inconsistent," exactly as
// reported and reproduced.
const SETTLE_CHECK_PX = 4
const SETTLE_POLL_MS = 16
// However much EXTRA time (beyond the nominal wait+duration) checkSettled may keep polling before
// giving up and revealing the real card anyway - a genuinely stuck ghost (UI thread starved far
// longer than one busy commit) must still resolve, not stall forever.
const SETTLE_MAX_EXTRA_MS = 1000
/**
 * The shortest gap between two beats of a deal's click-and-buzz (dealBeatTicks). A deal plays its click and haptic on a steady
 * beat, not once per card (Jay, 2026-10-17: the deal should have a rhythmic haptic): every card used to fire both from its own
 * take-off timer, throttled to one per 40ms, so they came every second or third card at uneven gaps that followed every JS
 * hiccup, ~25 a second, and each iOS haptic is a call on the main thread, where the flights are drawn. 60ms makes the beat
 * every second card of a 28-card deal (68ms), every fourth of a compressed 52-card one (72ms), every second face-up card (67-88ms).
 */
export const DEAL_BEAT_MIN_GAP_MS = 60

/** The deal's beat: the take-off times (`delays`, ms on the deal's own clock) the click and buzz fire at - the first card's, then
 * the next card's at least `minGapMs` after the last beat. A deal's delays are a regular grid (a stagger per card), so the beats
 * are too: every Nth card. Cards that leave together are one beat. Ascending, whatever order `delays` is in. */
export function dealBeatTicks(delays: number[], minGapMs: number = DEAL_BEAT_MIN_GAP_MS): number[] {
  const beats: number[] = []
  for (const delay of [...delays].sort((a, b) => a - b)) {
    // Half a millisecond of slack: a fractional stagger (34.07ms) times two must not round down below the gap.
    if (beats.length === 0 || delay - beats[beats.length - 1] >= minGapMs - 0.5) beats.push(delay)
  }
  return beats
}
/**
 * How long after a card takes off its source is told to let go of it (DealCardSpec.releasePending) - not in the take-off
 * itself. The ghost turns visible on the UI thread (takeOff's `withDelay(wait, ...)` opacity), whose delay only starts
 * counting once the UI thread has picked the assignment up, a frame or so after the JS write (dragSpring.ts's
 * SPRING_START_LAG_MS is the same hop for a spring), and then lands on a frame boundary; the release is a JS timer on the
 * JS clock, and the commit that drops the held card could reach the screen a frame BEFORE the ghost showed - a frame of the
 * card gone from its pile (the card under it, or an empty slot) at a take-off, the very gap the hold exists to close. Late
 * costs nothing visible: the ghost is drawn over that spot and has only just started to move. The same lag, for the same
 * race, as Pyramid's SWEEP_PILE_BLANK_LAG_MS (a win-sweep pile blanking after its last card's onCardDealt). Only a natural
 * take-off waits it out: a skip, a landing, a cancel or an unmount gives the hold back at once.
 */
export const TAKE_OFF_RELEASE_LAG_MS = 20

/** How many ghost slots a deal needs: the most flights that can overlap, counting each ghost as occupied from
 * `lookaheadMs` before its flight starts until the flight ends (`durationMs` after it). Two flights overlap when their
 * start delays are closer than lookahead + duration, so this is the busiest such window over the sorted delays. */
export function ghostPoolSize(delays: number[], durationMs: number, lookaheadMs: number, slack: number): number {
  if (delays.length === 0) return 0
  const sorted = [...delays].sort((a, b) => a - b)
  const window = durationMs + lookaheadMs
  let peak = 1
  let lo = 0
  for (let hi = 0; hi < sorted.length; hi++) {
    while (sorted[hi] - sorted[lo] >= window) lo++
    peak = Math.max(peak, hi - lo + 1)
  }
  return Math.min(sorted.length, peak + slack)
}

/** The ghost pool a deal with these flight start delays mounts, each flight lasting `durationMs` (see ghostPoolSize for what
 * the numbers mean). */
export function dealPoolSize(delays: number[], durationMs: number = DEAL_SPRING.duration ?? 0): number {
  return ghostPoolSize(delays, durationMs, LOOKAHEAD_MS + SLOT_TURNAROUND_MS, POOL_SLACK)
}

export function useDealAnimator(): DealAnimator {
  const ctx = useContext(DealContext)
  if (!ctx) throw new Error('useDealAnimator must be used within a DealProvider')
  return ctx
}

interface GhostSlotHandle {
  /** Points this slot at `spec` and starts its flight after `spec.delayMs` (already rebased onto this call), flying on
   * `spring` (the deal's - see DealAnimator.start). `order` is the card's position in the deal, so a later card always
   * paints above an earlier one whichever slot it landed in. */
  launch(spec: DealCardSpec, order: number, spring: WithSpringConfig): void
  /** Jumps a flight in progress straight to the landing point and notifies immediately, skipping whatever's left of the
   * delay/spring - used when the whole deal is tapped-to-skip. A no-op on an idle slot. */
  completeNow(): void
  /** Silences the slot for good without notifying anyone: its timers stop and its flight is forgotten. Used when a new deal
   * replaces this one - the old slots stay mounted until the commit that swaps them out, and a timer firing in that gap
   * must not report a card to the NEW deal. A take-off hold still waiting out TAKE_OFF_RELEASE_LAG_MS is given back now (its
   * ghost goes with the cancel); its card's hold, if it had not taken off, is the provider's to give back (start()'s
   * releaseAll), not this slot's. */
  cancel(): void
}

interface GhostSlotProps {
  slot: number
  /** Which deal this slot belongs to (DealProvider's generation). Every callback carries it back so a slot that outlives
   * its deal - replaced by a new start() but not yet unmounted - can never report into the new one. */
  deal: number
  /** Fires once a card's own flight actually begins (its delayMs elapses) - see DealProvider's handleDealt, which tells
   * the caller (DealAnimator.start's onCardDealt) that this card has taken off. The click and buzz are not per card: they
   * follow the deal's beat (dealBeatTicks). */
  onDealt: (cardId: string, deal: number) => void
  /** The card has landed (naturally or via skip). */
  onLanded: (cardId: string, deal: number) => void
  /** The slot is hidden again and free to be launched. Fired from an effect - i.e. AFTER the commit that hid this slot and
   * (in the same batch) revealed the real card underneath - never from the landing callback itself: relaunching a slot in
   * the very tick it landed would write its reset to the UI thread ahead of that commit and blink a card-shaped hole. */
  onIdle: (slot: number, deal: number) => void
  /** A landed card is being held on screen (true) until the real card under it has painted its face, or no longer is
   * (false) - see GhostSlot's `holding`. Called synchronously in the landing task, so the provider keeps the pool
   * mounted through the commit that ends the deal. `rect` (screen space) is where it rests; `release` ends the hold. */
  onHold: (slot: number, deal: number, hold: { rect: HoldRect; release: () => void } | null) => void
  /** The overlay's own placement (see DealProvider's useOverlayFrame) - converts spec.from/to from
   * screen space into the overlay's own space so a card lands exactly where it was measured,
   * regardless of where this screen-level overlay itself happens to sit relative to the true
   * viewport origin, or how far it's rotated under a landscape hold. */
  frame: OverlayFrame
  /** The deal's card width - the ghost's own footprint for that conversion. */
  cardWidth: number
  /** When the most recent card actually took off (epoch ms), shared by every slot of the deal. A card that reaches its slot's
   * effect with no runway left - its own launch commit ate the whole delay - departs at once, but not in the same breath as
   * the card before it: without this, two cards launched in one slow commit both find their deadline passed and leave in the
   * same frame. */
  lastTakeOffRef: { current: number }
  ref?: Ref<GhostSlotHandle>
}

/** Where a landed card rests, screen space. */
interface HoldRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * How long a slot may keep a landed card on screen, waiting for the real card under it to paint its face (see
 * cardFacePaint.ts: a card mounted in the landing commit gets its bitmap a frame or two later, and until then it is a blank
 * face). Normally a frame or two; this only bounds a load that never reports. Kept short - the slot is already free to be
 * relaunched (a relaunch ends the hold), and the pool stays mounted past the deal's end until every hold is over.
 */
export const DEAL_LANDED_MAX_MS = 150

/** A card waiting in the provider's queue for a free slot. */
interface QueuedCard {
  spec: DealCardSpec
  /** The card's position in the deal (becomes its paint order). */
  order: number
}

/** What a face-up card's Image shows: identical cards from two decks share one bitmap. */
const faceKey = (card: Card) => `${card.suit}-${card.rank}`

/**
 * Wraps a caller's take-off hold release (DealCardSpec.releasePending) for one deal: kept in `releases` until it runs, so
 * the paths that end a card's flight before its take-off can give back every hold still outstanding at once (releaseAll),
 * and safe to run from all of them - the caller still sees exactly one call. A throw is re-thrown from a timer, like
 * handleDealt's, so it can't abort a skip's or a cancel's loop over the other cards' holds.
 */
function trackRelease(releases: Set<() => void>, release: () => void): () => void {
  let done = false
  const tracked = () => {
    releases.delete(tracked)
    if (done) return
    done = true
    try {
      release()
    } catch (error) {
      setTimeout(() => {
        throw error
      }, 0)
    }
  }
  releases.add(tracked)
  return tracked
}

/** Runs every hold release still in `releases` (see trackRelease). */
function releaseAll(releases: Set<() => void>) {
  const outstanding = [...releases]
  releases.clear()
  outstanding.forEach((release) => release())
}

interface Job extends QueuedCard {
  /** The absolute time (epoch ms) this card's flight begins. Fixed when the slot is launched, so however long the React commit
   * that shows the card takes (a court-card face is tens of ms), the springs and timers below count down from the launch,
   * not from whenever that commit finished - the commit is absorbed by the lookahead instead of pushing the departure late. */
  departAt: number
  /** The flight's spring (see DealAnimator.start). */
  spring: WithSpringConfig
}

// Memoized: props are all stable across the deal (a slot number, stable callbacks, the overlay frame, the card width),
// so a slot re-renders only through its own state - i.e. when it is launched or lands.
const GhostSlot = memo(function GhostSlot({ slot, deal, onDealt, onLanded, onIdle, onHold, frame, cardWidth, lastTakeOffRef, ref }: GhostSlotProps) {
  const cardHeight = cardWidth / CARD_ASPECT
  const tx = useSharedValue(0)
  const ty = useSharedValue(0)
  // Starts (and is reset to, on every launch) invisible, then pops straight to fully visible - not eased - the instant
  // its delayed flight actually begins: a fade here read as sluggish against DEAL_SPRING's snappy, energetic-dealer
  // pace (see dealSpring.ts). Without it, a card whose own delay hasn't elapsed yet would sit motionless at full opacity
  // on top of the deck, its identity flickering to a different card every stagger (confirmed live on Pyramid/FreeCell).
  const opacity = useSharedValue(0)
  // What this slot is currently showing. Kept after the flight lands (the slot is only hidden, not torn down), and
  // left untouched when the next card looks identical (a face-down deal), so a relaunch costs no React work there.
  const [card, setCard] = useState<Card | null>(null)
  // The flight in progress, or null while the slot is idle. React state (not a shared value) on purpose: it hides the
  // slot in the SAME commit that reveals the real destination card (see the caller's onCardLanded), which a UI-thread
  // opacity write made a moment earlier could not - that would blink a card-shaped hole for a frame at every landing.
  const [job, setJob] = useState<Job | null>(null)
  // The card that has just landed, still drawn (same pixels as the real card the landing reveals under it) until that real
  // card's face has painted - a face mounted in the landing commit is blank for a frame or two (cardFacePaint.ts). The
  // slot itself is idle (job null) the whole time, so the pool's bookkeeping is unchanged; a relaunch ends the hold.
  const [holding, setHolding] = useState<Job | null>(null)
  // Ending a hold is how a slot goes idle after a flight (cancel() resets itself). An idle slot is hidden by its wrapper
  // (styles.idle), but its card box keeps the last flight's opacity (1) and position on the UI thread. A relaunch writes
  // them back to the origin/0 before the React commit that shows the wrapper again, but those are UI-thread writes and
  // that commit can reach the screen first: the slot was then drawn for one frame at its PREVIOUS landing spot, over the
  // real card that had landed there (pixel-found on the Simulator: a card back flashing over a just-dealt face-up card,
  // ~1 in 20 deals, in recordings from before the paint work too). So the opacity goes back to 0 here, as the hold ends -
  // normally frames before any relaunch, while the wrapper hides the box anyway - and a commit that beats a relaunch's
  // writes shows an invisible box. Not while a flight is running: a relaunch has taken the slot over (jobRef is set in
  // launch(), before its commit cancels this hold's wait). Through a ref, as a callback: the compiler freezes a shared
  // value once it is handed to a hook, and the take-off below still writes it.
  const opacityRef = useRef(opacity)
  const jobRef = useRef<Job | null>(null)
  const releaseHold = useCallback(() => {
    if (!jobRef.current) opacityRef.current.value = 0
    setHolding(null)
  }, [])
  const dealt = useRef(false)
  const notified = useRef(false)
  const dealtTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The face this slot's Image has painted (suit-rank: two decks' identical cards share one bitmap, and an unchanged source
  // never reloads), and the take-off waiting on the next one (see the [job] effect).
  const paintedFaceRef = useRef<string | null>(null)
  const paintWaiterRef = useRef<(() => void) | null>(null)
  const paintTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearTimers = useCallback(() => {
    if (dealtTimeoutRef.current) clearTimeout(dealtTimeoutRef.current)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    if (paintTimeoutRef.current) clearTimeout(paintTimeoutRef.current)
    dealtTimeoutRef.current = null
    timeoutRef.current = null
    paintTimeoutRef.current = null
    paintWaiterRef.current = null
  }, [])
  // A take-off hold release waiting out TAKE_OFF_RELEASE_LAG_MS (see dealtNotify), and its timer. Deliberately not one of
  // clearTimers' timers: those are dropped when the flight's `job` changes and on a cancel, and a release must never be
  // dropped - whatever ends the wait early runs it instead (flushRelease).
  const lateReleaseRef = useRef<(() => void) | null>(null)
  const lateReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushRelease = useCallback(() => {
    if (lateReleaseTimerRef.current) clearTimeout(lateReleaseTimerRef.current)
    lateReleaseTimerRef.current = null
    const release = lateReleaseRef.current
    lateReleaseRef.current = null
    release?.()
  }, [])

  // Reports this card's take-off the moment it's dealt out (see DealProvider's handleDealt) - guarded the same
  // way notify() below is, so completeNow's forced path doesn't double-fire it for a card whose delay had already
  // elapsed naturally before the skip. It is also where the card's source is told to let go of it (spec.releasePending -
  // see DealCardSpec): TAKE_OFF_RELEASE_LAG_MS after this, its ghost having been set to turn visible over that very spot in
  // this same instant (takeOff's opacity, on the same `wait`) - the UI thread can show the ghost a frame or so after this JS
  // timer - and a face-up ghost only gets here once its face has painted (the [job] effect's wait). A skip's completeNow
  // lands the card right after calling this, and notify() gives the hold back there and then: its ghost has jumped straight
  // to the landing, so there is no take-off left to cover.
  const dealtNotify = useCallback(
    (spec: DealCardSpec) => {
      if (dealt.current) return
      dealt.current = true
      if (spec.releasePending) {
        // Nothing is waiting here (the slot's last card landed - and so gave its hold back - before it was relaunched), but a
        // release is never overwritten: one still waiting runs now.
        flushRelease()
        lateReleaseRef.current = spec.releasePending
        lateReleaseTimerRef.current = setTimeout(flushRelease, TAKE_OFF_RELEASE_LAG_MS)
      }
      onDealt(spec.cardId, deal)
    },
    [onDealt, deal, flushRelease]
  )

  // Both the natural settle path (the effect below) and completeNow's forced path funnel through this, each guarded so a
  // card is only ever reported landed once per launch.
  const notify = useCallback(() => {
    if (notified.current) return
    notified.current = true
    // A card that lands while its take-off hold is still waiting out its lag (a skip right after its take-off, or a flight
    // shorter than the lag) gives it back first: a source must never still draw a card that has arrived somewhere else.
    flushRelease()
    const landed = jobRef.current
    jobRef.current = null
    setJob(null)
    if (landed) {
      setHolding(landed)
      onHold(slot, deal, { rect: { x: landed.spec.to.x, y: landed.spec.to.y, width: cardWidth, height: cardHeight }, release: releaseHold })
      onLanded(landed.spec.cardId, deal)
    }
  }, [flushRelease, onLanded, onHold, releaseHold, slot, deal, cardWidth, cardHeight])

  // Ends the hold once the real card's face has painted and the card is not taking off again with a ghost not on screen yet
  // (whenCardsSettled: Spider sweeps a run its dealt card completes in that card's own landing commit) - at once, in this
  // same commit, if neither: a layout effect, after the board's own layout effects in the landing commit, so a face the
  // landing mounted has reported - or after DEAL_LANDED_MAX_MS.
  useLayoutEffect(() => {
    if (!holding) return
    const cancel = whenCardsSettled([holding.spec.cardId], DEAL_LANDED_MAX_MS, releaseHold)
    return () => {
      cancel()
      onHold(slot, deal, null)
    }
  }, [holding, releaseHold, onHold, slot, deal])

  function takeOff({ spec, departAt, spring }: Job) {
    // What is left of the delay: the commit that got us here has already spent part of it (see Job.departAt). A card whose
    // deadline has already passed leaves now, but no closer than LATE_LAUNCH_MIN_GAP_MS to the card before it (the same
    // spacing launchDue gives late launches); an on-time card keeps its scheduled time exactly.
    const now = Date.now()
    let takeOffAt = Math.max(departAt, now)
    if (departAt <= now) takeOffAt = Math.max(takeOffAt, lastTakeOffRef.current + LATE_LAUNCH_MIN_GAP_MS)
    lastTakeOffRef.current = Math.max(lastTakeOffRef.current, takeOffAt)
    const wait = takeOffAt - now
    tx.value = withDelay(wait, withSpring(spec.to.x, spring))
    ty.value = withDelay(wait, withSpring(spec.to.y, spring))
    opacity.value = withDelay(wait, withTiming(1, { duration: 0 }))
    // Deliberately its own timer rather than piggybacked on the settle one below - this card's sound/haptic should fire
    // the instant it's dealt out (the departure), not once it's finished flying.
    dealtTimeoutRef.current = setTimeout(() => dealtNotify(spec), wait)
    // Settlement used to be driven by withSpring's own completion callback (one per axis, both required before
    // notifying) - that callback was found to never fire at all for these duration-based springs on this app's web
    // target (confirmed live via DragGhostLayer.tsx's identical bug, fixed the same way there). A plain `wait + duration`
    // timer stood in for it next - correct AS LONG AS the UI thread actually ran the spring on schedule, which a busy
    // commit (this deal's own ~52-card initial board mount, worst right at a deal's start) can't guarantee: the JS timer
    // keeps time regardless, so it could fire while the ghost was still sitting at its ORIGIN, revealing the real card
    // far from where the ghost had actually gotten to (see SETTLE_CHECK_PX's own comment - confirmed live, reproduced,
    // and this is the fix). checkSettled polls the ghost's OWN shared values instead of trusting the clock, and only
    // calls notify() once they genuinely read close to the destination (or SETTLE_MAX_EXTRA_MS has passed, so a truly
    // stuck ghost still resolves rather than stalling the deal forever).
    const nominalSettleAt = Date.now() + wait + (spring.duration ?? 0)
    const checkSettled = () => {
      const dx = Math.abs(tx.value - spec.to.x)
      const dy = Math.abs(ty.value - spec.to.y)
      if (dx <= SETTLE_CHECK_PX && dy <= SETTLE_CHECK_PX) {
        notify()
      } else if (Date.now() >= nominalSettleAt + SETTLE_MAX_EXTRA_MS) {
        // A truly stuck ghost must still resolve rather than stall the deal forever - but revealing
        // the real card while the ghost is still wherever it got stranded is EXACTLY the original bug
        // this whole mechanism exists to prevent (confirmed live: this branch used to call notify()
        // unconditionally here, with no position check at all - "structurally impossible" was only
        // ever true of the fast path above, never of this fallback, and a direct JS-thread lag probe
        // proved the fallback is far from rare: the thread was stalled MORE than it was free for over
        // half of a real deal's total duration). Snap the ghost to its true destination first - an
        // instant jump, still visible as a discontinuity, but the ghost's own last rendered position
        // and the real card's position are the same pixel the moment the swap happens, so the reveal
        // itself is never wrong, only occasionally abrupt for a ghost this badly starved.
        cancelAnimation(tx)
        cancelAnimation(ty)
        tx.value = spec.to.x
        ty.value = spec.to.y
        notify()
      } else {
        timeoutRef.current = setTimeout(checkSettled, SETTLE_POLL_MS)
      }
    }
    timeoutRef.current = setTimeout(checkSettled, wait + (spring.duration ?? 0))
  }

  useEffect(() => {
    if (!job) return
    const { spec, departAt } = job
    // A face-up card's face is an Image that paints a frame or two after the commit that set it (cardFacePaint.ts): blank in
    // a slot's first flight, the previous card's face in a reused one. The usual LOOKAHEAD_MS covers that before the card is
    // due, but a card with no runway (a deal's first, or one launched late after a stall) would take off showing it - seen on
    // the Simulator as the first two cards of a Pyramid deal flying blank. So the take-off waits for the face, but never past
    // the later of the card's own departure and GHOST_PAINT_MAX_MS after now: a card with that much runway is never late.
    // A back unmounts the face Image: whatever it painted is gone.
    if (!spec.card.faceUp) paintedFaceRef.current = null
    if (spec.card.faceUp && paintedFaceRef.current !== faceKey(spec.card)) {
      const go = () => {
        if (paintTimeoutRef.current) clearTimeout(paintTimeoutRef.current)
        paintTimeoutRef.current = null
        paintWaiterRef.current = null
        takeOff(job)
      }
      paintWaiterRef.current = go
      paintTimeoutRef.current = setTimeout(go, Math.max(departAt - Date.now(), GHOST_PAINT_MAX_MS))
    } else {
      takeOff(job)
    }
    return clearTimers
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job])

  // Offers the slot for reuse once it has gone idle - from an effect, so the hide (and the caller's reveal, batched with it)
  // has committed first. `flew` keeps the very first render (job null, never launched) from counting as a landing.
  const flew = useRef(false)
  useEffect(() => {
    if (job) {
      flew.current = true
      return
    }
    if (flew.current) {
      flew.current = false
      onIdle(slot, deal)
    }
  }, [job, onIdle, slot, deal])

  // Clears any timer still pending if this slot goes away mid-flight (Home, or a new deal replacing this one), and gives back
  // a take-off hold still waiting out its lag - its ghost goes with the slot. (Every path that unmounts a slot also has the
  // provider give back all of its deal's outstanding holds - releaseAll in start(), at the deal's end and on its own unmount -
  // so this only keeps the slot from leaving a timer behind; a release runs once either way, see trackRelease.)
  useEffect(
    () => () => {
      clearTimers()
      flushRelease()
    },
    [clearTimers, flushRelease]
  )

  useImperativeHandle(
    ref,
    () => ({
      launch(spec, order, spring) {
        clearTimers()
        dealt.current = false
        notified.current = false
        // Repositioned and hidden BEFORE the React commit that shows the slot again, so the previous card's landing spot
        // is never visible for even a frame. (A plain write also cancels whatever spring was still settling.)
        tx.value = spec.from.x
        ty.value = spec.from.y
        opacity.value = 0
        const next: Job = { spec, order, departAt: Date.now() + spec.delayMs, spring }
        jobRef.current = next
        setCard((prev) => (prev && !prev.faceUp && !spec.card.faceUp ? prev : spec.card))
        // A relaunch ends a hold still showing this slot's last card (unregistered at once - see handleHold).
        setHolding(null)
        onHold(slot, deal, null)
        setJob(next)
      },
      completeNow() {
        const current = jobRef.current
        if (!current) return
        clearTimers()
        tx.value = current.spec.to.x
        ty.value = current.spec.to.y
        opacity.value = 1
        // A card whose delay hadn't elapsed yet when the skip landed still gets its one sound/haptic (and its take-off
        // notification) here - a card that had already fired dealtNotify naturally is a no-op via its own guard. Either way
        // its hold goes back in notify(), at once and before the card is reported landed: no lag, the ghost is already at the
        // landing.
        dealtNotify(current.spec)
        notify()
      },
      cancel() {
        clearTimers()
        // (start() gives back every outstanding hold right after cancelling its slots anyway - releaseAll - so this only keeps
        // the lag timer from outliving the deal.)
        flushRelease()
        // Stop whatever spring is still running - without this, a slot cancelled mid-flight (a new
        // deal replacing this one) kept animating on the UI thread toward ITS OLD deal's destination
        // (nothing had ever told Reanimated to stop), visibly landing there and just sitting, frozen,
        // showing the old deal's card - until this same slot index was eventually reused by the NEW
        // deal's own launch(), whose plain value writes finally overwrote it. Confirmed live: rapid
        // repeated "New Game" taps (a new deal starting while the previous one still had ghosts mid-
        // flight) made a card visibly fly to a stale, meaningless position and sit there before
        // "snapping" once its slot was recycled - this is the fix, not a scheduling/pacing change.
        cancelAnimation(tx)
        cancelAnimation(ty)
        cancelAnimation(opacity)
        opacity.value = 0
        jobRef.current = null
        dealt.current = true
        notified.current = true
        // React state too, not just the ref - job still non-null in state left this slot rendering
        // with a real zIndex (not styles.idle) for however long it took the generation-keyed unmount
        // to actually commit, which is exactly the window the frozen ghost was visible in.
        setJob(null)
        setHolding(null)
        onHold(slot, deal, null)
      }
    }),
    [clearTimers, flushRelease, dealtNotify, notify, tx, ty, opacity, onHold, slot, deal]
  )

  // Both the slot wrapper and the animated card box carry an explicit card size. Neither NEEDS one for
  // layout (the card inside sizes itself, and the wrapper's only children are absolute), but without it
  // each lays out as an exactly-zero frame at the overlay's origin - and that specific frame triggers a
  // React Native (Fabric, iOS) view-recycling bug that put a ghost on the wrong ROW for the whole deal:
  // RCTViewComponentView's prepareForRecycle resets its stored _layoutMetrics to a default-constructed,
  // ZERO frame (not EmptyLayoutMetrics, whose size is -1x-1), so when the recycled UIView is reused for a
  // view whose new frame is also zero, updateLayoutMetrics sees "frame unchanged" and never resets the
  // view's center/bounds - the UIView keeps the position of its PREVIOUS life. A New Game unmounts every
  // real tableau card (PileView does not mount a card whose flight has not landed), and each card's outer
  // view has frame (0, index * fanOffset) inside its column; a slot wrapper that drew one of those from the
  // recycle pool sat at y = index * fanOffset, so every card that slot ever flew rendered exactly that many
  // fan steps too low (x untouched), from its very first flight, with the shared values, the shadow tree
  // and measureInWindow all reporting the correct position. Confirmed frame-by-frame on the Simulator
  // (offsets of exactly 4 and 5 fan steps, always on the same slots) and gone once the frame is non-zero.
  // The same guard is on DragGhostLayer's ghost container, which had the same zero-frame shape.
  const slotSize = useMemo(() => ({ width: cardWidth, height: cardHeight }), [cardWidth, cardHeight])

  const style = useAnimatedStyle(() => {
    const p = toLocal(tx.value, ty.value, cardWidth, cardHeight, frame)
    return { opacity: opacity.value, transform: [{ translateX: p.x }, { translateY: p.y }] }
  })

  // A stable element for the card: the slot re-renders on every launch and landing (its `job` changes), and PlayingCard
  // isn't memoized, so building the element inline would re-run it each time even when the card is unchanged. With this,
  // React bails out of the whole card subtree unless `card` itself changed - i.e. a face-down relaunch renders nothing.
  const face = useMemo(() => {
    if (!card) return null
    const onFacePainted = () => {
      paintedFaceRef.current = faceKey(card)
      paintWaiterRef.current?.()
    }
    return <PlayingCard card={card} onFacePainted={card.faceUp ? onFacePainted : undefined} />
  }, [card])

  return (
    // The static wrapper (not the animated opacity) is what hides an idle slot, and it carries the paint order.
    <View testID={`deal-ghost-${slot}`} pointerEvents='none' style={[styles.slot, slotSize, job ? { zIndex: job.order } : holding ? { zIndex: holding.order } : styles.idle]}>
      <Animated.View style={[styles.ghostCard, slotSize, style]}>{face}</Animated.View>
    </View>
  )
})

/** Wraps a game screen so its initial deal can fly N cards independently and simultaneously from
 * the stock pile to their starting positions. Deliberately a separate module from
 * dragdrop/DragGhostLayer.tsx, which only ever supports one flying card/group at a time (drag,
 * tap-to-move) - rather than risk that proven system, this generalizes the same "screen-level
 * overlay, real card content, spring-driven flight" idioms to N simultaneous ghosts instead. */
export function DealProvider({ children }: { children: ReactNode }) {
  const { playCardSound, hapticCard } = useCardSoundEffects()
  // Same rotated-frame safe-area top GameChrome positions its controls from, plus that band's height.
  const rotation = useRotation()
  const topChromeBand = rotateInsets(useSafeAreaInsets(), rotation).top + GAME_CONTENT_TOP_PADDING
  // Read when a card lands (handleHold): a card's screen footprint is its height x width under a quarter turn.
  const rotationRef = useRef(rotation)
  useEffect(() => {
    rotationRef.current = rotation
  }, [rotation])
  // How many ghost slots the current deal mounts (see ghostPoolSize) - NOT one per card.
  const [poolSize, setPoolSize] = useState(0)
  // Slots still holding a landed card on screen (see GhostSlot's `holding`), by slot, with where each rests. The pool stays
  // mounted while any is (`anyHold` - a boolean, so the provider only re-renders when that flips), past the commit that ends
  // the deal: unmounting it there would drop the last cards' holds in the very commit their real cards are revealed in.
  const holdsRef = useRef(new Map<number, { rect: HoldRect; release: () => void }>())
  const [anyHold, setAnyHold] = useState(false)
  // `dealing` as of now (not the last render): while the deal runs the pool is mounted anyway, so `anyHold` is only kept
  // up to date once it has ended - a hold coming and going at every landing must not re-render the provider each time.
  const dealingRef = useRef(false)
  // Whether a deal is in flight at all (drives the skip-tap layer and mounts the pool).
  const [dealing, setDealing] = useState(false)
  const [cardWidth, setCardWidth] = useState(0)
  // Specs not yet launched, in ascending delayMs order (with their paint order), the slots currently free, the deal's
  // clock and the pending launch timer. Only ever touched from start()/timer/landing/skip callbacks, never during render.
  const queueRef = useRef<QueuedCard[]>([])
  const freeSlots = useRef<number[]>([])
  const slotHandles = useRef<(GhostSlotHandle | null)[]>([])
  const startedAtRef = useRef(0)
  const lastDepartAt = useRef(0)
  const lastTakeOffAt = useRef(0)
  const launchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The current deal's flight (see DealAnimator.start's `spring`), set by start().
  const springRef = useRef<WithSpringConfig>(DEAL_SPRING)
  const landedIds = useRef(new Set<string>())
  const callbacksRef = useRef<{ onCardLanded: (cardId: string) => void; onAllLanded: () => void; onCardDealt?: (cardId: string) => void } | null>(null)
  // Cards whose take-off has already been reported to onCardDealt this deal (once per card, whatever route it took).
  const dealtIds = useRef(new Set<string>())
  // The current deal's take-off holds that have not been given back yet (DealCardSpec.releasePending, wrapped by
  // trackRelease). A card's own take-off gives its hold back (GhostSlot's dealtNotify, TAKE_OFF_RELEASE_LAG_MS later), and so
  // does a skip; everything that ends the deal without flying a card - a newer start(), an empty one included, the deal
  // completing with an entry that never flew (a duplicated card id), the provider unmounting - gives back whatever is still
  // in here, so no pile ever keeps drawing a card that is not going to take off (left alone, a hold only ends at its own 1s
  // backstop - over a fresh board).
  const pendingReleasesRef = useRef(new Set<() => void>())
  const totalRef = useRef(0)
  // The deal's click-and-buzz beats still to come (dealBeatTicks: ms on the deal's clock, ascending) and the timer for the next.
  const beatRef = useRef<number[]>([])
  const beatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // When the last beat played (epoch ms) - see runBeat.
  const lastBeatAtRef = useRef(0)
  // Card ids repeat across every deal (same 52 cards, just reshuffled - see deck.ts), and slot numbers repeat across
  // deals too, so keying slots by index alone would let React reuse a still-mounted slot from an overlapping prior deal
  // if start() is ever called again before the previous one finished. A reused instance wouldn't reset its shared-value
  // position (useSharedValue's initial value only applies on a genuine first mount) or its own "already notified" guard,
  // silently stalling that card forever. Folding a monotonic generation into the key instead forces a real
  // unmount+mount - and therefore a full state reset - for every deal, regardless of any overlap with the one before it.
  // The same generation is stamped onto every slot (`deal`) and checked in every callback, because the OLD slots stay
  // mounted (timers live) until the commit after start() - see the ref below, which start() bumps synchronously.
  // The state copy is what render reads (a ref's `.current` can't be read during render).
  const [generation, setGeneration] = useState(0)
  const generationRef = useRef(0)
  const { overlayRef, frame, ready: frameReady } = useOverlayFrame()
  // spec.from/to are screen-space (measureView/CardRegistry.measure, both viewport-relative on
  // web). But this overlay - a screen-level sibling of {children}, not a descendant - isn't
  // necessarily anchored at the true viewport origin: it renders wherever the containing block
  // wrapping this whole screen sits, which can be below a native header (confirmed live on this
  // app's web target - see DragGhostLayer.tsx's identical fix), and under a landscape hold it sits
  // inside FakeLandscapeView's rotated frame. Left uncorrected, every dealt card lands somewhere
  // other than where it was measured - "flies to a spot below its pile, then snaps up" once the
  // real, correctly-flowed destination card is revealed. useOverlayFrame measures the overlay once
  // it mounts (and again on resize/rotation) and toLocal converts each ghost's position - see
  // overlayFrame.ts.

  // One beat of the deal: a click and a buzz together, as every other card move plays them.
  const playBeat = useCallback(() => {
    playCardSound()
    hapticCard()
  }, [playCardSound, hapticCard])

  // Plays the beat that is due and waits for the next, on the deal's own clock (startedAtRef): each beat is timed from the clock,
  // not from the beat before, so a late timer never pushes the rest back. Beats a JS stall made overdue are ONE beat when it
  // ends, not a burst, and the next beat on the clock is dropped if it would follow that one within half a gap - the rhythm
  // skips a beat rather than bunching two up.
  const runBeat = useCallback(
    function runBeat() {
      if (beatTimerRef.current) clearTimeout(beatTimerRef.current)
      beatTimerRef.current = null
      const beats = beatRef.current
      const now = Date.now()
      const elapsed = now - startedAtRef.current
      let due = false
      while (beats.length > 0 && beats[0] <= elapsed) {
        beats.shift()
        due = true
      }
      if (due && now - lastBeatAtRef.current >= DEAL_BEAT_MIN_GAP_MS / 2) {
        lastBeatAtRef.current = now
        playBeat()
      }
      if (beats.length > 0) beatTimerRef.current = setTimeout(runBeat, beats[0] - elapsed)
    },
    [playBeat]
  )

  // Ends the beat. True if it had beats left (a skip then plays one for every card it deals at once).
  const stopBeat = useCallback(() => {
    if (beatTimerRef.current) clearTimeout(beatTimerRef.current)
    beatTimerRef.current = null
    const unplayed = beatRef.current.length > 0
    beatRef.current = []
    lastBeatAtRef.current = 0
    return unplayed
  }, [])

  // A card has been dealt out (see GhostSlot's onDealt) - deliberately not per-card-gated here the way handleLanded is below,
  // since GhostSlot's own dealtNotify guard already ensures this fires exactly once per card regardless of a mid-deal skip.
  const handleDealt = useCallback((cardId: string, deal: number) => {
    if (deal !== generationRef.current) return
    // Reported to the caller after the generation check (so a cancelled/replaced deal is silent, like onCardLanded) and
    // once per card: a duplicated id in the entries takes off twice but is one card to the caller.
    if (dealtIds.current.has(cardId)) return
    dealtIds.current.add(cardId)
    try {
      callbacksRef.current?.onCardDealt?.(cardId)
    } catch (error) {
      // The caller's take-off hook is cosmetic and must not be able to strand the deal: a throw here would abort a skip's
      // landing loop (and leave the skip layer up for good). Re-thrown from a timer instead, so it still surfaces.
      setTimeout(() => {
        throw error
      }, 0)
    }
  }, [])

  // Hands every queued card whose flight starts within LOOKAHEAD_MS to a free slot (with its delay re-based onto its own
  // launch time - a slot's timers/springs all start when it is launched), then reschedules itself while any remain. A
  // card that is due but finds no free slot simply waits: the next slot to go idle calls this again. A pass stops after
  // MAX_FACE_UP_LAUNCHES_PER_PASS face-up cards (one commit's worth) and comes back on the short CAPPED_TICK_MS.
  const launchDue = useCallback(function launchDue() {
    if (launchTimerRef.current) clearTimeout(launchTimerRef.current)
    launchTimerRef.current = null
    const now = Date.now()
    const elapsed = now - startedAtRef.current
    const queue = queueRef.current
    let faceUpLaunched = 0
    let capped = false
    while (queue.length > 0 && freeSlots.current.length > 0 && queue[0].spec.delayMs - LOOKAHEAD_MS <= elapsed) {
      const handle = slotHandles.current[freeSlots.current[0]]
      // The slots mount in the commit after start(); until their handles attach there is nothing to launch into.
      if (!handle) break
      // Enough face-up cards for one commit: the rest go on the next (short) tick - see MAX_FACE_UP_LAUNCHES_PER_PASS.
      if (queue[0].spec.card.faceUp && faceUpLaunched >= MAX_FACE_UP_LAUNCHES_PER_PASS) {
        capped = true
        break
      }
      freeSlots.current.shift()
      const { spec, order } = queue.shift()!
      if (spec.card.faceUp) faceUpLaunched++
      // An on-time card departs exactly when scheduled. A LATE one (a JS stall made it due meanwhile) departs as soon as
      // possible but no closer than LATE_LAUNCH_MIN_GAP_MS to the previous late one, so a hitch doesn't turn the riffle
      // into a blob followed by a second blob.
      const dueAt = startedAtRef.current + spec.delayMs
      let departAt = Math.max(dueAt, now)
      if (dueAt < now) departAt = Math.max(departAt, lastDepartAt.current + LATE_LAUNCH_MIN_GAP_MS)
      lastDepartAt.current = departAt
      handle.launch({ ...spec, delayMs: departAt - now }, order, springRef.current)
    }
    if (queue.length > 0) launchTimerRef.current = setTimeout(launchDue, capped ? CAPPED_TICK_MS : LAUNCH_TICK_MS)
  }, [])

  const handleLanded = useCallback((cardId: string, deal: number) => {
    if (deal !== generationRef.current) return
    if (landedIds.current.has(cardId)) return
    landedIds.current.add(cardId)
    const done = landedIds.current.size >= totalRef.current
    const callbacks = callbacksRef.current
    try {
      // The slot lets go of the card in the same commit the caller's onCardLanded reveals the real destination card
      // underneath (see GhostSlot's notify) - only holding it, the same pixels, until that real card's face has painted -
      // so a finished card never lingers as a double, and never leaves a hole or a blank face.
      callbacks?.onCardLanded(cardId)
    } finally {
      // Completion is bookkeeping, not the caller's to break: it runs even if onCardLanded threw, so a deal can never
      // leave the full-screen skip layer up forever.
      if (done) {
        // The last cards may still be holding (see GhostSlot's `holding` - registered before this, in their notify): the
        // pool stays mounted for them.
        dealingRef.current = false
        setAnyHold(holdsRef.current.size > 0)
        setDealing(false)
        callbacksRef.current = null
        // Every card has taken off (and so given its hold back) by now - but for an entry repeating a card id that has
        // already landed: the deal is over for its caller, and its flight goes with the pool (now, or once the last landed
        // card stops holding - if it takes off before that, trackRelease keeps this the one call).
        releaseAll(pendingReleasesRef.current)
        callbacks?.onAllLanded()
      }
    }
  }, [])

  // A card landing where another slot is still holding its landed card ends that hold: the newer card covers that spot now,
  // and the older one would otherwise be drawn over the newer real card once the newer slot let go (the overlay sits
  // above the board). Same rule as DragGhostLayer's land().
  const handleHold = useCallback((slot: number, deal: number, hold: { rect: HoldRect; release: () => void } | null) => {
    if (deal !== generationRef.current) return
    const holds = holdsRef.current
    if (hold) {
      const quarterTurn = Math.abs(rotationRef.current) === 90
      const rect = quarterTurn ? { ...hold.rect, width: hold.rect.height, height: hold.rect.width } : hold.rect
      hold = { ...hold, rect }
      holds.forEach((other, otherSlot) => {
        const a = other.rect
        const b = rect
        if (otherSlot !== slot && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) {
          other.release()
          // Unregistered here, not left to that slot's effect cleanup: its hold may end before it ever commits (set and
          // released in one batch), and then no cleanup runs.
          holds.delete(otherSlot)
        }
      })
      holds.set(slot, hold)
    } else holds.delete(slot)
    if (!dealingRef.current) setAnyHold(holds.size > 0)
  }, [])

  const handleSlotIdle = useCallback(
    (slot: number, deal: number) => {
      if (deal !== generationRef.current) return
      if (!freeSlots.current.includes(slot)) freeSlots.current.push(slot)
      // Not a launchDue() call of its own: every slot that landed in one commit runs its own onIdle effect, and each pass
      // gets its own MAX_FACE_UP_LAUNCHES_PER_PASS budget - after a JS stall (several landing timers firing together) k idle
      // effects would launch up to 2k faces into the next commit. Re-arming the one launch timer instead coalesces all of
      // them into a single, capped pass a macrotask later (launchDue clears whatever timer is pending when it runs).
      if (queueRef.current.length === 0) return
      if (launchTimerRef.current) clearTimeout(launchTimerRef.current)
      launchTimerRef.current = setTimeout(launchDue, 0)
    },
    [launchDue]
  )

  // The first launches can only happen once the slots this deal's start() asked for have mounted and attached their
  // handles - that is the commit after start(), and effects run after refs attach. The deal's clock starts HERE, not in
  // start(): if the mount took a while (a slow phone, a busy board commit), every card's delay would already be spent and
  // the first several would all leave in the same frame instead of staggered.
  //
  // Also gated on frameReady: useOverlayFrame's cx/cy/lw/lh start at 0 until its own async
  // measureInWindow lands, and toLocal has no way to tell "genuinely a zero-sized frame at the
  // screen's origin" from "not measured yet" - it just computes with whatever's there. On a fresh
  // game screen's very first deal, that measurement can still be in flight when this effect would
  // otherwise fire (both are async work kicked off around the same mount), so the first cards flew to
  // a wrong, shared position (toLocal's output for a zero frame) and jumped to their real one the
  // instant the real measurement landed and every still-mounted ghost's animated style (reading
  // cx/cy reactively) recomputed - confirmed live: "a small percentage" of a deal's earliest cards
  // flying to nowhere before snapping into place, never the middle or tail of a deal. Re-running once
  // frameReady flips true (it's a dependency below) costs nothing on every OTHER deal, where it's
  // already long since true.
  useEffect(() => {
    if (generation === 0 || !frameReady) return
    startedAtRef.current = Date.now()
    launchDue()
    runBeat()
  }, [generation, frameReady, launchDue, runBeat])

  useEffect(
    () => () => {
      if (launchTimerRef.current) clearTimeout(launchTimerRef.current)
      if (beatTimerRef.current) clearTimeout(beatTimerRef.current)
    },
    []
  )
  // Leaving mid-deal (Home): the cards still waiting to take off never will, so their sources let go of them now.
  useEffect(() => {
    const releases = pendingReleasesRef.current
    return () => releaseAll(releases)
  }, [])

  // One ref callback per slot, built once per pool size, so GhostSlot's memo (which relies on every prop being stable)
  // actually holds: an inline `ref={(h) => ...}` is a new function every render and would re-render and re-attach
  // every slot whenever the provider re-renders (a rotation, the overlay measurement landing, Settings opening mid-deal).
  const slotRefs = useMemo(
    () =>
      Array.from({ length: poolSize }, (_, slot) => (handle: GhostSlotHandle | null) => {
        slotHandles.current[slot] = handle
      }),
    [poolSize]
  )

  const controller = useMemo<DealAnimator>(
    () => ({
      start(incoming, width, onCardLanded, onAllLanded, onCardDealt, spring = DEAL_SPRING) {
        // The previous deal (if any) is finished as of THIS line: its slots stay mounted until the commit after this
        // call, so silence them now (cancel) and bump the generation their callbacks are checked against. None of its
        // cards that had not taken off yet ever will, so their take-off holds are given back here too (a cancelled slot
        // reports nothing, and its queue is dropped below).
        generationRef.current += 1
        slotHandles.current.forEach((handle) => handle?.cancel())
        releaseAll(pendingReleasesRef.current)
        // This deal's holds, each wrapped so whichever path ends its card's flight calls it exactly once (trackRelease).
        const entries = incoming.map((entry) => (entry.releasePending ? { ...entry, releasePending: trackRelease(pendingReleasesRef.current, entry.releasePending) } : entry))
        holdsRef.current.clear()
        setAnyHold(false)
        setGeneration(generationRef.current)
        landedIds.current = new Set()
        dealtIds.current = new Set()
        totalRef.current = new Set(entries.map((entry) => entry.cardId)).size
        callbacksRef.current = { onCardLanded, onAllLanded, onCardDealt }
        springRef.current = spring
        setCardWidth(width)
        if (launchTimerRef.current) clearTimeout(launchTimerRef.current)
        launchTimerRef.current = null
        stopBeat()
        queueRef.current = []
        freeSlots.current = []
        slotHandles.current = []
        lastDepartAt.current = 0
        lastTakeOffAt.current = 0
        dealingRef.current = false
        if (entries.length === 0) {
          callbacksRef.current = null
          setPoolSize(0)
          setDealing(false)
          onAllLanded()
          return
        }
        // Reduce Motion (the Settings row or the device's, see reducedMotion.tsx), read when the deal starts.
        if (isMotionReduced()) {
          // No ghost is ever mounted or flown: every card is dealt and lands in the same tick - the
          // same instant-land outcome handleSkipTap already gives an unlaunched card, just reached
          // without a tap. onCardDealt/onCardLanded still fire once per card in entries order (via
          // the same guarded functions a real flight uses, so a duplicated id in entries still only
          // reaches the caller once each) - with one click and buzz for the whole deal, not one a
          // card - and a caller's own take-off-driven side effects (e.g. FreeCell/Yukon's
          // deck placeholder, keyed on the max-delay card's own id) resolve exactly as they would at
          // the end of a real flight, just immediately. A card's take-off hold goes with its take-off, as in flight.
          setPoolSize(0)
          setDealing(false)
          playBeat()
          entries.forEach((entry) => {
            entry.releasePending?.()
            handleDealt(entry.cardId, generationRef.current)
            handleLanded(entry.cardId, generationRef.current)
          })
          return
        }
        const sorted = [...entries].sort((a, b) => a.delayMs - b.delayMs)
        queueRef.current = sorted.map((spec, order) => ({ spec, order }))
        // Played from the deal's clock once it starts (the [generation] effect's runBeat).
        beatRef.current = dealBeatTicks(sorted.map((entry) => entry.delayMs))
        const size = dealPoolSize(
          sorted.map((entry) => entry.delayMs),
          spring.duration ?? 0
        )
        freeSlots.current = Array.from({ length: size }, (_, i) => i)
        slotHandles.current = Array.from({ length: size }, () => null)
        // Provisional - the deal's clock is restarted when the slots have actually mounted (the [generation] effect).
        startedAtRef.current = Date.now()
        setPoolSize(size)
        dealingRef.current = true
        setDealing(true)
      }
    }),
    // handleLanded's, handleDealt's and stopBeat's own deps are `[]` and playBeat's are useCardSoundEffects' stable functions
    // (see their definitions above), so none of them ever changes - listing them here costs nothing (this memo still only
    // ever runs once) and satisfies the linter honestly, rather than disabling the rule for dependencies that genuinely are read.
    [handleLanded, handleDealt, playBeat, stopBeat]
  )

  function handleSkipTap() {
    // Cards still queued never got a slot, so there is nothing to fast-forward - just land them. Everything the skip deals at
    // once is one beat (if the beat had any left).
    if (launchTimerRef.current) clearTimeout(launchTimerRef.current)
    launchTimerRef.current = null
    if (stopBeat()) playBeat()
    const unlaunched = queueRef.current
    queueRef.current = []
    // A flying card's completeNow gives its take-off hold back (its dealtNotify, or its notify for one still in its lag); an
    // unlaunched one has no ghost at all, so its source lets go as it lands.
    slotHandles.current.forEach((handle) => handle?.completeNow())
    unlaunched.forEach(({ spec }) => {
      spec.releasePending?.()
      handleDealt(spec.cardId, generationRef.current)
      handleLanded(spec.cardId, generationRef.current)
    })
  }

  return (
    <DealContext.Provider value={controller}>
      {children}
      {/* Always mounted (regardless of `dealing`) so `frame` above can measure its real
      position - a card's own screen-space destination is only correct once this measurement
      lands, which needs the view to already exist. */}
      <View ref={overlayRef} pointerEvents='none' style={StyleSheet.absoluteFill}>
        {(dealing || anyHold) && poolSize > 0 && (
          <CardSizeProvider width={cardWidth}>
            {/* Ghosts: their faces are not the board's (see cardFacePaint.ts). */}
            <FaceLoadTrackingContext.Provider value={false}>
              {Array.from({ length: poolSize }, (_, slot) => (
                <GhostSlot key={`${generation}-${slot}`} slot={slot} deal={generation} onDealt={handleDealt} onLanded={handleLanded} onIdle={handleSlotIdle} onHold={handleHold} frame={frame} cardWidth={cardWidth} lastTakeOffRef={lastTakeOffAt} ref={slotRefs[slot]} />
              ))}
            </FaceLoadTrackingContext.Provider>
          </CardSizeProvider>
        )}
      </View>
      {dealing && (
        // A plain react-native Pressable, not @rific/feedback-press's - a screen-wide "get me
        // there faster" tap during a deal isn't a button and shouldn't trigger haptic/sound
        // feedback. Covers the board and the footer buttons underneath, which also happens to be
        // exactly what prevents a second deal from starting mid-flight. It deliberately stops short of
        // the top chrome band (Home, Settings, the title): a deal runs 0.4-2.1s, and when that band was
        // covered too, the first tap on Home during it only skipped the deal - reading as "Home is
        // slow to respond" - instead of leaving. Leaving is safe mid-deal (each slot clears its own
        // timers on unmount).
        <Pressable testID='deal-skip-layer' style={[StyleSheet.absoluteFill, { top: topChromeBand }]} onPress={handleSkipTap} />
      )}
    </DealContext.Provider>
  )
}

const styles = StyleSheet.create({
  ghostCard: {
    left: 0,
    position: 'absolute',
    top: 0
  },
  // Idle slots stay mounted (with their last card) but are invisible until launched again.
  idle: {
    opacity: 0
  },
  slot: {
    left: 0,
    position: 'absolute',
    top: 0
  }
})
