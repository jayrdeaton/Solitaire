import { Card, SUITS } from '@/engine/types';
import { shuffledDeck } from '@/engine/deck';
import { isDescendingSameSuit, top } from '@/engine/pile';
import { pickBestTableauTarget } from '@/engine/autoMove';
import { GameController, Move, PileRef } from '@/engine/gameTypes';

export interface SpiderState {
  tableau: Card[][];
  stock: Card[];
  /** One entry per completed King->Ace same-suit run, in completion order - the King itself,
   * which the screen shows in that sequence's "foundation" slot (see resolveCompletedSequence). */
  completed: Card[];
  /** One entry per completed run, same order/index as `completed` - the full 13-card run (King
   * first, Ace last), captured before resolveCompletedSequence's splice discards everything but
   * the King. Never read by any game rule, only by the win-cascade animation (see
   * components/winning/), which needs the whole run to chain through, not just its King. */
  completedRuns: Card[][];
}

const NUM_COLUMNS = 10;
const DEAL_COUNTS = [6, 6, 6, 6, 5, 5, 5, 5, 5, 5]; // 4 columns of 6, 6 columns of 5 = 54 cards

function cloneState(state: SpiderState): SpiderState {
  return {
    tableau: state.tableau.map((col) => col.map((c) => ({ ...c }))),
    stock: state.stock.map((c) => ({ ...c })),
    completed: state.completed.map((c) => ({ ...c })),
    completedRuns: state.completedRuns.map((run) => run.map((c) => ({ ...c }))),
  };
}

/** Check the top run of a column for a completed King->Ace same-suit sequence; if found, remove
 * it and return its King (the card the screen displays in that sequence's "foundation" slot)
 * along with the full run, King first through Ace last. */
function resolveCompletedSequence(tableau: Card[][], colIndex: number): { king: Card; run: Card[] } | null {
  const col = tableau[colIndex];
  if (col.length < 13) return null;
  const topRun = col.slice(col.length - 13);
  // topRun is in dealt order (index 0 = deepest of the run); King should be at index 0 (rank 13), Ace at end (rank 1).
  if (topRun[0].rank !== 13) return null;
  if (!topRun.every((c) => c.faceUp)) return null;
  if (!isDescendingSameSuit(topRun)) return null;
  // It's a complete run - remove it.
  tableau[colIndex] = col.slice(0, col.length - 13);
  const newTop = tableau[colIndex][tableau[colIndex].length - 1];
  if (newTop) newTop.faceUp = true;
  return { king: topRun[0], run: topRun };
}

function computeLegalMoves(state: SpiderState): Move[] {
  const moves: Move[] = [];
  for (let from = 0; from < NUM_COLUMNS; from++) {
    const col = state.tableau[from];
    if (col.length === 0) continue;
    // Find the longest valid same-suit descending run starting from the top.
    let runLen = 1;
    for (let i = col.length - 1; i > 0; i--) {
      const cur = col[i];
      const prev = col[i - 1];
      if (!cur.faceUp || !prev.faceUp) break;
      if (prev.rank !== cur.rank + 1 || prev.suit !== cur.suit) break;
      runLen++;
    }
    for (let count = 1; count <= runLen; count++) {
      const group = col.slice(col.length - count);
      if (!isDescendingSameSuit(group)) continue;
      const movingBottom = group[0]; // deepest (highest-rank) card of the run - lands directly on dest's top
      for (let to = 0; to < NUM_COLUMNS; to++) {
        if (to === from) continue;
        const destCol = state.tableau[to];
        if (destCol.length === 0) {
          moves.push({ from: { zone: 'tableau', index: from }, to: { zone: 'tableau', index: to }, count });
        } else {
          const destTop = destCol[destCol.length - 1];
          if (destTop.faceUp && destTop.rank === movingBottom.rank + 1) {
            moves.push({ from: { zone: 'tableau', index: from }, to: { zone: 'tableau', index: to }, count });
          }
        }
      }
    }
  }
  return moves;
}

export function createSpiderController(numSuits: 1 | 2 | 4): GameController<SpiderState> {
  return {
    id: 'spider',
    title: 'Spider',

    newGame(seed: number): SpiderState {
      const numDecks = 8 / numSuits;
      const suitFilter = SUITS.slice(0, numSuits);
      const deck = shuffledDeck(seed, numDecks, suitFilter);

      const tableau: Card[][] = Array.from({ length: NUM_COLUMNS }, () => []);
      let cursor = 0;
      for (let col = 0; col < NUM_COLUMNS; col++) {
        const count = DEAL_COUNTS[col];
        for (let i = 0; i < count; i++) {
          const card = deck[cursor++];
          card.faceUp = i === count - 1;
          tableau[col].push(card);
        }
      }
      const stock = deck.slice(cursor).map((c) => ({ ...c, faceUp: false }));

      return { tableau, stock, completed: [], completedRuns: [] };
    },

    legalMoves(state: SpiderState): Move[] {
      return computeLegalMoves(state);
    },

    tryMove(state: SpiderState, move: Move): SpiderState | null {
      const { from, to, count } = move;
      if (from.zone !== 'tableau' || to.zone !== 'tableau') return null;
      if (from.index === to.index) return null;
      const fromCol = state.tableau[from.index];
      const toCol = state.tableau[to.index];
      if (!fromCol || !toCol) return null;
      if (count < 1 || count > fromCol.length) return null;

      const group = fromCol.slice(fromCol.length - count);
      if (!group.every((c) => c.faceUp)) return null;
      if (!isDescendingSameSuit(group)) return null;

      const movingBottom = group[0]; // deepest (highest-rank) card of the run - lands directly on dest's top
      if (toCol.length > 0) {
        const destTop = toCol[toCol.length - 1];
        if (!destTop.faceUp || destTop.rank !== movingBottom.rank + 1) return null;
      }

      const next = cloneState(state);
      const nextFrom = next.tableau[from.index];
      const nextTo = next.tableau[to.index];
      const moved = nextFrom.splice(nextFrom.length - count, count);
      nextTo.push(...moved);

      const newTop = nextFrom[nextFrom.length - 1];
      if (newTop) newTop.faceUp = true;

      const completedSequence = resolveCompletedSequence(next.tableau, to.index);
      if (completedSequence) {
        next.completed.push(completedSequence.king);
        next.completedRuns.push(completedSequence.run);
      }

      return next;
    },

    drawStock(state: SpiderState): SpiderState | null {
      if (state.stock.length < NUM_COLUMNS) return null;
      if (state.tableau.some((col) => col.length === 0)) return null;

      const next = cloneState(state);
      for (let col = 0; col < NUM_COLUMNS; col++) {
        const card = next.stock.shift()!;
        card.faceUp = true;
        next.tableau[col].push(card);
      }
      for (let col = 0; col < NUM_COLUMNS; col++) {
        const completedSequence = resolveCompletedSequence(next.tableau, col);
        if (completedSequence) {
          next.completed.push(completedSequence.king);
          next.completedRuns.push(completedSequence.run);
        }
      }
      return next;
    },

    isWon(state: SpiderState): boolean {
      return state.completed.length === 8;
    },

    isStuck(state: SpiderState): boolean {
      const canDraw = state.stock.length >= NUM_COLUMNS && !state.tableau.some((col) => col.length === 0);
      if (canDraw) return false;
      return computeLegalMoves(state).length === 0;
    },

    autoMoveHint(state: SpiderState, from: PileRef, cardId: string): Move | null {
      if (from.zone !== 'tableau') return null;
      const col = state.tableau[from.index];
      if (!col) return null;
      const cardIndex = col.findIndex((c) => c.id === cardId);
      if (cardIndex === -1) return null;
      const movingCards = col.slice(cardIndex);
      if (movingCards.some((c) => !c.faceUp)) return null;
      if (!isDescendingSameSuit(movingCards)) return null;
      const movingBottom = movingCards[0]; // deepest card of the run - lands directly on dest's top
      const count = movingCards.length;

      const candidates = state.tableau
        .map((destCol, index) => ({ index, pile: destCol }))
        .filter((c) => c.index !== from.index)
        .filter((c) => {
          const destTop = top(c.pile);
          return destTop === undefined || (destTop.faceUp && destTop.rank === movingBottom.rank + 1);
        });
      const best = pickBestTableauTarget(candidates, isDescendingSameSuit);
      if (!best) return null;
      return { from, to: { zone: 'tableau', index: best.index }, count };
    },
  };
}
