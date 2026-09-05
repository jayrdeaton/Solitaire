import { Card } from '@/engine/types'
import { FreeCellController, FreeCellState } from '@/games/freecell/rules'

function card(id: string, suit: Card['suit'], rank: Card['rank'], faceUp = true): Card {
  return { id, suit, rank, faceUp }
}

describe('FreeCell newGame', () => {
  it('deals exactly 52 unique-id cards, all face-up, in the correct column counts', () => {
    const state = FreeCellController.newGame(12345)

    expect(state.tableau).toHaveLength(8)
    const expectedCounts = [7, 7, 7, 7, 6, 6, 6, 6]
    state.tableau.forEach((col, i) => {
      expect(col).toHaveLength(expectedCounts[i])
      col.forEach((c) => expect(c.faceUp).toBe(true))
    })

    const allCards = state.tableau.flat()
    expect(allCards).toHaveLength(52)
    const ids = new Set(allCards.map((c) => c.id))
    expect(ids.size).toBe(52)

    expect(state.freecells).toEqual([null, null, null, null])
    expect(state.foundation).toEqual([[], [], [], []])
  })

  it('is deterministic for a given seed', () => {
    const a = FreeCellController.newGame(555)
    const b = FreeCellController.newGame(555)
    expect(a.tableau.map((col) => col.map((c) => c.id))).toEqual(b.tableau.map((col) => col.map((c) => c.id)))
  })
})

describe('FreeCell tryMove - tableau to tableau', () => {
  function baseState(): FreeCellState {
    return {
      tableau: [[card('clubs-8-0', 'clubs', 8)], [card('hearts-7-0', 'hearts', 7)], [], [], [], [], [], []],
      freecells: [null, null, null, null],
      foundation: [[], [], [], []]
    }
  }

  it('allows a legal single-card move (red 7 onto black 8) and does not mutate the original', () => {
    const state = baseState()
    const frozenTableau = JSON.stringify(state.tableau)

    const result = FreeCellController.tryMove(state, {
      from: { zone: 'tableau', index: 1 },
      to: { zone: 'tableau', index: 0 },
      count: 1
    })

    expect(result).not.toBeNull()
    expect(result!.tableau[0].map((c) => c.id)).toEqual(['clubs-8-0', 'hearts-7-0'])
    expect(result!.tableau[1]).toEqual([])
    // original untouched
    expect(JSON.stringify(state.tableau)).toBe(frozenTableau)
  })

  it('rejects an illegal move (wrong rank/color)', () => {
    const state: FreeCellState = {
      tableau: [
        [card('clubs-8-0', 'clubs', 8)],
        [card('clubs-6-0', 'clubs', 6)], // same color, wrong rank too
        [],
        [],
        [],
        [],
        [],
        []
      ],
      freecells: [null, null, null, null],
      foundation: [[], [], [], []]
    }

    const result = FreeCellController.tryMove(state, {
      from: { zone: 'tableau', index: 1 },
      to: { zone: 'tableau', index: 0 },
      count: 1
    })

    expect(result).toBeNull()
  })
})

describe('FreeCell freecell interactions', () => {
  it('moves a card into an empty freecell and back out to a tableau column', () => {
    const state: FreeCellState = {
      tableau: [[card('hearts-7-0', 'hearts', 7)], [card('clubs-8-0', 'clubs', 8)], [], [], [], [], [], []],
      freecells: [null, null, null, null],
      foundation: [[], [], [], []]
    }

    const afterFreecell = FreeCellController.tryMove(state, {
      from: { zone: 'tableau', index: 0 },
      to: { zone: 'freecell', index: 2 },
      count: 1
    })
    expect(afterFreecell).not.toBeNull()
    expect(afterFreecell!.tableau[0]).toEqual([])
    expect(afterFreecell!.freecells[2]).toEqual(card('hearts-7-0', 'hearts', 7))

    const afterBack = FreeCellController.tryMove(afterFreecell!, {
      from: { zone: 'freecell', index: 2 },
      to: { zone: 'tableau', index: 1 },
      count: 1
    })
    expect(afterBack).not.toBeNull()
    expect(afterBack!.freecells[2]).toBeNull()
    expect(afterBack!.tableau[1].map((c) => c.id)).toEqual(['clubs-8-0', 'hearts-7-0'])
  })

  it('rejects moving into an occupied freecell', () => {
    const state: FreeCellState = {
      tableau: [[card('hearts-7-0', 'hearts', 7)], [], [], [], [], [], [], []],
      freecells: [card('spades-2-0', 'spades', 2), null, null, null],
      foundation: [[], [], [], []]
    }

    const result = FreeCellController.tryMove(state, {
      from: { zone: 'tableau', index: 0 },
      to: { zone: 'freecell', index: 0 },
      count: 1
    })
    expect(result).toBeNull()
  })
})

describe('FreeCell supermove', () => {
  it('succeeds when enough free cells/empty columns are available', () => {
    // destination column needs a card one rank higher, opposite color of the run's top card (clubs-8).
    // run being moved: [clubs-8, hearts-7] (2 cards). Destination top must be red 9.
    const state: FreeCellState = {
      tableau: [
        [card('spades-10-0', 'spades', 10), card('clubs-8-0', 'clubs', 8), card('hearts-7-0', 'hearts', 7)],
        [card('diamonds-9-0', 'diamonds', 9)],
        [], // 1 empty column
        [],
        [],
        [],
        [],
        []
      ],
      freecells: [null, card('spades-2-0', 'spades', 2), card('spades-3-0', 'spades', 3), card('spades-4-0', 'spades', 4)], // 1 free freecell
      foundation: [[], [], [], []]
    }
    // emptyFreecells = 1, emptyCols excluding dest(index 1, not empty) = 1 (col 2) -> max = (1+1)*2^1 = 4 >= 2

    const result = FreeCellController.tryMove(state, {
      from: { zone: 'tableau', index: 0 },
      to: { zone: 'tableau', index: 1 },
      count: 2
    })

    expect(result).not.toBeNull()
    expect(result!.tableau[0].map((c) => c.id)).toEqual(['spades-10-0'])
    expect(result!.tableau[1].map((c) => c.id)).toEqual(['diamonds-9-0', 'clubs-8-0', 'hearts-7-0'])
  })

  it('fails when there is insufficient free cells/empty columns for the same move', () => {
    const state: FreeCellState = {
      tableau: [[card('spades-10-0', 'spades', 10), card('clubs-8-0', 'clubs', 8), card('hearts-7-0', 'hearts', 7)], [card('diamonds-9-0', 'diamonds', 9)], [], [], [], [], [], []],
      // all freecells occupied, no empty columns other than not counted ones -> max = (0+1)*2^0 = 1 < 2
      freecells: [card('spades-2-0', 'spades', 2), card('spades-3-0', 'spades', 3), card('spades-4-0', 'spades', 4), card('spades-5-0', 'spades', 5)],
      foundation: [[], [], [], []]
    }
    // fill remaining columns so there are no empty ones besides destination (dest is not empty here anyway)
    state.tableau[2] = [card('clubs-2-0', 'clubs', 2)]
    state.tableau[3] = [card('clubs-3-0', 'clubs', 3)]
    state.tableau[4] = [card('clubs-4-0', 'clubs', 4)]
    state.tableau[5] = [card('clubs-5-0', 'clubs', 5)]
    state.tableau[6] = [card('clubs-6-0', 'clubs', 6)]
    state.tableau[7] = [card('diamonds-2-0', 'diamonds', 2)]

    const result = FreeCellController.tryMove(state, {
      from: { zone: 'tableau', index: 0 },
      to: { zone: 'tableau', index: 1 },
      count: 2
    })

    expect(result).toBeNull()
  })

  it('excludes the destination column itself from the empty-column count when computing the limit', () => {
    // 0 free freecells, destination column is empty (so it must be excluded), and no other empty columns.
    // max = (0 + 1) * 2^0 = 1, so a 2-card move should fail even though the destination itself is "empty".
    const state: FreeCellState = {
      tableau: [
        [card('spades-10-0', 'spades', 10), card('clubs-8-0', 'clubs', 8), card('hearts-7-0', 'hearts', 7)],
        [], // empty destination column
        [card('clubs-2-0', 'clubs', 2)],
        [card('clubs-3-0', 'clubs', 3)],
        [card('clubs-4-0', 'clubs', 4)],
        [card('clubs-5-0', 'clubs', 5)],
        [card('clubs-6-0', 'clubs', 6)],
        [card('diamonds-2-0', 'diamonds', 2)]
      ],
      freecells: [card('spades-2-0', 'spades', 2), card('spades-3-0', 'spades', 3), card('spades-4-0', 'spades', 4), card('spades-5-0', 'spades', 5)],
      foundation: [[], [], [], []]
    }

    const result = FreeCellController.tryMove(state, {
      from: { zone: 'tableau', index: 0 },
      to: { zone: 'tableau', index: 1 },
      count: 2
    })

    expect(result).toBeNull()
  })
})

describe('FreeCell isWon', () => {
  function fullSuit(suit: Card['suit']): Card[] {
    const ranks: Card['rank'][] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
    return ranks.map((r) => card(`${suit}-${r}-0`, suit, r))
  }

  it('is true only when all 4 foundations are full', () => {
    const wonState: FreeCellState = {
      tableau: [[], [], [], [], [], [], [], []],
      freecells: [null, null, null, null],
      foundation: [fullSuit('clubs'), fullSuit('diamonds'), fullSuit('hearts'), fullSuit('spades')]
    }
    expect(FreeCellController.isWon(wonState)).toBe(true)

    const notWonState: FreeCellState = {
      tableau: [[card('spades-13-0', 'spades', 13)], [], [], [], [], [], [], []],
      freecells: [null, null, null, null],
      foundation: [fullSuit('clubs'), fullSuit('diamonds'), fullSuit('hearts'), []]
    }
    expect(FreeCellController.isWon(notWonState)).toBe(false)
  })
})

describe('FreeCell foundation moves', () => {
  it('moves an ace to an empty foundation, then the two onto it', () => {
    const state: FreeCellState = {
      tableau: [[card('clubs-2-0', 'clubs', 2), card('clubs-1-0', 'clubs', 1)], [], [], [], [], [], [], []],
      freecells: [null, null, null, null],
      foundation: [[], [], [], []]
    }

    const afterAce = FreeCellController.tryMove(state, {
      from: { zone: 'tableau', index: 0 },
      to: { zone: 'foundation', index: 0 },
      count: 1
    })
    expect(afterAce).not.toBeNull()
    expect(afterAce!.foundation[0].map((c) => c.id)).toEqual(['clubs-1-0'])

    const afterTwo = FreeCellController.tryMove(afterAce!, {
      from: { zone: 'tableau', index: 0 },
      to: { zone: 'foundation', index: 0 },
      count: 1
    })
    expect(afterTwo).not.toBeNull()
    expect(afterTwo!.foundation[0].map((c) => c.id)).toEqual(['clubs-1-0', 'clubs-2-0'])
  })

  it('rejects moving a card to the wrong suit foundation slot', () => {
    const state: FreeCellState = {
      tableau: [[card('clubs-1-0', 'clubs', 1)], [], [], [], [], [], [], []],
      freecells: [null, null, null, null],
      foundation: [[], [], [], []]
    }
    const result = FreeCellController.tryMove(state, {
      from: { zone: 'tableau', index: 0 },
      to: { zone: 'foundation', index: 1 }, // diamonds slot, but card is clubs
      count: 1
    })
    expect(result).toBeNull()
  })
})

describe('FreeCell autoMoveHint', () => {
  it('finds a foundation move for a top-of-tableau ace', () => {
    const state: FreeCellState = {
      tableau: [[card('hearts-1-0', 'hearts', 1)], [], [], [], [], [], [], []],
      freecells: [null, null, null, null],
      foundation: [[], [], [], []]
    }
    const hint = FreeCellController.autoMoveHint!(state, { zone: 'tableau', index: 0 }, 'hearts-1-0')
    expect(hint).toEqual({ from: { zone: 'tableau', index: 0 }, to: { zone: 'foundation', index: 2 }, count: 1 })
  })

  it('falls back to the best tableau destination when no foundation move exists', () => {
    const state: FreeCellState = {
      tableau: [
        [card('hearts-5-0', 'hearts', 5)],
        [card('clubs-6-0', 'clubs', 6)], // legal (red 5 onto black 6), 0 buried cards
        [card('clubs-9-0', 'clubs', 9), card('clubs-6-1', 'clubs', 6)], // legal, but 1 buried card
        [],
        [],
        [],
        [],
        []
      ],
      freecells: [null, null, null, null],
      foundation: [[], [], [], []]
    }
    const hint = FreeCellController.autoMoveHint!(state, { zone: 'tableau', index: 0 }, 'hearts-5-0')
    // Prefers column 1 over the empty columns (fewer buried cards than starting a pile from scratch
    // isn't the deciding factor here - both are 0-buried single-card-accepting piles, but a non-empty
    // legal placement is still what "fewest buried cards, then largest pile" should pick over any of
    // the equally-0-buried empty columns, since column 1 is a strictly larger pile at equal buried count).
    expect(hint).toEqual({ from: { zone: 'tableau', index: 0 }, to: { zone: 'tableau', index: 1 }, count: 1 })
  })

  it('falls back to an empty freecell when no foundation or tableau move exists', () => {
    const state: FreeCellState = {
      tableau: [[card('hearts-5-0', 'hearts', 5)], [card('clubs-2-0', 'clubs', 2)], [card('spades-2-0', 'spades', 2)], [card('clubs-3-0', 'clubs', 3)], [card('spades-3-0', 'spades', 3)], [card('clubs-4-0', 'clubs', 4)], [card('spades-4-0', 'spades', 4)], [card('clubs-9-0', 'clubs', 9)]],
      freecells: [null, card('diamonds-9-0', 'diamonds', 9), null, null],
      foundation: [[], [], [], []]
    }
    const hint = FreeCellController.autoMoveHint!(state, { zone: 'tableau', index: 0 }, 'hearts-5-0')
    // Freecell 1 is occupied, so the first empty one (index 0) is picked.
    expect(hint).toEqual({ from: { zone: 'tableau', index: 0 }, to: { zone: 'freecell', index: 0 }, count: 1 })
  })

  it('returns null when the card has nowhere legal to go, including no empty freecell', () => {
    const state: FreeCellState = {
      tableau: [[card('hearts-5-0', 'hearts', 5)], [card('clubs-2-0', 'clubs', 2)], [card('spades-2-0', 'spades', 2)], [card('clubs-3-0', 'clubs', 3)], [card('spades-3-0', 'spades', 3)], [card('clubs-4-0', 'clubs', 4)], [card('spades-4-0', 'spades', 4)], [card('clubs-9-0', 'clubs', 9)]],
      freecells: [card('diamonds-9-0', 'diamonds', 9), card('diamonds-8-0', 'diamonds', 8), card('diamonds-7-0', 'diamonds', 7), card('diamonds-6-0', 'diamonds', 6)],
      foundation: [[], [], [], []]
    }
    const hint = FreeCellController.autoMoveHint!(state, { zone: 'tableau', index: 0 }, 'hearts-5-0')
    expect(hint).toBeNull()
  })

  it('does not shuffle a freecell card into a different empty freecell', () => {
    const state: FreeCellState = {
      tableau: [[card('clubs-2-0', 'clubs', 2)], [card('spades-2-0', 'spades', 2)], [card('clubs-3-0', 'clubs', 3)], [card('spades-3-0', 'spades', 3)], [card('clubs-4-0', 'clubs', 4)], [card('spades-4-0', 'spades', 4)], [card('clubs-9-0', 'clubs', 9)], [card('spades-9-0', 'spades', 9)]],
      freecells: [card('hearts-5-0', 'hearts', 5), null, null, null],
      foundation: [[], [], [], []]
    }
    const hint = FreeCellController.autoMoveHint!(state, { zone: 'freecell', index: 0 }, 'hearts-5-0')
    expect(hint).toBeNull()
  })
})
