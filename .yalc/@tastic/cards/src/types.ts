// Core card primitives shared by every game variant.

export type Suit = 'clubs' | 'diamonds' | 'hearts' | 'spades'

// 1 = Ace, 11 = Jack, 12 = Queen, 13 = King
export type Rank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13

export type Color = 'red' | 'black'

export interface Card {
  /** Stable unique id, e.g. "hearts-7-0" (deckIndex suffix supports multi-deck games). */
  id: string
  suit: Suit
  rank: Rank
  faceUp: boolean
}

export const SUITS: Suit[] = ['clubs', 'diamonds', 'hearts', 'spades']

export const SUIT_SYMBOLS: Record<Suit, string> = {
  clubs: '♣',
  diamonds: '♦',
  hearts: '♥',
  spades: '♠'
}

export function cardColor(suit: Suit): Color {
  return suit === 'hearts' || suit === 'diamonds' ? 'red' : 'black'
}

export function rankLabel(rank: Rank): string {
  switch (rank) {
    case 1:
      return 'A'
    case 11:
      return 'J'
    case 12:
      return 'Q'
    case 13:
      return 'K'
    default:
      return String(rank)
  }
}

/** A joker: not part of the standard 52-card vocabulary above (no suit/rank match, `Card`'s own
 * `suit`/`rank` stay exactly as Solitaire defines them - unwidened), but a real card some games
 * deal with anyway. `rank: null` rather than omitting the field - AnyCard consumers that switch on
 * shape can check `card.rank === null` as well as `isJoker(card)`. */
export interface Joker {
  id: string
  suit: 'joker'
  rank: null
  faceUp: boolean
}

export type AnyCard = Card | Joker

export function isJoker(card: AnyCard): card is Joker {
  return card.suit === 'joker'
}

export function cloneCard<T extends Card | Joker>(card: T): T {
  return { ...card }
}
