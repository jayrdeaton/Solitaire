import { createContext, ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import Animated, { Easing, SharedValue, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from 'react-native-reanimated'

import { Card } from '@/engine/types'

import { CARD_ASPECT, CardSizeProvider } from '../CardSizeContext'
import { ScreenPoint } from '../dealing/measureView'
import { PlayingCard } from '../PlayingCard'
import { BOUNCE_FLOOR_MARGIN_PX, BOUNCE_H_HALF_PERIOD_MAX_MS, BOUNCE_H_HALF_PERIOD_MIN_MS, BOUNCE_H_MARGIN_PX, BOUNCE_MIN_SPAN_PX, BOUNCE_TOP_MARGIN_PX, BOUNCE_V_HALF_PERIOD_MAX_MS, BOUNCE_V_HALF_PERIOD_MIN_MS, CHAIN_SEGMENT_DELAY_MS } from './winCascadeMotion'

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
  nearX: number
  farX: number
  hHalfPeriodMs: number
  initialLegMs: number
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function buildChainPath(origin: ScreenPoint, bounds: { width: number; height: number }, cardWidth: number, cardHeight: number): ChainPath {
  // Both ends of the bounce are independently randomized across nearly the full screen height, not
  // just the apex against a shared floor - otherwise every chain's floor lands in the exact same
  // band and they read as clustering together rather than spreading around the screen. apexY is
  // drawn first, leaving at least BOUNCE_MIN_SPAN_PX of room below it for floorY, so a chain can
  // land anywhere from "bounces across nearly the whole screen" to "stays low and small" - both are
  // wanted, since the mix of heights is what reads as spread rather than a uniform wall of cards.
  const bottomBound = bounds.height - cardHeight - BOUNCE_FLOOR_MARGIN_PX
  const apexMax = Math.max(BOUNCE_TOP_MARGIN_PX, bottomBound - BOUNCE_MIN_SPAN_PX)
  const apexY = randomBetween(BOUNCE_TOP_MARGIN_PX, apexMax)
  const floorY = randomBetween(Math.min(bottomBound, apexY + BOUNCE_MIN_SPAN_PX), bottomBound)
  const vHalfPeriodMs = randomBetween(BOUNCE_V_HALF_PERIOD_MIN_MS, BOUNCE_V_HALF_PERIOD_MAX_MS)

  const leftX = BOUNCE_H_MARGIN_PX
  const rightX = bounds.width - cardWidth - BOUNCE_H_MARGIN_PX
  const nearX = Math.abs(origin.x - leftX) < Math.abs(rightX - origin.x) ? leftX : rightX
  const farX = nearX === leftX ? rightX : leftX
  const hHalfPeriodMs = randomBetween(BOUNCE_H_HALF_PERIOD_MIN_MS, BOUNCE_H_HALF_PERIOD_MAX_MS)
  // The one-time leg from the real origin to whichever wall is nearer, scaled to that fraction of
  // the full wall-to-wall span, so it moves at the same speed the steady-state loop will.
  const span = Math.max(1, Math.abs(rightX - leftX))
  const initialLegMs = hHalfPeriodMs * (Math.abs(origin.x - nearX) / span)

  return { origin, floorY, apexY, vHalfPeriodMs, nearX, farX, hHalfPeriodMs, initialLegMs }
}

function ChainGhostCard({ card, path, delayMs, containerOffsetX, containerOffsetY }: { card: Card; path: ChainPath; delayMs: number; containerOffsetX: SharedValue<number>; containerOffsetY: SharedValue<number> }) {
  const bx = useSharedValue(path.origin.x)
  const by = useSharedValue(path.origin.y)
  const opacity = useSharedValue(0)

  useEffect(() => {
    opacity.value = withDelay(delayMs, withTiming(1, { duration: 0 }))

    // Staged via a plain JS timer rather than nesting withRepeat inside withSequence (which this
    // codebase's own Reanimated-on-web idiom avoids elsewhere too, e.g. DealLayer/DragGhostLayer
    // never trust an animation's own completion callback) - the one-time launch leg from the real
    // origin plays first; once it's done, a second assignment kicks off the infinite steady-state
    // loop. A real elastic bounce under constant gravity is an exactly-periodic parabola, so one
    // repeating fall+rise segment reproduces it with no per-cycle authoring needed.
    by.value = withDelay(delayMs, withTiming(path.apexY, { duration: path.vHalfPeriodMs, easing: Easing.out(Easing.quad) }))
    bx.value = withDelay(delayMs, withTiming(path.nearX, { duration: path.initialLegMs, easing: Easing.linear }))

    const verticalTimer = setTimeout(() => {
      by.value = withRepeat(withSequence(withTiming(path.floorY, { duration: path.vHalfPeriodMs, easing: Easing.in(Easing.quad) }), withTiming(path.apexY, { duration: path.vHalfPeriodMs, easing: Easing.out(Easing.quad) })), -1, false)
    }, delayMs + path.vHalfPeriodMs)

    const horizontalTimer = setTimeout(() => {
      bx.value = withRepeat(withSequence(withTiming(path.farX, { duration: path.hHalfPeriodMs, easing: Easing.linear }), withTiming(path.nearX, { duration: path.hHalfPeriodMs, easing: Easing.linear })), -1, false)
    }, delayMs + path.initialLegMs)

    return () => {
      clearTimeout(verticalTimer)
      clearTimeout(horizontalTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
        const resolved: ResolvedChain[] = chains.map((chain) => ({
          path: buildChainPath(chain.origin, boundsRef.current, cardWidth, cardHeight),
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
