import type { ScreenPoint } from '../dealing/measureView'

// Delay between successive chains (foundation piles / completed runs / the single discard pile)
// starting their own cascade - independent of, and much coarser than, CHAIN_SEGMENT_DELAY_MS
// below. Kept small enough that all of a game's chains read as erupting together, not one pile at
// a time.
export const CHAIN_ENTRANCE_STAGGER_MS = 220

// Delay between successive cards WITHIN one chain - card i (0 = head) starts i * this many ms
// after the chain's own entranceDelayMs. Every card in a chain plays the identical fixed-period
// path, so this constant delay produces a permanent, non-drifting phase offset: the whole chain
// stays racked together nose-to-tail forever instead of spreading apart over time.
//
// A 13-card chain's total span is 12 * this value - that MUST stay comfortably under
// BOUNCE_V_HALF_PERIOD_MIN_MS below, or the tail card starts its own fall/rise more than half a
// bounce cycle behind its King. Once the lag exceeds half a cycle, the tail isn't just "behind" -
// it can land in the OPPOSITE leg (rising while the King is falling, or vice versa), which reads
// as the chain splitting apart rather than one snake trailing its head. At 42ms, a 13-card span
// (504ms) still stays safely under half the shortest half-period's full range (900ms).
export const CHAIN_SEGMENT_DELAY_MS = 42

// The most a LONG chain's tail may trail its head, when its spec opts into a tighter per-card delay (ChainSpec.segmentDelayMs, see
// chainSegmentDelayMs below). The 42ms rule above only holds for the short chains it was tuned on: at 42ms a 52-card chain (all of
// Pyramid's deck in one discard pile) trails its head by ~2.1s, more than TWO bounce half-periods, so its tail is in a different leg
// altogether and the snake reads as a wave, not one chain. 500ms is what a 13-card chain already trails its head by (12 * 42ms),
// which is known to read as one unit and stays under the shortest half-period (900ms) with room to spare.
export const CHAIN_MAX_SPAN_MS = 500

/** The per-card delay for a chain of `cardCount` cards that must stay ONE continuous snake however long it is: the usual
 * CHAIN_SEGMENT_DELAY_MS, tightened just enough that the whole chain's head-to-tail span stays within `maxSpanMs`. Chains of ~13
 * cards or fewer keep (or all but keep) the usual delay. Pass the result as ChainSpec.segmentDelayMs. */
export function chainSegmentDelayMs(cardCount: number, maxSpanMs: number = CHAIN_MAX_SPAN_MS): number {
  if (cardCount <= 1) return CHAIN_SEGMENT_DELAY_MS
  return Math.min(CHAIN_SEGMENT_DELAY_MS, maxSpanMs / (cardCount - 1))
}

// The bounce path itself - assigned once per chain (see buildChainPath/computeCascadeVerticals),
// then shared by every card in that chain via the delay above, never randomized per-card, and
// fixed for the whole cascade (no drift). apexY is RANKED by each chain's own horizontal speed
// against the other chains in this cascade (see computeCascadeVerticals) rather than its own
// independent random draw - the floor is always the screen's actual bottom, shared by every
// chain. BOUNCE_MIN_SPAN_PX is the shortest any one chain's own bounce is allowed to be, so even
// the fastest/highest-bouncing chain never reads as a broken flicker against the floor.
export const BOUNCE_FLOOR_MARGIN_PX = 24
export const BOUNCE_TOP_MARGIN_PX = 24
export const BOUNCE_MIN_SPAN_PX = 220
// vHalfPeriodMs is randomized per chain too (not derived from its own span) so a short bounce
// doesn't automatically read as a frantic flicker - see buildChainPath for how this still keeps
// the motion feeling weighty regardless of how tall that particular chain's arc turned out.
export const BOUNCE_V_HALF_PERIOD_MIN_MS = 900
export const BOUNCE_V_HALF_PERIOD_MAX_MS = 1330
export const BOUNCE_H_MARGIN_PX = 12
// Deliberately a much wider spread than the vertical half-period above (nearly 4x, min to max,
// vs. vertical's ~1.5x) - since every chain now shares the same floor and alternates its starting
// wall by index (see buildChainPath), a wide horizontal speed range is what keeps chains reading as
// visually distinct from each other over time, rather than a uniform mass that only ever splits
// into two lockstep groups (one per starting wall).
export const BOUNCE_H_HALF_PERIOD_MIN_MS = 2500
export const BOUNCE_H_HALF_PERIOD_MAX_MS = 9500

// How far down the available apex range (from BOUNCE_TOP_MARGIN_PX at the top down to the
// screen's true lowest-allowed apex) the SLOWEST chain in a cascade bounces, by rank - see
// computeCascadeVerticals in WinCascadeLayer. 0 would put it at the very top alongside the
// fastest chain (no visible height difference at all); 1 would put it at the absolute lowest
// bounce the screen allows (uncomfortably close to the floor, reading as a weak, stunted hop
// rather than a deliberate "conservative" bounce). 0.75 still keeps it a real, deliberate bounce
// rather than the absolute minimum, while reading noticeably lower/calmer than the fastest chain's.
export const BOUNCE_APEX_CONSERVATIVE_FRACTION = 0.75

/** One chain's bounce path - randomized once per chain (see buildChainPath in WinCascadeLayer), then
 * shared by reference across every card in that chain, which is what keeps a chain racked together
 * forever instead of each card drifting off on its own independent physics. */
export interface ChainPath {
  origin: ScreenPoint
  floorY: number
  apexY: number
  vHalfPeriodMs: number
  /** Wall this chain heads toward on its one-time launch leg, then away from/back to forever after
   * (see the alternation in buildChainPath for why this isn't always the geometrically nearer wall). */
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
 * vHalfPeriodMs), it's a straight accelerating fall from the real origin to the floor (always a
 * fall, never the apex, and always accelerating). After that, it's a forever-repeating
 * rise-to-apex/fall-to-floor cycle, each leg exactly vHalfPeriodMs long. Being pure is the whole
 * point: two cards evaluate the exact same function, just at elapsedMs values exactly delayMs
 * apart, so their relative offset can never drift or coalesce the way independently-scheduled
 * timers could (see ChainPath's chainStartMs doc comment). */
export function verticalYAtElapsed(path: ChainPath, elapsedMs: number): number {
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
export function horizontalXAtElapsed(path: ChainPath, elapsedMs: number): number {
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

/** How much of a card's own starting offset (see cardXAtElapsed) is still applied at `elapsedMs`:
 * all of it while the card is parked (elapsed <= 0), then shrinking linearly to nothing exactly as
 * its first fall lands on the floor (elapsed >= vHalfPeriodMs), and none of it ever after - so the
 * card converges onto the racked chain during that one fall instead of keeping its old spot. */
export function fanOffsetScale(elapsedMs: number, vHalfPeriodMs: number): number {
  'worklet'
  if (elapsedMs <= 0) return 1
  if (elapsedMs >= vHalfPeriodMs) return 0
  return 1 - elapsedMs / vHalfPeriodMs
}

/** A card's x at `elapsedMs`: the chain's shared trajectory, translated by `offsetX` (where the
 * card really stood minus the chain's origin) while that offset decays away (see fanOffsetScale).
 * With offsetX 0 - a card with no origin of its own, i.e. every chain that does not opt in - this is
 * exactly horizontalXAtElapsed. */
export function cardXAtElapsed(path: ChainPath, elapsedMs: number, offsetX: number): number {
  'worklet'
  return horizontalXAtElapsed(path, elapsedMs) + offsetX * fanOffsetScale(elapsedMs, path.vHalfPeriodMs)
}

/** The y counterpart of cardXAtElapsed - see it. */
export function cardYAtElapsed(path: ChainPath, elapsedMs: number, offsetY: number): number {
  'worklet'
  return verticalYAtElapsed(path, elapsedMs) + offsetY * fanOffsetScale(elapsedMs, path.vHalfPeriodMs)
}

/** Whether a ghost card is drawn at `elapsedMs`. Before its entrance a ghost is parked exactly where
 * the real card it replaces stood (a screen blanks its real cards as the cascade takes over), so it
 * MUST be visible there: hiding it until its own entrance left piles/slots/columns empty for up to
 * (chains - 1) * CHAIN_ENTRANCE_STAGGER_MS, real cards vanishing with no ghost.
 *
 * `alwaysVisible` cards (a chain's head - the one card the real pile showed - and any card with a
 * position of its own) are drawn from the first frame. The rest of a chain all start on the head's
 * spot, hidden under it in the real pile, so they only appear once the card ahead of them has left
 * (one CHAIN_SEGMENT_DELAY_MS before their own start): the pile peels off one card at a time with
 * no gap, instead of a dozen shadowed cards stacked on one point darkening it. `segmentDelayMs` is the chain's
 * own per-card delay (ChainSpec.segmentDelayMs; CHAIN_SEGMENT_DELAY_MS when it has none) - "the card ahead has left" is one of THOSE
 * before this card's start, whatever the chain's spacing is. */
export function isGhostVisible(elapsedMs: number, alwaysVisible: boolean, segmentDelayMs: number = CHAIN_SEGMENT_DELAY_MS): boolean {
  'worklet'
  return alwaysVisible || elapsedMs + segmentDelayMs > 0
}
