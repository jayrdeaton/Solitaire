import { Card } from '@/engine/types'
import { flatIndex, isExposed, PyramidController, PyramidState } from '@/games/pyramid/rules'

function makeCard(suit: Card['suit'], rank: Card['rank'], faceUp = true, deckIndex = 0): Card {
  return { id: `${suit}-${rank}-${deckIndex}`, suit, rank, faceUp }
}

/** Build a full 28-slot pyramid array, all filled with throwaway low cards,
 * then let the caller override specific (row,col) slots. */
function buildPyramid(overrides: Record<string, Card | null>): (Card | null)[] {
  const pyramid: (Card | null)[] = new Array(28).fill(null)
  let n = 2 // start ranks away from 13 so accidental sums-to-13 pairs don't sneak in
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col <= row; col++) {
      const idx = flatIndex(row, col)
      const key = `${row},${col}`
      if (key in overrides) {
        pyramid[idx] = overrides[key]
      } else {
        const rank = ((n % 9) + 2) as Card['rank'] // ranks 2..10, avoids kings/aces
        n++
        pyramid[idx] = makeCard('clubs', rank, true, idx)
      }
    }
  }
  return pyramid
}

function baseState(overrides: Partial<PyramidState> = {}): PyramidState {
  return {
    pyramid: buildPyramid({}),
    stock: [],
    waste: [],
    discard: [],
    removedCount: 0,
    ...overrides
  }
}

describe('Pyramid newGame', () => {
  it('deals 28 pyramid cards (face-up) and 24 stock cards, no duplicate ids', () => {
    const state = PyramidController.newGame(777)

    expect(state.pyramid.length).toBe(28)
    expect(state.pyramid.every((c) => c !== null)).toBe(true)
    expect(state.pyramid.every((c) => c!.faceUp)).toBe(true)
    expect(state.stock.length).toBe(24)
    expect(state.stock.every((c) => !c.faceUp)).toBe(true)
    expect(state.waste.length).toBe(0)
    expect(state.discard.length).toBe(0)
    expect(state.removedCount).toBe(0)

    const allIds = [...state.pyramid.map((c) => c!.id), ...state.stock.map((c) => c.id)]
    expect(new Set(allIds).size).toBe(52)
  })

  it('is deterministic given the same seed', () => {
    const a = PyramidController.newGame(99)
    const b = PyramidController.newGame(99)
    expect(a.pyramid.map((c) => c!.id)).toEqual(b.pyramid.map((c) => c!.id))
    expect(a.stock.map((c) => c.id)).toEqual(b.stock.map((c) => c.id))
  })
})

describe('isExposed', () => {
  it('row 6 cards are always exposed when present', () => {
    const pyramid = buildPyramid({})
    for (let col = 0; col <= 6; col++) {
      expect(isExposed(pyramid, 6, col)).toBe(true)
    }
  })

  it('a row-5 card is exposed only once both its row-6 children are removed', () => {
    const pyramid = buildPyramid({})
    // (5,0) is covered by (6,0) and (6,1)
    expect(isExposed(pyramid, 5, 0)).toBe(false)

    pyramid[flatIndex(6, 0)] = null
    expect(isExposed(pyramid, 5, 0)).toBe(false) // only one child removed

    pyramid[flatIndex(6, 1)] = null
    expect(isExposed(pyramid, 5, 0)).toBe(true) // both children removed
  })

  it('returns false for an already-removed slot', () => {
    const pyramid = buildPyramid({})
    pyramid[flatIndex(6, 0)] = null
    expect(isExposed(pyramid, 6, 0)).toBe(false)
  })
})

describe('Pyramid tryMove - solo King', () => {
  it('removes an exposed King alone and increments removedCount by 1', () => {
    const king = makeCard('spades', 13)
    const pyramid = buildPyramid({ '6,0': king })
    const state = baseState({ pyramid })

    const idx = flatIndex(6, 0)
    const result = PyramidController.tryMove(state, {
      from: { zone: 'pyramid', index: idx },
      to: { zone: 'pyramid', index: idx },
      count: 1
    })

    expect(result).not.toBeNull()
    expect(result!.pyramid[idx]).toBeNull()
    expect(result!.removedCount).toBe(1)
    expect(result!.discard.map((c) => c.id)).toEqual([king.id])
    expect(result!.discard[0].faceUp).toBe(true)
    // original untouched
    expect(state.pyramid[idx]).not.toBeNull()
    expect(state.removedCount).toBe(0)
    expect(state.discard).toEqual([])
  })

  it('forces the discarded card face-up even if it was face-down', () => {
    const king = makeCard('spades', 13, false)
    const pyramid = buildPyramid({ '6,0': king })
    const state = baseState({ pyramid })
    const idx = flatIndex(6, 0)

    const result = PyramidController.tryMove(state, {
      from: { zone: 'pyramid', index: idx },
      to: { zone: 'pyramid', index: idx },
      count: 1
    })

    expect(result!.discard[0].faceUp).toBe(true)
  })

  it('refuses a solo removal for a non-King, and for a covered King', () => {
    const nonKing = makeCard('spades', 9)
    let pyramid = buildPyramid({ '6,0': nonKing })
    let state = baseState({ pyramid })
    let idx = flatIndex(6, 0)
    expect(
      PyramidController.tryMove(state, {
        from: { zone: 'pyramid', index: idx },
        to: { zone: 'pyramid', index: idx },
        count: 1
      })
    ).toBeNull()

    const king = makeCard('spades', 13)
    pyramid = buildPyramid({ '5,0': king })
    state = baseState({ pyramid })
    idx = flatIndex(5, 0) // covered by (6,0) and (6,1), both present
    expect(
      PyramidController.tryMove(state, {
        from: { zone: 'pyramid', index: idx },
        to: { zone: 'pyramid', index: idx },
        count: 1
      })
    ).toBeNull()
  })

  it('also removes a King alone when drawn onto the top of the waste pile', () => {
    const king = makeCard('hearts', 13)
    const state = baseState({ waste: [makeCard('clubs', 6), king] })

    const result = PyramidController.tryMove(state, {
      from: { zone: 'waste', index: 0 },
      to: { zone: 'waste', index: 0 },
      count: 1
    })

    expect(result).not.toBeNull()
    expect(result!.waste.map((c) => c.id)).toEqual(['clubs-6-0'])
    expect(result!.removedCount).toBe(1)
    expect(result!.discard.map((c) => c.id)).toEqual([king.id])
    // original untouched
    expect(state.waste.length).toBe(2)
    expect(state.removedCount).toBe(0)
  })

  it('includes waste and pyramid Kings in legalMoves as solo removals', () => {
    const king = makeCard('spades', 13)
    const pyramid = buildPyramid({ '6,0': king })
    const state = baseState({ pyramid, waste: [makeCard('hearts', 13)] })

    const moves = PyramidController.legalMoves(state)
    const idx = flatIndex(6, 0)
    expect(moves).toContainEqual({ from: { zone: 'pyramid', index: idx }, to: { zone: 'pyramid', index: idx }, count: 1 })
    expect(moves).toContainEqual({ from: { zone: 'waste', index: 0 }, to: { zone: 'waste', index: 0 }, count: 1 })
  })
})

describe('Pyramid tryMove - pair removal', () => {
  it('removes two exposed pyramid cards summing to 13', () => {
    const seven = makeCard('hearts', 7)
    const six = makeCard('clubs', 6)
    const pyramid = buildPyramid({ '6,0': seven, '6,1': six })
    const state = baseState({ pyramid })

    const idxA = flatIndex(6, 0)
    const idxB = flatIndex(6, 1)
    const result = PyramidController.tryMove(state, {
      from: { zone: 'pyramid', index: idxA },
      to: { zone: 'pyramid', index: idxB },
      count: 1
    })

    expect(result).not.toBeNull()
    expect(result!.pyramid[idxA]).toBeNull()
    expect(result!.pyramid[idxB]).toBeNull()
    expect(result!.removedCount).toBe(2)
    expect(result!.discard.map((c) => c.id)).toEqual([seven.id, six.id])
  })

  it('rejects a pair that does not sum to 13', () => {
    const five = makeCard('hearts', 5)
    const six = makeCard('clubs', 6)
    const pyramid = buildPyramid({ '6,0': five, '6,1': six })
    const state = baseState({ pyramid })

    const result = PyramidController.tryMove(state, {
      from: { zone: 'pyramid', index: flatIndex(6, 0) },
      to: { zone: 'pyramid', index: flatIndex(6, 1) },
      count: 1
    })
    expect(result).toBeNull()
  })

  it('rejects a pair where one card is not exposed', () => {
    const seven = makeCard('hearts', 7)
    const six = makeCard('clubs', 6)
    // put the six at (5,0), covered by (6,0) and (6,1) which remain present
    const pyramid = buildPyramid({ '6,2': seven, '5,0': six })
    const state = baseState({ pyramid })

    const result = PyramidController.tryMove(state, {
      from: { zone: 'pyramid', index: flatIndex(6, 2) },
      to: { zone: 'pyramid', index: flatIndex(5, 0) },
      count: 1
    })
    expect(result).toBeNull()
  })

  it('pairs an exposed pyramid card with the waste top card and pops the waste', () => {
    const seven = makeCard('hearts', 7)
    const six = makeCard('clubs', 6)
    const pyramid = buildPyramid({ '6,0': seven })
    const waste = [makeCard('diamonds', 2), six]
    const state = baseState({ pyramid, waste })

    const idx = flatIndex(6, 0)
    const result = PyramidController.tryMove(state, {
      from: { zone: 'pyramid', index: idx },
      to: { zone: 'waste', index: 0 },
      count: 1
    })

    expect(result).not.toBeNull()
    expect(result!.pyramid[idx]).toBeNull()
    expect(result!.waste.map((c) => c.id)).toEqual(['diamonds-2-0'])
    expect(result!.removedCount).toBe(2)
    expect(result!.discard.map((c) => c.id)).toEqual([seven.id, six.id])
  })

  it('also works with waste specified as the "from" side', () => {
    const seven = makeCard('hearts', 7)
    const six = makeCard('clubs', 6)
    const pyramid = buildPyramid({ '6,0': seven })
    const waste = [six]
    const state = baseState({ pyramid, waste })

    const idx = flatIndex(6, 0)
    const result = PyramidController.tryMove(state, {
      from: { zone: 'waste', index: 0 },
      to: { zone: 'pyramid', index: idx },
      count: 1
    })

    expect(result).not.toBeNull()
    expect(result!.pyramid[idx]).toBeNull()
    expect(result!.waste.length).toBe(0)
    expect(result!.discard.map((c) => c.id)).toEqual([six.id, seven.id])
  })
})

describe('Pyramid drawStock', () => {
  it('moves exactly 1 card face-up from stock to waste', () => {
    const stock = [makeCard('clubs', 2, false), makeCard('clubs', 3, false), makeCard('clubs', 4, false)]
    const state = baseState({ stock, waste: [] })

    const result = PyramidController.drawStock!(state)
    expect(result).not.toBeNull()
    expect(result!.stock.length).toBe(2)
    expect(result!.waste.length).toBe(1)
    expect(result!.waste[0].faceUp).toBe(true)
    expect(result!.waste[0].id).toBe('clubs-4-0') // top of stock (end of array)
  })

  it('recycles waste back into stock face-down, reversed, when stock is empty', () => {
    const waste = [makeCard('clubs', 2), makeCard('clubs', 3), makeCard('clubs', 4)]
    const state = baseState({ stock: [], waste })

    const result = PyramidController.drawStock!(state)
    expect(result).not.toBeNull()
    expect(result!.waste.length).toBe(0)
    expect(result!.stock.length).toBe(3)
    expect(result!.stock.every((c) => !c.faceUp)).toBe(true)
    expect(result!.stock.map((c) => c.id)).toEqual(['clubs-4-0', 'clubs-3-0', 'clubs-2-0'])
  })

  it('returns null when both stock and waste are empty', () => {
    const state = baseState({ stock: [], waste: [] })
    expect(PyramidController.drawStock!(state)).toBeNull()
  })
})

describe('Pyramid isWon / win sweep', () => {
  it('is true only once every pyramid slot is empty, not merely when removedCount reaches 28', () => {
    const notWon = baseState({ pyramid: buildPyramid({}) })
    expect(PyramidController.isWon(notWon)).toBe(false)
    const won = baseState({ pyramid: new Array(28).fill(null) })
    expect(PyramidController.isWon(won)).toBe(true)
  })

  it('declares a win via a waste-assisted pair that clears the last pyramid card, and sweeps the remaining waste/stock into discard', () => {
    const six = makeCard('clubs', 6)
    const seven = makeCard('hearts', 7)
    const leftoverWaste = makeCard('diamonds', 4)
    const leftoverStock = makeCard('spades', 9, false)
    const pyramid = new Array(28).fill(null)
    pyramid[flatIndex(6, 0)] = six // last remaining pyramid card, row 6 so always exposed
    const state = baseState({ pyramid, waste: [leftoverWaste, seven], stock: [leftoverStock] })

    expect(PyramidController.isWon(state)).toBe(false)

    const result = PyramidController.tryMove(state, {
      from: { zone: 'pyramid', index: flatIndex(6, 0) },
      to: { zone: 'waste', index: 0 },
      count: 1
    })

    expect(result).not.toBeNull()
    expect(result!.pyramid.every((c) => c === null)).toBe(true)
    expect(PyramidController.isWon(result!)).toBe(true)
    expect(result!.waste).toEqual([])
    expect(result!.stock).toEqual([])
    expect(result!.discard.map((c) => c.id)).toEqual([six.id, seven.id, leftoverWaste.id, leftoverStock.id])
    expect(result!.discard.every((c) => c.faceUp)).toBe(true)
  })

  it('does not declare a win or sweep when pyramid cards remain after the move', () => {
    const seven = makeCard('hearts', 7)
    const six = makeCard('clubs', 6)
    const pyramid = buildPyramid({ '6,0': seven, '6,1': six })
    const state = baseState({ pyramid, waste: [makeCard('diamonds', 4)], stock: [makeCard('spades', 9, false)] })

    const result = PyramidController.tryMove(state, {
      from: { zone: 'pyramid', index: flatIndex(6, 0) },
      to: { zone: 'pyramid', index: flatIndex(6, 1) },
      count: 1
    })

    expect(PyramidController.isWon(result!)).toBe(false)
    expect(result!.waste).toHaveLength(1)
    expect(result!.stock).toHaveLength(1)
  })
})
