import { findHint } from '@/engine/hint'
import { Card } from '@/engine/types'
import { canDealStock, createSpiderController, SpiderState } from '@/games/spider/rules'

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

describe('spider autoMoveHint', () => {
  const controller = createSpiderController(4)

  it('prefers a rank-matching non-empty column over an empty column, even when placing there would bury a card', () => {
    const state: SpiderState = {
      tableau: [
        [card('hearts', 6)], // source - moves onto any black/other-suit 7
        [], // empty column - would otherwise win on buried-count alone (0 buried)
        [card('clubs', 9), card('spades', 7)], // legal (6 onto 7), but buries the clubs-9 underneath
        [],
        [],
        [],
        [],
        [],
        [],
        []
      ],
      stock: [],
      completed: [],
      completedRuns: []
    }
    const hint = controller.autoMoveHint!(state, { zone: 'tableau', index: 0 }, 'hearts-6-0')
    // Empty columns are a strict last resort: any legal non-empty destination wins over them,
    // regardless of buried count, so this lands on column 2 rather than the empty column 1.
    expect(hint).toEqual({ from: { zone: 'tableau', index: 0 }, to: { zone: 'tableau', index: 2 }, count: 1 })
  })
})

describe('spider drawStock', () => {
  const controller = createSpiderController(1)

  it('refuses to deal when any tableau column is empty', () => {
    const state: SpiderState = {
      tableau: Array.from({ length: 10 }, (_, i) => (i === 3 ? [] : i === 0 ? [card('spades', 6, true), card('spades', 5, true)] : [card('spades', 5, true)])),
      stock: Array.from({ length: 20 }, (_, i) => card('spades', 2, false, i)),
      completed: [],
      completedRuns: []
    }
    expect(controller.drawStock!(state)).toBeNull()
  })

  it('deals onto empty columns when the tableau holds fewer cards than there are columns', () => {
    const state: SpiderState = {
      tableau: Array.from({ length: 10 }, (_, i) => (i < 9 ? [card('spades', 5, true, i)] : [])),
      stock: Array.from({ length: 10 }, (_, i) => card('spades', 2, false, 100 + i)),
      completed: [],
      completedRuns: []
    }
    const next = controller.drawStock!(state)
    expect(next).not.toBeNull()
    expect(next!.tableau[9]).toHaveLength(1)
    expect(canDealStock(state)).toBe(true)
    expect(controller.isStuck!(state)).toBe(false)
  })

  it('still refuses with an empty column once ten or more cards are on the tableau', () => {
    const state: SpiderState = {
      tableau: Array.from({ length: 10 }, (_, i) => (i === 0 ? [card('spades', 5, true, 0), card('spades', 4, true, 1)] : i < 9 ? [card('spades', 5, true, 10 + i)] : [])),
      stock: Array.from({ length: 10 }, (_, i) => card('spades', 2, false, 100 + i)),
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

describe('spider scoreHintMove', () => {
  const controller = createSpiderController(1)

  function moveTo(state: SpiderState, from: number, count: number, to: number) {
    const move = controller.legalMoves(state).find((m) => m.from.index === from && m.count === count && m.to.index === to)
    if (!move) throw new Error(`expected a legal move from=${from} count=${count} to=${to}`)
    return move
  }

  function scoreOf(state: SpiderState, from: number, count: number, to: number) {
    return controller.scoreHintMove!(state, moveTo(state, from, count, to))
  }

  // Regression test for a real bug: the previous scorer rated "peel the bottom card off a nice
  // 4-card run to park it on some unrelated matching card" the same as any other harmless 1-card
  // move, so Hint would suggest tearing apart a good run for no reason.
  it('never prefers fragmenting a coherent run over relocating it intact, with nothing gained', () => {
    const state: SpiderState = {
      tableau: [[], [card('spades', 7)], [card('spades', 9), card('spades', 8), card('spades', 7, true, 1), card('spades', 6)], ...Array.from({ length: 7 }, (_, i) => [card('spades', 2, true, i)])],
      stock: [],
      completed: [],
      completedRuns: []
    }

    const fragmentOnto7 = scoreOf(state, 2, 1, 1) // rips the 6 off the run, onto the lone 7
    const partialFragment2 = scoreOf(state, 2, 2, 0) // rips 7,6 off, onto the empty column
    const partialFragment3 = scoreOf(state, 2, 3, 0) // rips 8,7,6 off, onto the empty column
    const intactRelocation = scoreOf(state, 2, 4, 0) // the whole run, kept together
    const harmlessSingle = scoreOf(state, 1, 1, 0) // an unrelated lone-card move, for scale

    // Both only relocate something intact onto nothing longer, so neither gains anything: both
    // score 0 (no size tiebreak, which used to put the 4-card move ahead and kept every relocation
    // above 0, so Hint offered it and then offered moving it straight back).
    expect(intactRelocation).toBe(0)
    expect(harmlessSingle).toBe(0)
    expect(fragmentOnto7).toBeLessThan(harmlessSingle)
    expect(partialFragment2).toBeLessThan(harmlessSingle)
    expect(partialFragment3).toBeLessThan(harmlessSingle)
  })

  it('ranks revealing a face-down card far above any move that reveals nothing', () => {
    const state: SpiderState = {
      tableau: [[card('spades', 9, false), card('spades', 5)], [card('spades', 6)], [card('spades', 3)], [card('spades', 4)], ...Array.from({ length: 6 }, (_, i) => [card('spades', 2, true, i)])],
      stock: [],
      completed: [],
      completedRuns: []
    }

    const revealMove = scoreOf(state, 0, 1, 1) // 5 -> 6, exposes the face-down 9
    const plainConsolidation = scoreOf(state, 2, 1, 3) // 3 -> 4, nothing revealed

    expect(revealMove).toBeGreaterThan(plainConsolidation)
    expect(revealMove).toBeGreaterThan(400) // comfortably clears the empty-column/structural range
  })

  it('scores completing a run at 1000, clearly above a large fragment of an unrelated run', () => {
    const twelveRun = Array.from({ length: 12 }, (_, i) => card('spades', (13 - i) as Card['rank']))
    const state: SpiderState = {
      tableau: [twelveRun, [card('spades', 1)], ...Array.from({ length: 8 }, (_, i) => [card('spades', 10, true, i)])],
      stock: [],
      completed: [],
      completedRuns: []
    }

    const completion = scoreOf(state, 1, 1, 0) // the Ace completes King..Ace
    const bigFragment = scoreOf(state, 0, 8, 2) // 8-card fragment of the 12-run, onto a lone 10

    expect(completion).toBe(1000)
    expect(bigFragment).toBeLessThan(0) // unattractive on its own, not just "less than 1000"
  })

  it('treats empty columns as a resource whose net change matters, not a flat penalty', () => {
    const state: SpiderState = {
      tableau: [[card('spades', 5)], [card('spades', 9), card('spades', 8), card('spades', 7), card('spades', 6)], [card('spades', 7, true, 1)], [], ...Array.from({ length: 6 }, (_, i) => [card('spades', 10, true, i)])],
      stock: [],
      completed: [],
      completedRuns: []
    }

    const extendsRunAndFreesColumn = scoreOf(state, 0, 1, 1) // 5 -> the 4-run, frees col0
    const relocatesWholeRunAndFreesColumn = scoreOf(state, 1, 4, 4) // whole run -> a lone 10, frees col1
    const lateralIntoEmptyColumn = scoreOf(state, 2, 1, 3) // lone 7 -> the empty column, net wash
    const fragmentIntoEmptyColumn = scoreOf(state, 1, 2, 3) // rips 7,6 off the run, spends the empty column

    expect(extendsRunAndFreesColumn).toBeGreaterThan(lateralIntoEmptyColumn)
    expect(relocatesWholeRunAndFreesColumn).toBeGreaterThan(lateralIntoEmptyColumn)
    expect(lateralIntoEmptyColumn).toBeGreaterThan(fragmentIntoEmptyColumn)
  })

  // Hint used to offer moving the 6 from the red 7 it sat on to the other red 7, then moving it
  // straight back: neither 7 is a spade, so both moves built nothing, and both scored +2 from the
  // size tiebreak alone.
  it('scores a relocation that gains nothing, and its reverse, at 0, so Hint deals instead of ping-ponging', () => {
    const state: SpiderState = {
      tableau: [[card('diamonds', 7), card('spades', 6)], [card('hearts', 7)], ...Array.from({ length: 8 }, (_, i) => [card('clubs', 1, true, i)])],
      stock: Array.from({ length: 10 }, (_, i) => card('spades', 13, false, i)),
      completed: [],
      completedRuns: []
    }
    const there = moveTo(state, 0, 1, 1)
    expect(controller.scoreHintMove!(state, there)).toBe(0)

    const back = controller.tryMove(state, there)!
    expect(back).not.toBeNull()
    expect(scoreOf(back, 1, 1, 0)).toBe(0)

    expect(findHint(controller, state)).toEqual({ kind: 'drawStock' })
    expect(findHint(controller, back)).toEqual({ kind: 'drawStock' })
  })
})
