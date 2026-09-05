// Pyramid solitaire game rules & controller.
//
// Board: 28 cards dealt face-up into a 7-row triangle (row 0 has 1 card,
// row 6 has 7), stored as a flat 28-length array. The card at (row, col)
// lives at flatIndex(row, col) = row*(row+1)/2 + col. Once removed, a slot
// is set to `null` (never spliced out) so the covering/exposure math below
// keeps working off stable indices.
//
// The remaining 24 cards are a face-down stock; draw-1 flips cards onto a
// face-up waste pile, exactly like Klondike's draw-1 mode.

import { Card } from '@/engine/types';
import { shuffledDeck } from '@/engine/deck';
import { top } from '@/engine/pile';
import { GameController, Move, PileRef } from '@/engine/gameTypes';

export interface PyramidState {
  /** Flat 28-slot triangle; `null` once that card has been removed. */
  pyramid: (Card | null)[];
  stock: Card[];
  waste: Card[];
  /** Every card ever removed via a pair or solo King, oldest first (array end = top, same
   * convention as stock/waste). Always face-up once here, regardless of its prior faceUp. Once the
   * pyramid is cleared, sweepRemainderOnWin also appends whatever was left in waste/stock, so a
   * won game's discard always holds all 52 cards. */
  discard: Card[];
  /** How many cards have been consumed via a pair or solo King, from either the pyramid or the
   * waste (NOT specifically pyramid cards - see isWon, which checks the triangle directly rather
   * than this counter, since a card can be consumed from waste too). Kept purely as a move-size
   * stat; nothing reads it to determine whether the game is won. */
  removedCount: number;
}

const ROWS = 7;
const TOTAL = 28; // 1+2+3+4+5+6+7

/** Flat array index for the card at (row, col), 0-indexed, col from 0..row. */
export function flatIndex(row: number, col: number): number {
  return (row * (row + 1)) / 2 + col;
}

/** Inverse of flatIndex: which (row, col) a flat index corresponds to. */
export function rowColOf(index: number): { row: number; col: number } {
  let row = 0;
  while (flatIndex(row + 1, 0) <= index) row++;
  return { row, col: index - flatIndex(row, 0) };
}

/**
 * A pyramid card at (row, col) is exposed (removable) once the (up to) two
 * cards resting on it in the row below have both already been removed.
 * Row 6 (the bottom row) is always exposed if occupied.
 */
export function isExposed(pyramid: (Card | null)[], row: number, col: number): boolean {
  const idx = flatIndex(row, col);
  if (!pyramid[idx]) return false;
  if (row === ROWS - 1) return true;
  const childLeft = flatIndex(row + 1, col);
  const childRight = flatIndex(row + 1, col + 1);
  return !pyramid[childLeft] && !pyramid[childRight];
}

function isExposedAt(pyramid: (Card | null)[], index: number): boolean {
  const { row, col } = rowColOf(index);
  return isExposed(pyramid, row, col);
}

function cloneCard(c: Card): Card {
  return { ...c };
}

function cloneState(state: PyramidState): PyramidState {
  return {
    pyramid: state.pyramid.map((c) => (c ? cloneCard(c) : null)),
    stock: state.stock.map(cloneCard),
    waste: state.waste.map(cloneCard),
    discard: state.discard.map(cloneCard),
    removedCount: state.removedCount,
  };
}

function newGame(seed: number): PyramidState {
  const deck = shuffledDeck(seed, 1);
  const pyramid: (Card | null)[] = deck.slice(0, TOTAL).map((c) => ({ ...c, faceUp: true }));
  const stock: Card[] = deck.slice(TOTAL).map((c) => ({ ...c, faceUp: false }));
  return { pyramid, stock, waste: [], discard: [], removedCount: 0 };
}

export function cardAt(state: PyramidState, ref: PileRef): Card | null {
  if (ref.zone === 'pyramid') {
    return state.pyramid[ref.index] ?? null;
  }
  if (ref.zone === 'waste') {
    return top(state.waste) ?? null;
  }
  return null;
}

/** True if `ref` currently points at a removable ("available") card: an
 * exposed pyramid card, or the top card of the waste pile. */
function isAvailable(state: PyramidState, ref: PileRef): boolean {
  if (ref.zone === 'waste') {
    return top(state.waste) !== undefined;
  }
  if (ref.zone === 'pyramid') {
    const card = state.pyramid[ref.index];
    if (!card) return false;
    return isExposedAt(state.pyramid, ref.index);
  }
  return false;
}

function consume(state: PyramidState, ref: PileRef): void {
  const card = cardAt(state, ref);
  if (ref.zone === 'pyramid') {
    state.pyramid[ref.index] = null;
  } else if (ref.zone === 'waste') {
    state.waste.pop();
  }
  if (card) {
    state.discard.push({ ...card, faceUp: true });
  }
}

/** Once the triangle itself is empty the game is won (see isWon) - sweeps every card still
 * sitting in waste/stock into discard so the win-cascade animation (see components/winning/) has
 * the full 52-card deck to chain through, not just whatever subset was ever exposed in the
 * pyramid. Order (waste-then-stock) doesn't matter gameplay-wise, only the animation's own
 * reverse-order read of `discard` at win time. No-op unless this exact move just emptied the last
 * pyramid slot. Does not touch removedCount - that still only reflects real pairing/King moves. */
function sweepRemainderOnWin(state: PyramidState): void {
  if (!state.pyramid.every((c) => c === null)) return;
  for (const c of state.waste) state.discard.push({ ...c, faceUp: true });
  for (const c of state.stock) state.discard.push({ ...c, faceUp: true });
  state.waste = [];
  state.stock = [];
}

/**
 * Two move shapes are supported:
 *  - solo King: from === to, both {zone:'pyramid', index:i}, count 1.
 *  - pair summing to 13: from/to are two distinct available cards, each
 *    either {zone:'pyramid', index} or {zone:'waste', index:0}, count 1.
 */
function tryMove(state: PyramidState, move: Move): PyramidState | null {
  const { from, to, count } = move;
  if (count !== 1) return null;
  if (from.zone !== 'pyramid' && from.zone !== 'waste') return null;
  if (to.zone !== 'pyramid' && to.zone !== 'waste') return null;

  // Solo King case: `from` and `to` both point at the same available card (pyramid or waste -
  // both zones are already validated above), and it removes on its own since nothing sums to 13
  // with a King.
  if (from.zone === to.zone && from.index === to.index) {
    if (!isAvailable(state, from)) return null;
    const card = cardAt(state, from);
    if (!card || card.rank !== 13) return null;
    const next = cloneState(state);
    consume(next, from);
    next.removedCount += 1;
    sweepRemainderOnWin(next);
    return next;
  }

  if (!isAvailable(state, from) || !isAvailable(state, to)) return null;

  const fromCard = cardAt(state, from);
  const toCard = cardAt(state, to);
  if (!fromCard || !toCard) return null;
  if (fromCard.id === toCard.id) return null; // same physical card, can't pair with itself
  if (fromCard.rank + toCard.rank !== 13) return null;

  const next = cloneState(state);
  consume(next, from);
  consume(next, to);
  next.removedCount += 2;
  sweepRemainderOnWin(next);
  return next;
}

function drawStock(state: PyramidState): PyramidState | null {
  if (state.stock.length > 0) {
    const next = cloneState(state);
    const card = next.stock.pop()!;
    card.faceUp = true;
    next.waste.push(card);
    return next;
  }
  if (state.waste.length > 0) {
    // Unlimited recycling: once stock is empty, flip waste back over face-down
    // (reversed, so re-drawing reproduces the same sequence). Real physical
    // Pyramid often limits redeals, but that can permanently strand a digital
    // game with no way to clear the pyramid, so we allow infinite recycling.
    const next = cloneState(state);
    const recycled = next.waste
      .slice()
      .reverse()
      .map((c) => ({ ...c, faceUp: false }));
    next.stock = recycled;
    next.waste = [];
    return next;
  }
  return null;
}

function isWon(state: PyramidState): boolean {
  return state.pyramid.every((c) => c === null);
}

function legalMoves(state: PyramidState): Move[] {
  const moves: Move[] = [];
  const availableRefs: PileRef[] = [];

  for (let i = 0; i < TOTAL; i++) {
    if (state.pyramid[i] && isExposedAt(state.pyramid, i)) {
      availableRefs.push({ zone: 'pyramid', index: i });
    }
  }
  if (top(state.waste)) {
    availableRefs.push({ zone: 'waste', index: 0 });
  }

  // Solo kings - available in either zone, since nothing sums to 13 with a King.
  for (const ref of availableRefs) {
    const card = cardAt(state, ref);
    if (card && card.rank === 13) {
      moves.push({ from: ref, to: ref, count: 1 });
    }
  }

  // Pairs summing to 13.
  for (let a = 0; a < availableRefs.length; a++) {
    for (let b = a + 1; b < availableRefs.length; b++) {
      const refA = availableRefs[a];
      const refB = availableRefs[b];
      const cardA = cardAt(state, refA);
      const cardB = cardAt(state, refB);
      if (cardA && cardB && cardA.rank + cardB.rank === 13) {
        moves.push({ from: refA, to: refB, count: 1 });
      }
    }
  }

  return moves;
}

export const PyramidController: GameController<PyramidState> = {
  id: 'pyramid',
  title: 'Pyramid',
  newGame,
  legalMoves,
  tryMove,
  drawStock,
  isWon,
};
