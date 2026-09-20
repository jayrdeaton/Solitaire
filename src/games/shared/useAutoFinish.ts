import { useEffect, useRef } from 'react'

export interface AutoFinish {
  /** Call right after a move the PLAYER made themselves commits (a tap or a drag, to anywhere).
   * The finish may then start the next time the board settles finishable. */
  allow(): void
  /** Call when the board changed for a reason that isn't a player move - an undo, a resumed save,
   * a new deal - and stops a finish that's already running. Nothing starts again until the next
   * allow(), so undoing back onto a finishable board can't immediately re-fire the very cards the
   * player just took back. */
  suppress(): void
  /** Whether a finish may still run - false after suppress() (or the loop giving up, or unmount).
   * For a fireNext that awaits before firing: whatever it waited through may have suppressed the
   * finish, and the loop's own check is already behind it by then. */
  isAllowed(): boolean
}

// A step that can't measure its card, or finds the board changed under it, reports a miss. A few
// in a row means something is genuinely wrong (a card that never registers) - stop rather than
// retry forever, and leave the rest of the game to the player.
const MAX_CONSECUTIVE_MISSES = 3

/**
 * The "the game is won, just finish it" sweep: once `canFinish` says every remaining card can go
 * up on its own, fires one card after another, `staggerMs` apart, WITHOUT waiting for each flight
 * to land first (compare useAutoFoundationCascade, whose next step waits for `settled` - a card
 * per full flight-plus-measure round trip). Flights are purely cosmetic overlays on a board that
 * already committed (see useFlightConcurrency), so they overlap freely; the pace is the stagger.
 *
 * Only ever starts after a player move (allow) - never from a deal, a resume or an undo (suppress)
 * - and only once `settled`, so the player's own move has landed first. Honors `enabled` (the
 * Auto-Move to Foundation setting) and `isBusy` (an undo in progress) at every step, and each step
 * re-reads the live board through `getState` and re-checks `canFinish`, so a player move made
 * mid-finish that breaks it just ends the finish instead of playing cards that are no longer safe.
 */
export function useAutoFinish<TState>(config: {
  state: TState | null
  /** True once nothing is animating and the initial deal has finished - the same signal
   * useAutoFoundationCascade takes. */
  settled: boolean
  enabled: () => boolean
  isBusy: () => boolean
  /** The live board (a ref read, e.g. useFlightConcurrency's stateRef.current), not the render
   * closure's - the loop below outlives the render that started it. */
  getState: () => TState | null
  /** True while every remaining card can still go up by foundation moves alone - false on a won
   * board, so the loop ends on its own after the last card. */
  canFinish: (state: TState) => boolean
  /** Starts ONE card's flight and commits its move, resolving true once it did, false if it
   * couldn't (nothing to fly, the measurement failed, the board changed underneath it). Resolves
   * when the move is committed - NOT when the flight lands. */
  fireNext: (state: TState) => Promise<boolean>
  staggerMs: number
}): AutoFinish {
  const allowedRef = useRef(false)
  const runningRef = useRef(false)
  // The loop below runs across many renders; it always reads the newest config through this, so a
  // settings flip or a fresh closure is seen at its very next step.
  const latestRef = useRef(config)
  useEffect(() => {
    latestRef.current = config
  })
  useEffect(
    () => () => {
      allowedRef.current = false
    },
    []
  )

  async function run() {
    runningRef.current = true
    let misses = 0
    try {
      while (allowedRef.current) {
        const c = latestRef.current
        const s = c.getState()
        if (!c.enabled() || c.isBusy() || !s || !c.canFinish(s)) return
        if (await c.fireNext(s)) {
          misses = 0
        } else if (++misses >= MAX_CONSECUTIVE_MISSES) {
          allowedRef.current = false
          return
        }
        await new Promise<void>((resolve) => setTimeout(resolve, latestRef.current.staggerMs))
      }
    } finally {
      runningRef.current = false
    }
  }

  // Deliberately depends on only [state, settled], for the same reason useAutoFoundationCascade's
  // effect does: every screen passes fresh inline closures for the rest on every render.
  useEffect(() => {
    if (!allowedRef.current || runningRef.current) return
    if (!config.enabled() || !config.state || !config.settled || config.isBusy() || !config.canFinish(config.state)) return
    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.state, config.settled])

  return {
    allow() {
      allowedRef.current = true
    },
    suppress() {
      allowedRef.current = false
    },
    isAllowed() {
      return allowedRef.current
    }
  }
}
