// Undo-related shapes shared by every game's own <Game>Screen.tsx.

import { PileRef } from '@/engine/gameTypes'

/** Records enough about an applied move to reverse its animation later - undoing doesn't just
 * revert to the previous state snapshot, it flies the moved card(s) back from wherever they
 * currently sit (`to`) to their previous pile (`from`), mirroring the forward flight in reverse. */
export interface MoveInfo {
  from: PileRef
  to: PileRef
  count: number
  anchorCardId: string
}

/** One entry in a game's undo stack: the state to revert to, plus (when there's something
 * card-shaped to fly back) the move that produced the NEXT state, so undo can reverse its
 * animation instead of just snapping. `TMove` lets a game narrow or widen the default
 * `MoveInfo | null` - e.g. FreeCell's `move` is never null (every FreeCell move has a real
 * origin/destination to fly), so it instantiates `UndoEntry<FreeCellState, MoveInfo>` instead of
 * falling back to the nullable default. */
export interface UndoEntry<TState, TMove = MoveInfo | null> {
  state: TState
  move: TMove
}
