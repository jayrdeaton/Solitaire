// FreeCell solitaire game rules & controller.

import { Card, SUITS, cardColor } from '@/engine/types';
import { shuffledDeck } from '@/engine/deck';
import { isDescendingAltColor, top } from '@/engine/pile';
import { pickBestTableauTarget } from '@/engine/autoMove';
import { AccessibleCard, GameController, Move, PileRef } from '@/engine/gameTypes';

export interface FreeCellState {
  /** 8 tableau columns, all cards always face-up. */
  tableau: Card[][];
  /** 4 freecells, each holds 0 or 1 card. */
  freecells: (Card | null)[];
  /** 4 foundation piles, indexed to match engine/types SUITS order (clubs, diamonds, hearts, spades). */
  foundation: Card[][];
}

const NUM_TABLEAU = 8;
const NUM_FREECELLS = 4;
const NUM_FOUNDATIONS = 4;

function cloneState(state: FreeCellState): FreeCellState {
  return {
    tableau: state.tableau.map((col) => col.slice()),
    freecells: state.freecells.slice(),
    foundation: state.foundation.map((f) => f.slice()),
  };
}

function suitIndex(suit: Card['suit']): number {
  return SUITS.indexOf(suit);
}

function canPlaceOnFoundation(dest: Card[], moving: Card): boolean {
  const destTop = top(dest);
  if (destTop === undefined) return moving.rank === 1;
  return destTop.suit === moving.suit && moving.rank === destTop.rank + 1;
}

/** A single card (the top of the moving group) landing on a tableau column. */
function canPlaceOnTableau(dest: Card[], movingTop: Card): boolean {
  const destTop = top(dest);
  if (destTop === undefined) return true; // any card, or the head of a valid run, may start an empty column
  return movingTop.rank === destTop.rank - 1 && cardColor(movingTop.suit) !== cardColor(destTop.suit);
}

function countEmptyFreecells(state: FreeCellState): number {
  return state.freecells.filter((c) => c === null).length;
}

/** Count empty tableau columns, excluding `excludeIndex` (the move's own destination doesn't help). */
function countEmptyTableauColumns(state: FreeCellState, excludeIndex: number): number {
  return state.tableau.filter((col, i) => i !== excludeIndex && col.length === 0).length;
}

/** Max cards movable together in one tableau->tableau move (the "supermove" convention). */
function maxSupermoveCount(state: FreeCellState, destIndex: number): number {
  const emptyFreecells = countEmptyFreecells(state);
  const emptyCols = countEmptyTableauColumns(state, destIndex);
  return (emptyFreecells + 1) * 2 ** emptyCols;
}

function newGame(seed: number): FreeCellState {
  const deck = shuffledDeck(seed, 1).map((c) => ({ ...c, faceUp: true }));
  const tableau: Card[][] = [];
  let cursor = 0;
  for (let col = 0; col < NUM_TABLEAU; col++) {
    const count = col < 4 ? 7 : 6;
    tableau.push(deck.slice(cursor, cursor + count));
    cursor += count;
  }
  const freecells: (Card | null)[] = [null, null, null, null];
  const foundation: Card[][] = [[], [], [], []];
  return { tableau, freecells, foundation };
}

function tryMove(state: FreeCellState, move: Move): FreeCellState | null {
  const { from, to, count } = move;
  if (count < 1) return null;
  if (from.zone === to.zone && from.index === to.index) return null;
  if (from.zone === 'foundation') return null; // cards never move back out of foundation

  let movingCards: Card[];
  if (from.zone === 'tableau') {
    const col = state.tableau[from.index];
    if (!col || col.length < count) return null;
    movingCards = col.slice(col.length - count);
  } else if (from.zone === 'freecell') {
    if (count !== 1) return null;
    const card = state.freecells[from.index];
    if (!card) return null;
    movingCards = [card];
  } else {
    return null;
  }

  // Only tableau->tableau moves may carry more than one card.
  if (count > 1 && (from.zone !== 'tableau' || to.zone !== 'tableau')) return null;
  if (count > 1 && !isDescendingAltColor(movingCards)) return null;

  if (to.zone === 'tableau') {
    const destCol = state.tableau[to.index];
    if (!destCol) return null;
    if (count > 1 && count > maxSupermoveCount(state, to.index)) return null;
    if (!canPlaceOnTableau(destCol, movingCards[0])) return null;
  } else if (to.zone === 'foundation') {
    if (count !== 1) return null;
    const destPile = state.foundation[to.index];
    if (!destPile) return null;
    const movingCard = movingCards[0];
    if (suitIndex(movingCard.suit) !== to.index) return null;
    if (!canPlaceOnFoundation(destPile, movingCard)) return null;
  } else if (to.zone === 'freecell') {
    if (count !== 1) return null;
    if (to.index < 0 || to.index >= NUM_FREECELLS) return null;
    if (state.freecells[to.index] !== null) return null;
  } else {
    return null;
  }

  const next = cloneState(state);

  if (from.zone === 'tableau') {
    next.tableau[from.index] = next.tableau[from.index].slice(0, next.tableau[from.index].length - count);
  } else if (from.zone === 'freecell') {
    next.freecells[from.index] = null;
  }

  if (to.zone === 'tableau') {
    next.tableau[to.index] = next.tableau[to.index].concat(movingCards);
  } else if (to.zone === 'foundation') {
    next.foundation[to.index] = next.foundation[to.index].concat(movingCards);
  } else if (to.zone === 'freecell') {
    next.freecells[to.index] = movingCards[0];
  }

  return next;
}

function isWon(state: FreeCellState): boolean {
  return state.foundation.every((pile) => {
    const t = top(pile);
    return t !== undefined && t.rank === 13;
  });
}

function legalMoves(state: FreeCellState): Move[] {
  const moves: Move[] = [];

  const tryAdd = (from: PileRef, to: PileRef, count: number) => {
    const result = tryMove(state, { from, to, count });
    if (result) moves.push({ from, to, count });
  };

  // Freecell -> foundation / tableau
  for (let fc = 0; fc < NUM_FREECELLS; fc++) {
    if (state.freecells[fc] === null) continue;
    const from: PileRef = { zone: 'freecell', index: fc };
    for (let f = 0; f < NUM_FOUNDATIONS; f++) tryAdd(from, { zone: 'foundation', index: f }, 1);
    for (let t = 0; t < NUM_TABLEAU; t++) tryAdd(from, { zone: 'tableau', index: t }, 1);
  }

  // Tableau -> foundation / freecell / tableau (single card and valid runs)
  for (let col = 0; col < NUM_TABLEAU; col++) {
    const pile = state.tableau[col];
    if (pile.length === 0) continue;
    const from: PileRef = { zone: 'tableau', index: col };

    for (let f = 0; f < NUM_FOUNDATIONS; f++) tryAdd(from, { zone: 'foundation', index: f }, 1);
    for (let fc = 0; fc < NUM_FREECELLS; fc++) tryAdd(from, { zone: 'freecell', index: fc }, 1);

    // Find the longest alternating-color run at the top of the column.
    let runStart = pile.length - 1;
    while (runStart > 0 && isDescendingAltColor(pile.slice(runStart - 1))) {
      runStart -= 1;
    }
    const maxRun = pile.length - runStart;
    for (let count = 1; count <= maxRun; count++) {
      for (let t = 0; t < NUM_TABLEAU; t++) {
        if (t === col) continue;
        tryAdd(from, { zone: 'tableau', index: t }, count);
      }
    }
  }

  return moves;
}

/**
 * Foundation first, then the best tableau destination (shared logic with the other games), and
 * finally - FreeCell-only - an empty freecell as the last resort, so tapping a card that has
 * nowhere better to go still does something instead of sitting inert. Skipped when the card is
 * already sitting in a freecell: shuffling it into a different empty cell makes no progress, and
 * legalMoves() doesn't offer freecell->freecell moves either.
 */
function autoMoveHint(state: FreeCellState, from: PileRef, cardId: string): Move | null {
  let movingCards: Card[];
  if (from.zone === 'tableau') {
    const col = state.tableau[from.index];
    if (!col) return null;
    const cardIndex = col.findIndex((c) => c.id === cardId);
    if (cardIndex === -1) return null;
    movingCards = col.slice(cardIndex);
    if (movingCards.length > 1 && !isDescendingAltColor(movingCards)) return null;
  } else if (from.zone === 'freecell') {
    const c = state.freecells[from.index];
    if (!c || c.id !== cardId) return null;
    movingCards = [c];
  } else {
    return null;
  }

  const count = movingCards.length;
  const movingTop = movingCards[0];

  if (count === 1) {
    const f = suitIndex(movingTop.suit);
    if (canPlaceOnFoundation(state.foundation[f], movingTop)) {
      return { from, to: { zone: 'foundation', index: f }, count: 1 };
    }
  }

  const candidates = state.tableau
    .map((destPile, index) => ({ index, pile: destPile }))
    .filter((c) => !(from.zone === 'tableau' && from.index === c.index))
    .filter((c) => canPlaceOnTableau(c.pile, movingTop))
    .filter((c) => count === 1 || count <= maxSupermoveCount(state, c.index));
  const best = pickBestTableauTarget(candidates, isDescendingAltColor);
  if (best) return { from, to: { zone: 'tableau', index: best.index }, count };

  if (count === 1 && from.zone !== 'freecell') {
    const emptyFreecell = state.freecells.findIndex((c) => c === null);
    if (emptyFreecell !== -1) {
      return { from, to: { zone: 'freecell', index: emptyFreecell }, count: 1 };
    }
  }

  return null;
}

/** Every card currently reachable - every freecell's contents plus each tableau column's top card
 * (FreeCell has no stock/waste) - for the auto-play-to-foundation feature (see
 * engine/autoFoundation.ts). */
function accessibleCards(state: FreeCellState): AccessibleCard[] {
  const result: AccessibleCard[] = [];
  state.freecells.forEach((card, index) => {
    if (card) result.push({ ref: { zone: 'freecell', index }, card });
  });
  state.tableau.forEach((pile, index) => {
    const t = top(pile);
    if (t) result.push({ ref: { zone: 'tableau', index }, card: t });
  });
  return result;
}

export const FreeCellController: GameController<FreeCellState> = {
  id: 'freecell',
  title: 'FreeCell',
  newGame,
  legalMoves,
  tryMove,
  isWon,
  autoMoveHint,
  accessibleCards,
};
