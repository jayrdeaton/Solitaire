import { CARD_ASPECT, CardSizeProvider } from '@tastic/cards'
import { createContext, ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import Animated, { SharedValue, useAnimatedStyle, useFrameCallback, useSharedValue } from 'react-native-reanimated'

import { Card } from '@/engine/types'

import { ScreenPoint } from '../dealing/measureView'
import { PlayingCard } from '../PlayingCard'
import { BOUNCE_APEX_CONSERVATIVE_FRACTION, BOUNCE_FLOOR_MARGIN_PX, BOUNCE_H_HALF_PERIOD_MAX_MS, BOUNCE_H_HALF_PERIOD_MIN_MS, BOUNCE_H_MARGIN_PX, BOUNCE_MIN_SPAN_PX, BOUNCE_TOP_MARGIN_PX, BOUNCE_V_HALF_PERIOD_MAX_MS, BOUNCE_V_HALF_PERIOD_MIN_MS, CHAIN_SEGMENT_DELAY_MS } from './winCascadeMotion'

export interface ChainSpec {
  /** Head-to-tail order - index 0 leads the chain (e.g. a foundation pile's King, or Pyramid's
   * most-recently-discarded card). */
  cards: Card[]
  origin: ScreenPoint
  /** This chain's own launch delay relative to the cascade's other chains. */
  entranceDelayMs: number
}

export interface WinCascadeController {
  /** Launches every chain at once, each card racked nose-to-tail behind its own chain's head,
   * bouncing forever. Calling this again (a fresh win) implicitly clears whatever was running. */
  startChains(chains: ChainSpec[], cardWidth: number): void
  /** Unmounts every ghost, hard-stopping every loop - the only way this ever stops, since every
   * chain loops via withRepeat(-1). Call from "New Game". */
  clear(): void
}

interface WinCascadeContextValue {
  controller: WinCascadeController
  cascade: CascadeState
  /** Shared with WinCascadeGhosts purely for its ghost keys - see WinCascadeProvider's own comment
   * on why a fresh generation forces a real unmount+remount instead of reusing stale instances.
   * State, not a ref: WinCascadeGhosts reads it during render, and reading a ref's `.current`
   * during render isn't allowed. */
  generation: number
}

const WinCascadeContext = createContext<WinCascadeContextValue | null>(null)

export function useWinCascade(): WinCascadeController {
  const ctx = useContext(WinCascadeContext)
  if (!ctx) throw new Error('useWinCascade must be used within a WinCascadeProvider')
  return ctx.controller
}

/** One chain's bounce path - randomized once per chain (see buildChainPath), then shared by
 * reference across every card in that chain, which is what keeps a chain racked together forever
 * instead of each card drifting off on its own independent physics. */
interface ChainPath {
  origin: ScreenPoint
  floorY: number
  apexY: number
  vHalfPeriodMs: number
  /** Wall this chain heads toward on its one-time launch leg, then away from/back to forever after
   * (see the coin flip below for why this isn't always the geometrically nearer wall). */
  firstX: number
  secondX: number
  hHalfPeriodMs: number
  initialLegMs: number
  /** performance.now() at the instant this chain launched - the one shared "t=0" every card in
   * the chain measures its own elapsed time against (elapsed = frameInfo.timestamp - chainStartMs
   * - delayMs, see ChainGhostCard). frameInfo.timestamp comes from the SAME requestAnimationFrame
   * timestamp Reanimated's frame-callback registry passes to every registered callback in a given
   * tick (see FrameCallbackRegistryUI.ts's single shared rAF loop) - the same clock domain as
   * performance.now() - so every card's position is a pure, stateless function of real elapsed
   * time, computed fresh every frame. That's what makes two cards' relative offset exactly
   * delayMs apart forever, with nothing to drift or coalesce - unlike the old design, where each
   * card ran its own independent setTimeout chain and 20ms-apart chains could get coalesced by the
   * browser's timer scheduler into firing at the same tick, locking pairs of cards together. */
  chainStartMs: number
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

/** Assigns each chain's fixed floor and apex heights for one cascade launch, given every chain's
 * own (already-drawn) horizontal half-period. All chains share the same floor (the screen's
 * actual bottom). Apex height is RANKED by speed across this specific set of chains, not derived
 * from each chain's own half-period in isolation - the fastest chain always reaches
 * BOUNCE_TOP_MARGIN_PX (the very top of the screen), the slowest always reaches
 * BOUNCE_APEX_CONSERVATIVE_FRACTION of the way there (a deliberately modest bounce, never as low
 * as the absolute minimum the screen would allow), and any chains in between are spaced evenly by
 * rank. Ranking (rather than mapping each chain's raw half-period linearly against the fixed
 * BOUNCE_H_HALF_PERIOD_MIN/MAX_MS range) guarantees this spread every single cascade, regardless
 * of how tightly or widely this particular random draw of half-periods happened to cluster. */
function computeCascadeVerticals(hHalfPeriods: number[], bounds: { width: number; height: number }, cardHeight: number): { floorY: number; apexYs: number[] } {
  const floorY = bounds.height - cardHeight - BOUNCE_FLOOR_MARGIN_PX
  const apexMax = Math.max(BOUNCE_TOP_MARGIN_PX, floorY - BOUNCE_MIN_SPAN_PX)
  const conservativeLowY = BOUNCE_TOP_MARGIN_PX + BOUNCE_APEX_CONSERVATIVE_FRACTION * (apexMax - BOUNCE_TOP_MARGIN_PX)
  const order = hHalfPeriods.map((_, chainIndex) => chainIndex).sort((a, b) => hHalfPeriods[a] - hHalfPeriods[b])
  const apexYs = new Array(hHalfPeriods.length).fill(BOUNCE_TOP_MARGIN_PX)
  order.forEach((chainIndex, rank) => {
    const rankFraction = order.length > 1 ? rank / (order.length - 1) : 0
    apexYs[chainIndex] = BOUNCE_TOP_MARGIN_PX + rankFraction * (conservativeLowY - BOUNCE_TOP_MARGIN_PX)
  })
  return { floorY, apexYs }
}

function buildChainPath(origin: ScreenPoint, bounds: { width: number; height: number }, cardWidth: number, chainIndex: number, hHalfPeriodMs: number, floorY: number, apexY: number): ChainPath {
  const vHalfPeriodMs = randomBetween(BOUNCE_V_HALF_PERIOD_MIN_MS, BOUNCE_V_HALF_PERIOD_MAX_MS)

  const leftX = BOUNCE_H_MARGIN_PX
  const rightX = bounds.width - cardWidth - BOUNCE_H_MARGIN_PX
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

  return { origin, floorY, apexY, vHalfPeriodMs, firstX, secondX, hHalfPeriodMs, initialLegMs, chainStartMs: performance.now() }
}

function easeInQuad(f: number): number {
  'worklet'
  return f * f
}

function easeOutQuad(f: number): number {
  'worklet'
  const g = 1 - f
  return 1 - g * g
}

/** Pure function of elapsed time since a card's own launch (already delay-adjusted by the
 * caller) - no state, no scheduling, just math. Before the launch leg completes (elapsedMs <
 * vHalfPeriodMs), it's a straight accelerating fall from the real origin to the floor (see
 * ChainGhostCard's old doc comment on why this is always a fall, never the apex, and why it
 * always accelerates). After that, it's a forever-repeating rise-to-apex/fall-to-floor cycle,
 * each leg exactly vHalfPeriodMs long. Being pure is the whole point: two cards evaluate the
 * exact same function, just at elapsedMs values exactly delayMs apart, so their relative offset
 * can never drift or coalesce the way independently-scheduled timers could (see ChainPath's
 * chainStartMs doc comment). */
function verticalYAtElapsed(path: ChainPath, elapsedMs: number): number {
  'worklet'
  if (elapsedMs <= 0) return path.origin.y
  if (elapsedMs < path.vHalfPeriodMs) {
    const frac = elapsedMs / path.vHalfPeriodMs
    return path.origin.y + (path.floorY - path.origin.y) * easeInQuad(frac)
  }
  const cyclePos = (elapsedMs - path.vHalfPeriodMs) % (2 * path.vHalfPeriodMs)
  if (cyclePos < path.vHalfPeriodMs) {
    const frac = cyclePos / path.vHalfPeriodMs
    return path.floorY + (path.apexY - path.floorY) * easeOutQuad(frac)
  }
  const frac = (cyclePos - path.vHalfPeriodMs) / path.vHalfPeriodMs
  return path.apexY + (path.floorY - path.apexY) * easeInQuad(frac)
}

/** Same idea as verticalYAtElapsed, for the horizontal bounce - linear throughout (see
 * buildChainPath's firstX/secondX), so no easing curves needed, just a triangle wave. */
function horizontalXAtElapsed(path: ChainPath, elapsedMs: number): number {
  'worklet'
  if (elapsedMs <= 0) return path.origin.x
  if (elapsedMs < path.initialLegMs) {
    const frac = elapsedMs / path.initialLegMs
    return path.origin.x + (path.firstX - path.origin.x) * frac
  }
  const cyclePos = (elapsedMs - path.initialLegMs) % (2 * path.hHalfPeriodMs)
  if (cyclePos < path.hHalfPeriodMs) {
    const frac = cyclePos / path.hHalfPeriodMs
    return path.firstX + (path.secondX - path.firstX) * frac
  }
  const frac = (cyclePos - path.hHalfPeriodMs) / path.hHalfPeriodMs
  return path.secondX + (path.firstX - path.secondX) * frac
}

function ChainGhostCard({ card, path, delayMs, containerOffsetX, containerOffsetY }: { card: Card; path: ChainPath; delayMs: number; containerOffsetX: SharedValue<number>; containerOffsetY: SharedValue<number> }) {
  const bx = useSharedValue(path.origin.x)
  const by = useSharedValue(path.origin.y)
  const opacity = useSharedValue(0)

  // Driven entirely by useFrameCallback rather than a chain of setTimeout-triggered withTiming
  // calls - every frame, this card's position is RECOMPUTED from scratch as a pure function of
  // real elapsed time (see verticalYAtElapsed/horizontalXAtElapsed), not advanced incrementally
  // from wherever a previous scheduled callback left off. That statelessness is what makes it
  // immune to the bug the old per-card setTimeout chains had: 13 independent timers only
  // CHAIN_SEGMENT_DELAY_MS apart could get coalesced by the browser's scheduler into firing
  // together, locking pairs of cards to the same position. A pure function has nothing to
  // coalesce - two cards' relative offset is exactly delayMs apart by construction, every frame.
  useFrameCallback((frameInfo) => {
    const elapsed = frameInfo.timestamp - path.chainStartMs - delayMs
    opacity.value = elapsed > 0 ? 1 : 0
    by.value = verticalYAtElapsed(path, elapsed)
    bx.value = horizontalXAtElapsed(path, elapsed)
  })

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateX: bx.value - containerOffsetX.value }, { translateY: by.value - containerOffsetY.value }]
  }))

  return (
    <Animated.View style={[styles.ghostCard, style]}>
      <PlayingCard card={card} />
    </Animated.View>
  )
}

interface ResolvedChain {
  path: ChainPath
  /** Tail-to-head render order, so each chain's head card paints on top of its own tail. */
  cards: { card: Card; delayMs: number }[]
}

type CascadeState = { mode: 'idle' } | { mode: 'chains'; chains: ResolvedChain[]; cardWidth: number }

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
  const { width: winWidth, height: winHeight } = useWindowDimensions()
  // Read at startChains-call time via the ref (not the useMemo's own deps) so the controller
  // identity stays stable across resizes, the same way useDealAnimator's does.
  const boundsRef = useRef({ width: winWidth, height: winHeight })
  useEffect(() => {
    // useWindowDimensions() can transiently report a degenerate 0x0 size (e.g. right after a fresh
    // web navigation, before the viewport has settled) - guard against ever computing a chain's
    // bounce path against that, which would send every card wildly off-screen. Keeping the last
    // known-good size until a real one arrives is harmless: it's only ever off by a frame or two.
    if (winWidth > 0 && winHeight > 0) {
      boundsRef.current = { width: winWidth, height: winHeight }
    }
  }, [winWidth, winHeight])

  const controller = useMemo<WinCascadeController>(
    () => ({
      startChains(chains, cardWidth) {
        setGeneration((g) => g + 1)
        if (chains.length === 0) {
          setCascade({ mode: 'idle' })
          return
        }
        const cardHeight = cardWidth / CARD_ASPECT
        // Every chain's horizontal half-period is drawn up front (rather than inside
        // buildChainPath) so computeCascadeVerticals can rank them against each other before any
        // chain's apex height is assigned - see its own doc comment for why ranking, not each
        // chain's raw half-period in isolation, is what actually guarantees the height spread.
        const hHalfPeriods = chains.map(() => randomBetween(BOUNCE_H_HALF_PERIOD_MIN_MS, BOUNCE_H_HALF_PERIOD_MAX_MS))
        const { floorY, apexYs } = computeCascadeVerticals(hHalfPeriods, boundsRef.current, cardHeight)
        const resolved: ResolvedChain[] = chains.map((chain, chainIndex) => ({
          path: buildChainPath(chain.origin, boundsRef.current, cardWidth, chainIndex, hHalfPeriods[chainIndex], floorY, apexYs[chainIndex]),
          cards: chain.cards.map((card, i) => ({ card, delayMs: chain.entranceDelayMs + i * CHAIN_SEGMENT_DELAY_MS })).reverse()
        }))
        setCascade({ mode: 'chains', chains: resolved, cardWidth })
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
  const { width: winWidth, height: winHeight } = useWindowDimensions()

  useEffect(() => {
    overlayRef.current?.measureInWindow((x, y) => {
      containerOffsetX.value = x
      containerOffsetY.value = y
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [winWidth, winHeight])

  return (
    <View ref={overlayRef} pointerEvents='none' style={StyleSheet.absoluteFill}>
      {cascade.mode === 'chains' && <CardSizeProvider width={cascade.cardWidth}>{cascade.chains.flatMap((chain) => chain.cards.map(({ card, delayMs }) => <ChainGhostCard key={`${generation}-${card.id}`} card={card} path={chain.path} delayMs={delayMs} containerOffsetX={containerOffsetX} containerOffsetY={containerOffsetY} />))}</CardSizeProvider>}
    </View>
  )
}

const styles = StyleSheet.create({
  ghostCard: {
    left: 0,
    position: 'absolute',
    top: 0
  }
})
