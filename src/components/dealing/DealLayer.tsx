import { CARD_ASPECT, CardSizeProvider } from '@tastic/cards'
import { rotateInsets, useRotation } from '@tastic/core'
import { createContext, memo, ReactNode, Ref, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming } from 'react-native-reanimated'
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
   * fires once every entry has landed. Passing an empty list calls onAllLanded immediately. */
  start(entries: DealCardSpec[], cardWidth: number, onCardLanded: (cardId: string) => void, onAllLanded: () => void): void
}

const DealContext = createContext<DealAnimator | null>(null)

// A deal used to mount a ghost for EVERY card up front (a second full copy of the board - ~640 views for
// Klondike, ~1,200-1,500 for the 50-card games - with all their shared values and gesture-free-but-still-
// registered animated styles) although only a handful are ever mid-flight at once and each waits invisibly at
// opacity 0 until its own turn. Now a ghost mounts LOOKAHEAD_MS before its flight begins (re-checked every
// MOUNT_TICK_MS, so it lands 150-250ms early - plenty for its mount + effects) and unmounts as it lands.
const LOOKAHEAD_MS = 250
const MOUNT_TICK_MS = 100

export function useDealAnimator(): DealAnimator {
  const ctx = useContext(DealContext)
  if (!ctx) throw new Error('useDealAnimator must be used within a DealProvider')
  return ctx
}

interface DealGhostHandle {
  /** Jumps straight to the landing point and notifies immediately, skipping whatever's left of the
   * delay/spring - used when the whole deal is tapped-to-skip. */
  completeNow(): void
}

interface DealGhostCardProps {
  spec: DealCardSpec
  /** Fires once this card's own flight actually begins (its delayMs elapses) - see DealProvider's
   * handleDealt, which plays this card's sound/haptic right as it's dealt out rather than waiting
   * for it to land. */
  onDealt: () => void
  onLanded: (cardId: string) => void
  /** The overlay's own placement (see DealProvider's useOverlayFrame) - converts spec.from/to from
   * screen space into the overlay's own space so a card lands exactly where it was measured,
   * regardless of where this screen-level overlay itself happens to sit relative to the true
   * viewport origin, or how far it's rotated under a landscape hold. */
  frame: OverlayFrame
  /** The deal's card width - the ghost's own footprint for that conversion. */
  cardWidth: number
  ref?: Ref<DealGhostHandle>
}

// Memoized: a full deal mounts up to 52 of these at once, and handleLanded below removes them from
// `active` one at a time as each one's own flight settles - every still-flying ghost's props here
// (spec, onDealt/onLanded, the two shared values) stay referentially stable across that churn
// (spec survives setActive's .filter() by reference; handleLanded/handleDealt are stable
// useCallbacks; shared values never change identity), so without this, every remaining ghost
// re-rendered on every single sibling's landing - up to ~50 wasted re-renders per deal for the
// last card alone.
const DealGhostCard = memo(function DealGhostCard({ spec, onDealt, onLanded, frame, cardWidth, ref }: DealGhostCardProps) {
  const cardHeight = cardWidth / CARD_ASPECT
  const tx = useSharedValue(spec.from.x)
  const ty = useSharedValue(spec.from.y)
  // Every ghost for the whole deal mounts at once (see DealProvider's single setActive(entries)
  // call below) - only the POSITION springs are staggered, via withDelay. Without this, a card
  // whose own delay hasn't elapsed yet would still render at full opacity, sitting motionless
  // stacked exactly on top of every other not-yet-started ghost at the shared `from` origin.
  // Invisible for a face-down deal (Klondike) - identical-looking backs stacked on each other read
  // as just one still card - but for a face-up deal (Pyramid, FreeCell) each stacked-and-waiting
  // ghost shows its own real face, so what's actually visible is some face-up card sitting at the
  // origin, its identity flickering to a different card every DEAL_STAGGER_MS as each one's turn
  // arrives and it peels away - confirmed live on both games. Starts invisible, then pops straight
  // to fully visible - not eased - the instant its delayed flight actually begins: a fade here
  // read as sluggish against DEAL_SPRING's snappy, energetic-dealer pace (see dealSpring.ts).
  const opacity = useSharedValue(0)
  const dealt = useRef(false)
  const notified = useRef(false)
  const dealtTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Fires this card's own sound/haptic the moment it's dealt out (see DealProvider's handleDealt) -
  // guarded the same way notify() below is, so completeNow's forced path doesn't double-fire it for
  // a card whose delay had already elapsed naturally before the skip.
  const dealtNotify = useCallback(() => {
    if (dealt.current) return
    dealt.current = true
    onDealt()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Both the natural settle path (below) and completeNow's forced path funnel through this, each
  // guarded so a card is only ever reported landed once.
  const notify = useCallback(() => {
    if (notified.current) return
    notified.current = true
    onLanded(spec.cardId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    tx.value = withDelay(spec.delayMs, withSpring(spec.to.x, DEAL_SPRING))
    ty.value = withDelay(spec.delayMs, withSpring(spec.to.y, DEAL_SPRING))
    opacity.value = withDelay(spec.delayMs, withTiming(1, { duration: 0 }))
    // Deliberately its own timer rather than piggybacked on the settle one below - this card's
    // sound/haptic should fire the instant it's dealt out (delayMs), not once it's finished flying.
    dealtTimeoutRef.current = setTimeout(dealtNotify, spec.delayMs)
    // Settlement used to be driven by withSpring's own completion callback (one per axis, both
    // required before notifying) - that callback was found to never fire at all for these
    // duration-based springs on this app's web target (confirmed live via DragGhostLayer.tsx's
    // identical bug, fixed the same way there). A plain timer covering the same delay+duration the
    // springs are configured for stands in for it instead; the visual flight itself doesn't depend
    // on the callback either way, since it's driven by tx/ty directly.
    timeoutRef.current = setTimeout(notify, spec.delayMs + (DEAL_SPRING.duration ?? 0))
    return () => {
      if (dealtTimeoutRef.current) clearTimeout(dealtTimeoutRef.current)
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useImperativeHandle(ref, () => ({
    completeNow() {
      if (dealtTimeoutRef.current) clearTimeout(dealtTimeoutRef.current)
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      cancelAnimation(tx)
      cancelAnimation(ty)
      cancelAnimation(opacity)
      tx.value = spec.to.x
      ty.value = spec.to.y
      opacity.value = 1
      // A card whose delay hadn't elapsed yet when the skip landed still gets its one sound/haptic
      // here - a card that had already fired dealtNotify naturally is a no-op via its own guard.
      dealtNotify()
      notify()
    }
  }))

  const style = useAnimatedStyle(() => {
    const p = toLocal(tx.value, ty.value, cardWidth, cardHeight, frame)
    return { opacity: opacity.value, transform: [{ translateX: p.x }, { translateY: p.y }] }
  })

  return (
    <Animated.View style={[styles.ghostCard, style]}>
      <PlayingCard card={spec.card} />
    </Animated.View>
  )
})

/** Wraps a game screen so its initial deal can fly N cards independently and simultaneously from
 * the stock pile to their starting positions. Deliberately a separate module from
 * dragdrop/DragGhostLayer.tsx, which only ever supports one flying card/group at a time (drag,
 * tap-to-move) - rather than risk that proven system, this generalizes the same "screen-level
 * overlay, real card content, spring-driven flight" idioms to N simultaneous ghosts instead. */
export function DealProvider({ children }: { children: ReactNode }) {
  const { playCardSound, hapticCard } = useCardSoundEffects()
  // Same rotated-frame safe-area top GameChrome positions its corner buttons from, plus that band's height.
  const topChromeBand = rotateInsets(useSafeAreaInsets(), useRotation()).top + GAME_CONTENT_TOP_PADDING
  // Ghosts currently mounted - NOT every card of the deal. See LOOKAHEAD_MS: a ghost only mounts shortly before
  // its own flight begins, and unmounts as it lands (handleLanded), so at most a couple of dozen exist at once
  // instead of one full copy of every dealt card.
  const [mounted, setMounted] = useState<DealCardSpec[]>([])
  // Whether a deal is in flight at all (drives the skip-tap layer) - `mounted` alone can't say, since it is empty
  // both before the first ghost mounts and after the last lands.
  const [dealing, setDealing] = useState(false)
  const [cardWidth, setCardWidth] = useState(0)
  // Specs not yet mounted, in ascending delayMs order, plus the deal's start time and the pending mount timer.
  // Only ever touched from start()/timer/skip callbacks, never during render.
  const queueRef = useRef<DealCardSpec[]>([])
  const startedAtRef = useRef(0)
  const mountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handles = useRef(new Map<string, DealGhostHandle>())
  const landedIds = useRef(new Set<string>())
  const callbacksRef = useRef<{ onCardLanded: (cardId: string) => void; onAllLanded: () => void } | null>(null)
  const totalRef = useRef(0)
  // Card ids repeat across every deal (same 52 cards, just reshuffled - see deck.ts), so keying
  // ghosts by cardId alone would let React reuse a still-mounted instance from an overlapping
  // prior deal if start() is ever called again before the previous one finished. A reused instance
  // wouldn't reset its shared-value position (useSharedValue's initial value only applies on a
  // genuine first mount) or its own "already notified" guard, silently stalling that card forever.
  // Folding a monotonic generation into the key instead forces a real unmount+mount - and therefore
  // a full state reset - for every deal, regardless of any id overlap with the one before it.
  // State, not a ref: it's read in the JSX key below, and reading a ref's `.current` during render
  // isn't allowed - the increment already sits alongside setCardWidth/setActive in start(), so
  // routing it through its own setState doesn't add a render that wasn't already happening here.
  const [generation, setGeneration] = useState(0)
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

  // Each card's own click+buzz, fired the instant it's dealt out (see DealGhostCard's onDealt) -
  // deliberately not per-card-gated here the way handleLanded is below, since DealGhostCard's own
  // dealtNotify guard already ensures this fires exactly once per card regardless of a mid-deal
  // skip. playCardSound's own PLAY_THROTTLE_MS still caps how many of these can actually audibly
  // fire in one tick, same as it always has for this riffle.
  const handleDealt = useCallback(() => {
    playCardSound()
    hapticCard()
  }, [playCardSound, hapticCard])

  const handleLanded = useCallback((cardId: string) => {
    if (landedIds.current.has(cardId)) return
    landedIds.current.add(cardId)
    handles.current.delete(cardId)
    callbacksRef.current?.onCardLanded(cardId)
    // Each ghost is removed as its own flight settles, rather than all at once when the whole
    // deal finishes - the real destination card underneath is revealed on this same per-card
    // schedule (see the caller's onCardLanded), so leaving every earlier ghost mounted until the
    // last card lands would double-render each of them for the rest of the deal.
    setMounted((prev) => prev.filter((spec) => spec.cardId !== cardId))
    if (landedIds.current.size >= totalRef.current) {
      setDealing(false)
      callbacksRef.current?.onAllLanded()
      callbacksRef.current = null
    }
  }, [])

  // Mounts every queued ghost whose flight starts within LOOKAHEAD_MS, with its delay re-based onto its own mount
  // time (a ghost's timers/springs all start when it mounts), then reschedules itself while any remain.
  const mountDue = useCallback(function mountDue() {
    mountTimerRef.current = null
    const elapsed = Date.now() - startedAtRef.current
    const queue = queueRef.current
    const due: DealCardSpec[] = []
    while (queue.length > 0 && queue[0].delayMs - LOOKAHEAD_MS <= elapsed) {
      const spec = queue.shift()!
      due.push({ ...spec, delayMs: Math.max(0, spec.delayMs - elapsed) })
    }
    if (due.length > 0) setMounted((prev) => [...prev, ...due])
    if (queue.length > 0) mountTimerRef.current = setTimeout(mountDue, MOUNT_TICK_MS)
  }, [])

  useEffect(
    () => () => {
      if (mountTimerRef.current) clearTimeout(mountTimerRef.current)
    },
    []
  )

  const controller = useMemo<DealAnimator>(
    () => ({
      start(entries, width, onCardLanded, onAllLanded) {
        setGeneration((g) => g + 1)
        landedIds.current = new Set()
        handles.current = new Map()
        totalRef.current = entries.length
        callbacksRef.current = { onCardLanded, onAllLanded }
        setCardWidth(width)
        if (mountTimerRef.current) clearTimeout(mountTimerRef.current)
        mountTimerRef.current = null
        queueRef.current = []
        setMounted([])
        if (entries.length === 0) {
          callbacksRef.current = null
          setDealing(false)
          onAllLanded()
          return
        }
        setDealing(true)
        queueRef.current = [...entries].sort((a, b) => a.delayMs - b.delayMs)
        startedAtRef.current = Date.now()
        mountDue()
      }
    }),
    [mountDue]
  )

  function handleSkipTap() {
    // Ghosts still queued never mounted, so there is nothing to fast-forward - just land them, with the same
    // one sound/haptic each that a mounted ghost's completeNow gives a card whose turn hadn't come yet.
    if (mountTimerRef.current) clearTimeout(mountTimerRef.current)
    mountTimerRef.current = null
    const unmounted = queueRef.current
    queueRef.current = []
    Array.from(handles.current.values()).forEach((handle) => handle.completeNow())
    unmounted.forEach((spec) => {
      handleDealt()
      handleLanded(spec.cardId)
    })
  }

  return (
    <DealContext.Provider value={controller}>
      {children}
      {/* Always mounted (regardless of `active`) so `frame` above can measure its real
      position - a card's own screen-space destination is only correct once this measurement
      lands, which needs the view to already exist. */}
      <View ref={overlayRef} pointerEvents='none' style={StyleSheet.absoluteFill}>
        {mounted.length > 0 && (
          <CardSizeProvider width={cardWidth}>
            {mounted.map((spec) => (
              <DealGhostCard
                key={`${generation}-${spec.cardId}`}
                spec={spec}
                onDealt={handleDealt}
                onLanded={handleLanded}
                frame={frame}
                cardWidth={cardWidth}
                ref={(handle) => {
                  if (handle) handles.current.set(spec.cardId, handle)
                  else handles.current.delete(spec.cardId)
                }}
              />
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
        // slow to respond" - instead of leaving. Leaving is safe mid-deal (each ghost clears its own
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
  }
})
