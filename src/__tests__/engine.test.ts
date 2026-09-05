import { makeDeck, shuffledDeck } from '@/engine/deck';
import { mulberry32, shuffle } from '@/engine/rng';
import { isDescendingAltColor, isDescendingSameSuit } from '@/engine/pile';
import { computeScore } from '@/engine/score';
import { Card } from '@/engine/types';

describe('deck', () => {
  it('makes a standard 52 card deck, all face down', () => {
    const deck = makeDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map((c) => c.id)).size).toBe(52);
    expect(deck.every((c) => !c.faceUp)).toBe(true);
  });

  it('shuffledDeck is deterministic for a given seed', () => {
    const a = shuffledDeck(42);
    const b = shuffledDeck(42);
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
  });

  it('shuffledDeck differs across seeds (almost always)', () => {
    const a = shuffledDeck(1);
    const b = shuffledDeck(2);
    expect(a.map((c) => c.id)).not.toEqual(b.map((c) => c.id));
  });

  it('supports multiple decks for games like Spider', () => {
    const twoDeck = shuffledDeck(7, 2);
    expect(twoDeck).toHaveLength(104);
  });

  it('supports a suit filter for 1/2-suit Spider variants', () => {
    const spadesOnly = shuffledDeck(7, 2, ['spades']);
    expect(spadesOnly).toHaveLength(26);
    expect(spadesOnly.every((c) => c.suit === 'spades')).toBe(true);
  });
});

describe('rng', () => {
  it('mulberry32 produces the same sequence for the same seed', () => {
    const seq1 = Array.from({ length: 5 }, mulberry32(123));
    const seq2 = Array.from({ length: 5 }, mulberry32(123));
    expect(seq1).toEqual(seq2);
  });

  it('shuffle does not mutate the input array', () => {
    const input = [1, 2, 3, 4, 5];
    const copy = [...input];
    shuffle(input, mulberry32(1));
    expect(input).toEqual(copy);
  });
});

function card(suit: Card['suit'], rank: Card['rank']): Card {
  return { id: `${suit}-${rank}-0`, suit, rank, faceUp: true };
}

describe('pile helpers', () => {
  it('recognizes a valid descending alternating-color run', () => {
    const run = [card('clubs', 8), card('hearts', 7), card('spades', 6)];
    expect(isDescendingAltColor(run)).toBe(true);
  });

  it('rejects a same-color run for alt-color check', () => {
    const run = [card('clubs', 8), card('spades', 7)];
    expect(isDescendingAltColor(run)).toBe(false);
  });

  it('recognizes a valid descending same-suit run', () => {
    const run = [card('hearts', 10), card('hearts', 9), card('hearts', 8)];
    expect(isDescendingSameSuit(run)).toBe(true);
  });

  it('rejects a mixed-suit run for same-suit check', () => {
    const run = [card('hearts', 10), card('diamonds', 9)];
    expect(isDescendingSameSuit(run)).toBe(false);
  });
});

describe('computeScore', () => {
  it('adds moves and elapsed seconds, equally weighted', () => {
    expect(computeScore(80, 120)).toBe(200);
  });

  it('is lower for a faster, more efficient win', () => {
    const efficient = computeScore(40, 60);
    const sloppy = computeScore(100, 300);
    expect(efficient).toBeLessThan(sloppy);
  });
});
