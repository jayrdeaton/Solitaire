import AsyncStorage from '@react-native-async-storage/async-storage'
import { act, fireEvent, render, screen } from '@testing-library/react-native'

import type { PileDragConfig } from '@/components/PileView'
import { Card, Suit } from '@/engine/types'
import { ScorpionState } from '@/games/scorpion/rules'
import ScorpionScreen from '@/games/scorpion/ScorpionScreen'

// ---------------------------------------------------------------------------------------------------------------------
// A screen-level test for Scorpion's WIN: the REAL ScorpionScreen, real rules, real useFlightConcurrency / useDerivedWinCheck /
// useWinReveal / useGameSession / gameInProgress store (seeded through the AsyncStorage mock). Only what needs native views,
// gestures or animation is replaced, by a stand-in honoring the contract the screen relies on - see spiderScreenWin.test.tsx
// and freeCellScreenAutoPlay.test.tsx, whose harness this follows. The card registry is faithful: measure(id) answers only for
// a card some pile stand-in currently renders, exactly like the real CardRegistry, because "the winning card could not be
// measured (its column had already been blanked), so its ghost was hidden" is precisely the teleport this file pins - and,
// with a distinct position per rendered card (its column, and its place in the fan), because a completed run standing fanned
// must hand the win cascade every card's OWN spot, not one point for the whole column.
// ---------------------------------------------------------------------------------------------------------------------

const FLIGHT_MS = 80
const HOLD_MS = 400 // useWinReveal's WIN_REVEAL_HOLD_MS
const SAVE_KEY = 'solitaire.game-in-progress.v1.scorpion'

/** How long a tap/drop ghost takes to land (mutable: one test flies it slower than the celebration's own hold). */
let mockFlightMs = FLIGHT_MS
const mockRecordWon = jest.fn()
const mockRegistered = new Map<string, unknown>()
let mockPileInstance = 0
/** measureView's answer - null makes every measurement of a column container fail (mutable: one test starves the cascade of an origin). */
let mockColumnOrigin: { x: number; y: number } | null = { x: 5, y: 5 }
/** Each column's latest drag config, as PileView would hand it to its cards - the tests drop onto/from a column through it. */
const mockDrags: Record<number, PileDragConfig> = {}
interface MockRect {
  x: number
  y: number
  width: number
  height: number
}
const DEFAULT_RECT: MockRect = { x: 10, y: 10, width: 50, height: 70 }
/** Where the pile stand-in draws card `index` of column `column`: a distinct spot per card, fanned down its column. */
const fanRect = (column: number, index: number): MockRect => ({ x: 10 + column * 60, y: 10 + index * 22, width: 50, height: 70 })

interface MockChain {
  cards: { id: string }[]
  origin: { x: number; y: number }
  cardOrigins?: { x: number; y: number }[]
  entranceDelayMs: number
}
interface MockLog {
  /** Every ghost.show() - one per tap/drop/undo card flight the screen started. */
  shown: string[]
  /** flyTo() calls still waiting to land. */
  inAir: number
  /** flight.hide() calls - a ghost dropped without ever flying to a destination. */
  hidden: number
  /** How many chains the win cascade was started with (-1: it never started). */
  cascadeChains: number
  /** The card ids of every DealLayer batch the screen started (the assisted stock's burst). */
  deals: string[][]
  /** How many DealLayer flights had not landed yet the moment the win cascade started (-1: it never did). */
  dealsInAirAtCascade: number
  /** The chains the win cascade was started with. */
  chains: MockChain[]
  /** How many real cards were still on the board the moment the win cascade started (-1: it never did). */
  cardsOnBoardAtCascade: number
  /** The same, the moment the cascade's ghosts showed (its onShown; -1: they never did). */
  cardsOnBoardAtGhostsShown: number
  /** How many times the win cascade was cleared. */
  cleared: number
}
/** How many real card stand-ins the screen renders right now - read from inside the mocked cascade, hence hoisted-mock naming. */
const mockCardsNow = () => screen.queryAllByTestId(/^card-/).length
const mockLog: MockLog = { shown: [], inAir: 0, hidden: 0, cascadeChains: -1, deals: [], dealsInAirAtCascade: -1, chains: [], cardsOnBoardAtCascade: -1, cardsOnBoardAtGhostsShown: -1, cleared: 0 }
/** The real cascade shows - and calls startChains' onShown - only once its parked ghosts' faces have painted, a frame or two after
 * startChains (WinCascadeLayer's CascadeChains); the mock stands in for that wait with a timer. */
const MOCK_GHOSTS_SHOW_MS = 16
let mockGhostsShowTimer: ReturnType<typeof setTimeout> | undefined
let mockDealsInAir = 0

function mockMakeFlight() {
  return {
    hide: () => {
      mockLog.hidden += 1
    },
    flyTo: (_x: number, _y: number, onDone?: () => void) => {
      mockLog.inAir += 1
      setTimeout(() => {
        mockLog.inAir -= 1
        onDone?.()
      }, mockFlightMs)
    }
  }
}
const mockGhost = {
  cardRegistry: {
    register: (id: string, ref: unknown) => void mockRegistered.set(id, ref),
    unregister: (id: string, ref: unknown) => {
      if (mockRegistered.get(id) === ref) mockRegistered.delete(id)
    },
    measure: async (id: string) => {
      if (!mockRegistered.has(id)) return null
      return (mockRegistered.get(id) as { rects?: Map<string, MockRect> }).rects?.get(id) ?? DEFAULT_RECT
    }
  },
  show: (spec: { cards: { id: string }[] }) => {
    mockLog.shown.push(spec.cards.map((c) => c.id).join('+'))
    return mockMakeFlight()
  }
}
const mockDeal = {
  start: (entries: { cardId: string }[], _w: number, onLanded: (id: string) => void, onDone?: () => void) => {
    mockLog.deals.push(entries.map((e) => e.cardId))
    mockDealsInAir += 1
    setTimeout(() => {
      mockDealsInAir -= 1
      entries.forEach((e) => onLanded(e.cardId))
      onDone?.()
    }, FLIGHT_MS)
  },
  cancel: () => {}
}

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
    startChains: (chains: MockChain[], _cardWidth: number, onShown?: () => void) => {
      mockLog.cascadeChains = chains.length
      mockLog.chains = chains
      mockLog.dealsInAirAtCascade = mockDealsInAir
      mockLog.cardsOnBoardAtCascade = mockCardsNow()
      // Like the real controller: never for an empty cascade, and dropped by clear() or a newer startChains.
      clearTimeout(mockGhostsShowTimer)
      if (chains.length > 0 && onShown)
        mockGhostsShowTimer = setTimeout(() => {
          mockLog.cardsOnBoardAtGhostsShown = mockCardsNow()
          onShown()
        }, MOCK_GHOSTS_SHOW_MS)
    },
    clear: () => {
      mockLog.cleared += 1
      clearTimeout(mockGhostsShowTimer)
    }
  })
}))
jest.mock('@/components/dealing/measureView', () => ({ measureView: async () => mockColumnOrigin }))
jest.mock('@/components/RotatedGameView', () => ({ RotatedGameView: ({ children }: { children: unknown }) => children }))
jest.mock('@/components/GameStatusBar', () => ({ GameStatusBar: () => null }))
jest.mock('@/components/useCardSounds', () => ({ useCardSoundEffects: () => ({ playCardSound: () => {}, playInvalidSound: () => {}, hapticCard: () => {}, hapticInvalid: () => {} }) }))
jest.mock('@rific/feedback-press', () => ({ useVibration: () => ({ short: () => {}, selection: () => {} }) }))
jest.mock('@rific/toaster', () => ({ useToast: () => ({ info: () => {} }) }))
jest.mock('@tastic/animations/fireworks', () => ({ Fireworks: () => null }))
jest.mock('@/games/shared/WinBanner', () => {
  const { Text: MockText } = require('react-native')
  return { WinBanner: () => <MockText testID='win-banner'>won</MockText> }
})
jest.mock('@/stores/gameStats', () => ({ useGameStats: () => ({ recordDealWon: mockRecordWon, recordDealAbandoned: () => {}, recordHintUsed: () => {} }) }))
jest.mock('@/stores/lastActiveGame', () => ({ useLastActiveGame: () => ({ setLastActiveGame: () => {}, clearLastActiveGame: () => {} }) }))
jest.mock('@/stores/settings', () => {
  const actual = jest.requireActual('@/stores/settings')
  return { ...actual, useSettings: () => ({ settings: { ...actual.DEFAULT_SETTINGS, scorpionAssistedStock: true } }) }
})
jest.mock('@/components/theme', () => {
  const actual = jest.requireActual('@/components/theme')
  return { ...actual, useTableColors: () => actual.lightColors }
})
// Scorpion draws exactly one non-pile card - the assisted stock's packet, whose tap deals it out.
jest.mock('@/components/PlayingCard', () => {
  const { Pressable: MockPressable } = require('react-native')
  return { PlayingCard: ({ card, onPress }: { card: { id: string }; onPress?: () => void }) => <MockPressable testID={`pc-${card.id}`} onPress={onPress} /> }
})
jest.mock('@/components/PileView', () => {
  const { Pressable: MockPressable, View: MockView } = require('react-native')
  const { useEffect, useRef } = require('react')
  return {
    PileView: (props: { cards: Card[]; drag?: PileDragConfig; onPressCard: (card: Card, indexFromTop: number, measure: () => Promise<{ x: number; y: number }>) => void }) => {
      const id = useRef(mockPileInstance++).current
      const view = useRef({ rects: new Map<string, MockRect>() }).current
      if (props.drag) mockDrags[id % 7] = props.drag
      // Like PileView's own per-card registration: every rendered card is measurable (at its own spot in the fan), nothing else is.
      useEffect(() => {
        props.cards.forEach((c, i) => {
          view.rects.set(c.id, fanRect(id % 7, i))
          mockGhost.cardRegistry.register(c.id, view)
        })
        return () => props.cards.forEach((c) => mockGhost.cardRegistry.unregister(c.id, view))
      })
      return (
        <MockView testID={`pile-${id % 7}`}>
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

const id = (suit: Suit, rank: number) => `${suit}-${rank}-0`
const card = (suit: Suit, rank: number, faceUp = true): Card => ({ id: id(suit, rank), suit, rank, faceUp }) as Card
/** `high` down to `low` of one suit, all face up: a column's contents from the King (bottom) down. */
const run = (suit: Suit, high: number, low: number): Card[] => {
  const cards: Card[] = []
  for (let r = high; r >= low; r--) cards.push(card(suit, r))
  return cards
}

/** Three columns already complete, the fourth K..3 of spades with `[2, A]` of spades alone in a fifth: moving that pair onto the 3
 * completes the last run - the winning move. */
function oneMoveFromWon(): ScorpionState {
  return { tableau: [run('clubs', 13, 1), run('diamonds', 13, 1), run('hearts', 13, 1), run('spades', 13, 3), [card('spades', 2), card('spades', 1)], [], []], stock: [] }
}
/** Spades complete; the other three suits are K..2 in the three columns the assisted stock deals onto, each waiting for its Ace: the
 * stock deal itself is the winning move. */
function stockDealFromWon(): ScorpionState {
  return {
    tableau: [run('spades', 13, 1), [], [], [], run('clubs', 13, 2), run('diamonds', 13, 2), run('hearts', 13, 2)],
    stock: [card('clubs', 1, false), card('diamonds', 1, false), card('hearts', 1, false)]
  }
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

async function mount(state: ScorpionState) {
  jest.spyOn(AsyncStorage, 'getItem').mockImplementation(async (key: string) => (key === SAVE_KEY ? JSON.stringify({ state, undoStack: [], moves: 5, elapsedSeconds: 30, config: 1 }) : null))
  await render(<ScorpionScreen />)
  await flush() // loadGameInProgress -> restoreGame
  expect(screen.queryAllByTestId(/^card-/).length).toBe(state.tableau.flat().length)
}

async function tap(testID: string) {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID))
  })
}

const cardsOnBoard = () => screen.queryAllByTestId(/^card-/).length

/** Drops `count` cards headed by `anchorCardId` from column `from` onto `to`, exactly as PileView's drag-end would. */
async function drop(from: number, to: { zone: 'tableau'; index: number }, count: number, anchorCardId: string, flight: object): Promise<boolean> {
  let applied = false
  await act(async () => {
    applied = await mockDrags[from].onDrop(to, count, anchorCardId, flight as never)
  })
  return applied
}

beforeEach(() => {
  jest.useFakeTimers()
  mockPileInstance = 0
  mockRegistered.clear()
  mockDealsInAir = 0
  mockFlightMs = FLIGHT_MS
  mockLog.shown = []
  mockLog.inAir = 0
  mockLog.hidden = 0
  mockLog.cascadeChains = -1
  mockLog.deals = []
  mockLog.dealsInAirAtCascade = -1
  mockLog.chains = []
  mockLog.cardsOnBoardAtCascade = -1
  mockLog.cardsOnBoardAtGhostsShown = -1
  mockLog.cleared = 0
  mockColumnOrigin = { x: 5, y: 5 }
  mockRecordWon.mockClear()
})
afterEach(async () => {
  await act(async () => {
    await jest.runOnlyPendingTimersAsync()
  })
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('Scorpion screen - the winning move never makes a card teleport', () => {
  it('the winning cards fly onto the run they complete, and no column changes until they have landed and a beat has passed', async () => {
    await mount(oneMoveFromWon())

    await tap(`card-${id('spades', 2)}`)
    await flush(10) // the move has committed and its ghost is in the air

    expect(mockRecordWon).toHaveBeenCalledTimes(1) // the win is recorded the instant it happens...
    expect(mockLog.shown).toEqual([`${id('spades', 2)}+${id('spades', 1)}`])
    expect(mockLog.inAir).toBe(1) // ...and the pair really flies (its destination used to be blanked with the rest of the board, so the ghost was hidden on the spot)...
    expect(mockLog.hidden).toBe(0)
    expect(cardsOnBoard()).toBe(52) // ...onto a board that still shows every column, the completed ones included,
    expect(screen.queryByTestId('win-banner')).toBeNull() // with no celebration yet
    expect(mockLog.cascadeChains).toBe(-1)

    await flush(FLIGHT_MS) // the flight lands
    expect(mockLog.inAir).toBe(0)
    expect(cardsOnBoard()).toBe(52) // the completed board holds for a beat
    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(mockLog.cascadeChains).toBe(-1)

    await flush(HOLD_MS + 50)
    expect(screen.getByTestId('win-banner')).toBeTruthy() // then the celebration takes over,
    expect(cardsOnBoard()).toBe(0) // the columns giving way to the bouncing runs,
    expect(mockLog.cascadeChains).toBe(4) // one chain per completed column,
    expect(mockLog.inAir).toBe(0) // with nothing left in the air
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
    expect(mockLog.hidden).toBe(0)
  })

  it('a flight that outlasts the celebration hold still lands before anything celebrates', async () => {
    mockFlightMs = 1500 // longer than useWinReveal's hold, so a celebration timed from the WIN (not from the landing) would start mid-flight
    await mount(oneMoveFromWon())

    await tap(`card-${id('spades', 2)}`)
    await flush(HOLD_MS + 100)
    expect(mockLog.inAir).toBe(1) // still flying...
    expect(screen.queryByTestId('win-banner')).toBeNull() // ...so nothing has celebrated
    expect(mockLog.cascadeChains).toBe(-1)
    expect(cardsOnBoard()).toBe(52)

    await flush(1500 - (HOLD_MS + 100) + 50) // it lands (the hold starts over from there)
    expect(mockLog.inAir).toBe(0)
    expect(screen.queryByTestId('win-banner')).toBeNull()

    await flush(HOLD_MS + 50)
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(mockLog.cascadeChains).toBe(4)
    expect(mockLog.inAir).toBe(0)
  })

  it('a stock deal that wins the game deals its cards in (they used to have no destination to fly to, so the deal was skipped)', async () => {
    await mount(stockDealFromWon())

    await tap('pc-scorpion-stock-packet')
    await flush(10)

    expect(mockLog.deals).toEqual([[id('clubs', 1), id('diamonds', 1), id('hearts', 1)]]) // all three really fly...
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
    expect(cardsOnBoard()).toBe(52) // ...onto a board still showing every column,
    expect(screen.queryByTestId('win-banner')).toBeNull() // with no celebration while they are in the air
    expect(mockLog.cascadeChains).toBe(-1)

    await flush(FLIGHT_MS + HOLD_MS - 50)
    expect(mockLog.cascadeChains).toBe(-1) // the hold has not run out

    await flush(100)
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(mockLog.cascadeChains).toBe(4)
    expect(mockLog.dealsInAirAtCascade).toBe(0)
  })

  it('a New Game started while the finished board is still holding cancels the celebration', async () => {
    await mount(oneMoveFromWon())

    await tap(`card-${id('spades', 2)}`)
    await flush(10 + FLIGHT_MS + 200) // landed; the hold has begun but has not run out
    expect(cardsOnBoard()).toBe(52)
    expect(screen.queryByTestId('win-banner')).toBeNull()

    await act(async () => {
      fireEvent.press(screen.getByTestId('new-game'))
    })
    await flush(3000)

    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(mockLog.cascadeChains).toBe(-1)
    expect(cardsOnBoard()).toBe(49) // a fresh (assisted) deal
  })

  it('hands the cascade every card of a fanned run at its own spot, and the columns blank only as the ghosts arrive', async () => {
    await mount(oneMoveFromWon())

    await tap(`card-${id('spades', 2)}`)
    await flush(10 + FLIGHT_MS + HOLD_MS + 50)

    expect(mockLog.chains).toHaveLength(4)
    mockLog.chains.forEach((chain, column) => {
      // Ace first (the head), King last; every card carries where it really stood, not the King's slot.
      expect(chain.cards.map((c) => c.id)).toEqual(Array.from({ length: 13 }, (_, j) => id(['clubs', 'diamonds', 'hearts', 'spades'][column] as Suit, j + 1)))
      expect(chain.cardOrigins).toEqual(chain.cards.map((_, j) => ({ x: fanRect(column, 12 - j).x, y: fanRect(column, 12 - j).y })))
      expect(new Set(chain.cardOrigins!.map((o) => `${o.x},${o.y}`)).size).toBe(13)
      expect(chain.origin).toEqual({ x: 5, y: 5 }) // the chain's own origin stays the column container's
    })
    // The cascade started while every real card was still on the board, the board kept them until the ghosts were on screen
    // (their faces paint a frame or two after they mount: blanking with startChains showed a fan of blank-faced cards), and the
    // columns are blank now: measuring after the blanking finds nothing, and blanking first leaves the fan empty until the
    // ghosts arrive.
    expect(mockLog.cardsOnBoardAtCascade).toBe(52)
    expect(mockLog.cardsOnBoardAtGhostsShown).toBe(52)
    expect(cardsOnBoard()).toBe(0)
    expect(screen.getByTestId('win-banner')).toBeTruthy()
  })

  it('leaves the finished columns up when no chain can start, instead of blanking them with nothing to show', async () => {
    mockColumnOrigin = null // every column container fails to measure
    await mount(oneMoveFromWon())

    await tap(`card-${id('spades', 2)}`)
    await flush(10 + FLIGHT_MS + HOLD_MS + 50)

    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(mockLog.cascadeChains).toBe(0)
    expect(cardsOnBoard()).toBe(52)
  })

  it('an undo out of the celebration brings the columns back, and a re-win never blanks them without a cascade to show', async () => {
    await mount(oneMoveFromWon())
    await tap(`card-${id('spades', 2)}`)
    await flush(10 + FLIGHT_MS + HOLD_MS + 50)
    expect(cardsOnBoard()).toBe(0)

    await tap('undo')
    await flush(200)
    expect(mockLog.cleared).toBeGreaterThan(0)
    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(cardsOnBoard()).toBe(52) // the run is split again and every column shows

    // Winning again does not relaunch the cascade (the win is only recorded - and its cascade only queued - once per deal),
    // so nothing takes over from the finished columns: they must stay up under the banner, not blank with nothing to show.
    mockLog.chains = []
    mockLog.cascadeChains = -1
    await tap(`card-${id('spades', 2)}`)
    await flush(10 + FLIGHT_MS + HOLD_MS + 50)
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(mockLog.cascadeChains).toBe(-1)
    expect(cardsOnBoard()).toBe(52)
  })

  it('refuses a drop once the game is won, so the held finished board cannot be broken up', async () => {
    await mount(oneMoveFromWon())

    // Not gated before the win: the winning move itself can be a drag.
    const winningFlight = mockMakeFlight()
    expect(await drop(4, { zone: 'tableau', index: 3 }, 2, id('spades', 2), winningFlight)).toBe(true)
    await flush(10 + FLIGHT_MS + 100) // landed; the celebration is holding
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
    expect(cardsOnBoard()).toBe(52)

    // Dropping the Ace of clubs onto the empty column would split a completed run (and un-win the deal).
    const flight = { hide: jest.fn(), flyTo: jest.fn(), snapBack: jest.fn() }
    expect(await drop(0, { zone: 'tableau', index: 5 }, 1, id('clubs', 1), flight)).toBe(false)
    await flush(HOLD_MS + 50)

    expect(flight.flyTo).not.toHaveBeenCalled()
    expect(mockLog.shown).toEqual([]) // no ghost was shown for it either
    expect(screen.getByTestId('win-banner')).toBeTruthy() // the win stood, and the celebration ran
    expect(mockLog.cascadeChains).toBe(4)
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
  })

  it('a move that does not win never blanks the board', async () => {
    const state = oneMoveFromWon()
    state.tableau[5] = [card('hearts', 13, true)] // a stray King: the deal is not won even once the pair lands
    state.tableau[2] = run('hearts', 12, 1)
    await mount(state)

    await tap(`card-${id('spades', 2)}`)
    await flush(FLIGHT_MS + 10 + 3000)

    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(mockLog.cascadeChains).toBe(-1)
    expect(cardsOnBoard()).toBe(52)
  })
})
