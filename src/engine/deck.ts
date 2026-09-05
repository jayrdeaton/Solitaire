import { Card, Rank, SUITS } from './types';
import { mulberry32, shuffle } from './rng';

/** One standard 52-card deck, all face down. `deckIndex` keeps ids unique across multi-deck games. */
export function makeDeck(deckIndex = 0): Card[] {
  const cards: Card[] = [];
  for (const suit of SUITS) {
    for (let rank = 1; rank <= 13; rank++) {
      cards.push({ id: `${suit}-${rank}-${deckIndex}`, suit, rank: rank as Rank, faceUp: false });
    }
  }
  return cards;
}

/**
 * A shuffled deck for a given game `seed`, using `numDecks` standard decks
 * (Spider uses 2). Pass `suitFilter` to restrict to a subset of suits, then
 * the result is duplicated up to `numDecks` copies of that filtered set
 * (used by 1-suit / 2-suit Spider).
 */
export function shuffledDeck(seed: number, numDecks = 1, suitFilter?: Card['suit'][]): Card[] {
  let all: Card[] = [];
  for (let d = 0; d < numDecks; d++) {
    const deck = makeDeck(d);
    all = all.concat(suitFilter ? deck.filter((c) => suitFilter.includes(c.suit)) : deck);
  }
  const rng = mulberry32(seed);
  return shuffle(all, rng);
}
