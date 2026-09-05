import { Card, SUITS } from '@/engine/types'
import { createKlondikeController, KlondikeState } from '@/games/klondike/rules'

function countCards(state: KlondikeState): number {
  const tableauCount = state.tableau.reduce((sum, col) => sum + col.length, 0)
  const foundationCount = state.foundation.reduce((sum, f) => sum + f.length, 0)
  return tableauCount + foundationCount + state.stock.length + state.waste.length
}

describe('Klondike newGame', () => {
  it('deals a legal starting layout', () => {
    const controller = createKlondikeController(1)
    const state = controller.newGame(12345)

    expect(countCards(state)).toBe(52)
    expect(state.tableau.length).toBe(7)
    expect(state.foundation.length).toBe(4)
    expect(state.waste.length).toBe(0)
    expect(state.stock.length).toBe(24)

    state.tableau.forEach((col, i) => {
      expect(col.length).toBe(i + 1)
      col.forEach((card, idx) => {
        if (idx === col.length - 1) {
          expect(card.faceUp).toBe(true)
        } else {
          expect(card.faceUp).toBe(false)
        }
      })
    })

    state.foundation.forEach((f) => expect(f.length).toBe(0))
    state.stock.forEach((c) => expect(c.faceUp).toBe(false))
  })

  it('is deterministic given the same seed', () => {
    const controller = createKlondikeController(1)
    const a = controller.newGame(42)
    const b = controller.newGame(42)
    expect(a.tableau.map((c) => c.map((x) => x.id))).toEqual(b.tableau.map((c) => c.map((x) => x.id)))
  })
})

describe('Klondike tryMove', () => {
  it('moves a valid card from tableau to tableau without mutating original state', () => {
    const controller = createKlondikeController(1)

    const black8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const redSeven: Card = { id: 'hearts-7-0', suit: 'hearts', rank: 7, faceUp: true }

    const state: KlondikeState = {
      tableau: [[black8], [redSeven], [], [], [], [], []],
      foundation: [[], [], [], []],
      stock: [],
      waste: []
    }
    const snapshot = JSON.parse(JSON.stringify(state))

    const result = controller.tryMove(state, {
      from: { zone: 'tableau', index: 1 },
      to: { zone: 'tableau', index: 0 },
      count: 1
    })

    expect(result).not.toBeNull()
    expect(result!.tableau[0].map((c) => c.id)).toEqual(['clubs-8-0', 'hearts-7-0'])
    expect(result!.tableau[1]).toEqual([])

    // original state unchanged
    expect(state).toEqual(snapshot)
  })

  it('rejects an illegal move (wrong rank/color)', () => {
    const controller = createKlondikeController(1)

    const black8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const blackSix: Card = { id: 'spades-6-0', suit: 'spades', rank: 6, faceUp: true }

    const state: KlondikeState = {
      tableau: [[black8], [blackSix], [], [], [], [], []],
      foundation: [[], [], [], []],
      stock: [],
      waste: []
    }

    // wrong color (both black)
    const result = controller.tryMove(state, {
      from: { zone: 'tableau', index: 1 },
      to: { zone: 'tableau', index: 0 },
      count: 1
    })
    expect(result).toBeNull()
  })

  it('rejects moving from foundation', () => {
    const controller = createKlondikeController(1)
    const ace: Card = { id: 'clubs-1-0', suit: 'clubs', rank: 1, faceUp: true }
    const state: KlondikeState = {
      tableau: [[], [], [], [], [], [], []],
      foundation: [[ace], [], [], []],
      stock: [],
      waste: []
    }
    const result = controller.tryMove(state, {
      from: { zone: 'foundation', index: 0 },
      to: { zone: 'tableau', index: 0 },
      count: 1
    })
    expect(result).toBeNull()
  })

  it('only allows a King to start an empty tableau column', () => {
    const controller = createKlondikeController(1)
    const queen: Card = { id: 'hearts-12-0', suit: 'hearts', rank: 12, faceUp: true }
    const king: Card = { id: 'spades-13-0', suit: 'spades', rank: 13, faceUp: true }

    const stateWithQueen: KlondikeState = {
      tableau: [[queen], [], [], [], [], [], []],
      foundation: [[], [], [], []],
      stock: [],
      waste: []
    }
    expect(
      controller.tryMove(stateWithQueen, {
        from: { zone: 'tableau', index: 0 },
        to: { zone: 'tableau', index: 1 },
        count: 1
      })
    ).toBeNull()

    const stateWithKing: KlondikeState = {
      tableau: [[king], [], [], [], [], [], []],
      foundation: [[], [], [], []],
      stock: [],
      waste: []
    }
    const result = controller.tryMove(stateWithKing, {
      from: { zone: 'tableau', index: 0 },
      to: { zone: 'tableau', index: 1 },
      count: 1
    })
    expect(result).not.toBeNull()
    expect(result!.tableau[1].map((c) => c.id)).toEqual(['spades-13-0'])
  })

  it('reveals the new top card of the source tableau column after a move', () => {
    const controller = createKlondikeController(1)
    const hiddenCard: Card = { id: 'diamonds-2-0', suit: 'diamonds', rank: 2, faceUp: false }
    const black8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const redNine: Card = { id: 'hearts-9-0', suit: 'hearts', rank: 9, faceUp: true }

    const state: KlondikeState = {
      tableau: [[hiddenCard, black8], [redNine], [], [], [], [], []],
      foundation: [[], [], [], []],
      stock: [],
      waste: []
    }

    const result = controller.tryMove(state, {
      from: { zone: 'tableau', index: 0 },
      to: { zone: 'tableau', index: 1 },
      count: 1
    })
    expect(result).not.toBeNull()
    expect(result!.tableau[0].length).toBe(1)
    expect(result!.tableau[0][0].faceUp).toBe(true)
  })

  it('moves a single card from waste to foundation', () => {
    const controller = createKlondikeController(1)
    const ace: Card = { id: 'clubs-1-0', suit: 'clubs', rank: 1, faceUp: true }
    const state: KlondikeState = {
      tableau: [[], [], [], [], [], [], []],
      foundation: [[], [], [], []],
      stock: [],
      waste: [ace]
    }
    const result = controller.tryMove(state, {
      from: { zone: 'waste', index: 0 },
      to: { zone: 'foundation', index: SUITS.indexOf('clubs') },
      count: 1
    })
    expect(result).not.toBeNull()
    expect(result!.foundation[SUITS.indexOf('clubs')].map((c) => c.id)).toEqual(['clubs-1-0'])
    expect(result!.waste.length).toBe(0)
  })
})

describe('Klondike isWon', () => {
  it('returns true when all foundations are complete (Ace..King)', () => {
    const controller = createKlondikeController(1)
    const foundation: Card[][] = SUITS.map((suit) => {
      const pile: Card[] = []
      for (let rank = 1; rank <= 13; rank++) {
        pile.push({ id: `${suit}-${rank}-0`, suit, rank: rank as Card['rank'], faceUp: true })
      }
      return pile
    })
    const state: KlondikeState = {
      tableau: [[], [], [], [], [], [], []],
      foundation,
      stock: [],
      waste: []
    }
    expect(controller.isWon(state)).toBe(true)
  })

  it('returns false when foundations are incomplete', () => {
    const controller = createKlondikeController(1)
    const ace: Card = { id: 'clubs-1-0', suit: 'clubs', rank: 1, faceUp: true }
    const state: KlondikeState = {
      tableau: [[], [], [], [], [], [], []],
      foundation: [[ace], [], [], []],
      stock: [],
      waste: []
    }
    expect(controller.isWon(state)).toBe(false)
  })
})

describe('Klondike drawStock', () => {
  it('draws drawCount cards face-up onto waste', () => {
    const controller = createKlondikeController(3)
    const stock: Card[] = [
      { id: 'clubs-2-0', suit: 'clubs', rank: 2, faceUp: false },
      { id: 'clubs-3-0', suit: 'clubs', rank: 3, faceUp: false },
      { id: 'clubs-4-0', suit: 'clubs', rank: 4, faceUp: false },
      { id: 'clubs-5-0', suit: 'clubs', rank: 5, faceUp: false }
    ]
    const state: KlondikeState = {
      tableau: [[], [], [], [], [], [], []],
      foundation: [[], [], [], []],
      stock,
      waste: []
    }
    const result = controller.drawStock!(state)
    expect(result).not.toBeNull()
    expect(result!.stock.length).toBe(1)
    expect(result!.waste.length).toBe(3)
    expect(result!.waste.every((c) => c.faceUp)).toBe(true)
    // last-drawn card (top of original stock) is now the visible top of waste
    expect(result!.waste[result!.waste.length - 1].id).toBe('clubs-5-0')
  })

  it('recycles waste back to stock face-down, reversed, when stock is empty', () => {
    const controller = createKlondikeController(1)
    const waste: Card[] = [
      { id: 'clubs-2-0', suit: 'clubs', rank: 2, faceUp: true },
      { id: 'clubs-3-0', suit: 'clubs', rank: 3, faceUp: true },
      { id: 'clubs-4-0', suit: 'clubs', rank: 4, faceUp: true }
    ]
    const state: KlondikeState = {
      tableau: [[], [], [], [], [], [], []],
      foundation: [[], [], [], []],
      stock: [],
      waste
    }
    const result = controller.drawStock!(state)
    expect(result).not.toBeNull()
    expect(result!.waste.length).toBe(0)
    expect(result!.stock.length).toBe(3)
    expect(result!.stock.every((c) => !c.faceUp)).toBe(true)
    // reversed order: last card of waste becomes bottom... drawing again should reproduce order
    expect(result!.stock.map((c) => c.id)).toEqual(['clubs-4-0', 'clubs-3-0', 'clubs-2-0'])
  })

  it('returns null when both stock and waste are empty', () => {
    const controller = createKlondikeController(1)
    const state: KlondikeState = {
      tableau: [[], [], [], [], [], [], []],
      foundation: [[], [], [], []],
      stock: [],
      waste: []
    }
    expect(controller.drawStock!(state)).toBeNull()
  })
})
