import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'

import { markGhostPending } from '@/components/cardFacePaint'
import { Card, Suit } from '@/engine/types'
import { TriPeaksState } from '@/games/tripeaks/rules'
import TriPeaksScreen from '@/games/tripeaks/TriPeaksScreen'

import { resetGameInProgress, seedGameInProgress } from '../../../testUtils/gameInProgressStore'

// ---------------------------------------------------------------------------------------------------------------------
// The REAL TriPeaksScreen's board cells (real rules, flight concurrency, the memoized TriPeaksCell with its real useTakeOffHold
// and real DropZone), with the same kind of stand-ins as tripeaksScreenWin.test.tsx for what needs native views. The ghost
// layer stand-in marks a flight's card as taking off (cardFacePaint.ts's markGhostPending) the way the real one does, and the
// test decides when its ghost "shows". What it pins:
//   - a shake does not replay on a card a New Game dealt COVERED once its covering cards are played off (card ids are reused
//     by every deal, and the cell's DraggableCard is kept from covered to exposed - see TriPeaksCell),
//   - a held cell (its card has just taken off, its ghost is not on screen yet) is not a touch target, while the card its
//     leaving uncovered is already playable,
//   - an unrelated screen render does not re-render a covered cell (TriPeaksCell is memoized, its callbacks stable).
// ---------------------------------------------------------------------------------------------------------------------

const FLIGHT_MS = 80

// Every playShake() is one withSequence() call, so counting those counts the shakes actually played.
const mockWithSequence = jest.fn((...steps: unknown[]) => steps[steps.length - 1])
/** Board DraggableCard renders per card id - what the memoization test counts. */
const mockRenders = new Map<string, number>()
/** The next New Game's board (null: a real shuffled deal). */
let mockNextDeal: TriPeaksState | null = null
/** `defer`: a flight's ghost does not "show" (its take-off mark is not released) until the test says so. */
const mockPaint = { defer: false, waiting: [] as (() => void)[] }

function mockMakeFlight() {
  return {
    hide: () => {},
    flyTo: (_x: number, _y: number, onDone?: () => void) => {
      setTimeout(() => onDone?.(), FLIGHT_MS)
    }
  }
}
const mockGhost = {
  cardRegistry: { register: () => {}, unregister: () => {}, measure: async () => ({ x: 10, y: 10 }) },
  // Like the real DragGhostLayer: the flight's face-up cards are marked as taking off, synchronously, and released when the ghost shows.
  show: (spec: { cards: { id: string; faceUp: boolean }[] }) => {
    const release = markGhostPending(spec.cards.filter((c) => c.faceUp).map((c) => c.id))
    if (mockPaint.defer) mockPaint.waiting.push(release)
    else release()
    return mockMakeFlight()
  }
}
const mockDeal = {
  start: (entries: { cardId: string }[], _w: number, onLanded: (id: string) => void, onDone?: () => void) => {
    setTimeout(() => {
      entries.forEach((e) => onLanded(e.cardId))
      onDone?.()
    }, FLIGHT_MS)
  },
  cancel: () => {}
}

jest.mock('@/redux/store', () => require('../../../testUtils/gameInProgressStore').storeModule)
jest.mock('react-native-reanimated', () => {
  const { useRef } = require('react')
  const base = jest.requireActual('../../../__mocks__/react-native-reanimated')
  return {
    ...base,
    withSequence: (...steps: unknown[]) => mockWithSequence(...steps),
    // Stable for a component's lifetime, like the real ones (the repo-wide mock hands back new ones every render).
    useSharedValue: (initial: unknown) => useRef({ value: initial }).current
  }
})
jest.mock('@/games/tripeaks/rules', () => {
  const actual = jest.requireActual('@/games/tripeaks/rules')
  return {
    ...actual,
    createTriPeaksController: (wrap: boolean) => {
      const controller = actual.createTriPeaksController(wrap)
      return { ...controller, newGame: (seed: number) => mockNextDeal ?? controller.newGame(seed) }
    }
  }
})
jest.mock('@/components/dragdrop/DragGhostLayer', () => ({ DragGhostProvider: ({ children }: { children: unknown }) => children, useDragGhost: () => mockGhost }))
jest.mock('@/components/dealing/DealLayer', () => ({ DealProvider: ({ children }: { children: unknown }) => children, useDealAnimator: () => mockDeal }))
jest.mock('@/components/winning/WinCascadeLayer', () => ({ WinCascadeProvider: ({ children }: { children: unknown }) => children, WinCascadeGhosts: () => null, useWinCascade: () => ({ startChains: () => {}, clear: () => {} }) }))
jest.mock('@/components/dealing/measureView', () => ({ measureView: async () => ({ x: 5, y: 5 }) }))
jest.mock('@/components/RotatedGameView', () => ({ RotatedGameView: ({ children }: { children: unknown }) => children }))
jest.mock('@/components/GameStatusBar', () => ({ GameStatusBar: () => null }))
jest.mock('@/components/useCardSounds', () => ({ useCardSoundEffects: () => ({ playCardSound: () => {}, playInvalidSound: () => {}, hapticCard: () => {}, hapticInvalid: () => {} }) }))
jest.mock('@rific/feedback-press', () => ({ useVibration: () => ({ short: () => {}, selection: () => {} }) }))
jest.mock('@rific/toaster', () => ({ useToast: () => ({ info: () => {} }) }))
jest.mock('@tastic/animations/fireworks', () => ({ Fireworks: () => null }))
jest.mock('@/games/shared/WinBanner', () => ({ WinBanner: () => null }))
jest.mock('@/stores/gameStats', () => ({ useGameStats: () => ({ recordDealWon: () => {}, recordDealAbandoned: () => {}, recordHintUsed: () => {} }) }))
jest.mock('@/stores/lastActiveGame', () => ({ useLastActiveGame: () => ({ setLastActiveGame: () => {}, clearLastActiveGame: () => {} }) }))
jest.mock('@/hooks/useSettings', () => {
  const actual = jest.requireActual('@/redux/settingsSlice')
  return { useSettings: () => ({ settings: { ...actual.DEFAULT_SETTINGS } }) }
})
jest.mock('@/components/theme', () => {
  const actual = jest.requireActual('@/components/theme')
  return { ...actual, useTableColors: () => actual.lightColors }
})
jest.mock('@/components/PlayingCard', () => {
  const { View: MockView } = require('react-native')
  return { PlayingCard: () => <MockView />, EmptySlot: () => <MockView /> }
})
// A board card: the REAL shake hook (so a replayed token really plays), a render counter, and how it is drawn.
jest.mock('@/components/dragdrop/DraggableCard', () => {
  const { Pressable: MockPressable } = require('react-native')
  const { useShakeStyle } = require('@/components/shakeAnimation')
  return {
    DraggableCard: ({ card, disabled, shakeToken, onPress }: { card: { id: string; faceUp: boolean }; disabled?: boolean; shakeToken?: number; onPress?: (measure: () => Promise<{ x: number; y: number }>) => void }) => {
      mockRenders.set(card.id, (mockRenders.get(card.id) ?? 0) + 1)
      useShakeStyle(shakeToken, card.id)
      return <MockPressable testID={`card-${card.id}`} accessibilityLabel={`${disabled ? 'disabled' : 'playable'} ${card.faceUp ? 'face-up' : 'face-down'}`} onPress={() => onPress?.(async () => ({ x: 10, y: 10 }))} />
    }
  }
})
jest.mock('@/components/StockWaste', () => {
  const { Pressable: MockPressable, Text: MockText, View: MockView } = require('react-native')
  return {
    StockWaste: ({ wasteTop, onDrawStock }: { wasteTop?: { id: string }; onDrawStock: () => void }) => (
      <MockView>
        <MockText testID='waste-top'>{wasteTop?.id ?? 'empty'}</MockText>
        <MockPressable testID='stock' onPress={onDrawStock} />
      </MockView>
    )
  }
})
jest.mock('@/components/GameChrome', () => {
  const { Pressable: MockPressable, View: MockView } = require('react-native')
  return {
    GAME_CONTENT_PADDING: 6,
    GameChrome: ({ children, onNewGame }: { children: unknown; onNewGame: () => void }) => (
      <MockView>
        <MockPressable testID='new-game' onPress={onNewGame} />
        {children}
      </MockView>
    )
  }
})

// ------------------------------------------------------------------------------------------------ boards

const card = (suit: Suit, rank: number, faceUp = true): Card => ({ id: `${suit}-${rank}-0`, suit, rank, faceUp }) as Card

// Flat indices: 9 is the first card of row 2, covered by 18 and 19 (the base row, always exposed); 20 is another base card.
const COVERED = 9
const [LEFT, RIGHT, BASE] = [18, 19, 20]

const board = (cards: Record<number, Card>, waste: Card[], stock: Card[] = []): TriPeaksState => ({ tableau: Array.from({ length: 28 }, (_, i) => cards[i] ?? null), waste, stock })

const TEN = card('diamonds', 10)
const SIX = card('hearts', 6)
const SEVEN = card('clubs', 7)
const FIVE = card('spades', 5)
const EIGHT = card('spades', 8)
/** The 6 plays onto the 5, then the 7 onto the 6 - and with both gone the card at 9 is uncovered. The 10 plays onto none of them. */
const UNDER_SIX_AND_SEVEN = (covered: Card) => board({ [COVERED]: covered, [LEFT]: SIX, [RIGHT]: SEVEN, 27: card('clubs', 2) }, [FIVE])

// ------------------------------------------------------------------------------------------------ harness

const STEP_MS = 10

async function flush(ms = 0) {
  if (ms === 0) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0)
    })
    return
  }
  for (let t = 0; t < ms; t += STEP_MS) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(Math.min(STEP_MS, ms - t))
    })
  }
}

async function mount(state: TriPeaksState) {
  seedGameInProgress('tripeaks', { state, undoStack: [], moves: 0, elapsedSeconds: 0, config: 0 })
  await render(<TriPeaksScreen />)
  await flush() // loadGameInProgress -> restoreGame
}

async function press(testID: string) {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID))
  })
}
/** Taps a board card and lets its flight land. */
async function play(c: Card) {
  await press(`card-${c.id}`)
  await flush(FLIGHT_MS + 30)
}
const onBoard = (c: Card) => screen.queryByTestId(`card-${c.id}`) !== null
const look = (c: Card) => screen.getByTestId(`card-${c.id}`).props.accessibilityLabel as string
const renders = (c: Card) => mockRenders.get(c.id) ?? 0
/** The cell's own positioned box (the DropZone's View) around a board card. */
function cellStyle(c: Card): { position?: string; pointerEvents?: string } {
  let node = screen.getByTestId(`card-${c.id}`).parent
  const flat = (n: typeof node) => (StyleSheet.flatten(n?.props.style) ?? {}) as { position?: string; pointerEvents?: string }
  while (node && flat(node).position !== 'absolute') node = node.parent
  return flat(node)
}

beforeEach(() => {
  jest.useFakeTimers()
  mockWithSequence.mockClear()
  mockRenders.clear()
  mockNextDeal = null
  mockPaint.defer = false
})
afterEach(async () => {
  // The take-off registry is module-level: nothing a test left pending may hold a card in the next one.
  mockPaint.waiting.splice(0).forEach((release) => release())
  await act(async () => {
    await jest.runOnlyPendingTimersAsync()
  })
  jest.useRealTimers()
  jest.restoreAllMocks()
})

// ------------------------------------------------------------------------------------------------ tests

// Each test starts with no saved games (the store helper is shared across the file).
afterEach(() => resetGameInProgress())

describe('TriPeaks cells - a shake is never replayed on a card the next deal put under others', () => {
  it('the card shaken last, dealt COVERED by a New Game, does not shake when it is uncovered (as it turns face-up) - and still shakes when tapped stuck', async () => {
    await mount(board({ [BASE]: TEN }, [card('spades', 2)]))
    await press(`card-${TEN.id}`) // the 10 has nowhere to go: it shakes
    expect(mockWithSequence).toHaveBeenCalledTimes(1)

    // The next deal puts the 10 in row 2, under the 6 and the 7 (card ids are reused by every deal).
    mockNextDeal = UNDER_SIX_AND_SEVEN(TEN)
    await press('new-game')
    await flush(FLIGHT_MS + 30) // dealt and landed
    expect(look(TEN)).toBe('disabled face-down')

    await play(SIX)
    await play(SEVEN)
    expect(onBoard(SIX) || onBoard(SEVEN)).toBe(false)
    expect(look(TEN)).toBe('playable face-up')
    expect(mockWithSequence).toHaveBeenCalledTimes(1) // uncovered without a wiggle

    await press(`card-${TEN.id}`) // 10 onto the 7: stuck, a NEW shake still plays
    expect(mockWithSequence).toHaveBeenCalledTimes(2)
  })
})

describe('TriPeaks cells - a held cell is not a touch target', () => {
  it('a played card still drawn while its ghost is not on screen passes touches through to the card it uncovered, which is already playable', async () => {
    await mount(UNDER_SIX_AND_SEVEN(EIGHT))
    await play(SIX)
    expect(cellStyle(SEVEN).pointerEvents).toBeUndefined() // a live cell takes touches as usual

    mockPaint.defer = true // the 7's ghost is not on screen yet: its cell keeps drawing it
    await press(`card-${SEVEN.id}`)
    await flush(10)
    expect(onBoard(SEVEN)).toBe(true)
    expect(look(SEVEN)).toBe('disabled face-up') // held: inert, still its face
    expect(cellStyle(SEVEN).pointerEvents).toBe('none')
    expect(look(EIGHT)).toBe('playable face-up') // the card it uncovered is live in the same moment...
    expect(cellStyle(EIGHT).pointerEvents).toBeUndefined() // ...and takes its touches

    await act(async () => mockPaint.waiting.splice(0).forEach((release) => release())) // the ghost shows: the hold ends
    await flush()
    expect(onBoard(SEVEN)).toBe(false)
  })
})

describe('TriPeaks cells - an unrelated screen render does not re-render a covered cell', () => {
  it('a stuck tap (a shake), a move off another cell and a stock draw re-render the cells that changed, never the covered one', async () => {
    await mount(board({ [COVERED]: EIGHT, [LEFT]: SIX, [RIGHT]: SEVEN, [BASE]: TEN }, [FIVE], [card('clubs', 9, false)]))
    const coveredBefore = renders(EIGHT)
    const shakenBefore = renders(TEN)
    expect(coveredBefore).toBeGreaterThan(0)

    await press(`card-${TEN.id}`) // stuck: a shake
    await play(SIX) // the 6 goes - the 8 is still under the 7
    await press('stock') // a draw: a claim, the commit, the flight, its landing - several screen renders
    await flush(FLIGHT_MS + 30)
    expect(screen.getByTestId('waste-top').props.children).toBe(card('clubs', 9).id)

    expect(renders(TEN)).toBeGreaterThan(shakenBefore) // the counter works: the shaken cell did re-render
    expect(look(EIGHT)).toBe('disabled face-down')
    expect(renders(EIGHT)).toBe(coveredBefore)
  })
})
