import { CARD_ASPECT, CardSizeProvider } from '@tastic/cards'
import { rotateInsets, useRotation } from '@tastic/core'
import { createContext, memo, ReactNode, Ref, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Card } from '@/engine/types'

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
   * to empty a source pile only once the last card has actually left it). Omitting it changes nothing. */
  start(entries: DealCardSpec[], cardWidth: number, onCardLanded: (cardId: string) => void, onAllLanded: () => void, onCardDealt?: (cardId: string) => void): void
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
// A slot stays occupied a little past its flight: its landing timer can fire late, and it is only offered for reuse once the
// commit that hides it (and reveals the real card) has happened. The pool is sized for that turnaround too, so a busy JS
// thread does not leave a due card waiting for a slot.
const SLOT_TURNAROUND_MS = 80
// Spare slots beyond the computed peak.
const POOL_SLACK = 2
// After a JS stall every card that came due meanwhile launches at once; cards that are LATE are spaced at least this far
// apart so they stream out instead of leaving as one blob (on-time cards always keep their own scheduled time).
const LATE_LAUNCH_MIN_GAP_MS = 12
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

/** The ghost pool a deal with these flight start delays mounts (see ghostPoolSize for what the numbers mean). */
export function dealPoolSize(delays: number[]): number {
  return ghostPoolSize(delays, DEAL_SPRING.duration ?? 0, LOOKAHEAD_MS + SLOT_TURNAROUND_MS, POOL_SLACK)
}

export function useDealAnimator(): DealAnimator {
  const ctx = useContext(DealContext)
  if (!ctx) throw new Error('useDealAnimator must be used within a DealProvider')
  return ctx
}

interface GhostSlotHandle {
  /** Points this slot at `spec` and starts its flight after `spec.delayMs` (already rebased onto this call). `order` is
   * the card's position in the deal, so a later card always paints above an earlier one whichever slot it landed in. */
  launch(spec: DealCardSpec, order: number): void
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
  ref?: Ref<GhostSlotHandle>
}

interface Job {
  spec: DealCardSpec
  order: number
}

// Memoized: props are all stable across the deal (a slot number, stable callbacks, the overlay frame, the card width),
// so a slot re-renders only through its own state - i.e. when it is launched or lands.
const GhostSlot = memo(function GhostSlot({ slot, deal, onDealt, onLanded, onIdle, frame, cardWidth, ref }: GhostSlotProps) {
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
    const { spec } = job
    tx.value = withDelay(spec.delayMs, withSpring(spec.to.x, DEAL_SPRING))
    ty.value = withDelay(spec.delayMs, withSpring(spec.to.y, DEAL_SPRING))
    opacity.value = withDelay(spec.delayMs, withTiming(1, { duration: 0 }))
    // Deliberately its own timer rather than piggybacked on the settle one below - this card's sound/haptic should fire
    // the instant it's dealt out (delayMs), not once it's finished flying.
    dealtTimeoutRef.current = setTimeout(() => dealtNotify(spec.cardId), spec.delayMs)
    // Settlement used to be driven by withSpring's own completion callback (one per axis, both required before
    // notifying) - that callback was found to never fire at all for these duration-based springs on this app's web
    // target (confirmed live via DragGhostLayer.tsx's identical bug, fixed the same way there). A plain timer covering
    // the same delay+duration the springs are configured for stands in for it instead; the visual flight itself doesn't
    // depend on the callback either way, since it's driven by tx/ty directly.
    timeoutRef.current = setTimeout(notify, spec.delayMs + (DEAL_SPRING.duration ?? 0))
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
      launch(spec, order) {
        clearTimers()
        dealt.current = false
        notified.current = false
        // Repositioned and hidden BEFORE the React commit that shows the slot again, so the previous card's landing spot
        // is never visible for even a frame. (A plain write also cancels whatever spring was still settling.)
        tx.value = spec.from.x
        ty.value = spec.from.y
        opacity.value = 0
        const next = { spec, order }
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
        jobRef.current = null
        dealt.current = true
        notified.current = true
      }
    }),
    [clearTimers, dealtNotify, notify, tx, ty, opacity]
  )

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
    <View testID={`deal-ghost-${slot}`} pointerEvents='none' style={[styles.slot, job ? { zIndex: job.order } : styles.idle]}>
      <Animated.View style={[styles.ghostCard, style]}>{face}</Animated.View>
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
  // How many ghost slots the current deal mounts (see ghostPoolSize) - NOT one per card.
  const [poolSize, setPoolSize] = useState(0)
  // Whether a deal is in flight at all (drives the skip-tap layer and mounts the pool).
  const [dealing, setDealing] = useState(false)
  const [cardWidth, setCardWidth] = useState(0)
  // Specs not yet launched, in ascending delayMs order (with their paint order), the slots currently free, the deal's
  // clock and the pending launch timer. Only ever touched from start()/timer/landing/skip callbacks, never during render.
  const queueRef = useRef<Job[]>([])
  const freeSlots = useRef<number[]>([])
  const slotHandles = useRef<(GhostSlotHandle | null)[]>([])
  const startedAtRef = useRef(0)
  const lastDepartAt = useRef(0)
  const launchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
  const { overlayRef, frame } = useOverlayFrame()
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

  // Hands every queued card whose flight starts within LOOKAHEAD_MS to a free slot (with its delay re-based onto its own
  // launch time - a slot's timers/springs all start when it is launched), then reschedules itself while any remain. A
  // card that is due but finds no free slot simply waits: the next slot to go idle calls this again.
  const launchDue = useCallback(function launchDue() {
    if (launchTimerRef.current) clearTimeout(launchTimerRef.current)
    launchTimerRef.current = null
    const now = Date.now()
    const elapsed = now - startedAtRef.current
    const queue = queueRef.current
    while (queue.length > 0 && freeSlots.current.length > 0 && queue[0].spec.delayMs - LOOKAHEAD_MS <= elapsed) {
      const handle = slotHandles.current[freeSlots.current[0]]
      // The slots mount in the commit after start(); until their handles attach there is nothing to launch into.
      if (!handle) break
      freeSlots.current.shift()
      const { spec, order } = queue.shift()!
      // An on-time card departs exactly when scheduled. A LATE one (a JS stall made it due meanwhile) departs as soon as
      // possible but no closer than LATE_LAUNCH_MIN_GAP_MS to the previous late one, so a hitch doesn't turn the riffle
      // into a blob followed by a second blob.
      const dueAt = startedAtRef.current + spec.delayMs
      let departAt = Math.max(dueAt, now)
      if (dueAt < now) departAt = Math.max(departAt, lastDepartAt.current + LATE_LAUNCH_MIN_GAP_MS)
      lastDepartAt.current = departAt
      handle.launch({ ...spec, delayMs: departAt - now }, order)
    }
    if (queue.length > 0) launchTimerRef.current = setTimeout(launchDue, LAUNCH_TICK_MS)
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
      launchDue()
    },
    [launchDue]
  )

  // The first launches can only happen once the slots this deal's start() asked for have mounted and attached their
  // handles - that is the commit after start(), and effects run after refs attach. The deal's clock starts HERE, not in
  // start(): if the mount took a while (a slow phone, a busy board commit), every card's delay would already be spent and
  // the first several would all leave in the same frame instead of staggered.
  useEffect(() => {
    if (generation === 0) return
    startedAtRef.current = Date.now()
    launchDue()
  }, [generation, launchDue])

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
      start(entries, width, onCardLanded, onAllLanded, onCardDealt) {
        // The previous deal (if any) is finished as of THIS line: its slots stay mounted until the commit after this
        // call, so silence them now (cancel) and bump the generation their callbacks are checked against.
        generationRef.current += 1
        slotHandles.current.forEach((handle) => handle?.cancel())
        setGeneration(generationRef.current)
        landedIds.current = new Set()
        dealtIds.current = new Set()
        totalRef.current = new Set(entries.map((entry) => entry.cardId)).size
        callbacksRef.current = { onCardLanded, onAllLanded, onCardDealt }
        setCardWidth(width)
        if (launchTimerRef.current) clearTimeout(launchTimerRef.current)
        launchTimerRef.current = null
        queueRef.current = []
        freeSlots.current = []
        slotHandles.current = []
        lastDepartAt.current = 0
        if (entries.length === 0) {
          callbacksRef.current = null
          setPoolSize(0)
          setDealing(false)
          onAllLanded()
          return
        }
        const sorted = [...entries].sort((a, b) => a.delayMs - b.delayMs)
        queueRef.current = sorted.map((spec, order) => ({ spec, order }))
        const size = dealPoolSize(sorted.map((entry) => entry.delayMs))
        freeSlots.current = Array.from({ length: size }, (_, i) => i)
        slotHandles.current = Array.from({ length: size }, () => null)
        // Provisional - the deal's clock is restarted when the slots have actually mounted (the [generation] effect).
        startedAtRef.current = Date.now()
        setPoolSize(size)
        setDealing(true)
      }
    }),
    []
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
              <GhostSlot key={`${generation}-${slot}`} slot={slot} deal={generation} onDealt={handleDealt} onLanded={handleLanded} onIdle={handleSlotIdle} frame={frame} cardWidth={cardWidth} ref={slotRefs[slot]} />
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
