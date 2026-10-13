import { isFullyAutoCompletable } from '@/engine/autoFoundation'
import { Card, Suit, SUITS } from '@/engine/types'
import { canAutoFinish, createYukonController, nextFinishMove, YukonState } from '@/games/yukon/rules'

function card(suit: Card['suit'], rank: Card['rank'], faceUp = true, deckIndex = 0): Card {
  return { id: `${suit}-${rank}-${deckIndex}`, suit, rank, faceUp }
}

function countCards(state: YukonState): number {
  const tableauCount = state.tableau.reduce((sum, col) => sum + col.length, 0)
  const foundationCount = state.foundation.reduce((sum, f) => sum + f.length, 0)
  return tableauCount + foundationCount
}

describe('Yukon newGame', () => {
  it('deals a legal starting layout', () => {
    const controller = createYukonController()
    const state = controller.newGame(12345)

    expect(countCards(state)).toBe(52)
    expect(state.tableau.length).toBe(7)
    expect(state.foundation.length).toBe(4)

    const expectedSizes = [1, 6, 7, 8, 9, 10, 11]
    const expectedFaceDown = [0, 1, 2, 3, 4, 5, 6]
    state.tableau.forEach((col, i) => {
      expect(col.length).toBe(expectedSizes[i])
      const faceDownCount = col.filter((c) => !c.faceUp).length
      expect(faceDownCount).toBe(expectedFaceDown[i])
      // every face-down card sits below every face-up card (no gaps/inversions)
      const firstFaceUp = col.findIndex((c) => c.faceUp)
      col.forEach((c, idx) => {
        expect(c.faceUp).toBe(idx >= firstFaceUp)
      })
    })

    state.foundation.forEach((f) => expect(f.length).toBe(0))
  })

  it('is deterministic given the same seed', () => {
    const controller = createYukonController()
    const a = controller.newGame(42)
    const b = controller.newGame(42)
    expect(a.tableau.map((c) => c.map((x) => x.id))).toEqual(b.tableau.map((c) => c.map((x) => x.id)))
  })
})

describe('Yukon tryMove', () => {
  it('moves an out-of-order face-up group as one unit, without requiring it to be a valid run', () => {
    const controller = createYukonController()

    // black-8 then red-King stacked on it - NOT a valid descending alt-color run (Klondike would
    // reject moving these two together), but Yukon allows moving any face-up card plus everything
    // stacked above it, in its current order.
    const black8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const redKing: Card = { id: 'hearts-13-0', suit: 'hearts', rank: 13, faceUp: true }
    const redNine: Card = { id: 'diamonds-9-0', suit: 'diamonds', rank: 9, faceUp: true }

    const state: YukonState = {
      tableau: [[black8, redKing], [redNine], [], [], [], [], []],
      foundation: [[], [], [], []]
    }
    const snapshot = JSON.parse(JSON.stringify(state))

    const result = controller.tryMove(state, {
      from: { zone: 'tableau', index: 0 },
      to: { zone: 'tableau', index: 1 },
      count: 2
    })

    expect(result).not.toBeNull()
    expect(result!.tableau[1].map((c) => c.id)).toEqual(['diamonds-9-0', 'clubs-8-0', 'hearts-13-0'])
    expect(result!.tableau[0]).toEqual([])

    // original state unchanged
    expect(state).toEqual(snapshot)
  })

  it('still rejects a single-card move onto a wrong-color/wrong-rank destination', () => {
    const controller = createYukonController()
    const black8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const blackSix: Card = { id: 'spades-6-0', suit: 'spades', rank: 6, faceUp: true }

    const state: YukonState = {
      tableau: [[black8], [blackSix], [], [], [], [], []],
      foundation: [[], [], [], []]
    }

    const result = controller.tryMove(state, {
      from: { zone: 'tableau', index: 1 },
      to: { zone: 'tableau', index: 0 },
      count: 1
    })
    expect(result).toBeNull()
  })

  it('rejects a group move that includes a face-down card', () => {
    const controller = createYukonController()
    const hidden: Card = { id: 'diamonds-2-0', suit: 'diamonds', rank: 2, faceUp: false }
    const exposed: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }

    const state: YukonState = {
      tableau: [[hidden, exposed], [], [], [], [], [], []],
      foundation: [[], [], [], []]
    }

    // col 1 is empty, which accepts any face-up group in Yukon - so this only fails if the
    // face-down check itself fires.
    const result = controller.tryMove(state, {
      from: { zone: 'tableau', index: 0 },
      to: { zone: 'tableau', index: 1 },
      count: 2
    })
    expect(result).toBeNull()
  })

  it("lets a foundation's top card come back down onto a legal tableau spot", () => {
    const controller = createYukonController()
    const clubs = SUITS.indexOf('clubs')
    const state: YukonState = {
      tableau: [[card('hearts', 3)], [], [], [], [], [], []],
      foundation: SUITS.map((s) => (s === 'clubs' ? [card('clubs', 1), card('clubs', 2)] : []))
    }
    const result = controller.tryMove(state, { from: { zone: 'foundation', index: clubs }, to: { zone: 'tableau', index: 0 }, count: 1 })
    expect(result).not.toBeNull()
    expect(result!.foundation[clubs].map((c) => c.id)).toEqual(['clubs-1-0'])
    expect(result!.tableau[0].map((c) => c.id)).toEqual(['hearts-3-0', 'clubs-2-0'])
  })

  it('refuses a foundation card anywhere but a legal tableau spot, and more than one card at a time', () => {
    const controller = createYukonController()
    const clubs = SUITS.indexOf('clubs')
    const state: YukonState = {
      tableau: [[card('spades', 3)], [card('hearts', 3)], [], [], [], [], []],
      foundation: SUITS.map((s) => (s === 'clubs' ? [card('clubs', 1), card('clubs', 2)] : s === 'diamonds' ? [card('diamonds', 1)] : []))
    }
    const from = { zone: 'foundation' as const, index: clubs }
    expect(controller.tryMove(state, { from, to: { zone: 'tableau', index: 0 }, count: 1 })).toBeNull() // same color
    expect(controller.tryMove(state, { from, to: { zone: 'foundation', index: SUITS.indexOf('diamonds') }, count: 1 })).toBeNull()
    expect(controller.tryMove(state, { from, to: { zone: 'tableau', index: 1 }, count: 2 })).toBeNull()
  })

  it('never offers a foundation card in legalMoves, so Hint cannot suggest a card going straight back down', () => {
    const controller = createYukonController()
    const state: YukonState = {
      tableau: [[card('hearts', 3)], [], [], [], [], [], []],
      foundation: SUITS.map((s) => (s === 'clubs' ? [card('clubs', 1), card('clubs', 2)] : []))
    }
    expect(controller.tryMove(state, { from: { zone: 'foundation', index: SUITS.indexOf('clubs') }, to: { zone: 'tableau', index: 0 }, count: 1 })).not.toBeNull()
    expect(controller.legalMoves(state).filter((m) => m.from.zone === 'foundation')).toEqual([])
  })

  it('allows any face-up card to start an empty tableau column, not just a King', () => {
    const controller = createYukonController()
    const queen: Card = { id: 'hearts-12-0', suit: 'hearts', rank: 12, faceUp: true }

    const state: YukonState = {
      tableau: [[queen], [], [], [], [], [], []],
      foundation: [[], [], [], []]
    }
    const result = controller.tryMove(state, {
      from: { zone: 'tableau', index: 0 },
      to: { zone: 'tableau', index: 1 },
      count: 1
    })
    expect(result).not.toBeNull()
    expect(result!.tableau[1].map((c) => c.id)).toEqual(['hearts-12-0'])
  })

  it('reveals the new top card of the source tableau column after a move', () => {
    const controller = createYukonController()
    const hiddenCard: Card = { id: 'diamonds-2-0', suit: 'diamonds', rank: 2, faceUp: false }
    const black8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const redNine: Card = { id: 'hearts-9-0', suit: 'hearts', rank: 9, faceUp: true }

    const state: YukonState = {
      tableau: [[hiddenCard, black8], [redNine], [], [], [], [], []],
      foundation: [[], [], [], []]
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

  it('moves a single card from tableau to foundation', () => {
    const controller = createYukonController()
    const ace: Card = { id: 'clubs-1-0', suit: 'clubs', rank: 1, faceUp: true }
    const state: YukonState = {
      tableau: [[ace], [], [], [], [], [], []],
      foundation: [[], [], [], []]
    }
    const result = controller.tryMove(state, {
      from: { zone: 'tableau', index: 0 },
      to: { zone: 'foundation', index: SUITS.indexOf('clubs') },
      count: 1
    })
    expect(result).not.toBeNull()
    expect(result!.foundation[SUITS.indexOf('clubs')].map((c) => c.id)).toEqual(['clubs-1-0'])
    expect(result!.tableau[0].length).toBe(0)
  })

  it('rejects a foundation move of more than one card, or of the wrong suit/rank', () => {
    const controller = createYukonController()
    const ace: Card = { id: 'clubs-1-0', suit: 'clubs', rank: 1, faceUp: true }
    const two: Card = { id: 'clubs-2-0', suit: 'clubs', rank: 2, faceUp: true }
    const wrongSuitAce: Card = { id: 'hearts-1-0', suit: 'hearts', rank: 1, faceUp: true }

    const state: YukonState = {
      tableau: [[ace, two], [wrongSuitAce], [], [], [], [], []],
      foundation: [[], [], [], []]
    }

    expect(
      controller.tryMove(state, {
        from: { zone: 'tableau', index: 0 },
        to: { zone: 'foundation', index: SUITS.indexOf('clubs') },
        count: 2
      })
    ).toBeNull()

    expect(
      controller.tryMove(state, {
        from: { zone: 'tableau', index: 1 },
        to: { zone: 'foundation', index: SUITS.indexOf('clubs') },
        count: 1
      })
    ).toBeNull()
  })
})

describe('Yukon legalMoves', () => {
  it('enumerates every group size through an out-of-order face-up column, not just a valid prefix', () => {
    const controller = createYukonController()
    const black8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const redKing: Card = { id: 'hearts-13-0', suit: 'hearts', rank: 13, faceUp: true }

    const state: YukonState = {
      tableau: [[black8, redKing], [], [], [], [], [], []],
      foundation: [[], [], [], []]
    }

    const moves = controller.legalMoves(state)
    const toEmptyCol1 = moves.filter((m) => m.from.zone === 'tableau' && m.from.index === 0 && m.to.zone === 'tableau' && m.to.index === 1)
    const counts = toEmptyCol1.map((m) => m.count).sort()
    expect(counts).toEqual([1, 2])
  })
})

describe('Yukon isWon', () => {
  it('returns true when all foundations are complete (Ace..King)', () => {
    const controller = createYukonController()
    const foundation: Card[][] = SUITS.map((suit) => {
      const pile: Card[] = []
      for (let rank = 1; rank <= 13; rank++) {
        pile.push({ id: `${suit}-${rank}-0`, suit, rank: rank as Card['rank'], faceUp: true })
      }
      return pile
    })
    const state: YukonState = {
      tableau: [[], [], [], [], [], [], []],
      foundation
    }
    expect(controller.isWon(state)).toBe(true)
  })

  it('returns false when foundations are incomplete', () => {
    const controller = createYukonController()
    const ace: Card = { id: 'clubs-1-0', suit: 'clubs', rank: 1, faceUp: true }
    const state: YukonState = {
      tableau: [[], [], [], [], [], [], []],
      foundation: [[ace], [], [], []]
    }
    expect(controller.isWon(state)).toBe(false)
  })
})

describe('yukon scoreHintMove', () => {
  const controller = createYukonController()

  // After the legalMoves fix above, there's at most one legal tableau destination per
  // (from, count) - the same one autoMoveHint would pick - so this can look a move up by source
  // and count alone, with no need to guess (or hand-verify) which column wins the tie-break.
  function moveTo(state: YukonState, from: number, count: number) {
    const move = controller.legalMoves(state).find((m) => m.from.zone === 'tableau' && m.from.index === from && m.count === count && m.to.zone === 'tableau')
    if (!move) throw new Error(`expected a legal tableau move from=${from} count=${count}`)
    return move
  }

  function scoreOf(state: YukonState, from: number, count: number) {
    return controller.scoreHintMove!(state, moveTo(state, from, count))
  }

  // Regression test for what IS Yukon's real analogue of Spider's fragmentation bug, despite
  // Yukon never requiring a moved group to be internally valid: peeling a single card off the
  // bottom of a coherent 4-card alternating-color run, onto some unrelated (but rank/color-legal)
  // lone card, leaves neither piece as long as the original run - a real loss of structure, even
  // though every card involved remains exactly as movable afterward as before. Relocating the
  // whole run intact loses nothing.
  it('never prefers fragmenting a coherent alternating-color run over relocating it intact, with nothing gained', () => {
    const state: YukonState = {
      tableau: [
        [card('diamonds', 9), card('clubs', 8), card('hearts', 7), card('spades', 6)], // valid 4-run, spades-6 on top
        [card('clubs', 10)], // legal landing spot for the whole run (black 10)
        [],
        [card('diamonds', 7)], // legal landing spot for just the top card (spades-6) alone
        [card('hearts', 2)], // unrelated single-card move, for scale
        [card('clubs', 3)],
        []
      ],
      foundation: [[], [], [], []]
    }

    const intactRelocation = scoreOf(state, 0, 4) // whole run -> clubs-10, nothing lost
    const fragmentedPeel = scoreOf(state, 0, 1) // just spades-6 -> diamonds-7, breaks the 4-run into 3+2
    const harmlessSingle = scoreOf(state, 4, 1) // unrelated lone-card move, for scale

    expect(intactRelocation).toBeGreaterThan(harmlessSingle)
    expect(fragmentedPeel).toBeLessThan(harmlessSingle)
    expect(fragmentedPeel).toBeLessThan(0)
  })

  it('ranks revealing a face-down card far above a move that reveals nothing', () => {
    const state: YukonState = {
      tableau: [
        [card('diamonds', 9, false), card('hearts', 5)], // red-5 -> black-6 exposes the hidden 9
        [card('spades', 6)],
        [card('hearts', 10), card('clubs', 3)], // moving clubs-3 reveals nothing (hearts-10 is face-up)
        [card('diamonds', 4)],
        [],
        [],
        []
      ],
      foundation: [[], [], [], []]
    }

    const revealMove = scoreOf(state, 0, 1) // hearts-5 -> spades-6, exposes the face-down 9
    const plainConsolidation = scoreOf(state, 2, 1) // clubs-3 -> diamonds-4, nothing revealed

    expect(revealMove).toBeGreaterThan(plainConsolidation)
    expect(revealMove).toBeGreaterThan(400) // comfortably clears the empty-column/structural range
  })

  it('treats empty columns as a resource whose net change matters, not a flat penalty', () => {
    const state: YukonState = {
      tableau: [
        [card('spades', 12)], // lone black Queen - moving it frees this column
        [card('hearts', 13)], // legal landing spot for the Queen (red King)
        [card('clubs', 7)], // lone card with no non-empty legal landing spot anywhere else
        [],
        [card('diamonds', 9), card('clubs', 8)], // valid 2-run - peeling the top spends an empty column for nothing
        [],
        []
      ],
      foundation: [[], [], [], []]
    }

    const extendsRunAndFreesColumn = scoreOf(state, 0, 1) // spades-Q -> hearts-K, frees col0
    const lateralIntoEmptyColumn = scoreOf(state, 2, 1) // clubs-7 -> an empty column, source empties too: net wash
    const fragmentIntoEmptyColumn = scoreOf(state, 4, 1) // clubs-8 -> an empty column, breaks the 2-run for nothing

    expect(extendsRunAndFreesColumn).toBeGreaterThan(lateralIntoEmptyColumn)
    expect(lateralIntoEmptyColumn).toBeGreaterThan(fragmentIntoEmptyColumn)
  })
})

describe('Yukon canAutoFinish / nextFinishMove - the finish only takes a SOLVED board', () => {
  const controller = createYukonController()
  /** A foundation pile built Ace-first up to `high`. */
  const foundationUpTo = (suit: Suit, high: number): Card[] => Array.from({ length: high }, (_, i) => card(suit, (i + 1) as Card['rank']))
  /** A column `high` at the bottom down to `low` on top - each card free to go up the moment the one below it in rank has. */
  function run(suit: Suit, high: number, low: number): Card[] {
    const cards: Card[] = []
    for (let rank = high; rank >= low; rank--) cards.push(card(suit, rank as Card['rank']))
    return cards
  }
  const board = (tableau: Card[][], foundation: Card[][]): YukonState => ({ tableau: Array.from({ length: 7 }, (_, i) => tableau[i] ?? []), foundation })
  /** A whole deck: 41 cards home, the other 11 face up in three columns that clear by foundation moves alone. */
  const SOLVED = () => board([run('clubs', 13, 10), run('diamonds', 13, 10), run('hearts', 13, 11)], [foundationUpTo('clubs', 9), foundationUpTo('diamonds', 9), foundationUpTo('hearts', 10), foundationUpTo('spades', 13)])

  it('is true once every card is face up and the rest can go up by foundation moves alone', () => {
    expect(canAutoFinish(controller, SOLVED())).toBe(true)
    const step = nextFinishMove(controller, SOLVED())!
    expect(step.entry.card).toMatchObject({ suit: 'clubs', rank: 10 })
    expect(step.entry.ref).toEqual({ zone: 'tableau', index: 0 })
    expect(step.to).toEqual({ zone: 'foundation', index: SUITS.indexOf('clubs') })
  })

  it('is false while a card is still face down, even one the foundation moves would turn over (that would give away what is under it)', () => {
    const state = SOLVED()
    state.tableau[1] = [{ ...card('diamonds', 13), faceUp: false }, card('diamonds', 12), card('diamonds', 11), card('diamonds', 10)]
    expect(isFullyAutoCompletable(controller, state)).toBe(true) // the engine's check alone peeks under it and says yes
    expect(canAutoFinish(controller, state)).toBe(false)
    expect(nextFinishMove(controller, state)).toBeNull()
  })

  it('is false when a card is stuck under a higher one of its own suit', () => {
    const state = SOLVED()
    state.tableau[0] = [card('clubs', 10), card('clubs', 11), card('clubs', 12), card('clubs', 13)] // the 10 the clubs need next is at the bottom
    expect(canAutoFinish(controller, state)).toBe(false)
    expect(nextFinishMove(controller, state)).toBeNull()
  })

  it('is false on a won board (nothing left to finish)', () => {
    const won = board(
      [],
      SUITS.map((suit) => foundationUpTo(suit, 13))
    )
    expect(controller.isWon(won)).toBe(true)
    expect(canAutoFinish(controller, won)).toBe(false)
    expect(nextFinishMove(controller, won)).toBeNull()
  })

  it("following it from a solved board wins the game, every card to its own suit's foundation, through moves the rules accept", () => {
    let state = SOLVED()
    let played = 0
    for (let step = nextFinishMove(controller, state); step; step = nextFinishMove(controller, state)) {
      expect(step.to).toEqual({ zone: 'foundation', index: SUITS.indexOf(step.entry.card.suit) })
      const next = controller.tryMove(state, { from: step.entry.ref, to: step.to, count: 1 })
      expect(next).not.toBeNull()
      state = next!
      played += 1
    }
    expect(played).toBe(11)
    expect(controller.isWon(state)).toBe(true)
  })

  it.each(SUITS)("sends a %s card to that suit's foundation", (suit) => {
    const state = board(
      [run(suit, 13, 1)],
      SUITS.map((other) => (other === suit ? [] : foundationUpTo(other, 13)))
    )
    expect(canAutoFinish(controller, state)).toBe(true)
    const step = nextFinishMove(controller, state)!
    expect(step.entry.card).toMatchObject({ suit, rank: 1 })
    expect(step.to).toEqual({ zone: 'foundation', index: SUITS.indexOf(suit) })
  })
})
