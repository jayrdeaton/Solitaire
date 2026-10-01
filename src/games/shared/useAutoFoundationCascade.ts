import { useEffect, useRef } from 'react'

import { AUTO_PLAY_STAGGER_MS, WIN_SWEEP_STAGGER_MS } from '@/components/dragdrop/dragSpring'
import { AutoCompleteStep } from '@/engine/autoFoundation'
import { AccessibleCard, PileRef } from '@/engine/gameTypes'

export interface AutoFoundationCascade {
  /** Call right after a manual (non-silent) player move whose `to.zone === 'foundation'` commits -
   * the only ordinary trigger for this whole feature. Arms the cascade; the effect below starts it
   * once `state`/`settled` next reflect that move having landed. */
  armFromForwardMove(): void
  /** Call right after a stock-draw-to-waste or tableau/reserve-reveal produces this game's own
   * foundation-starter card (rank 1 for every game except Canfield - see its own
   * isFoundationStarterCard). Plays `entry` first, ahead of whatever computeNextStep's own scan
   * order would otherwise pick, then continues the cascade exactly like armFromForwardMove - the
   * ace landing on its foundation is itself now "a card moved to the foundation." */
  armFromAceEvent(entry: AccessibleCard, to: PileRef): void
  /** Drops any pending arm (and its pinned card / sweep latch), and stops a cascade that's already
   * running. For a board change that isn't a consequence of the player's own foundation move - an
   * undo, a resumed save, a new deal, or an arm made while auto-move was off: the cascade only ever
   * disarms on its own once computeNextStep runs dry, which it never reaches while
   * enabled()/settled/isBusy() hold it back, so without this an old arm could fire a cascade on a
   * later board with no fresh tap. */
  disarm(): void
}

// A step that can't measure its card, or finds the board changed under it, reports a miss. A few
// in a row means something is genuinely wrong (a card that never registers) - stop rather than
// retry forever, and leave the rest to the player. Same limit as useAutoFinish.
const MAX_CONSECUTIVE_MISSES = 3
// How often a cascade waiting for the board to settle checks again, and how long it waits at most
// before handing back to the [state, settled] effect (which restarts it at the next settle).
const SETTLE_POLL_MS = 16
const MAX_SETTLE_WAIT_MS = 3000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * An explicit armed state machine: nothing fires until one of the two arm methods above is called,
 * and it disarms the moment computeNextStep runs dry - a plain tableau/freecell move, an undo, a
 * non-ace draw/reveal, or the initial deal trigger nothing here at all, by construction, since
 * none of them ever call either arm method.
 *
 * Once armed, the cascade starts when the board next settles (the player's own move has landed),
 * then sends its cards up one after another, AUTO_PLAY_STAGGER_MS apart, WITHOUT waiting for each
 * flight to land first - flights are purely cosmetic overlays on a board that already committed
 * (see useFlightConcurrency), so they overlap freely, like useAutoFinish's. Every card flight takes
 * the same time (dragSpring.ts's FLIGHT_SPRING), so they land in the order they left - two cards
 * headed to the same foundation never overtake each other. The overlap is kept to the
 * cascade's own plays; it waits for every flight to land (polling `isSettled`) before:
 *  - a draw or draw-and-play step, and the step right after one: the stock/waste have their own
 *    flight machinery (frozen slots, draw-3 fans, recycle clumps), and the next play may take the
 *    very card the draw is still flying in - acting on a card whose ghost is airborne shows it twice;
 *  - a step after the board changed under it (the player moved mid-cascade): that move may be a
 *    drag, whose drop settles in a distance-scaled time a cascade card could overtake, and it may
 *    be landing on the card the next step would take.
 *
 * `sweepingRef` latches once computeNextStep first returns a 'draw'/'drawAndPlay' step and stays
 * latched for the rest of that cascade - once the game is provably finishing itself, every
 * remaining card in the same cascade leaves at the quicker sweep gap (WIN_SWEEP_STAGGER_MS),
 * including any ordinary 'play' steps interleaved with the draws. Every card flies for the same
 * time either way (dragSpring.ts's FLIGHT_SPRING).
 */
export function useAutoFoundationCascade<TState>(config: {
  state: TState | null
  /** True once nothing is animating and the initial deal has finished - each screen's own existing
   * activeFlightCount===0 && dealHiddenIds.size===0 signal. Only what STARTS the cascade. */
  settled: boolean
  /** The same signal read live (activeFlightCountRef, not the render value) - what a running
   * cascade polls when a step has to wait for everything to land (see above). */
  isSettled: () => boolean
  /** The live board (useFlightConcurrency's stateRef.current), not the render closure's - the
   * cascade runs across many renders. */
  getState: () => TState | null
  enabled: () => boolean
  isBusy: () => boolean
  /** Composes whichever of Mechanism A / Mechanism B / the draws-aware Mechanism B applies to this
   * game (see engine/autoFoundation.ts) into the single step shape below. */
  computeNextStep: (state: TState) => AutoCompleteStep | null
  /** Starts ONE card's flight and commits its move, resolving true once it did, false if it
   * couldn't (the measurement failed, the board changed underneath it). Resolves when the move is
   * COMMITTED - not when the flight lands. */
  firePlay: (entry: AccessibleCard, to: PileRef) => Promise<boolean>
  /** Only supplied by the games with a stock (Klondike/Canfield/FortyThieves). Resolve once the
   * draw is committed (or refused). `sweep` tells the draw it is the cascade's, not the player's
   * (no move counted, the cascade's throttled sound/haptic). */
  fireDraw?: (opts: { sweep: boolean }) => unknown
  fireDrawAndPlay?: (entry: AccessibleCard, to: PileRef) => unknown
}): AutoFoundationCascade {
  const armedRef = useRef(false)
  const pinnedRef = useRef<{ entry: AccessibleCard; to: PileRef } | null>(null)
  const sweepingRef = useRef(false)
  const runningRef = useRef(false)
  // The loop below runs across many renders; it always reads the newest config through this, so a
  // settings flip or a fresh closure is seen at its very next step.
  const latestRef = useRef(config)
  useEffect(() => {
    latestRef.current = config
  })
  useEffect(
    () => () => {
      armedRef.current = false
    },
    []
  )

  function disarm() {
    armedRef.current = false
    pinnedRef.current = null
    sweepingRef.current = false
  }

  // True once everything has landed; false if the cascade was disarmed meanwhile, or the wait ran
  // out (the [state, settled] effect picks it up again at the next settle).
  async function waitForSettle(): Promise<boolean> {
    const deadline = Date.now() + MAX_SETTLE_WAIT_MS
    while (!latestRef.current.isSettled()) {
      if (!armedRef.current || Date.now() >= deadline) return false
      await sleep(SETTLE_POLL_MS)
    }
    return armedRef.current
  }

  async function run() {
    runningRef.current = true
    try {
      // The board as the cascade's own last commit left it: anything else means someone else moved.
      let expected = latestRef.current.getState()
      // The last step was a draw: let it land before the next one.
      let fenced = false
      let misses = 0
      while (armedRef.current) {
        const c = latestRef.current
        if (!c.enabled() || c.isBusy()) return
        const s = c.getState()
        if (!s) return
        const pinned = pinnedRef.current
        const step: AutoCompleteStep | null = pinned ? { kind: 'play', ...pinned } : c.computeNextStep(s)
        if (!step) {
          disarm()
          return
        }
        if (fenced || step.kind !== 'play' || s !== expected) {
          if (!c.isSettled()) {
            if (!(await waitForSettle())) return
            continue // start over from the settled board - the step may be a different one now
          }
          expected = s
          fenced = false
        }
        if (pinned) pinnedRef.current = null
        if (step.kind !== 'play') sweepingRef.current = true
        const sweep = sweepingRef.current
        let fired: boolean
        if (step.kind === 'play') {
          fired = await c.firePlay(step.entry, step.to)
        } else {
          if (step.kind === 'drawAndPlay') await c.fireDrawAndPlay?.(step.entry, step.to)
          else await c.fireDraw?.({ sweep: true })
          fired = latestRef.current.getState() !== s
          fenced = true
        }
        if (fired) {
          misses = 0
          expected = latestRef.current.getState()
        } else if (++misses >= MAX_CONSECUTIVE_MISSES) {
          disarm()
          return
        }
        await sleep(sweep ? WIN_SWEEP_STAGGER_MS : AUTO_PLAY_STAGGER_MS)
      }
    } finally {
      runningRef.current = false
    }
  }

  // Deliberately depends on only [state, settled], not on the callbacks - every screen passes fresh
  // inline closures for those on every render. A running cascade reads the newest ones itself.
  useEffect(() => {
    if (!armedRef.current || runningRef.current) return
    if (!config.enabled() || !config.state || !config.settled || config.isBusy()) return
    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.state, config.settled])

  return {
    armFromForwardMove() {
      armedRef.current = true
    },
    armFromAceEvent(entry, to) {
      armedRef.current = true
      pinnedRef.current = { entry, to }
    },
    disarm
  }
}
