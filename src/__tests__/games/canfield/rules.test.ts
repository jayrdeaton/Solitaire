import { isFullyAutoCompletable, isFullyAutoCompletableWithDraws } from '@/engine/autoFoundation'
import { PileRef } from '@/engine/gameTypes'
import { Card, Suit, SUITS } from '@/engine/types'
import { canAutoFinish, CanfieldState, createCanfieldController, findSafeAutoPlay, isSafeAutoPlay, nextFinishMove } from '@/games/canfield/rules'

// Every test here exercises drawCount-independent behavior except the "Canfield drawStock" block
// below, which specifically tests the draw-3 default (settings.canfieldDraw's default value) - one
// shared controller instance for the whole file, same as this file always assumed a single fixed
// draw count before canfieldDraw became a setting.
const CanfieldController = createCanfieldController(3)

function countCards(state: CanfieldState): number {
  const tableauCount = state.tableau.reduce((sum, col) => sum + col.length, 0)
  const foundationCount = state.foundation.reduce((sum, f) => sum + f.length, 0)
  return tableauCount + foundationCount + state.reserve.length + state.stock.length + state.waste.length
}

describe('Canfield newGame', () => {
  it('deals a legal starting layout', () => {
    const state = CanfieldController.newGame(12345)

    expect(countCards(state)).toBe(52)
    expect(state.tableau.length).toBe(4)
    state.tableau.forEach((col) => {
      expect(col.length).toBe(1)
      expect(col[0].faceUp).toBe(true)
    })

    expect(state.foundation.length).toBe(4)
    const nonEmpty = state.foundation.filter((f) => f.length > 0)
    expect(nonEmpty.length).toBe(1)
    expect(nonEmpty[0][0].rank).toBe(state.foundationRank)

    expect(state.reserve.length).toBe(13)
    state.reserve.forEach((c, i) => expect(c.faceUp).toBe(i === 12))

    expect(state.waste.length).toBe(0)
    expect(state.stock.length).toBe(34)
    state.stock.forEach((c) => expect(c.faceUp).toBe(false))
  })

  it('is deterministic given the same seed', () => {
    const a = CanfieldController.newGame(42)
    const b = CanfieldController.newGame(42)
    expect(a.foundationRank).toBe(b.foundationRank)
    expect(a.tableau.map((c) => c.map((x) => x.id))).toEqual(b.tableau.map((c) => c.map((x) => x.id)))
    expect(a.reserve.map((x) => x.id)).toEqual(b.reserve.map((x) => x.id))
  })
})

describe('Canfield tableau tryMove', () => {
  it('moves a single card onto a descending, opposite-color target', () => {
    const black8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const redSeven: Card = { id: 'hearts-7-0', suit: 'hearts', rank: 7, faceUp: true }
    const state: CanfieldState = {
      tableau: [[black8], [redSeven], [], []],
      foundation: [[], [], [], []],
      foundationRank: 1,
      reserve: [],
      stock: [],
      waste: []
    }
    const result = CanfieldController.tryMove(state, { from: { zone: 'tableau', index: 1 }, to: { zone: 'tableau', index: 0 }, count: 1 })
    expect(result).not.toBeNull()
    expect(result!.tableau[0].map((c) => c.id)).toEqual(['clubs-8-0', 'hearts-7-0'])
  })

  it('wraps a King onto an Ace, unlike every other game in this app', () => {
    const redAce: Card = { id: 'hearts-1-0', suit: 'hearts', rank: 1, faceUp: true }
    const blackKing: Card = { id: 'clubs-13-0', suit: 'clubs', rank: 13, faceUp: true }
    const state: CanfieldState = {
      tableau: [[redAce], [blackKing], [], []],
      foundation: [[], [], [], []],
      foundationRank: 1,
      reserve: [],
      stock: [],
      waste: []
    }
    const result = CanfieldController.tryMove(state, { from: { zone: 'tableau', index: 1 }, to: { zone: 'tableau', index: 0 }, count: 1 })
    expect(result).not.toBeNull()
    expect(result!.tableau[0].map((c) => c.id)).toEqual(['hearts-1-0', 'clubs-13-0'])
  })

  it('rejects same-color or non-adjacent placement', () => {
    const black8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const blackSeven: Card = { id: 'spades-7-0', suit: 'spades', rank: 7, faceUp: true }
    const state: CanfieldState = {
      tableau: [[black8], [blackSeven], [], []],
      foundation: [[], [], [], []],
      foundationRank: 1,
      reserve: [],
      stock: [],
      waste: []
    }
    const result = CanfieldController.tryMove(state, { from: { zone: 'tableau', index: 1 }, to: { zone: 'tableau', index: 0 }, count: 1 })
    expect(result).toBeNull()
  })

  it('moves a multi-card wrapping run as one group', () => {
    // ace(red, bottom of the run) then king(black, on top of it) - a valid cyclic 2-card run - onto
    // a black 2, since the run's BOTTOM card (the ace) is what attaches to the destination, not the
    // king on top of it.
    const redAce: Card = { id: 'hearts-1-0', suit: 'hearts', rank: 1, faceUp: true }
    const blackKing: Card = { id: 'clubs-13-0', suit: 'clubs', rank: 13, faceUp: true }
    const blackTwo: Card = { id: 'spades-2-0', suit: 'spades', rank: 2, faceUp: true }
    const state: CanfieldState = {
      tableau: [[redAce, blackKing], [blackTwo], [], []],
      foundation: [[], [], [], []],
      foundationRank: 1,
      reserve: [],
      stock: [],
      waste: []
    }
    const result = CanfieldController.tryMove(state, { from: { zone: 'tableau', index: 0 }, to: { zone: 'tableau', index: 1 }, count: 2 })
    expect(result).not.toBeNull()
    expect(result!.tableau[1].map((c) => c.id)).toEqual(['spades-2-0', 'hearts-1-0', 'clubs-13-0'])
    expect(result!.tableau[0]).toEqual([])
  })
})

describe('Canfield empty tableau column - reserve priority', () => {
  const wasteCard: Card = { id: 'clubs-5-0', suit: 'clubs', rank: 5, faceUp: true }
  const reserveTop: Card = { id: 'hearts-9-0', suit: 'hearts', rank: 9, faceUp: true }

  it('rejects a waste card filling an empty column while the reserve still has cards', () => {
    const state: CanfieldState = {
      tableau: [[], [], [], []],
      foundation: [[], [], [], []],
      foundationRank: 1,
      reserve: [reserveTop],
      stock: [],
      waste: [wasteCard]
    }
    const result = CanfieldController.tryMove(state, { from: { zone: 'waste', index: 0 }, to: { zone: 'tableau', index: 0 }, count: 1 })
    expect(result).toBeNull()
  })

  it('accepts a reserve card filling an empty column', () => {
    const state: CanfieldState = {
      tableau: [[], [], [], []],
      foundation: [[], [], [], []],
      foundationRank: 1,
      reserve: [reserveTop],
      stock: [],
      waste: [wasteCard]
    }
    const result = CanfieldController.tryMove(state, { from: { zone: 'reserve', index: 0 }, to: { zone: 'tableau', index: 0 }, count: 1 })
    expect(result).not.toBeNull()
    expect(result!.tableau[0].map((c) => c.id)).toEqual(['hearts-9-0'])
  })

  it('accepts a waste card filling an empty column once the reserve is exhausted', () => {
    const state: CanfieldState = {
      tableau: [[], [], [], []],
      foundation: [[], [], [], []],
      foundationRank: 1,
      reserve: [],
      stock: [],
      waste: [wasteCard]
    }
    const result = CanfieldController.tryMove(state, { from: { zone: 'waste', index: 0 }, to: { zone: 'tableau', index: 0 }, count: 1 })
    expect(result).not.toBeNull()
  })

  it('reveals the next reserve card after its top card is played', () => {
    const hidden: Card = { id: 'spades-2-0', suit: 'spades', rank: 2, faceUp: false }
    const state: CanfieldState = {
      tableau: [[], [], [], []],
      foundation: [[], [], [], []],
      foundationRank: 1,
      reserve: [hidden, reserveTop],
      stock: [],
      waste: []
    }
    const result = CanfieldController.tryMove(state, { from: { zone: 'reserve', index: 0 }, to: { zone: 'tableau', index: 0 }, count: 1 })
    expect(result).not.toBeNull()
    expect(result!.reserve.length).toBe(1)
    expect(result!.reserve[0].faceUp).toBe(true)
  })
})

describe('Canfield foundation tryMove', () => {
  it('accepts the foundation rank onto an empty foundation, and rejects any other rank', () => {
    const seven: Card = { id: 'hearts-7-0', suit: 'hearts', rank: 7, faceUp: true }
    const eight: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const state: CanfieldState = {
      tableau: [[seven], [eight], [], []],
      foundation: [[], [], [], []],
      foundationRank: 7,
      reserve: [],
      stock: [],
      waste: []
    }
    expect(CanfieldController.tryMove(state, { from: { zone: 'tableau', index: 1 }, to: { zone: 'foundation', index: SUITS.indexOf('clubs') }, count: 1 })).toBeNull()
    const result = CanfieldController.tryMove(state, { from: { zone: 'tableau', index: 0 }, to: { zone: 'foundation', index: SUITS.indexOf('hearts') }, count: 1 })
    expect(result).not.toBeNull()
    expect(result!.foundation[SUITS.indexOf('hearts')].map((c) => c.id)).toEqual(['hearts-7-0'])
  })

  it('wraps King up to Ace on a non-Ace-starting foundation', () => {
    const king: Card = { id: 'hearts-13-0', suit: 'hearts', rank: 13, faceUp: true }
    const ace: Card = { id: 'hearts-1-0', suit: 'hearts', rank: 1, faceUp: true }
    const state: CanfieldState = {
      tableau: [[ace], [], [], []],
      foundation: SUITS.map((s) => (s === 'hearts' ? [king] : [])),
      foundationRank: 5,
      reserve: [],
      stock: [],
      waste: []
    }
    const result = CanfieldController.tryMove(state, { from: { zone: 'tableau', index: 0 }, to: { zone: 'foundation', index: SUITS.indexOf('hearts') }, count: 1 })
    expect(result).not.toBeNull()
    expect(result!.foundation[SUITS.indexOf('hearts')].map((c) => c.id)).toEqual(['hearts-13-0', 'hearts-1-0'])
  })

  it("lets a foundation's top card come back down onto a legal tableau spot - wrapping, and the starter included", () => {
    const hearts = SUITS.indexOf('hearts')
    const king: Card = { id: 'hearts-13-0', suit: 'hearts', rank: 13, faceUp: true }
    const ace: Card = { id: 'hearts-1-0', suit: 'hearts', rank: 1, faceUp: true }
    const blackAce: Card = { id: 'spades-1-0', suit: 'spades', rank: 1, faceUp: true }
    const blackTwo: Card = { id: 'clubs-2-0', suit: 'clubs', rank: 2, faceUp: true }
    const state: CanfieldState = {
      tableau: [[blackTwo], [blackAce], [], []],
      foundation: SUITS.map((s) => (s === 'hearts' ? [king, ace] : [])),
      foundationRank: 13,
      reserve: [],
      stock: [],
      waste: []
    }
    const from = { zone: 'foundation' as const, index: hearts }
    const afterAce = CanfieldController.tryMove(state, { from, to: { zone: 'tableau', index: 0 }, count: 1 })
    expect(afterAce).not.toBeNull()
    expect(afterAce!.tableau[0].map((c) => c.id)).toEqual(['clubs-2-0', 'hearts-1-0'])
    // The starter (a King here) goes on an Ace - the tableau wraps too - and its foundation needs a King again.
    const afterStarter = CanfieldController.tryMove(afterAce!, { from, to: { zone: 'tableau', index: 1 }, count: 1 })
    expect(afterStarter).not.toBeNull()
    expect(afterStarter!.foundation[hearts]).toEqual([])
    expect(afterStarter!.tableau[1].map((c) => c.id)).toEqual(['spades-1-0', 'hearts-13-0'])
  })

  it('refuses a foundation card on an empty column while the reserve has cards, on another foundation, or two at a time', () => {
    const hearts = SUITS.indexOf('hearts')
    const seven: Card = { id: 'hearts-7-0', suit: 'hearts', rank: 7, faceUp: true }
    const eight: Card = { id: 'hearts-8-0', suit: 'hearts', rank: 8, faceUp: true }
    const nine: Card = { id: 'spades-9-0', suit: 'spades', rank: 9, faceUp: true }
    const reserveTop: Card = { id: 'clubs-4-0', suit: 'clubs', rank: 4, faceUp: true }
    const state: CanfieldState = {
      tableau: [[nine], [], [], []],
      foundation: SUITS.map((s) => (s === 'hearts' ? [seven, eight] : [])),
      foundationRank: 7,
      reserve: [reserveTop],
      stock: [],
      waste: []
    }
    const from = { zone: 'foundation' as const, index: hearts }
    expect(CanfieldController.tryMove(state, { from, to: { zone: 'tableau', index: 1 }, count: 1 })).toBeNull() // empty columns take the reserve
    expect(CanfieldController.tryMove({ ...state, reserve: [] }, { from, to: { zone: 'tableau', index: 1 }, count: 1 })).not.toBeNull()
    expect(CanfieldController.tryMove(state, { from, to: { zone: 'foundation', index: SUITS.indexOf('clubs') }, count: 1 })).toBeNull()
    expect(CanfieldController.tryMove(state, { from, to: { zone: 'tableau', index: 0 }, count: 2 })).toBeNull()
    expect(CanfieldController.tryMove(state, { from, to: { zone: 'tableau', index: 0 }, count: 1 })).not.toBeNull() // 8 on 9
    expect(CanfieldController.legalMoves(state).filter((m) => m.from.zone === 'foundation')).toEqual([])
  })
})

describe('Canfield drawStock', () => {
  it('draws up to 3 cards face-up onto waste', () => {
    const stock: Card[] = [1, 2, 3, 4].map((r) => ({ id: `clubs-${r}-0`, suit: 'clubs', rank: r as Card['rank'], faceUp: false }))
    const state: CanfieldState = { tableau: [[], [], [], []], foundation: [[], [], [], []], foundationRank: 1, reserve: [], stock, waste: [] }
    const result = CanfieldController.drawStock!(state)
    expect(result).not.toBeNull()
    expect(result!.stock.length).toBe(1)
    expect(result!.waste.length).toBe(3)
    expect(result!.waste.every((c) => c.faceUp)).toBe(true)
  })

  it('recycles waste back to stock, reversed, once stock is empty', () => {
    const waste: Card[] = [1, 2].map((r) => ({ id: `clubs-${r}-0`, suit: 'clubs', rank: r as Card['rank'], faceUp: true }))
    const state: CanfieldState = { tableau: [[], [], [], []], foundation: [[], [], [], []], foundationRank: 1, reserve: [], stock: [], waste }
    const result = CanfieldController.drawStock!(state)
    expect(result).not.toBeNull()
    expect(result!.stock.map((c) => c.id)).toEqual(['clubs-2-0', 'clubs-1-0'])
    expect(result!.waste.length).toBe(0)
  })
})

describe('Canfield isWon', () => {
  it('returns true only once every foundation has all 13 cards', () => {
    const full: Card[] = Array.from({ length: 13 }, (_, i) => ({ id: `hearts-${i}-0`, suit: 'hearts', rank: ((i % 13) + 1) as Card['rank'], faceUp: true }))
    const state: CanfieldState = { tableau: [[], [], [], []], foundation: [full, full, full, full], foundationRank: 1, reserve: [], stock: [], waste: [] }
    expect(CanfieldController.isWon(state)).toBe(true)
  })

  it('returns false while any foundation is short', () => {
    const state: CanfieldState = { tableau: [[], [], [], []], foundation: [[], [], [], []], foundationRank: 1, reserve: [], stock: [], waste: [] }
    expect(CanfieldController.isWon(state)).toBe(false)
  })
})

describe('Canfield isSafeAutoPlay / findSafeAutoPlay (cyclic, non-Ace-starting)', () => {
  it('treats a card as safe once both opposite-color foundations have advanced as far as its own cyclic position', () => {
    // foundationRank 5: cyclic order is 5,6,7,...,K,A,2,3,4. Rank 7's cyclic position is 2.
    const redSeven: Card = { id: 'hearts-7-0', suit: 'hearts', rank: 7, faceUp: true }
    const blackFilled = [
      { id: 'clubs-5-0', suit: 'clubs', rank: 5, faceUp: true },
      { id: 'clubs-6-0', suit: 'clubs', rank: 6, faceUp: true }
    ] as Card[]
    const state: CanfieldState = {
      tableau: [[], [], [], []],
      foundation: [blackFilled, [], [], blackFilled.slice(0, 1)], // clubs at position 2, spades at position 1 (both black)
      foundationRank: 5,
      reserve: [],
      stock: [],
      waste: []
    }
    expect(isSafeAutoPlay(state, redSeven)).toBe(false) // spades only at position 1, needs 2

    const state2: CanfieldState = { ...state, foundation: [blackFilled, [], [], blackFilled] }
    expect(isSafeAutoPlay(state2, redSeven)).toBe(true)
  })

  it('findSafeAutoPlay returns the accessible card once both its foundation move and its safety check pass', () => {
    const redSeven: Card = { id: 'hearts-7-0', suit: 'hearts', rank: 7, faceUp: true }
    const heartsAt6 = [
      { id: 'hearts-5-0', suit: 'hearts', rank: 5, faceUp: true },
      { id: 'hearts-6-0', suit: 'hearts', rank: 6, faceUp: true }
    ] as Card[]
    const blackAt2 = [
      { id: 'clubs-5-0', suit: 'clubs', rank: 5, faceUp: true },
      { id: 'clubs-6-0', suit: 'clubs', rank: 6, faceUp: true }
    ] as Card[]
    const state: CanfieldState = {
      tableau: [[], [], [], []],
      foundation: [blackAt2, [], heartsAt6, blackAt2],
      foundationRank: 5,
      reserve: [],
      stock: [],
      waste: []
    }
    const accessible = [{ ref: { zone: 'tableau' as const, index: 0 }, card: redSeven }]
    const found = findSafeAutoPlay(state, accessible)
    expect(found?.card.id).toBe('hearts-7-0')
  })

  it('plays a foundation-starting-rank card sitting on the waste (just drawn from stock) immediately, same as anywhere else', () => {
    const startRankCard: Card = { id: 'hearts-5-0', suit: 'hearts', rank: 5, faceUp: true }
    const state: CanfieldState = { tableau: [[], [], [], []], foundation: [[], [], [], []], foundationRank: 5, reserve: [], stock: [], waste: [] }
    const accessible = [{ ref: { zone: 'waste' as const, index: 0 }, card: startRankCard }]
    expect(findSafeAutoPlay(state, accessible)?.card.id).toBe('hearts-5-0')
  })
})

describe('Canfield canAutoFinish / nextFinishMove (a solved board: what the finish files away on its own)', () => {
  const c = (suit: Suit, rank: number, faceUp = true): Card => ({ id: `${suit}-${rank}-0`, suit, rank, faceUp }) as Card
  /** The first `count` cards of `suit`'s foundation cycle from the 5 (5, 6, ..., K, A, 2, 3, 4). */
  const cycle = (suit: Suit, count: number): Card[] => Array.from({ length: count }, (_, i) => c(suit, ((4 + i) % 13) + 1))
  /** A complete deck, foundationRank 5. Hearts and spades are home, clubs is up to its 2 and diamonds to its Q, and the
   * 7 cards left (the diamond K, A, 2, 3, 4 and the club 3, 4) wrap past the King. Nothing is hidden, nothing left to draw,
   * and every card can go up by foundation moves alone. */
  function solved(parts: Partial<CanfieldState> = {}): CanfieldState {
    return {
      tableau: [[c('diamonds', 4), c('clubs', 3)], [c('clubs', 4), c('diamonds', 3)], [c('diamonds', 2), c('diamonds', 13)], [c('diamonds', 1)]],
      foundation: [cycle('clubs', 11), cycle('diamonds', 8), cycle('hearts', 13), cycle('spades', 13)],
      foundationRank: 5,
      reserve: [],
      stock: [],
      waste: [],
      ...parts
    }
  }
  /** solved(), with its diamond Ace (alone in the last column) somewhere else. */
  const aceIn = (parts: Partial<CanfieldState>) => solved({ tableau: [...solved().tableau.slice(0, 3), []], ...parts })

  it('is true on a solved board, and nextFinishMove walks it to the win one card at a time, each to its own suit foundation, wrapping past the King', () => {
    let s = solved()
    const sent: string[] = []
    while (canAutoFinish(CanfieldController, s)) {
      const step = nextFinishMove(CanfieldController, s)
      expect(step).not.toBeNull()
      expect(step!.to).toEqual({ zone: 'foundation', index: SUITS.indexOf(step!.entry.card.suit) })
      sent.push(step!.entry.card.id)
      const next = CanfieldController.tryMove(s, { from: step!.entry.ref, to: step!.to, count: 1 })
      expect(next).not.toBeNull()
      s = next!
    }
    expect(sent).toEqual(['clubs-3-0', 'diamonds-13-0', 'diamonds-1-0', 'diamonds-2-0', 'diamonds-3-0', 'diamonds-4-0', 'clubs-4-0'])
    expect(CanfieldController.isWon(s)).toBe(true)
  })

  it('is false on a won board, although isFullyAutoCompletable says true there', () => {
    const won = solved({ tableau: [[], [], [], []], foundation: SUITS.map((suit) => cycle(suit, 13)) })
    expect(CanfieldController.isWon(won)).toBe(true)
    expect(isFullyAutoCompletable(CanfieldController, won)).toBe(true)
    expect(canAutoFinish(CanfieldController, won)).toBe(false)
    expect(nextFinishMove(CanfieldController, won)).toBeNull()
  })

  it('is false while the reserve, the stock or the waste holds a card, even one that could go straight up', () => {
    const inReserve = aceIn({ reserve: [c('diamonds', 1)] })
    const inWaste = aceIn({ waste: [c('diamonds', 1)] })
    const inStock = aceIn({ stock: [c('diamonds', 1, false)] })
    // Every one of these would clear: the plain check (which reads the reserve and waste tops) or the draws-aware one (which
    // also turns the stock over) says so...
    expect(isFullyAutoCompletable(CanfieldController, inReserve)).toBe(true)
    expect(isFullyAutoCompletable(CanfieldController, inWaste)).toBe(true)
    expect(isFullyAutoCompletableWithDraws(CanfieldController, inStock)).toBe(true)
    // The plain check never draws, so it already says no for the stock: canAutoFinish's own stock check is belt-and-braces,
    // and the stock case below pins the answer, not that check. The reserve and waste cases do need theirs.
    expect(isFullyAutoCompletable(CanfieldController, inStock)).toBe(false)
    // ...but nothing may go up by itself until the player has emptied those piles.
    for (const s of [inReserve, inWaste, inStock]) {
      expect(canAutoFinish(CanfieldController, s)).toBe(false)
      expect(nextFinishMove(CanfieldController, s)).toBeNull()
    }
  })

  it('never reads a hidden card to decide: a face-down card under the reserve top keeps it off, and so does one in a column', () => {
    // The reserve's Ace goes up, which turns over the 2 under it - the plain check would count on a card nobody has seen.
    const hiddenUnderReserve = solved({ tableau: [[c('diamonds', 4), c('clubs', 3)], [c('clubs', 4), c('diamonds', 3)], [c('diamonds', 13)], []], reserve: [c('diamonds', 2, false), c('diamonds', 1)] })
    expect(isFullyAutoCompletable(CanfieldController, hiddenUnderReserve)).toBe(true)
    expect(canAutoFinish(CanfieldController, hiddenUnderReserve)).toBe(false)
    // A face-down column card the plain check already refuses (accessibleCards skips a face-down top, and tryMove never turns
    // a column card over), so canAutoFinish's own face-down check is belt-and-braces: this pins the answer, not that check.
    const faceDownInColumn = aceIn({ tableau: [...solved().tableau.slice(0, 3), [c('diamonds', 1, false)]] })
    expect(isFullyAutoCompletable(CanfieldController, faceDownInColumn)).toBe(false)
    expect(canAutoFinish(CanfieldController, faceDownInColumn)).toBe(false)
  })

  it('is false when a card is stuck under another of its own suit, with nothing hidden', () => {
    // The club 4 sits on the club 3 it has to follow up.
    const stuck = solved({ tableau: [[c('clubs', 3), c('clubs', 4)], [c('diamonds', 4), c('diamonds', 3)], [c('diamonds', 2), c('diamonds', 13)], [c('diamonds', 1)]] })
    expect(canAutoFinish(CanfieldController, stuck)).toBe(false)
    expect(nextFinishMove(CanfieldController, stuck)).toBeNull()
  })
})

describe('Canfield scoreHintMove', () => {
  function moveTo(state: CanfieldState, from: PileRef, count: number, to: PileRef) {
    const move = CanfieldController.legalMoves(state).find((m) => m.from.zone === from.zone && m.from.index === from.index && m.count === count && m.to.zone === to.zone && m.to.index === to.index)
    if (!move) throw new Error(`expected a legal move from=${JSON.stringify(from)} count=${count} to=${JSON.stringify(to)}`)
    return move
  }

  function scoreOf(state: CanfieldState, from: PileRef, count: number, to: PileRef): number {
    return CanfieldController.scoreHintMove!(state, moveTo(state, from, count, to))
  }

  // Regression-shaped test for the same class of bug Spider's own scoreHintMove was built to catch:
  // tearing a single card off the top of a nice coherent wrapping run just to park it on some
  // unrelated matching card, when the whole run could have relocated intact instead.
  it('never prefers fragmenting a coherent wrapping run over relocating it intact', () => {
    const black8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const red7: Card = { id: 'hearts-7-0', suit: 'hearts', rank: 7, faceUp: true }
    const black6: Card = { id: 'spades-6-0', suit: 'spades', rank: 6, faceUp: true }
    const state: CanfieldState = {
      tableau: [
        [black8, red7, black6], // a coherent 3-run: 8(black)-7(red)-6(black)
        [{ id: 'diamonds-7-0', suit: 'diamonds', rank: 7, faceUp: true }], // only the lone 6 fits here
        [{ id: 'diamonds-9-0', suit: 'diamonds', rank: 9, faceUp: true }], // the whole 3-run fits here
        [{ id: 'clubs-10-0', suit: 'clubs', rank: 10, faceUp: true }] // unrelated, for the waste move
      ],
      foundation: [[], [], [], []],
      foundationRank: 1,
      reserve: [],
      stock: [],
      waste: [{ id: 'hearts-9-0', suit: 'hearts', rank: 9, faceUp: true }]
    }

    const fragmentPartial = scoreOf(state, { zone: 'tableau', index: 0 }, 1, { zone: 'tableau', index: 1 }) // rips the 6 off, onto the lone 7
    const intactRelocation = scoreOf(state, { zone: 'tableau', index: 0 }, 3, { zone: 'tableau', index: 2 }) // the whole run, kept together
    const harmlessSingle = scoreOf(state, { zone: 'waste', index: 0 }, 1, { zone: 'tableau', index: 3 }) // unrelated single-card move, for scale

    expect(intactRelocation).toBeGreaterThan(harmlessSingle)
    expect(fragmentPartial).toBeLessThan(harmlessSingle)
    expect(fragmentPartial).toBeLessThan(0)
  })

  // Canfield's tableau has no face-down cards at all (see rules.ts), so there's no tableau-side
  // reveal bonus to give - the reserve is this game's own hidden-info pile instead, and draining it
  // should rank far above an ordinary tableau consolidation that reveals/depletes nothing.
  it('ranks depleting the reserve far above a plain tableau consolidation', () => {
    const state: CanfieldState = {
      tableau: [
        [{ id: 'clubs-6-0', suit: 'clubs', rank: 6, faceUp: true }], // accepts the reserve's red 5
        [{ id: 'diamonds-9-0', suit: 'diamonds', rank: 9, faceUp: true }],
        [
          { id: 'diamonds-2-0', suit: 'diamonds', rank: 2, faceUp: true },
          { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true } // unrelated to the diamonds-2 below it - lone run of 1
        ],
        [{ id: 'spades-4-0', suit: 'spades', rank: 4, faceUp: true }] // unused filler
      ],
      foundation: [[], [], [], []],
      foundationRank: 1,
      reserve: [
        { id: 'spades-2-0', suit: 'spades', rank: 2, faceUp: false },
        { id: 'hearts-5-0', suit: 'hearts', rank: 5, faceUp: true }
      ],
      stock: [],
      waste: []
    }

    const depletesReserve = scoreOf(state, { zone: 'reserve', index: 0 }, 1, { zone: 'tableau', index: 0 }) // reserve's 5 -> the 6
    const plainConsolidation = scoreOf(state, { zone: 'tableau', index: 2 }, 1, { zone: 'tableau', index: 1 }) // the lone 8 -> the 9, nothing revealed

    expect(depletesReserve).toBeGreaterThan(plainConsolidation)
    expect(depletesReserve).toBeGreaterThan(400) // comfortably clears the run/empty-column range
  })

  // Once the reserve is exhausted, any single card may fill an empty tableau column (same relaxed
  // rule Yukon has from the start) - an empty column is a resource whose net CHANGE matters, not a
  // flat bonus for touching one: freeing a column while also extending a run should beat a lateral
  // empty-for-empty wash, which should in turn beat fragmenting a good run just to spend the column.
  it('treats an empty tableau column as a resource whose net change matters, not a flat bonus', () => {
    const state: CanfieldState = {
      tableau: [
        [{ id: 'clubs-5-0', suit: 'clubs', rank: 5, faceUp: true }], // lone card: extends col1's run, or washes into the empty col3
        [
          { id: 'clubs-9-0', suit: 'clubs', rank: 9, faceUp: true },
          { id: 'hearts-8-0', suit: 'hearts', rank: 8, faceUp: true },
          { id: 'spades-7-0', suit: 'spades', rank: 7, faceUp: true },
          { id: 'diamonds-6-0', suit: 'diamonds', rank: 6, faceUp: true }
        ], // a coherent 4-run
        [
          { id: 'spades-10-0', suit: 'spades', rank: 10, faceUp: true },
          { id: 'hearts-9-0', suit: 'hearts', rank: 9, faceUp: true }
        ], // a coherent 2-run - fragmenting it spends the empty column for a net loss
        [] // empty - reserve is exhausted, so any single card may land here
      ],
      foundation: [[], [], [], []],
      foundationRank: 1,
      reserve: [],
      stock: [],
      waste: []
    }

    const extendsRunAndFreesColumn = scoreOf(state, { zone: 'tableau', index: 0 }, 1, { zone: 'tableau', index: 1 }) // 5 -> the 4-run, frees col0
    const lateralIntoEmptyColumn = scoreOf(state, { zone: 'tableau', index: 0 }, 1, { zone: 'tableau', index: 3 }) // 5 -> empty col3, a wash
    const fragmentIntoEmptyColumn = scoreOf(state, { zone: 'tableau', index: 2 }, 1, { zone: 'tableau', index: 3 }) // rips the 9 off the 2-run, spends the empty column

    expect(extendsRunAndFreesColumn).toBeGreaterThan(lateralIntoEmptyColumn)
    expect(lateralIntoEmptyColumn).toBeGreaterThan(fragmentIntoEmptyColumn)
  })
})
