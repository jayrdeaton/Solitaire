import { useEffect, useState } from 'react'

import { GameController } from '@/engine/gameTypes'
import { cachedSearchOutcome, cacheSearchOutcome } from '@/engine/hint'
import { isConclusive, LOOKAHEAD_BUDGET, LOOKAHEAD_MAX_MS, ProgressSearch, ProgressSpec, SearchOutcome } from '@/engine/progressSearch'

// The look-ahead waits this long after a board change, so a stream of auto-played cards (each its own board) doesn't start
// one search per card, then works in slices of SLICE_MS with a frame between them, so the flights and the player's next
// touch never wait on it.
const START_DELAY_MS = 150
const SLICE_MS = 4
const SLICE_GAP_MS = 16

export type LookaheadController<TState> = Partial<Pick<GameController<TState>, 'tryMove' | 'isWon' | 'drawStock' | 'scoreHintMove' | 'progress'>>

// Boards found dead, by board and rules (ProgressSpec.id), so a board seen again (an Undo back to it) is known at once.
const deadBoards = new WeakMap<object, Set<string>>()

function knownDead<TState>(spec: ProgressSpec<TState>, state: TState): boolean {
  return typeof state === 'object' && state !== null && !!deadBoards.get(state as object)?.has(spec.id)
}

function markDead<TState>(spec: ProgressSpec<TState>, state: TState): void {
  if (typeof state !== 'object' || state === null) return
  let ids = deadBoards.get(state as object)
  if (!ids) deadBoards.set(state as object, (ids = new Set()))
  ids.add(spec.id)
}

/** Whether a search that looked at everything and found no progress leaves the board dead: only if the stock has nothing
 * left to deal (a stock that isn't part of the search still has cards to give). */
function noStockLeft<TState>(controller: LookaheadController<TState>, spec: ProgressSpec<TState>, state: TState): boolean {
  return spec.drawIsStep || !controller.drawStock || controller.drawStock(state) === null
}

/**
 * Looks ahead from every board a game with an idea of progress (GameController.progress) settles on, in the background:
 * its answer is what Hint offers (engine/hint.ts reads it from the same cache), and a board from which no progress can be
 * reached at all is dead (the loss dialog, see useStuckLossCheck). Hint's search leaves out the game's rescue moves (a card
 * back down off a foundation), so a board it finds nothing from is searched once more with them before it is called dead.
 * True while `state` is known to be dead. Skips a won board and anything while `enabled` is off.
 */
export function useBoardLookahead<TState>(controller: LookaheadController<TState>, state: TState | null, enabled = true): boolean {
  const [, setFound] = useState(0)
  const spec = controller.progress

  useEffect(() => {
    const { tryMove, isWon } = controller
    if (!enabled || !spec || !tryMove || !isWon || state === null || isWon(state) || knownDead(spec, state)) return
    // A board with cards still to deal from a stock that isn't part of the search (Spider's, Scorpion's, Aces Up's, Forty
    // Thieves') can't be dead, and its look-ahead is the costliest (Spider with two or four suits: ~85ms a board in Node):
    // a Hint press looks for itself when it needs to.
    if (!noStockLeft(controller, spec, state)) return
    const searchController = { ...controller, tryMove }
    const dead = () => {
      markDead(spec, state)
      setFound((n) => n + 1)
    }
    // Hint's own look first, unless a Hint press already finished one; then, if that found nothing anywhere, the rescue
    // pass. Returns true when the look says the board is dead outright (no rescue moves to try).
    let rescue: ProgressSearch<TState> | null = null
    const afterHintLook = (outcome: SearchOutcome) => {
      if (!outcome.exhausted || !noStockLeft(controller, spec, state)) return false
      if (!spec.rescueMoves) return true
      rescue = new ProgressSearch(searchController, spec, state, 'alive')
      return false
    }
    const cached = cachedSearchOutcome(spec, state)
    let search: ProgressSearch<TState> | null = null
    if (cached && isConclusive(cached)) {
      if (afterHintLook(cached)) {
        dead()
        return
      }
      if (!rescue) return
    } else {
      search = new ProgressSearch(searchController, spec, state, 'hint')
    }
    let timer: ReturnType<typeof setTimeout>
    // Time spent so far, over both passes: past LOOKAHEAD_MAX_MS the look stops where it is.
    let spentMs = 0
    const slice = () => {
      const started = Date.now()
      const until = started + SLICE_MS
      const current = (search ?? rescue)!
      let done = false
      while (!done && Date.now() < until && current.expanded < LOOKAHEAD_BUDGET) done = current.step(25)
      spentMs += Date.now() - started
      if (!done && current.expanded < LOOKAHEAD_BUDGET && spentMs < LOOKAHEAD_MAX_MS) {
        timer = setTimeout(slice, SLICE_GAP_MS)
        return
      }
      const outcome = current.outcome()
      if (current === search) {
        search = null
        cacheSearchOutcome(spec, state, outcome)
        if (afterHintLook(outcome)) dead()
        else if (rescue && spentMs < LOOKAHEAD_MAX_MS) timer = setTimeout(slice, SLICE_GAP_MS)
        return
      }
      if (outcome.exhausted) dead()
    }
    timer = setTimeout(slice, START_DELAY_MS)
    return () => clearTimeout(timer)
  }, [controller, spec, state, enabled])

  return !!spec && state !== null && enabled && knownDead(spec, state)
}
