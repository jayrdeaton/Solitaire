import { makeDeck, shuffledDeck } from '@/engine/deck'
import { isDescendingAltColor, isDescendingSameSuit, runCountFrom } from '@/engine/pile'
import { mulberry32, shuffle } from '@/engine/rng'
import { computeScore } from '@/engine/score'
import { Card } from '@/engine/types'

describe('deck', () => {
  it('makes a standard 52 card deck, all face down', () => {
    const deck = makeDeck()
    expect(deck).toHaveLength(52)
    expect(new Set(deck.map((c) => c.id)).size).toBe(52)
    expect(deck.every((c) => !c.faceUp)).toBe(true)
  })

  it('shuffledDeck is deterministic for a given seed', () => {
    const a = shuffledDeck(42)
    const b = shuffledDeck(42)
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id))
  })

  it('shuffledDeck differs across seeds (almost always)', () => {
    const a = shuffledDeck(1)
    const b = shuffledDeck(2)
    expect(a.map((c) => c.id)).not.toEqual(b.map((c) => c.id))
  })

  it('supports multiple decks for games like Spider', () => {
    const twoDeck = shuffledDeck(7, 2)
    expect(twoDeck).toHaveLength(104)
  })

  it('supports a suit filter for 1/2-suit Spider variants', () => {
    const spadesOnly = shuffledDeck(7, 2, ['spades'])
    expect(spadesOnly).toHaveLength(26)
    expect(spadesOnly.every((c) => c.suit === 'spades')).toBe(true)
  })
})

describe('rng', () => {
  it('mulberry32 produces the same sequence for the same seed', () => {
    const seq1 = Array.from({ length: 5 }, mulberry32(123))
    const seq2 = Array.from({ length: 5 }, mulberry32(123))
    expect(seq1).toEqual(seq2)
  })

  it('shuffle does not mutate the input array', () => {
    const input = [1, 2, 3, 4, 5]
    const copy = [...input]
    shuffle(input, mulberry32(1))
    expect(input).toEqual(copy)
  })
})

function card(suit: Card['suit'], rank: Card['rank']): Card {
  return { id: `${suit}-${rank}-0`, suit, rank, faceUp: true }
}

describe('pile helpers', () => {
  it('recognizes a valid descending alternating-color run', () => {
    const run = [card('clubs', 8), card('hearts', 7), card('spades', 6)]
    expect(isDescendingAltColor(run)).toBe(true)
  })

  it('rejects a same-color run for alt-color check', () => {
    const run = [card('clubs', 8), card('spades', 7)]
    expect(isDescendingAltColor(run)).toBe(false)
  })

  it('recognizes a valid descending same-suit run', () => {
    const run = [card('hearts', 10), card('hearts', 9), card('hearts', 8)]
    expect(isDescendingSameSuit(run)).toBe(true)
  })

  it('rejects a mixed-suit run for same-suit check', () => {
    const run = [card('hearts', 10), card('diamonds', 9)]
    expect(isDescendingSameSuit(run)).toBe(false)
  })

  describe('runCountFrom', () => {
    it('returns the run length for a single face-up card', () => {
      const pile = [card('clubs', 8), card('hearts', 7)]
      expect(runCountFrom(pile, 0, isDescendingAltColor)).toBe(1)
    })

    it('returns the run length for a valid multi-card run', () => {
      const pile = [card('clubs', 8), card('hearts', 7), card('spades', 6)]
      expect(runCountFrom(pile, 1, isDescendingAltColor)).toBe(2)
    })

    it('returns 0 when the requested depth is not a valid run', () => {
      const pile = [card('clubs', 8), card('spades', 7)] // same color, not alternating
      expect(runCountFrom(pile, 1, isDescendingAltColor)).toBe(0)
    })

    it('returns 0 when the run dips into a face-down card, even if it would otherwise be valid', () => {
      // A 2-card alt-color run (black 8, red 7) that isn't draggable because the deeper card
      // (the 8) is still face-down - the exact case that made a naive Klondike/FreeCell merge
      // unsafe (FreeCell's tableau is always face-up, so it never needed this guard itself).
      const pile = [{ ...card('clubs', 8), faceUp: false }, card('hearts', 7)]
      expect(runCountFrom(pile, 1, isDescendingAltColor)).toBe(0)
    })

    it('does not require isValidRun to hold for a single face-up card', () => {
      // count === 1 skips the isValidRun check entirely - isDescendingSameSuit would trivially
      // pass on a 1-element array anyway, but this pins down that runCountFrom itself never calls
      // isValidRun for a lone card.
      const pile = [card('hearts', 5)]
      expect(runCountFrom(pile, 0, isDescendingSameSuit)).toBe(1)
    })
  })
})

describe('computeScore', () => {
  it('adds moves and elapsed seconds, equally weighted', () => {
    expect(computeScore(80, 120)).toBe(200)
  })

  it('is lower for a faster, more efficient win', () => {
    const efficient = computeScore(40, 60)
    const sloppy = computeScore(100, 300)
    expect(efficient).toBeLessThan(sloppy)
  })
})
