import { Card } from '@/engine/types'
import { createSpiderController, SpiderState } from '@/games/spider/rules'

function card(suit: Card['suit'], rank: Card['rank'], faceUp = true, deckIndex = 0): Card {
  return { id: `${suit}-${rank}-${deckIndex}`, suit, rank, faceUp }
}

describe('spider newGame deal', () => {
  const cases: (1 | 2 | 4)[] = [1, 2, 4]

  for (const numSuits of cases) {
    it(`deals a correct 104-card layout for ${numSuits}-suit spider`, () => {
      const controller = createSpiderController(numSuits)
      const state = controller.newGame(12345)

      const allTableauCards = state.tableau.flat()
      const totalCards = allTableauCards.length + state.stock.length
      expect(totalCards).toBe(104)

      const allIds = [...allTableauCards.map((c) => c.id), ...state.stock.map((c) => c.id)]
      expect(new Set(allIds).size).toBe(104)

      expect(state.tableau).toHaveLength(10)
      const expectedCounts = [6, 6, 6, 6, 5, 5, 5, 5, 5, 5]
      state.tableau.forEach((col, i) => {
        expect(col).toHaveLength(expectedCounts[i])
        // All but the last card should be face-down; last card face-up.
        col.forEach((c, idx) => {
          expect(c.faceUp).toBe(idx === col.length - 1)
        })
      })

      expect(state.stock).toHaveLength(50)
      expect(state.stock.every((c) => !c.faceUp)).toBe(true)
      expect(state.completed).toEqual([])
      expect(state.completedRuns).toEqual([])
    })
  }
})

describe('spider tryMove', () => {
  const controller = createSpiderController(4)

  function baseState(): SpiderState {
    const tableau: Card[][] = Array.from({ length: 10 }, () => [])
    return { tableau, stock: [], completed: [], completedRuns: [] }
  }

  it('allows a legal same-suit descending move onto a matching top card', () => {
    const state = baseState()
    state.tableau[0] = [card('hearts', 10, false), card('hearts', 9, true)]
    state.tableau[1] = [card('spades', 10, true)]

    const next = controller.tryMove(state, {
      from: { zone: 'tableau', index: 0 },
      to: { zone: 'tableau', index: 1 },
      count: 1
    })

    expect(next).not.toBeNull()
    expect(next).not.toBe(state)
    expect(next!.tableau[1].map((c) => c.id)).toEqual(['spades-10-0', 'hearts-9-0'])
    // Original state unmutated.
    expect(state.tableau[0]).toHaveLength(2)
    expect(state.tableau[1]).toHaveLength(1)
    expect(state.tableau[0][0].faceUp).toBe(false)
  })

  it('flips the new top card face-up after a card is moved off a column', () => {
    const state = baseState()
    state.tableau[0] = [card('hearts', 10, false), card('hearts', 9, true)]
    state.tableau[1] = [card('spades', 10, true)]

    const next = controller.tryMove(state, {
      from: { zone: 'tableau', index: 0 },
      to: { zone: 'tableau', index: 1 },
      count: 1
    })

    expect(next!.tableau[0]).toHaveLength(1)
    expect(next!.tableau[0][0].faceUp).toBe(true)
  })

  it('allows moving a same-suit run of multiple cards together', () => {
    const state = baseState()
    state.tableau[0] = [card('clubs', 9, true), card('clubs', 8, true), card('clubs', 7, true)]
    state.tableau[1] = [card('hearts', 10, true)]

    const next = controller.tryMove(state, {
      from: { zone: 'tableau', index: 0 },
      to: { zone: 'tableau', index: 1 },
      count: 3
    })

    expect(next).not.toBeNull()
    expect(next!.tableau[1]).toHaveLength(4)
    expect(next!.tableau[0]).toHaveLength(0)
  })

  it('rejects a move where the group is not a valid same-suit descending run', () => {
    const state = baseState()
    // clubs-9 on top of clubs-8: not descending (out of order for a "run" from top).
    state.tableau[0] = [card('clubs', 8, true), card('clubs', 9, true)]
    state.tableau[1] = [card('hearts', 10, true)]

    const next = controller.tryMove(state, {
      from: { zone: 'tableau', index: 0 },
      to: { zone: 'tableau', index: 1 },
      count: 2
    })

    expect(next).toBeNull()
  })

  it('rejects a move onto a destination top card with the wrong rank gap', () => {
    const state = baseState()
    state.tableau[0] = [card('hearts', 9, true)]
    state.tableau[1] = [card('spades', 5, true)] // gap is wrong (needs rank 10 on top)

    const next = controller.tryMove(state, {
      from: { zone: 'tableau', index: 0 },
      to: { zone: 'tableau', index: 1 },
      count: 1
    })

    expect(next).toBeNull()
  })

  it('allows moving any card/run onto an empty column', () => {
    const state = baseState()
    state.tableau[0] = [card('hearts', 5, true)]
    state.tableau[1] = []

    const next = controller.tryMove(state, {
      from: { zone: 'tableau', index: 0 },
      to: { zone: 'tableau', index: 1 },
      count: 1
    })

    expect(next).not.toBeNull()
    expect(next!.tableau[1]).toHaveLength(1)
  })

  it('rejects moves that are not tableau-to-tableau', () => {
    const state = baseState()
    state.tableau[0] = [card('hearts', 5, true)]

    const next = controller.tryMove(state, {
      from: { zone: 'stock', index: 0 },
      to: { zone: 'tableau', index: 1 },
      count: 1
    })

    expect(next).toBeNull()
  })
})

describe('spider completed sequence detection', () => {
  const controller = createSpiderController(1)

  function fullSuitRun(suit: Card['suit'], faceUp = true): Card[] {
    const run: Card[] = []
    for (let rank = 13; rank >= 1; rank--) {
      run.push(card(suit, rank as Card['rank'], faceUp))
    }
    return run
  }

  it('removes a completed King->Ace same-suit run and adds its King to completed', () => {
    const state: SpiderState = {
      tableau: Array.from({ length: 10 }, () => [] as Card[]),
      stock: [],
      completed: [card('hearts', 13, true, 1), card('diamonds', 13, true, 2), card('clubs', 13, true, 3)],
      completedRuns: []
    }
    // Column 0 has an almost complete run (King..2), column 1 has a lone Ace of the same suit to move over.
    state.tableau[0] = fullSuitRun('spades').slice(0, 12) // King(13) down to 2
    state.tableau[0].push(card('diamonds', 8, false)) // a buried card underneath doesn't matter for this test
    // Actually simplest: put the 12-card run then move the Ace on top via tryMove.
    state.tableau[0] = fullSuitRun('spades').slice(0, 12)
    state.tableau[1] = [card('spades', 1, true)] // Ace of spades

    const next = controller.tryMove(state, {
      from: { zone: 'tableau', index: 1 },
      to: { zone: 'tableau', index: 0 },
      count: 1
    })

    expect(next).not.toBeNull()
    expect(next!.completed).toHaveLength(4)
    expect(next!.completed[3]).toMatchObject({ suit: 'spades', rank: 13 })
    expect(next!.tableau[0]).toHaveLength(0)
    expect(next!.completedRuns).toHaveLength(1)
    expect(next!.completedRuns[0]).toHaveLength(13)
    expect(next!.completedRuns[0][0]).toMatchObject({ suit: 'spades', rank: 13 })
    expect(next!.completedRuns[0][12]).toMatchObject({ suit: 'spades', rank: 1 })
  })

  it('flips the newly exposed top card after removing a completed sequence', () => {
    const state: SpiderState = {
      tableau: Array.from({ length: 10 }, () => [] as Card[]),
      stock: [],
      completed: [],
      completedRuns: []
    }
    const buried = card('hearts', 6, false)
    state.tableau[0] = [buried, ...fullSuitRun('spades').slice(0, 12)]
    state.tableau[1] = [card('spades', 1, true)]

    const next = controller.tryMove(state, {
      from: { zone: 'tableau', index: 1 },
      to: { zone: 'tableau', index: 0 },
      count: 1
    })

    expect(next!.completed).toHaveLength(1)
    expect(next!.tableau[0]).toHaveLength(1)
    expect(next!.tableau[0][0].faceUp).toBe(true)
  })
})

describe('spider isWon', () => {
  const controller = createSpiderController(2)

  it('is only true once 8 sequences are completed', () => {
    const sevenKings = Array.from({ length: 7 }, (_, i) => card('hearts', 13, true, i))
    const base: SpiderState = { tableau: Array.from({ length: 10 }, () => []), stock: [], completed: sevenKings, completedRuns: [] }
    expect(controller.isWon(base)).toBe(false)
    expect(controller.isWon({ ...base, completed: [...sevenKings, card('hearts', 13, true, 7)] })).toBe(true)
  })
})

describe('spider drawStock', () => {
  const controller = createSpiderController(1)

  it('refuses to deal when any tableau column is empty', () => {
    const state: SpiderState = {
      tableau: Array.from({ length: 10 }, (_, i) => (i === 3 ? [] : [card('spades', 5, true)])),
      stock: Array.from({ length: 20 }, (_, i) => card('spades', 2, false, i)),
      completed: [],
      completedRuns: []
    }
    expect(controller.drawStock!(state)).toBeNull()
  })

  it('refuses to deal when stock is empty', () => {
    const state: SpiderState = {
      tableau: Array.from({ length: 10 }, () => [card('spades', 5, true)]),
      stock: [],
      completed: [],
      completedRuns: []
    }
    expect(controller.drawStock!(state)).toBeNull()
  })

  it('deals one card face-up onto each column when allowed', () => {
    const state: SpiderState = {
      tableau: Array.from({ length: 10 }, () => [card('spades', 5, true)]),
      stock: Array.from({ length: 10 }, (_, i) => card('spades', 2, false, i)),
      completed: [],
      completedRuns: []
    }
    const next = controller.drawStock!(state)
    expect(next).not.toBeNull()
    expect(next!.stock).toHaveLength(0)
    next!.tableau.forEach((col) => {
      expect(col).toHaveLength(2)
      expect(col[1].faceUp).toBe(true)
    })
    // Original unmutated
    expect(state.stock).toHaveLength(10)
    expect(state.tableau[0]).toHaveLength(1)
  })
})
