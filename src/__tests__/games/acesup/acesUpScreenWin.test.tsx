import { act, fireEvent, render, screen } from '@testing-library/react-native'

import { Card, Suit } from '@/engine/types'
import AcesUpScreen from '@/games/acesup/AcesUpScreen'
import { AcesUpState } from '@/games/acesup/rules'

import { resetGameInProgress, seedGameInProgress } from '../../../testUtils/gameInProgressStore'

// ---------------------------------------------------------------------------------------------------------------------
// A screen-level test for what Aces Up's WINNING discard does: the REAL AcesUpScreen (real rules, real useFlightConcurrency /
// useDerivedWinCheck / useStuckLossCheck / useWinReveal / useGameSession / gameInProgress store), seeded with a saved game through
// the test store (src/testUtils/gameInProgressStore.ts). Only the parts that need native views, gestures or animation are replaced, each by a stand-in that honors
// the same contract the screen relies on (same approach as freeCellScreenAutoPlay.test.tsx / pyramidScreenWin.test.tsx):
//   - PileView: renders the card ids it was handed (so the test sees what each pile shows at every moment); a tap calls
//     onPressCard(card, indexFromTop, measure) like the real one.
//   - useDragGhost: a fake ghost whose flights "land" FLIGHT_MS later (the Reanimated mock's withSpring never calls its
//     completion callback). Its CardRegistry is faithful: measure(id) answers only for a card some pile stand-in is rendering
//     RIGHT NOW (at a distinct point per pile), like the real one - the win cascade launches each Ace from its own registered
//     rect, and a pile blanked before that measurement would leave it nothing to find.
//   - useWinCascade: records the chains it was asked to launch, and what the board looked like at that instant.
// The winning discard removes the card on top of one pile, revealing the last Ace: the four Aces are all that is left. The cascade
// used to start on that very commit - over a discard still in the air - and the Aces were hidden at once.
// ---------------------------------------------------------------------------------------------------------------------

const FLIGHT_MS = 80
/** How long the fake ghost takes to land - a test raises it past the win hold to prove the celebration waits for the LANDING. */
let mockFlightMs = FLIGHT_MS
const HOLD_MS = 400 // useWinReveal's WIN_REVEAL_HOLD_MS

const mockRecordWon = jest.fn()

interface MockLog {
  shown: string[]
  inAir: number
  /** The chains the win cascade was launched with (null: it never started), and how many flights were still in the air. */
  chains: { ids: string[]; origin: { x: number; y: number } }[] | null
  airAtWinCascade: number
  /** How many real cards the piles were drawing at the instant the cascade started (-1: it never did). */
  cardsAtCascade: number
  /** The same, at the instant the cascade's ghosts showed (its onShown; -1: they never did). */
  cardsAtGhostsShown: number
  /** Renders of a pile with NO cards before the cascade's ghosts showed: a pile blanked ahead of its ghosts sat empty until they
   * arrived (or, blanked with startChains, under blank-faced ghosts until their faces painted). */
  blankPileRendersBeforeGhosts: number
}
const mockLog: MockLog = { shown: [], inAir: 0, chains: null, airAtWinCascade: -1, cardsAtCascade: -1, cardsAtGhostsShown: -1, blankPileRendersBeforeGhosts: 0 }
/** The real cascade shows - and calls startChains' onShown - only once its parked ghosts' faces have painted, a frame or two after
 * startChains (WinCascadeLayer's CascadeChains); the mock stands in for that wait with a timer. */
const MOCK_GHOSTS_SHOW_MS = 16
let mockGhostsShowTimer: ReturnType<typeof setTimeout> | undefined
let mockFlightsLand = true
/** Card ids a pile stand-in is drawing right now, each at its pile's own point - exactly what CardRegistry.measure can find. */
const mockRegistered = new Map<string, { x: number; y: number }>()
/** Ids the registry is forced to miss even though they are on screen. */
const mockRegistryMisses = new Set<string>()
let mockPileInstance = 0
/** The registry point of pile `index` (distinct from the plain-view point every measureView answer uses, 5 / 5). */
const pilePoint = (index: number) => ({ x: 10 + index * 60, y: 10 })
/** Read from inside the mocked cascade, hence hoisted-mock naming. */
const mockCardsNow = () => screen.queryAllByTestId(/^card-/).length

function mockMakeFlight() {
  return {
    hide: () => {},
    flyTo: (_x: number, _y: number, onDone?: () => void) => {
      mockLog.inAir += 1
      if (!mockFlightsLand) return
      setTimeout(() => {
        mockLog.inAir -= 1
        onDone?.()
      }, mockFlightMs)
    }
  }
}
const mockGhost = {
  cardRegistry: { register: () => {}, unregister: () => {}, measure: async (id: string) => (mockRegistryMisses.has(id) ? null : (mockRegistered.get(id) ?? null)) },
  show: (spec: { cards: { id: string }[] }) => {
    mockLog.shown.push(spec.cards.map((c) => c.id).join('+'))
    return mockMakeFlight()
  }
}
const mockDeal = { start: () => {}, cancel: () => {} }

jest.mock('@/redux/store', () => require('../../../testUtils/gameInProgressStore').storeModule)
jest.mock('@/components/dragdrop/DragGhostLayer', () => ({ DragGhostProvider: ({ children }: { children: unknown }) => children, useDragGhost: () => mockGhost }))
jest.mock('@/components/dealing/DealLayer', () => ({ DealProvider: ({ children }: { children: unknown }) => children, useDealAnimator: () => mockDeal }))
jest.mock('@/components/winning/WinCascadeLayer', () => ({
  // Unmounting drops a cascade that has not shown yet, like the real provider (a test can end mid-wait).
  WinCascadeProvider: ({ children }: { children: unknown }) => {
    require('react').useEffect(() => () => clearTimeout(mockGhostsShowTimer), [])
    return children
  },
  WinCascadeGhosts: () => null,
  useWinCascade: () => ({
    startChains: (chains: { cards: { id: string }[]; origin: { x: number; y: number } }[], _cardWidth: number, onShown?: () => void) => {
      mockLog.chains = chains.map((c) => ({ ids: c.cards.map((card) => card.id), origin: c.origin }))
      mockLog.airAtWinCascade = mockLog.inAir
      mockLog.cardsAtCascade = mockCardsNow()
      // Like the real controller: never for an empty cascade, and dropped by clear() or a newer startChains.
      clearTimeout(mockGhostsShowTimer)
      if (chains.length > 0 && onShown)
        mockGhostsShowTimer = setTimeout(() => {
          mockLog.cardsAtGhostsShown = mockCardsNow()
          onShown()
        }, MOCK_GHOSTS_SHOW_MS)
    },
    clear: () => clearTimeout(mockGhostsShowTimer)
  })
}))
jest.mock('@/components/dealing/measureView', () => ({ measureView: async (view: unknown) => (view ? { x: 5, y: 5 } : null) }))
jest.mock('@/components/useCardSounds', () => ({ useCardSoundEffects: () => ({ playCardSound: () => {}, playInvalidSound: () => {}, hapticCard: () => {}, hapticInvalid: () => {} }) }))
jest.mock('@rific/feedback-press', () => ({ useVibration: () => ({ short: () => {}, selection: () => {} }) }))
jest.mock('@rific/toaster', () => ({ useToast: () => ({ info: () => {} }) }))
jest.mock('@tastic/sprites/fireworks', () => {
  const { View: MockView } = require('react-native')
  return { Fireworks: () => <MockView testID='fireworks' /> }
})
jest.mock('@/games/shared/WinBanner', () => {
  const { Text: MockText } = require('react-native')
  return { WinBanner: () => <MockText testID='win-banner'>won</MockText> }
})
jest.mock('@/games/shared/LossBanner', () => {
  const { Text: MockText } = require('react-native')
  return { LossBanner: () => <MockText testID='loss-banner'>lost</MockText> }
})
jest.mock('@/stores/gameStats', () => ({ useGameStats: () => ({ recordDealWon: mockRecordWon, recordDealAbandoned: () => {}, recordHintUsed: () => {} }) }))
jest.mock('@/stores/lastActiveGame', () => ({ useLastActiveGame: () => ({ setLastActiveGame: () => {}, clearLastActiveGame: () => {} }) }))
jest.mock('@/components/theme', () => {
  const actual = jest.requireActual('@/components/theme')
  return { ...actual, useTableColors: () => actual.lightColors }
})
jest.mock('@/components/PlayingCard', () => {
  const { View: MockView } = require('react-native')
  return { PlayingCard: () => <MockView />, EmptySlot: () => <MockView /> }
})
jest.mock('@/components/dragdrop/DropZone', () => ({ DropZone: ({ children }: { children: unknown }) => children }))
jest.mock('@/games/shared/DiscardCell', () => {
  const { Text: MockText, View: MockView } = require('react-native')
  return {
    DiscardCell: ({ card, isFlyingHere, viewRef }: { card?: { id: string }; isFlyingHere: boolean; viewRef: never }) => (
      <MockView ref={viewRef} collapsable={false}>
        <MockText testID='discard-top'>{card ? card.id : 'empty'}</MockText>
        <MockText testID='discard-flying'>{String(isFlyingHere)}</MockText>
      </MockView>
    )
  }
})
jest.mock('@/components/PileView', () => {
  const { Pressable: MockPressable, View: MockView } = require('react-native')
  const { useEffect, useRef } = require('react')
  return {
    PileView: (props: { cards: Card[]; onPressCard: (card: Card, indexFromTop: number, measure: () => Promise<{ x: number; y: number }>) => void }) => {
      const pile = useRef(mockPileInstance++).current % 4
      if (props.cards.length === 0 && mockLog.cardsAtGhostsShown === -1) mockLog.blankPileRendersBeforeGhosts += 1
      // Like PileView's own per-card registration: every card drawn is measurable (at its pile's point), nothing else is.
      const key = props.cards.map((c) => c.id).join(',')
      useEffect(() => {
        const ids = key ? key.split(',') : []
        ids.forEach((cardId) => mockRegistered.set(cardId, pilePoint(pile)))
        return () => ids.forEach((cardId) => mockRegistered.delete(cardId))
      }, [key, pile])
      return (
        <MockView>
          {props.cards.map((card, i) => (
            <MockPressable key={card.id} testID={`card-${card.id}`} onPress={() => props.onPressCard(card, props.cards.length - 1 - i, async () => ({ x: 10, y: 10 }))} />
          ))}
        </MockView>
      )
    }
  }
})
jest.mock('@/components/GameChrome', () => {
  const { Pressable: MockPressable, View: MockView } = require('react-native')
  return {
    GAME_CONTENT_PADDING: 6,
    GameChrome: ({ children, onUndo, onNewGame }: { children: unknown; onUndo: () => void; onNewGame: () => void }) => (
      <MockView>
        <MockPressable testID='undo' onPress={onUndo} />
        <MockPressable testID='new-game' onPress={onNewGame} />
        {children}
      </MockView>
    )
  }
})

// ------------------------------------------------------------------------------------------------ boards

const card = (suit: Suit, rank: number): Card => ({ id: `${suit}-${rank}-0`, suit, rank, faceUp: true }) as Card
const id = (suit: Suit, rank: number) => `${suit}-${rank}-0`
const state = (piles: Card[][], discard: Card[] = [card('hearts', 9), card('clubs', 4)]): AcesUpState => ({ piles, stock: [], discard })

/** Discarding the 5 of spades (the Ace of spades, on another pile, outranks it) leaves the four Aces: the game is won. */
const ONE_DISCARD_FROM_WON = () => state([[card('hearts', 1), card('spades', 5)], [card('spades', 1)], [card('diamonds', 1)], [card('clubs', 1)]])
/** Two discards from won: the 5 of spades (the Ace of spades outranks it), then the 6 of hearts (the Ace of hearts, on top of another pile, outranks that). */
const TWO_DISCARDS_FROM_WON = () => state([[card('hearts', 6), card('spades', 5)], [card('spades', 1)], [card('diamonds', 1)], [card('clubs', 1), card('hearts', 1)]])

// ------------------------------------------------------------------------------------------------ harness

const STEP_MS = 10

/** Advances fake time by `ms`, in small steps each inside its OWN act() - see freeCellScreenAutoPlay.test.tsx. */
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

async function mount(saved: AcesUpState, expectedCards: number) {
  seedGameInProgress('acesup', { state: saved, undoStack: [], moves: 0, elapsedSeconds: 0 })
  await render(<AcesUpScreen />)
  await flush() // loadGameInProgress -> restoreGame
  expect(screen.queryAllByTestId(/^card-/).length).toBe(expectedCards)
}

const text = (testID: string) => screen.getByTestId(testID).props.children as string
const cardsOnBoard = () =>
  screen
    .queryAllByTestId(/^card-/)
    .map((n) => n.props.testID as string)
    .sort()

async function tap(cardId: string) {
  await act(async () => {
    fireEvent.press(screen.getByTestId(`card-${cardId}`))
  })
}

beforeEach(() => {
  jest.useFakeTimers()
  mockLog.shown = []
  mockLog.inAir = 0
  mockLog.chains = null
  mockLog.airAtWinCascade = -1
  mockLog.cardsAtCascade = -1
  mockLog.cardsAtGhostsShown = -1
  mockLog.blankPileRendersBeforeGhosts = 0
  mockRegistered.clear()
  mockRegistryMisses.clear()
  mockPileInstance = 0
  mockFlightsLand = true
  mockFlightMs = FLIGHT_MS
  mockRecordWon.mockClear()
})
afterEach(async () => {
  await act(async () => {
    await jest.runOnlyPendingTimersAsync()
  })
  jest.useRealTimers()
  jest.restoreAllMocks()
})

// Each test starts with no saved games (the store helper is shared across the file).
afterEach(() => resetGameInProgress())

describe('Aces Up screen - the winning discard', () => {
  it('flies to the discard, and neither the four Aces nor the banner change until it has landed and a beat has passed', async () => {
    await mount(ONE_DISCARD_FROM_WON(), 5)

    await tap(id('spades', 5))
    await flush(10) // the move has committed and its ghost is in the air

    expect(mockRecordWon).toHaveBeenCalledTimes(1) // the win is recorded the instant it happens...
    expect(mockLog.shown).toEqual([id('spades', 5)])
    expect(mockLog.inAir).toBe(1) // ...the winning card really is flying to the discard...
    expect(text('discard-flying')).toBe('true')
    expect(cardsOnBoard()).toEqual([id('clubs', 1), id('diamonds', 1), id('hearts', 1), id('spades', 1)].map((c) => `card-${c}`).sort()) // ...over four Aces that are all still on the board,
    expect(screen.queryByTestId('win-banner')).toBeNull() // with no celebration yet
    expect(screen.queryByTestId('fireworks')).toBeNull()
    expect(mockLog.chains).toBeNull()

    await flush(FLIGHT_MS) // the flight lands
    expect(mockLog.inAir).toBe(0)
    expect(text('discard-flying')).toBe('false')
    expect(text('discard-top')).toBe(id('spades', 5)) // the discard shows the card that flew there
    expect(cardsOnBoard()).toHaveLength(4) // the completed board holds for a beat
    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(screen.queryByTestId('fireworks')).toBeNull()
    expect(mockLog.chains).toBeNull()

    await flush(HOLD_MS + 50) // then the celebration takes over
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(screen.getByTestId('fireworks')).toBeTruthy()
    expect(cardsOnBoard()).toHaveLength(0) // the real Aces give way to the cascade...
    expect(mockLog.chains!.map((c) => c.ids)).toEqual([[id('hearts', 1)], [id('spades', 1)], [id('diamonds', 1)], [id('clubs', 1)]]) // ...which launches each of them,
    expect(mockLog.airAtWinCascade).toBe(0) // with nothing left in the air
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
  })

  it('waits for the LANDING, not just for time to pass: a flight slower than the hold keeps the celebration back until it lands', async () => {
    await mount(ONE_DISCARD_FROM_WON(), 5)
    mockFlightMs = 1200

    await tap(id('spades', 5))
    await flush(HOLD_MS * 2) // well past the hold, the discard still in the air
    expect(mockLog.inAir).toBe(1)
    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(screen.queryByTestId('fireworks')).toBeNull()
    expect(mockLog.chains).toBeNull()
    expect(cardsOnBoard()).toHaveLength(4)

    await flush(1200 - HOLD_MS * 2 + 10) // it lands
    expect(mockLog.inAir).toBe(0)
    expect(screen.queryByTestId('win-banner')).toBeNull() // and only then does the beat start
    expect(screen.queryByTestId('fireworks')).toBeNull()
    await flush(HOLD_MS + 50)
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(screen.getByTestId('fireworks')).toBeTruthy()
    expect(mockLog.airAtWinCascade).toBe(0)
  })

  it('is not withheld by a flight that never lands', async () => {
    await mount(ONE_DISCARD_FROM_WON(), 5)
    mockFlightsLand = false

    await tap(id('spades', 5))
    await flush(3000)

    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(screen.getByTestId('fireworks')).toBeTruthy()
    expect(mockLog.chains).not.toBeNull()
  })

  it('launches each Ace from its own drawn card, and the piles blank only as the ghosts arrive: the real Aces are still on the board when the cascade starts', async () => {
    await mount(ONE_DISCARD_FROM_WON(), 5)

    await tap(id('spades', 5))
    await flush(FLIGHT_MS + HOLD_MS + 50)

    // Each chain's origin is where its own Ace was DRAWN (the registry's rect - card-sized, which the ghost overlay's rotation conversion
    // needs) - not the pile's container, which with a card in it is as tall as the whole column.
    expect(mockLog.chains).toEqual([
      { ids: [id('hearts', 1)], origin: pilePoint(0) },
      { ids: [id('spades', 1)], origin: pilePoint(1) },
      { ids: [id('diamonds', 1)], origin: pilePoint(2) },
      { ids: [id('clubs', 1)], origin: pilePoint(3) }
    ])
    // The cascade measured (and mounted its parked ghosts) while all four Aces were still drawn and kept them drawn until the ghosts
    // were on screen (their faces paint a frame or two after they mount: blanking with startChains showed four blank-faced Aces),
    // and no pile ever sat empty before that: blanking on the reveal alone left the four piles empty for the few frames the
    // measurement takes, then the ghosts appeared.
    expect(mockLog.cardsAtCascade).toBe(4)
    expect(mockLog.cardsAtGhostsShown).toBe(4)
    expect(mockLog.blankPileRendersBeforeGhosts).toBe(0)
    expect(cardsOnBoard()).toHaveLength(0) // and they are blank now
    expect(screen.getByTestId('win-banner')).toBeTruthy()
  })

  it('leaves the finished piles up when no chain can start, instead of blanking them with nothing to show', async () => {
    await mount(ONE_DISCARD_FROM_WON(), 5)
    ;[id('hearts', 1), id('spades', 1), id('diamonds', 1), id('clubs', 1)].forEach((aceId) => mockRegistryMisses.add(aceId)) // no Ace can be measured

    await tap(id('spades', 5))
    await flush(FLIGHT_MS + HOLD_MS + 50)

    expect(screen.getByTestId('win-banner')).toBeTruthy() // the win is celebrated all the same
    expect(mockLog.chains).toEqual([]) // with no chain to launch
    expect(cardsOnBoard()).toHaveLength(4) // so the Aces stay where the finished board showed them
  })

  it('blanks only the piles whose own chain started: an Ace that cannot be measured stays up', async () => {
    await mount(ONE_DISCARD_FROM_WON(), 5)
    mockRegistryMisses.add(id('diamonds', 1))

    await tap(id('spades', 5))
    await flush(FLIGHT_MS + HOLD_MS + 50)

    expect(mockLog.chains!.map((c) => c.ids)).toEqual([[id('hearts', 1)], [id('spades', 1)], [id('clubs', 1)]])
    expect(cardsOnBoard()).toEqual([`card-${id('diamonds', 1)}`]) // the pile with no chain keeps its Ace
  })

  it('an undo out of the celebration brings the piles back, and a re-win never blanks them without a cascade to show', async () => {
    await mount(ONE_DISCARD_FROM_WON(), 5)
    await tap(id('spades', 5))
    await flush(FLIGHT_MS + HOLD_MS + 50)
    expect(cardsOnBoard()).toHaveLength(0)

    await act(async () => {
      fireEvent.press(screen.getByTestId('undo'))
    })
    await flush(FLIGHT_MS + 200)
    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(cardsOnBoard()).toHaveLength(5) // the discard is undone and every pile shows

    // Winning again does not relaunch the cascade (the win is only recorded - and its cascade only queued - once per deal), so nothing
    // takes over from the finished piles: they must stay up under the banner, not blank with nothing to show.
    mockLog.chains = null
    await tap(id('spades', 5))
    await flush(FLIGHT_MS + HOLD_MS + 50)
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(mockLog.chains).toBeNull()
    expect(cardsOnBoard()).toHaveLength(4)
  })

  it('an ordinary discard on the way there does not celebrate anything', async () => {
    await mount(TWO_DISCARDS_FROM_WON(), 6)

    await tap(id('spades', 5)) // discards, but the 6 of hearts is still to go
    await flush(FLIGHT_MS + HOLD_MS + 50)

    expect(mockRecordWon).not.toHaveBeenCalled()
    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(screen.queryByTestId('fireworks')).toBeNull()
    expect(mockLog.chains).toBeNull()
    expect(cardsOnBoard()).toHaveLength(5)
  })
})
