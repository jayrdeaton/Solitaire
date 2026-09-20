import AsyncStorage from '@react-native-async-storage/async-storage'
import { act, fireEvent, render, screen } from '@testing-library/react-native'

import { Card, Suit } from '@/engine/types'
import { TriPeaksState } from '@/games/tripeaks/rules'
import TriPeaksScreen from '@/games/tripeaks/TriPeaksScreen'

// ---------------------------------------------------------------------------------------------------------------------
// A screen-level test for TriPeaks' win: the REAL TriPeaksScreen, real rules, real useFlightConcurrency / useDerivedWinCheck /
// useWinReveal / useGameSession / gameInProgress store, seeded with a saved game through the AsyncStorage mock (same
// approach as freeCellScreenAutoPlay.test.tsx). Only the parts that need native views, gestures or animation are replaced
// by stand-ins that honour the contract the screen relies on:
//   - the ghost's CardRegistry is modelled on what is actually RENDERED: a card can only be measured while a stand-in
//     (an exposed tableau DraggableCard / StockWaste waste top) is showing it - which is the real failure the win used to hit, since hiding the
//     waste top on `won` unregistered the very card the winning flight was measuring to land on.
//   - a fake ghost whose flights "land" FLIGHT_MS later (the Reanimated mock's withSpring never calls its completion callback).
//   - measureView (plain-view measurement) answers with a DIFFERENT point than the registry, so a test can tell which of the
//     two a flight was aimed at.
// ---------------------------------------------------------------------------------------------------------------------

const FLIGHT_MS = 80
const HOLD_MS = 400 // useWinReveal's WIN_REVEAL_HOLD_MS
const SAVE_KEY = 'solitaire.game-in-progress.v1.tripeaks'
const REGISTRY_POINT = { x: 10, y: 10 }
const VIEW_POINT = { x: 5, y: 5 }

const mockRecordWon = jest.fn()
/** How long a fake flight takes to land. */
let mockFlightMs = FLIGHT_MS
/** Card ids a stand-in is showing right now - exactly what CardRegistry.measure can find. */
const mockRegistered = new Set<string>()
/** Ids the registry is forced to miss even though they are on screen. */
const mockRegistryMisses = new Set<string>()

const mockLog = {
  /** Every ghost.show() - one per card flight the screen started (tap, drop, draw, undo), with where it took off from. */
  shown: [] as { id: string; from: { x: number; y: number } }[],
  /** Where every flyTo() was aimed. */
  flown: [] as { x: number; y: number }[],
  /** hide() calls - a ghost dismissed instead of flying, i.e. the card just appears. */
  hidden: 0,
  inAir: 0,
  /** Every startChains() call, with how many flights were still in the air when it happened. */
  cascades: [] as number[],
  /** What the waste showed (its top card's id, or 'empty') at the instant of each startChains() - the real pile must still be drawn then. */
  wasteAtCascade: [] as string[],
  /** The waste's successive appearances (consecutive repeats collapsed) with a 'startChains' marker where the cascade started: a pile that is blanked BEFORE the marker sat empty until the ghosts arrived. */
  timeline: [] as string[]
}
/** Read from inside the mocked cascade / stand-in, hence hoisted-mock naming. */
const mockWasteNow = () => screen.getByTestId('waste-top').props.children as string
const mockMark = (entry: string) => {
  if (mockLog.timeline[mockLog.timeline.length - 1] !== entry) mockLog.timeline.push(entry)
}
/** measureView's answer - false makes every plain-view measurement fail (mutable: one test starves the cascade of its origin). */
let mockViewMeasurable = true

function mockMakeFlight() {
  return {
    hide: () => void (mockLog.hidden += 1),
    flyTo: (x: number, y: number, onDone?: () => void) => {
      mockLog.flown.push({ x, y })
      mockLog.inAir += 1
      setTimeout(() => {
        mockLog.inAir -= 1
        onDone?.()
      }, mockFlightMs)
    }
  }
}
const mockGhost = {
  cardRegistry: { register: () => {}, unregister: () => {}, measure: async (id: string) => (mockRegistered.has(id) && !mockRegistryMisses.has(id) ? mockRegistryPoint() : null) },
  show: (spec: { cards: { id: string }[] }, from: { x: number; y: number }) => {
    mockLog.shown.push({ id: spec.cards.map((c) => c.id).join('+'), from })
    return mockMakeFlight()
  }
}
function mockRegistryPoint() {
  return { ...REGISTRY_POINT }
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

jest.mock('@/components/dragdrop/DragGhostLayer', () => ({ DragGhostProvider: ({ children }: { children: unknown }) => children, useDragGhost: () => mockGhost }))
jest.mock('@/components/dealing/DealLayer', () => ({ DealProvider: ({ children }: { children: unknown }) => children, useDealAnimator: () => mockDeal }))
jest.mock('@/components/winning/WinCascadeLayer', () => ({
  WinCascadeProvider: ({ children }: { children: unknown }) => children,
  WinCascadeGhosts: () => null,
  useWinCascade: () => ({
    startChains: () => {
      mockLog.cascades.push(mockLog.inAir)
      mockLog.wasteAtCascade.push(mockWasteNow())
      mockLog.timeline.push('startChains')
    },
    clear: () => {}
  })
}))
jest.mock('@/components/dealing/measureView', () => ({ measureView: async () => (mockViewMeasurable ? { x: 5, y: 5 } : null) }))
jest.mock('@/components/RotatedGameView', () => ({ RotatedGameView: ({ children }: { children: unknown }) => children }))
jest.mock('@/components/GameStatusBar', () => ({ GameStatusBar: () => null }))
jest.mock('@/components/useCardSounds', () => ({ useCardSoundEffects: () => ({ playCardSound: () => {}, playInvalidSound: () => {}, hapticCard: () => {}, hapticInvalid: () => {} }) }))
jest.mock('@rific/feedback-press', () => ({ useVibration: () => ({ short: () => {}, selection: () => {} }) }))
jest.mock('@rific/toaster', () => ({ useToast: () => ({ info: () => {} }) }))
jest.mock('@tastic/animations/fireworks', () => {
  const { View: MockView } = require('react-native')
  return { Fireworks: () => <MockView testID='fireworks' /> }
})
jest.mock('@/games/shared/WinBanner', () => {
  const { Text: MockText } = require('react-native')
  return { WinBanner: () => <MockText testID='win-banner'>won</MockText> }
})
jest.mock('@/stores/gameStats', () => ({ useGameStats: () => ({ recordDealWon: mockRecordWon, recordDealAbandoned: () => {}, recordHintUsed: () => {} }) }))
jest.mock('@/stores/lastActiveGame', () => ({ useLastActiveGame: () => ({ setLastActiveGame: () => {}, clearLastActiveGame: () => {} }) }))
jest.mock('@/stores/settings', () => {
  const actual = jest.requireActual('@/stores/settings')
  return { ...actual, useSettings: () => ({ settings: { ...actual.DEFAULT_SETTINGS } }) }
})
jest.mock('@/components/theme', () => {
  const actual = jest.requireActual('@/components/theme')
  return { ...actual, useTableColors: () => actual.lightColors }
})
jest.mock('@/components/dragdrop/DropZone', () => ({ DropZone: ({ children }: { children: unknown }) => children }))
jest.mock('@/components/PlayingCard', () => {
  const { View: MockView } = require('react-native')
  return { PlayingCard: () => <MockView />, EmptySlot: () => <MockView /> }
})
jest.mock('@/components/dragdrop/DraggableCard', () => {
  const { Pressable: MockPressable, Text: MockText } = require('react-native')
  const { useEffect } = require('react')
  return {
    // An exposed tableau card - registered (measurable) for as long as it is rendered, hidden or not, like the real one.
    DraggableCard: ({ card, hidden, onPress }: { card: { id: string }; hidden?: boolean; onPress: (measure: () => Promise<{ x: number; y: number }>) => void }) => {
      const cardId = card.id
      useEffect(() => {
        mockRegistered.add(cardId)
        return () => void mockRegistered.delete(cardId)
      }, [cardId])
      return (
        <MockPressable testID={`card-${cardId}`} onPress={() => onPress(async () => ({ x: 10, y: 10 }))}>
          <MockText testID={`hidden-${cardId}`}>{hidden ? 'hidden' : 'shown'}</MockText>
        </MockPressable>
      )
    }
  }
})
jest.mock('@/components/StockWaste', () => {
  const { Pressable: MockPressable, Text: MockText, View: MockView } = require('react-native')
  const { useEffect } = require('react')
  return {
    StockWaste: ({ wasteTop, wasteHiddenCount, onDrawStock }: { wasteTop?: { id: string }; wasteHiddenCount?: number; onDrawStock: () => void }) => {
      const wasteId = wasteTop?.id
      mockMark(wasteId ?? 'empty')
      // Like the real one: the waste top stays registered (measurable) even while it is hidden mid-flight.
      useEffect(() => {
        if (!wasteId) return
        mockRegistered.add(wasteId)
        return () => void mockRegistered.delete(wasteId)
      }, [wasteId])
      return (
        <MockView>
          <MockText testID='waste-top'>{wasteId ?? 'empty'}</MockText>
          <MockText testID='waste-hidden-count'>{String(wasteHiddenCount ?? 0)}</MockText>
          <MockPressable testID='stock' onPress={onDrawStock} />
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

const id = (suit: Suit, rank: number) => `${suit}-${rank}-0`
const card = (suit: Suit, rank: number, faceUp = true): Card => ({ id: id(suit, rank), suit, rank, faceUp }) as Card

/** A board with only the given base-row cards left (flat index -> card): the base row (indices 18-27) is exposed from the start. */
const board = (cards: Record<number, Card>, waste: Card[], stock: Card[] = []): TriPeaksState => ({ tableau: Array.from({ length: 28 }, (_, i) => cards[i] ?? null), waste, stock })
/** Every card is gone from the peaks except the 6 of hearts, which goes onto the 5 of spades: tapping it wins the game. */
const ONE_CARD_FROM_WON = (): TriPeaksState => board({ 20: card('hearts', 6) }, [card('spades', 5)])
/** One card left in a face-down stock (the 9 of clubs), over the 5 of spades on the waste: drawing turns the 9 up onto the waste. */
const ONE_IN_STOCK = (): TriPeaksState => board({ 20: card('hearts', 6) }, [card('spades', 5)], [card('clubs', 9, false)])
/** Two cards left (the second, 7 of clubs, only goes onto the 6 - so the win is NOT one move away). */
const TWO_CARDS_LEFT = (): TriPeaksState => board({ 20: card('hearts', 6), 21: card('clubs', 7) }, [card('spades', 5)])

// ------------------------------------------------------------------------------------------------ harness

const STEP_MS = 10

/** Advances fake time in small steps, each inside its OWN act(): React only processes the renders and effects a step's timers
 * queued when its act scope exits, and "land -> render -> effect -> next" is a chain. */
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
  jest.spyOn(AsyncStorage, 'getItem').mockImplementation(async (key: string) => (key === SAVE_KEY ? JSON.stringify({ state, undoStack: [], moves: 0, elapsedSeconds: 0, config: 0 }) : null))
  await render(<TriPeaksScreen />)
  await flush() // loadGameInProgress -> restoreGame
}

const wasteTop = () => screen.getByTestId('waste-top').props.children as string
const banner = () => screen.queryByTestId('win-banner')
const fireworks = () => screen.queryByTestId('fireworks')

async function tap(cardId: string) {
  await act(async () => {
    fireEvent.press(screen.getByTestId(`card-${cardId}`))
  })
}

async function drawStock() {
  await act(async () => {
    fireEvent.press(screen.getByTestId('stock'))
  })
}

async function undo() {
  await act(async () => {
    fireEvent.press(screen.getByTestId('undo'))
  })
}

beforeEach(() => {
  jest.useFakeTimers()
  mockRegistered.clear()
  mockRegistryMisses.clear()
  mockLog.shown = []
  mockLog.flown = []
  mockLog.hidden = 0
  mockLog.inAir = 0
  mockLog.cascades = []
  mockLog.wasteAtCascade = []
  mockLog.timeline = []
  mockViewMeasurable = true
  mockRecordWon.mockClear()
  mockFlightMs = FLIGHT_MS
})
afterEach(async () => {
  await act(async () => {
    await jest.runOnlyPendingTimersAsync()
  })
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('TriPeaks screen - the win celebration waits for the winning card to fly in and land', () => {
  it('the winning card flies onto the still-visible waste pile, and nothing celebrates until it has landed and a beat has passed', async () => {
    await mount(ONE_CARD_FROM_WON())
    expect(wasteTop()).toBe(id('spades', 5))

    await tap(id('hearts', 6))
    await flush(10) // the move has committed and its ghost is in the air

    expect(mockRecordWon).toHaveBeenCalledTimes(1) // the win is recorded the instant it happens...
    expect(mockLog.shown).toEqual([{ id: id('hearts', 6), from: REGISTRY_POINT }])
    expect(mockLog.inAir).toBe(1) // ...the winning card really is flying...
    expect(mockLog.flown).toEqual([REGISTRY_POINT]) // ...to the registered waste top card (not a fallback)...
    expect(mockLog.hidden).toBe(0) // ...instead of the ghost being dismissed and the card just appearing
    expect(wasteTop()).toBe(id('hearts', 6)) // the pile it is flying to is still showing the card,
    expect(banner()).toBeNull() // with no celebration yet
    expect(fireworks()).toBeNull()
    expect(mockLog.cascades).toEqual([])

    await flush(FLIGHT_MS) // the flight lands
    expect(mockLog.inAir).toBe(0)
    expect(wasteTop()).toBe(id('hearts', 6)) // the completed board holds for a beat
    expect(banner()).toBeNull()
    expect(fireworks()).toBeNull()
    expect(mockLog.cascades).toEqual([])

    await flush(HOLD_MS + 50)
    expect(banner()).toBeTruthy() // then the celebration takes over
    expect(fireworks()).toBeTruthy()
    expect(wasteTop()).toBe('empty') // the real pile gives way to the win cascade
    expect(mockLog.cascades).toEqual([0]) // which starts with nothing left in the air
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
    expect(mockLog.hidden).toBe(0)
  })

  it('hands the pile over to the cascade in ONE commit: the real waste card is still drawn when the cascade starts, and blanks only after it', async () => {
    await mount(ONE_CARD_FROM_WON())
    mockLog.timeline = []

    await tap(id('hearts', 6))
    await flush(FLIGHT_MS + HOLD_MS + 50)

    expect(mockLog.cascades).toEqual([0])
    // The cascade measured (and mounted its parked ghosts) while the pile still showed its card...
    expect(mockLog.wasteAtCascade).toEqual([id('hearts', 6)])
    // ...and the pile never sat empty before that: blanking on the reveal alone left the waste slot empty for the few frames
    // runWinCascade takes to measure, then the ghosts appeared (a pile that teleported away).
    expect(mockLog.timeline.slice(0, mockLog.timeline.indexOf('startChains'))).not.toContain('empty')
    expect(mockLog.timeline.slice(-2)).toEqual(['startChains', 'empty'])
    expect(wasteTop()).toBe('empty')
  })

  it('leaves the finished waste up when no chain can start, instead of blanking it with nothing to show', async () => {
    await mount(ONE_CARD_FROM_WON())
    mockViewMeasurable = false // the waste slot cannot be measured, so there is no origin to launch from

    await tap(id('hearts', 6))
    await flush(FLIGHT_MS + HOLD_MS + 50)

    expect(banner()).toBeTruthy() // the win is celebrated all the same
    expect(fireworks()).toBeTruthy()
    expect(mockLog.cascades).toEqual([]) // but no cascade could start
    expect(wasteTop()).toBe(id('hearts', 6)) // so the pile stays as the finished board showed it
  })

  it('a last flight that takes longer than the usual beat still holds the celebration back until it has landed', async () => {
    await mount(ONE_CARD_FROM_WON())
    mockFlightMs = HOLD_MS * 3

    await tap(id('hearts', 6))
    await flush(HOLD_MS * 2) // well past the beat a win normally waits - and the card is still in the air
    expect(mockLog.inAir).toBe(1)
    expect(banner()).toBeNull()
    expect(fireworks()).toBeNull()
    expect(wasteTop()).toBe(id('hearts', 6))
    expect(mockLog.cascades).toEqual([])

    await flush(HOLD_MS * 2 - 100) // it lands (at 3 * HOLD_MS), and only then does the beat start
    expect(mockLog.inAir).toBe(0)
    expect(banner()).toBeNull()
    expect(fireworks()).toBeNull()

    await flush(200)
    expect(banner()).toBeTruthy()
    expect(fireworks()).toBeTruthy()
    expect(mockLog.cascades).toEqual([0])
  })

  it('is not withheld by a flight that never lands', async () => {
    await mount(ONE_CARD_FROM_WON())
    jest.spyOn(mockGhost, 'show').mockImplementation(() => ({ hide: () => {}, flyTo: () => {} }) as never) // its flight never calls back

    await tap(id('hearts', 6))
    await flush(3000)

    expect(banner()).toBeTruthy()
    expect(fireworks()).toBeTruthy()
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
  })

  it('a move that does not win never celebrates, and its card still flies to the pile', async () => {
    await mount(TWO_CARDS_LEFT())

    await tap(id('hearts', 6))
    await flush(FLIGHT_MS + HOLD_MS + 200)

    expect(wasteTop()).toBe(id('hearts', 6))
    expect(banner()).toBeNull()
    expect(fireworks()).toBeNull()
    expect(mockRecordWon).not.toHaveBeenCalled()
    expect(mockLog.flown).toEqual([REGISTRY_POINT])
    expect(mockLog.hidden).toBe(0)
  })

  it('a New Game during the hold cancels the celebration', async () => {
    await mount(ONE_CARD_FROM_WON())

    await tap(id('hearts', 6))
    await flush(FLIGHT_MS + 100) // landed, still inside the hold
    expect(banner()).toBeNull()
    expect(fireworks()).toBeNull()

    await act(async () => {
      fireEvent.press(screen.getByTestId('new-game'))
    })
    await flush(3000)

    expect(banner()).toBeNull()
    expect(fireworks()).toBeNull()
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
  })

  it('undoing the winning move after the celebration flies the card back from the waste slot instead of dropping it into place', async () => {
    await mount(ONE_CARD_FROM_WON())
    await tap(id('hearts', 6))
    await flush(FLIGHT_MS + HOLD_MS + 50)
    expect(banner()).toBeTruthy()
    expect(fireworks()).toBeTruthy()
    expect(wasteTop()).toBe('empty') // the real waste card is gone (unregistered): only the waste SLOT can be measured
    mockLog.shown = []
    mockLog.flown = []

    await undo()
    await flush(10)

    expect(mockLog.shown).toEqual([{ id: id('hearts', 6), from: VIEW_POINT }]) // it took off from the waste slot
    expect(mockLog.flown).toEqual([REGISTRY_POINT]) // and flew to its restored slot
    expect(mockLog.hidden).toBe(0)
    expect(banner()).toBeNull()
    expect(fireworks()).toBeNull()
    expect(wasteTop()).toBe(id('spades', 5))

    await flush(FLIGHT_MS)
    expect(screen.getByTestId(`hidden-${id('hearts', 6)}`).props.children).toBe('shown')
  })

  it('winning again after an undo waits for the last flight all over again', async () => {
    await mount(ONE_CARD_FROM_WON())
    await tap(id('hearts', 6))
    await flush(FLIGHT_MS + HOLD_MS + 50)
    expect(banner()).toBeTruthy()
    expect(fireworks()).toBeTruthy()

    await undo()
    await flush(FLIGHT_MS + 50)
    expect(banner()).toBeNull()
    expect(fireworks()).toBeNull()

    mockLog.flown = []
    await tap(id('hearts', 6))
    await flush(10)
    expect(mockLog.flown).toEqual([REGISTRY_POINT])
    expect(wasteTop()).toBe(id('hearts', 6)) // not swept away the instant it is won again
    expect(banner()).toBeNull()
    expect(fireworks()).toBeNull()

    await flush(FLIGHT_MS + HOLD_MS + 50)
    expect(banner()).toBeTruthy()
    expect(fireworks()).toBeTruthy()
    expect(mockRecordWon).toHaveBeenCalledTimes(1) // recorded once for the deal
    // The win is only recorded (and its cascade only queued) once per deal, so this re-win starts no cascade: nothing takes over
    // from the finished waste, which must stay up under the banner rather than blank with nothing to show.
    expect(mockLog.cascades).toEqual([0]) // still only the first win's
    expect(wasteTop()).toBe(id('hearts', 6))
  })
})

describe('TriPeaks screen - a card never lands without its own flight', () => {
  it('a card that has no registry entry of its own still flies - to the waste slot - instead of being hidden and just appearing', async () => {
    await mount(TWO_CARDS_LEFT())
    // e.g. a second move landed on top of it in the same commit, so it is no longer the (registered) waste top.
    mockRegistryMisses.add(id('hearts', 6))

    await tap(id('hearts', 6))
    await flush(10)

    expect(mockLog.flown).toEqual([VIEW_POINT])
    expect(mockLog.hidden).toBe(0)
  })

  it('a card DRAWN from the stock that has no registry entry of its own still flies - to the waste slot - instead of being hidden and just appearing', async () => {
    await mount(ONE_IN_STOCK())
    // e.g. another draw landed on top of it in the same commit, so it is no longer the (registered) waste top.
    mockRegistryMisses.add(id('clubs', 9))

    await drawStock()
    await flush(10)

    expect(mockLog.shown).toEqual([{ id: id('clubs', 9), from: VIEW_POINT }]) // it took off from the stock
    expect(mockLog.flown).toEqual([VIEW_POINT]) // and flew to the waste slot, the one place that is always there to measure
    expect(mockLog.hidden).toBe(0)
    expect(mockLog.inAir).toBe(1)
    expect(wasteTop()).toBe(id('clubs', 9))

    await flush(FLIGHT_MS)
    expect(mockLog.inAir).toBe(0)
    expect(mockLog.hidden).toBe(0)
  })

  it('a card drawn from the stock flies to its own registered waste card when it has one', async () => {
    await mount(ONE_IN_STOCK())

    await drawStock()
    await flush(10)

    expect(mockLog.flown).toEqual([REGISTRY_POINT])
    expect(mockLog.hidden).toBe(0)
  })
})
