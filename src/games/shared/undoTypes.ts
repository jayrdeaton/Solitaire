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
  /** The full oldest-to-newest card id list for a count > 1 move, only when it can't be reliably
   * reconstructed later by peeking at the current top `count` cards of `to`'s pile (that trick only
   * works for the single most recent move on the stack - a multi-card auto-draw/recycle folded into
   * a cascade, undone alongside other moves that happened after it, needs its own record instead).
   * Unused (and unnecessary) for a single-card move, or for a primary move's own draw-3/recycle
   * undo, which is always undoing the single most recent stack entry. */
  cardIds?: string[]
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
