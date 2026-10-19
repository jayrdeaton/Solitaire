import { WithSpringConfig } from 'react-native-reanimated'

import { isMotionReduced } from '../reducedMotionFlag'

/**
 * THE pace knob for every per-PLAY card flight (FLIGHT_SPRING: tap-to-move, undo, pair removal, stock
 * draws, auto-play, the finish sweep, Pyramid/Spider's own flights) and a drag's drop settle
 * (dropSpringFor). Every duration below is written at "scale 1" and multiplied by this, and every
 * pacing constant elsewhere that has to follow a flight (the auto-play staggers, FreeCell's
 * last-card wait, Pyramid's deferral wait, the undo hold-to-repeat cadence) derives from scaledMs()
 * or springSettleMs(FLIGHT_SPRING) - so editing this ONE number re-paces all of them together, and
 * nothing else needs touching.
 *
 * Deliberately NOT applied to the deal (dealing/dealSpring.ts's DEAL_SPRING/dealStaggerMs - the
 * player has already been given back a lot of time there) or to SNAP_BACK_SPRING (a rejected drag
 * should still bounce home briskly).
 */
export const FLIGHT_TIME_SCALE = 1.6

/** A pacing constant written at scale 1, re-paced by FLIGHT_TIME_SCALE. */
export function scaledMs(ms: number): number {
  return Math.round(ms * FLIGHT_TIME_SCALE)
}

/**
 * Reanimated's duration-based spring solves for a stiffness that makes the spring's energy reach its
 * rest threshold after 1.5 x `duration` (springUtils.ts's calculateNewStiffnessToMatchDuration: its
 * `perceptualCoefficient`; the docs call `duration` the "perceptual" duration and say the actual one
 * is 1.5 times longer). But that solver bisects stiffness only up to 8000 - and with the library's
 * DEFAULT mass of 4 that ceiling is reached at about a 184ms duration: EVERY shorter duration
 * silently ran as the same ~283ms spring. So the old 40-170ms flights (all of the sweep and most of
 * the auto-play tier) were really ~283ms springs whose ghost was retired at 40-170ms, with up to
 * 130px still to travel - the ghost visibly vanished partway and the card just appeared. Critically
 * damped motion depends only on omega = sqrt(stiffness / mass), so a smaller mass lifts the ceiling
 * (omega max = sqrt(8000 / mass)) without changing the motion; 0.1 is exact down to ~30ms, far
 * below the shortest flight here (see dragSpring.test.ts, which drives Reanimated's own spring code
 * and fails if any flight's real end drifts from 1.5 x duration).
 */
export const FLIGHT_SPRING_MASS = 0.1

/**
 * Where a flight's landing is finally settled - the ghost removed and the real card revealed - must
 * be the spring's REAL end, not its perceptual duration. Two things separate the two:
 *  - Position remaining is distance x (1 + u) e^-u with u = 8.23 t / duration (critically damped; 8.23
 *    is the energy-threshold u = 12.35 divided by the 1.5 factor above). At t = 1.25 x duration that
 *    is 0.04% of the distance: 0.35px even for a 900px flight, whatever the duration. At t = the
 *    duration itself it is still 0.25% (2px of 900px).
 *  - The spring runs on the UI thread and starts a frame or two AFTER the JS timer that covers it
 *    (the withSpring assignment is queued across threads and waits for the next frame): 33ms is two
 *    60Hz frames. That lag is absolute, so it is a large share of the shortest flights - with it, a
 *    timer of exactly `duration` retired a 60px sweep flight 22px short, and a flat 1.3 x duration
 *    still leaves 2.6px of a 100px, 75ms one - and a small one of the longest. So it is added on top
 *    of the factor: SPRING_SETTLE_FACTOR x duration + SPRING_START_LAG_MS.
 * dragSpring.test.ts measures the residual with Reanimated's own spring for every flight config at
 * 60..900px, with the spring starting up to a frame and up to two frames late, and requires it under
 * 1px (worst case 0.68px, a 900px sweep flight, two frames late).
 */
export const SPRING_SETTLE_FACTOR = 1.25
export const SPRING_START_LAG_MS = 33

/** How long after a flight starts its ghost may be retired (and the real card revealed) with no
 * visible jump - see SPRING_SETTLE_FACTOR. Use this, never the bare `duration`, for every timer that
 * covers a spring. */
export function springSettleMs(config: WithSpringConfig): number {
  const duration = config.duration ?? 0
  // Under Reduce Motion the spring lands at once (see reducedMotion.tsx), so only the UI thread's start lag is left to cover.
  if (isMotionReduced()) return duration <= 0 ? 0 : SPRING_START_LAG_MS
  return duration <= 0 ? 0 : Math.ceil(duration * SPRING_SETTLE_FACTOR + SPRING_START_LAG_MS)
}

/**
 * Shared "snap back to origin" feel used by every draggable card.
 *
 * Uses the duration-based spring config (rather than stiffness/damping/mass)
 * because it's the only mode that lets us actually pin down how long this
 * takes: a stiffness/damping/mass spring's real settle time is an emergent
 * property that's hard to predict up front, and measuring one against real
 * drags showed it was taking ~580ms to fully settle despite looking like it
 * should be much quicker - spring physics decay exponentially, so most of
 * that was a near-imperceptible tail after the card had visually stopped
 * moving. From the user's side that read as "animates, pauses, then snaps
 * into place" once the real card revealed itself the instant the spring
 * finally crossed its rest threshold. dampingRatio: 1 (critically damped) +
 * overshootClamping avoids any bounce past the origin, keeping the snap
 * clean instead of just fast.
 *
 * Not re-paced by FLIGHT_TIME_SCALE, and it keeps the default mass: 240ms is above the ~184ms
 * stiffness ceiling FLIGHT_SPRING_MASS works around, so it already runs exactly as configured.
 */
export const SNAP_BACK_SPRING: WithSpringConfig = {
  duration: 240,
  dampingRatio: 1,
  overshootClamping: true
}

// EVERY card flight takes the same time, however far it goes: a tap-to-move, an undo, a stock draw (a draw-3 fan too - it flies through the deal
// layer, passing this to DealAnimator.start), an auto-played card, the end-of-game sweep, Pyramid's pair removals, Spider's completed runs (Jay,
// 2026-10-01). Two reasons:
//  - Cards that left one after another land in the order they left. A pile under several incoming ghosts shows its cards by how many are still in
//    the air (FoundationCell's settledCard), so a quick short hop overtaking a long flight to the same pile would show the overtaken card on the
//    pile while it was still airborne, and hide its own. With distance-scaled flights that happened on two quick taps, or an auto-played card
//    following a tap.
//  - The pace of a stream of cards (auto-play, the finish) is the gap between them, not the flight - flights overlap - so a flight can be as
//    long as reads well without slowing anything down.
// Critically damped and clamped, so it glides in without bouncing. Scale-1 225ms, re-paced by FLIGHT_TIME_SCALE: 360ms at the default, the middle
// of the old distance-scaled 208-512ms tap flights (~483ms of ghost, springSettleMs).
export const FLIGHT_SPRING: WithSpringConfig = {
  duration: scaledMs(225),
  dampingRatio: 1,
  overshootClamping: true,
  mass: FLIGHT_SPRING_MASS
}

// The ONE exception (with the deals, dealing/dealSpring.ts's DEAL_SPRING): a drag's drop. By the time the finger lets go the card is usually within a card's width
// of its spot, so it only has to settle the last few px - a full flight's time for that would leave the ghost covering the real card after every
// drag ("animates, pauses, then snaps into place"). Its settle scales with the distance actually left (DragGhostLayer's flyTo on a showLive
// flight): a well-aimed drop hands off to the real card almost at once, a far one takes up to a flight and a half. Scale-1 130-320ms over 60-360px,
// re-paced by FLIGHT_TIME_SCALE: 208-512ms at the default.
const DROP_MIN_DURATION = scaledMs(130)
const DROP_MAX_DURATION = scaledMs(320)
const DROP_MIN_DISTANCE = 60
const DROP_MAX_DISTANCE = 360

/** The settle of a drag's drop over `distance` (px) still to go - see the comment above. Clamped to [DROP_MIN_DURATION, DROP_MAX_DURATION],
 * linear in between. */
export function dropSpringFor(distance: number): WithSpringConfig {
  const t = (distance - DROP_MIN_DISTANCE) / (DROP_MAX_DISTANCE - DROP_MIN_DISTANCE)
  const duration = DROP_MIN_DURATION + Math.max(0, Math.min(1, t)) * (DROP_MAX_DURATION - DROP_MIN_DURATION)
  return { duration, dampingRatio: 1, overshootClamping: true, mass: FLIGHT_SPRING_MASS }
}

/** Gap between one auto-played card leaving and the next - the player's own card included, so the first follower leaves this long after it while
 * it is still in the air (useAutoFoundationCascade, and FreeCell's finish). Every flight takes the same time, so the gap only sets how quick the
 * stream reads; ~5 cards are in the air at once. Scale-1 60ms: 96ms at the default. Above useCascadeFeedback's 45ms floor, so every card keeps its
 * own sound/haptic tick. */
export const AUTO_PLAY_STAGGER_MS = scaledMs(60)

/** The FINISH's pace (useAutoFinish: the board is solved, nothing hidden and no choice left, so every remaining card files away on its own)
 * RAMPS UP (Jay, 2026-10-14: not "immediately flying in"): its first card follows the player's move at ordinary auto-play's gap
 * (FINISH_RAMP_START_MS = AUTO_PLAY_STAGGER_MS, so a cascade handing over to it doesn't slow down), and each later gap closes in on
 * FINISH_STAGGER_MS, the top speed, by FINISH_RAMP_FACTOR of what is left: 96, 89, 83, 77, 73 ... ~59 by the 10th card, ~50 by the 20th.
 * The flights still take FLIGHT_SPRING's one time, so the cards still land in the order they left. */
export const FINISH_RAMP_START_MS = AUTO_PLAY_STAGGER_MS

/** The finish's top speed: half the auto-play gap (scale-1 30ms: 48ms at the default). Just above useCascadeFeedback's 45ms floor, so every
 * card normally keeps its tick (the gap is kept on a fixed clock from one take-off to the next, and a step whose measurement comes back
 * quicker than the one before can land inside the floor and lose its tick: inaudible in a stream). */
export const FINISH_STAGGER_MS = scaledMs(30)

/** How much of the gap still above FINISH_STAGGER_MS each finish card keeps - see FINISH_RAMP_START_MS. */
export const FINISH_RAMP_FACTOR = 0.85

/** The gap in front of the finish's `index`th card (0 = the first, after the player's own move). */
export function finishGapMs(index: number): number {
  return Math.round(FINISH_STAGGER_MS + (FINISH_RAMP_START_MS - FINISH_STAGGER_MS) * FINISH_RAMP_FACTOR ** index)
}
