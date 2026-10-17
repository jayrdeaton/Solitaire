import { act, fireEvent, render, screen, within } from '@testing-library/react-native'
import { StrictMode } from 'react'

import { FLIGHT_SPRING, springSettleMs } from '@/components/dragdrop/dragSpring'
import { CHAIN_SEGMENT_DELAY_MS } from '@/components/winning/winCascadeMotion'
import { Card } from '@/engine/types'
import { SpiderState } from '@/games/spider/rules'
import SpiderScreen from '@/games/spider/SpiderScreen'

import { resetGameInProgress, seedGameInProgress } from '../../../testUtils/gameInProgressStore'
import { peelableFlights } from '../../../testUtils/peelableFlights'

// ---------------------------------------------------------------------------------------------------------------------
// A screen-level test for Spider's WIN: the REAL SpiderScreen, real rules, real useFlightConcurrency / useDerivedWinCheck /
// useWinReveal / useGameSession / gameInProgress store (seeded through the test store (src/testUtils/gameInProgressStore.ts)) and the real
// SequenceFlightGhosts (the sweep of a completed run to its foundation slot). Only what needs native views, gestures or
// animation is replaced, by a stand-in honoring the contract the screen relies on - see freeCellScreenAutoPlay.test.tsx,
// whose harness this follows. Unlike that one, the card registry is faithful: measure(id) answers only for a card some pile
// stand-in currently renders, exactly like the real CardRegistry, because "the winning card could not be measured, so its
// ghost was hidden" is precisely the teleport this file pins.
// ---------------------------------------------------------------------------------------------------------------------

const FLIGHT_MS = 80
const HOLD_MS = 400 // useWinReveal's WIN_REVEAL_HOLD_MS

const mockRecordWon = jest.fn()
const mockMeasureView = jest.fn(async (): Promise<{ x: number; y: number } | null> => ({ x: 5, y: 5 }))
const mockRegistered = new Map<string, unknown>()
/** While set, every card-registry measurement made from now on hangs until it resolves - a stock deal's own measurements
 * are what the New Game tests below need to interleave with. Measurements already awaiting keep the gate they started with. */
let mockMeasureGate: Promise<void> | null = null
/** With the gate up: the stock packets' measurements (a draw's flight origin) still answer, so only card measurements wait. */
let mockGatePassesPackets = false
const mockPiles = new Map<number, { cards: Card[]; press: (card: Card, indexFromTop: number) => void; drag?: { onDrop: (to: { zone: 'tableau'; index: number }, count: number, anchorCardId: string, flight: ReturnType<typeof mockMakeFlight>) => Promise<boolean> | boolean } }>()
let mockPileInstance = 0

interface MockLog {
  /** Every ghost.show() - one per tap/drop/undo card flight the screen started. */
  shown: string[]
  /** flyTo() calls still waiting to land. */
  inAir: number
  /** flight.hide() calls - a ghost dropped without ever flying to a destination. */
  hidden: number
  /** How many chains the win cascade was started with (-1: it never started). */
  cascadeChains: number
  /** How many cards those chains hold between them - every run in a slot, so 104 for a finished deal that lost none. */
  cascadeCards: number
  /** How many stock deals reached the deal animator. */
  deals: number
  /** How many Kings the completed-run slots were still drawing the moment the win cascade started (-1: it never did). */
  slotKingsAtCascade: number
  /** The same, the moment the cascade's ghosts showed (its onShown; -1: they never did). */
  slotKingsAtGhostsShown: number
}
/** How many completed-run slots are drawing a King right now - read from inside the mocked cascade, hence hoisted-mock naming. */
const mockSlotKingsNow = () => screen.queryAllByTestId(/^pc-spades-13-/).length
const mockLog: MockLog = { shown: [], inAir: 0, hidden: 0, cascadeChains: -1, cascadeCards: 0, deals: 0, slotKingsAtCascade: -1, slotKingsAtGhostsShown: -1 }
/** The real cascade shows - and calls startChains' onShown - only once its parked ghosts' faces have painted, a frame or two after
 * startChains (WinCascadeLayer's CascadeChains); the mock stands in for that wait with a timer. */
const MOCK_GHOSTS_SHOW_MS = 16
let mockGhostsShowTimer: ReturnType<typeof setTimeout> | undefined

function mockMakeFlight() {
  let landing: { timer: ReturnType<typeof setTimeout>; onDone?: () => void } | null = null
  return {
    // Like the real handle's hide(): a flight still in the air goes at once, and its landing callback runs right there
    // (DragGhostLayer's flushPendingSettle) instead of when it would have landed.
    hide: () => {
      mockLog.hidden += 1
      if (!landing) return
      const { timer, onDone } = landing
      landing = null
      clearTimeout(timer)
      mockLog.inAir -= 1
      onDone?.()
    },
    flyTo: (_x: number, _y: number, onDone?: () => void) => {
      mockLog.inAir += 1
      const timer = setTimeout(() => {
        landing = null
        mockLog.inAir -= 1
        onDone?.()
      }, FLIGHT_MS)
      landing = { timer, onDone }
    }
  }
}
/** An undo turning cards back mid-air (ghost.peel): the cards each flight still carries, and every peel. */
const mockPeel = peelableFlights(() => mockMakeFlight())
const mockGhost = {
  cardRegistry: {
    register: (id: string, ref: unknown) => void mockRegistered.set(id, ref),
    unregister: (id: string, ref: unknown) => {
      if (mockRegistered.get(id) === ref) mockRegistered.delete(id)
    },
    measure: async (id: string) => {
      const gate = mockMeasureGate
      if (gate && !(mockGatePassesPackets && id.startsWith('stock-packet'))) await gate
      return mockRegistered.has(id) ? { x: 10, y: 10, width: 50, height: 70 } : null
    }
  },
  show: (spec: { cards: { id: string }[] }) => {
    mockLog.shown.push(spec.cards.map((c) => c.id).join('+'))
    return mockPeel.track(
      spec.cards.map((c) => c.id),
      mockMakeFlight()
    )
  },
  canPeel: mockPeel.canPeel,
  peel: mockPeel.peel
}
/** While set, a deal started from now on stays in the air until it resolves - see holdDeals. */
let mockDealGate: Promise<void> | null = null
const mockDeal = {
  start: (entries: { cardId: string }[], _w: number, onLanded: (id: string) => void, onDone?: () => void) => {
    mockLog.deals += 1
    const gate = mockDealGate
    setTimeout(async () => {
      if (gate) await gate
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
    startChains: (chains: { cards: unknown[] }[], _cardWidth: number, onShown?: () => void) => {
      mockLog.cascadeChains = chains.length
      mockLog.cascadeCards = chains.reduce((total, chain) => total + chain.cards.length, 0)
      mockLog.slotKingsAtCascade = mockSlotKingsNow()
      // Like the real controller: never for an empty cascade, and dropped by clear() or a newer startChains.
      clearTimeout(mockGhostsShowTimer)
      if (chains.length > 0 && onShown)
        mockGhostsShowTimer = setTimeout(() => {
          mockLog.slotKingsAtGhostsShown = mockSlotKingsNow()
          onShown()
        }, MOCK_GHOSTS_SHOW_MS)
    },
    clear: () => clearTimeout(mockGhostsShowTimer)
  })
}))
jest.mock('@/components/dealing/measureView', () => ({ measureView: () => mockMeasureView() }))
jest.mock('@/components/useCardSounds', () => ({ useCardSoundEffects: () => ({ playCardSound: () => {}, playInvalidSound: () => {}, hapticCard: () => {}, hapticInvalid: () => {} }) }))
jest.mock('@rific/feedback-press', () => {
  const { Pressable: MockPressable } = require('react-native')
  return { Pressable: MockPressable, useVibration: () => ({ short: () => {}, selection: () => {} }) }
})
jest.mock('@rific/toaster', () => ({ useToast: () => ({ info: () => {} }) }))
jest.mock('@/components/winning/PipFireworks', () => {
  const { View: MockView } = require('react-native')
  return { PipFireworks: () => <MockView testID='fireworks' /> }
})
jest.mock('@/games/shared/WinBanner', () => {
  const { Text: MockText } = require('react-native')
  return { WinBanner: () => <MockText testID='win-banner'>won</MockText> }
})
jest.mock('@/stores/gameStats', () => ({ useGameStats: () => ({ recordDealWon: mockRecordWon, recordDealAbandoned: () => {}, recordHintUsed: () => {} }) }))
jest.mock('@/stores/lastActiveGame', () => ({ useLastActiveGame: () => ({ setLastActiveGame: () => {}, clearLastActiveGame: () => {} }) }))
jest.mock('@/hooks/useSettings', () => {
  const actual = jest.requireActual('@/redux/settingsSlice')
  return { useSettings: () => ({ settings: { ...actual.DEFAULT_SETTINGS, spiderSuits: 1 } }) }
})
jest.mock('@/components/theme', () => {
  const actual = jest.requireActual('@/components/theme')
  return { ...actual, useTableColors: () => actual.lightColors }
})
// One id-tagged view per card drawn anywhere outside the tableau piles: a completed slot's King, a stock packet, or a card of a
// sweep flight's ghost - so "the last run is still in the air" reads as its Ace (which no slot ever shows) being on screen.
jest.mock('@/components/PlayingCard', () => {
  const { View: MockView } = require('react-native')
  const { useEffect: useMockEffect } = require('react')
  // A face reports its bitmap painted once mounted, as a loaded Image does - a run's ghosts are invisible until then (see
  // cardFacePaint.ts's useGhostPaintGate).
  function MockPlayingCard({ card, onFacePainted }: { card: { id: string }; onFacePainted?: () => void }) {
    useMockEffect(() => onFacePainted?.(), [onFacePainted])
    return <MockView testID={`pc-${card.id}`} />
  }
  return { PlayingCard: MockPlayingCard, EmptySlot: () => <MockView /> }
})
jest.mock('@/components/PileView', () => {
  const { Pressable: MockPressable, View: MockView } = require('react-native')
  const { useEffect, useRef } = require('react')
  return {
    PileView: (props: { cards: Card[]; drag?: NonNullable<ReturnType<typeof mockPiles.get>>['drag']; onPressCard: (card: Card, indexFromTop: number, measure: () => Promise<{ x: number; y: number }>) => void }) => {
      const id = useRef(mockPileInstance++).current
      const view = useRef({}).current
      mockPiles.set(id, { cards: props.cards, drag: props.drag, press: (card, indexFromTop) => props.onPressCard(card, indexFromTop, async () => ({ x: 10, y: 10 })) })
      // Like PileView's own per-card registration: every rendered card is measurable, nothing else is.
      useEffect(() => {
        props.cards.forEach((c) => mockGhost.cardRegistry.register(c.id, view))
        return () => props.cards.forEach((c) => mockGhost.cardRegistry.unregister(c.id, view))
      })
      useEffect(() => () => void mockPiles.delete(id), [id])
      return (
        <MockView testID={`pile-${id % 10}`}>
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

const card = (rank: number, deck: number): Card => ({ id: `spades-${rank}-${deck}`, suit: 'spades', rank, faceUp: true }) as Card
const id = (rank: number, deck: number) => `spades-${rank}-${deck}`
/** `high` down to `low`, all spades, all face up. */
const run = (high: number, low: number, deck: number): Card[] => {
  const cards: Card[] = []
  for (let r = high; r >= low; r--) cards.push(card(r, deck))
  return cards
}
const FINAL_DECK = 7

/** Seven runs already in their slots, plus the last one nearly built: King..2 in one column, the Ace alone in another.
 * Moving the Ace onto the 2 completes the eighth run - the winning move. */
function oneMoveFromWon(): SpiderState {
  const completedRuns = Array.from({ length: 7 }, (_, deck) => run(13, 1, deck))
  const tableau: Card[][] = Array.from({ length: 10 }, () => [])
  tableau[0] = run(13, 2, FINAL_DECK)
  tableau[1] = [card(1, FINAL_DECK)]
  return { tableau, stock: [], completed: completedRuns.map((r) => r[0]), completedRuns }
}

/** The first of the eight runs is one move from done, with every column occupied and a whole deal left in the stock: the Ace
 * (deck 0) moves onto the 2, completing King..Ace on a 6 that stays behind. Column 1 keeps a card under the Ace, so a stock deal
 * stays legal while the run is still assembled - exactly what the sweep must hold off. The stock's 5s are decks 10-19, clear of
 * the run's own 5 (deck 0): a deck-0 5 in the stock was a second copy of a card already on the board, and dealing it put two
 * `spades-5-0` cards in one column (two children with one React key, and a registry that answered for either). */
function firstRunOneMoveAway(): SpiderState {
  const tableau: Card[][] = Array.from({ length: 10 }, () => [])
  tableau[0] = [card(6, 8), ...run(13, 2, 0)]
  tableau[1] = [card(9, 1), card(1, 0)]
  for (let col = 2; col < 10; col++) tableau[col] = [card(9, col)]
  const stock = Array.from({ length: 10 }, (_, d) => ({ ...card(5, 10 + d), faceUp: false }))
  return { tableau, stock, completed: [], completedRuns: [] }
}

/** The same board one step earlier: it is the stock deal itself that completes the run - the Ace (top of the stock) lands on
 * column 0's 2 - so the deal flight, not a tap's ghost, precedes the sweep. Every column holds a card, so the deal is legal. */
function dealCompletesFirstRun(): SpiderState {
  const state = firstRunOneMoveAway()
  const [ace] = state.tableau[1].splice(1, 1)
  state.stock = [{ ...ace, faceUp: false }, ...state.stock.slice(1)]
  return state
}

/** The first board again, but with two deals left in the stock and nothing that a deal could complete. */
function twoDealsLeft(): SpiderState {
  const state = firstRunOneMoveAway()
  state.stock = Array.from({ length: 20 }, (_, d) => ({ ...card(5, 20 + d), faceUp: false })) // decks 20+: clear of the run's own 5 (deck 0) and of firstRunOneMoveAway's stock (decks 10-19)
  return state
}

// ------------------------------------------------------------------------------------------------ harness

const STEP_MS = 10

/** Advances fake time by `ms`, in small steps each inside its OWN act(): the landing -> render -> effect -> next step chains
 * need React to process each step's timers before the next fires (see the FreeCell harness). */
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

async function mount(state: SpiderState) {
  seedGameInProgress('spider', { state, undoStack: [], moves: 5, elapsedSeconds: 30, config: 1 })
  await render(<SpiderScreen />)
  await flush() // loadGameInProgress -> restoreGame
  expect(screen.queryAllByTestId(/^card-/).length).toBe(state.tableau.flat().length)
}

async function tap(cardId: string) {
  await act(async () => {
    fireEvent.press(screen.getByTestId(`card-${cardId}`))
  })
}

/** A tap on the stock pile that reaches the screen without going through fireEvent, so two of them fit in a single act: the
 * pile's Pressable turns a click on its own host view (the one carrying onClick) into onPress, exactly as a real tap does. */
function stockPress(): () => void {
  let node = screen.getAllByTestId('pc-stock-packet')[0].parent
  while (node && !node.props.onClick) node = node.parent
  const click = node!.props.onClick
  return () => click({ currentTarget: 'stock', target: 'stock', nativeEvent: {}, stopPropagation: () => {} })
}

/** A tap that reaches the screen without going through fireEvent (see the one test that needs two taps in a single act). */
function pressDirect(cardId: string) {
  const pile = [...mockPiles.values()].find((p) => p.cards.some((c) => c.id === cardId))!
  const index = pile.cards.findIndex((c) => c.id === cardId)
  pile.press(pile.cards[index], pile.cards.length - 1 - index)
}

async function tapStock() {
  await act(async () => {
    fireEvent.press(screen.getAllByTestId('pc-stock-packet')[0])
  })
}

/** Makes the NEXT measureView call (the sweep's own read of its foundation slot) hang until `resolve` is called. */
function holdNextSlotMeasurement() {
  const held: { resolve: () => void } = { resolve: () => {} }
  mockMeasureView.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        held.resolve = () => resolve({ x: 5, y: 5 })
      })
  )
  return held
}

/** Makes EVERY later measureView call (the win cascade's read of each slot) hang until `resolve` is called. */
function holdAllSlotMeasurements() {
  const held: { resolve: () => void } = { resolve: () => {} }
  const gate = new Promise<void>((resolve) => {
    held.resolve = resolve
  })
  mockMeasureView.mockImplementation(async () => {
    await gate
    return { x: 5, y: 5 }
  })
  return held
}

/** Opens a gate on the card registry (see mockMeasureGate); returns the function that lets everything waiting on it through. */
function gateRegistry(packetsPass = false) {
  mockGatePassesPackets = packetsPass
  let open: () => void = () => {}
  mockMeasureGate = new Promise<void>((resolve) => {
    open = resolve
  })
  return open
}

/** Keeps every deal started from now on in the air (its flight claim held) until the returned function lands it. */
function holdDeals() {
  let land: () => void = () => {}
  mockDealGate = new Promise<void>((resolve) => {
    land = resolve
  })
  return async () => {
    mockDealGate = null
    land()
    await flush(10)
  }
}

const stockPackets = () => screen.queryAllByTestId('pc-stock-packet').length
const cardsOnBoard = () => screen.queryAllByTestId(/^card-/).length
/** The last run's Ace: shown nowhere but by that run's own sweep flight (a slot only ever shows its King). */
const finalRunFlying = () => !!screen.queryByTestId(`pc-${id(1, FINAL_DECK)}`)
/** The last run's King, in its slot (or, while flying, as a ghost). */
const finalKingShown = () => !!screen.queryByTestId(`pc-${id(13, FINAL_DECK)}`)
const kingShownInSlot = (deck: number) => !!screen.queryByTestId(`pc-${id(13, deck)}`)

beforeEach(() => {
  jest.useFakeTimers()
  mockPeel.reset()
  mockPiles.clear()
  mockPileInstance = 0
  mockRegistered.clear()
  mockLog.shown = []
  mockLog.inAir = 0
  mockLog.hidden = 0
  mockLog.cascadeChains = -1
  mockLog.cascadeCards = 0
  mockLog.deals = 0
  mockLog.slotKingsAtCascade = -1
  mockLog.slotKingsAtGhostsShown = -1
  mockMeasureGate = null
  mockGatePassesPackets = false
  mockDealGate = null
  mockRecordWon.mockClear()
  mockMeasureView.mockClear()
  mockMeasureView.mockImplementation(async () => ({ x: 5, y: 5 }))
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

describe('Spider screen - the winning move never makes a card teleport', () => {
  it('the winning card flies onto the run it completes, then the whole run flies to its slot - nothing is hidden or removed without a flight', async () => {
    await mount(oneMoveFromWon())

    await tap(id(1, FINAL_DECK))
    await flush(10) // the move has committed and its ghost is in the air

    expect(mockLog.shown).toEqual([id(1, FINAL_DECK)])
    expect(mockLog.inAir).toBe(1) // the Ace really flies (it used to have nothing to measure, and its ghost was hidden on the spot)...
    expect(mockLog.hidden).toBe(0)
    expect(cardsOnBoard()).toBe(13) // ...to the completed run, assembled in its column instead of already swept away
    expect(mockRecordWon).not.toHaveBeenCalled() // the deal is not over until that run has left for its slot
    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(screen.queryByTestId('fireworks')).toBeNull()

    await flush(FLIGHT_MS) // the Ace lands: the run peels off to its slot
    expect(mockLog.hidden).toBe(0)
    expect(cardsOnBoard()).toBe(0)
    expect(finalRunFlying()).toBe(true) // ...as 13 cards in flight, not a run that simply disappeared
    expect(mockRecordWon).toHaveBeenCalledTimes(1) // the win is recorded the instant the last run is swept...
    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(screen.queryByTestId('fireworks')).toBeNull() // ...with no celebration while it is still in the air
    expect(mockLog.cascadeChains).toBe(-1)
    expect(kingShownInSlot(0)).toBe(true) // and the earlier runs stay put in their slots

    // Halfway through the sweep: still flying, still nothing celebrating.
    await flush(300)
    expect(finalRunFlying()).toBe(true)
    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(screen.queryByTestId('fireworks')).toBeNull()
    expect(mockLog.cascadeChains).toBe(-1)

    // The sweep lands (13 cards, CHAIN_SEGMENT_DELAY_MS apart, plus the last one's flight): the finished board holds for a beat.
    await flush(12 * CHAIN_SEGMENT_DELAY_MS + springSettleMs(FLIGHT_SPRING) - 300 + 30)
    expect(finalRunFlying()).toBe(false)
    expect(finalKingShown()).toBe(true) // the last King now sits in its slot,
    expect(kingShownInSlot(0)).toBe(true) // beside the other seven
    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(screen.queryByTestId('fireworks')).toBeNull()
    expect(mockLog.cascadeChains).toBe(-1)

    await flush(HOLD_MS)
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(screen.getByTestId('fireworks')).toBeTruthy() // then the celebration takes over,
    expect(mockLog.cascadeChains).toBe(8) // bouncing all eight runs off their slots,
    expect(finalKingShown()).toBe(false) // which are blank from that moment on
    expect(kingShownInSlot(0)).toBe(false)
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
    expect(mockLog.hidden).toBe(0)
  })

  it('the recorded time is the moment of the winning move, not the moment its last run finished leaving', async () => {
    await mount(oneMoveFromWon()) // resumed at 30 seconds, clock running from now
    await flush(990) // 30s + 0.99s: the win is played just before a whole second ticks over...

    await tap(id(1, FINAL_DECK))
    await flush(FLIGHT_MS + 10) // ...and the last run is swept (and the win derived) after it

    expect(mockRecordWon).toHaveBeenCalledTimes(1)
    expect(mockRecordWon.mock.calls[0][1].seconds).toBe(30)
  })

  it('still wins when the last slot cannot be measured (the run is swept anyway, rather than left assembled in the tableau forever)', async () => {
    await mount(oneMoveFromWon())
    mockMeasureView.mockImplementation(async () => null)

    await tap(id(1, FINAL_DECK))
    await flush(FLIGHT_MS + 10)

    expect(mockRecordWon).toHaveBeenCalledTimes(1)
    expect(cardsOnBoard()).toBe(0)

    await flush(HOLD_MS + 50)
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(screen.getByTestId('fireworks')).toBeTruthy()
  })

  it("a sweep ghost stays up until its spring's real end - springSettleMs after it departs, not the bare duration that would retire it with the card still short of its slot", async () => {
    await mount(oneMoveFromWon())
    await tap(id(1, FINAL_DECK))
    await flush(10)
    await flush(FLIGHT_MS) // the Ace lands and the run peels off: King first, the Ace last, one CHAIN_SEGMENT_DELAY_MS apart
    expect(finalRunFlying()).toBe(true)

    const config = FLIGHT_SPRING // the one flight time, whatever the distance
    const aceDeparts = 12 * CHAIN_SEGMENT_DELAY_MS
    await flush(aceDeparts + (config.duration ?? 0) + 20) // the bare duration - the old timer - has run out for the Ace, the run's last card
    expect(finalRunFlying()).toBe(true)
    await flush(springSettleMs(config) - (config.duration ?? 0)) // and now the spring's real end has
    expect(finalRunFlying()).toBe(false)
  })

  it('a New Game started while the finished board is still holding cancels the celebration', async () => {
    await mount(oneMoveFromWon())

    await tap(id(1, FINAL_DECK))
    await flush(FLIGHT_MS + 10 + 700) // the last run has landed in its slot; the hold has begun but has not run out
    expect(finalKingShown()).toBe(true)
    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(screen.queryByTestId('fireworks')).toBeNull()

    await act(async () => {
      fireEvent.press(screen.getByTestId('new-game'))
    })
    await flush(3000)

    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(screen.queryByTestId('fireworks')).toBeNull()
    expect(mockLog.cascadeChains).toBe(-1)
    expect(cardsOnBoard()).toBe(54) // a fresh deal
  })

  it('a move that does not win never celebrates', async () => {
    const state = oneMoveFromWon()
    state.completed = state.completed.slice(0, 6)
    state.completedRuns = state.completedRuns.slice(0, 6)
    state.tableau[2] = run(13, 1, 6) // a seventh run, still sitting in the tableau - the game is far from won
    await mount(state)

    await tap(id(1, FINAL_DECK)) // Ace onto the 2 completes the SEVENTH run, not the last
    await flush(FLIGHT_MS + 10 + 3000)

    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(screen.queryByTestId('fireworks')).toBeNull()
    expect(mockLog.cascadeChains).toBe(-1)
    expect(mockLog.hidden).toBe(0)
  })
})

// A completed run first sits assembled in its column while the move (or dealt card) that completed it lands, and only then
// flies to its slot - so for that stretch the board still shows cards the sweep is about to remove.
describe('Spider screen - the other columns play on while a run waits to be swept', () => {
  /** Six runs in their slots; the seventh one move from done (King..2 in column 0, its Ace in column 1), and an unrelated 5
   * in column 3 that goes on the 6 in column 2. */
  function seventhRunAndASpareMove(): SpiderState {
    const completedRuns = Array.from({ length: 6 }, (_, deck) => run(13, 1, deck))
    const tableau: Card[][] = Array.from({ length: 10 }, () => [])
    tableau[0] = run(13, 2, 6)
    tableau[1] = [card(1, 6)]
    tableau[2] = [card(6, 7)]
    tableau[3] = [card(5, 7)]
    return { tableau, stock: [], completed: completedRuns.map((r) => r[0]), completedRuns }
  }

  it('a move in another column goes through while the run is still assembled, and undoing it later leaves the run in its slot', async () => {
    await mount(seventhRunAndASpareMove())
    const held = holdNextSlotMeasurement()

    await tap(id(1, 6)) // completes the seventh run in column 0
    await flush(FLIGHT_MS) // landed; the sweep is measuring (held open), the run still assembled
    expect(cardsOnBoard()).toBe(15)

    await tap(id(5, 7)) // a different column: not held
    expect(mockLog.shown).toEqual([id(1, 6), id(5, 7)])

    held.resolve()
    await flush(2500) // the sweep flight lands (undo waits for every flight)
    expect(cardsOnBoard()).toBe(2) // the run has left; the 5 sits on the 6
    expect(kingShownInSlot(6)).toBe(true)

    await act(async () => {
      fireEvent.press(screen.getByTestId('undo'))
    })
    await flush(FLIGHT_MS * 4)
    // Only the 5 goes back: the board the undo restores is the one with the run already swept, not the moment it was taken
    // (when the run still stood in column 0 - nothing would ever sweep it again).
    expect(mockLog.shown).toEqual([id(1, 6), id(5, 7), id(5, 7)]) // the undo really ran: the 5 flew back
    expect(cardsOnBoard()).toBe(2)
    expect(kingShownInSlot(6)).toBe(true)
  })
})

describe('Spider screen - nothing can move a run that is waiting to be swept', () => {
  it('a tap on the assembled winning run is ignored, before the winning card lands and while its sweep is measuring - the deal still ends won with all 104 cards', async () => {
    await mount(oneMoveFromWon())
    const held = holdNextSlotMeasurement()

    await tap(id(1, FINAL_DECK))
    await flush(10) // the Ace's ghost is in the air; King..Ace stands assembled in column 0
    expect(cardsOnBoard()).toBe(13)

    await tap(id(13, FINAL_DECK)) // the King: the whole run could go to any empty column (every other column is empty)
    expect(mockLog.shown).toEqual([id(1, FINAL_DECK)]) // ignored up front: no second ghost, no move
    expect(mockLog.hidden).toBe(0)

    await flush(FLIGHT_MS) // the Ace lands and the sweep starts - its slot measurement is held open
    expect(cardsOnBoard()).toBe(13)
    await tap(id(12, FINAL_DECK))
    expect(mockLog.shown).toEqual([id(1, FINAL_DECK)]) // still ignored: the run has not left its column yet
    expect(mockRecordWon).not.toHaveBeenCalled()

    held.resolve()
    await flush(10)
    expect(cardsOnBoard()).toBe(0) // swept whole, the one time
    expect(finalRunFlying()).toBe(true)
    expect(mockRecordWon).toHaveBeenCalledTimes(1)

    await flush(2500)
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(screen.getByTestId('fireworks')).toBeTruthy()
    expect(mockLog.cascadeChains).toBe(8)
    expect(mockLog.cascadeCards + cardsOnBoard()).toBe(104) // eight whole runs and nothing left behind: no card lost or duplicated
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
    expect(mockLog.shown).toEqual([id(1, FINAL_DECK)])
  })

  it('a drop of the assembled run onto an empty column is refused while it waits to be swept', async () => {
    await mount(oneMoveFromWon())

    await tap(id(1, FINAL_DECK))
    await flush(10)

    let accepted: boolean | undefined
    await act(async () => {
      accepted = await mockPiles.get(0)!.drag!.onDrop({ zone: 'tableau', index: 3 }, 13, id(13, FINAL_DECK), mockMakeFlight())
    })
    expect(accepted).toBe(false)
    expect(cardsOnBoard()).toBe(13) // still in column 0, where the sweep expects it

    await flush(2500)
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(mockLog.cascadeCards + cardsOnBoard()).toBe(104)
  })

  it('a tap that was already waiting on its own measurement when another move completed the run does not move it either', async () => {
    await mount(oneMoveFromWon())

    // Both taps pass their guards before either has measured anything; the Ace's move commits (and completes the run) first.
    // Straight into the pile's press handler rather than fireEvent: its own nested act() calls cannot overlap like these two taps do.
    await act(async () => {
      pressDirect(id(1, FINAL_DECK))
      pressDirect(id(13, FINAL_DECK))
    })
    await flush(10)
    expect(cardsOnBoard()).toBe(13) // King..Ace, whole, in column 0 - the second tap's move was refused

    await flush(2500)
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(mockLog.cascadeCards + cardsOnBoard()).toBe(104)
  })

  it('a stock deal is ignored while a completed run waits to be swept, and works again once it has left', async () => {
    await mount(firstRunOneMoveAway())
    expect(stockPackets()).toBe(1)

    await tap(id(1, 0)) // Ace onto the 2: the first run completes (not the last)
    await flush(10)
    expect(cardsOnBoard()).toBe(23) // King..Ace assembled in column 0, on the 6

    await tapStock() // legal on this board (no empty column) - it would land on top of the assembled run
    await flush(FLIGHT_MS + 10)
    expect(mockLog.deals).toBe(0)
    expect(stockPackets()).toBe(1)

    await flush(2500) // the run has flown to its slot
    expect(cardsOnBoard()).toBe(10) // 13 cards left the tableau, the six behind them stayed
    expect(kingShownInSlot(0)).toBe(true)

    await tapStock()
    await flush(FLIGHT_MS + 10)
    expect(mockLog.deals).toBe(1) // not blocked for good
    expect(stockPackets()).toBe(0)
  })

  it('undo waits out the gap between a completing stock deal landing and its sweep removing the run, then takes the deal back', async () => {
    await mount(dealCompletesFirstRun())
    const held = holdNextSlotMeasurement()
    expect(cardsOnBoard()).toBe(22)
    expect(stockPackets()).toBe(1)

    await tapStock()
    await flush(FLIGHT_MS + 10) // every dealt card has landed and settled its flight; the run's sweep is still measuring
    expect(mockLog.deals).toBe(1)
    expect(cardsOnBoard()).toBe(32) // King..Ace assembled in column 0 (14 with the 6), one card on each of the nine others' pairs

    await act(async () => {
      fireEvent.press(screen.getByTestId('undo'))
    })
    await flush(10)
    expect(cardsOnBoard()).toBe(32) // the deal was not undone under the sweep

    held.resolve()
    const counts = new Set<number>()
    for (let t = 0; t < 2500; t += STEP_MS) {
      await flush(STEP_MS)
      counts.add(cardsOnBoard())
    }
    expect(counts.has(19)).toBe(true) // the six in column 0 and the nine dealt pairs: the run went, exactly once...
    // ...and only then did the waiting undo go through: the run is back in column 0 and the ten dealt cards back in the stock
    expect(cardsOnBoard()).toBe(22)
    expect(kingShownInSlot(0)).toBe(false)
    expect(stockPackets()).toBe(1)
  })

  it('a completing stock deal whose cards never got a flight still sweeps the run, and does not leave the board locked', async () => {
    await mount(dealCompletesFirstRun())
    mockRegistered.delete('stock-packet-0') // the packet the deal would fly from cannot be measured: no origin, so no deal flight

    await tapStock()
    await flush(FLIGHT_MS + 2500)

    expect(cardsOnBoard()).toBe(19) // the run left anyway, instead of standing assembled in column 0 forever
    expect(kingShownInSlot(0)).toBe(true)

    await tap(id(5, 11)) // the 5 dealt on column 1 goes onto the 6 left in column 0: nothing is locked
    expect(mockLog.shown).toEqual([id(5, 11)])
  })
})

describe('Spider screen - a New Game while a run waits to be swept leaves a clean fresh game', () => {
  async function expectCleanFreshGame() {
    expect(cardsOnBoard()).toBe(54) // the whole fresh deal: nothing cut out of it by the old game's sweep
    expect(screen.queryAllByTestId(/^pc-spades-/).length).toBe(0) // no run in a slot, no sweep ghost in the air
    expect(mockRecordWon).not.toHaveBeenCalled()
    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(mockLog.cascadeChains).toBe(-1)
    expect(stockPackets()).toBe(5)

    await tapStock() // and nothing is left blocked by the old game's pending sweep
    await flush(FLIGHT_MS + 10)
    expect(mockLog.deals).toBe(2) // the fresh game's initial deal, then this one
    expect(stockPackets()).toBe(4)
  }

  it('while the completing move is still in the air', async () => {
    await mount(oneMoveFromWon())

    await tap(id(1, FINAL_DECK))
    await flush(10)
    expect(mockLog.inAir).toBe(1)
    await act(async () => {
      fireEvent.press(screen.getByTestId('new-game'))
    })
    expect(mockLog.inAir).toBe(0) // the old ghost goes with its game instead of landing on the fresh deal
    await flush(FLIGHT_MS + 3000)

    await expectCleanFreshGame()
  })

  it('while the sweep is still measuring its slot', async () => {
    await mount(oneMoveFromWon())
    const held = holdNextSlotMeasurement()

    await tap(id(1, FINAL_DECK))
    await flush(FLIGHT_MS + 10) // landed; the sweep is waiting on its measurement
    expect(cardsOnBoard()).toBe(13)

    await act(async () => {
      fireEvent.press(screen.getByTestId('new-game'))
    })
    await flush(3000)
    held.resolve() // the old game's measurement answers only now
    await flush(3000)

    await expectCleanFreshGame()
  })
})

// A run's flight to or from its slot lasts about a second (12 x CHAIN_SEGMENT_DELAY_MS, plus the flight) and New Game is never
// disabled meanwhile. The old game's ghosts used to keep flying over the fresh deal, and their landing then ran the old game's
// callbacks on the new one: a settleFlight() that took away a claim the fresh game held, and - for an undo's restore flight -
// finishMoveUndo, which committed the old game's board over the fresh deal.
/** The sweep (or a restore): every card leaves CHAIN_SEGMENT_DELAY_MS after the one before, then takes a whole flight. */
const RUN_FLIGHT_MS = 12 * CHAIN_SEGMENT_DELAY_MS + springSettleMs(FLIGHT_SPRING)

describe('Spider screen - a New Game while a run flies to or from its slot leaves a clean fresh game', () => {
  const runGhosts = () => screen.queryAllByTestId(/^pc-spades-/).length // no slot holds a King in these games: only ghosts

  it("while the run sweeps to its slot: its ghosts go at once, and their landing settles none of the fresh game's claims", async () => {
    await mount(firstRunOneMoveAway())
    await tap(id(1, 0))
    await flush(FLIGHT_MS + 10 + 100) // the Ace has landed and the completed run is on its way to slot 0
    expect(runGhosts()).toBe(13)

    await act(async () => {
      fireEvent.press(screen.getByTestId('new-game'))
    })
    expect(runGhosts()).toBe(0) // gone with the game they belonged to

    await flush(FLIGHT_MS + 10) // the fresh deal lands
    expect(cardsOnBoard()).toBe(54)
    const landDeal = holdDeals()
    await tapStock() // a draw in the fresh game: its claim holds undo off until its own deal has landed
    await flush(RUN_FLIGHT_MS) // ...past the moment the old run would have landed in its slot
    expect(runGhosts()).toBe(0)

    await act(async () => {
      fireEvent.press(screen.getByTestId('undo'))
    })
    await flush(10)
    expect(stockPackets()).toBe(4) // refused: the old run's landing did not settle the draw's claim out from under it

    await landDeal()
    await act(async () => {
      fireEvent.press(screen.getByTestId('undo'))
    })
    await flush(FLIGHT_MS + 10)
    expect(stockPackets()).toBe(5) // and undo works once the draw really has landed
  })

  it('while an undo flies the run back out of its slot: the old board never comes back over the fresh deal', async () => {
    await mount(firstRunOneMoveAway())
    await tap(id(1, 0))
    await flush(FLIGHT_MS + 10 + RUN_FLIGHT_MS + 50) // the run has gone to its slot
    expect(cardsOnBoard()).toBe(10)
    expect(kingShownInSlot(0)).toBe(true)

    await act(async () => {
      fireEvent.press(screen.getByTestId('undo'))
    })
    await flush(200) // the run is flying back to column 0
    expect(runGhosts()).toBe(13)

    await act(async () => {
      fireEvent.press(screen.getByTestId('new-game'))
    })
    expect(runGhosts()).toBe(0)
    await flush(3000) // long past the moment the old restore would have landed and sent the Ace home

    expect(cardsOnBoard()).toBe(54) // the whole fresh deal, not the old game's board
    expect(stockPackets()).toBe(5)
    expect(runGhosts()).toBe(0)
    expect(mockLog.shown).toEqual([id(1, 0)]) // the old undo never sent its Ace home: the tap's own ghost is the only one

    await tapStock() // and nothing of the old undo is left holding the fresh game
    await flush(FLIGHT_MS + 10)
    expect(stockPackets()).toBe(4)
  })

  it('restoring a saved game over one whose run is sweeping drops the run and its claim the same way', async () => {
    // restoreGame over a game in progress is the mount effect's second run under StrictMode - see the restore tests below.
    const saves = [firstRunOneMoveAway(), firstRunOneMoveAway()].map((state) => JSON.stringify({ state, undoStack: [], moves: 5, elapsedSeconds: 30, config: 1 }))
    const answers: (() => void)[] = []
    // Each load (StrictMode mounts twice) resolves only when the test says so, like a slow storage read.
    jest.spyOn(require('@/stores/gameInProgress'), 'loadGameInProgress').mockImplementation(() => new Promise((resolve) => answers.push(() => resolve(JSON.parse(saves[answers.length - 1])))))
    await render(
      <StrictMode>
        <SpiderScreen />
      </StrictMode>
    )
    await flush()
    await act(async () => answers[0]())
    await flush()

    await tap(id(1, 0))
    await flush(FLIGHT_MS + 10 + 100) // the first game's run is on its way to slot 0
    expect(runGhosts()).toBe(13)

    await act(async () => answers[1]())
    await flush()
    expect(runGhosts()).toBe(0)
    expect(cardsOnBoard()).toBe(23) // the restored board, whole

    const landDeal = holdDeals()
    await tapStock()
    await flush(RUN_FLIGHT_MS)
    await act(async () => {
      fireEvent.press(screen.getByTestId('undo'))
    })
    await flush(10)
    expect(stockPackets()).toBe(0) // refused while the restored game's own deal is in the air

    await landDeal()
    await act(async () => {
      fireEvent.press(screen.getByTestId('undo'))
    })
    await flush(FLIGHT_MS + 10)
    expect(stockPackets()).toBe(1)
  })
})

// A tap's, a drop's or an undo's own ghost (the shared drag-ghost layer) is a claim too, settled when it lands. One still in the
// air - or still measuring where it lands - when New Game is confirmed belonged to the game that is gone, but it used to carry on:
// its landing settled whatever claim the fresh game held by then (a draw's, so Undo was taken while that draw's deal was still in
// the air), and one still measuring went on to fly to wherever its card id - ids repeat from deal to deal - sat in the fresh deal.
describe("Spider screen - a New Game while a card's own ghost flies leaves none of it in the fresh game", () => {
  it("while an undo sends the run's top card home (its second phase): the ghost goes at once, and settles none of the fresh game's claims", async () => {
    await mount(firstRunOneMoveAway())
    await tap(id(1, 0))
    await flush(FLIGHT_MS + 10 + RUN_FLIGHT_MS + 50) // the run has gone to its slot
    expect(kingShownInSlot(0)).toBe(true)

    await act(async () => {
      fireEvent.press(screen.getByTestId('undo'))
    })
    await flush(RUN_FLIGHT_MS + 20) // the run is back in column 0, and the Ace is on its way home to column 1
    expect(mockLog.shown).toEqual([id(1, 0), id(1, 0)])
    expect(mockLog.inAir).toBe(1)

    const landDeal = holdDeals() // from here on the fresh game's deals stay in the air until landDeal
    await act(async () => {
      fireEvent.press(screen.getByTestId('new-game'))
    })
    expect(mockLog.inAir).toBe(0) // the Ace's ghost went with its game
    expect(mockLog.hidden).toBe(1)
    expect(cardsOnBoard()).toBe(54)

    await tapStock() // a draw in the fresh game: its claim holds Undo off until its own deal has landed
    expect(stockPackets()).toBe(4)
    await flush(200) // long past the moment the old ghost would have landed

    await act(async () => {
      fireEvent.press(screen.getByTestId('undo'))
    })
    await flush(10)
    expect(stockPackets()).toBe(4) // refused: the old ghost's landing did not settle the draw's claim out from under it

    await landDeal()
    await act(async () => {
      fireEvent.press(screen.getByTestId('undo'))
    })
    await flush(FLIGHT_MS + 10)
    expect(stockPackets()).toBe(5) // and Undo works once the draw really has landed
    expect(mockLog.shown).toEqual([id(1, 0), id(1, 0)])
  })

  it("while a tap's ghost is still measuring where it lands: it never sets off, and settles none of the fresh game's claims", async () => {
    const state = twoDealsLeft()
    state.tableau[2] = [card(9, 2), card(8, 40)] // the 8 goes onto a 9: a plain move, nothing completes
    await mount(state)
    const open = gateRegistry() // the tap's ghost measures its destination - and waits there

    await tap(id(8, 40))
    await flush(10)
    expect(mockLog.shown).toEqual([id(8, 40)])
    expect(mockLog.inAir).toBe(0) // shown over the card, not flying yet

    const landDeal = holdDeals()
    await act(async () => {
      fireEvent.press(screen.getByTestId('new-game'))
    })
    mockMeasureGate = null // the fresh game measures freely; only the old ghost's measurement is still waiting
    expect(mockLog.hidden).toBe(1) // the waiting ghost went with its game

    await tapStock()
    expect(stockPackets()).toBe(4)
    // Card ids repeat from deal to deal: let the old measurement find "its" card in the fresh deal, as it would whenever the
    // fresh deal has one with that id on the board.
    mockRegistered.set(id(8, 40), {})
    open()
    await flush(10)
    expect(mockLog.inAir).toBe(0) // the retired ghost never set off for it
    expect(mockLog.hidden).toBe(1)
    await flush(200) // long past the moment it would have landed there

    await act(async () => {
      fireEvent.press(screen.getByTestId('undo'))
    })
    await flush(10)
    expect(stockPackets()).toBe(4) // refused: the draw's claim is still its own

    mockRegistered.delete(id(8, 40))
    await landDeal()
    await act(async () => {
      fireEvent.press(screen.getByTestId('undo'))
    })
    await flush(FLIGHT_MS + 10)
    expect(stockPackets()).toBe(5)
    expect(mockLog.shown).toEqual([id(8, 40)])
  })
})

// The cascade's ghosts park at each slot, so the slot's own King must stay up until they are mounted. The reveal used to blank the
// slots at once and the cascade only started after measuring them (a later commit), leaving every slot empty in between.
describe('Spider screen - the win cascade takes the slots over once its ghosts show', () => {
  /** Plays the winning move and lets the last run land in its slot, stopping there with the celebration still to come. */
  async function winAndLandLastRun() {
    await tap(id(1, FINAL_DECK))
    await flush(FLIGHT_MS + 10) // the Ace has landed and the run's sweep is under way (its own slot measurement is already answered)
  }

  it('keeps every King in its slot while the cascade measures them and until its ghosts show, and blanks the slots in the commit right after', async () => {
    await mount(oneMoveFromWon())
    await winAndLandLastRun()
    const held = holdAllSlotMeasurements() // from here on, only the cascade measures slots

    await flush(2500) // the sweep lands, the finished board holds, and the win is revealed: the cascade is measuring
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(screen.getByTestId('fireworks')).toBeTruthy()
    expect(mockLog.cascadeChains).toBe(-1) // no ghost exists yet...
    expect(screen.queryAllByTestId(/^pc-spades-13-/)).toHaveLength(8) // ...so every slot still shows its King, not an empty frame

    held.resolve()
    await flush(10)
    expect(mockLog.cascadeChains).toBe(8)
    expect(mockLog.slotKingsAtCascade).toBe(8) // the cascade started while all eight were still drawn...
    // ...and they stay drawn while its ghosts are mounted but not on screen yet (their faces still painting: blanking them with
    // startChains showed eight blank-faced Kings for a frame or two)...
    expect(screen.queryAllByTestId(/^pc-spades-13-/)).toHaveLength(8)

    await flush(MOCK_GHOSTS_SHOW_MS)
    expect(mockLog.slotKingsAtGhostsShown).toBe(8) // ...up to the moment the ghosts show...
    expect(screen.queryAllByTestId(/^pc-spades-13-/)).toHaveLength(0) // ...and they are blank from the commit right after it on
    expect(mockLog.hidden).toBe(0)
  })

  it('blanks only the slots the cascade has a chain for: a slot that cannot be measured keeps its King', async () => {
    await mount(oneMoveFromWon())
    await winAndLandLastRun()
    let measured = 0
    mockMeasureView.mockImplementation(async () => (measured++ === 3 ? null : { x: 5, y: 5 })) // the cascade reads slots 0..7 in order: slot 3 fails

    await flush(2500)

    expect(mockLog.cascadeChains).toBe(7)
    expect(mockLog.slotKingsAtCascade).toBe(8)
    ;[0, 1, 2, 4, 5, 6, 7].forEach((deck) => expect(kingShownInSlot(deck)).toBe(false))
    expect(kingShownInSlot(3)).toBe(true) // no chain carries that run, so nothing else would show it
    expect(screen.getByTestId('win-banner')).toBeTruthy()
  })

  it('leaves every slot up when no chain can start, instead of blanking them with nothing to show', async () => {
    await mount(oneMoveFromWon())
    await winAndLandLastRun()
    mockMeasureView.mockImplementation(async () => null) // the sweep is done measuring: now no slot can be read

    await flush(2500)

    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(mockLog.cascadeChains).toBe(0)
    expect(screen.queryAllByTestId(/^pc-spades-13-/)).toHaveLength(8)
  })

  it('an undo out of the celebration brings the slots back, and a re-win never blanks them without a cascade to show', async () => {
    await mount(oneMoveFromWon())
    await winAndLandLastRun()
    await flush(2500)
    expect(mockLog.cascadeChains).toBe(8)
    expect(screen.queryAllByTestId(/^pc-spades-13-/)).toHaveLength(0)

    await act(async () => {
      fireEvent.press(screen.getByTestId('undo'))
    })
    await flush(3000)
    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(screen.queryAllByTestId(/^pc-spades-13-/)).toHaveLength(7) // the seven finished runs show again; the eighth is back in its column
    expect(cardsOnBoard()).toBe(13)

    // Winning again does not relaunch the cascade (a win is only recorded - and its cascade only queued - once per deal), so
    // nothing takes over from the slots: they must stay up under the banner instead of blanking with nothing to show.
    mockLog.cascadeChains = -1
    await tap(id(1, FINAL_DECK))
    await flush(FLIGHT_MS + 10 + 3000)
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(mockLog.cascadeChains).toBe(-1)
    expect(screen.queryAllByTestId(/^pc-spades-13-/)).toHaveLength(8)
  })
})

// handleDrawStock awaits the stock packet's measurement before it commits anything, and a deal is one batch on the shared
// animator: a second draw overlapping the first used to drop its pending deal - and with it the flight claim and any run sweep
// it held, which are never released, so undo (and, for a sweep, every tap, drag and deal) stayed dead until New Game.
describe('Spider screen - overlapping stock deals', () => {
  it('a second draw while the first is still measuring is ignored: the first deal completes its run and nothing is left locked', async () => {
    await mount(dealCompletesFirstRun())

    // Two presses back to back, with no await between them: neither continues past its measurement until both have started.
    const press = stockPress()
    await act(async () => {
      press()
      press()
    })
    await flush(FLIGHT_MS + 2500)

    expect(mockLog.deals).toBe(1) // one deal, not two racing for the same pendingDealRef
    expect(cardsOnBoard()).toBe(19) // its run swept to the slot exactly once
    expect(kingShownInSlot(0)).toBe(true)

    await tap(id(5, 11)) // the 5 dealt on column 1 onto the 6 left in column 0: the sweep's claim was released, nothing is locked
    expect(mockLog.shown).toEqual([id(5, 11)])
    await flush(FLIGHT_MS + 10)

    // ...and the flight claim was too: undo takes the move back (it refuses while any claim is outstanding).
    await act(async () => {
      fireEvent.press(screen.getByTestId('undo'))
    })
    await flush(FLIGHT_MS + 10)
    expect(mockLog.shown).toEqual([id(5, 11), id(5, 11)])
  })

  it('a second draw while the first deal is still in the air is ignored, and works once the first has landed', async () => {
    await mount(twoDealsLeft())
    expect(stockPackets()).toBe(2)

    await tapStock()
    await flush(10) // the first deal is in the air
    expect(mockLog.deals).toBe(1)
    expect(stockPackets()).toBe(1)

    await tapStock() // would start a second batch over the one still flying
    await flush(10)
    expect(mockLog.deals).toBe(1)
    expect(stockPackets()).toBe(1)

    await flush(FLIGHT_MS + 10) // the first has landed
    await tapStock()
    await flush(FLIGHT_MS + 10)
    expect(mockLog.deals).toBe(2) // not blocked for good
    expect(stockPackets()).toBe(0)
  })

  it('a New Game while the draw is still measuring its packet leaves the fresh board alone', async () => {
    await mount(twoDealsLeft())
    const open = gateRegistry()

    await tapStock() // its packet measurement is now waiting
    await act(async () => {
      fireEvent.press(screen.getByTestId('new-game'))
    })
    mockMeasureGate = null // the fresh game measures freely; only the old draw's measurement is still waiting
    await flush(FLIGHT_MS + 10) // the fresh game's own deal lands
    expect(cardsOnBoard()).toBe(54)

    open()
    await flush(FLIGHT_MS + 2500) // the old draw's measurement answers now

    expect(cardsOnBoard()).toBe(54) // the old game's dealt board did not overwrite the fresh one
    expect(stockPackets()).toBe(5)
    expect(mockLog.deals).toBe(1) // only the fresh game's own deal

    await tapStock() // and nothing is left claimed or blocked by the old draw
    await flush(FLIGHT_MS + 10)
    expect(mockLog.deals).toBe(2)
    expect(stockPackets()).toBe(4)
  })

  it('a New Game while a deal measures its destinations does not settle a claim that is no longer its own', async () => {
    await mount(twoDealsLeft())
    const open = gateRegistry(true)

    await tapStock() // the packet is measured and the deal committed; its cards' destinations are now waiting
    expect(mockLog.deals).toBe(0)
    mockMeasureGate = null // from here the fresh game measures freely; only the old deal's own measurements keep waiting
    await act(async () => {
      fireEvent.press(screen.getByTestId('new-game'))
    })
    await flush(FLIGHT_MS + 10) // the fresh game's own deal lands
    expect(mockLog.deals).toBe(1)

    await tapStock() // a draw in the fresh game: it holds a flight claim while its deal is in the air
    await flush(10)
    expect(stockPackets()).toBe(4)

    open() // the old deal's measurements answer now, to a token that no longer exists
    await flush(10)

    await act(async () => {
      fireEvent.press(screen.getByTestId('undo'))
    })
    await flush(10)
    expect(stockPackets()).toBe(4) // refused: the fresh draw's claim was not settled out from under it by the dead deal

    await flush(FLIGHT_MS + 10) // its deal lands
    await act(async () => {
      fireEvent.press(screen.getByTestId('undo'))
    })
    await flush(FLIGHT_MS + 10)
    expect(stockPackets()).toBe(5) // and undo works once it really has
  })
})

// restoreGame is also the mount effect's second run under StrictMode (dev), and that is the one way a screen ever restores with a
// game already on it - so nothing the first game left behind (a run-sweep claim, a stock deal in flight) may survive into the second.
describe('Spider screen - restoring a saved game over one in progress', () => {
  /** Mounts the screen under StrictMode with both of its saved-game loads left waiting, so a test decides when each restores. */
  async function mountWithTwoLoads(first: SpiderState, second: SpiderState) {
    const saves = [first, second].map((state) => JSON.stringify({ state, undoStack: [], moves: 5, elapsedSeconds: 30, config: 1 }))
    const answers: (() => void)[] = []
    // Each load (StrictMode mounts twice) resolves only when the test says so, like a slow storage read.
    jest.spyOn(require('@/stores/gameInProgress'), 'loadGameInProgress').mockImplementation(() => new Promise((resolve) => answers.push(() => resolve(JSON.parse(saves[answers.length - 1])))))
    await render(
      <StrictMode>
        <SpiderScreen />
      </StrictMode>
    )
    await flush()
    expect(answers).toHaveLength(2) // the mount effect ran twice, so two loads are waiting
    return async (which: 0 | 1) => {
      await act(async () => {
        answers[which]()
      })
      await flush()
    }
  }

  it("does not carry the first game's run-sweep claim into the restored one", async () => {
    const restore = await mountWithTwoLoads(oneMoveFromWon(), oneMoveFromWon())
    await restore(0)
    expect(cardsOnBoard()).toBe(13)

    // The winning move completes the run: it holds a claim on the sweep until the run has left, and the slot measurement that
    // would release it never answers.
    holdNextSlotMeasurement()
    await tap(id(1, FINAL_DECK))
    await flush(FLIGHT_MS + 10)
    expect(mockLog.shown).toEqual([id(1, FINAL_DECK)])
    expect(cardsOnBoard()).toBe(13)

    await restore(1) // the second load restores its board over the first game
    expect(cardsOnBoard()).toBe(13)

    await tap(id(1, FINAL_DECK)) // the same first move of a game that has nothing pending: it is not ignored
    expect(mockLog.shown).toEqual([id(1, FINAL_DECK), id(1, FINAL_DECK)])
  })

  it("does not carry the first game's stock deal in flight into the restored one", async () => {
    const restore = await mountWithTwoLoads(twoDealsLeft(), twoDealsLeft())
    await restore(0)
    expect(stockPackets()).toBe(2)

    await tapStock()
    await flush(10) // the first game's deal is in the air
    expect(mockLog.deals).toBe(1)

    await restore(1)
    expect(stockPackets()).toBe(2)

    await tapStock() // the restored game's own first deal: not refused because of the game it replaced
    await flush(10)
    expect(mockLog.deals).toBe(2)
    expect(stockPackets()).toBe(1)
  })
})

// A held Undo used to stall whenever the next undo needed cards the one before it was still flying back (Jay's Yukon recording,
// 2026-10-16). A run flying in to a column turns back in mid-air instead (ghost.peel).
describe('Spider screen - an undo that needs cards still flying back', () => {
  const col = (index: number) => ({ zone: 'tableau' as const, index })
  /** Keeps advancing fake time until `done()`. */
  async function flushUntil(done: () => boolean, maxMs = 2000) {
    for (let t = 0; !done() && t < maxMs; t += 10) await flush(10)
  }
  async function undo() {
    await act(async () => {
      fireEvent.press(screen.getByTestId('undo'))
    })
  }
  const columnIds = (index: number) =>
    within(screen.getByTestId(`pile-${index}`))
      .queryAllByTestId(/^card-/)
      .map((n) => (n.props.testID as string).slice('card-'.length))
  const spiderBoard = (columns: Card[][]): SpiderState => ({ tableau: Array.from({ length: 10 }, (_, i) => columns[i] ?? []), stock: [], completed: [], completedRuns: [] })

  it('turns them back in mid-air at once, instead of waiting for them to land', async () => {
    // The 5 went onto the 6, then the 6 and 5 together onto the 7.
    const s0 = spiderBoard([[card(5, 0)], [card(7, 0)], [card(6, 0)]])
    const s1 = spiderBoard([[], [card(7, 0)], [card(6, 0), card(5, 0)]])
    const s2 = spiderBoard([[], [card(7, 0), card(6, 0), card(5, 0)]])
    const entry = (state: SpiderState, from: number, to: number, count: number, anchorCardId: string) => ({ state, move: { from: col(from), to: col(to), count, anchorCardId } })
    seedGameInProgress('spider', { state: s2, undoStack: [entry(s0, 0, 2, 1, id(5, 0)), entry(s1, 2, 1, 2, id(6, 0))], moves: 2, elapsedSeconds: 30, config: 1 })
    await render(<SpiderScreen />)
    await flush()

    const pressed = Date.now()
    await undo()
    await flush(10)
    expect(mockLog.shown).toEqual([`${id(6, 0)}+${id(5, 0)}`])
    await undo()
    await flush(10)
    expect(mockPeel.peeled).toEqual([id(5, 0)]) // the 5 turned back out of the pair's flight
    expect(mockPeel.peeledAt[0] - pressed).toBeLessThan(FLIGHT_MS) // while the pair was still in the air
    expect(mockLog.shown).toHaveLength(1)

    await flushUntil(() => mockLog.inAir === 0)
    expect([0, 1, 2].map(columnIds)).toEqual([[id(5, 0)], [id(7, 0)], [id(6, 0)]])
  })
})
