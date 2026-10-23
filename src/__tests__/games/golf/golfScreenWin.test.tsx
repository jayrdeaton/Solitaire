import { act, fireEvent, render, screen } from '@testing-library/react-native'

import { PileRef } from '@/engine/gameTypes'
import { Card, Suit } from '@/engine/types'
import GolfScreen from '@/games/golf/GolfScreen'
import { GolfState } from '@/games/golf/rules'

import { resetGameInProgress, seedGameInProgress } from '../../../testUtils/gameInProgressStore'

// ---------------------------------------------------------------------------------------------------------------------
// A screen-level test for Golf's win: the REAL GolfScreen, real rules, real useFlightConcurrency / useDerivedWinCheck /
// useWinReveal / useGameSession / gameInProgress store, seeded with a saved game through the test store (src/testUtils/gameInProgressStore.ts) (same
// approach as freeCellScreenAutoPlay.test.tsx). Only the parts that need native views, gestures or animation are replaced
// by stand-ins that honour the contract the screen relies on:
//   - the ghost's CardRegistry is modelled on what is actually RENDERED: a card can only be measured while a stand-in
//     (PileView column / StockWaste waste top) is showing it - which is the real failure the win used to hit, since hiding the
//     waste top on `won` unregistered the very card the winning flight was measuring to land on.
//   - a fake ghost whose flights "land" FLIGHT_MS later (the Reanimated mock's withSpring never calls its completion callback).
//   - measureView (plain-view measurement) answers with a DIFFERENT point than the registry, so a test can tell which of the
//     two a flight was aimed at.
// ---------------------------------------------------------------------------------------------------------------------

const FLIGHT_MS = 80
const HOLD_MS = 400 // useWinReveal's WIN_REVEAL_HOLD_MS
const REGISTRY_POINT = { x: 10, y: 10 }
const VIEW_POINT = { x: 5, y: 5 }

const mockRecordWon = jest.fn()
/** How long a fake flight takes to land. */
let mockFlightMs = FLIGHT_MS
/** Card ids a stand-in is showing right now - exactly what CardRegistry.measure can find. */
const mockRegistered = new Set<string>()
/** Ids the registry is forced to miss even though they are on screen. */
const mockRegistryMisses = new Set<string>()
const mockPiles = new Map<number, { cards: Card[]; hiddenCardIds: Set<string>; drag: { onDrop: (to: PileRef, count: number, anchorCardId: string, flight: unknown) => Promise<boolean> | boolean } }>()
let mockPileInstance = 0

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
  /** Every startChains() call's chains: each chain's card ids (head first) and its own per-card delay. */
  chains: [] as { ids: string[]; segmentDelayMs?: number }[][],
  /** What the waste showed (its top card's id, or 'empty') at the instant of each startChains() - the real pile must still be drawn then. */
  wasteAtCascade: [] as string[],
  /** The same at the instant the cascade's ghosts showed (its onShown) - the real pile must STILL be drawn then. */
  wasteAtGhostsShown: [] as string[],
  /** The waste's successive appearances (consecutive repeats collapsed) with a 'startChains' marker where the cascade started and a
   * 'ghosts-shown' one where its ghosts appeared: a pile that is blanked BEFORE that marker sat empty (or under blank-faced ghosts)
   * until the ghosts could be seen. */
  timeline: [] as string[]
}
/** The real cascade shows - and calls startChains' onShown - only once its parked ghosts' faces have painted, a frame or two after
 * startChains (WinCascadeLayer's CascadeChains); the mock stands in for that wait with a timer. */
const MOCK_GHOSTS_SHOW_MS = 16
let mockGhostsShowTimer: ReturnType<typeof setTimeout> | undefined
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
    startChains: (chains: { cards: { id: string }[]; segmentDelayMs?: number }[], _cardWidth: number, onShown?: () => void) => {
      mockLog.cascades.push(mockLog.inAir)
      mockLog.chains.push(chains.map((chain) => ({ ids: chain.cards.map((c) => c.id), segmentDelayMs: chain.segmentDelayMs })))
      mockLog.wasteAtCascade.push(mockWasteNow())
      mockLog.timeline.push('startChains')
      // Like the real controller: never for an empty cascade, and dropped by clear() or a newer startChains.
      clearTimeout(mockGhostsShowTimer)
      if (chains.length > 0 && onShown)
        mockGhostsShowTimer = setTimeout(() => {
          mockLog.wasteAtGhostsShown.push(mockWasteNow())
          mockLog.timeline.push('ghosts-shown')
          onShown()
        }, MOCK_GHOSTS_SHOW_MS)
    },
    clear: () => clearTimeout(mockGhostsShowTimer)
  })
}))
jest.mock('@/components/dealing/measureView', () => ({ measureView: async () => (mockViewMeasurable ? { x: 5, y: 5 } : null) }))
jest.mock('@/components/useCardSounds', () => ({ useCardSoundEffects: () => ({ playCardSound: () => {}, playInvalidSound: () => {}, hapticCard: () => {}, hapticInvalid: () => {} }) }))
jest.mock('@rific/feedback-press', () => ({ useVibration: () => ({ short: () => {}, selection: () => {} }) }))
jest.mock('@rific/toaster', () => ({ useToast: () => ({ info: () => {} }) }))
jest.mock('@/components/winning/PipFireworks', () => {
  const { View: MockView } = require('react-native')
  return { PipFireworks: () => <MockView testID='fireworks' /> }
})
jest.mock('@/games/shared/WinBanner', () => {
  const { Text: MockText } = require('react-native')
  return { WinBanner: () => <MockText testID='win-banner'>won</MockText> }
})
jest.mock('@/games/shared/LossBanner', () => {
  const { Pressable: MockPressable, View: MockView } = require('react-native')
  return {
    LossBanner: ({ onUndo }: { onUndo?: () => void }) => (
      <MockView testID='loss-banner'>
        <MockPressable testID='loss-undo' onPress={onUndo} />
      </MockView>
    )
  }
})
// The dead-board loss is off for now (constants/deadBoardLoss.ts); the dead-board cases turn it on to cover it as it works
// when it is back on, and one checks it stays out of the way while it is off.
const mockDeadBoardLoss = { on: false }
jest.mock('@/constants/deadBoardLoss', () => ({
  get DEAD_BOARD_LOSS() {
    return mockDeadBoardLoss.on
  }
}))
jest.mock('@/stores/gameStats', () => ({ useGameStats: () => ({ recordDealWon: mockRecordWon, recordDealAbandoned: () => {}, recordHintUsed: () => {} }) }))
jest.mock('@/stores/lastActiveGame', () => ({ useLastActiveGame: () => ({ setLastActiveGame: () => {}, clearLastActiveGame: () => {} }) }))
jest.mock('@/hooks/useSettings', () => {
  const actual = jest.requireActual('@/redux/settingsSlice')
  return { useSettings: () => ({ settings: { ...actual.DEFAULT_SETTINGS } }) }
})
jest.mock('@/components/theme', () => {
  const actual = jest.requireActual('@/components/theme')
  return { ...actual, useTableColors: () => actual.lightColors }
})
jest.mock('@/components/dragdrop/DropZone', () => ({ DropZone: ({ children }: { children: unknown }) => children }))
jest.mock('@/components/PileView', () => {
  const { Pressable: MockPressable, Text: MockText, View: MockView } = require('react-native')
  const { useEffect, useRef } = require('react')
  return {
    PileView: (props: { cards: Card[]; hiddenCardIds?: Set<string>; onPressCard: (card: Card, indexFromTop: number, measure: () => Promise<{ x: number; y: number }>) => void; drag: never }) => {
      const instance = useRef(mockPileInstance++).current
      mockPiles.set(instance, { cards: props.cards, hiddenCardIds: props.hiddenCardIds ?? new Set(), drag: props.drag })
      const key = props.cards.map((c) => c.id).join(',')
      useEffect(() => {
        const ids = key ? key.split(',') : []
        ids.forEach((cardId) => mockRegistered.add(cardId))
        return () => ids.forEach((cardId) => mockRegistered.delete(cardId))
      }, [key])
      useEffect(() => () => void mockPiles.delete(instance), [instance])
      return (
        <MockView>
          {props.cards.map((card, i) => (
            <MockPressable key={card.id} testID={`card-${card.id}`} onPress={() => props.onPressCard(card, props.cards.length - 1 - i, async () => ({ x: 10, y: 10 }))}>
              <MockText testID={`hidden-${card.id}`}>{props.hiddenCardIds?.has(card.id) ? 'hidden' : 'shown'}</MockText>
            </MockPressable>
          ))}
        </MockView>
      )
    }
  }
})
jest.mock('@/components/StockWaste', () => {
  const { Pressable: MockPressable, Text: MockText, View: MockView } = require('react-native')
  const { useEffect } = require('react')
  return {
    StockWaste: ({ stockTopCard, wasteTop, wasteHiddenCount, settledWasteTop, onDrawStock }: { stockTopCard?: { id: string }; wasteTop?: { id: string }; wasteHiddenCount?: number; settledWasteTop?: { id: string } | null; onDrawStock: () => void }) => {
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
          <MockText testID='stock-top'>{stockTopCard?.id ?? 'empty'}</MockText>
          <MockText testID='waste-hidden-count'>{String(wasteHiddenCount ?? 0)}</MockText>
          <MockText testID='waste-settled'>{settledWasteTop === undefined ? 'default' : (settledWasteTop?.id ?? 'empty')}</MockText>
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

/** Every card is gone from the tableau except the 6 of hearts, which goes onto the 5 of spades: tapping it wins the game. */
const ONE_CARD_FROM_WON = (): GolfState => ({ tableau: [[card('hearts', 6)], [], [], [], [], [], []], waste: [card('spades', 5)], stock: [] })
/** One card left in a face-down stock (the 9 of clubs), over the 5 of spades on the waste: drawing turns the 9 up onto the waste. */
const ONE_IN_STOCK = (): GolfState => ({ tableau: [[card('hearts', 6)], [], [], [], [], [], []], waste: [card('spades', 5)], stock: [card('clubs', 9, false)] })
/** Two cards left (the second, 5 of clubs, only goes onto the 6 - so the win is NOT one move away). */
const TWO_CARDS_LEFT = (): GolfState => ({ tableau: [[card('hearts', 6)], [card('clubs', 7)], [], [], [], [], []], waste: [card('spades', 5)], stock: [] })

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

async function mount(state: GolfState) {
  seedGameInProgress('golf', { state, undoStack: [], moves: 0, elapsedSeconds: 0, config: 0 })
  await render(<GolfScreen />)
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
  mockPiles.clear()
  mockPileInstance = 0
  mockRegistered.clear()
  mockRegistryMisses.clear()
  mockLog.shown = []
  mockLog.flown = []
  mockLog.hidden = 0
  mockLog.inAir = 0
  mockLog.cascades = []
  mockLog.chains = []
  mockLog.wasteAtCascade = []
  mockLog.wasteAtGhostsShown = []
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

// Each test starts with no saved games (the store helper is shared across the file).
afterEach(() => resetGameInProgress())

describe('Golf screen - the win celebration waits for the winning card to fly in and land', () => {
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

  it('hands the pile over to the cascade once its ghosts show: the real waste card is still drawn when the cascade starts and when its ghosts appear, and blanks only after that', async () => {
    await mount(ONE_CARD_FROM_WON())
    mockLog.timeline = []

    await tap(id('hearts', 6))
    await flush(FLIGHT_MS + HOLD_MS + 50)

    expect(mockLog.cascades).toEqual([0])
    // The cascade measured (and mounted its parked ghosts) while the pile still showed its card, and kept it up until the ghosts
    // were on screen (their faces paint a frame or two after they mount - blanking with startChains showed a blank-faced card)...
    expect(mockLog.wasteAtCascade).toEqual([id('hearts', 6)])
    expect(mockLog.wasteAtGhostsShown).toEqual([id('hearts', 6)])
    // ...and the pile never sat empty before that: blanking on the reveal alone left the waste slot empty for the few frames
    // runWinCascade takes to measure, then the ghosts appeared (a pile that teleported away).
    expect(mockLog.timeline.slice(0, mockLog.timeline.indexOf('ghosts-shown'))).not.toContain('empty')
    expect(mockLog.timeline.slice(-3)).toEqual(['startChains', 'ghosts-shown', 'empty'])
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

  it('a DRAGGED winning card is held to the same rule', async () => {
    await mount(ONE_CARD_FROM_WON())
    const pile = [...mockPiles.values()].find((p) => p.cards.some((c) => c.id === id('hearts', 6)))!

    await act(async () => {
      // The drag's own pick-up ghost comes from PileView, not from the screen - it is not counted in mockLog.shown.
      await pile.drag.onDrop({ zone: 'waste', index: 0 }, 1, id('hearts', 6), mockMakeFlight())
    })
    await flush(10)

    expect(mockRecordWon).toHaveBeenCalledTimes(1)
    expect(mockLog.flown).toEqual([REGISTRY_POINT])
    expect(mockLog.hidden).toBe(0)
    expect(wasteTop()).toBe(id('hearts', 6))
    expect(banner()).toBeNull()
    expect(fireworks()).toBeNull()

    await flush(FLIGHT_MS + HOLD_MS + 50)
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
    expect(mockLog.flown).toEqual([REGISTRY_POINT]) // and flew to its restored column card
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

describe('Golf screen - a card never lands without its own flight', () => {
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

  it("paints an empty waste under the starter card while it is dealt, not the starter itself (or the last game's top card)", async () => {
    resetGameInProgress() // nothing saved: a fresh deal
    await render(<GolfScreen />)
    await flush(FLIGHT_MS / 2) // dealt, nothing landed yet

    expect(screen.getByTestId('waste-hidden-count').props.children).toBe('1')
    expect(screen.getByTestId('waste-settled').props.children).toBe('empty')

    await flush(FLIGHT_MS * 4)
    expect(screen.getByTestId('waste-hidden-count').props.children).toBe('0')
    expect(screen.getByTestId('waste-settled').props.children).toBe('default')
  })

  it('a card of the initial deal whose destination cannot be measured is not left invisible for the rest of the hand', async () => {
    resetGameInProgress() // nothing saved: a fresh deal
    // The deal measures every dealt card's destination the moment it commits - miss the first one asked about.
    let missed: string | null = null
    jest.spyOn(mockGhost.cardRegistry, 'measure').mockImplementation(async (cardId: string) => {
      if (missed === null) missed = cardId
      return cardId === missed ? null : mockRegistryPoint()
    })
    await render(<GolfScreen />)
    await flush(FLIGHT_MS * 4)

    expect(missed).not.toBeNull()
    const all = screen.queryAllByTestId(/^hidden-/)
    expect(all.length).toBeGreaterThan(0)
    // Every dealt card is shown once the deal has landed - including the one that never got a flight.
    expect(all.filter((node) => node.props.children === 'hidden')).toEqual([])
  })
})

describe('Golf screen - a dead board', () => {
  afterEach(() => {
    mockDeadBoardLoss.on = false
  })

  it('shows no loss banner while the dead-board loss is off: the board just sits there, Undo still on the footer', async () => {
    await mount(ONE_IN_STOCK())
    await drawStock()
    await flush(FLIGHT_MS + HOLD_MS + 50)
    expect(screen.queryByTestId('loss-banner')).toBeNull()
  })

  it('ends with the loss banner once the stock is spent and nothing plays, after the last card lands - and its Undo takes the draw back', async () => {
    mockDeadBoardLoss.on = true
    await mount(ONE_IN_STOCK())
    expect(screen.queryByTestId('loss-banner')).toBeNull()

    await drawStock() // the 9 of clubs: the 6 of hearts can't go on it, and the stock is now empty
    await flush(10)
    expect(screen.queryByTestId('loss-banner')).toBeNull() // not while the drawn card is still in the air

    await flush(FLIGHT_MS + HOLD_MS + 50)
    expect(screen.queryByTestId('loss-banner')).toBeTruthy()

    await act(async () => {
      fireEvent.press(screen.getByTestId('loss-undo'))
    })
    await flush(FLIGHT_MS * 2)
    expect(screen.queryByTestId('loss-banner')).toBeNull()
    expect(wasteTop()).toBe(id('spades', 5))
  })
})

describe('Golf screen - a win with cards still in the stock', () => {
  /** Tapping the 6 of hearts onto the 5 of spades wins with two cards still in the stock: the 9 of clubs on top of the 2 of diamonds. */
  const WON_WITH_STOCK_LEFT = (): GolfState => ({ tableau: [[card('hearts', 6)], [], [], [], [], [], []], waste: [card('spades', 5)], stock: [card('diamonds', 2, false), card('clubs', 9, false)] })

  type Entry = { cardId: string; card: Card; from: { x: number; y: number }; to: { x: number; y: number }; delayMs: number }
  let deals: { ids: string[]; faceUp: boolean[]; from: { x: number; y: number }[]; to: { x: number; y: number }[] }[]
  let dealStartedAt: number

  /** A deal that keeps its own schedule, like the real one: each card takes off at its delayMs (onCardDealt) and lands FLIGHT_MS
   * later, and a newer start() (an empty one included) silences the one before. The file's own stand-in lands every card at once. */
  beforeEach(() => {
    deals = []
    let timers: ReturnType<typeof setTimeout>[] = []
    jest.spyOn(mockDeal, 'start').mockImplementation(((entries: Entry[], _w: number, onLanded: (id: string) => void, onDone?: () => void, onDealt?: (id: string) => void) => {
      timers.forEach(clearTimeout)
      timers = []
      deals.push({ ids: entries.map((e) => e.cardId), faceUp: entries.map((e) => e.card.faceUp), from: entries.map((e) => e.from), to: entries.map((e) => e.to) })
      dealStartedAt = Date.now()
      if (entries.length === 0) return onDone?.()
      for (const e of entries) {
        timers.push(setTimeout(() => onDealt?.(e.cardId), e.delayMs))
        timers.push(setTimeout(() => onLanded(e.cardId), e.delayMs + FLIGHT_MS))
      }
      timers.push(setTimeout(() => onDone?.(), Math.max(...entries.map((e) => e.delayMs)) + FLIGHT_MS))
    }) as never)
  })

  /** Advances fake time to `ms` after the sweep's deal started. */
  const sinceSweep = (ms: number) => flush(Math.max(0, dealStartedAt + ms - Date.now()))
  const stockTop = () => screen.getByTestId('stock-top').props.children as string

  it('deals the leftover stock onto the waste once the winning card has landed, and celebrates with every card in one pile', async () => {
    await mount(WON_WITH_STOCK_LEFT())
    await tap(id('hearts', 6))
    await flush(FLIGHT_MS / 2)
    expect(deals).toEqual([]) // the winning card is still in the air
    expect(stockTop()).toBe(id('clubs', 9))

    await flush(FLIGHT_MS)
    // Landed: the stock is dealt from the stock slot onto the waste slot, top card first, each face up.
    expect(deals).toEqual([{ ids: [id('clubs', 9), id('diamonds', 2)], faceUp: [true, true], from: [VIEW_POINT, VIEW_POINT], to: [VIEW_POINT, VIEW_POINT] }])

    await sinceSweep(30) // the 9 is flying, the 2 still waits in the stock
    expect(stockTop()).toBe(id('clubs', 9))
    expect(wasteTop()).toBe(id('hearts', 6))
    await sinceSweep(60) // the 2 has taken off too (dealStaggerMs(2) = 35ms after the 9): the stock is empty
    expect(stockTop()).toBe('empty')
    expect(wasteTop()).toBe(id('hearts', 6))
    await sinceSweep(90) // each lands on the waste in turn
    expect(wasteTop()).toBe(id('clubs', 9))
    await sinceSweep(125)
    expect(wasteTop()).toBe(id('diamonds', 2))
    expect(banner()).toBeNull() // the finished pile reads for a beat first
    expect(mockLog.chains).toEqual([])

    await sinceSweep(125 + HOLD_MS + 50)
    expect(banner()).toBeTruthy()
    // One chain carries all of it (a short pile: under 13 cards), the last card dealt leading.
    expect(mockLog.chains).toEqual([[{ ids: [id('diamonds', 2), id('clubs', 9), id('hearts', 6), id('spades', 5)] }]])
    expect(mockLog.wasteAtCascade).toEqual([id('diamonds', 2)])
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
  })

  it('an undo while the stock is being dealt takes the deal out of the air and puts the cards back in the stock', async () => {
    await mount(WON_WITH_STOCK_LEFT())
    await tap(id('hearts', 6))
    await flush(FLIGHT_MS + FLIGHT_MS / 2)
    await sinceSweep(90)
    expect(wasteTop()).toBe(id('clubs', 9))

    await undo()
    await flush(FLIGHT_MS * 3)
    expect(deals[deals.length - 1].ids).toEqual([]) // the sweep's ghosts are gone
    expect(stockTop()).toBe(id('clubs', 9))
    expect(wasteTop()).toBe(id('spades', 5))
    expect(banner()).toBeNull()
  })

  it('a New Game while the stock is being dealt stops it: nothing celebrates', async () => {
    await mount(WON_WITH_STOCK_LEFT())
    await tap(id('hearts', 6))
    await flush(FLIGHT_MS + FLIGHT_MS / 2)
    await sinceSweep(30)

    await act(async () => {
      fireEvent.press(screen.getByTestId('new-game'))
    })
    await flush(3000)
    expect(banner()).toBeNull()
    expect(mockLog.chains).toEqual([])
  })
})
