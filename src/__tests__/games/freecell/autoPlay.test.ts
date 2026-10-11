import { Card, Suit, SUITS } from '@/engine/types'
import { canAutoFinish, nextFinishMove, nextSafeCascadeStep } from '@/games/freecell/autoPlay'
import { FreeCellState } from '@/games/freecell/rules'

function card(suit: Suit, rank: Card['rank']): Card {
  return { id: `${suit}-${rank}-0`, suit, rank, faceUp: true }
}

/** A run of `suit` from `high` down to `low` - a column already sorted highest to lowest, top card last. */
function column(suit: Suit, high: Card['rank'], low: Card['rank']): Card[] {
  const cards: Card[] = []
  for (let r = high; r >= low; r--) cards.push(card(suit, r as Card['rank']))
  return cards
}

function emptyBoard(): FreeCellState {
  return { tableau: [[], [], [], [], [], [], [], []], freecells: [null, null, null, null], foundation: [[], [], [], []] }
}

/** Foundation pile for `suit` holding Ace..`upTo`. */
function foundationUpTo(suit: Suit, upTo: number): Card[] {
  return column(suit, upTo as Card['rank'], 1).reverse()
}

describe('canAutoFinish / nextFinishMove', () => {
  it('is true once every column is sorted highest to lowest, even with nothing on a foundation yet', () => {
    const state = emptyBoard()
    state.tableau[0] = column('clubs', 13, 1)
    state.tableau[1] = column('diamonds', 13, 1)
    state.tableau[2] = column('hearts', 13, 1)
    state.tableau[3] = column('spades', 13, 1)
    expect(canAutoFinish(state)).toBe(true)
    const step = nextFinishMove(state)!
    expect(step.entry.card.rank).toBe(1) // an ace, whichever suit the scan reaches first
    expect(step.to).toEqual({ zone: 'foundation', index: SUITS.indexOf(step.entry.card.suit) })
  })

  it('counts cards sitting in freecells as finishable', () => {
    const state = emptyBoard()
    state.tableau[0] = column('clubs', 13, 2)
    state.freecells[0] = card('clubs', 1)
    state.tableau[1] = column('diamonds', 13, 1)
    state.tableau[2] = column('hearts', 13, 1)
    state.tableau[3] = column('spades', 13, 1)
    expect(canAutoFinish(state)).toBe(true)
  })

  it('is false while a column has a lower card buried under a higher one of the same suit that is needed first', () => {
    const state = emptyBoard()
    // Clubs: the 2 sits UNDER the 3 with the Ace nowhere accessible - the 3 blocks the 2 forever.
    state.tableau[0] = [card('clubs', 2), card('clubs', 3)]
    state.tableau[1] = [card('clubs', 1), card('diamonds', 13)]
    state.tableau[2] = column('diamonds', 12, 1)
    state.tableau[3] = column('hearts', 13, 1)
    state.tableau[4] = column('spades', 13, 1)
    state.tableau[5] = column('clubs', 13, 4)
    expect(canAutoFinish(state)).toBe(false)
    expect(nextFinishMove(state)).toBeNull()
  })

  it('is false on a won board (nothing left to finish)', () => {
    const state = emptyBoard()
    SUITS.forEach((suit, i) => (state.foundation[i] = foundationUpTo(suit, 13)))
    expect(canAutoFinish(state)).toBe(false)
    expect(nextFinishMove(state)).toBeNull()
  })
})

// Which foundation a card is sent to must be ITS suit's, for every suit - not just whichever one a scan happens to reach first.
describe.each(SUITS)('foundation targeting - %s', (suit) => {
  it("nextFinishMove sends this suit's card to this suit's foundation", () => {
    const state = emptyBoard()
    SUITS.forEach((other, i) => {
      if (other !== suit) state.foundation[i] = foundationUpTo(other, 13)
    })
    state.tableau[0] = column(suit, 13, 1)
    expect(canAutoFinish(state)).toBe(true)
    const step = nextFinishMove(state)!
    expect(step.entry.card).toMatchObject({ suit, rank: 1 })
    expect(step.to).toEqual({ zone: 'foundation', index: SUITS.indexOf(suit) })
  })

  it("nextSafeCascadeStep sends this suit's safe Ace to this suit's foundation", () => {
    const state = emptyBoard()
    state.tableau[0] = [card(suit, 1)] // a lone Ace can never win the game, so the board is not finishable
    expect(canAutoFinish(state)).toBe(false)
    const step = nextSafeCascadeStep(state)
    expect(step?.kind).toBe('play')
    if (step?.kind === 'play') {
      expect(step.entry.card).toMatchObject({ suit, rank: 1 })
      expect(step.to).toEqual({ zone: 'foundation', index: SUITS.indexOf(suit) })
    }
  })
})

describe('nextSafeCascadeStep - the safe-card cascade', () => {
  it('sends up an accessible card that is safe (an ace)', () => {
    const state = emptyBoard()
    // Not finishable: a black 2 buried under a red king in the same column.
    state.tableau[0] = [card('clubs', 2), card('hearts', 13)]
    state.tableau[1] = [card('spades', 1)]
    state.tableau[2] = [card('hearts', 1), card('clubs', 1)]
    expect(canAutoFinish(state)).toBe(false)
    const step = nextSafeCascadeStep(state)
    expect(step?.kind).toBe('play')
    if (step?.kind === 'play') expect(step.entry.card.rank).toBe(1)
  })

  it('leaves alone a card that is legal on its foundation but not yet safe', () => {
    const state = emptyBoard()
    state.foundation[SUITS.indexOf('clubs')] = foundationUpTo('clubs', 1)
    // Black 2 is legal on clubs' foundation, but the red 2s/aces that could still want it as a
    // landing spot are not up yet - not safe. Board is not finishable (a red king buries the red ace).
    state.tableau[0] = [card('clubs', 2)]
    state.tableau[1] = [card('hearts', 1), card('spades', 13)]
    state.tableau[2] = [card('diamonds', 1), card('hearts', 13)]
    expect(canAutoFinish(state)).toBe(false)
    expect(nextSafeCascadeStep(state)).toBeNull()
  })

  it('steps aside the moment the board is finishable - the finish takes over', () => {
    const state = emptyBoard()
    state.tableau[0] = column('clubs', 13, 1)
    state.tableau[1] = column('diamonds', 13, 1)
    state.tableau[2] = column('hearts', 13, 1)
    state.tableau[3] = column('spades', 13, 1)
    expect(canAutoFinish(state)).toBe(true)
    // An ace IS safe here - without stepping aside, both mechanisms would fire the same settle.
    expect(nextSafeCascadeStep(state)).toBeNull()
  })
})
