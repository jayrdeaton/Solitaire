// Reduce Motion as of the last commit (see reducedMotion.tsx), with no imports, so plain timing modules (dragSpring.ts) can
// read it without pulling the settings store in.
let motionReduced = false

/** Reduce Motion as of now, for timers and controllers that are not components (see reducedMotion.tsx). */
export function isMotionReduced(): boolean {
  return motionReduced
}

/** Set by ReducedMotionBridge after each commit, and by tests. */
export function setMotionReduced(value: boolean) {
  motionReduced = value
}

/** The cards a screen hides until their deal-layer flight lands (a stock deal, an Aces Up round): none under Reduce Motion.
 * DealLayer then lands every card at once, but only once the screen has measured the destinations, a commit after the one that
 * takes the cards off the stock, so hiding them would show the board without them for a frame. */
export function hiddenUntilDealt(ids: Iterable<string>): Set<string> {
  return motionReduced ? new Set() : new Set(ids)
}

/** hiddenUntilDealt for a pile that hides its incoming cards by count (beginFlying for a draw-3 fan): 0 under Reduce Motion. */
export function countHiddenUntilDealt(count: number): number {
  return motionReduced ? 0 : count
}
