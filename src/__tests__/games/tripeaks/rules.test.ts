import { findHint } from '@/engine/hint'
import { Card } from '@/engine/types'
import { createTriPeaksController, flatIndex, isExposed, ROW_WIDTHS, rowColOf, TriPeaksState } from '@/games/tripeaks/rules'

// One shared controller instance for the whole file (no-wrap default, settings.tripeaksRankWrap's
// default value) - same as this file always assumed a single fixed rule before tripeaksRankWrap
// became a setting.
const TriPeaksController = createTriPeaksController(false)

function makeCard(id: string, rank: Card['rank'] = 5): Card {
  return { id, suit: 'clubs', rank, faceUp: true }
}

function emptyTableau(): (Card | null)[] {
  return new Array(28).fill(null)
}

function countCards(state: TriPeaksState): number {
  return state.tableau.filter((c) => c !== null).length + state.waste.length + state.stock.length
}

describe('TriPeaks newGame', () => {
  it('deals a legal starting layout', () => {
    const state = TriPeaksController.newGame(12345)

    expect(countCards(state)).toBe(52)
    expect(state.tableau.length).toBe(28)
    expect(state.waste.length).toBe(1)
    expect(state.waste[0].faceUp).toBe(true)
    expect(state.stock.length).toBe(23)
    state.stock.forEach((c) => expect(c.faceUp).toBe(false))

    // Row widths: 3, 6, 9, 10 - the base row (indices 18-27) is exposed on its own; the upper 18
    // are not, since each has two cards resting on it.
    expect(ROW_WIDTHS).toEqual([3, 6, 9, 10])
    for (let col = 0; col < 10; col++) {
      expect(isExposed(state.tableau, 3, col)).toBe(true)
    }
    for (let col = 0; col < 3; col++) {
      expect(isExposed(state.tableau, 0, col)).toBe(false)
    }
  })

  it('is deterministic given the same seed', () => {
    const a = TriPeaksController.newGame(42)
    const b = TriPeaksController.newGame(42)
    expect(a.tableau.map((c) => c?.id)).toEqual(b.tableau.map((c) => c?.id))
    expect(a.waste.map((c) => c.id)).toEqual(b.waste.map((c) => c.id))
  })
})

describe('TriPeaks isExposed', () => {
  it('exposes a row-2 card only once BOTH of its row-3 children are removed', () => {
    const tableau = emptyTableau()
    // row2 col0 (peak 0's last mid-row card) sits over row3 col0 and row3 col1.
    tableau[flatIndex(2, 0)] = makeCard('row2-0')
    tableau[flatIndex(3, 0)] = makeCard('row3-0')
    tableau[flatIndex(3, 1)] = makeCard('row3-1')

    expect(isExposed(tableau, 2, 0)).toBe(false)

    tableau[flatIndex(3, 0)] = null
    expect(isExposed(tableau, 2, 0)).toBe(false) // still one child left

    tableau[flatIndex(3, 1)] = null
    expect(isExposed(tableau, 2, 0)).toBe(true)
  })

  it('exposes a row-0 apex only after its whole sub-chain clears down to row 3', () => {
    const tableau = emptyTableau()
    tableau[flatIndex(0, 0)] = makeCard('apex') // peak 0's tip
    tableau[flatIndex(1, 0)] = makeCard('r1-0')
    tableau[flatIndex(1, 1)] = makeCard('r1-1')
    tableau[flatIndex(2, 0)] = makeCard('r2-0')
    tableau[flatIndex(2, 1)] = makeCard('r2-1')
    tableau[flatIndex(2, 2)] = makeCard('r2-2')
    tableau[flatIndex(3, 0)] = makeCard('r3-0')
    tableau[flatIndex(3, 1)] = makeCard('r3-1')
    tableau[flatIndex(3, 2)] = makeCard('r3-2')
    tableau[flatIndex(3, 3)] = makeCard('r3-3')

    expect(isExposed(tableau, 0, 0)).toBe(false)

    // Clear peak 0's whole base slice (cols 0-3) and mid row (cols 0-2) - the apex should now be exposed.
    for (const idx of [flatIndex(3, 0), flatIndex(3, 1), flatIndex(3, 2), flatIndex(3, 3)]) tableau[idx] = null
    expect(isExposed(tableau, 2, 0)).toBe(true)
    expect(isExposed(tableau, 2, 1)).toBe(true)
    expect(isExposed(tableau, 2, 2)).toBe(true)
    expect(isExposed(tableau, 1, 0)).toBe(false) // row1 col0 still covered by row2 col0/col1

    tableau[flatIndex(2, 0)] = null
    tableau[flatIndex(2, 1)] = null
    expect(isExposed(tableau, 1, 0)).toBe(true)
    expect(isExposed(tableau, 0, 0)).toBe(false) // apex needs row1 col0 AND col1

    tableau[flatIndex(2, 2)] = null
    expect(isExposed(tableau, 1, 1)).toBe(true)
    tableau[flatIndex(1, 0)] = null
    tableau[flatIndex(1, 1)] = null
    expect(isExposed(tableau, 0, 0)).toBe(true)
  })

  it('shares a base column between two adjacent peaks - removing it partially exposes both', () => {
    // row3 col3 is the shared boundary between peak 0's base (cols 0-3) and peak 1's base (cols 3-6).
    const tableau = emptyTableau()
    tableau[flatIndex(2, 2)] = makeCard('peak0-last-mid') // needs row3 col2 + col3
    tableau[flatIndex(2, 3)] = makeCard('peak1-first-mid') // needs row3 col3 + col4
    tableau[flatIndex(3, 2)] = makeCard('r3-2')
    tableau[flatIndex(3, 3)] = makeCard('r3-3-shared')
    tableau[flatIndex(3, 4)] = makeCard('r3-4')

    tableau[flatIndex(3, 3)] = null
    expect(isExposed(tableau, 2, 2)).toBe(false) // still needs col2
    expect(isExposed(tableau, 2, 3)).toBe(false) // still needs col4

    tableau[flatIndex(3, 2)] = null
    expect(isExposed(tableau, 2, 2)).toBe(true)
    tableau[flatIndex(3, 4)] = null
    expect(isExposed(tableau, 2, 3)).toBe(true)
  })

  it('returns false for an already-removed slot', () => {
    const tableau = emptyTableau()
    expect(isExposed(tableau, 3, 0)).toBe(false)
  })
})

describe('TriPeaks tryMove', () => {
  function stateWith(tableau: (Card | null)[], wasteTop: Card, stock: Card[] = []): TriPeaksState {
    return { tableau, waste: [wasteTop], stock }
  }

  it('moves an exposed tableau card onto the build pile when adjacent by rank', () => {
    const tableau = emptyTableau()
    const seven = makeCard('seven', 7)
    tableau[flatIndex(3, 0)] = seven
    const state = stateWith(tableau, makeCard('waste-eight', 8))

    const result = TriPeaksController.tryMove(state, {
      from: { zone: 'tableau', index: flatIndex(3, 0) },
      to: { zone: 'waste', index: 0 },
      count: 1
    })

    expect(result).not.toBeNull()
    expect(result!.tableau[flatIndex(3, 0)]).toBeNull()
    expect(result!.waste.map((c) => c.id)).toEqual(['waste-eight', 'seven'])
  })

  it('rejects moving a card that is not yet exposed, even if its rank is adjacent', () => {
    const tableau = emptyTableau()
    const seven = makeCard('seven', 7)
    tableau[flatIndex(2, 0)] = seven
    tableau[flatIndex(3, 0)] = makeCard('cover-a')
    tableau[flatIndex(3, 1)] = makeCard('cover-b')
    const state = stateWith(tableau, makeCard('waste-eight', 8))

    const result = TriPeaksController.tryMove(state, {
      from: { zone: 'tableau', index: flatIndex(2, 0) },
      to: { zone: 'waste', index: 0 },
      count: 1
    })
    expect(result).toBeNull()
  })

  it('rejects a non-adjacent rank', () => {
    const tableau = emptyTableau()
    tableau[flatIndex(3, 0)] = makeCard('king', 13)
    const state = stateWith(tableau, makeCard('waste-eight', 8))

    const result = TriPeaksController.tryMove(state, {
      from: { zone: 'tableau', index: flatIndex(3, 0) },
      to: { zone: 'waste', index: 0 },
      count: 1
    })
    expect(result).toBeNull()
  })

  it('does not treat Ace and King as adjacent (no wraparound)', () => {
    const tableau = emptyTableau()
    tableau[flatIndex(3, 0)] = makeCard('ace', 1)
    const state = stateWith(tableau, makeCard('waste-king', 13))

    const result = TriPeaksController.tryMove(state, {
      from: { zone: 'tableau', index: flatIndex(3, 0) },
      to: { zone: 'waste', index: 0 },
      count: 1
    })
    expect(result).toBeNull()
  })
})

describe('TriPeaks drawStock', () => {
  it('flips the next stock card face up onto the build pile, never recycling', () => {
    const state: TriPeaksState = { tableau: emptyTableau(), waste: [makeCard('w', 8)], stock: [{ id: 's', suit: 'hearts', rank: 2, faceUp: false }] }
    const result = TriPeaksController.drawStock!(state)
    expect(result).not.toBeNull()
    expect(result!.stock.length).toBe(0)
    expect(result!.waste.map((c) => c.id)).toEqual(['w', 's'])
    expect(result!.waste[1].faceUp).toBe(true)

    expect(TriPeaksController.drawStock!(result!)).toBeNull()
  })
})

describe('TriPeaks isWon / isStuck', () => {
  it('is won once the whole tableau is cleared', () => {
    const state: TriPeaksState = { tableau: emptyTableau(), waste: [makeCard('w', 8)], stock: [] }
    expect(TriPeaksController.isWon(state)).toBe(true)
  })

  it('is stuck when the stock is empty and no exposed card is adjacent to the build pile', () => {
    const tableau = emptyTableau()
    tableau[flatIndex(3, 0)] = makeCard('king', 13)
    const state: TriPeaksState = { tableau, waste: [makeCard('w', 8)], stock: [] }
    expect(TriPeaksController.isStuck!(state)).toBe(true)
  })

  it('is not stuck while stock remains, even with no legal tableau move', () => {
    const tableau = emptyTableau()
    tableau[flatIndex(3, 0)] = makeCard('king', 13)
    const state: TriPeaksState = { tableau, waste: [makeCard('w', 8)], stock: [{ id: 's', suit: 'hearts', rank: 2, faceUp: false }] }
    expect(TriPeaksController.isStuck!(state)).toBe(false)
  })
})

describe('TriPeaks autoMoveHint', () => {
  it('returns the build-pile move for an exposed, adjacent card', () => {
    const tableau = emptyTableau()
    tableau[flatIndex(3, 0)] = makeCard('seven', 7)
    const state: TriPeaksState = { tableau, waste: [makeCard('w', 8)], stock: [] }
    const move = TriPeaksController.autoMoveHint!(state, { zone: 'tableau', index: flatIndex(3, 0) }, 'seven')
    expect(move).toEqual({ from: { zone: 'tableau', index: flatIndex(3, 0) }, to: { zone: 'waste', index: 0 }, count: 1 })
  })

  it('returns null for a covered (not yet exposed) card', () => {
    const tableau = emptyTableau()
    tableau[flatIndex(2, 0)] = makeCard('seven', 7)
    tableau[flatIndex(3, 0)] = makeCard('cover-a')
    tableau[flatIndex(3, 1)] = makeCard('cover-b')
    const state: TriPeaksState = { tableau, waste: [makeCard('w', 8)], stock: [] }
    const move = TriPeaksController.autoMoveHint!(state, { zone: 'tableau', index: flatIndex(2, 0) }, 'seven')
    expect(move).toBeNull()
  })
})

describe('TriPeaks scoreHintMove', () => {
  function state(tableau: (Card | null)[], wasteRank: Card['rank']): TriPeaksState {
    return { tableau, waste: [makeCard('waste', wasteRank)], stock: [] }
  }

  it('scores a move that exposes a new parent card higher than one that exposes nothing', () => {
    const tableau = emptyTableau()

    // Peak 0's apex is already exposed (both row1 children already gone) - removing it can't
    // expose anything further, since row 0 has no row above it.
    tableau[flatIndex(0, 0)] = makeCard('apex', 7)

    // Peak 1's row2 col3 is exposed on its own (both its row3 children already gone) and, once
    // removed, exposes row1 col2 too - whose *other* child (row2 col4) is already gone as well.
    tableau[flatIndex(1, 2)] = makeCard('r1-2', 2)
    tableau[flatIndex(2, 3)] = makeCard('r2-3', 9)

    const s = state(tableau, 8)
    const apexMove = { from: { zone: 'tableau', index: flatIndex(0, 0) }, to: { zone: 'waste', index: 0 }, count: 1 }
    const r2Move = { from: { zone: 'tableau', index: flatIndex(2, 3) }, to: { zone: 'waste', index: 0 }, count: 1 }

    // Both are legal, and raw scan order surfaces the apex first (lower flat index) - the exact
    // conflict findHint's ranking needs to resolve.
    expect(TriPeaksController.legalMoves(s).map((m) => m.from.index)).toEqual([flatIndex(0, 0), flatIndex(2, 3)])

    expect(TriPeaksController.scoreHintMove!(s, apexMove)).toBe(1) // base only - exposes nothing
    expect(TriPeaksController.scoreHintMove!(s, r2Move)).toBe(2) // base + 1 newly-exposed parent
  })

  it('scores a move that exposes two parent cards at once even higher', () => {
    const tableau = emptyTableau()
    // row2 col1 is shared: it's a child of BOTH row1 col0 and row1 col1. Removing it exposes both
    // at once, since their other children (row2 col0 and row2 col2) are already gone.
    tableau[flatIndex(1, 0)] = makeCard('r1-0', 2)
    tableau[flatIndex(1, 1)] = makeCard('r1-1', 3)
    tableau[flatIndex(2, 1)] = makeCard('r2-1', 9) // exposed itself (its own row3 children are gone)

    const s = state(tableau, 8)
    const move = { from: { zone: 'tableau', index: flatIndex(2, 1) }, to: { zone: 'waste', index: 0 }, count: 1 }

    expect(TriPeaksController.scoreHintMove!(s, move)).toBe(3) // base + 2 newly-exposed parents
  })

  it('never scores a legal move non-positive, so Hint never prefers a stock draw over a free tableau play', () => {
    const tableau = emptyTableau()
    tableau[flatIndex(0, 0)] = makeCard('apex', 7) // legal, but exposes nothing
    const s: TriPeaksState = { tableau, waste: [makeCard('w', 8)], stock: [{ id: 'stock-card', suit: 'hearts', rank: 2, faceUp: false }] }
    const move = { from: { zone: 'tableau', index: flatIndex(0, 0) }, to: { zone: 'waste', index: 0 }, count: 1 }

    expect(TriPeaksController.scoreHintMove!(s, move)).toBeGreaterThan(0)
    expect(findHint(TriPeaksController, s)).toEqual({ kind: 'move', move })
  })

  it('findHint recommends the higher-exposure move over an earlier no-gain move in raw scan order', () => {
    const tableau = emptyTableau()
    tableau[flatIndex(0, 0)] = makeCard('apex', 7) // exposed, adjacent, exposes nothing further
    tableau[flatIndex(1, 2)] = makeCard('r1-2', 2)
    tableau[flatIndex(2, 3)] = makeCard('r2-3', 9) // exposed, adjacent, exposes row1 col2

    const s: TriPeaksState = { tableau, waste: [makeCard('waste', 8)], stock: [] }

    const hint = findHint(TriPeaksController, s)
    expect(hint).toEqual({
      kind: 'move',
      move: { from: { zone: 'tableau', index: flatIndex(2, 3) }, to: { zone: 'waste', index: 0 }, count: 1 }
    })
  })
})

describe('TriPeaks flatIndex / rowColOf', () => {
  it('round-trips every valid (row, col) through flatIndex/rowColOf', () => {
    ROW_WIDTHS.forEach((width, row) => {
      for (let col = 0; col < width; col++) {
        expect(rowColOf(flatIndex(row, col))).toEqual({ row, col })
      }
    })
  })
})
