import { makeDeck, shuffledDeck } from '@/engine/deck'
import { Move } from '@/engine/gameTypes'
import { findHint, hintCountFor } from '@/engine/hint'
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

describe('findHint', () => {
  const tableauMove: Move = { from: { zone: 'tableau', index: 0 }, to: { zone: 'tableau', index: 1 }, count: 1 }
  const foundationMove: Move = { from: { zone: 'tableau', index: 2 }, to: { zone: 'foundation', index: 0 }, count: 1 }

  it('prefers a foundation-bound move over an earlier non-foundation one', () => {
    const controller = { legalMoves: () => [tableauMove, foundationMove] }
    expect(findHint(controller, null)).toEqual({ kind: 'move', move: foundationMove, choices: 2 })
  })

  it('falls back to the first legal move when none is foundation-bound', () => {
    const controller = { legalMoves: () => [tableauMove] }
    expect(findHint(controller, null)).toEqual({ kind: 'move', move: tableauMove, choices: 1 })
  })

  it('suggests a stock draw when there are no legal moves but the stock can be drawn', () => {
    const controller = { legalMoves: () => [], drawStock: () => ({}) }
    expect(findHint(controller, null)).toEqual({ kind: 'drawStock' })
  })

  it('reports none when there are no legal moves and no stock to draw', () => {
    const withNullDraw = { legalMoves: () => [], drawStock: () => null }
    expect(findHint(withNullDraw, null)).toEqual({ kind: 'none' })

    const withNoDrawStock = { legalMoves: () => [] }
    expect(findHint(withNoDrawStock, null)).toEqual({ kind: 'none' })
  })

  describe('a move that gains nothing and can be moved straight back', () => {
    // A board of two piles, a card moving between them. tryMove: any move from a non-empty pile is legal (so every move
    // can be undone); scoreHintMove from the test.
    type Board = number[]
    const shuffle: Move = { from: { zone: 'tableau', index: 0 }, to: { zone: 'tableau', index: 1 }, count: 1 }
    const back: Move = { from: { zone: 'tableau', index: 1 }, to: { zone: 'tableau', index: 0 }, count: 1 }
    const tryMove = (board: Board, m: Move): Board | null => (board[m.from.index] > 0 ? board.map((n, i) => (i === m.from.index ? n - 1 : i === m.to.index ? n + 1 : n)) : null)
    const controllerWith = (scoreOf: number, drawable: boolean) => ({ legalMoves: (b: Board) => [shuffle, back].filter((m) => tryMove(b, m) !== null), tryMove, scoreHintMove: () => scoreOf, drawStock: () => (drawable ? [0, 0] : null) })

    it('is never suggested, even with nothing to draw: Hint reports none instead of moving it there and back', () => {
      expect(findHint(controllerWith(0, false), [1, 0])).toEqual({ kind: 'none' })
      expect(findHint(controllerWith(-30, false), [1, 0])).toEqual({ kind: 'none' })
    })

    it('leaves the draw as the hint when there is one', () => {
      expect(findHint(controllerWith(0, true), [1, 0])).toEqual({ kind: 'drawStock' })
    })

    it('is still suggested when it gains something, reversible or not', () => {
      expect(findHint(controllerWith(30, false), [1, 0])).toEqual({ kind: 'move', move: shuffle, choices: 1 })
    })

    it('is still suggested when it cannot be moved back', () => {
      const oneWay = { ...controllerWith(0, false), tryMove: (b: Board, m: Move) => (m === shuffle ? tryMove(b, m) : null) }
      expect(findHint(oneWay, [1, 0])).toEqual({ kind: 'move', move: shuffle, choices: 1 })
    })
  })

  describe('skip', () => {
    const moveA: Move = { from: { zone: 'tableau', index: 0 }, to: { zone: 'tableau', index: 1 }, count: 1 }
    const moveB: Move = { from: { zone: 'tableau', index: 2 }, to: { zone: 'tableau', index: 3 }, count: 1 }
    const moveC: Move = { from: { zone: 'tableau', index: 4 }, to: { zone: 'tableau', index: 5 }, count: 1 }
    const controller = { legalMoves: () => [moveA, moveB, moveC] }

    it('cycles to a different move as skip increases', () => {
      expect(findHint(controller, null, 0)).toEqual({ kind: 'move', move: moveA, choices: 3 })
      expect(findHint(controller, null, 1)).toEqual({ kind: 'move', move: moveB, choices: 3 })
      expect(findHint(controller, null, 2)).toEqual({ kind: 'move', move: moveC, choices: 3 })
    })

    it('wraps back around once every move has been shown', () => {
      expect(findHint(controller, null, 3)).toEqual({ kind: 'move', move: moveA, choices: 3 })
      expect(findHint(controller, null, 4)).toEqual({ kind: 'move', move: moveB, choices: 3 })
    })

    it('keeps a foundation-bound move first in the cycle', () => {
      const withFoundation = { legalMoves: () => [moveA, foundationMove, moveB] }
      expect(findHint(withFoundation, null, 0)).toEqual({ kind: 'move', move: foundationMove, choices: 3 })
      expect(findHint(withFoundation, null, 1)).toEqual({ kind: 'move', move: moveA, choices: 3 })
      expect(findHint(withFoundation, null, 2)).toEqual({ kind: 'move', move: moveB, choices: 3 })
    })
  })
})

describe('hintCountFor', () => {
  const move: Move = { from: { zone: 'tableau', index: 0 }, to: { zone: 'tableau', index: 1 }, count: 3 }
  const hint = { kind: 'move' as const, move, choices: 1 }

  it('returns the full run count for the source pile', () => {
    expect(hintCountFor(hint, { zone: 'tableau', index: 0 })).toBe(3)
  })

  it('returns 0 for the destination pile: the glide shows where it goes, the ring only what to pick up', () => {
    expect(hintCountFor(hint, { zone: 'tableau', index: 1 })).toBe(0)
  })

  it('returns 0 for an unrelated pile', () => {
    expect(hintCountFor(hint, { zone: 'tableau', index: 2 })).toBe(0)
  })

  it('returns 0 for a non-move hint or no hint at all', () => {
    expect(hintCountFor({ kind: 'drawStock' }, { zone: 'tableau', index: 0 })).toBe(0)
    expect(hintCountFor(null, { zone: 'tableau', index: 0 })).toBe(0)
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
