import { PileRef } from '@/engine/gameTypes'
import { Card } from '@/engine/types'
import { FreeCellController, FreeCellState, moveHeadCard } from '@/games/freecell/rules'

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

  it('prefers a non-empty column that buries a card over an empty column, even though the empty column is "cleaner"', () => {
    const state: FreeCellState = {
      tableau: [
        [card('hearts-5-0', 'hearts', 5)],
        [], // empty column - would otherwise win on buried-count alone (0 buried)
        [card('clubs-9-0', 'clubs', 9), card('clubs-6-1', 'clubs', 6)], // legal (red 5 onto black 6), but buries the clubs-9
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
    // Empty piles are now a strict last resort: any legal non-empty destination wins over them,
    // regardless of buried count, so this lands on column 2 rather than an empty column.
    expect(hint).toEqual({ from: { zone: 'tableau', index: 0 }, to: { zone: 'tableau', index: 2 }, count: 1 })
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

describe('FreeCell scoreHintMove', () => {
  function moveTo(state: FreeCellState, from: PileRef, count: number, to: PileRef) {
    const move = FreeCellController.legalMoves(state).find((m) => m.from.zone === from.zone && m.from.index === from.index && m.count === count && m.to.zone === to.zone && m.to.index === to.index)
    if (!move) throw new Error(`expected a legal move from=${JSON.stringify(from)} count=${count} to=${JSON.stringify(to)}`)
    return move
  }

  function scoreOf(state: FreeCellState, from: PileRef, count: number, to: PileRef): number {
    return FreeCellController.scoreHintMove!(state, moveTo(state, from, count, to))
  }

  // Regression-shaped test for the same class of bug Spider's/Klondike's own scoreHintMove was
  // built to catch: tearing a card off a nice coherent alt-color run to park it on some unrelated
  // matching card, when the whole run could have relocated intact elsewhere instead.
  it('never prefers fragmenting a coherent run over relocating it intact', () => {
    const state: FreeCellState = {
      tableau: [
        [card('spades-2-0', 'spades', 2)],
        [card('clubs-9-0', 'clubs', 9), card('hearts-8-0', 'hearts', 8), card('clubs-7-0', 'clubs', 7)], // a coherent 3-run: 9(black)-8(red)-7(black)
        [card('diamonds-8-0', 'diamonds', 8)], // only the lone 7 fits here
        [], // the whole 3-run fits here (empty column)
        [card('spades-3-0', 'spades', 3)],
        [card('spades-4-0', 'spades', 4)],
        [card('spades-5-0', 'spades', 5)],
        [card('spades-6-0', 'spades', 6)]
      ],
      freecells: [null, null, null, null],
      foundation: [[], [], [], []]
    }

    const fragmentPartial = scoreOf(state, { zone: 'tableau', index: 1 }, 1, { zone: 'tableau', index: 2 }) // rips the 7 off, onto the lone 8
    const intactRelocation = scoreOf(state, { zone: 'tableau', index: 1 }, 3, { zone: 'tableau', index: 3 }) // the whole run, kept together

    expect(intactRelocation).toBeGreaterThan(fragmentPartial)
    // A whole run relocated intact has zero net run-structure change - freeing the source column
    // and filling the (previously empty) destination column also cancel out, leaving only the tiny
    // move.count tiebreak term, so the total stays small and non-negative.
    expect(intactRelocation).toBeGreaterThanOrEqual(0)
    expect(fragmentPartial).toBeLessThan(0)
  })

  // Empty tableau columns are scarce workspace - actually freeing one (the source column empties
  // and the destination wasn't already empty) should score higher than an otherwise-identical
  // single-card move that leaves the empty-column count unchanged.
  it('rewards a move that actually frees a tableau column over an otherwise-equivalent lateral one', () => {
    const state: FreeCellState = {
      tableau: [
        [card('spades-2-0', 'spades', 2), card('clubs-8-0', 'clubs', 8)], // moving the top card alone does not empty this column
        [card('clubs-6-0', 'clubs', 6)], // a lone card - moving it empties this column
        [card('diamonds-9-0', 'diamonds', 9)], // accepts the black 8
        [card('hearts-7-0', 'hearts', 7)], // accepts the black 6
        [card('spades-3-0', 'spades', 3)],
        [card('spades-4-0', 'spades', 4)],
        [card('spades-5-0', 'spades', 5)],
        [card('spades-9-0', 'spades', 9)]
      ],
      freecells: [null, null, null, null],
      foundation: [[], [], [], []]
    }

    const lateral = scoreOf(state, { zone: 'tableau', index: 0 }, 1, { zone: 'tableau', index: 2 }) // column 0 stays non-empty
    const freesColumn = scoreOf(state, { zone: 'tableau', index: 1 }, 1, { zone: 'tableau', index: 3 }) // column 1 becomes empty

    // Both moves build the same amount of run structure (a lone card onto a lone card) and move the
    // same card count, isolating the empty-column delta as the only real difference between them.
    expect(freesColumn).toBeGreaterThan(lateral)
  })

  // FreeCell's two scarce resources - empty tableau columns and empty freecells - are deliberately
  // NOT weighted equally (see scoreHintMove's own doc comment): freeing a column is worth more
  // because it doubles the supermove ceiling (maxSupermoveCount's 2**emptyCols term) rather than
  // just adding one to it. Spending a freecell to free a column should therefore score noticeably
  // better than spending the board's only empty column to free a freecell.
  it('values freeing a column (by spending a freecell) over freeing a freecell (by spending the only empty column)', () => {
    const state: FreeCellState = {
      tableau: [
        [card('diamonds-5-0', 'diamonds', 5)], // frees this column when parked in a freecell
        [], // the board's only empty column
        [card('spades-2-0', 'spades', 2)],
        [card('spades-3-0', 'spades', 3)],
        [card('spades-4-0', 'spades', 4)],
        [card('spades-6-0', 'spades', 6)],
        [card('spades-7-0', 'spades', 7)],
        [card('spades-9-0', 'spades', 9)]
      ],
      freecells: [card('clubs-10-0', 'clubs', 10), null, null, null],
      foundation: [[], [], [], []]
    }

    const freeColumnSpendFreecell = scoreOf(state, { zone: 'tableau', index: 0 }, 1, { zone: 'freecell', index: 1 })
    const freeFreecellSpendColumn = scoreOf(state, { zone: 'freecell', index: 0 }, 1, { zone: 'tableau', index: 1 })

    expect(freeColumnSpendFreecell).toBeGreaterThan(freeFreecellSpendColumn)
  })

  // Moving a freecell card onto an existing tableau run should credit the full extension - the
  // longer the run it lands on, the higher the score - since a freecell's occupant is treated as a
  // trivially maximal "run of length 1" by the same formula a tableau source uses.
  it('credits extending a longer existing run more than a shorter one when placing a freecell card', () => {
    const state: FreeCellState = {
      tableau: [
        [card('hearts-8-0', 'hearts', 8), card('clubs-7-0', 'clubs', 7), card('diamonds-6-0', 'diamonds', 6)], // a coherent 3-run
        [card('diamonds-10-0', 'diamonds', 10)], // a lone card - a 1-run
        [card('spades-2-0', 'spades', 2)],
        [card('spades-3-0', 'spades', 3)],
        [card('spades-4-0', 'spades', 4)],
        [card('spades-5-0', 'spades', 5)],
        [card('spades-6-0', 'spades', 6)],
        [card('spades-7-0', 'spades', 7)]
      ],
      freecells: [card('clubs-5-0', 'clubs', 5), card('clubs-9-0', 'clubs', 9), null, null],
      foundation: [[], [], [], []]
    }

    const ontoLongRun = scoreOf(state, { zone: 'freecell', index: 0 }, 1, { zone: 'tableau', index: 0 }) // black 5 onto red 6, extending a 3-run
    const ontoShortRun = scoreOf(state, { zone: 'freecell', index: 1 }, 1, { zone: 'tableau', index: 1 }) // black 9 onto red 10, extending a 1-run

    expect(ontoLongRun).toBeGreaterThan(ontoShortRun)
  })

  it('is not asked to score foundation-bound moves (already sorted first by findHint), and returns 0 defensively if it is', () => {
    const state: FreeCellState = {
      tableau: [[card('clubs-1-0', 'clubs', 1)], [], [], [], [], [], [], []],
      freecells: [null, null, null, null],
      foundation: [[], [], [], []]
    }
    const move = { from: { zone: 'tableau', index: 0 }, to: { zone: 'foundation', index: 0 }, count: 1 }
    expect(FreeCellController.scoreHintMove!(state, move)).toBe(0)
  })

  // Regression test: a freecell destination was scored as if it held a "run of length 0", so even
  // a routine, non-fragmenting park (moving a column's own lone top run, however short, into a
  // freecell) was wrongly scored as if it fragmented that run down to nothing. A freecell should
  // score symmetrically to its treatment as a SOURCE (a trivially maximal run of whatever's in it),
  // so storing a card that wasn't extending or building anything anyway should net to a small
  // positive/neutral score (dominated by the empty-column-freed bonus here), never a steep penalty
  // matching genuine fragmentation.
  it('does not penalize parking a column-emptying single card in a freecell as if it fragmented a run', () => {
    const state: FreeCellState = {
      tableau: [
        [card('diamonds-5-0', 'diamonds', 5)], // a lone card - its own top "run" is just itself
        [card('spades-2-0', 'spades', 2)],
        [card('spades-3-0', 'spades', 3)],
        [card('spades-4-0', 'spades', 4)],
        [card('spades-6-0', 'spades', 6)],
        [card('spades-7-0', 'spades', 7)],
        [card('spades-8-0', 'spades', 8)],
        [card('spades-9-0', 'spades', 9)]
      ],
      freecells: [null, null, null, null],
      foundation: [[], [], [], []]
    }

    const parkInFreecell = scoreOf(state, { zone: 'tableau', index: 0 }, 1, { zone: 'freecell', index: 0 })
    // Genuine fragmentation, for contrast: ripping the same-length (1-card) piece off a real
    // 3-card run and parking THAT in a freecell should still score clearly worse.
    const fragmentingState: FreeCellState = {
      ...state,
      tableau: [[card('clubs-9-0', 'clubs', 9), card('hearts-8-0', 'hearts', 8), card('clubs-7-0', 'clubs', 7)], ...state.tableau.slice(1)]
    }
    const fragmentIntoFreecell = scoreOf(fragmentingState, { zone: 'tableau', index: 0 }, 1, { zone: 'freecell', index: 0 })

    expect(parkInFreecell).toBeGreaterThanOrEqual(0)
    expect(parkInFreecell).toBeGreaterThan(fragmentIntoFreecell)
  })
})

describe('moveHeadCard - the card a move is about', () => {
  const state: FreeCellState = {
    tableau: [[card('clubs-9-0', 'clubs', 9), card('hearts-8-0', 'hearts', 8), card('spades-7-0', 'spades', 7)], [], [], [], [], [], [], []],
    freecells: [card('diamonds-4-0', 'diamonds', 4), null, null, null],
    foundation: [[], [], [], []]
  }

  it('is the first card of the run being moved, not the top of the column', () => {
    expect(moveHeadCard(state, { zone: 'tableau', index: 0 }, 1)?.id).toBe('spades-7-0')
    expect(moveHeadCard(state, { zone: 'tableau', index: 0 }, 2)?.id).toBe('hearts-8-0')
    expect(moveHeadCard(state, { zone: 'tableau', index: 0 }, 3)?.id).toBe('clubs-9-0')
  })

  it('is undefined when the pile holds fewer cards than the move claims, or is empty', () => {
    expect(moveHeadCard(state, { zone: 'tableau', index: 0 }, 4)).toBeUndefined()
    expect(moveHeadCard(state, { zone: 'tableau', index: 3 }, 1)).toBeUndefined()
  })

  it('reads a freecell, but only ever for a single card', () => {
    expect(moveHeadCard(state, { zone: 'freecell', index: 0 }, 1)?.id).toBe('diamonds-4-0')
    expect(moveHeadCard(state, { zone: 'freecell', index: 1 }, 1)).toBeUndefined()
    expect(moveHeadCard(state, { zone: 'freecell', index: 0 }, 2)).toBeUndefined()
  })

  it('has no head for a foundation (nothing is ever moved out of one)', () => {
    expect(moveHeadCard(state, { zone: 'foundation', index: 0 }, 1)).toBeUndefined()
  })
})
