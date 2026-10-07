import { Move } from '@/engine/gameTypes'
import { Card } from '@/engine/types'
import { createGolfController, GolfState } from '@/games/golf/rules'

// Every test here exercises the no-wrap default (settings.golfRankWrap's default value) except
// none actually test wrap-on - one shared controller instance for the whole file, same as this
// file always assumed a single fixed rule before golfRankWrap became a setting.
const GolfController = createGolfController(false)

function countCards(state: GolfState): number {
  const tableauCount = state.tableau.reduce((sum, col) => sum + col.length, 0)
  return tableauCount + state.waste.length + state.stock.length
}

describe('Golf newGame', () => {
  it('deals a legal starting layout', () => {
    const state = GolfController.newGame(12345)

    expect(countCards(state)).toBe(52)
    expect(state.tableau.length).toBe(7)
    state.tableau.forEach((col) => {
      expect(col.length).toBe(5)
      col.forEach((c) => expect(c.faceUp).toBe(true))
    })
    expect(state.waste.length).toBe(1)
    expect(state.waste[0].faceUp).toBe(true)
    expect(state.stock.length).toBe(16)
    state.stock.forEach((c) => expect(c.faceUp).toBe(false))
  })

  it('is deterministic given the same seed', () => {
    const a = GolfController.newGame(42)
    const b = GolfController.newGame(42)
    expect(a.tableau.map((c) => c.map((x) => x.id))).toEqual(b.tableau.map((c) => c.map((x) => x.id)))
    expect(a.waste.map((x) => x.id)).toEqual(b.waste.map((x) => x.id))
  })
})

describe('Golf tryMove', () => {
  it('moves a tableau top card onto the build pile when adjacent by rank, regardless of suit', () => {
    const seven: Card = { id: 'clubs-7-0', suit: 'clubs', rank: 7, faceUp: true }
    const eight: Card = { id: 'hearts-8-0', suit: 'hearts', rank: 8, faceUp: true }
    const state: GolfState = {
      tableau: [[seven], [], [], [], [], [], []],
      waste: [eight],
      stock: []
    }
    const snapshot = JSON.parse(JSON.stringify(state))

    const result = GolfController.tryMove(state, {
      from: { zone: 'tableau', index: 0 },
      to: { zone: 'waste', index: 0 },
      count: 1
    })

    expect(result).not.toBeNull()
    expect(result!.tableau[0]).toEqual([])
    expect(result!.waste.map((c) => c.id)).toEqual(['hearts-8-0', 'clubs-7-0'])
    expect(state).toEqual(snapshot)
  })

  it('accepts a rank one BELOW the build pile top too, not just above', () => {
    const nine: Card = { id: 'spades-9-0', suit: 'spades', rank: 9, faceUp: true }
    const eight: Card = { id: 'hearts-8-0', suit: 'hearts', rank: 8, faceUp: true }
    const state: GolfState = {
      tableau: [[nine], [], [], [], [], [], []],
      waste: [eight],
      stock: []
    }
    const result = GolfController.tryMove(state, {
      from: { zone: 'tableau', index: 0 },
      to: { zone: 'waste', index: 0 },
      count: 1
    })
    expect(result).not.toBeNull()
  })

  it('rejects a non-adjacent rank', () => {
    const king: Card = { id: 'spades-13-0', suit: 'spades', rank: 13, faceUp: true }
    const eight: Card = { id: 'hearts-8-0', suit: 'hearts', rank: 8, faceUp: true }
    const state: GolfState = {
      tableau: [[king], [], [], [], [], [], []],
      waste: [eight],
      stock: []
    }
    const result = GolfController.tryMove(state, {
      from: { zone: 'tableau', index: 0 },
      to: { zone: 'waste', index: 0 },
      count: 1
    })
    expect(result).toBeNull()
  })

  it('does not treat Ace and King as adjacent (no wraparound)', () => {
    const ace: Card = { id: 'clubs-1-0', suit: 'clubs', rank: 1, faceUp: true }
    const king: Card = { id: 'hearts-13-0', suit: 'hearts', rank: 13, faceUp: true }
    const state: GolfState = {
      tableau: [[ace], [], [], [], [], [], []],
      waste: [king],
      stock: []
    }
    const result = GolfController.tryMove(state, {
      from: { zone: 'tableau', index: 0 },
      to: { zone: 'waste', index: 0 },
      count: 1
    })
    expect(result).toBeNull()
  })

  it('rejects moving more than one card at once', () => {
    const six: Card = { id: 'clubs-6-0', suit: 'clubs', rank: 6, faceUp: true }
    const seven: Card = { id: 'diamonds-7-0', suit: 'diamonds', rank: 7, faceUp: true }
    const eight: Card = { id: 'hearts-8-0', suit: 'hearts', rank: 8, faceUp: true }
    const state: GolfState = {
      tableau: [[six, seven], [], [], [], [], [], []],
      waste: [eight],
      stock: []
    }
    const result = GolfController.tryMove(state, {
      from: { zone: 'tableau', index: 0 },
      to: { zone: 'waste', index: 0 },
      count: 2
    })
    expect(result).toBeNull()
  })
})

describe('Golf drawStock', () => {
  it('flips the next stock card face up onto the build pile', () => {
    const eight: Card = { id: 'hearts-8-0', suit: 'hearts', rank: 8, faceUp: true }
    const stockCard: Card = { id: 'clubs-2-0', suit: 'clubs', rank: 2, faceUp: false }
    const state: GolfState = {
      tableau: [[], [], [], [], [], [], []],
      waste: [eight],
      stock: [stockCard]
    }
    const result = GolfController.drawStock!(state)
    expect(result).not.toBeNull()
    expect(result!.stock.length).toBe(0)
    expect(result!.waste.map((c) => c.id)).toEqual(['hearts-8-0', 'clubs-2-0'])
    expect(result!.waste[1].faceUp).toBe(true)
  })

  it('never recycles - returns null once the stock is empty', () => {
    const eight: Card = { id: 'hearts-8-0', suit: 'hearts', rank: 8, faceUp: true }
    const state: GolfState = {
      tableau: [[], [], [], [], [], [], []],
      waste: [eight],
      stock: []
    }
    expect(GolfController.drawStock!(state)).toBeNull()
  })
})

describe('Golf isWon / isStuck', () => {
  it('is won once every tableau column is empty', () => {
    const eight: Card = { id: 'hearts-8-0', suit: 'hearts', rank: 8, faceUp: true }
    const state: GolfState = {
      tableau: [[], [], [], [], [], [], []],
      waste: [eight],
      stock: []
    }
    expect(GolfController.isWon(state)).toBe(true)
    // A cleared board has no move and (here) no stock either - it must read as a win, never a loss.
    expect(GolfController.isStuck!(state)).toBe(false)
  })

  it('is not won while any tableau card remains', () => {
    const six: Card = { id: 'clubs-6-0', suit: 'clubs', rank: 6, faceUp: true }
    const eight: Card = { id: 'hearts-8-0', suit: 'hearts', rank: 8, faceUp: true }
    const state: GolfState = {
      tableau: [[six], [], [], [], [], [], []],
      waste: [eight],
      stock: []
    }
    expect(GolfController.isWon(state)).toBe(false)
  })

  it('is stuck when the stock is empty and no tableau top card is adjacent to the build pile', () => {
    const king: Card = { id: 'spades-13-0', suit: 'spades', rank: 13, faceUp: true }
    const eight: Card = { id: 'hearts-8-0', suit: 'hearts', rank: 8, faceUp: true }
    const state: GolfState = {
      tableau: [[king], [], [], [], [], [], []],
      waste: [eight],
      stock: []
    }
    expect(GolfController.isStuck!(state)).toBe(true)
  })

  it('is not stuck while stock cards remain, even with no legal tableau move', () => {
    const king: Card = { id: 'spades-13-0', suit: 'spades', rank: 13, faceUp: true }
    const eight: Card = { id: 'hearts-8-0', suit: 'hearts', rank: 8, faceUp: true }
    const stockCard: Card = { id: 'clubs-2-0', suit: 'clubs', rank: 2, faceUp: false }
    const state: GolfState = {
      tableau: [[king], [], [], [], [], [], []],
      waste: [eight],
      stock: [stockCard]
    }
    expect(GolfController.isStuck!(state)).toBe(false)
  })
})

describe('Golf autoMoveHint', () => {
  it('returns the build-pile move when legal', () => {
    const seven: Card = { id: 'clubs-7-0', suit: 'clubs', rank: 7, faceUp: true }
    const eight: Card = { id: 'hearts-8-0', suit: 'hearts', rank: 8, faceUp: true }
    const state: GolfState = {
      tableau: [[seven], [], [], [], [], [], []],
      waste: [eight],
      stock: []
    }
    const move = GolfController.autoMoveHint!(state, { zone: 'tableau', index: 0 }, 'clubs-7-0')
    expect(move).toEqual({ from: { zone: 'tableau', index: 0 }, to: { zone: 'waste', index: 0 }, count: 1 })
  })

  it('returns null when no legal destination exists', () => {
    const king: Card = { id: 'spades-13-0', suit: 'spades', rank: 13, faceUp: true }
    const eight: Card = { id: 'hearts-8-0', suit: 'hearts', rank: 8, faceUp: true }
    const state: GolfState = {
      tableau: [[king], [], [], [], [], [], []],
      waste: [eight],
      stock: []
    }
    const move = GolfController.autoMoveHint!(state, { zone: 'tableau', index: 0 }, 'spades-13-0')
    expect(move).toBeNull()
  })
})

describe('Golf scoreHintMove', () => {
  function moveFrom(colIndex: number): Move {
    return { from: { zone: 'tableau', index: colIndex }, to: { zone: 'waste', index: 0 }, count: 1 }
  }

  function scoreOf(state: GolfState, colIndex: number): number {
    return GolfController.scoreHintMove!(state, moveFrom(colIndex))
  }

  it('prefers a move that immediately unlocks a follow-up move over one that dead-ends the board', () => {
    // Column 0: 4 underneath, 5 on top. Column 1: King underneath, 7 on top. Build pile top: 6.
    // Both tops are adjacent to 6, so both are legal right now.
    const four: Card = { id: 'clubs-4-0', suit: 'clubs', rank: 4, faceUp: true }
    const five: Card = { id: 'clubs-5-0', suit: 'clubs', rank: 5, faceUp: true }
    const king: Card = { id: 'spades-13-0', suit: 'spades', rank: 13, faceUp: true }
    const seven: Card = { id: 'hearts-7-0', suit: 'hearts', rank: 7, faceUp: true }
    const six: Card = { id: 'diamonds-6-0', suit: 'diamonds', rank: 6, faceUp: true }
    const state: GolfState = {
      tableau: [[four, five], [king, seven], [], [], [], [], []],
      waste: [six],
      stock: []
    }

    expect(GolfController.legalMoves(state).length).toBe(2)

    // Playing column 0's 5 sets the build pile to 5, which column 0's own newly-exposed 4 is
    // immediately adjacent to - a free follow-up move. Playing column 1's 7 instead sets the build
    // pile to 7, which strands BOTH column 0's un-played 5 (diff 2) and column 1's own
    // newly-exposed King (diff 6) - the board goes dead and a stock draw becomes the only option.
    expect(scoreOf(state, 0)).toBeGreaterThan(scoreOf(state, 1))
  })

  it('prefers a move that permanently empties a column over one that does not, even with equal follow-up mobility', () => {
    // Column 0 is down to its last card (5). Column 1: King underneath, 7 on top. Build pile top: 6.
    // Playing either one strands the other (same dead-end shape as above), so follow-up mobility is
    // equal (zero) for both - isolating the emptying bonus on its own.
    const five: Card = { id: 'clubs-5-0', suit: 'clubs', rank: 5, faceUp: true }
    const king: Card = { id: 'spades-13-0', suit: 'spades', rank: 13, faceUp: true }
    const seven: Card = { id: 'hearts-7-0', suit: 'hearts', rank: 7, faceUp: true }
    const six: Card = { id: 'diamonds-6-0', suit: 'diamonds', rank: 6, faceUp: true }
    const state: GolfState = {
      tableau: [[five], [king, seven], [], [], [], [], []],
      waste: [six],
      stock: []
    }

    expect(scoreOf(state, 0)).toBeGreaterThan(scoreOf(state, 1))
  })

  it('never scores a legal move as non-positive, so Hint never prefers drawing over an available play', () => {
    const king: Card = { id: 'spades-13-0', suit: 'spades', rank: 13, faceUp: true }
    const seven: Card = { id: 'hearts-7-0', suit: 'hearts', rank: 7, faceUp: true }
    const six: Card = { id: 'diamonds-6-0', suit: 'diamonds', rank: 6, faceUp: true }
    const stockCard: Card = { id: 'clubs-2-0', suit: 'clubs', rank: 2, faceUp: false }
    const state: GolfState = {
      tableau: [[king, seven], [], [], [], [], [], []],
      waste: [six],
      stock: [stockCard]
    }

    expect(scoreOf(state, 0)).toBeGreaterThan(0)
  })
})
