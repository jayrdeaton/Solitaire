// Core card primitives shared by every game variant.

export type Suit = 'clubs' | 'diamonds' | 'hearts' | 'spades';

// 1 = Ace, 11 = Jack, 12 = Queen, 13 = King
export type Rank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;

export type Color = 'red' | 'black';

export interface Card {
  /** Stable unique id, e.g. "hearts-7-0" (deckIndex suffix supports multi-deck games). */
  id: string;
  suit: Suit;
  rank: Rank;
  faceUp: boolean;
}

export const SUITS: Suit[] = ['clubs', 'diamonds', 'hearts', 'spades'];

export const SUIT_SYMBOLS: Record<Suit, string> = {
  clubs: '♣',
  diamonds: '♦',
  hearts: '♥',
  spades: '♠',
};

export function cardColor(suit: Suit): Color {
  return suit === 'hearts' || suit === 'diamonds' ? 'red' : 'black';
}

export function rankLabel(rank: Rank): string {
  switch (rank) {
    case 1:
      return 'A';
    case 11:
      return 'J';
    case 12:
      return 'Q';
    case 13:
      return 'K';
    default:
      return String(rank);
  }
}

export function cloneCard(card: Card): Card {
  return { ...card };
}
