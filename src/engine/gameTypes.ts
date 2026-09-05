// Generic contract every game variant (Klondike, Spider, FreeCell, Pyramid, ...)
// implements. Each game owns its own state shape (`TState`) since the board
// layouts differ too much to force into one generic structure - but every
// game exposes the same controller shape so the app shell can drive any of
// them the same way (new game, undo, move, win check).

import { Card } from './types';

export interface PileRef {
  /** Logical zone name within the game's own state, e.g. 'tableau' | 'foundation' | 'stock' | 'waste' | 'freecell'. */
  zone: string;
  /** Which pile within that zone (0-indexed). Zones with a single pile (e.g. stock) always use 0. */
  index: number;
}

export interface Move {
  from: PileRef;
  to: PileRef;
  /** How many cards from the top of `from` to move together (1 for a single card). */
  count: number;
}

/** A card currently sitting at a legally-reachable position - a tableau top, a freecell, a waste
 * top - the unit engine/autoFoundation.ts scans over for the auto-play-to-foundation feature.
 * Lives here rather than in autoFoundation.ts itself so that file can import PileRef/GameController
 * from this one without a cycle. */
export interface AccessibleCard {
  ref: PileRef;
  card: Card;
}

export interface GameController<TState> {
  id: string;
  title: string;
  /** Deal a brand new game from a seed (same seed -> same deal, for testability / shareable game numbers). */
  newGame(seed: number): TState;
  /** All currently legal moves - used for hints and "no moves left" detection. */
  legalMoves(state: TState): Move[];
  /** Attempt a move. Returns a new state if legal, or null if illegal (state is never mutated in place). */
  tryMove(state: TState, move: Move): TState | null;
  /** Draw from stock / recycle waste, etc. Returns a new state, or null if not applicable right now. */
  drawStock?(state: TState): TState | null;
  isWon(state: TState): boolean;
  /** True if no legal moves and no stock draw remain (used for "stuck" banners). */
  isStuck?(state: TState): boolean;
  /**
   * Optional: given a single tapped card, find its best automatic destination - a foundation move
   * if one exists, otherwise the best tableau destination (fewest buried cards, then largest pile,
   * then leftmost, breaking ties in that order), or null if the card has nowhere legal to go.
   * Powers tap-to-auto-move; calling it again with the card now sitting at that destination finds
   * the next-best destination from there, since the one it just left is no longer a valid target.
   */
  autoMoveHint?(state: TState, from: PileRef, cardId: string): Move | null;
  /**
   * Optional: every card currently sitting at a legally-reachable position - tableau tops,
   * freecell contents, a waste top - for the auto-play-to-foundation feature (see
   * engine/autoFoundation.ts) to scan. Never includes stock or anything else that would need an
   * extra action (like a draw) to become reachable.
   */
  accessibleCards?(state: TState): AccessibleCard[];
}
