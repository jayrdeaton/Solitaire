import { Move } from '@/engine/gameTypes'
import { findHint } from '@/engine/hint'
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

describe('Pyramid scoreHintMove', () => {
  function moveOf(state: PyramidState, fromKey: string, toKey: string): Move {
    const move = PyramidController.legalMoves(state).find((m) => `${m.from.zone}:${m.from.index}` === fromKey && `${m.to.zone}:${m.to.index}` === toKey)
    if (!move) throw new Error(`expected a legal move ${fromKey} -> ${toKey}`)
    return move
  }

  function scoreOf(state: PyramidState, fromKey: string, toKey: string): number {
    return PyramidController.scoreHintMove!(state, moveOf(state, fromKey, toKey))
  }

  // Regression scenario for a real hint-quality gap: two pairs are simultaneously legal, but only
  // one of them removes both children of a still-covered card above it, instantly exposing that
  // card. The other pair is equally "legal" but exposes nothing - its one pyramid-side card's
  // only parent was already removed earlier. Before scoreHintMove existed, legalMoves' raw
  // enumeration order (a nested scan over available refs) surfaced the exposing-nothing pair
  // first, so a naive first-Hint press would suggest it over the strictly more useful move.
  function boardWithOneExposingPairAndOneDeadEndPair(): PyramidState {
    const king = makeCard('spades', 13) // (4,0) - the eventual payoff once (5,1) is also gone
    const blockerBelowKing = makeCard('hearts', 5) // (5,1) - covers the King; becomes exposed once (6,1)+(6,2) are both gone
    const pyramid = buildPyramid({
      '4,0': king,
      '5,0': null, // already removed earlier - (6,0)'s only parent, so removing (6,0) exposes nothing
      '5,1': blockerBelowKing,
      '6,0': makeCard('clubs', 6), // dead-end pair partner: pairs with waste, but exposes nothing
      '6,1': makeCard('diamonds', 9), // exposing pair, part A: 9+4=13, both children of (5,1)
      '6,2': makeCard('spades', 4), // exposing pair, part B
      '6,3': makeCard('clubs', 2),
      '6,4': makeCard('hearts', 2),
      '6,5': makeCard('diamonds', 2),
      '6,6': makeCard('spades', 2)
    })
    return baseState({ pyramid, waste: [makeCard('hearts', 7)] }) // 7 pairs with (6,0)'s 6
  }

  it('confirms the constructed board has exactly the two intended legal pairs, nothing else', () => {
    const state = boardWithOneExposingPairAndOneDeadEndPair()
    const moves = PyramidController.legalMoves(state)
    expect(moves).toHaveLength(2)
    expect(moves).toContainEqual({ from: { zone: 'pyramid', index: flatIndex(6, 0) }, to: { zone: 'waste', index: 0 }, count: 1 })
    expect(moves).toContainEqual({ from: { zone: 'pyramid', index: flatIndex(6, 1) }, to: { zone: 'pyramid', index: flatIndex(6, 2) }, count: 1 })
  })

  it('scores the pair that exposes a new pyramid card above the dead-end pair that exposes nothing', () => {
    const state = boardWithOneExposingPairAndOneDeadEndPair()

    const deadEndPair = scoreOf(state, 'pyramid:21', 'waste:0') // (6,0) + waste - exposes nothing
    const exposingPair = scoreOf(state, 'pyramid:22', 'pyramid:23') // (6,1)+(6,2) - exposes (5,1)

    expect(exposingPair).toBeGreaterThan(deadEndPair)
    expect(deadEndPair).toBeGreaterThan(0) // still a perfectly fine move, never non-positive
  })

  it('actually exposes (5,1) - and only (5,1), not the King two levels up - once the exposing pair is applied', () => {
    const state = boardWithOneExposingPairAndOneDeadEndPair()
    expect(isExposed(state.pyramid, 5, 1)).toBe(false)
    expect(isExposed(state.pyramid, 4, 0)).toBe(false)

    const move = moveOf(state, 'pyramid:22', 'pyramid:23')
    const result = PyramidController.tryMove(state, move)

    expect(result).not.toBeNull()
    expect(isExposed(result!.pyramid, 5, 1)).toBe(true) // newly exposed by this move
    expect(isExposed(result!.pyramid, 4, 0)).toBe(false) // King still needs (5,1) itself removed too
  })

  it('drives findHint to suggest the exposing pair over the dead-end pair on the first press', () => {
    const state = boardWithOneExposingPairAndOneDeadEndPair()
    const hint = findHint(PyramidController, state)
    expect(hint.kind).toBe('move')
    if (hint.kind === 'move') {
      expect(hint.move).toEqual({ from: { zone: 'pyramid', index: flatIndex(6, 1) }, to: { zone: 'pyramid', index: flatIndex(6, 2) }, count: 1 })
    }
  })

  it('scores a solo King removal by the same exposure signal - a King that unblocks another card outscores one that unblocks nothing', () => {
    const revealed = makeCard('hearts', 6) // (4,0) - its other child (5,1) is already gone, so the King below is the last thing blocking it
    const exposingKing = makeCard('spades', 13) // (5,0), covered only by (6,0)+(6,1) (both already gone) - so it's exposed and legal to remove right now
    const deadEndKing = makeCard('diamonds', 13) // (6,4) - row 6, always exposed, but both its own parents keep their other child present, so removing it exposes nothing
    const pyramid = buildPyramid({
      '4,0': revealed,
      '5,0': exposingKing,
      '5,1': null, // (4,0)'s other child - already removed earlier
      '6,0': null,
      '6,1': null, // exposingKing's two children - both already removed earlier, so it's exposed now
      '6,4': deadEndKing
      // (6,4)'s parents are (5,3) and (5,4) - both left as ordinary present fillers, so removing (6,4) alone can't complete either parent's pair
    })
    const state = baseState({ pyramid })

    expect(isExposed(pyramid, 4, 0)).toBe(false) // still needs (5,0) itself gone too
    expect(isExposed(pyramid, 5, 0)).toBe(true) // exposingKing is legal right now

    const exposingKingScore = PyramidController.scoreHintMove!(state, { from: { zone: 'pyramid', index: flatIndex(5, 0) }, to: { zone: 'pyramid', index: flatIndex(5, 0) }, count: 1 })
    const deadEndKingScore = PyramidController.scoreHintMove!(state, { from: { zone: 'pyramid', index: flatIndex(6, 4) }, to: { zone: 'pyramid', index: flatIndex(6, 4) }, count: 1 })

    expect(exposingKingScore).toBeGreaterThan(deadEndKingScore)
    expect(deadEndKingScore).toBeGreaterThan(0)
  })
})
