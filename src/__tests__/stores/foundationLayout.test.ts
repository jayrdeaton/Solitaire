import { FOUNDATION_LAYOUT, FOUNDATION_SUITS } from '@/engine/foundation'
import type { Card, Suit } from '@/engine/types'
import { loadGameInProgress, remapLegacyFoundations, type SavedGame } from '@/stores/gameInProgress'

import { resetGameInProgress, seedGameInProgress } from '../../testUtils/gameInProgressStore'

jest.mock('@/redux/store', () => require('../../testUtils/gameInProgressStore').storeModule)

// The foundation slots used to follow the deck's suit order (clubs, diamonds, hearts, spades) and now follow
// FOUNDATION_SUITS (spades, diamonds, clubs, hearts). A game saved before the switch has to resume with each pile
// in its suit's new slot, or a resumed board would have its clubs in the slot now locked to spades.
const card = (suit: Suit, rank: number): Card => ({ id: `${suit}-${rank}-0`, suit, rank, faceUp: true }) as Card
const pile = (suit: Suit, upTo: number): Card[] => Array.from({ length: upTo }, (_, i) => card(suit, i + 1))
// The old order: clubs, diamonds, hearts, spades.
const oldFoundation = () => [pile('clubs', 3), pile('diamonds', 1), [], pile('spades', 2)]
const oldSave = () => ({
  state: { tableau: [[card('hearts', 5)]], foundation: oldFoundation(), stock: [], waste: [] },
  undoStack: [
    {
      state: { tableau: [[card('clubs', 3)]], foundation: [pile('clubs', 2), pile('diamonds', 1), [], pile('spades', 2)], stock: [], waste: [] },
      move: { from: { zone: 'tableau', index: 0 }, to: { zone: 'foundation', index: 0 }, count: 1, anchorCardId: 'clubs-3-0' }
    }
  ],
  moves: 4,
  elapsedSeconds: 30,
  config: 1
})
const tops = (foundation: Card[][]) => foundation.map((p) => p[p.length - 1]?.id ?? 'empty')

describe('a save from before the foundations followed FOUNDATION_SUITS', () => {
  beforeEach(() => resetGameInProgress())

  it("resumes with every pile, the live board and each undo entry, in its suit's new slot", async () => {
    seedGameInProgress('klondike', { ...oldSave(), foundationLayout: undefined })
    const saved = (await loadGameInProgress('klondike')) as unknown as SavedGame<{ foundation: Card[][] }, { state: { foundation: Card[][] }; move: { to: { zone: string; index: number } } }>
    expect(FOUNDATION_SUITS).toEqual(['spades', 'diamonds', 'clubs', 'hearts'])
    expect(tops(saved.state.foundation)).toEqual(['spades-2-0', 'diamonds-1-0', 'clubs-3-0', 'empty'])
    expect(tops(saved.undoStack![0].state.foundation)).toEqual(['spades-2-0', 'diamonds-1-0', 'clubs-2-0', 'empty'])
    // The undo entry's move named the clubs slot by number: it names clubs' new slot.
    expect(saved.undoStack![0].move.to).toEqual({ zone: 'foundation', index: 2 })
    expect(saved.foundationLayout).toBe(FOUNDATION_LAYOUT)
    // Everything else comes through as it was.
    expect(saved.moves).toBe(4)
    expect(saved.config).toBe(1)
  })

  it('leaves a save made with the new order alone', async () => {
    const current = { ...oldSave(), foundationLayout: FOUNDATION_LAYOUT }
    expect(remapLegacyFoundations('klondike', current)).toBe(current)
  })

  it('leaves Forty Thieves alone: its piles are not locked to a suit', () => {
    const save = { ...oldSave(), state: { ...oldSave().state, foundation: [...oldFoundation(), [], [], [], []] } }
    expect(remapLegacyFoundations('fortythieves', save)).toBe(save)
  })

  it('remaps a save only once: what it hands back is stamped with the new layout', () => {
    const once = remapLegacyFoundations('freecell', oldSave())
    expect(remapLegacyFoundations('freecell', once)).toBe(once)
  })
})
