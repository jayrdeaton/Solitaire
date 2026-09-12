import { GameController } from '@/engine/gameTypes'
import { Card, SUITS } from '@/engine/types'
import { createFortyThievesController, findFoundationSlot, FortyThievesState, isFullyAutoCompletable, nextAutoCompleteMove } from '@/games/fortythieves/rules'

const Strict = createFortyThievesController(false)
const RunMoves = createFortyThievesController(true)

function countCards(state: FortyThievesState): number {
  const tableauCount = state.tableau.reduce((sum, col) => sum + col.length, 0)
  const foundationCount = state.foundation.reduce((sum, f) => sum + f.length, 0)
  return tableauCount + foundationCount + state.stock.length + state.waste.length
}

describe('Forty Thieves newGame', () => {
  it('deals two decks (104 cards): 10 columns of 4 face-up, the rest as stock', () => {
    const state = Strict.newGame(12345)

    expect(countCards(state)).toBe(104)
    expect(state.tableau.length).toBe(10)
    state.tableau.forEach((col) => {
      expect(col.length).toBe(4)
      col.forEach((c) => expect(c.faceUp).toBe(true))
    })
    expect(state.foundation.length).toBe(8)
    state.foundation.forEach((pile) => expect(pile.length).toBe(0))
    expect(state.waste.length).toBe(0)
    expect(state.stock.length).toBe(64)
    state.stock.forEach((c) => expect(c.faceUp).toBe(false))
  })

  it('is deterministic given the same seed', () => {
    const a = Strict.newGame(42)
    const b = Strict.newGame(42)
    expect(a.tableau.map((c) => c.map((x) => x.id))).toEqual(b.tableau.map((c) => c.map((x) => x.id)))
  })
})

describe('Forty Thieves tableau tryMove', () => {
  it('moves a single card onto a same-suit, one-rank-lower target', () => {
    const clubs8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const clubs7: Card = { id: 'clubs-7-0', suit: 'clubs', rank: 7, faceUp: true }
    const state: FortyThievesState = { tableau: [[clubs8], [clubs7], [], [], [], [], [], [], [], []], foundation: Array.from({ length: 8 }, () => []), stock: [], waste: [] }
    const result = Strict.tryMove(state, { from: { zone: 'tableau', index: 1 }, to: { zone: 'tableau', index: 0 }, count: 1 })
    expect(result).not.toBeNull()
    expect(result!.tableau[0].map((c) => c.id)).toEqual(['clubs-8-0', 'clubs-7-0'])
  })

  it('rejects a different suit even at an adjacent rank (no alternating-color rule here)', () => {
    const clubs8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const hearts7: Card = { id: 'hearts-7-0', suit: 'hearts', rank: 7, faceUp: true }
    const state: FortyThievesState = { tableau: [[clubs8], [hearts7], [], [], [], [], [], [], [], []], foundation: Array.from({ length: 8 }, () => []), stock: [], waste: [] }
    const result = Strict.tryMove(state, { from: { zone: 'tableau', index: 1 }, to: { zone: 'tableau', index: 0 }, count: 1 })
    expect(result).toBeNull()
  })

  it('rejects moving more than one card when run moves are off (the classic default)', () => {
    const clubs9: Card = { id: 'clubs-9-0', suit: 'clubs', rank: 9, faceUp: true }
    const clubs8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const clubs7: Card = { id: 'clubs-7-0', suit: 'clubs', rank: 7, faceUp: true }
    const state: FortyThievesState = { tableau: [[clubs9], [clubs8, clubs7], [], [], [], [], [], [], [], []], foundation: Array.from({ length: 8 }, () => []), stock: [], waste: [] }
    const result = Strict.tryMove(state, { from: { zone: 'tableau', index: 1 }, to: { zone: 'tableau', index: 0 }, count: 2 })
    expect(result).toBeNull()
  })

  it('allows moving a valid same-suit run together once run moves are on', () => {
    const clubs9: Card = { id: 'clubs-9-0', suit: 'clubs', rank: 9, faceUp: true }
    const clubs8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const clubs7: Card = { id: 'clubs-7-0', suit: 'clubs', rank: 7, faceUp: true }
    const state: FortyThievesState = { tableau: [[clubs9], [clubs8, clubs7], [], [], [], [], [], [], [], []], foundation: Array.from({ length: 8 }, () => []), stock: [], waste: [] }
    const result = RunMoves.tryMove(state, { from: { zone: 'tableau', index: 1 }, to: { zone: 'tableau', index: 0 }, count: 2 })
    expect(result).not.toBeNull()
    expect(result!.tableau[0].map((c) => c.id)).toEqual(['clubs-9-0', 'clubs-8-0', 'clubs-7-0'])
  })

  it('rejects a run move whose group is not itself a valid same-suit descending sequence', () => {
    const clubs9: Card = { id: 'clubs-9-0', suit: 'clubs', rank: 9, faceUp: true }
    const clubs8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const hearts7: Card = { id: 'hearts-7-0', suit: 'hearts', rank: 7, faceUp: true }
    const state: FortyThievesState = { tableau: [[clubs9], [clubs8, hearts7], [], [], [], [], [], [], [], []], foundation: Array.from({ length: 8 }, () => []), stock: [], waste: [] }
    const result = RunMoves.tryMove(state, { from: { zone: 'tableau', index: 1 }, to: { zone: 'tableau', index: 0 }, count: 2 })
    expect(result).toBeNull()
  })

  it('accepts any single card filling an empty column', () => {
    const clubs7: Card = { id: 'clubs-7-0', suit: 'clubs', rank: 7, faceUp: true }
    const state: FortyThievesState = { tableau: [[], [clubs7], [], [], [], [], [], [], [], []], foundation: Array.from({ length: 8 }, () => []), stock: [], waste: [] }
    const result = Strict.tryMove(state, { from: { zone: 'tableau', index: 1 }, to: { zone: 'tableau', index: 0 }, count: 1 })
    expect(result).not.toBeNull()
  })
})

describe('Forty Thieves foundation tryMove / findFoundationSlot', () => {
  it('only an Ace may start an unclaimed (empty) foundation pile', () => {
    const clubs2: Card = { id: 'clubs-2-0', suit: 'clubs', rank: 2, faceUp: true }
    const state: FortyThievesState = { tableau: [[clubs2], [], [], [], [], [], [], [], [], []], foundation: Array.from({ length: 8 }, () => []), stock: [], waste: [] }
    const result = Strict.tryMove(state, { from: { zone: 'tableau', index: 0 }, to: { zone: 'foundation', index: 0 }, count: 1 })
    expect(result).toBeNull()
  })

  it('an Ace claims the first empty foundation slot', () => {
    const clubsAce: Card = { id: 'clubs-1-0', suit: 'clubs', rank: 1, faceUp: true }
    const state: FortyThievesState = { tableau: [[clubsAce], [], [], [], [], [], [], [], [], []], foundation: Array.from({ length: 8 }, () => []), stock: [], waste: [] }
    const slot = findFoundationSlot(state.foundation, clubsAce)
    expect(slot).toBe(0)
    const result = Strict.tryMove(state, { from: { zone: 'tableau', index: 0 }, to: { zone: 'foundation', index: 0 }, count: 1 })
    expect(result).not.toBeNull()
    expect(result!.foundation[0].map((c) => c.id)).toEqual(['clubs-1-0'])
  })

  it("builds up by suit, and a second deck's Ace of the same suit claims a DIFFERENT slot", () => {
    const clubsAceDeck0: Card = { id: 'clubs-1-0', suit: 'clubs', rank: 1, faceUp: true }
    const clubsAceDeck1: Card = { id: 'clubs-1-1', suit: 'clubs', rank: 1, faceUp: true }
    const clubs2: Card = { id: 'clubs-2-0', suit: 'clubs', rank: 2, faceUp: true }
    const foundation = Array.from({ length: 8 }, () => [] as Card[])
    foundation[0] = [clubsAceDeck0]
    const state: FortyThievesState = { tableau: [[clubs2], [clubsAceDeck1], [], [], [], [], [], [], [], []], foundation, stock: [], waste: [] }

    // clubs-2 correctly targets the already-started slot 0 (needs rank 2 next).
    expect(findFoundationSlot(state.foundation, clubs2)).toBe(0)
    const afterTwo = Strict.tryMove(state, { from: { zone: 'tableau', index: 0 }, to: { zone: 'foundation', index: 0 }, count: 1 })
    expect(afterTwo).not.toBeNull()

    // The second deck's own Ace of clubs claims a fresh, still-empty slot instead.
    const secondAceSlot = findFoundationSlot(afterTwo!.foundation, clubsAceDeck1)
    expect(secondAceSlot).not.toBeNull()
    expect(afterTwo!.foundation[secondAceSlot!]).toEqual([])
  })

  it('rejects a card whose own suit has not been started and is not itself an Ace', () => {
    const hearts5: Card = { id: 'hearts-5-0', suit: 'hearts', rank: 5, faceUp: true }
    const state: FortyThievesState = { tableau: [[hearts5], [], [], [], [], [], [], [], [], []], foundation: Array.from({ length: 8 }, () => []), stock: [], waste: [] }
    expect(findFoundationSlot(state.foundation, hearts5)).toBeNull()
  })
})

describe('Forty Thieves drawStock', () => {
  it('flips the next stock card face up onto the waste, never recycling', () => {
    const stockCard: Card = { id: 'clubs-2-0', suit: 'clubs', rank: 2, faceUp: false }
    const state: FortyThievesState = { tableau: Array.from({ length: 10 }, () => []), foundation: Array.from({ length: 8 }, () => []), stock: [stockCard], waste: [] }
    const result = Strict.drawStock!(state)
    expect(result).not.toBeNull()
    expect(result!.stock.length).toBe(0)
    expect(result!.waste.map((c) => c.id)).toEqual(['clubs-2-0'])
    expect(result!.waste[0].faceUp).toBe(true)
    expect(Strict.drawStock!(result!)).toBeNull()
  })
})

describe('Forty Thieves isWon', () => {
  it('is won once all 8 foundations hold 13 cards each', () => {
    const full: Card[] = Array.from({ length: 13 }, (_, i) => ({ id: `hearts-${i}`, suit: 'hearts', rank: ((i % 13) + 1) as Card['rank'], faceUp: true }))
    const foundation = Array.from({ length: 8 }, () => full)
    const state: FortyThievesState = { tableau: Array.from({ length: 10 }, () => []), foundation, stock: [], waste: [] }
    expect(Strict.isWon(state)).toBe(true)
  })

  it('is not won while any foundation is short', () => {
    const state: FortyThievesState = { tableau: Array.from({ length: 10 }, () => []), foundation: Array.from({ length: 8 }, () => []), stock: [], waste: [] }
    expect(Strict.isWon(state)).toBe(false)
  })
})

describe('Forty Thieves isFullyAutoCompletable / nextAutoCompleteMove', () => {
  it('recognizes a trivially clearable board and cascades every card to its foundation', () => {
    // All 8 foundations one card (a King) short of full - every suit/deck combination accounted
    // for, so the board is genuinely, fully clearable: each of the 8 Kings sits alone in its own
    // tableau column with an obvious, unblocked home.
    const foundation: Card[][] = []
    const tableau: Card[][] = Array.from({ length: 10 }, () => [])
    SUITS.forEach((suit, suitIndex) => {
      for (let deckIndex = 0; deckIndex < 2; deckIndex++) {
        const slot = suitIndex * 2 + deckIndex
        foundation[slot] = Array.from({ length: 12 }, (_, i) => ({ id: `${suit}-${i + 1}-${deckIndex}`, suit, rank: (i + 1) as Card['rank'], faceUp: true }))
        tableau[slot] = [{ id: `${suit}-13-${deckIndex}`, suit, rank: 13, faceUp: true }]
      }
    })
    const state: FortyThievesState = { tableau, foundation, stock: [], waste: [] }

    expect(isFullyAutoCompletable(Strict, state)).toBe(true)
    const first = nextAutoCompleteMove(Strict, state)
    expect(first).not.toBeNull()
    expect(first!.card.rank).toBe(13)
  })

  it('is not fully auto-completable while a needed card is still buried', () => {
    const heartsK: Card = { id: 'hearts-13-0', suit: 'hearts', rank: 13, faceUp: true }
    const buried: Card = { id: 'clubs-5-0', suit: 'clubs', rank: 5, faceUp: true }
    const tableau = Array.from({ length: 10 }, () => [] as Card[])
    tableau[0] = [heartsK, buried] // buried sits ON TOP of heartsK - heartsK isn't accessible
    const state: FortyThievesState = { tableau, foundation: Array.from({ length: 8 }, () => []), stock: [], waste: [] }
    expect(isFullyAutoCompletable(Strict, state)).toBe(false)
  })
})

function card(suit: Card['suit'], rank: Card['rank'], deckIndex = 0): Card {
  return { id: `${suit}-${rank}-${deckIndex}`, suit, rank, faceUp: true }
}

function emptyTableau(overrides: Record<number, Card[]>): Card[][] {
  const tableau: Card[][] = Array.from({ length: 10 }, () => [])
  for (const [index, col] of Object.entries(overrides)) tableau[Number(index)] = col
  return tableau
}

describe('Forty Thieves scoreHintMove', () => {
  const emptyFoundation = () => Array.from({ length: 8 }, () => [] as Card[])

  function moveTo(controller: GameController<FortyThievesState>, state: FortyThievesState, from: number, count: number, to: number) {
    const move = controller.legalMoves(state).find((m) => m.from.zone === 'tableau' && m.from.index === from && m.count === count && m.to.zone === 'tableau' && m.to.index === to)
    if (!move) throw new Error(`expected a legal move from=${from} count=${count} to=${to}`)
    return move
  }

  function scoreOf(controller: GameController<FortyThievesState>, state: FortyThievesState, from: number, count: number, to: number) {
    return controller.scoreHintMove!(state, moveTo(controller, state, from, count, to))
  }

  // Regression test for the fragmentation bug pattern (same shape as Spider's): with run moves on,
  // ripping part of a coherent run off to park it onto an empty column should score worse than
  // relocating the whole run intact, and worse than a harmless unrelated single-card move.
  it('with run moves on, never prefers fragmenting a coherent run over relocating it intact', () => {
    const state: FortyThievesState = {
      tableau: emptyTableau({
        0: [card('clubs', 9), card('clubs', 8), card('clubs', 7), card('clubs', 6)],
        1: [card('hearts', 5)] // unrelated lone card, for a harmless-move baseline
      }),
      foundation: emptyFoundation(),
      stock: [],
      waste: []
    }

    const intactRelocation = scoreOf(RunMoves, state, 0, 4, 2) // the whole run, kept together, onto an empty column
    const partialFragment = scoreOf(RunMoves, state, 0, 1, 2) // rips just the 6 off, onto an empty column
    const harmlessSingle = scoreOf(RunMoves, state, 1, 1, 2) // unrelated lone-card move, onto an empty column

    expect(intactRelocation).toBeGreaterThan(partialFragment)
    expect(harmlessSingle).toBeGreaterThan(partialFragment)
  })

  // The actual gap this game needed, distinct from Spider: settings.fortyThievesRunMoves off (the
  // classic default) forces every tableau move to count === 1, even when a real multi-card run
  // happens to sit at the top of the source column. A naive port of Spider's `runLen` (the real run
  // length at the source) would flag peeling one card off that run as "fragmenting" it - even
  // though moving the whole run was never a real, choosable alternative in this mode. It must
  // score no worse for that reason, while still earning credit for genuinely extending a same-suit
  // run at the destination (an achievable, one-card-at-a-time benefit under the strict rule too).
  it('with run moves OFF, a forced single-card move off a long run scores by its destination gain, not a false fragmentation penalty', () => {
    const state: FortyThievesState = {
      tableau: emptyTableau({
        0: [card('clubs', 9, 0), card('clubs', 8, 0), card('clubs', 7, 0), card('clubs', 6, 0)], // real 4-run, but only the 6 can ever move alone
        1: [card('clubs', 7, 1)] // second deck's own clubs-7, a lone card the 6 can land on
      }),
      foundation: emptyFoundation(),
      stock: [],
      waste: []
    }

    const score = scoreOf(Strict, state, 0, 1, 1) // clubs-6 (deck0) -> clubs-7 (deck1), extending it to a 2-run
    expect(score).toBeGreaterThan(0) // a naive "real source run length" port would score this negative
  })

  it('treats empty tableau columns as a resource whose net change matters, not a flat penalty', () => {
    const state: FortyThievesState = {
      tableau: emptyTableau({
        0: [card('clubs', 6)],
        1: [card('clubs', 9), card('clubs', 8), card('clubs', 7)],
        2: [card('hearts', 7)],
        3: []
      }),
      foundation: emptyFoundation(),
      stock: [],
      waste: []
    }

    const extendsRunAndFreesColumn = scoreOf(Strict, state, 0, 1, 1) // clubs-6 -> the run, frees col0
    const lateralIntoEmptyColumn = scoreOf(Strict, state, 2, 1, 3) // lone hearts-7 -> the empty column, net wash

    expect(extendsRunAndFreesColumn).toBeGreaterThan(lateralIntoEmptyColumn)
  })

  it('scores a waste-to-tableau move as neutral (0) - no source group to weigh a tradeoff against', () => {
    const state: FortyThievesState = {
      tableau: emptyTableau({ 0: [card('clubs', 8)] }),
      foundation: emptyFoundation(),
      stock: [],
      waste: [card('clubs', 7)]
    }
    const move = Strict.legalMoves(state).find((m) => m.from.zone === 'waste' && m.to.zone === 'tableau' && m.to.index === 0)
    expect(move).toBeDefined()
    expect(Strict.scoreHintMove!(state, move!)).toBe(0)
  })
})
