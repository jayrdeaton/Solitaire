import { useEffect, useRef } from 'react'

import { PileRef } from '@/engine/gameTypes'

export interface AutoFinish {
  /** Call right after every move the PLAYER made commits (a tap or a drag; never an auto-played,
   * silent one). Only a move to a foundation lets the finish run: if that play - or the safe-card
   * cascade it sets off - leaves the board finishable, the finish starts at once, its first card
   * `staggerMs` after the move that made it so. Any other move (to a column or a freecell) never
   * starts it, and stops one still running. */
  afterPlayerMove(to: PileRef): void
  /** Call when the board changed for a reason that isn't a player move - an undo, a resumed save,
   * a new deal - and stops a finish that's already running. Nothing starts again until the player's
   * next foundation play, so undoing back onto a finishable board can't immediately re-fire the very
   * cards the player just took back. */
  suppress(): void
  /** Whether a finish may still run - false after suppress() (or the loop ending, or unmount).
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
 * to land first (useAutoFoundationCascade does the same). Flights are purely cosmetic overlays on a
 * board that already committed (see useFlightConcurrency), so they overlap freely; the pace is the
 * stagger. The first card follows the player's own move by the same gap, while that one is still in
 * the air - fireNext itself holds back a card that is still flying in to its pile.
 *
 * Only ever starts after the player's own play of a card to a foundation (afterPlayerMove) - never
 * after a move to a column or a freecell, a deal, a resume or an undo (suppress) - and that play's
 * permission ends with the finish itself or the player's next move. Honors `enabled` (the
 * Auto-Move to Foundation setting) and `isBusy` (an undo in progress) at every step, and each step
 * re-reads the live board through `getState` and re-checks `canFinish`, so a player move made
 * mid-finish that breaks it just ends the finish instead of playing cards that are no longer safe.
 */
export function useAutoFinish<TState>(config: {
  state: TState | null
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
        // Every card, the first included, leaves one gap after the card before it (the player's own, for the first).
        await new Promise<void>((resolve) => setTimeout(resolve, latestRef.current.staggerMs))
        const c = latestRef.current
        const s = c.getState()
        if (!allowedRef.current || !c.enabled() || c.isBusy() || !s || !c.canFinish(s)) return
        if (await c.fireNext(s)) {
          misses = 0
        } else if (++misses >= MAX_CONSECUTIVE_MISSES) {
          return
        }
      }
    } finally {
      runningRef.current = false
      // However it ended, that play's finish is over: only the player's next foundation play allows another.
      allowedRef.current = false
    }
  }

  // Deliberately depends on only [state], for the same reason useAutoFoundationCascade's effect
  // does: every screen passes fresh inline closures for the rest on every render. A board that isn't
  // finishable yet keeps the play's permission (the cascade it set off may still make it so); one the
  // finish can't follow at all (Auto-Move off, an undo running) drops it, so it can't start later.
  useEffect(() => {
    if (!allowedRef.current || runningRef.current) return
    if (!config.enabled() || !config.state || config.isBusy()) {
      allowedRef.current = false
      return
    }
    if (!config.canFinish(config.state)) return
    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.state])

  return {
    afterPlayerMove(to) {
      allowedRef.current = to.zone === 'foundation'
    },
    suppress() {
      allowedRef.current = false
    },
    isAllowed() {
      return allowedRef.current
    }
  }
}
