import { CARD_ASPECT, CardSizeProvider } from '@tastic/cards'
import { rotateInsets, useRotatedWindowDimensions, useRotation } from '@tastic/core'
import { createContext, memo, ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import Animated, { SharedValue, useAnimatedStyle, useFrameCallback, useSharedValue } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Card } from '@/engine/types'

import { FaceLoadTrackingContext, useGhostPaintGate } from '../cardFacePaint'
import { ScreenPoint } from '../dealing/measureView'
import { GAME_CONTENT_TOP_PADDING } from '../gameLayout'
import { screenToLocalPoint } from '../overlayFrame'
import { PlayingCard } from '../PlayingCard'
import { BOUNCE_V_HALF_PERIOD_MAX_MS, BOUNCE_V_HALF_PERIOD_MIN_MS, cardXAtElapsed, cardYAtElapsed, CascadeBounds, cascadeBounds, CHAIN_SEGMENT_DELAY_MS, ChainPath, fitXToBounds, fitYToBounds, isGhostVisible, spreadHHalfPeriods } from './winCascadeMotion'

export interface ChainSpec {
  /** Head-to-tail order - index 0 leads the chain (e.g. a foundation pile's King, or Pyramid's
   * most-recently-discarded card). */
  cards: Card[]
  origin: ScreenPoint
  /** Opt-in: where each card of `cards` really stands on screen (same screen-space as `origin`,
   * aligned by index - e.g. a fanned column's cards, each at its own spot). A card with an entry
   * waits there, visible, until its entrance, then falls onto the racked chain (see
   * cardXAtElapsed); a card without one - or a chain with no `cardOrigins` at all - starts on
   * `origin` exactly as it always did. Each entry must be card-sized, like `origin`: it goes through
   * the same rotation conversion. */
  cardOrigins?: ScreenPoint[]
  /** This chain's own launch delay relative to the cascade's other chains. */
  entranceDelayMs: number
  /** Opt-in: this chain's own delay between successive cards (CHAIN_SEGMENT_DELAY_MS when omitted). A chain's total lag
   * (cards * this) has to stay well under the bounce half-period or its tail lands in the opposite leg and the snake splits
   * apart - fine at the default 42ms for the ~13-card chains that value was tuned on, not for a 52-card one (~2.1s). Pass
   * chainSegmentDelayMs(cards.length) to cap the whole chain's span instead. */
  segmentDelayMs?: number
}

export interface WinCascadeController {
  /** Launches every chain at once, each card racked nose-to-tail behind its own chain's head,
   * bouncing forever. Calling this again (a fresh win) implicitly clears whatever was running.
   *
   * The ghosts are mounted at once but do NOT appear in that commit: every ghost that is drawn while parked (each chain's
   * head, and every card with a `cardOrigins` spot) is a freshly mounted face Image, blank for a frame or two
   * (cardFacePaint.ts), standing exactly where the real card is. So the whole cascade stays invisible - and its clock
   * stopped, nothing moves - until those faces have painted (WIN_CASCADE_PAINT_MAX_MS at most), and `onShown` runs in the commit
   * it appears (a layout effect): that is where a screen hands its piles over (blanks the real cards the ghosts stand in
   * for), so the piles are never empty before the ghosts are on screen, and never showing over blank ghosts either.
   * `onShown` runs at most once, never for an empty `chains`, and never once a clear() or a newer startChains has replaced
   * this cascade (it is dropped with it). */
  startChains(chains: ChainSpec[], cardWidth: number, onShown?: () => void): void
  /** Unmounts every ghost, hard-stopping every loop - the only way this ever stops, since every
   * chain loops via withRepeat(-1). Call from "New Game". */
  clear(): void
}

interface WinCascadeContextValue {
  controller: WinCascadeController
  cascade: CascadeState
  /** Shared with WinCascadeGhosts purely as the key of its one CascadeChains: a fresh generation (every startChains and
   * clear) forces a real unmount+remount instead of reusing stale instances - the ghosts' shared values and frame
   * callbacks, the paint gate, the clock and the `onShown` that belonged to the cascade before it all go with it. State,
   * not a ref: WinCascadeGhosts reads it during render, and reading a ref's `.current` during render isn't allowed. */
  generation: number
}

const WinCascadeContext = createContext<WinCascadeContextValue | null>(null)

export function useWinCascade(): WinCascadeController {
  const ctx = useContext(WinCascadeContext)
  if (!ctx) throw new Error('useWinCascade must be used within a WinCascadeProvider')
  return ctx.controller
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function buildChainPath(origin: ScreenPoint, bounds: CascadeBounds, chainIndex: number, hHalfPeriodMs: number): ChainPath {
  const vHalfPeriodMs = randomBetween(BOUNCE_V_HALF_PERIOD_MIN_MS, BOUNCE_V_HALF_PERIOD_MAX_MS)

  const { leftX, rightX, floorY, apexY } = bounds
  const nearX = Math.abs(origin.x - leftX) < Math.abs(rightX - origin.x) ? leftX : rightX
  const farX = nearX === leftX ? rightX : leftX
  // Which wall a chain heads toward first alternates by chain index rather than being each chain's
  // own coin flip - a coin flip can still land every chain on the same side by chance (with only a
  // handful of chains per win, that's common enough to read as "they all stick together"), while
  // alternating guarantees the chains starting closest together in time immediately split toward
  // opposite walls instead of leaving separation up to chance.
  const startTowardFar = chainIndex % 2 === 0
  const firstX = startTowardFar ? farX : nearX
  const secondX = startTowardFar ? nearX : farX
  // The one-time leg from the real origin to whichever wall it's heading toward first, scaled to
  // that fraction of the full wall-to-wall span, so it moves at the same speed the steady-state
  // loop will regardless of which wall (and therefore how far) that first leg turned out to be.
  const span = Math.max(1, Math.abs(rightX - leftX))
  const initialLegMs = hHalfPeriodMs * (Math.abs(origin.x - firstX) / span)

  return { origin, floorY, apexY, vHalfPeriodMs, firstX, secondX, hHalfPeriodMs, initialLegMs }
}

interface ChainGhostCardProps {
  card: Card
  path: ChainPath
  delayMs: number
  segmentDelayMs: number
  offsetX: number
  offsetY: number
  alwaysVisible: boolean
  /** Paint order (see CascadeChains: the ghosts are mounted heads-first, so the stacking is explicit). */
  zIndex: number
  /** The cascade's t=0 (see CascadeChains): null until the ghosts have shown. */
  startMs: SharedValue<number | null>
  /** Set for a card the cascade's paint gate waits on (see CascadeChains), called with its id once its face has painted. */
  onFacePainted?: (cardId: string) => void
  /** The bounce box as it is NOW (see CascadeChains): `path` was built in the one at the win. */
  bounds: SharedValue<CascadeBounds>
  containerOffsetX: SharedValue<number>
  containerOffsetY: SharedValue<number>
}

// Memoized: CascadeChains re-renders once per face its paint gate hears from (Scorpion's runs stand every card in its own
// spot, so up to 52), and every prop here is stable for the cascade's whole life (its path, numbers and shared values are
// built once by startChains; onFacePainted is the gate's own stable markPainted) - without this, each of those renders
// would re-render every ghost in the cascade.
const ChainGhostCard = memo(function ChainGhostCard({ card, path, delayMs, segmentDelayMs, offsetX, offsetY, alwaysVisible, zIndex, startMs, onFacePainted, bounds, containerOffsetX, containerOffsetY }: ChainGhostCardProps) {
  // Parked where the real card stood until this card's own entrance - VISIBLE, not hidden until then:
  // a screen blanks its real cards as the cascade takes over, so a ghost waiting invisible for its
  // entrance (chain i enters i * CHAIN_ENTRANCE_STAGGER_MS late, a card 42ms after the one ahead of
  // it) left the piles/slots/columns empty for up to ~1.5s with no card standing where one had just
  // been. See isGhostVisible for which cards show while parked, and cardXAtElapsed for offsetX/Y.
  // (Visible once the whole cascade shows - see CascadeChains' paint gate.)
  const bx = useSharedValue(path.origin.x + offsetX)
  const by = useSharedValue(path.origin.y + offsetY)
  const opacity = useSharedValue(alwaysVisible ? 1 : 0)

  // Driven entirely by useFrameCallback rather than a chain of setTimeout-triggered withTiming
  // calls - every frame, this card's position is RECOMPUTED from scratch as a pure function of
  // real elapsed time (see cardXAtElapsed/cardYAtElapsed), not advanced incrementally
  // from wherever a previous scheduled callback left off. That statelessness is what makes it
  // immune to the bug the old per-card setTimeout chains had: 13 independent timers only
  // CHAIN_SEGMENT_DELAY_MS apart could get coalesced by the browser's scheduler into firing
  // together, locking pairs of cards to the same position. A pure function has nothing to
  // coalesce - two cards' relative offset is exactly delayMs apart by construction, every frame.
  // Until the cascade's clock has started (startMs null) every card is held at the cascade's t=0: parked, the heads (and
  // cards with spots of their own) drawn and the rest hidden under them - exactly the first frame of the cascade, so it
  // starts from there the moment it shows instead of having moved on while it was invisible.
  // The path is the one built at the win, in that frame's bounds; each position is then moved into the bounds as they are now
  // (fitXToBounds), so a rotation mid-cascade turns the bounce with the frame instead of leaving it in the old one's shape.
  useFrameCallback((frameInfo) => {
    const start = startMs.value
    const elapsed = (start === null ? 0 : frameInfo.timestamp - start) - delayMs
    const now = bounds.value
    opacity.value = isGhostVisible(elapsed, alwaysVisible, segmentDelayMs) ? 1 : 0
    by.value = fitYToBounds(path, now, cardYAtElapsed(path, elapsed, offsetY))
    bx.value = fitXToBounds(path, now, cardXAtElapsed(path, elapsed, offsetX))
  })

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateX: bx.value - containerOffsetX.value }, { translateY: by.value - containerOffsetY.value }]
  }))

  const handleFacePainted = useCallback(() => onFacePainted?.(card.id), [onFacePainted, card.id])

  return (
    <Animated.View style={[styles.ghostCard, { zIndex }, style]}>
      {/* A ghost: its face is not the board's (see cardFacePaint.ts). */}
      <FaceLoadTrackingContext.Provider value={false}>
        <PlayingCard card={card} onFacePainted={onFacePainted ? handleFacePainted : undefined} />
      </FaceLoadTrackingContext.Provider>
    </Animated.View>
  )
})

interface ResolvedChain {
  path: ChainPath
  /** The chain's own delay between successive cards (ChainSpec.segmentDelayMs, else CHAIN_SEGMENT_DELAY_MS). */
  segmentDelayMs: number
  /** Tail-to-head render order, so each chain's head card paints on top of its own tail. `offsetX/Y`
   * are where the card really stood minus the chain's origin (0 without a cardOrigins entry, in the
   * rotated frame the path lives in), `alwaysVisible` whether it shows while parked - see
   * isGhostVisible. */
  cards: { card: Card; delayMs: number; offsetX: number; offsetY: number; alwaysVisible: boolean }[]
}

/** `bounds` is the bounce box every path was built in (the frame at the win). */
type CascadeState = { mode: 'idle' } | { mode: 'chains'; chains: ResolvedChain[]; cardWidth: number; bounds: CascadeBounds; onShown?: () => void }

/** The frame the ghosts bounce in: the rotated window (see FakeLandscapeView: width and height swap under a quarter turn) and
 * the bottom of the header band in that frame's own coordinates - the same band GameChrome reserves above the board (its top
 * safe-area inset, remapped onto the rotated frame, plus GAME_CONTENT_TOP_PADDING), where every chain bounces up to. Exact
 * identity with plain useWindowDimensions()/useSafeAreaInsets() for a screen with no rotated wrapper. */
function useCascadeFrame(): { width: number; height: number; headerBottom: number } {
  const { width, height } = useRotatedWindowDimensions()
  const rotation = useRotation()
  const insets = useSafeAreaInsets()
  return { width, height, headerBottom: rotateInsets(insets, rotation).top + GAME_CONTENT_TOP_PADDING }
}

/** Provides the win-cascade controller (see useWinCascade) to a game screen - deliberately does
 * NOT render the bouncing cards itself. Rendering is a separate component, WinCascadeGhosts,
 * placed explicitly by the screen wherever it needs to paint in that screen's own JSX (typically
 * right before the win banner, so the banner - a later sibling - paints on top of the cards, not
 * the other way around; see each Game Screen's own render for exactly where). Splitting these
 * apart is what makes that orderable: this codebase's own z-order idiom is "later sibling wins,
 * regardless of nesting" (see dragdrop/DragGhostLayer.tsx's comment on why), so the *screen*, not
 * this module, has to own where in its tree the cards actually paint. */
export function WinCascadeProvider({ children }: { children: ReactNode }) {
  const [cascade, setCascade] = useState<CascadeState>({ mode: 'idle' })
  const [generation, setGeneration] = useState(0)
  // The frame the paths are built in. A resize after the win (a rotation) doesn't rebuild them: CascadeChains moves every
  // position into the new frame instead.
  const { width: winWidth, height: winHeight, headerBottom } = useCascadeFrame()
  // Read at startChains-call time via the ref (not the useMemo's own deps) so the controller
  // identity stays stable across resizes, the same way useDealAnimator's does.
  const boundsRef = useRef({ width: winWidth, height: winHeight })
  // The real (unrotated) window and the current rotation, for converting each chain's screen-space
  // origin into the rotated frame the bounce path itself lives in (see startChains below).
  const rotation = useRotation()
  const { width: screenWidth, height: screenHeight } = useWindowDimensions()
  const screenRef = useRef({ rotation, width: screenWidth, height: screenHeight })
  useEffect(() => {
    screenRef.current = { rotation, width: screenWidth, height: screenHeight }
  }, [rotation, screenWidth, screenHeight])
  const headerBottomRef = useRef(headerBottom)
  useEffect(() => {
    headerBottomRef.current = headerBottom
  }, [headerBottom])
  useEffect(() => {
    // useRotatedWindowDimensions() can transiently report a degenerate 0x0 size (e.g. right after a fresh
    // web navigation, before the viewport has settled) - guard against ever computing a chain's
    // bounce path against that, which would send every card wildly off-screen. Keeping the last
    // known-good size until a real one arrives is harmless: it's only ever off by a frame or two.
    if (winWidth > 0 && winHeight > 0) {
      boundsRef.current = { width: winWidth, height: winHeight }
    }
  }, [winWidth, winHeight])

  const controller = useMemo<WinCascadeController>(
    () => ({
      startChains(chains, cardWidth, onShown) {
        setGeneration((g) => g + 1)
        if (chains.length === 0) {
          setCascade({ mode: 'idle' })
          return
        }
        const cardHeight = cardWidth / CARD_ASPECT
        // Every chain bounces between the same two heights - the screen's bottom and the bottom of the header - so what tells chains
        // apart is their horizontal speed alone: one distinct half-period per chain (see spreadHHalfPeriods).
        const hHalfPeriods = spreadHHalfPeriods(chains.length)
        const bounds = cascadeBounds(boundsRef.current, cardWidth, cardHeight, headerBottomRef.current)
        // chain.origin is a screen-space measurement, but boundsRef above is the ROTATED footprint
        // (that's the frame the ghosts render and bounce in under a landscape hold), so an origin
        // measured on a rotated board has to be converted into it first. A no-op at rotation 0, where
        // WinCascadeGhosts' own overlay-offset subtraction already handles screen -> overlay space.
        const { rotation: rot, width: sw, height: sh } = screenRef.current
        const toLocal = (point: ScreenPoint): ScreenPoint => (rot === 0 ? point : screenToLocalPoint(point.x, point.y, cardWidth, cardHeight, rot, sw, sh))
        const resolved: ResolvedChain[] = chains.map((chain, chainIndex) => {
          const origin = toLocal(chain.origin)
          const segmentDelayMs = chain.segmentDelayMs ?? CHAIN_SEGMENT_DELAY_MS
          return {
            segmentDelayMs,
            path: buildChainPath(origin, bounds, chainIndex, hHalfPeriods[chainIndex]),
            cards: chain.cards
              .map((card, i) => {
                // Converted with the same function as the chain's own origin, so the offset between them is the
                // real (rotated-frame) distance between the two spots.
                const own = chain.cardOrigins?.[i]
                const local = own ? toLocal(own) : null
                // The head (index 0) is the card the real pile showed; a card with a spot of its own stood there too.
                return { card, delayMs: chain.entranceDelayMs + i * segmentDelayMs, offsetX: local ? local.x - origin.x : 0, offsetY: local ? local.y - origin.y : 0, alwaysVisible: i === 0 || !!local }
              })
              .reverse()
          }
        })
        // onShown lives and dies with this cascade: replaced by the next startChains, dropped by clear() (an empty `chains`
        // above never gets one - there is nothing to show), and called by CascadeChains, keyed by this generation.
        setCascade({ mode: 'chains', chains: resolved, cardWidth, bounds, onShown })
      },
      clear() {
        setGeneration((g) => g + 1)
        setCascade({ mode: 'idle' })
      }
    }),
    []
  )

  const value = useMemo<WinCascadeContextValue>(() => ({ controller, cascade, generation }), [controller, cascade, generation])

  return <WinCascadeContext.Provider value={value}>{children}</WinCascadeContext.Provider>
}

/** Renders the actual bouncing chains - place this explicitly in a game screen's own JSX, as a
 * plain sibling among its other screen-level overlays (Fireworks, the win banner, etc.), wherever
 * it should paint relative to them. Always mounted (only its cascade.mode==='chains' children are
 * conditional) so its own offset-correction effect can measure a real position at all times, the
 * same reasoning DealLayer/DragGhostLayer's own always-mounted overlays already rely on.
 * pointerEvents="none" means these cards never block whatever's underneath, including "New Game",
 * for as long as the cascade runs. */
export function WinCascadeGhosts() {
  const ctx = useContext(WinCascadeContext)
  if (!ctx) throw new Error('WinCascadeGhosts must be used within a WinCascadeProvider')
  const { cascade, generation } = ctx

  const overlayRef = useRef<View>(null)
  const containerOffsetX = useSharedValue(0)
  const containerOffsetY = useSharedValue(0)
  // Rotation-aware, same reasoning as WinCascadeProvider's own boundsRef above.
  const { width: winWidth, height: winHeight } = useRotatedWindowDimensions()

  useEffect(() => {
    overlayRef.current?.measureInWindow((x, y) => {
      containerOffsetX.value = x
      containerOffsetY.value = y
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [winWidth, winHeight])

  return (
    <View ref={overlayRef} pointerEvents='none' style={StyleSheet.absoluteFill}>
      {cascade.mode === 'chains' && <CascadeChains key={generation} chains={cascade.chains} cardWidth={cascade.cardWidth} initialBounds={cascade.bounds} onShown={cascade.onShown} containerOffsetX={containerOffsetX} containerOffsetY={containerOffsetY} />}
    </View>
  )
}

/**
 * How long the cascade may stay invisible waiting for its parked faces (useGhostPaintGate) - far longer than a move's
 * GHOST_PAINT_MAX_MS, because nothing waits on it: the real cards stand in for the ghosts the whole time and only the bounce
 * starts later, while a move's cap bounds how long the next card in a stream can be held back. At 80ms the cap ran out on the
 * Simulator (a Metro-served build re-fetches every new Image's bitmap, on a JS thread busy with the win) and two of four
 * Kings were handed over as blank faces for ~6 frames. Normally the faces report in a frame or two.
 */
export const WIN_CASCADE_PAINT_MAX_MS = 500

/**
 * One cascade's ghosts - keyed by the provider's generation (see WinCascadeGhosts), so every startChains mounts a fresh one
 * and clear() unmounts it, along with its gate, its clock and its `onShown`.
 *
 * The cascade takes over from real cards still on screen: each chain's head (and every card with a spot of its own) is
 * parked exactly where a real card stands, and the screen blanks those real cards to hand them over. But a ghost's face is a
 * freshly mounted Image, blank for a frame or two (cardFacePaint.ts) - parked ghosts that showed from their first commit
 * were blank cards on every pile as the celebration started, and blanking the piles any earlier left them empty. So the
 * cascade is invisible (React-owned opacity, so it changes in a known commit) until every face drawn while parked has
 * painted (useGhostPaintGate, WIN_CASCADE_PAINT_MAX_MS at most), the real cards standing in for them meanwhile. In the commit it
 * shows (the gate's layout effect) its clock starts and the screen's `onShown` runs: the hand-off then blanks the piles in
 * the next, synchronous commit - the ghosts are on screen no later than the piles go, same pixels in the one commit both
 * show. Only the parked faces are waited on: the rest of a chain is hidden under its head and only shows once the card ahead
 * of it has left (isGhostVisible) - mounted in the same commit as the faces waited on, it loads alongside them, and even a
 * chain that leaves at once uncovers its second card only gradually (the head's fall starts from rest).
 */
function CascadeChains({ chains, cardWidth, initialBounds, onShown, containerOffsetX, containerOffsetY }: { chains: ResolvedChain[]; cardWidth: number; initialBounds: CascadeBounds; onShown?: () => void; containerOffsetX: SharedValue<number>; containerOffsetY: SharedValue<number> }) {
  // The cascade's t=0 - what every card measures its own elapsed time against (elapsed = frameInfo.timestamp - startMs
  // - delayMs, see ChainGhostCard) - null until the ghosts have shown: nothing moves while they are invisible, so a chain
  // that enters at once leaves from where its head is seen standing instead of from wherever it had got to by then.
  // performance.now() on the JS thread at the commit they show, compared with frameInfo.timestamp - the SAME
  // requestAnimationFrame timestamp Reanimated's frame-callback registry passes to every registered callback in a given tick
  // (see FrameCallbackRegistryUI.ts's single shared rAF loop), in the same clock domain as performance.now() - so every
  // card's position is a pure, stateless function of real elapsed time, computed fresh every frame. That's what makes two
  // cards' relative offset exactly delayMs apart forever, with nothing to drift or coalesce - unlike the old design, where
  // each card ran its own independent setTimeout chain and 20ms-apart chains could get coalesced by the browser's timer
  // scheduler into firing at the same tick, locking pairs of cards together.
  const startMs = useSharedValue<number | null>(null)
  // Every face drawn while the cascade is parked (see isGhostVisible): what the gate waits for. A face-down card is SVG,
  // drawn in the frame it mounts, and never reports.
  const faceIds = useMemo(() => chains.flatMap((chain) => chain.cards.filter((c) => c.alwaysVisible && c.card.faceUp).map((c) => c.card.id)), [chains])
  // Once per cascade: the gate's layout effect re-runs whenever this callback's identity changes while it is shown.
  const shownRef = useRef(false)
  const handleShown = useCallback(() => {
    if (shownRef.current) return
    shownRef.current = true
    onShown?.()
  }, [onShown])
  const { shown, markPainted } = useGhostPaintGate(faceIds, handleShown, WIN_CASCADE_PAINT_MAX_MS)
  // The clock starts in that same commit, a layout effect like the gate's own (`shown` only ever turns true once).
  useLayoutEffect(() => {
    if (shown) startMs.value = performance.now()
  }, [shown, startMs])
  // The bounce box as it is now, for every ghost's frame callback to move its position into (fitXToBounds): the paths keep the
  // box they were built in at the win, and a rotation (or any resize) while the cascade runs only changes this. A layout effect,
  // so it reaches the UI thread as close as it can to the commit that turns the frame. A degenerate 0x0 reading (see the
  // provider's boundsRef) keeps the last real box.
  const bounds = useSharedValue(initialBounds)
  const { width, height, headerBottom } = useCascadeFrame()
  useLayoutEffect(() => {
    if (width > 0 && height > 0) bounds.value = cascadeBounds({ width, height }, cardWidth, cardWidth / CARD_ASPECT, headerBottom)
  }, [bounds, width, height, cardWidth, headerBottom])
  // Full-size, like the overlay it fills: a view whose only children are absolutely positioned must never lay out as a
  // zero frame (see DealLayer.tsx's slotSize - React Native's iOS view recycling). Never flattened (collapsable): once shown
  // it carries no visual prop of its own, and Fabric would otherwise drop it from the native tree in that very commit and
  // re-parent every ghost - churn in the one commit that has to be exactly "the same ghosts, now visible".
  // Mounted heads first: every chain's head, then every chain's second card, and so on - the order the faces are needed in.
  // Each face is a fresh Image whose bitmap iOS requests in mount order and loads a few at a time, so mounted tail-to-head
  // (the paint order) the heads the gate waits on were requested LAST, behind every hidden follower: on the Simulator
  // (a Metro-served build fetches each bitmap) the heads arrived one by one over ~0.5s+ and the cap handed the piles over
  // to blank Kings. The paint order is kept with zIndex: the old order, chain by chain, each chain tail to head.
  const ghosts = useMemo(() => {
    const entries = chains.flatMap((chain, chainIndex) => chain.cards.map((c, i) => ({ chain, c, depth: chain.cards.length - 1 - i, chainIndex })))
    const painted = entries.map((e, zIndex) => ({ ...e, zIndex }))
    return painted.sort((a, b) => a.depth - b.depth || a.chainIndex - b.chainIndex)
  }, [chains])

  return (
    <View collapsable={false} style={[StyleSheet.absoluteFill, !shown && styles.unpainted]}>
      <CardSizeProvider width={cardWidth}>
        {ghosts.map(({ chain, c: { card, delayMs, offsetX, offsetY, alwaysVisible }, zIndex }) => (
          <ChainGhostCard key={card.id} card={card} path={chain.path} delayMs={delayMs} segmentDelayMs={chain.segmentDelayMs} offsetX={offsetX} offsetY={offsetY} alwaysVisible={alwaysVisible} zIndex={zIndex} startMs={startMs} onFacePainted={alwaysVisible && card.faceUp ? markPainted : undefined} bounds={bounds} containerOffsetX={containerOffsetX} containerOffsetY={containerOffsetY} />
        ))}
      </CardSizeProvider>
    </View>
  )
}

const styles = StyleSheet.create({
  ghostCard: {
    left: 0,
    position: 'absolute',
    top: 0
  },
  unpainted: {
    opacity: 0
  }
})
