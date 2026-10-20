import { isFullyAutoCompletable, isFullyAutoCompletableWithDraws } from '@/engine/autoFoundation'
import { FOUNDATION_SUITS } from '@/engine/foundation'
import { findHint } from '@/engine/hint'
import { Card } from '@/engine/types'
import { canAutoFinish, createKlondikeController, KlondikeState, nextFinishMove } from '@/games/klondike/rules'

function card(suit: Card['suit'], rank: Card['rank'], faceUp = true, deckIndex = 0): Card {
  return { id: `${suit}-${rank}-${deckIndex}`, suit, rank, faceUp }
}

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

  it("lets a foundation's top card come back down onto a legal tableau spot", () => {
    const controller = createKlondikeController(1)
    const clubs = FOUNDATION_SUITS.indexOf('clubs')
    const state: KlondikeState = {
      tableau: [[card('hearts', 3)], [], [], [], [], [], []],
      foundation: FOUNDATION_SUITS.map((s) => (s === 'clubs' ? [card('clubs', 1), card('clubs', 2)] : [])),
      stock: [],
      waste: []
    }
    const result = controller.tryMove(state, { from: { zone: 'foundation', index: clubs }, to: { zone: 'tableau', index: 0 }, count: 1 })
    expect(result).not.toBeNull()
    expect(result!.foundation[clubs].map((c) => c.id)).toEqual(['clubs-1-0'])
    expect(result!.tableau[0].map((c) => c.id)).toEqual(['hearts-3-0', 'clubs-2-0'])
  })

  it('refuses a foundation card anywhere but a legal tableau spot, and more than one card at a time', () => {
    const controller = createKlondikeController(1)
    const clubs = FOUNDATION_SUITS.indexOf('clubs')
    const state: KlondikeState = {
      tableau: [[card('spades', 3)], [], [card('hearts', 3)], [], [], [], []],
      foundation: FOUNDATION_SUITS.map((s) => (s === 'clubs' ? [card('clubs', 1), card('clubs', 2)] : s === 'diamonds' ? [card('diamonds', 1)] : [])),
      stock: [],
      waste: []
    }
    const from = { zone: 'foundation' as const, index: clubs }
    expect(controller.tryMove(state, { from, to: { zone: 'tableau', index: 0 }, count: 1 })).toBeNull() // same color
    expect(controller.tryMove(state, { from, to: { zone: 'tableau', index: 1 }, count: 1 })).toBeNull() // empty column: Kings only
    expect(controller.tryMove(state, { from, to: { zone: 'foundation', index: FOUNDATION_SUITS.indexOf('diamonds') }, count: 1 })).toBeNull()
    expect(controller.tryMove(state, { from, to: { zone: 'waste', index: 0 }, count: 1 })).toBeNull()
    expect(controller.tryMove(state, { from, to: { zone: 'tableau', index: 2 }, count: 2 })).toBeNull()
  })

  it('never offers a foundation card in legalMoves, so Hint cannot suggest a card going straight back down', () => {
    const controller = createKlondikeController(1)
    const state: KlondikeState = {
      tableau: [[card('hearts', 3)], [], [], [], [], [], []],
      foundation: FOUNDATION_SUITS.map((s) => (s === 'clubs' ? [card('clubs', 1), card('clubs', 2)] : [])),
      stock: [],
      waste: []
    }
    expect(controller.tryMove(state, { from: { zone: 'foundation', index: FOUNDATION_SUITS.indexOf('clubs') }, to: { zone: 'tableau', index: 0 }, count: 1 })).not.toBeNull()
    expect(controller.legalMoves(state).filter((m) => m.from.zone === 'foundation')).toEqual([])
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
      to: { zone: 'foundation', index: FOUNDATION_SUITS.indexOf('clubs') },
      count: 1
    })
    expect(result).not.toBeNull()
    expect(result!.foundation[FOUNDATION_SUITS.indexOf('clubs')].map((c) => c.id)).toEqual(['clubs-1-0'])
    expect(result!.waste.length).toBe(0)
  })
})

describe('Klondike isWon', () => {
  it('returns true when all foundations are complete (Ace..King)', () => {
    const controller = createKlondikeController(1)
    const foundation: Card[][] = FOUNDATION_SUITS.map((suit) => {
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

// Regression test for a real bug: legalMoves used to enumerate EVERY legal tableau destination for
// a given (source column, card count), while autoMoveHint (tap-to-auto-move) already computed a
// single "best" destination via pickBestTableauTarget. When two columns both happened to offer a
// legal landing spot for the same card, Hint could highlight one while tapping the card sent it to
// the other. legalMoves now builds the same candidate list and calls pickBestTableauTarget itself,
// so it always collapses to the one destination autoMoveHint would also pick.
describe('Klondike legalMoves destination selection', () => {
  it('collapses multiple legal tableau destinations for the same (from, count) to the single best one, matching autoMoveHint', () => {
    const controller = createKlondikeController(1)
    const state: KlondikeState = {
      tableau: [
        [card('hearts', 8)], // col0: source - red 8
        [card('spades', 9)], // col1: black 9 - a legal destination (leftmost)
        [card('clubs', 9)], // col2: black 9 - also a legal destination
        [],
        [],
        [],
        []
      ],
      foundation: [[], [], [], []],
      stock: [],
      waste: []
    }

    const tableauMovesFromCol0 = controller.legalMoves(state).filter((m) => m.from.zone === 'tableau' && m.from.index === 0 && m.to.zone === 'tableau')
    expect(tableauMovesFromCol0).toHaveLength(1)
    expect(tableauMovesFromCol0[0].to.index).toBe(1) // tie-break: fewest buried, same pile size -> leftmost

    const autoHint = controller.autoMoveHint!(state, { zone: 'tableau', index: 0 }, 'hearts-8-0')
    expect(autoHint).toEqual(tableauMovesFromCol0[0])
  })
})

describe('Klondike scoreHintMove', () => {
  const controller = createKlondikeController(1)

  function moveTo(state: KlondikeState, from: number, count: number, to: number) {
    const move = controller.legalMoves(state).find((m) => m.from.zone === 'tableau' && m.from.index === from && m.count === count && m.to.zone === 'tableau' && m.to.index === to)
    if (!move) throw new Error(`expected a legal tableau move from=${from} count=${count} to=${to}`)
    return move
  }

  function scoreOf(state: KlondikeState, from: number, count: number, to: number) {
    return controller.scoreHintMove!(state, moveTo(state, from, count, to))
  }

  // Regression test for the same fragmentation bug fixed in Spider: the previous scorer rated
  // "peel part of a nice run off to park it on some unrelated matching card" the same as any other
  // harmless move, so Hint could suggest tearing apart a good run for no reason. Klondike has no
  // foundation special-case here (findHint already sorts foundation-bound moves first, unconditionally).
  it('never prefers fragmenting a coherent run over relocating it intact', () => {
    const state: KlondikeState = {
      tableau: [
        [card('spades', 9), card('hearts', 8), card('clubs', 7), card('diamonds', 6)], // col0: a full 4-run
        [card('spades', 7)], // col1: takes just the 6 (fragment of 1)
        [card('diamonds', 8)], // col2: takes the top 2 (7,6)
        [card('clubs', 9)], // col3: takes the top 3 (8,7,6)
        [card('hearts', 10)], // col4: takes the whole run (4)
        [],
        []
      ],
      foundation: [[], [], [], []],
      stock: [],
      waste: []
    }

    const fragment1 = scoreOf(state, 0, 1, 1) // rips the 6 off the run, onto the lone black 7
    const fragment2 = scoreOf(state, 0, 2, 2) // rips 7,6 off, onto the lone red 8
    const fragment3 = scoreOf(state, 0, 3, 3) // rips 8,7,6 off, onto the lone black 9
    const intactRelocation = scoreOf(state, 0, 4, 4) // the whole run, kept together

    expect(intactRelocation).toBeGreaterThan(fragment1)
    expect(intactRelocation).toBeGreaterThan(fragment2)
    expect(intactRelocation).toBeGreaterThan(fragment3)
    expect(fragment1).toBeLessThan(0)
    expect(fragment2).toBeLessThan(0)
  })

  it('ranks revealing a face-down card far above a move that reveals nothing', () => {
    const state: KlondikeState = {
      tableau: [
        [card('diamonds', 9, false), card('clubs', 5)], // col0: moving the 5 exposes the face-down 9
        [card('hearts', 6)], // col1: destination for the 5
        [card('clubs', 9), card('spades', 3)], // col2: moving the 3 exposes nothing new (already face-up)
        [card('hearts', 4)], // col3: destination for the 3
        [],
        [],
        []
      ],
      foundation: [[], [], [], []],
      stock: [],
      waste: []
    }

    const revealMove = scoreOf(state, 0, 1, 1) // 5 -> 6, exposes the face-down 9
    const plainConsolidation = scoreOf(state, 2, 1, 3) // 3 -> 4, nothing revealed

    expect(revealMove).toBeGreaterThan(plainConsolidation)
    expect(revealMove).toBeGreaterThan(400) // comfortably clears the structural/empty-column range
  })

  // Klondike's empty tableau columns only ever accept a King (unlike Spider's, which take any
  // card) - so "spending" one is a real, scarce move here too, just reachable through fewer shapes.
  it('treats empty columns as a resource whose net change matters, not a flat penalty', () => {
    const state: KlondikeState = {
      tableau: [
        [card('spades', 13)], // col0: a lone King - moving it is a purely lateral shuffle
        [], // col1: empty - destination for the lone King
        [card('hearts', 5)], // col2: a lone card whose move frees this column
        [card('spades', 6)], // col3: destination that extends into a real 2-run
        [card('clubs', 8), card('diamonds', 7)], // col4: a 2-card run occupying the whole column
        [card('hearts', 9)], // col5: destination for the whole run
        [] // col6: empty, so the King has two candidate empty destinations (leftmost wins)
      ],
      foundation: [[], [], [], []],
      stock: [],
      waste: []
    }

    const lateralIntoEmptyColumn = scoreOf(state, 0, 1, 1) // King -> empty column, net wash
    const extendsRunAndFreesColumn = scoreOf(state, 2, 1, 3) // 5 -> 6, frees col2
    const relocatesWholeRunAndFreesColumn = scoreOf(state, 4, 2, 5) // whole run -> a lone 9, frees col4

    expect(extendsRunAndFreesColumn).toBeGreaterThan(lateralIntoEmptyColumn)
    expect(relocatesWholeRunAndFreesColumn).toBeGreaterThan(lateralIntoEmptyColumn)
  })

  // Hint used to offer moving the 5 from one black 6 to the other, then moving it straight back:
  // both scored +2 from the size tiebreak alone.
  it('scores a relocation that gains nothing, and its reverse, at 0, so Hint draws instead of ping-ponging', () => {
    const state: KlondikeState = {
      tableau: [[card('clubs', 9), card('spades', 6), card('hearts', 5)], [card('clubs', 6)], [], [], [], [], []],
      foundation: [[], [], [], []],
      stock: [card('diamonds', 13, false)],
      waste: []
    }
    const there = moveTo(state, 0, 1, 1)
    expect(controller.scoreHintMove!(state, there)).toBe(0)

    const back = controller.tryMove(state, there)!
    expect(back).not.toBeNull()
    expect(scoreOf(back, 1, 1, 0)).toBe(0)

    expect(findHint(controller, state)).toEqual({ kind: 'drawStock' })
    expect(findHint(controller, back)).toEqual({ kind: 'drawStock' })
  })

  // A waste-to-tableau play used to score 0, so whenever it was the only thing to do Hint drew instead.
  it('suggests playing the waste card onto the tableau over drawing', () => {
    const state: KlondikeState = {
      tableau: [[card('clubs', 6)], [], [], [], [], [], []],
      foundation: [[], [], [], []],
      stock: [card('diamonds', 13, false)],
      waste: [card('hearts', 5)]
    }
    const play = controller.legalMoves(state).find((m) => m.from.zone === 'waste' && m.to.zone === 'tableau' && m.to.index === 0)!
    expect(play).toBeDefined()
    expect(controller.scoreHintMove!(state, play)).toBeGreaterThan(0)
    expect(findHint(controller, state)).toEqual({ kind: 'move', move: play, choices: 1 })
  })
})

describe('Klondike canAutoFinish / nextFinishMove (the finish: a solved board files itself away)', () => {
  /** Foundation piles, Ace first, each filled up to the given rank (13 = complete, missing = empty). */
  function foundationsUpTo(upTo: Partial<Record<Card['suit'], number>>): Card[][] {
    return FOUNDATION_SUITS.map((suit) => Array.from({ length: upTo[suit] ?? 0 }, (_, i) => card(suit, (i + 1) as Card['rank'])))
  }
  function board(parts: { tableau: Card[][]; foundation: Card[][]; stock?: Card[]; waste?: Card[] }): KlondikeState {
    return { tableau: Array.from({ length: 7 }, (_, i) => parts.tableau[i] ?? []), foundation: parts.foundation, stock: parts.stock ?? [], waste: parts.waste ?? [] }
  }
  /** Nothing face-down, the stock and waste empty, every card able to go up: the Jack, Queen and King of clubs and the other Kings are left. */
  const solved = () => board({ tableau: [[card('clubs', 11)], [card('diamonds', 13), card('clubs', 12)], [card('hearts', 13)], [card('clubs', 13)], [card('spades', 13)]], foundation: foundationsUpTo({ clubs: 10, diamonds: 12, hearts: 12, spades: 12 }) })
  const controller = createKlondikeController(1)

  it("is true on a solved board, and nextFinishMove sends every card left to its own suit's foundation until the game is won", () => {
    let state = solved()
    expect(canAutoFinish(controller, state)).toBe(true)
    const sent: string[] = []
    for (let step = nextFinishMove(controller, state); step; step = nextFinishMove(controller, state)) {
      expect(step.to).toEqual({ zone: 'foundation', index: FOUNDATION_SUITS.indexOf(step.entry.card.suit) })
      sent.push(step.entry.card.id)
      state = controller.tryMove(state, { from: step.entry.ref, to: step.to, count: 1 })!
      expect(state).not.toBeNull()
    }
    expect(sent).toEqual(['clubs-11-0', 'clubs-12-0', 'diamonds-13-0', 'hearts-13-0', 'clubs-13-0', 'spades-13-0'])
    expect(controller.isWon(state)).toBe(true)
    expect(canAutoFinish(controller, state)).toBe(false)
  })

  it('is false on a won board, though isFullyAutoCompletable says true there', () => {
    const won = board({ tableau: [], foundation: foundationsUpTo({ clubs: 13, diamonds: 13, hearts: 13, spades: 13 }) })
    expect(isFullyAutoCompletable(controller, won)).toBe(true)
    expect(canAutoFinish(controller, won)).toBe(false)
    expect(nextFinishMove(controller, won)).toBeNull()
  })

  it('is false while a face-down card is left, though the cards above it could clear and turn it over', () => {
    const state = board({ tableau: [[card('clubs', 13, false), card('clubs', 12)], [card('diamonds', 13)], [card('hearts', 13)], [card('spades', 13)]], foundation: foundationsUpTo({ clubs: 11, diamonds: 12, hearts: 12, spades: 12 }) })
    expect(isFullyAutoCompletable(controller, state)).toBe(true)
    expect(canAutoFinish(controller, state)).toBe(false)
    expect(nextFinishMove(controller, state)).toBeNull()
  })

  it('is false while a card is left in the stock, though a clear that draws would reach it', () => {
    const state = board({ tableau: [[card('clubs', 13)], [card('diamonds', 13)], [card('hearts', 13)]], stock: [card('spades', 13, false)], foundation: foundationsUpTo({ clubs: 12, diamonds: 12, hearts: 12, spades: 12 }) })
    expect(isFullyAutoCompletableWithDraws(controller, state)).toBe(true)
    expect(canAutoFinish(controller, state)).toBe(false)
    expect(nextFinishMove(controller, state)).toBeNull()
  })

  it('is false while a card is left on the waste, even one that could go straight up', () => {
    const state = board({ tableau: [[card('clubs', 13)], [card('diamonds', 13)], [card('hearts', 13)]], waste: [card('spades', 13)], foundation: foundationsUpTo({ clubs: 12, diamonds: 12, hearts: 12, spades: 12 }) })
    expect(isFullyAutoCompletable(controller, state)).toBe(true)
    expect(canAutoFinish(controller, state)).toBe(false)
    expect(nextFinishMove(controller, state)).toBeNull()
  })

  it('is false when a card is buried under a higher one of its own suit, so foundation moves alone cannot clear the board', () => {
    const state = board({ tableau: [[card('clubs', 11), card('clubs', 12)], [card('clubs', 13)]], foundation: foundationsUpTo({ clubs: 10, diamonds: 13, hearts: 13, spades: 13 }) })
    expect(canAutoFinish(controller, state)).toBe(false)
    expect(nextFinishMove(controller, state)).toBeNull()
  })

  it('does not depend on the draw count the game was dealt with', () => {
    const drawThree = createKlondikeController(3)
    expect(canAutoFinish(drawThree, solved())).toBe(true)
    expect(nextFinishMove(drawThree, solved())).toEqual(nextFinishMove(controller, solved()))
  })
})
