import { useEffect, useRef } from 'react'

import { finishGapMs, FLIGHT_SPRING, springSettleMs } from '@/components/dragdrop/dragSpring'
import { FinishMove } from '@/engine/autoFoundation'
import { AccessibleCard, PileRef } from '@/engine/gameTypes'

export interface AutoFinish {
  /** Call right after every move the PLAYER made commits (a tap or a drag, to ANY pile; never an
   * auto-played, silent one), with the pile it went `to`. Only a play of a card TO a foundation allows
   * the finish: if that play - or the safe-card cascade it sets off - leaves the board solved, the
   * finish starts at once, its first card one gap (finishGapMs(0)) after the move that made it so. Any
   * other move stops a finish still running (a card taken back off a foundation isn't sent straight
   * back up), and the player's next foundation play starts it again. */
  afterPlayerMove(to: PileRef): void
  /** Call when the board changed for a reason that isn't a player move - an undo, a resumed save,
   * a new deal - and stops a finish that's already running. Nothing starts again until the player's
   * next move, so undoing a card off a solved board can't fly it straight back up. */
  suppress(): void
  /** Whether a finish may still run - false after suppress() (or the loop ending, or unmount).
   * Handed to firePlay as its `stillWanted` check, for after its measurement await. */
  isAllowed(): boolean
}

// A step that can't measure its card, or finds the board changed under it, reports a miss. A few
// in a row means something is genuinely wrong (a card that never registers) - stop rather than
// retry forever, and leave the rest of the game to the player.
const MAX_CONSECUTIVE_MISSES = 3
// How long a finish card waits (at most) for a card still flying in to its own pile to land: twice a
// flight's ghost lifetime (springSettleMs of FLIGHT_SPRING, every flight's one time), ~966ms at the
// default pace - also past the slowest drag drop that may still be settling (~673ms). It only bounds
// the wait: the card leaves the moment that pile has landed.
export const FINISH_LANDING_WAIT_MS = 2 * springSettleMs(FLIGHT_SPRING)
const LANDING_POLL_MS = 16

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The "the game is won, just finish it" sweep. Once `canFinish` says the board is SOLVED - nothing
 * hidden, nothing left to draw, every remaining card able to go up by foundation moves alone - there
 * is no decision left to protect, so the remaining cards file away on their own, WITHOUT waiting for
 * each flight to land first, at a pace that ramps up (finishGapMs: ordinary auto-play's gap for the
 * first card, closing in on half that). Flights are purely cosmetic overlays on a board that already committed (see
 * useFlightConcurrency), and every flight takes the same time (FLIGHT_SPRING), so they overlap freely
 * and land in the order they left.
 *
 * Like every auto-play, it only ever follows the player's own play of a card to a foundation (Jay,
 * 2026-10-14; from 2026-10-12 it started after ANY move that left the board solved): that play
 * (afterPlayerMove), or the safe-card cascade it sets off, the moment either makes the board solved.
 * An undo, a resume or a new deal never does (suppress): undoing a card off a solved board leaves it
 * solved, and the card would fly straight back up. Nor does any other move of the player's, a card
 * taken back off a foundation included. Their next foundation play starts it again. A permission ends
 * with the finish itself.
 *
 * The pace is a fixed clock: each card leaves its gap after the card before it LEFT (the player's own
 * move, for the first), not after that card's measurement and commit, so the gap really is the pace. The one thing a card waits for is its own pile to stop landing (`isLanding`, bounded by
 * FINISH_LANDING_WAIT_MS): picked up while its own ghost is still airborne, a card shows twice.
 *
 * Honors `enabled` (the Auto-Move to Foundation setting) and `isBusy` (an undo in progress) at every
 * step, and each step re-reads the live board through `getState` and re-checks `canFinish`, so a
 * player move made mid-finish that breaks it just ends the finish instead of playing cards that are
 * no longer safe.
 */
export function useAutoFinish<TState>(config: {
  state: TState | null
  enabled: () => boolean
  isBusy: () => boolean
  /** The live board (a ref read, e.g. useFlightConcurrency's stateRef.current), not the render
   * closure's - the loop below outlives the render that started it. */
  getState: () => TState | null
  /** True while the board is solved (see above) - false on a won board, so the loop ends on its own
   * after the last card. */
  canFinish: (state: TState) => boolean
  /** The next card to send up - only asked once canFinish said true. */
  nextMove: (state: TState) => FinishMove | null
  /** Whether a card is still flying in to `pile` - read live (useFlightConcurrency's isLanding). */
  isLanding: (pile: PileRef) => boolean
  /** Starts ONE card's flight and commits its move, resolving true once it did, false if it
   * couldn't (the measurement failed, the board changed underneath it, `stillWanted` turned false
   * while it measured). Resolves when the move is committed - NOT when the flight lands. */
  firePlay: (entry: AccessibleCard, to: PileRef, stillWanted: () => boolean) => Promise<boolean>
  /** The gap in front of the finish's `index`th card (0 = the first). finishGapMs by default. */
  gapMs?: (index: number) => number
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

  function isAllowed() {
    return allowedRef.current
  }

  // The card the finish would send up now, or null if it shouldn't send any (suppressed, Auto-Move
  // off, an undo running, the board no longer solved - or won).
  function nextStep(): FinishMove | null {
    const c = latestRef.current
    if (!allowedRef.current || !c.enabled() || c.isBusy()) return null
    const s = c.getState()
    return s && c.canFinish(s) ? c.nextMove(s) : null
  }

  async function run() {
    runningRef.current = true
    let misses = 0
    // When the card before this one left: the player's own move for the first (this runs in the
    // effect of the commit that made the board solved).
    let lastLeftAt = Date.now()
    // Cards sent so far: the ramp's position. A miss doesn't advance it.
    let sent = 0
    try {
      while (allowedRef.current) {
        const gap = lastLeftAt + (latestRef.current.gapMs ?? finishGapMs)(sent) - Date.now()
        if (gap > 0) await sleep(gap) // a card already late (its predecessor was slow to measure) goes at once
        let step = nextStep()
        const deadline = Date.now() + FINISH_LANDING_WAIT_MS
        while (step && latestRef.current.isLanding(step.entry.ref) && Date.now() < deadline) {
          await sleep(LANDING_POLL_MS)
          step = nextStep() // re-read: whatever landed meanwhile may have changed the board or ended the finish
        }
        if (!step) return
        lastLeftAt = Date.now()
        // A pile still landing after the whole wait counts as a miss, like a failed measurement.
        const fired = !latestRef.current.isLanding(step.entry.ref) && (await latestRef.current.firePlay(step.entry, step.to, isAllowed))
        if (fired) {
          misses = 0
          sent += 1
        } else if (++misses >= MAX_CONSECUTIVE_MISSES) {
          return
        }
      }
    } finally {
      runningRef.current = false
      // However it ended, that finish is over: only the player's next move allows another.
      allowedRef.current = false
    }
  }

  // Deliberately depends on only [state], for the same reason useAutoFoundationCascade's effect
  // does: every screen passes fresh inline closures for the rest on every render. A board that isn't
  // solved yet keeps the move's permission (a cascade a foundation play set off may still make it
  // so); one the finish can't follow at all (Auto-Move off, an undo running) drops it, so it can't
  // start later.
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
    isAllowed
  }
}
