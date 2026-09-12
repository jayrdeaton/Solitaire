import { GameController, Move, PileRef } from './gameTypes'

export type HintResult = { kind: 'move'; move: Move } | { kind: 'drawStock' } | { kind: 'none' }

function refsEqual(a: PileRef, b: PileRef): boolean {
  return a.zone === b.zone && a.index === b.index
}

/**
 * How many of this pile's own top cards a screen should highlight for the current hint - the
 * source pile highlights the full run being suggested (`move.count`), the destination pile
 * highlights just its current top card/slot (1) as the landing spot. 0 for every other pile, or
 * when there's no active move-shaped hint (a `kind: 'drawStock'`/`'none'` hint has no `move` to
 * match against - see each screen's own stock-pile highlighting for the drawStock case instead).
 */
export function hintCountFor(hint: HintResult | null, ref: PileRef): number {
  if (!hint || hint.kind !== 'move') return 0
  if (refsEqual(hint.move.from, ref)) return hint.move.count
  if (refsEqual(hint.move.to, ref)) return 1
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
 * stock draw is legal, that's suggested instead of the best of a bad lot. If there's no legal move
 * at all, falls back the same way, and otherwise reports there's nothing to suggest.
 *
 * `skip` cycles through that ordering - each screen bumps it by one on a repeated Hint press
 * against an unchanged board (see e.g. KlondikeScreen's own handleHint), so pressing Hint
 * repeatedly without making a move surfaces a different legal move each time instead of
 * re-suggesting the same one, wrapping back to the start once every move's been shown. Meaningless
 * for a 'drawStock'/'none' result - there's only one of each to suggest regardless of `skip`.
 */
export function findHint<TState>(controller: Pick<GameController<TState>, 'legalMoves' | 'drawStock' | 'scoreHintMove'>, state: TState, skip = 0): HintResult {
  const moves = controller.legalMoves(state)
  if (moves.length > 0) {
    const score = controller.scoreHintMove
    const foundationMoves = moves.filter((m) => m.to.zone === 'foundation')
    const otherMoves = moves.filter((m) => m.to.zone !== 'foundation')
    const rankedOther = score ? [...otherMoves].sort((a, b) => score(state, b) - score(state, a)) : otherMoves
    if (score && foundationMoves.length === 0 && otherMoves.every((m) => score(state, m) <= 0) && controller.drawStock && controller.drawStock(state) !== null) {
      return { kind: 'drawStock' }
    }
    const ordered = [...foundationMoves, ...rankedOther]
    const move = ordered[skip % ordered.length]
    return { kind: 'move', move }
  }
  if (controller.drawStock && controller.drawStock(state) !== null) {
    return { kind: 'drawStock' }
  }
  return { kind: 'none' }
}
