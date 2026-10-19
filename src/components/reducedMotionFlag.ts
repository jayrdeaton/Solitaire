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
