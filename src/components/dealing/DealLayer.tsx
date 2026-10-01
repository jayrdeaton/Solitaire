import { CARD_ASPECT, CardSizeProvider } from '@tastic/cards'
import { rotateInsets, useRotation } from '@tastic/core'
import { createContext, memo, ReactNode, Ref, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withDelay, withSpring, WithSpringConfig, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Card } from '@/engine/types'
import { useSettings } from '@/stores/settings'

import { GAME_CONTENT_TOP_PADDING } from '../gameLayout'
import { OverlayFrame, toLocal, useOverlayFrame } from '../overlayFrame'
import { PlayingCard } from '../PlayingCard'
import { useCardSoundEffects } from '../useCardSounds'
import { DEAL_SPRING } from './dealSpring'
import { ScreenPoint } from './measureView'

export interface DealCardSpec {
  cardId: string
  card: Card
  from: ScreenPoint
  to: ScreenPoint
  delayMs: number
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
   * other card move; deals keep the deal's pace. */
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
// Haptics are capped like the sound pool already is (PLAY_THROTTLE_MS = 40) - at any pace: a card dealt every ~18ms
// (compressed deals) or ~35ms (the rest) would otherwise be a buzz, not a riffle, and the click and buzz stay paired.
const HAPTIC_MIN_GAP_MS = 40

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
   * must not report a card to the NEW deal. */
  cancel(): void
}

interface GhostSlotProps {
  slot: number
  /** Which deal this slot belongs to (DealProvider's generation). Every callback carries it back so a slot that outlives
   * its deal - replaced by a new start() but not yet unmounted - can never report into the new one. */
  deal: number
  /** Fires once a card's own flight actually begins (its delayMs elapses) - see DealProvider's handleDealt, which
   * plays this card's sound/haptic right as it's dealt out rather than waiting for it to land, and tells the caller
   * (DealAnimator.start's onCardDealt) that this card has taken off. */
  onDealt: (cardId: string, deal: number) => void
  /** The card has landed (naturally or via skip). */
  onLanded: (cardId: string, deal: number) => void
  /** The slot is hidden again and free to be launched. Fired from an effect - i.e. AFTER the commit that hid this slot and
   * (in the same batch) revealed the real card underneath - never from the landing callback itself: relaunching a slot in
   * the very tick it landed would write its reset to the UI thread ahead of that commit and blink a card-shaped hole. */
  onIdle: (slot: number, deal: number) => void
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

/** A card waiting in the provider's queue for a free slot. */
interface QueuedCard {
  spec: DealCardSpec
  /** The card's position in the deal (becomes its paint order). */
  order: number
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
const GhostSlot = memo(function GhostSlot({ slot, deal, onDealt, onLanded, onIdle, frame, cardWidth, lastTakeOffRef, ref }: GhostSlotProps) {
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
  const jobRef = useRef<Job | null>(null)
  const dealt = useRef(false)
  const notified = useRef(false)
  const dealtTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearTimers = useCallback(() => {
    if (dealtTimeoutRef.current) clearTimeout(dealtTimeoutRef.current)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    dealtTimeoutRef.current = null
    timeoutRef.current = null
  }, [])

  // Fires this card's own sound/haptic the moment it's dealt out (see DealProvider's handleDealt) - guarded the same
  // way notify() below is, so completeNow's forced path doesn't double-fire it for a card whose delay had already
  // elapsed naturally before the skip.
  const dealtNotify = useCallback(
    (cardId: string) => {
      if (dealt.current) return
      dealt.current = true
      onDealt(cardId, deal)
    },
    [onDealt, deal]
  )

  // Both the natural settle path (the effect below) and completeNow's forced path funnel through this, each guarded so a
  // card is only ever reported landed once per launch.
  const notify = useCallback(() => {
    if (notified.current) return
    notified.current = true
    const landed = jobRef.current
    jobRef.current = null
    setJob(null)
    if (landed) onLanded(landed.spec.cardId, deal)
  }, [onLanded, deal])

  useEffect(() => {
    if (!job) return
    const { spec, departAt, spring } = job
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
    dealtTimeoutRef.current = setTimeout(() => dealtNotify(spec.cardId), wait)
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

  // Clears any timer still pending if this slot goes away mid-flight (Home, or a new deal replacing this one).
  useEffect(() => clearTimers, [clearTimers])

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
        // notification) here - a card that had already fired dealtNotify naturally is a no-op via its own guard.
        dealtNotify(current.spec.cardId)
        notify()
      },
      cancel() {
        clearTimers()
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
      }
    }),
    [clearTimers, dealtNotify, notify, tx, ty, opacity]
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
  const face = useMemo(() => (card ? <PlayingCard card={card} /> : null), [card])

  return (
    // The static wrapper (not the animated opacity) is what hides an idle slot, and it carries the paint order.
    <View testID={`deal-ghost-${slot}`} pointerEvents='none' style={[styles.slot, slotSize, job ? { zIndex: job.order } : styles.idle]}>
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
  const topChromeBand = rotateInsets(useSafeAreaInsets(), useRotation()).top + GAME_CONTENT_TOP_PADDING
  // Read through a ref, not a controller dependency: `controller` below is memoized once (`[]`) so
  // every screen's `deal` reference stays stable for its whole lifetime, and start() itself always
  // wants the CURRENT setting - not whatever it was when the provider first mounted.
  const { settings } = useSettings()
  const reduceMotionRef = useRef(settings.reduceMotion)
  useEffect(() => {
    reduceMotionRef.current = settings.reduceMotion
  }, [settings.reduceMotion])
  // How many ghost slots the current deal mounts (see ghostPoolSize) - NOT one per card.
  const [poolSize, setPoolSize] = useState(0)
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
  const totalRef = useRef(0)
  const lastHapticAt = useRef(0)
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
  // inside RotatedGameView's rotated frame. Left uncorrected, every dealt card lands somewhere
  // other than where it was measured - "flies to a spot below its pile, then snaps up" once the
  // real, correctly-flowed destination card is revealed. useOverlayFrame measures the overlay once
  // it mounts (and again on resize/rotation) and toLocal converts each ghost's position - see
  // overlayFrame.ts.

  // Each card's own click+buzz, fired the instant it's dealt out (see GhostSlot's onDealt) -
  // deliberately not per-card-gated here the way handleLanded is below, since GhostSlot's own
  // dealtNotify guard already ensures this fires exactly once per card regardless of a mid-deal
  // skip. playCardSound's own PLAY_THROTTLE_MS still caps how many of these can actually audibly
  // fire in one tick, same as it always has for this riffle; haptics get the equivalent cap here.
  const handleDealt = useCallback(
    (cardId: string, deal: number) => {
      if (deal !== generationRef.current) return
      playCardSound()
      const now = Date.now()
      if (now - lastHapticAt.current >= HAPTIC_MIN_GAP_MS) {
        lastHapticAt.current = now
        hapticCard()
      }
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
    },
    [playCardSound, hapticCard]
  )
  // handleDealt isn't unconditionally stable (its own deps are playCardSound/hapticCard), but
  // `controller` below is memoized at `[]` forever - so start()'s reduceMotion fast path reads it
  // through a ref, the same reason reduceMotionRef exists above, rather than adding it (and
  // therefore controller itself) to a dependency array. handleLanded needs no such ref: its own
  // deps are already `[]`, so the closure `controller` captures at mount stays the only one there
  // ever is.
  const handleDealtRef = useRef(handleDealt)
  useEffect(() => {
    handleDealtRef.current = handleDealt
  }, [handleDealt])

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
      // The slot hides itself in the same commit the caller's onCardLanded reveals the real destination card underneath
      // (see GhostSlot's notify) - so a finished card never lingers as a double, and never leaves a hole.
      callbacks?.onCardLanded(cardId)
    } finally {
      // Completion is bookkeeping, not the caller's to break: it runs even if onCardLanded threw, so a deal can never
      // leave the full-screen skip layer up forever.
      if (done) {
        setDealing(false)
        callbacksRef.current = null
        callbacks?.onAllLanded()
      }
    }
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
  }, [generation, frameReady, launchDue])

  useEffect(
    () => () => {
      if (launchTimerRef.current) clearTimeout(launchTimerRef.current)
    },
    []
  )

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
      start(entries, width, onCardLanded, onAllLanded, onCardDealt, spring = DEAL_SPRING) {
        // The previous deal (if any) is finished as of THIS line: its slots stay mounted until the commit after this
        // call, so silence them now (cancel) and bump the generation their callbacks are checked against.
        generationRef.current += 1
        slotHandles.current.forEach((handle) => handle?.cancel())
        setGeneration(generationRef.current)
        landedIds.current = new Set()
        dealtIds.current = new Set()
        totalRef.current = new Set(entries.map((entry) => entry.cardId)).size
        callbacksRef.current = { onCardLanded, onAllLanded, onCardDealt }
        springRef.current = spring
        setCardWidth(width)
        if (launchTimerRef.current) clearTimeout(launchTimerRef.current)
        launchTimerRef.current = null
        queueRef.current = []
        freeSlots.current = []
        slotHandles.current = []
        lastDepartAt.current = 0
        lastTakeOffAt.current = 0
        if (entries.length === 0) {
          callbacksRef.current = null
          setPoolSize(0)
          setDealing(false)
          onAllLanded()
          return
        }
        if (reduceMotionRef.current) {
          // No ghost is ever mounted or flown: every card is dealt and lands in the same tick - the
          // same instant-land outcome handleSkipTap already gives an unlaunched card, just reached
          // without a tap. onCardDealt/onCardLanded still fire once per card in entries order (via
          // the same guarded functions a real flight uses, so a duplicated id in entries still only
          // reaches the caller once each) - sound/haptic still fire too, throttled by their own
          // existing PLAY_THROTTLE_MS/HAPTIC_MIN_GAP_MS to essentially one of each for the whole
          // deal, not 52 - and a caller's own take-off-driven side effects (e.g. FreeCell/Yukon's
          // deck placeholder, keyed on the max-delay card's own id) resolve exactly as they would at
          // the end of a real flight, just immediately.
          setPoolSize(0)
          setDealing(false)
          entries.forEach((entry) => {
            handleDealtRef.current(entry.cardId, generationRef.current)
            handleLanded(entry.cardId, generationRef.current)
          })
          return
        }
        const sorted = [...entries].sort((a, b) => a.delayMs - b.delayMs)
        queueRef.current = sorted.map((spec, order) => ({ spec, order }))
        const size = dealPoolSize(
          sorted.map((entry) => entry.delayMs),
          spring.duration ?? 0
        )
        freeSlots.current = Array.from({ length: size }, (_, i) => i)
        slotHandles.current = Array.from({ length: size }, () => null)
        // Provisional - the deal's clock is restarted when the slots have actually mounted (the [generation] effect).
        startedAtRef.current = Date.now()
        setPoolSize(size)
        setDealing(true)
      }
    }),
    // handleLanded's own deps are `[]` (see its definition above), so it never actually changes -
    // listing it here costs nothing (this memo still only ever runs once) and satisfies the linter
    // honestly, rather than disabling the rule for a dependency that genuinely is being read.
    [handleLanded]
  )

  function handleSkipTap() {
    // Cards still queued never got a slot, so there is nothing to fast-forward - just land them, with the same one
    // sound/haptic each that a slot's completeNow gives a card whose turn hadn't come yet.
    if (launchTimerRef.current) clearTimeout(launchTimerRef.current)
    launchTimerRef.current = null
    const unlaunched = queueRef.current
    queueRef.current = []
    slotHandles.current.forEach((handle) => handle?.completeNow())
    unlaunched.forEach(({ spec }) => {
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
        {dealing && poolSize > 0 && (
          <CardSizeProvider width={cardWidth}>
            {Array.from({ length: poolSize }, (_, slot) => (
              <GhostSlot key={`${generation}-${slot}`} slot={slot} deal={generation} onDealt={handleDealt} onLanded={handleLanded} onIdle={handleSlotIdle} frame={frame} cardWidth={cardWidth} lastTakeOffRef={lastTakeOffAt} ref={slotRefs[slot]} />
            ))}
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
