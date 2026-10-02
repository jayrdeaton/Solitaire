import { useEffect, useRef } from 'react'

import { AUTO_PLAY_STAGGER_MS } from '@/components/dragdrop/dragSpring'
import { AutoCompleteStep } from '@/engine/autoFoundation'
import { AccessibleCard, PileRef } from '@/engine/gameTypes'

export interface AutoFoundationCascade {
  /** Call right after a manual (non-silent) player move whose `to.zone === 'foundation'` commits -
   * the only ordinary trigger for this whole feature. Arms the cascade; its first card follows the
   * player's own one AUTO_PLAY_STAGGER_MS later, while that one is still in the air. */
  armFromForwardMove(): void
  /** Call right after a stock-draw-to-waste or tableau/reserve-reveal produces this game's own
   * foundation-starter card (rank 1 for every game except Canfield - see its own
   * isFoundationStarterCard). Plays `entry` first, ahead of whatever computeNextStep's own scan
   * order would otherwise pick, then continues the cascade exactly like armFromForwardMove - the
   * ace landing on its foundation is itself now "a card moved to the foundation." */
  armFromAceEvent(entry: AccessibleCard, to: PileRef): void
  /** Drops any pending arm (and its pinned card), and stops a cascade that's already running. For
   * a board change that isn't a consequence of the player's own foundation move - an undo, a
   * resumed save, a new deal, or an arm made while auto-move was off: the cascade only ever disarms
   * on its own once computeNextStep runs dry, which it never reaches while enabled()/isBusy() hold
   * it back, so without this an old arm could fire a cascade on a later board with no fresh tap. */
  disarm(): void
}

// A step that can't measure its card, or finds the board changed under it, reports a miss. A few
// in a row means something is genuinely wrong (a card that never registers) - stop rather than
// retry forever, and leave the rest to the player. Same limit as useAutoFinish.
const MAX_CONSECUTIVE_MISSES = 3
// How often a cascade waiting for a card to land checks again, and how long it waits at most before
// giving up until the board next changes (the [state] effect starts it again).
const LANDING_POLL_MS = 16
const MAX_LANDING_WAIT_MS = 3000
const STOCK: PileRef = { zone: 'stock', index: 0 }
const WASTE: PileRef = { zone: 'waste', index: 0 }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * An explicit armed state machine: nothing fires until one of the two arm methods above is called,
 * and it disarms the moment computeNextStep runs dry - a plain tableau/freecell move, an undo, a
 * non-ace draw/reveal, or the initial deal trigger nothing here at all, by construction, since
 * none of them ever call either arm method.
 *
 * Once armed it sends its cards up one after another, AUTO_PLAY_STAGGER_MS apart, the first one
 * that long after the player's own card - none of them waits for the one before it to land. Flights
 * are purely cosmetic overlays on a board that already committed (see useFlightConcurrency), and
 * every card flight takes the same time (dragSpring.ts's FLIGHT_SPRING), so they overlap freely and
 * still land in the order they left: two cards headed to the same foundation never overtake each
 * other. The one thing a step waits for (polling `isLanding`) is a card still flying in to the pile
 * it would take from - picking up a card whose own ghost is still airborne shows it twice (a drawn
 * ace, a card the player just dropped there). A draw or draw-and-play waits the same way for the
 * stock and waste to be quiet: they have their own flight machinery (frozen slots, draw-3 fans
 * through the deal layer, which flies one batch at a time, recycle clumps).
 */
export function useAutoFoundationCascade<TState>(config: {
  state: TState | null
  /** Whether a card is still flying in to `pile` - read live (useFlightConcurrency's isLanding). */
  isLanding: (pile: PileRef) => boolean
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
  }

  // True once `blocked` clears; false if the cascade was disarmed meanwhile, or the wait ran out.
  async function waitUntilClear(blocked: () => boolean): Promise<boolean> {
    const deadline = Date.now() + MAX_LANDING_WAIT_MS
    while (blocked()) {
      if (!armedRef.current || Date.now() >= deadline) return false
      await sleep(LANDING_POLL_MS)
    }
    return armedRef.current
  }

  async function run() {
    runningRef.current = true
    try {
      let misses = 0
      // Whether the next card still owes its gap after the one before (a wait for a landing already spaced it out).
      let gap = true
      while (armedRef.current) {
        if (gap) await sleep(AUTO_PLAY_STAGGER_MS)
        gap = true
        if (!armedRef.current) return
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
        const blocked = step.kind === 'play' ? () => latestRef.current.isLanding(step.entry.ref) : () => latestRef.current.isLanding(STOCK) || latestRef.current.isLanding(WASTE)
        if (blocked()) {
          if (!(await waitUntilClear(blocked))) return
          gap = false
          continue // start over from the board as it is now - the step may be a different one
        }
        if (pinned) pinnedRef.current = null
        let fired: boolean
        if (step.kind === 'play') {
          fired = await c.firePlay(step.entry, step.to)
        } else {
          if (step.kind === 'drawAndPlay') await c.fireDrawAndPlay?.(step.entry, step.to)
          else await c.fireDraw?.({ sweep: true })
          fired = latestRef.current.getState() !== s
        }
        if (fired) {
          misses = 0
        } else if (++misses >= MAX_CONSECUTIVE_MISSES) {
          disarm()
          return
        }
      }
    } finally {
      runningRef.current = false
    }
  }

  // Deliberately depends on only [state], not on the callbacks - every screen passes fresh inline
  // closures for those on every render. A running cascade reads the newest ones itself. Every arm
  // call comes with the commit of the move that made it, so this always runs right after one.
  useEffect(() => {
    if (!armedRef.current || runningRef.current) return
    if (!config.enabled() || !config.state || config.isBusy()) return
    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.state])

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
