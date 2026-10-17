import { useEffect, useRef } from 'react'

import { AUTO_PLAY_STAGGER_MS } from '@/components/dragdrop/dragSpring'
import { AutoCompleteStep } from '@/engine/autoFoundation'
import { AccessibleCard, PileRef } from '@/engine/gameTypes'

export interface AutoFoundationCascade {
  /** Call right after every move the PLAYER made commits (a tap or a drag; never an auto-played,
   * silent one). A move to a foundation is the one thing that starts auto-play: its first card follows
   * the player's own one AUTO_PLAY_STAGGER_MS later, while that one is still in the air. Any other
   * move (to a column, a freecell, the reserve...) stops a cascade still running from an earlier
   * play, so a card that move uncovers is the player's to find and play, never auto-played for them. */
  afterPlayerMove(to: PileRef): void
  /** Stops a cascade that's already running and drops one about to start. For a board change that
   * isn't the player's own card move - a stock draw (a card just drawn is theirs to find), an undo,
   * a resumed save, a new deal. */
  disarm(): void
  /** Whether the cascade is still armed - false once the player's draw or other move, an undo, a new
   * deal or the loop itself has ended it. For a firePlay/fireDraw/fireDrawAndPlay that awaits before
   * committing: whatever it waited through may have ended the cascade, and the loop's own check is
   * already behind it by then (useAutoFinish's isAllowed is the same check for the finish). */
  isArmed(): boolean
}

// A step that can't measure its card, or finds the board changed under it, reports a miss. A few
// in a row means something is genuinely wrong (a card that never registers) - stop rather than
// retry forever, and leave the rest to the player. Same limit as useAutoFinish.
const MAX_CONSECUTIVE_MISSES = 3
// How often a cascade waiting for a card to land checks again, and how long it waits at most before
// giving up (the cascade ends there; the player's next foundation play starts a new one).
const LANDING_POLL_MS = 16
const MAX_LANDING_WAIT_MS = 3000
const STOCK: PileRef = { zone: 'stock', index: 0 }
const WASTE: PileRef = { zone: 'waste', index: 0 }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * An explicit armed state machine. Auto-play only ever follows the player's own play of a card to a
 * foundation (afterPlayerMove); nothing else arms it - not a stock draw, not a card a move uncovers on
 * the tableau or the reserve, not an undo, a resume or a deal. Once armed it plays whatever is
 * available until computeNextStep runs dry. An arm never outlives that: when the cascade stops for
 * any reason (ran dry, the player's next non-foundation move or draw, an undo, Auto-Move turned off,
 * a wait that ran out), it is disarmed, and one that can't start at once (Auto-Move off, an undo
 * running) is dropped - so it can never fire later, after some other board change, with no
 * foundation play in front of it.
 *
 * Once armed it sends its cards up one after another, AUTO_PLAY_STAGGER_MS apart, the first one
 * that long after the player's own card - none of them waits for the one before it to land. The gap
 * is a fixed clock, like useAutoFinish's: each card leaves AUTO_PLAY_STAGGER_MS after the card before
 * it LEFT, not after that card's measurement and commit, and its click and buzz (`beat`) play as it
 * leaves, so the stream keeps a steady rhythm (Jay, 2026-10-17). Flights
 * are purely cosmetic overlays on a board that already committed (see useFlightConcurrency), and
 * every card flight takes the same time (dragSpring.ts's FLIGHT_SPRING), so they overlap freely and
 * still land in the order they left: two cards headed to the same foundation never overtake each
 * other. The one thing a step waits for (polling `isLanding`) is a card still flying in to the pile
 * it would take from - picking up a card whose own ghost is still airborne shows it twice (a card
 * the sweep just drew, a card the player just dropped there). A draw or draw-and-play (the end-game
 * finish through the stock, see engine/autoFoundation.ts) waits the same way for the stock and waste
 * to be quiet: they have their own flight machinery (frozen slots, draw-3 fans through the deal
 * layer, which flies one batch at a time, recycle clumps).
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
   * couldn't (the measurement failed, the board changed underneath it, the cascade was disarmed
   * meanwhile - see isArmed). Resolves when the move is COMMITTED - not when the flight lands. */
  firePlay: (entry: AccessibleCard, to: PileRef) => Promise<boolean>
  /** Only supplied by the games with a stock (Klondike/Canfield/FortyThieves). Resolve once the
   * draw is committed (or refused). `sweep` tells the draw it is the cascade's, not the player's
   * (no move counted, the cascade's throttled sound/haptic). */
  fireDraw?: (opts: { sweep: boolean }) => unknown
  fireDrawAndPlay?: (entry: AccessibleCard, to: PileRef) => unknown
  /** One auto-played card's click and buzz, played the moment it leaves - on the cascade's own clock, so they keep its
   * rhythm, rather than after the card's measurement (which takes a different time every card). firePlay and fireDrawAndPlay
   * play none; fireDraw plays its own (a draw-3 fan's are the deal layer's). */
  beat?: () => void
}): AutoFoundationCascade {
  const armedRef = useRef(false)
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
      // When the card before this one left: the player's own move for the first (this runs in the effect of its commit).
      let lastLeftAt = Date.now()
      // Whether the next card still owes its gap after the one before (a wait for a landing already spaced it out).
      let gap = true
      while (armedRef.current) {
        const wait = gap ? lastLeftAt + AUTO_PLAY_STAGGER_MS - Date.now() : 0
        if (wait > 0) await sleep(wait) // a card already late (its predecessor was slow to measure) goes at once
        gap = true
        if (!armedRef.current) return
        const c = latestRef.current
        if (!c.enabled() || c.isBusy()) return
        const s = c.getState()
        if (!s) return
        const step = c.computeNextStep(s)
        if (!step) return
        const blocked = step.kind === 'play' ? () => latestRef.current.isLanding(step.entry.ref) : () => latestRef.current.isLanding(STOCK) || latestRef.current.isLanding(WASTE)
        if (blocked()) {
          if (!(await waitUntilClear(blocked))) return
          gap = false
          continue // start over from the board as it is now - the step may be a different one
        }
        lastLeftAt = Date.now()
        // A plain draw plays its own (fireDraw): a draw-3 fan clicks and buzzes on the deal layer's beat.
        if (step.kind !== 'draw') c.beat?.()
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
          return
        }
      }
    } finally {
      runningRef.current = false
      // Every way out of the loop ends this cascade for good: only a fresh foundation play starts another.
      disarm()
    }
  }

  // Deliberately depends on only [state], not on the callbacks - every screen passes fresh inline
  // closures for those on every render. A running cascade reads the newest ones itself. Every arm
  // comes with the commit of the player's move that made it, so this always runs right after one.
  useEffect(() => {
    if (!armedRef.current || runningRef.current) return
    if (!config.enabled() || !config.state || config.isBusy()) {
      disarm() // can't follow that play now - and must never fire later, after some other move
      return
    }
    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.state])

  return {
    afterPlayerMove(to) {
      armedRef.current = to.zone === 'foundation'
    },
    disarm,
    isArmed() {
      return armedRef.current
    }
  }
}
