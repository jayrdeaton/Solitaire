import { GameController, Move, PileRef } from './gameTypes'
import { HINT_SEARCH_BUDGET, HINT_SEARCH_MAX_MS, isConclusive, ProgressSearch, ProgressSpec, SearchOutcome } from './progressSearch'

/** A 'move' hint carries `choices`: how many moves Hint cycles through on this board (`skip` wraps at it), so a held Hint
 * button knows whether there's a next one to show (see components/hintHold.ts). */
export type HintResult = { kind: 'move'; move: Move; choices: number } | { kind: 'drawStock' } | { kind: 'none' }

function refsEqual(a: PileRef, b: PileRef): boolean {
  return a.zone === b.zone && a.index === b.index
}

/**
 * How many of this pile's own top cards a screen should ring for the current hint: the source pile
 * rings the run being suggested (`move.count`), every other pile nothing. The destination is shown
 * by the hint's glide (games/shared/useHintGlide.ts), not a second ring, so the ring only ever
 * marks what to pick up. 0 when there's no active move-shaped hint (a `kind: 'drawStock'`/`'none'`
 * hint has no `move` to match against - see each screen's own stock-pile highlighting instead).
 */
export function hintCountFor(hint: HintResult | null, ref: PileRef): number {
  if (!hint || hint.kind !== 'move') return 0
  if (refsEqual(hint.move.from, ref)) return hint.move.count
  return 0
}

/**
 * The move (or draw) the Hint button suggests. A game that says what progress is gets the look-ahead's answer (searchedHint
 * below); any other game, or a board the look-ahead ran out of room on, the scored hint (scoredHint).
 *
 * `skip` cycles through the suggestions - each screen bumps it by one on a repeated Hint press against an unchanged board
 * (see e.g. KlondikeScreen's own handleHint), wrapping back to the start once every one has been shown; a move hint's
 * `choices` says how many there are. Holding the Hint button steps through the same cycle (see components/hintHold.ts).
 */
export function findHint<TState>(controller: Pick<GameController<TState>, 'legalMoves' | 'drawStock' | 'scoreHintMove'> & Partial<Pick<GameController<TState>, 'tryMove' | 'progress'>>, state: TState, skip = 0): HintResult {
  const scored = scoredHint(controller, state, skip)
  return searchedHint(controller, state, skip, scored) ?? scored
}

// One look-ahead per board, whichever asks first: a held Hint steps through its first steps, and Auto Hint and the
// background look-ahead (games/shared/useBoardLookahead.ts) ask about the same board. Kept by the board object (boards are
// never changed in place) and the rules (ProgressSpec.id).
const searchCache = new WeakMap<object, Map<string, SearchOutcome>>()

export function cachedSearchOutcome<TState>(spec: ProgressSpec<TState>, state: TState): SearchOutcome | undefined {
  return typeof state === 'object' && state !== null ? searchCache.get(state as object)?.get(spec.id) : undefined
}

export function cacheSearchOutcome<TState>(spec: ProgressSpec<TState>, state: TState, outcome: SearchOutcome): void {
  if (typeof state !== 'object' || state === null) return
  let byRules = searchCache.get(state as object)
  if (!byRules) searchCache.set(state as object, (byRules = new Map()))
  const known = byRules.get(spec.id)
  // A longer look keeps its answer over a shorter one's.
  if (!known || outcome.nodes >= known.nodes || isConclusive(outcome)) byRules.set(spec.id, outcome)
}

/** The look-ahead's outcome for this board (engine/progressSearch.ts): the background's if it has one, else a short one of
 * its own (HINT_SEARCH_BUDGET, HINT_SEARCH_MAX_MS). */
export function hintSearchOutcome<TState>(controller: Pick<GameController<TState>, 'tryMove'> & Partial<Pick<GameController<TState>, 'drawStock' | 'scoreHintMove' | 'progress'>>, state: TState): SearchOutcome | null {
  const spec = controller.progress
  if (!spec) return null
  const cached = cachedSearchOutcome(spec, state)
  if (cached && (isConclusive(cached) || cached.nodes >= HINT_SEARCH_BUDGET)) return cached
  const outcome = new ProgressSearch(controller, spec, state, 'hint').run(HINT_SEARCH_BUDGET, HINT_SEARCH_MAX_MS)
  cacheSearchOutcome(spec, state, outcome)
  return outcome
}

// The boards a look-ahead hint leads to, by rules and position key (ProgressSpec.key), a few at a time: a hint asked for on
// one of them carries on with the look-ahead's plan. Without it the scored hint's next "productive" move could take back
// the plan's last step, and the two would lead the player round in circles (Spider with two suits did, in simulation).
const PLAN_MEMORY = 32
const planBoards: string[] = []

function rememberPlanStep<TState>(spec: ProgressSpec<TState>, next: TState | null): void {
  if (next === null) return
  planBoards.push(`${spec.id}/${spec.key(next)}`)
  if (planBoards.length > PLAN_MEMORY) planBoards.shift()
}

/**
 * The hint for a game that says what progress is (GameController.progress), or null to keep the scored one. The scored hint
 * plays these games well while it has a productive move to offer (a card to a foundation, a card turned over, a run built,
 * a card off the waste), so that stands. It goes wrong when it has nothing better than a card moved from one column to
 * another for nothing, a draw, or "no moves" (a coworker of Jay's, 2026-10-22): then the look-ahead (engine/progressSearch.ts)
 * offers the first step of the shortest way to progress, and the hints after it carry that plan through. A board from which
 * no progress can be reached at all gets a draw if a stock that isn't part of the search still has cards, a rescue move if
 * that is the only way on, else nothing (the dead-board check calls the deal lost). With several equally short ways, `skip`
 * steps through their first steps.
 */
function searchedHint<TState>(controller: Pick<GameController<TState>, 'drawStock' | 'scoreHintMove'> & Partial<Pick<GameController<TState>, 'tryMove' | 'progress'>>, state: TState, skip: number, scored: HintResult): HintResult | null {
  const spec = controller.progress
  const tryMove = controller.tryMove
  if (!spec || !tryMove) return null
  const searchController = controller as Pick<GameController<TState>, 'tryMove'> & typeof controller
  const midPlan = planBoards.includes(`${spec.id}/${spec.key(state)}`)
  const productive = !midPlan && scored.kind === 'move' && (scored.move.to.zone === 'foundation' || !controller.scoreHintMove || controller.scoreHintMove(state, scored.move) > 0)
  // Looked up even for a productive hint: a board that can't make progress gets no move at all. Cheap when the board is
  // alive (the look stops at the first progress, usually a move or two away), and kept for the next press.
  const outcome = hintSearchOutcome(searchController, state)
  if (!outcome) return null
  if (outcome.exhausted) {
    if (!spec.drawIsStep && controller.drawStock && controller.drawStock(state) !== null) return { kind: 'drawStock' }
    // Only a rescue move (a card back down off a foundation) gets anywhere: it is the hint then, rare as that is.
    if (spec.rescueMoves) {
      const rescue = new ProgressSearch(searchController, spec, state, 'alive').run(HINT_SEARCH_BUDGET, HINT_SEARCH_MAX_MS)
      const step = rescue.firstSteps[0]
      if (step) return step.kind === 'draw' ? { kind: 'drawStock' } : { kind: 'move', move: step.move, choices: 1 }
    }
    return { kind: 'none' }
  }
  if (productive || outcome.found !== 'progress') return null
  const steps = outcome.firstSteps
  const step = steps[skip % steps.length]
  if (step.kind === 'draw') {
    rememberPlanStep(spec, controller.drawStock ? controller.drawStock(state) : null)
    return { kind: 'drawStock' }
  }
  rememberPlanStep(spec, tryMove(state, step.move))
  return { kind: 'move', move: step.move, choices: steps.length }
}

/**
 * The hint for a game with no idea of progress, or when the look-ahead ran out of room: finds one legal move to highlight for the Hint button - reuses `legalMoves` (every game's own
 * full board scan, already documented in gameTypes.ts as "used for hints and 'no moves left'
 * detection") rather than a separate solver. Foundation-bound moves (always real progress) sort
 * first; the rest are ranked by the game's own optional `scoreHintMove` (highest first) where one's
 * provided, otherwise left in whatever order `legalMoves` returned them - games with no
 * 'foundation' zone and no scorer (Pyramid) just get that raw order untouched. If every legal move
 * scores non-positive (nothing productive available - see each game's own `scoreHintMove`) and a
 * stock draw is legal, that's suggested instead of the best of a bad lot. A move that gains nothing
 * and can be moved straight back is never suggested (see isShuffle). If that leaves nothing, falls
 * back the same way, and otherwise reports there's nothing to suggest.
 *
 * `skip` cycles through that ordering - each screen bumps it by one on a repeated Hint press
 * against an unchanged board (see e.g. KlondikeScreen's own handleHint), so pressing Hint
 * repeatedly without making a move surfaces a different legal move each time instead of
 * re-suggesting the same one, wrapping back to the start once every move's been shown. Meaningless
 * for a 'drawStock'/'none' result - there's only one of each to suggest regardless of `skip`. Holding the Hint button
 * steps through the same cycle (see components/hintHold.ts).
 */
function scoredHint<TState>(controller: Pick<GameController<TState>, 'legalMoves' | 'drawStock' | 'scoreHintMove'> & Partial<Pick<GameController<TState>, 'tryMove'>>, state: TState, skip: number): HintResult {
  const moves = controller.legalMoves(state)
  if (moves.length > 0) {
    const score = controller.scoreHintMove
    const foundationMoves = moves.filter((m) => m.to.zone === 'foundation')
    const otherMoves = moves.filter((m) => m.to.zone !== 'foundation' && !(score && isShuffle(controller, state, m, score)))
    const rankedOther = score ? [...otherMoves].sort((a, b) => score(state, b) - score(state, a)) : otherMoves
    if (score && foundationMoves.length === 0 && otherMoves.every((m) => score(state, m) <= 0) && controller.drawStock && controller.drawStock(state) !== null) {
      return { kind: 'drawStock' }
    }
    const ordered = [...foundationMoves, ...rankedOther]
    if (ordered.length > 0) return { kind: 'move', move: ordered[skip % ordered.length], choices: ordered.length }
  }
  if (controller.drawStock && controller.drawStock(state) !== null) {
    return { kind: 'drawStock' }
  }
  return { kind: 'none' }
}

/**
 * A move that gains nothing (scores 0 or less) and can be moved straight back. Hint never suggests one: with no stock to
 * fall back on (Yukon, FreeCell, Spider with an empty column, Scorpion's dealt stock) it used to offer the best of a bad
 * lot, then its reverse once the player made it, back and forth for good. A move that turns a card over or builds
 * something scores above 0 and is kept, whether or not it can be moved back.
 */
function isShuffle<TState>(controller: Partial<Pick<GameController<TState>, 'tryMove'>>, state: TState, move: Move, score: (state: TState, move: Move) => number): boolean {
  if (!controller.tryMove || score(state, move) > 0) return false
  const after = controller.tryMove(state, move)
  return after !== null && controller.tryMove(after, { from: move.to, to: move.from, count: move.count }) !== null
}
