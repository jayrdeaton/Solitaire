import { WithSpringConfig } from 'react-native-reanimated'

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
 */
export const SNAP_BACK_SPRING: WithSpringConfig = {
  duration: 200,
  dampingRatio: 1,
  overshootClamping: true
}

// flyTo's settle timer is what reveals the real card and hides the ghost (see DragGhostLayer.tsx's
// settleAfter - withSpring's own completion callback doesn't reliably fire on web, so the timer's
// duration has to match the spring's). A manual drag already tracks the pointer continuously, so
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
const AUTO_MOVE_MIN_DURATION = 100
const AUTO_MOVE_MAX_DURATION = 260
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
  overshootClamping: true
}

function springForDistance(distance: number, minDuration: number, maxDuration: number): WithSpringConfig {
  const t = (distance - AUTO_MOVE_MIN_DISTANCE) / (AUTO_MOVE_MAX_DISTANCE - AUTO_MOVE_MIN_DISTANCE)
  const duration = minDuration + Math.max(0, Math.min(1, t)) * (maxDuration - minDuration)
  return { duration, dampingRatio: 1, overshootClamping: true }
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
// reads as brisk rather than a deliberate one-at-a-time flight.
const AUTO_PLAY_MIN_DURATION = 60
const AUTO_PLAY_MAX_DURATION = 140

/** Same distance-scaled shape as autoMoveSpringFor, but for the quicker auto-play-to-foundation
 * cascade specifically - see the comment above. */
export function autoPlaySpringFor(distance: number): WithSpringConfig {
  return springForDistance(distance, AUTO_PLAY_MIN_DURATION, AUTO_PLAY_MAX_DURATION)
}
