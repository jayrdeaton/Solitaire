import { GameController, Move, PileRef } from './gameTypes'

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
 * Finds one legal move to highlight for the Hint button - reuses `legalMoves` (every game's own
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
export function findHint<TState>(controller: Pick<GameController<TState>, 'legalMoves' | 'drawStock' | 'scoreHintMove'> & Partial<Pick<GameController<TState>, 'tryMove'>>, state: TState, skip = 0): HintResult {
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
