import { CARD_ASPECT, CardSizeProvider } from '@tastic/cards'
import { useRotatedWindowDimensions, useRotation } from '@tastic/core'
import { createContext, ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import Animated, { SharedValue, useAnimatedStyle, useFrameCallback, useSharedValue } from 'react-native-reanimated'

import { Card } from '@/engine/types'

import { ScreenPoint } from '../dealing/measureView'
import { screenToLocalPoint } from '../overlayFrame'
import { PlayingCard } from '../PlayingCard'
import { BOUNCE_APEX_CONSERVATIVE_FRACTION, BOUNCE_FLOOR_MARGIN_PX, BOUNCE_H_HALF_PERIOD_MAX_MS, BOUNCE_H_HALF_PERIOD_MIN_MS, BOUNCE_H_MARGIN_PX, BOUNCE_MIN_SPAN_PX, BOUNCE_TOP_MARGIN_PX, BOUNCE_V_HALF_PERIOD_MAX_MS, BOUNCE_V_HALF_PERIOD_MIN_MS, cardXAtElapsed, cardYAtElapsed, CHAIN_SEGMENT_DELAY_MS, ChainPath, isGhostVisible } from './winCascadeMotion'

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

function ChainGhostCard({ card, path, delayMs, segmentDelayMs, offsetX, offsetY, alwaysVisible, containerOffsetX, containerOffsetY }: { card: Card; path: ChainPath; delayMs: number; segmentDelayMs: number; offsetX: number; offsetY: number; alwaysVisible: boolean; containerOffsetX: SharedValue<number>; containerOffsetY: SharedValue<number> }) {
  // Parked where the real card stood until this card's own entrance - VISIBLE, not hidden until then:
  // a screen blanks its real cards as the cascade takes over, so a ghost waiting invisible for its
  // entrance (chain i enters i * CHAIN_ENTRANCE_STAGGER_MS late, a card 42ms after the one ahead of
  // it) left the piles/slots/columns empty for up to ~1.5s with no card standing where one had just
  // been. See isGhostVisible for which cards show while parked, and cardXAtElapsed for offsetX/Y.
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
  useFrameCallback((frameInfo) => {
    const elapsed = frameInfo.timestamp - path.chainStartMs - delayMs
    opacity.value = isGhostVisible(elapsed, alwaysVisible, segmentDelayMs) ? 1 : 0
    by.value = cardYAtElapsed(path, elapsed, offsetY)
    bx.value = cardXAtElapsed(path, elapsed, offsetX)
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
  /** The chain's own delay between successive cards (ChainSpec.segmentDelayMs, else CHAIN_SEGMENT_DELAY_MS). */
  segmentDelayMs: number
  /** Tail-to-head render order, so each chain's head card paints on top of its own tail. `offsetX/Y`
   * are where the card really stood minus the chain's origin (0 without a cardOrigins entry, in the
   * rotated frame the path lives in), `alwaysVisible` whether it shows while parked - see
   * isGhostVisible. */
  cards: { card: Card; delayMs: number; offsetX: number; offsetY: number; alwaysVisible: boolean }[]
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
  // Rotation-aware: winWidth/winHeight swap when rendered inside a rotated wrapper (see
  // RotatedGameView), so the cascade bounces within the screen's real, post-rotation footprint -
  // exact identity with plain useWindowDimensions() for any screen with no such wrapper.
  const { width: winWidth, height: winHeight } = useRotatedWindowDimensions()
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
            path: buildChainPath(origin, boundsRef.current, cardWidth, chainIndex, hHalfPeriods[chainIndex], floorY, apexYs[chainIndex]),
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
      {cascade.mode === 'chains' && <CardSizeProvider width={cascade.cardWidth}>{cascade.chains.flatMap((chain) => chain.cards.map(({ card, delayMs, offsetX, offsetY, alwaysVisible }) => <ChainGhostCard key={`${generation}-${card.id}`} card={card} path={chain.path} delayMs={delayMs} segmentDelayMs={chain.segmentDelayMs} offsetX={offsetX} offsetY={offsetY} alwaysVisible={alwaysVisible} containerOffsetX={containerOffsetX} containerOffsetY={containerOffsetY} />))}</CardSizeProvider>}
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
