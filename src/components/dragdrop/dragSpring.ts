import { WithSpringConfig } from 'react-native-reanimated'

/**
 * THE pace knob for every per-PLAY card flight (tap-to-move, undo, pair removal, stock draws, the
 * auto-play cascade, FreeCell's finish sweep, Pyramid/Spider's own flights). Every min/max duration
 * below is written at "scale 1" and multiplied by this, and every pacing constant elsewhere that
 * has to follow a flight (FreeCell's finish stagger and last-card wait, Pyramid's deferral wait,
 * the undo hold-to-repeat cadence) derives from scaledMs() - so editing this ONE number re-paces all
 * of them together, and nothing else needs touching.
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

// flyTo's settle timer is what reveals the real card and hides the ghost (see DragGhostLayer.tsx's
// settleAfter - withSpring's own completion callback doesn't reliably fire on web, so the timer's
// duration has to match the spring's: springSettleMs). A manual drag already tracks the pointer continuously, so
// by the time flyTo runs, the ghost is sitting wherever the player's finger released it - usually
// within a card's width of the pile's exact fanned position - and flyTo only needs to nudge it the
// rest of the way. Using the full flight duration for that tiny correction meant every drag's ghost
// hung around covering the real card for the same duration as a corner-to-corner tap-to-move
// flight, even though there was almost nothing left to visually travel. Scaling the duration to the
// actual remaining distance (see autoMoveSpringFor below) keeps a real flight (tap-to-move,
// auto-play, undo - which start from the card's original resting spot and can cover the whole
// board) feeling exactly as before, while letting a well-aimed drag hand off to the real card
// almost the instant it's placed. (The card-move click+haptic themselves don't wait on this settle
// at all - see useCardSounds.ts's playCardSound/hapticCard, fired together the instant each of
// these flights is kicked off instead.)
//
// The four numbers below are the scale-1 design values (130-320ms), re-paced by FLIGHT_TIME_SCALE:
// at the default 1.6 that is 208-512ms of perceptual duration, which the settle timer then covers
// with springSettleMs (~275-675ms of ghost lifetime).
const AUTO_MOVE_MIN_DURATION = scaledMs(130)
const AUTO_MOVE_MAX_DURATION = scaledMs(320)
const AUTO_MOVE_MIN_DISTANCE = 60
const AUTO_MOVE_MAX_DISTANCE = 360

/**
 * Used when a tapped card auto-moves to its destination (no pointer involved, so there's no
 * "already near the target" head start the way a real drag's drop has). Same critically-damped,
 * no-overshoot feel as SNAP_BACK_SPRING, just a touch longer since this can cover the full width
 * of the board (e.g. leftmost tableau column to the foundations) instead of a short drop-distance.
 * This is the config for a genuine full-distance flight - see autoMoveSpringFor below for the
 * scaled-down version DragGhostLayer's flyTo actually uses for a manual drag's short settle.
 */
export const AUTO_MOVE_SPRING: WithSpringConfig = {
  duration: AUTO_MOVE_MAX_DURATION,
  dampingRatio: 1,
  overshootClamping: true,
  mass: FLIGHT_SPRING_MASS
}

function springForDistance(distance: number, minDuration: number, maxDuration: number): WithSpringConfig {
  const t = (distance - AUTO_MOVE_MIN_DISTANCE) / (AUTO_MOVE_MAX_DISTANCE - AUTO_MOVE_MIN_DISTANCE)
  const duration = minDuration + Math.max(0, Math.min(1, t)) * (maxDuration - minDuration)
  return { duration, dampingRatio: 1, overshootClamping: true, mass: FLIGHT_SPRING_MASS }
}

/** AUTO_MOVE_SPRING scaled down for `distance` (px) of actual remaining travel - see the comment
 * above. Clamped to [AUTO_MOVE_MIN_DURATION, AUTO_MOVE_MAX_DURATION], linear in between. */
export function autoMoveSpringFor(distance: number): WithSpringConfig {
  return springForDistance(distance, AUTO_MOVE_MIN_DURATION, AUTO_MOVE_MAX_DURATION)
}

// Auto-play-to-foundation (see KlondikeScreen/FreeCellScreen's maybeAutoPlay/fireAutoMove) can
// chain through many cards in a row once the board is safely resolved - each one waited out the
// same full tap-to-move flight time as a single, deliberate player move, which made a long cascade
// (e.g. auto-completing the last dozen cards of a won deal) feel sluggish. Roughly halving the
// duration range keeps the same critically-damped glide, just fast enough that a long cascade
// reads as brisk rather than a deliberate one-at-a-time flight. (Scale-1 values 75-170ms, re-paced
// by FLIGHT_TIME_SCALE like the tier above: 120-272ms at the default.)
const AUTO_PLAY_MIN_DURATION = scaledMs(75)
const AUTO_PLAY_MAX_DURATION = scaledMs(170)

/** Same distance-scaled shape as autoMoveSpringFor, but for the quicker auto-play-to-foundation
 * cascade specifically - see the comment above. */
export function autoPlaySpringFor(distance: number): WithSpringConfig {
  return springForDistance(distance, AUTO_PLAY_MIN_DURATION, AUTO_PLAY_MAX_DURATION)
}

// The win-completing sweep (useAutoFoundationCascade's sweepingRef - once the whole rest of the
// game, stock included, is provably clearable, every remaining card flies at this pace instead of
// autoPlaySpringFor's already-quick one) is meant to read as noticeably brisker still: a flat,
// constant pace for the whole sweep, not a gradual ramp - each card's own duration keeps scaling
// with its own travel distance (same distance-scaled shape as every other tier here), it's the
// sweep as a sequence that doesn't accelerate card-over-card. (Scale-1 values 40-90ms, re-paced by
// FLIGHT_TIME_SCALE: 64-144ms at the default.)
const WIN_SWEEP_MIN_DURATION = scaledMs(40)
const WIN_SWEEP_MAX_DURATION = scaledMs(90)

/** Same distance-scaled shape as autoPlaySpringFor, but for the win-completing sweep specifically -
 * see the comment above. */
export function winSweepSpringFor(distance: number): WithSpringConfig {
  return springForDistance(distance, WIN_SWEEP_MIN_DURATION, WIN_SWEEP_MAX_DURATION)
}
