import { findHint } from '@/engine/hint'
import { Card } from '@/engine/types'
import { createScorpionController, ScorpionState } from '@/games/scorpion/rules'

const Classic = createScorpionController(false)
const Assisted = createScorpionController(true)

function card(suit: Card['suit'], rank: Card['rank'], faceUp = true, deckIndex = 0): Card {
  return { id: `${suit}-${rank}-${deckIndex}`, suit, rank, faceUp }
}

function countCards(state: ScorpionState): number {
  return state.tableau.reduce((sum, col) => sum + col.length, 0) + state.stock.length
}

describe('Scorpion newGame', () => {
  it('classic variant deals all 52 cards into the tableau with no stock', () => {
    const state = Classic.newGame(12345)

    expect(countCards(state)).toBe(52)
    expect(state.stock.length).toBe(0)
    expect(state.tableau.length).toBe(7)

    for (let col = 0; col < 4; col++) {
      expect(state.tableau[col].length).toBe(7)
      state.tableau[col].forEach((c, i) => expect(c.faceUp).toBe(i >= 3))
    }
    for (let col = 4; col < 7; col++) {
      expect(state.tableau[col].length).toBe(8)
      state.tableau[col].forEach((c) => expect(c.faceUp).toBe(true))
    }
  })

  it('assisted variant holds back exactly 3 cards as a one-shot stock', () => {
    const state = Assisted.newGame(12345)

    expect(countCards(state)).toBe(52)
    expect(state.stock.length).toBe(3)
    state.stock.forEach((c) => expect(c.faceUp).toBe(false))

    for (let col = 0; col < 4; col++) {
      expect(state.tableau[col].length).toBe(7)
      state.tableau[col].forEach((c, i) => expect(c.faceUp).toBe(i >= 3))
    }
    for (let col = 4; col < 7; col++) {
      expect(state.tableau[col].length).toBe(7)
      state.tableau[col].forEach((c) => expect(c.faceUp).toBe(true))
    }
  })

  it('is deterministic given the same seed', () => {
    const a = Classic.newGame(42)
    const b = Classic.newGame(42)
    expect(a.tableau.map((c) => c.map((x) => x.id))).toEqual(b.tableau.map((c) => c.map((x) => x.id)))
  })
})

describe('Scorpion tryMove', () => {
  it('moves a single card onto a same-suit, one-rank-higher target', () => {
    const clubs8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const clubs7: Card = { id: 'clubs-7-0', suit: 'clubs', rank: 7, faceUp: true }
    const state: ScorpionState = { tableau: [[clubs8], [clubs7], [], [], [], [], []], stock: [] }
    const result = Classic.tryMove(state, { from: { zone: 'tableau', index: 1 }, to: { zone: 'tableau', index: 0 }, count: 1 })
    expect(result).not.toBeNull()
    expect(result!.tableau[0].map((c) => c.id)).toEqual(['clubs-8-0', 'clubs-7-0'])
  })

  it('rejects a different suit even at the correct rank', () => {
    const clubs8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const hearts7: Card = { id: 'hearts-7-0', suit: 'hearts', rank: 7, faceUp: true }
    const state: ScorpionState = { tableau: [[clubs8], [hearts7], [], [], [], [], []], stock: [] }
    const result = Classic.tryMove(state, { from: { zone: 'tableau', index: 1 }, to: { zone: 'tableau', index: 0 }, count: 1 })
    expect(result).toBeNull()
  })

  it('rejects a non-adjacent rank of the same suit', () => {
    const clubs8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const clubs5: Card = { id: 'clubs-5-0', suit: 'clubs', rank: 5, faceUp: true }
    const state: ScorpionState = { tableau: [[clubs8], [clubs5], [], [], [], [], []], stock: [] }
    const result = Classic.tryMove(state, { from: { zone: 'tableau', index: 1 }, to: { zone: 'tableau', index: 0 }, count: 1 })
    expect(result).toBeNull()
  })

  it('moves a face-up group as one unit even when the group is NOT itself a valid descending run', () => {
    // clubs-7 (bottom of the group, attaches to the destination - same suit, one rank lower than
    // clubs-8) with a totally unrelated clubs-2 stacked on top of it - not a valid run by any
    // measure (2 doesn't follow 7), but Scorpion doesn't require internal validity, only that
    // every card in the group is face-up (see rules.ts) and the group's own bottom card matches
    // the destination.
    const clubs8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const clubs7: Card = { id: 'clubs-7-0', suit: 'clubs', rank: 7, faceUp: true }
    const clubs2: Card = { id: 'clubs-2-0', suit: 'clubs', rank: 2, faceUp: true }
    const state: ScorpionState = { tableau: [[clubs8], [clubs7, clubs2], [], [], [], [], []], stock: [] }
    const result = Classic.tryMove(state, { from: { zone: 'tableau', index: 1 }, to: { zone: 'tableau', index: 0 }, count: 2 })
    expect(result).not.toBeNull()
    expect(result!.tableau[0].map((c) => c.id)).toEqual(['clubs-8-0', 'clubs-7-0', 'clubs-2-0'])
    expect(result!.tableau[1]).toEqual([])
  })

  it('rejects moving a face-down card', () => {
    const clubs8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const clubs7: Card = { id: 'clubs-7-0', suit: 'clubs', rank: 7, faceUp: false }
    const state: ScorpionState = { tableau: [[clubs8], [clubs7], [], [], [], [], []], stock: [] }
    const result = Classic.tryMove(state, { from: { zone: 'tableau', index: 1 }, to: { zone: 'tableau', index: 0 }, count: 1 })
    expect(result).toBeNull()
  })

  it('accepts any card or group filling an empty column, no King restriction', () => {
    const clubs7: Card = { id: 'clubs-7-0', suit: 'clubs', rank: 7, faceUp: true }
    const state: ScorpionState = { tableau: [[], [clubs7], [], [], [], [], []], stock: [] }
    const result = Classic.tryMove(state, { from: { zone: 'tableau', index: 1 }, to: { zone: 'tableau', index: 0 }, count: 1 })
    expect(result).not.toBeNull()
    expect(result!.tableau[0].map((c) => c.id)).toEqual(['clubs-7-0'])
  })

  it('flips the newly exposed top card of the source column face up', () => {
    const hidden: Card = { id: 'spades-2-0', suit: 'spades', rank: 2, faceUp: false }
    const clubs8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const clubs7: Card = { id: 'clubs-7-0', suit: 'clubs', rank: 7, faceUp: true }
    const state: ScorpionState = { tableau: [[clubs8], [hidden, clubs7], [], [], [], [], []], stock: [] }
    const result = Classic.tryMove(state, { from: { zone: 'tableau', index: 1 }, to: { zone: 'tableau', index: 0 }, count: 1 })
    expect(result).not.toBeNull()
    expect(result!.tableau[1]).toEqual([{ ...hidden, faceUp: true }])
  })
})

describe('Scorpion drawStock (assisted variant)', () => {
  it('deals all 3 held-back cards at once, one onto each of the last 3 columns', () => {
    const stock: Card[] = [1, 2, 3].map((r) => ({ id: `clubs-${r}-0`, suit: 'clubs', rank: r as Card['rank'], faceUp: false }))
    const state: ScorpionState = { tableau: [[], [], [], [], [], [], []], stock }
    const result = Assisted.drawStock!(state)
    expect(result).not.toBeNull()
    expect(result!.stock.length).toBe(0)
    expect(result!.tableau[4].map((c) => c.id)).toEqual(['clubs-1-0'])
    expect(result!.tableau[5].map((c) => c.id)).toEqual(['clubs-2-0'])
    expect(result!.tableau[6].map((c) => c.id)).toEqual(['clubs-3-0'])
    result!.tableau.slice(4).forEach((col) => expect(col[0].faceUp).toBe(true))
  })

  it('returns null once the stock is already empty', () => {
    const state: ScorpionState = { tableau: [[], [], [], [], [], [], []], stock: [] }
    expect(Assisted.drawStock!(state)).toBeNull()
  })

  it('the classic variant always has an empty stock, so drawStock is always null', () => {
    const state = Classic.newGame(1)
    expect(Classic.drawStock!(state)).toBeNull()
  })
})

describe('Scorpion isWon', () => {
  it('is won once every column is either empty or a complete same-suit King-to-Ace run', () => {
    const run: Card[] = Array.from({ length: 13 }, (_, i) => ({ id: `hearts-${13 - i}-0`, suit: 'hearts', rank: (13 - i) as Card['rank'], faceUp: true }))
    const state: ScorpionState = { tableau: [run, [], [], [], [], [], []], stock: [] }
    expect(Classic.isWon(state)).toBe(true)
  })

  it('is not won while any column is neither empty nor a complete run', () => {
    const clubs8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const state: ScorpionState = { tableau: [[clubs8], [], [], [], [], [], []], stock: [] }
    expect(Classic.isWon(state)).toBe(false)
  })

  it('a 13-card pile that is not a valid same-suit descending run does not count as won', () => {
    const junk: Card[] = Array.from({ length: 13 }, (_, i) => ({ id: `card-${i}`, suit: 'hearts', rank: 5 as Card['rank'], faceUp: true }))
    const state: ScorpionState = { tableau: [junk, [], [], [], [], [], []], stock: [] }
    expect(Classic.isWon(state)).toBe(false)
  })
})

describe('Scorpion isStuck', () => {
  it('is stuck when no tableau move exists and the stock is empty', () => {
    const clubs8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const hearts2: Card = { id: 'hearts-2-0', suit: 'hearts', rank: 2, faceUp: true }
    // Every column occupied, no same-suit-adjacent destination for any card, no empty column.
    const state: ScorpionState = { tableau: [[clubs8], [hearts2], [clubs8], [clubs8], [clubs8], [clubs8], [clubs8]], stock: [] }
    expect(Classic.isStuck!(state)).toBe(true)
  })

  it('is never stuck while the assisted stock still has cards', () => {
    const clubs8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const state: ScorpionState = { tableau: [[clubs8], [clubs8], [clubs8], [clubs8], [clubs8], [clubs8], [clubs8]], stock: [{ id: 'stock-1', suit: 'spades', rank: 1, faceUp: false }] }
    expect(Assisted.isStuck!(state)).toBe(false)
  })
})

describe('Scorpion autoMoveHint', () => {
  it('returns the best legal destination for a tapped card', () => {
    const clubs8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const clubs7: Card = { id: 'clubs-7-0', suit: 'clubs', rank: 7, faceUp: true }
    const state: ScorpionState = { tableau: [[clubs8], [clubs7], [], [], [], [], []], stock: [] }
    const move = Classic.autoMoveHint!(state, { zone: 'tableau', index: 1 }, 'clubs-7-0')
    expect(move).toEqual({ from: { zone: 'tableau', index: 1 }, to: { zone: 'tableau', index: 0 }, count: 1 })
  })

  it('returns null when no legal destination exists', () => {
    // hearts2 alone in its column, with every other column occupied by a non-adjacent,
    // different-suit card - nowhere legal to go (an empty column would otherwise always accept it).
    const hearts2: Card = { id: 'hearts-2-0', suit: 'hearts', rank: 2, faceUp: true }
    const clubs8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const blocked: ScorpionState = { tableau: [[hearts2], [clubs8], [clubs8], [clubs8], [clubs8], [clubs8], [clubs8]], stock: [] }
    const move = Classic.autoMoveHint!(blocked, { zone: 'tableau', index: 0 }, 'hearts-2-0')
    expect(move).toBeNull()
  })
})

describe('Scorpion computeLegalMoves destination selection', () => {
  it('collapses to the single best destination for a given (from, count), matching autoMoveHint', () => {
    // Two same-suit, same-rank-continuation destinations exist for the lone clubs-7: an empty
    // column (col0) and a lone clubs-8 (col2). pickBestTableauTarget prefers the larger pile on a
    // buried-count tie (both are 0-buried), so it should pick col2, not col0 - and legalMoves()
    // should report only that one destination, not both.
    const clubs8: Card = { id: 'clubs-8-0', suit: 'clubs', rank: 8, faceUp: true }
    const clubs7: Card = { id: 'clubs-7-0', suit: 'clubs', rank: 7, faceUp: true }
    // Columns 3-6 are unrelated filler (non-empty, non-matching) so col0 and col2 are the only two
    // real candidates - isolating the tie-break this test is about.
    const state: ScorpionState = { tableau: [[], [clubs7], [clubs8], [card('diamonds', 2)], [card('diamonds', 2, true, 1)], [card('diamonds', 2, true, 2)], [card('diamonds', 2, true, 3)]], stock: [] }

    const movesForClubs7 = Classic.legalMoves(state).filter((m) => m.from.index === 1)
    expect(movesForClubs7).toEqual([{ from: { zone: 'tableau', index: 1 }, to: { zone: 'tableau', index: 2 }, count: 1 }])

    const hint = Classic.autoMoveHint!(state, { zone: 'tableau', index: 1 }, 'clubs-7-0')
    expect(hint).toEqual(movesForClubs7[0])
  })
})

describe('Scorpion scoreHintMove', () => {
  const controller = Classic

  function moveTo(state: ScorpionState, from: number, count: number, to: number) {
    const move = controller.legalMoves(state).find((m) => m.from.index === from && m.count === count && m.to.index === to)
    if (!move) throw new Error(`expected a legal move from=${from} count=${count} to=${to}`)
    return move
  }

  function scoreOf(state: ScorpionState, from: number, count: number, to: number) {
    return controller.scoreHintMove!(state, moveTo(state, from, count, to))
  }

  // Regression test for the same class of bug Spider's scorer fixed: tearing a good run apart for
  // no gain should never outscore relocating it intact.
  it('never prefers fragmenting a coherent run over relocating it intact, with nothing gained', () => {
    const state: ScorpionState = {
      tableau: [[], [card('spades', 7)], [card('spades', 9), card('spades', 8), card('spades', 7, true, 1), card('spades', 6)], [card('diamonds', 2)], [card('diamonds', 2, true, 1)], [card('diamonds', 2, true, 2)], [card('diamonds', 2, true, 3)]],
      stock: []
    }

    const fragmentOnto7 = scoreOf(state, 2, 1, 1) // rips the 6 off the run, onto the lone 7
    const partialFragment2 = scoreOf(state, 2, 2, 0) // rips 7,6 off, onto the empty column
    const partialFragment3 = scoreOf(state, 2, 3, 0) // rips 8,7,6 off, onto the empty column
    const intactRelocation = scoreOf(state, 2, 4, 0) // the whole run, kept together
    const harmlessSingle = scoreOf(state, 1, 1, 0) // an unrelated lone-card move, for scale

    // Both only relocate something intact onto nothing longer, so neither gains anything: both
    // score 0 (no size tiebreak, which used to put the 4-card move ahead and kept every relocation
    // above 0, so Hint offered it and then offered moving it straight back).
    expect(intactRelocation).toBe(0)
    expect(harmlessSingle).toBe(0)
    expect(fragmentOnto7).toBeLessThan(harmlessSingle)
    expect(partialFragment2).toBeLessThan(harmlessSingle)
    expect(partialFragment3).toBeLessThan(harmlessSingle)
  })

  it('ranks revealing a face-down card far above a move that reveals nothing', () => {
    const state: ScorpionState = {
      tableau: [[card('spades', 9, false), card('spades', 5)], [card('spades', 6)], [card('diamonds', 3)], [card('diamonds', 4)], [card('clubs', 2)], [card('clubs', 2, true, 1)], [card('clubs', 2, true, 2)]],
      stock: []
    }

    const revealMove = scoreOf(state, 0, 1, 1) // 5 -> 6, exposes the face-down 9
    const plainConsolidation = scoreOf(state, 2, 1, 3) // 3 -> 4, nothing revealed

    expect(revealMove).toBeGreaterThan(plainConsolidation)
    expect(revealMove).toBeGreaterThan(400) // comfortably clears the empty-column/structural range
  })

  it('scores completing a full King-to-Ace run at 1000, clearly above a large fragment of an unrelated run', () => {
    // Ranks 13 (King) down to 2, all hearts - one card short of a complete run.
    const twelveRun = Array.from({ length: 12 }, (_, i) => card('hearts', (13 - i) as Card['rank']))
    const state: ScorpionState = {
      tableau: [twelveRun, [card('hearts', 1)], [card('hearts', 10, true, 1)], [card('diamonds', 3)], [card('diamonds', 3, true, 1)], [card('diamonds', 3, true, 2)], [card('diamonds', 3, true, 3)]],
      stock: []
    }

    const completion = scoreOf(state, 1, 1, 0) // the Ace completes King..Ace
    const bigFragment = scoreOf(state, 0, 8, 2) // 8-card fragment of the 12-run, onto a lone 10

    expect(completion).toBe(1000)
    expect(bigFragment).toBeLessThan(0) // unattractive on its own, not just "less than 1000"
  })

  it('treats empty columns as a resource whose net change matters, not a flat penalty', () => {
    const state: ScorpionState = {
      tableau: [[card('spades', 5)], [card('spades', 9), card('spades', 8), card('spades', 7), card('spades', 6)], [card('spades', 7, true, 1)], [], [card('spades', 10, true, 1)], [card('diamonds', 3)], [card('diamonds', 3, true, 1)]],
      stock: []
    }

    const extendsRunAndFreesColumn = scoreOf(state, 0, 1, 1) // 5 -> the 4-run, frees col0
    const relocatesWholeRunAndFreesColumn = scoreOf(state, 1, 4, 4) // whole run -> a lone 10, frees col1
    const lateralIntoEmptyColumn = scoreOf(state, 2, 1, 3) // lone 7 -> the empty column, net wash
    const fragmentIntoEmptyColumn = scoreOf(state, 1, 2, 3) // rips 7,6 off the run, spends the empty column

    expect(extendsRunAndFreesColumn).toBeGreaterThan(lateralIntoEmptyColumn)
    expect(relocatesWholeRunAndFreesColumn).toBeGreaterThan(lateralIntoEmptyColumn)
    expect(lateralIntoEmptyColumn).toBeGreaterThan(fragmentIntoEmptyColumn)
  })

  // Scorpion-specific case Spider can't produce: a moved group need not be a valid run at all (see
  // rules.ts's header comment), so dragging an unrelated card along on top of an otherwise-valid
  // attach point must NOT be credited as if it extended a coherent run.
  it('does not credit a "dirty" group (valid attach point, incoherent cards riding along above it) as if it were a clean run extension', () => {
    const state: ScorpionState = {
      tableau: [
        [card('clubs', 4), card('spades', 8), card('diamonds', 2)], // moving count=2 drags the diamonds-2 along
        [card('spades', 9)], // valid attach point for the spades-8 at the bottom of that group
        [card('hearts', 7), card('hearts', 6)], // a genuinely clean 2-card run, for contrast
        [card('hearts', 8)], // valid attach point for the clean run
        [card('diamonds', 5)], // unrelated filler - Scorpion always has 7 columns
        [card('diamonds', 5, true, 1)],
        [card('diamonds', 5, true, 2)]
      ],
      stock: []
    }

    const dirtyGroupMove = scoreOf(state, 0, 2, 1)
    const cleanMove = scoreOf(state, 2, 2, 3)

    expect(cleanMove).toBeGreaterThan(dirtyGroupMove)
    // A naive count-based formula (Spider's own shortcut, misapplied here) would credit this move
    // as if it built a 2-length run onto the spades-9 - in the same range as `cleanMove`. The
    // correct, measured-directly value stays low because the diamonds-2 riding on top breaks the
    // run outright.
    expect(dirtyGroupMove).toBeLessThan(20)
  })

  // Hint used to offer moving the 6 from one 7 of spades to the other, then moving it straight back:
  // only the source's run counted before the move, so the 2-card run it left matched the 2-card run
  // it built and both moves scored +2 from the size tiebreak alone.
  it('scores a relocation that gains nothing, and its reverse, at 0, so Hint deals the stock instead of ping-ponging', () => {
    const state: ScorpionState = {
      tableau: [[card('spades', 7), card('spades', 6)], [card('spades', 7, true, 1)], [card('hearts', 13)], [card('diamonds', 13)], [card('clubs', 13)], [card('hearts', 1)], [card('diamonds', 1)]],
      stock: [card('clubs', 5, false), card('clubs', 9, false), card('hearts', 9, false)]
    }
    const there = moveTo(state, 0, 1, 1)
    expect(Assisted.scoreHintMove!(state, there)).toBe(0)

    const back = Assisted.tryMove(state, there)!
    expect(back).not.toBeNull()
    expect(scoreOf(back, 1, 1, 0)).toBe(0)

    expect(findHint(Assisted, state)).toEqual({ kind: 'drawStock' })
    expect(findHint(Assisted, back)).toEqual({ kind: 'drawStock' })
  })

  it('gives no completion credit for moving an already-complete column whole into an empty one, or back', () => {
    const kingToAce = Array.from({ length: 13 }, (_, i) => card('hearts', (13 - i) as Card['rank']))
    const state: ScorpionState = {
      tableau: [kingToAce, [], [card('clubs', 13)], [card('diamonds', 13)], [card('spades', 13)], [card('clubs', 1)], [card('diamonds', 1)]],
      stock: []
    }
    const there = moveTo(state, 0, 13, 1)
    expect(controller.scoreHintMove!(state, there)).toBe(0)

    const back = controller.tryMove(state, there)!
    expect(scoreOf(back, 1, 13, 0)).toBe(0)
  })
})
