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

// The bounce path itself - assigned once per chain (see buildChainPath), then shared by every card in that chain via the delay
// above, never randomized per-card, and fixed for the whole cascade (no drift). Every chain in a cascade bounces between the SAME
// two heights: the floor is the screen's actual bottom (BOUNCE_FLOOR_MARGIN_PX above it) and the apex is the bottom of the
// header (see cascadeApexY), so no chain ever climbs behind the header's controls and none bounces visibly higher than the rest.
// BOUNCE_TOP_MARGIN_PX is the hard limit on that apex on a screen too short to leave the header its room, and BOUNCE_MIN_SPAN_PX
// the shortest any bounce is allowed to be, so it never reads as a broken flicker against the floor.
export const BOUNCE_FLOOR_MARGIN_PX = 24
export const BOUNCE_TOP_MARGIN_PX = 24
export const BOUNCE_MIN_SPAN_PX = 220
// vHalfPeriodMs is randomized per chain (not derived from its own span), so chains sharing one floor and one apex still leave and
// return to it out of step with each other.
export const BOUNCE_V_HALF_PERIOD_MIN_MS = 900
export const BOUNCE_V_HALF_PERIOD_MAX_MS = 1330
export const BOUNCE_H_MARGIN_PX = 12
// With every chain on the same floor and apex, horizontal speed is the ONLY thing left that tells two chains apart, so it is what
// keeps one from sitting behind another for long: each chain gets its own speed (see spreadHHalfPeriods), spread evenly across
// this band - deliberately narrow (about +/-16% around 5s per wall-to-wall leg), a slight difference rather than the very wide
// 2.5-9.5s range a chain used to draw from when speed also decided its height.
export const BOUNCE_H_HALF_PERIOD_MIN_MS = 4200
export const BOUNCE_H_HALF_PERIOD_MAX_MS = 5800

/** The single apex every chain of a cascade bounces up to: the top of the cards sits at `headerBottomY` (the bottom of the header
 * band, in the same frame as `floorY`), so a bounce reaches the header's lower edge without going behind it. Held back only as far
 * as needed to leave every bounce at least BOUNCE_MIN_SPAN_PX tall (a short screen), and never above BOUNCE_TOP_MARGIN_PX. */
export function cascadeApexY(headerBottomY: number, floorY: number): number {
  return Math.min(headerBottomY, Math.max(BOUNCE_TOP_MARGIN_PX, floorY - BOUNCE_MIN_SPAN_PX))
}

/** The box every chain of a cascade bounces in, in the rotated frame the ghosts render in: the two walls (the x of a card's left
 * edge against each) and the apex and floor (the y of its top edge at each). */
export interface CascadeBounds {
  leftX: number
  rightX: number
  apexY: number
  floorY: number
}

/** The bounce box for a `frame` (the rotated window), a card of `cardWidth` x `cardHeight` and a header ending at `headerBottomY`. */
export function cascadeBounds(frame: { width: number; height: number }, cardWidth: number, cardHeight: number, headerBottomY: number): CascadeBounds {
  const floorY = frame.height - cardHeight - BOUNCE_FLOOR_MARGIN_PX
  return { leftX: BOUNCE_H_MARGIN_PX, rightX: frame.width - cardWidth - BOUNCE_H_MARGIN_PX, apexY: cascadeApexY(headerBottomY, floorY), floorY }
}

/** One horizontal half-period per chain, all different: `count` values spaced evenly from BOUNCE_H_HALF_PERIOD_MIN_MS to
 * BOUNCE_H_HALF_PERIOD_MAX_MS (a lone chain gets the middle), then shuffled so WHICH chain is the fast one changes from win to
 * win. Even spacing, rather than an independent random draw per chain, is what guarantees no two chains ever share a speed - two
 * draws can land nearly on top of each other, and two chains at the same speed stay stacked for as long as the cascade runs. */
export function spreadHHalfPeriods(count: number, random: () => number = Math.random): number[] {
  const middle = (BOUNCE_H_HALF_PERIOD_MIN_MS + BOUNCE_H_HALF_PERIOD_MAX_MS) / 2
  const periods = Array.from({ length: count }, (_, i) => (count > 1 ? BOUNCE_H_HALF_PERIOD_MIN_MS + ((BOUNCE_H_HALF_PERIOD_MAX_MS - BOUNCE_H_HALF_PERIOD_MIN_MS) * i) / (count - 1) : middle))
  for (let i = periods.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[periods[i], periods[j]] = [periods[j], periods[i]]
  }
  return periods
}

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
  // No start time of its own: every card's elapsed time counts from the whole cascade's one clock, which only starts once
  // its ghosts are on screen (WinCascadeLayer's CascadeChains, startMs) - a path is built before that.
  // Its walls, apex and floor are the cascade's bounds AT THE WIN: a later resize (a rotation) leaves the path alone and moves
  // the positions it gives into the new bounds instead (fitXToBounds/fitYToBounds).
}

function remapAxis(value: number, from0: number, from1: number, to0: number, to1: number): number {
  'worklet'
  // Unchanged bounds give back the very same number, not one that went through a division.
  if (from0 === to0 && from1 === to1) return value
  const span = from1 - from0
  if (Math.abs(span) < 1e-6) return value + (to0 - from0)
  return to0 + (value - from0) * ((to1 - to0) / span)
}

/** An x of `path` (a card's cardXAtElapsed) moved into the cascade's current `bounds`: the path's two walls onto the new walls,
 * everything between (or beyond) them in proportion. The motion is linear interpolation between the path's own points, so this
 * is exactly the path a chain would have taken had it been built in `bounds` - same timing, same phase, nothing restarts: a
 * rotation mid-cascade carries every card to the same spot of its bounce in the turned frame. */
export function fitXToBounds(path: ChainPath, bounds: CascadeBounds, x: number): number {
  'worklet'
  return remapAxis(x, Math.min(path.firstX, path.secondX), Math.max(path.firstX, path.secondX), bounds.leftX, bounds.rightX)
}

/** The y counterpart of fitXToBounds: the path's apex and floor onto the new apex and floor. */
export function fitYToBounds(path: ChainPath, bounds: CascadeBounds, y: number): number {
  'worklet'
  return remapAxis(y, path.apexY, path.floorY, bounds.apexY, bounds.floorY)
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
 * timers could (see CascadeChains' startMs in WinCascadeLayer). */
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
 * position of its own) are drawn from the cascade's first frame (the one it shows in, once these faces have painted - see
 * WinCascadeLayer's CascadeChains). The rest of a chain all start on the head's
 * spot, hidden under it in the real pile, so they only appear once the card ahead of them has left
 * (one CHAIN_SEGMENT_DELAY_MS before their own start): the pile peels off one card at a time with
 * no gap, instead of a dozen shadowed cards stacked on one point darkening it. `segmentDelayMs` is the chain's
 * own per-card delay (ChainSpec.segmentDelayMs; CHAIN_SEGMENT_DELAY_MS when it has none) - "the card ahead has left" is one of THOSE
 * before this card's start, whatever the chain's spacing is. */
export function isGhostVisible(elapsedMs: number, alwaysVisible: boolean, segmentDelayMs: number = CHAIN_SEGMENT_DELAY_MS): boolean {
  'worklet'
  return alwaysVisible || elapsedMs + segmentDelayMs > 0
}
