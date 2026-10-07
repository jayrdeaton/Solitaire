import AsyncStorage from '@react-native-async-storage/async-storage'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { useEffect } from 'react'

import { PileRef } from '@/engine/gameTypes'
import { Card, Suit, SUITS } from '@/engine/types'
import KlondikeScreen from '@/games/klondike/KlondikeScreen'
import * as klondikeRules from '@/games/klondike/rules'
import { KlondikeState } from '@/games/klondike/rules'

// ---------------------------------------------------------------------------------------------------------------------
// A screen-level test for Klondike's win flow and its "a card never moves without its own flight" rule: the REAL
// KlondikeScreen, real game rules, real useFlightConcurrency / useAutoFoundationCascade / useGameSession /
// useFoundationWinCheck / useWinReveal / gameInProgress store, seeded with a saved game through the AsyncStorage mock.
// Only what needs native views, gestures or animation is replaced, each by a stand-in honoring the contract the screen
// relies on (same approach as freeCellScreenAutoPlay.test.tsx):
//   - PileView / StockWaste / FoundationCell: render the card ids they are given AND register the cards they would
//     register in the real CardRegistry (every pile card, the waste top, a foundation's top card) - so a card that is
//     hidden or buried really is unmeasurable, which is exactly the situation the teleport fixes are about.
//   - useDragGhost: a fake ghost whose flights "land" FLIGHT_MS later (the Reanimated mock's withSpring never calls
//     its completion callback). A ghost that is hide()n instead of flown is what a teleport looks like - counted.
//   - useDealAnimator: lands every entry after a beat (the cascade-undo flights go through it).
// ---------------------------------------------------------------------------------------------------------------------

const FLIGHT_MS = 80
/** How long a fake flight stays in the air - a test raises it to outlast the celebration's hold. */
const mockFlight = { ms: FLIGHT_MS }
const HOLD_MS = 400 // useWinReveal's WIN_REVEAL_HOLD_MS
const SAVE_KEY = 'solitaire.game-in-progress.v1.klondike'

const mockSettings = { autoMove: true }
const mockRecordWon = jest.fn()
const mockPiles = new Map<number, { cards: Card[]; drag: { onDrop: (to: PileRef, count: number, anchorCardId: string, flight: unknown) => Promise<boolean> | boolean } }>()
let mockPileInstance = 0

interface MockFlightLog {
  /** Every ghost.show() - one per card flight the screen started (tap, drop, cascade step, undo). */
  shown: string[]
  /** Every card handed to the deal-style flight (cascade undo returns). */
  dealt: string[]
  /** flyTo() calls still waiting to land. */
  inAir: number
  /** Ghosts that were hide()n instead of flown to a destination - the card just APPEARS where it was headed. */
  hides: number
  /** How many flights were still in the air the moment the win cascade started (-1: it never did). */
  airAtWinCascade: number
  /** How many chains the win cascade was started with (-1: it never started). */
  chainsAtWinCascade: number
  /** What each foundation pile was showing (a card id, or 'empty') the moment the win cascade started - null if it never did. */
  foundationsAtWinCascade: string[] | null
  /** The same, the moment the cascade's ghosts showed (its onShown) - null if they never did. */
  foundationsAtGhostsShown: string[] | null
  /** Commit-time order of the hand-off: 'cascade' when startChains is called, 'ghosts-shown' when the cascade shows and calls the
   * screen's onShown, 'blank-<suit>' when a foundation cell commits with no real card (an empty pile mid-game shows up here too, so
   * only tests that start from full piles read it). */
  events: string[]
}
const mockLog: MockFlightLog = { shown: [], dealt: [], inAir: 0, hides: 0, airAtWinCascade: -1, chainsAtWinCascade: -1, foundationsAtWinCascade: null, foundationsAtGhostsShown: null, events: [] }
/** The real cascade shows - and calls startChains' onShown - only once its parked ghosts' faces have painted, a frame or two after
 * startChains (WinCascadeLayer's CascadeChains); the mock stands in for that wait with a timer. */
const MOCK_GHOSTS_SHOW_MS = 16
let mockGhostsShowTimer: ReturnType<typeof setTimeout> | undefined
/** Suits whose foundation slot container fails to measure (the rare origin-measurement failure the screen falls back on). */
const mockUnmeasurableSlots = new Set<string>()
/** What every foundation cell shows right now - read from inside the mocked cascade, hence hoisted-mock naming. */
const mockFoundationsNow = () => SUITS.map((suit) => screen.getByTestId(`foundation-${suit}`).props.children as string)

const mockRegistered = new Map<string, symbol>()
const mockRegistry = {
  register: () => {},
  unregister: () => {},
  measure: async (cardId: string): Promise<{ x: number; y: number; width: number; height: number } | null> => (mockRegistered.has(cardId) ? { x: 10, y: 10, width: 40, height: 56 } : null)
}
/** Registers `cardId` for as long as it is mounted (render it inside a stand-in) - same "only remove my own registration" rule as the real CardRegistry. */
function MockRegister({ cardId }: { cardId: string | undefined }) {
  useEffect(() => {
    if (!cardId) return
    const token = Symbol(cardId)
    mockRegistered.set(cardId, token)
    return () => {
      if (mockRegistered.get(cardId) === token) mockRegistered.delete(cardId)
    }
  }, [cardId])
  return null
}

function mockMakeFlight() {
  return {
    hide: () => {
      mockLog.hides += 1
    },
    flyTo: (_x: number, _y: number, onDone?: () => void) => {
      mockLog.inAir += 1
      setTimeout(() => {
        mockLog.inAir -= 1
        onDone?.()
      }, mockFlight.ms)
    }
  }
}
const mockGhost = {
  cardRegistry: mockRegistry,
  show: (spec: { cards: { id: string }[] }) => {
    mockLog.shown.push(spec.cards.map((c) => c.id).join('+'))
    return mockMakeFlight()
  }
}
const mockDeal = {
  start: (entries: { cardId: string }[], _w: number, onLanded: (id: string) => void, onDone?: () => void) => {
    mockLog.dealt.push(...entries.map((e) => e.cardId))
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
  // Unmounting drops a cascade that has not shown yet, like the real provider (a test can end mid-wait).
  WinCascadeProvider: ({ children }: { children: unknown }) => {
    require('react').useEffect(() => () => clearTimeout(mockGhostsShowTimer), [])
    return children
  },
  WinCascadeGhosts: () => null,
  useWinCascade: () => ({
    startChains: (chains: unknown[], _cardWidth: number, onShown?: () => void) => {
      mockLog.airAtWinCascade = mockLog.inAir
      mockLog.chainsAtWinCascade = chains.length
      mockLog.foundationsAtWinCascade = mockFoundationsNow()
      mockLog.events.push('cascade')
      // Like the real controller: never for an empty cascade, and dropped by clear() or a newer startChains.
      clearTimeout(mockGhostsShowTimer)
      if (chains.length > 0 && onShown)
        mockGhostsShowTimer = setTimeout(() => {
          mockLog.foundationsAtGhostsShown = mockFoundationsNow()
          mockLog.events.push('ghosts-shown')
          onShown()
        }, MOCK_GHOSTS_SHOW_MS)
    },
    clear: () => clearTimeout(mockGhostsShowTimer)
  })
}))
// A foundation slot container measures like any view unless its suit is in mockUnmeasurableSlots; every other view (the stock/waste
// refs the stand-ins never attach, so null) keeps answering.
jest.mock('@/components/dealing/measureView', () => ({ measureView: async (view: { suit?: string } | null) => (view?.suit && mockUnmeasurableSlots.has(view.suit) ? null : { x: 5, y: 5 }) }))
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
jest.mock('@/hooks/useSettings', () => {
  const actual = jest.requireActual('@/redux/settingsSlice')
  return { useSettings: () => ({ settings: { ...actual.DEFAULT_SETTINGS, autoMoveToFoundation: mockSettings.autoMove } }) }
})
jest.mock('@/components/theme', () => {
  const actual = jest.requireActual('@/components/theme')
  return { ...actual, useTableColors: () => actual.lightColors }
})
jest.mock('@/components/PlayingCard', () => {
  const { View: MockView } = require('react-native')
  return { PlayingCard: () => <MockView />, EmptySlot: () => <MockView />, FoundationSlot: () => <MockView /> }
})
// It also reports what the real cell paints UNDER the incoming ghost(s) while a flight is in the air (the caller's
// settledCard, or the frozen copy of what was on top before the flight began when it gives none) - 'none' when nothing
// is flying here.
jest.mock('@/games/shared/FoundationCell', () => {
  const { Text: MockText, View: MockView } = require('react-native')
  const { useEffect: mockEffect } = require('react')
  const { useFrozenWhileHidden } = jest.requireActual('@/components/useFrozenWhileHidden')
  function MockFoundationCell({ card, suit, isFlyingHere, settledCard, slotRef }: { card?: { id: string }; suit: string; isFlyingHere: boolean; settledCard?: { id: string } | null; slotRef?: (el: { suit: string } | null) => void }) {
    const frozenCopy = useFrozenWhileHidden(card, isFlyingHere)
    const underGhost = settledCard === undefined ? frozenCopy : settledCard
    // Like the real cell's outer container: always mounted, whether or not a real card is drawn, and handed to the screen as the slot to measure.
    mockEffect(() => {
      slotRef?.({ suit })
      return () => slotRef?.(null)
    }, [slotRef, suit])
    mockEffect(() => {
      if (!card) mockLog.events.push(`blank-${suit}`)
    }, [card, suit])
    return (
      <MockView>
        <MockRegister cardId={card?.id} />
        <MockText testID={`foundation-${suit}`}>{card ? card.id : 'empty'}</MockText>
        <MockText testID={`under-ghost-${suit}`}>{isFlyingHere ? (underGhost ? underGhost.id : 'empty') : 'none'}</MockText>
      </MockView>
    )
  }
  return { FoundationCell: MockFoundationCell }
})
jest.mock('@/components/StockWaste', () => {
  const { Pressable: MockPressable, Text: MockText, View: MockView } = require('react-native')
  function MockWasteTop({ card, onPress }: { card: { id: string }; onPress: (measure: () => Promise<{ x: number; y: number }>) => void }) {
    return (
      <MockPressable testID='waste-top' onPress={() => onPress(async () => ({ x: 10, y: 10 }))}>
        <MockRegister cardId={card.id} />
        <MockText testID='top-of-waste'>{card.id}</MockText>
      </MockPressable>
    )
  }
  return {
    StockWaste: (props: { wasteTop?: { id: string }; onDrawStock: () => void; onWastePress: (measure: () => Promise<{ x: number; y: number }>) => void }) => (
      <MockView>
        <MockPressable testID='stock-pile' onPress={() => props.onDrawStock()} />
        {props.wasteTop ? <MockWasteTop card={props.wasteTop} onPress={props.onWastePress} /> : null}
      </MockView>
    )
  }
})
jest.mock('@/components/PileView', () => {
  const { Pressable: MockPressable, View: MockView } = require('react-native')
  const { useEffect: mockEffect, useRef: mockRef } = require('react')
  function MockPileCard({ card, onPress }: { card: { id: string }; onPress: () => void }) {
    return (
      <MockPressable testID={`card-${card.id}`} onPress={onPress}>
        <MockRegister cardId={card.id} />
      </MockPressable>
    )
  }
  return {
    PileView: (props: { cards: Card[]; onPressCard: (card: Card, indexFromTop: number, measure: () => Promise<{ x: number; y: number }>) => void; drag: never }) => {
      const id = mockRef(mockPileInstance++).current
      mockPiles.set(id, { cards: props.cards, drag: props.drag })
      mockEffect(() => () => void mockPiles.delete(id), [id])
      return (
        <MockView>
          {props.cards.map((card, i) => (
            <MockPileCard key={card.id} card={card} onPress={() => props.onPressCard(card, props.cards.length - 1 - i, async () => ({ x: 10, y: 10 }))} />
          ))}
        </MockView>
      )
    }
  }
})
jest.mock('@/components/GameChrome', () => {
  const { Pressable: MockPressable, Text: MockText, View: MockView } = require('react-native')
  return {
    GAME_CONTENT_PADDING: 6,
    GameChrome: ({ children, onUndo, onNewGame, won, movesCount, undoDisabled }: { children: unknown; onUndo: () => void; onNewGame: () => void; won: boolean; movesCount: number; undoDisabled: boolean }) => (
      <MockView>
        <MockPressable testID='undo' onPress={onUndo} />
        <MockPressable testID='new-game' onPress={onNewGame} />
        <MockText testID='chrome-won'>{String(won)}</MockText>
        <MockText testID='chrome-moves'>{String(movesCount)}</MockText>
        <MockText testID='chrome-undo-disabled'>{String(undoDisabled)}</MockText>
        {children}
      </MockView>
    )
  }
})

// ------------------------------------------------------------------------------------------------ boards

const card = (suit: Suit, rank: number, faceUp = true): Card => ({ id: `${suit}-${rank}-0`, suit, rank, faceUp }) as Card
const id = (suit: Suit, rank: number) => `${suit}-${rank}-0`
/** Foundation piles, Ace first, each filled up to the given rank (13 = complete, missing = empty). */
function foundations(upTo: Partial<Record<Suit, number>>): Card[][] {
  return SUITS.map((suit) => Array.from({ length: upTo[suit] ?? 0 }, (_, i) => card(suit, i + 1)))
}
function board(parts: { tableau?: Card[][]; foundation: Card[][]; stock?: Card[]; waste?: Card[] }): KlondikeState {
  return { tableau: Array.from({ length: 7 }, (_, i) => parts.tableau?.[i] ?? []), foundation: parts.foundation, stock: parts.stock ?? [], waste: parts.waste ?? [] }
}

/** Every card is home except the King of clubs, alone in a column: tapping it wins the game. */
const KING_IN_COLUMN = () => board({ tableau: [[card('clubs', 13)]], foundation: foundations({ clubs: 12, diamonds: 13, hearts: 13, spades: 13 }) })
/** The same, with the King on the waste. */
const KING_ON_WASTE = () => board({ waste: [card('clubs', 13)], foundation: foundations({ clubs: 12, diamonds: 13, hearts: 13, spades: 13 }) })
/** Tapping the Queen wins, in two steps: the Queen goes up, then auto-play sends the King (bared by it) up. */
const KING_AUTOPLAYED = () => board({ tableau: [[card('clubs', 13), card('clubs', 12)]], foundation: foundations({ clubs: 11, diamonds: 13, hearts: 13, spades: 13 }) })
/** Tapping the Queen wins, with the King still in the stock: auto-play draws it and sends it straight up (drawAndPlay). */
const KING_FROM_STOCK = () => board({ tableau: [[card('clubs', 12)]], stock: [card('clubs', 13, false)], foundation: foundations({ clubs: 11, diamonds: 13, hearts: 13, spades: 13 }) })
/** Tapping 5 of hearts sends it to its foundation and auto-play then sends 6 of hearts up ON TOP of it; A of diamonds (face-down) keeps the game from being finishable. */
const FIVE_THEN_SIX = () => board({ tableau: [[card('hearts', 5)], [card('hearts', 6)], [card('diamonds', 1, false), card('diamonds', 2)]], foundation: foundations({ clubs: 13, spades: 13, hearts: 4 }) })

// ------------------------------------------------------------------------------------------------ harness

const STEP_MS = 10

/** Advances fake time by `ms`, in small steps each inside its OWN act(): the cascade is a chain of "land -> render -> effect
 * -> next card", so one big advance would starve it (see freeCellScreenAutoPlay.test.tsx). */
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

/** Keeps advancing fake time until `done()` - for "the first flight has landed", whose exact moment the test does not pin. */
async function flushUntil(done: () => boolean, maxMs = 2000) {
  for (let t = 0; !done() && t < maxMs; t += STEP_MS) await flush(STEP_MS)
}

/** `undoStack`/`moves` seed the save too (an old save's undo entries, for the legacy-shape tests). */
async function mount(state: KlondikeState, expectedCards: number, undoStack: unknown[] = [], moves = 0) {
  jest.spyOn(AsyncStorage, 'getItem').mockImplementation(async (key: string) => (key === SAVE_KEY ? JSON.stringify({ state, undoStack, moves, elapsedSeconds: 0, config: 1 }) : null))
  await render(<KlondikeScreen />)
  await flush() // loadGameInProgress -> restoreGame
  expect(screen.queryAllByTestId(/^card-|^waste-top/).length).toBe(expectedCards)
}

const foundationTop = (suit: Suit) => screen.getByTestId(`foundation-${suit}`).props.children as string
/** What the foundation pile shows under its incoming ghost(s): a card id, 'empty' (the bare slot), or 'none' (nothing is flying there). */
const underGhost = (suit: Suit) => screen.getByTestId(`under-ghost-${suit}`).props.children as string
const cardsOnBoard = () => screen.queryAllByTestId(/^card-|^waste-top/).length
const movesCount = () => screen.getByTestId('chrome-moves').props.children as string
const undoDisabled = () => screen.getByTestId('chrome-undo-disabled').props.children as string
/** The waste's top card id, or 'none'. */
const wasteTop = () => (screen.queryByTestId('top-of-waste')?.props.children as string | undefined) ?? 'none'
const pileIds = (index: number) => [...mockPiles.values()][index]?.cards.map((c) => c.id)

async function tap(testID: string) {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID))
  })
}
const tapCard = (cardId: string) => tap(`card-${cardId}`)

beforeEach(() => {
  jest.useFakeTimers()
  mockSettings.autoMove = true
  mockFlight.ms = FLIGHT_MS
  mockPiles.clear()
  mockPileInstance = 0
  mockRegistered.clear()
  mockLog.shown = []
  mockLog.dealt = []
  mockLog.inAir = 0
  mockLog.hides = 0
  mockLog.airAtWinCascade = -1
  mockLog.chainsAtWinCascade = -1
  mockLog.foundationsAtWinCascade = null
  mockLog.foundationsAtGhostsShown = null
  mockLog.events = []
  mockUnmeasurableSlots.clear()
  mockRecordWon.mockClear()
})
afterEach(async () => {
  await act(async () => {
    await jest.runOnlyPendingTimersAsync()
  })
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('Klondike screen - the win celebration waits for the winning card to fly in and land', () => {
  it.each([
    ['a tableau card', KING_IN_COLUMN, () => tapCard(id('clubs', 13))],
    ['the waste top', KING_ON_WASTE, () => tap('waste-top')]
  ])('%s: the winning card flies (not vanishes), and neither the foundations nor the banner change until it has landed and a beat has passed', async (_name, makeBoard, tapKing) => {
    await mount(makeBoard(), 1)
    expect(foundationTop('clubs')).toBe(id('clubs', 12))

    await tapKing()
    await flush(10) // the move has committed and its ghost is in the air

    expect(mockRecordWon).toHaveBeenCalledTimes(1) // the win is recorded the instant it happens (game state, not celebration)...
    expect(screen.getByTestId('chrome-won').props.children).toBe('true')
    expect(mockLog.shown).toEqual([id('clubs', 13)])
    expect(mockLog.inAir).toBe(1) // ...the winning card really is flying (not hide()n)...
    expect(mockLog.hides).toBe(0)
    expect(foundationTop('clubs')).toBe(id('clubs', 13)) // ...to a foundation that is still showing the whole pile,
    expect(screen.queryByTestId('win-banner')).toBeNull() // with no celebration yet
    expect(screen.queryByTestId('fireworks')).toBeNull()
    expect(mockLog.airAtWinCascade).toBe(-1)

    await flush(FLIGHT_MS) // the flight lands
    expect(mockLog.inAir).toBe(0)
    expect(foundationTop('clubs')).toBe(id('clubs', 13)) // the completed board holds for a beat
    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(screen.queryByTestId('fireworks')).toBeNull()

    await flush(HOLD_MS + 50)
    expect(screen.getByTestId('win-banner')).toBeTruthy() // then the celebration takes over
    expect(screen.getByTestId('fireworks')).toBeTruthy()
    expect(foundationTop('clubs')).toBe('empty')
    expect(mockLog.airAtWinCascade).toBe(0) // with nothing left in the air
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
  })

  it('a flight that outlasts the hold still lands before the celebration starts', async () => {
    await mount(KING_IN_COLUMN(), 1)
    mockFlight.ms = HOLD_MS * 3

    await tapCard(id('clubs', 13))
    await flush(HOLD_MS * 2) // long past the hold, the King is still in the air
    expect(mockLog.inAir).toBe(1)
    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(screen.queryByTestId('fireworks')).toBeNull()
    expect(foundationTop('clubs')).toBe(id('clubs', 13))

    await flush(HOLD_MS * 2) // landed, and the hold has run since
    expect(mockLog.inAir).toBe(0)
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(screen.getByTestId('fireworks')).toBeTruthy()
    expect(mockLog.airAtWinCascade).toBe(0)
  })

  it('an auto-played last card flies too, and the celebration waits for it', async () => {
    await mount(KING_AUTOPLAYED(), 2)

    await tapCard(id('clubs', 12))
    await flush(10000)

    expect(mockLog.shown).toEqual([id('clubs', 12), id('clubs', 13)]) // the Queen, then the King, each with its own ghost
    expect(mockLog.hides).toBe(0)
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(screen.getByTestId('fireworks')).toBeTruthy()
    expect(mockLog.airAtWinCascade).toBe(0) // the win cascade started only once the King's flight had landed
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
  })

  it('a last card drawn from the stock and sent straight up flies too, and the celebration waits for it', async () => {
    await mount(KING_FROM_STOCK(), 1)

    await tapCard(id('clubs', 12))
    await flush(10000)

    expect(mockLog.shown).toEqual([id('clubs', 12), id('clubs', 13)])
    expect(mockLog.hides).toBe(0)
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(screen.getByTestId('fireworks')).toBeTruthy()
    expect(mockLog.airAtWinCascade).toBe(0)
  })

  it('is not withheld by a flight that never lands', async () => {
    await mount(KING_IN_COLUMN(), 1)
    const tapMove = jest.spyOn(mockGhost, 'show').mockImplementation(() => ({ hide: () => {}, flyTo: () => {} }) as never) // its flight never calls back

    await tapCard(id('clubs', 13))
    await flush(3000)

    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(screen.getByTestId('fireworks')).toBeTruthy()
    expect(tapMove).toHaveBeenCalledTimes(1)
  })

  it('an undo inside the hold cancels the celebration, and the card flies back', async () => {
    await mount(KING_IN_COLUMN(), 1)
    await tapCard(id('clubs', 13))
    await flush(FLIGHT_MS + 100) // landed, still inside the hold

    await tap('undo')
    await flush(HOLD_MS + 1000)

    expect(screen.queryByTestId('win-banner')).toBeNull() // the pending reveal was cancelled...
    expect(screen.queryByTestId('fireworks')).toBeNull()
    expect(screen.getByTestId('chrome-won').props.children).toBe('false')
    expect(mockLog.shown).toEqual([id('clubs', 13), id('clubs', 13)]) // ...and the King flew home instead of reappearing
    expect(pileIds(0)).toEqual([id('clubs', 13)])
    expect(foundationTop('clubs')).toBe(id('clubs', 12))
    expect(mockLog.hides).toBe(0)
  })

  it('New Game inside the hold cancels the celebration', async () => {
    await mount(KING_IN_COLUMN(), 1)
    await tapCard(id('clubs', 13))
    await flush(FLIGHT_MS + 100)

    await tap('new-game')
    await flush(HOLD_MS + 3000)

    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(screen.queryByTestId('fireworks')).toBeNull()
    expect(screen.getByTestId('chrome-won').props.children).toBe('false')
    expect(cardsOnBoard()).toBe(28) // a fresh deal: 1+2+...+7 tableau cards (the rest is stock)
  })
})

describe('Klondike screen - the foundation piles hand over to the win cascade once its ghosts show', () => {
  const settleAndHold = FLIGHT_MS + HOLD_MS + MOCK_GHOSTS_SHOW_MS + 100

  it('every pile is still fully drawn when the cascade starts and until its ghosts show, and they blank in the commit that follows - never a frame of empty piles before the ghosts', async () => {
    await mount(KING_IN_COLUMN(), 1)

    await tapCard(id('clubs', 13))
    await flushUntil(() => mockLog.events.includes('cascade'))

    // Blanking on the reveal alone emptied all four piles first, and only THEN (after the origin measurement) started the
    // cascade whose ghosts stand in for them - a few empty frames in between.
    expect(mockLog.chainsAtWinCascade).toBe(4)
    expect(mockLog.foundationsAtWinCascade).toEqual(SUITS.map((suit) => id(suit, 13)))
    // The ghosts are mounted but not on screen yet (their faces are still painting), so the real piles stay up meanwhile:
    // blanking them with startChains showed blank-faced Kings for a frame or two.
    expect(mockLog.events).toEqual(['cascade'])
    expect(SUITS.map(foundationTop)).toEqual(SUITS.map((suit) => id(suit, 13)))

    await flushUntil(() => mockLog.events.includes('ghosts-shown'))
    expect(mockLog.foundationsAtGhostsShown).toEqual(SUITS.map((suit) => id(suit, 13)))
    // The piles blanked in the commit that follows the ghosts showing: already, within the very step it happened in (not on a later timer).
    expect(mockLog.events).toEqual(['cascade', 'ghosts-shown', ...SUITS.map((suit) => `blank-${suit}`)])
    expect(SUITS.map(foundationTop)).toEqual(SUITS.map(() => 'empty'))
    expect(screen.getByTestId('win-banner')).toBeTruthy()
  })

  it('an undo after the cascade started but before its ghosts showed leaves every pile up, and the cascade never hands over', async () => {
    await mount(KING_IN_COLUMN(), 1)
    await tapCard(id('clubs', 13))
    await flushUntil(() => mockLog.events.includes('cascade'))

    await tap('undo') // clears the cascade, which drops its onShown
    await flush(1000)

    expect(mockLog.events).toEqual(['cascade'])
    expect(foundationTop('clubs')).toBe(id('clubs', 12))
    expect(SUITS.filter((suit) => suit !== 'clubs').map(foundationTop)).toEqual(SUITS.filter((suit) => suit !== 'clubs').map((suit) => id(suit, 13)))
    expect(pileIds(0)).toEqual([id('clubs', 13)])
    expect(screen.queryByTestId('win-banner')).toBeNull()
  })

  it('a pile whose slot cannot be measured keeps its real card (it gets no chain, so nothing would stand in), while the rest hand over', async () => {
    mockUnmeasurableSlots.add('hearts')
    await mount(KING_IN_COLUMN(), 1)

    await tapCard(id('clubs', 13))
    await flush(settleAndHold)

    expect(mockLog.chainsAtWinCascade).toBe(3)
    expect(mockLog.foundationsAtWinCascade).toEqual(SUITS.map((suit) => id(suit, 13)))
    expect(mockLog.events).toEqual(['cascade', 'ghosts-shown', ...SUITS.filter((suit) => suit !== 'hearts').map((suit) => `blank-${suit}`)])
    expect(foundationTop('hearts')).toBe(id('hearts', 13))
    expect(SUITS.filter((suit) => suit !== 'hearts').map(foundationTop)).toEqual(['empty', 'empty', 'empty'])
    expect(screen.getByTestId('win-banner')).toBeTruthy()
  })

  it('leaves every pile up when no chain can start, instead of blanking them with nothing to show', async () => {
    SUITS.forEach((suit) => mockUnmeasurableSlots.add(suit))
    await mount(KING_IN_COLUMN(), 1)

    await tapCard(id('clubs', 13))
    await flush(settleAndHold)

    expect(mockLog.chainsAtWinCascade).toBe(0)
    expect(mockLog.events).toEqual(['cascade']) // an empty cascade has nothing to show: no onShown, so nothing hands over
    expect(SUITS.map(foundationTop)).toEqual(SUITS.map((suit) => id(suit, 13)))
    expect(screen.getByTestId('win-banner')).toBeTruthy()
  })

  it("a second win in the same mounted screen (after a New Game) hands over on its own - the first win's hand-off never blanks the new piles early", async () => {
    await mount(KING_IN_COLUMN(), 1)
    await tapCard(id('clubs', 13))
    await flush(settleAndHold)
    expect(mockLog.events).toEqual(['cascade', 'ghosts-shown', ...SUITS.map((suit) => `blank-${suit}`)]) // the first win handed over

    // The next deal is one move from won again.
    const newController = klondikeRules.createKlondikeController
    jest.spyOn(klondikeRules, 'createKlondikeController').mockImplementation((draw) => ({ ...newController(draw), newGame: () => KING_IN_COLUMN() }))
    await tap('new-game')
    await flush(3000)
    expect(cardsOnBoard()).toBe(1)
    expect(SUITS.map(foundationTop)).toEqual(SUITS.map((suit) => id(suit, suit === 'clubs' ? 12 : 13)))
    mockLog.events = []
    mockLog.foundationsAtWinCascade = null

    await tapCard(id('clubs', 13))
    await flushUntil(() => mockLog.events.includes('cascade'))

    expect(mockLog.foundationsAtWinCascade).toEqual(SUITS.map((suit) => id(suit, 13))) // still every real card when the second cascade starts
    expect(mockLog.events).toEqual(['cascade'])
    await flushUntil(() => mockLog.events.includes('ghosts-shown'))
    expect(mockLog.events).toEqual(['cascade', 'ghosts-shown', ...SUITS.map((suit) => `blank-${suit}`)])
  })

  it('an undo out of the celebration brings every pile back', async () => {
    await mount(KING_IN_COLUMN(), 1)
    await tapCard(id('clubs', 13))
    await flush(settleAndHold)
    expect(SUITS.map(foundationTop)).toEqual(SUITS.map(() => 'empty'))

    await tap('undo')
    await flush(1000)

    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(foundationTop('clubs')).toBe(id('clubs', 12))
    expect(SUITS.filter((suit) => suit !== 'clubs').map(foundationTop)).toEqual(SUITS.filter((suit) => suit !== 'clubs').map((suit) => id(suit, 13)))
    expect(mockLog.hides).toBe(0)
  })
})

describe('Klondike screen - a card never moves without its own flight', () => {
  it('a flight whose destination card cannot be measured lands on the foundation pile itself, instead of the card appearing', async () => {
    await mount(KING_IN_COLUMN(), 1)
    jest.spyOn(mockRegistry, 'measure').mockImplementation(async () => null) // nothing is measurable per card

    await tapCard(id('clubs', 13))
    await flush(10)

    expect(mockLog.shown).toEqual([id('clubs', 13)])
    expect(mockLog.inAir).toBe(1) // it flew to the pile's container...
    expect(mockLog.hides).toBe(0) // ...it was not hidden
    await flush(FLIGHT_MS + HOLD_MS + 50)
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(screen.getByTestId('fireworks')).toBeTruthy()
  })

  it('a card drawn onto the waste that can no longer be measured (already covered by the next draw) still flies to the waste', async () => {
    await mount(board({ stock: [card('spades', 3, false), card('spades', 4, false)], foundation: foundations({}) }), 0)
    jest.spyOn(mockRegistry, 'measure').mockImplementation(async () => null)

    await tap('stock-pile')
    await flush(10)

    expect(mockLog.shown).toHaveLength(1)
    expect(mockLog.inAir).toBe(1)
    expect(mockLog.hides).toBe(0)
  })

  it('undoing a foundation move that auto-play has since buried (an old save that folded the auto-play into it) flies that card out of its pile', async () => {
    // A save written before every auto-play became its own undo step: the board after the tap on 5 of hearts and the
    // auto-play of 6 of hearts on top of it, with both recorded in ONE entry (the auto-play in `cascaded`).
    const hearts = SUITS.indexOf('hearts')
    const after = board({ tableau: [[], [], [card('diamonds', 1, false), card('diamonds', 2)]], foundation: foundations({ clubs: 13, spades: 13, hearts: 6 }) })
    const folded = { state: FIVE_THEN_SIX(), move: { primary: { from: { zone: 'tableau', index: 0 }, to: { zone: 'foundation', index: hearts }, count: 1, anchorCardId: id('hearts', 5) }, cascaded: [{ from: { zone: 'tableau', index: 1 }, to: { zone: 'foundation', index: hearts }, count: 1, anchorCardId: id('hearts', 6) }] } }
    await mount(after, 2, [folded], 1)
    expect(foundationTop('hearts')).toBe(id('hearts', 6)) // 5 of hearts is buried: not the top, so it is not a measurable card
    expect(mockRegistered.has(id('hearts', 5))).toBe(false)

    await tap('undo')
    await flush(2000)

    expect(mockLog.shown).toEqual([id('hearts', 5)]) // the undone card has a ghost of its own (the buried card, not whatever is on top)...
    expect(mockLog.dealt).toEqual([id('hearts', 6)]) // ...alongside the auto-played card returning, in the same Undo press
    expect(mockLog.hides).toBe(0)
    expect(pileIds(0)).toEqual([id('hearts', 5)])
    expect(pileIds(1)).toEqual([id('hearts', 6)])
    expect(foundationTop('hearts')).toBe(id('hearts', 4))
    expect(undoDisabled()).toBe('true')
  })
})

describe('Klondike screen - every auto-played step is its own undo step', () => {
  it('every auto-played card is its own undo step, taken back one at a time before the tap that set them off', async () => {
    await mount(FIVE_THEN_SIX(), 4)

    await tapCard(id('hearts', 5))
    await flush(2000) // the tap's flight, then auto-play sends 6 of hearts up on top of it
    expect(mockLog.shown).toEqual([id('hearts', 5), id('hearts', 6)])
    expect(foundationTop('hearts')).toBe(id('hearts', 6))
    expect(movesCount()).toBe('1') // the auto-play is not a move of the player's
    mockLog.shown = []

    await tap('undo') // takes back only the auto-played 6 of hearts...
    await flush(2000)
    expect(mockLog.shown).toEqual([id('hearts', 6)]) // ...which flies home on a ghost of its own (the ordinary undo flight)
    expect(mockLog.dealt).toEqual([])
    expect(pileIds(1)).toEqual([id('hearts', 6)])
    expect(pileIds(0)).toEqual([])
    expect(foundationTop('hearts')).toBe(id('hearts', 5)) // the tap's own card stays up, and auto-play does not send the 6 straight back
    expect(undoDisabled()).toBe('false')
    mockLog.shown = []

    await tap('undo') // then the tap itself
    await flush(2000)
    expect(mockLog.shown).toEqual([id('hearts', 5)])
    expect(pileIds(0)).toEqual([id('hearts', 5)])
    expect(pileIds(1)).toEqual([id('hearts', 6)])
    expect(foundationTop('hearts')).toBe(id('hearts', 4))
    expect(undoDisabled()).toBe('true')
    expect(mockLog.hides).toBe(0)
  })

  it("a card the sweep draws and sends straight up is two undo steps (back onto the waste, then back into the stock), each before the player's tap", async () => {
    await mount(KING_FROM_STOCK(), 1)

    await tapCard(id('clubs', 12))
    await flush(10000)
    expect(screen.getByTestId('chrome-won').props.children).toBe('true')
    expect(movesCount()).toBe('1') // neither the draw nor the play counts
    mockLog.shown = []

    await tap('undo') // the King drops from its foundation onto the waste
    await flush(2000)
    expect(screen.getByTestId('chrome-won').props.children).toBe('false')
    expect(mockLog.shown).toEqual([id('clubs', 13)])
    expect(foundationTop('clubs')).toBe(id('clubs', 12))
    expect(wasteTop()).toBe(id('clubs', 13)) // and stays there: auto-play does not send it back up
    mockLog.shown = []

    await tap('undo') // then the draw goes back into the stock
    await flush(2000)
    expect(mockLog.shown).toEqual([id('clubs', 13)])
    expect(wasteTop()).toBe('none')
    expect(foundationTop('clubs')).toBe(id('clubs', 12))
    mockLog.shown = []

    await tap('undo') // and only then the player's own tap
    await flush(2000)
    expect(mockLog.shown).toEqual([id('clubs', 12)])
    expect(pileIds(0)).toEqual([id('clubs', 12)])
    expect(foundationTop('clubs')).toBe(id('clubs', 11))
    expect(undoDisabled()).toBe('true')
    expect(mockLog.hides).toBe(0)
  })
})

describe('Klondike screen - a foundation pile keeps showing the card that has landed while later flights are still in the air', () => {
  /** The Ace of clubs is up, the 2 and the 3 each sit alone in a column (a diamond keeps the game unfinished). */
  const TWO_THEN_THREE = () => board({ tableau: [[card('clubs', 2)], [card('clubs', 3)], [card('diamonds', 5)]], foundation: foundations({ clubs: 1 }) })

  it('two quick taps: once the first card lands, the pile shows it under the second ghost instead of reverting to the card from before both', async () => {
    mockSettings.autoMove = false
    await mount(TWO_THEN_THREE(), 3)
    expect(underGhost('clubs')).toBe('none') // nothing is flying there

    await tapCard(id('clubs', 2))
    await flush(10)
    expect(mockLog.inAir).toBe(1)
    expect(underGhost('clubs')).toBe(id('clubs', 1)) // one card in the air: the pile still shows the Ace it had

    await tapCard(id('clubs', 3)) // a second flight sets off before the first has landed
    await flush(10)
    expect(mockLog.inAir).toBe(2)
    expect(foundationTop('clubs')).toBe(id('clubs', 3))
    expect(underGhost('clubs')).toBe(id('clubs', 1)) // both in the air: still the Ace

    await flushUntil(() => mockLog.inAir === 1) // the 2 lands, the 3 is still flying
    expect(underGhost('clubs')).toBe(id('clubs', 2)) // the pile now shows the 2 - not the Ace again

    await flushUntil(() => mockLog.inAir === 0)
    await flush(10)
    expect(underGhost('clubs')).toBe('none')
    expect(foundationTop('clubs')).toBe(id('clubs', 3))
  })

  it('a flight onto an empty foundation that is followed by another shows the bare slot, then the first card once it has landed', async () => {
    mockSettings.autoMove = false
    await mount(board({ tableau: [[card('clubs', 1)], [card('clubs', 2)], [card('diamonds', 5)]], foundation: foundations({}) }), 3)

    await tapCard(id('clubs', 1))
    await flush(10)
    await tapCard(id('clubs', 2))
    await flush(10)
    expect(mockLog.inAir).toBe(2)
    expect(underGhost('clubs')).toBe('empty') // nothing has landed yet

    await flushUntil(() => mockLog.inAir === 1)
    expect(underGhost('clubs')).toBe(id('clubs', 1)) // the Ace has landed and stays there under the 2's ghost
  })
})
