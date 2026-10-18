import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { useEffect } from 'react'

import { markGhostPending } from '@/components/cardFacePaint'
import { AUTO_PLAY_STAGGER_MS, finishGapMs } from '@/components/dragdrop/dragSpring'
import { DropZoneRegistry } from '@/components/dragdrop/DropZoneRegistry'
import { PileRef } from '@/engine/gameTypes'
import { Card, Suit, SUITS } from '@/engine/types'
import KlondikeScreen from '@/games/klondike/KlondikeScreen'
import * as klondikeRules from '@/games/klondike/rules'
import { KlondikeState } from '@/games/klondike/rules'
import { STOCK_QUEUE_GAP_MS } from '@/games/shared/stockWait'

import { resetGameInProgress, seedGameInProgress } from '../../../testUtils/gameInProgressStore'
import { peelableFlights } from '../../../testUtils/peelableFlights'

// ---------------------------------------------------------------------------------------------------------------------
// A screen-level test for Klondike's win flow and its "a card never moves without its own flight" rule: the REAL
// KlondikeScreen, real game rules, real useFlightConcurrency / useAutoFoundationCascade / useGameSession /
// useFoundationWinCheck / useWinReveal / gameInProgress store, seeded with a saved game through the test store (src/testUtils/gameInProgressStore.ts).
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

const mockSettings = { autoMove: true }
const mockRecordWon = jest.fn()
const mockPiles = new Map<number, { cards: Card[]; drag: { onDrop: (to: PileRef, count: number, anchorCardId: string, flight: unknown) => Promise<boolean> | boolean } }>()
let mockPileInstance = 0
/** Each foundation cell's onDrop as last rendered, by suit (undefined: its card can't be picked up). */
const mockFoundationDrops = new Map<string, ((x: number, y: number, flight: unknown, dragged: Card) => Promise<boolean> | boolean) | undefined>()

interface MockFlightLog {
  /** Every ghost.show() - one per card flight the screen started (tap, drop, cascade step, undo). */
  shown: string[]
  /** When each of those took off (fake time, index-aligned with `shown`). */
  shownAt: number[]
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
const mockLog: MockFlightLog = { shown: [], shownAt: [], dealt: [], inAir: 0, hides: 0, airAtWinCascade: -1, chainsAtWinCascade: -1, foundationsAtWinCascade: null, foundationsAtGhostsShown: null, events: [] }
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
/** An undo turning cards back mid-air (ghost.peel): the cards each flight still carries, and every peel. */
const mockPeel = peelableFlights(() => mockMakeFlight())
const mockGhost = {
  cardRegistry: mockRegistry,
  show: (spec: { cards: { id: string }[] }) => {
    mockLog.shown.push(spec.cards.map((c) => c.id).join('+'))
    mockLog.shownAt.push(Date.now())
    return mockPeel.track(
      spec.cards.map((c) => c.id),
      mockMakeFlight()
    )
  },
  canPeel: mockPeel.canPeel,
  peel: mockPeel.peel
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
/** How long a container measurement takes to come back (a real one is a native round trip) - 0 resolves at once. */
let mockMeasureViewMs = 0
jest.mock('@/components/dealing/measureView', () => ({
  measureView: async (view: { suit?: string } | null) => {
    if (mockMeasureViewMs > 0) await new Promise((resolve) => setTimeout(resolve, mockMeasureViewMs))
    return view?.suit && mockUnmeasurableSlots.has(view.suit) ? null : { x: 5, y: 5 }
  }
}))
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
  function MockFoundationCell({ card, suit, isFlyingHere, settledCard, slotRef, onDrop }: { card?: { id: string }; suit: string; isFlyingHere: boolean; settledCard?: { id: string } | null; slotRef?: (el: { suit: string } | null) => void; onDrop?: (x: number, y: number, flight: unknown, dragged: Card) => Promise<boolean> | boolean }) {
    mockFoundationDrops.set(suit, onDrop)
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
  const { useFrozenWhileHidden } = jest.requireActual('@/components/useFrozenWhileHidden')
  function MockWasteTop({ card, onPress }: { card: { id: string }; onPress: (measure: () => Promise<{ x: number; y: number }>) => void }) {
    return (
      <MockPressable testID='waste-top' onPress={() => onPress(async () => ({ x: 10, y: 10 }))}>
        <MockRegister cardId={card.id} />
        <MockText testID='top-of-waste'>{card.id}</MockText>
      </MockPressable>
    )
  }
  // Also reports what the real waste paints under incoming ghost(s) - the caller's settledWasteTop, or else the frozen copy of
  // its pre-flight top, while wasteHiddenCount > 0 ('empty' for the bare slot), 'none' when nothing lands there - and whether
  // the stock is frozen. 'stock-repeat' is a held stock's repeat draw (StockWaste's useStockHold).
  function MockStockWaste(props: { wasteTop?: { id: string }; wasteHiddenCount?: number; settledWasteTop?: { id: string } | null; stockHidden?: boolean; onDrawStock: (opts?: { repeat?: boolean }) => unknown; onWastePress: (measure: () => Promise<{ x: number; y: number }>) => void }) {
    const landing = (props.wasteHiddenCount ?? 0) > 0
    const frozenTop = useFrozenWhileHidden(props.wasteTop, landing)
    const underTop = props.settledWasteTop === undefined ? frozenTop : props.settledWasteTop
    return (
      <MockView>
        <MockPressable testID='stock-pile' onPress={() => props.onDrawStock()} />
        <MockPressable testID='stock-repeat' onPress={() => props.onDrawStock({ repeat: true })} />
        {props.wasteTop ? <MockWasteTop card={props.wasteTop} onPress={props.onWastePress} /> : null}
        <MockText testID='under-waste'>{landing ? (underTop ? underTop.id : 'empty') : 'none'}</MockText>
        <MockText testID='stock-hidden'>{String(!!props.stockHidden)}</MockText>
      </MockView>
    )
  }
  return { StockWaste: MockStockWaste }
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
const mockHintGlides: string[][] = []
jest.mock('@/games/shared/useHintGlide', () => ({
  useHintGlide: () => async (target: { moving: { id: string }[] }) => {
    mockHintGlides.push(target.moving.map((c) => c.id))
  }
}))
jest.mock('@/components/GameChrome', () => {
  const { Pressable: MockPressable, Text: MockText, View: MockView } = require('react-native')
  return {
    GAME_CONTENT_PADDING: 6,
    GameChrome: ({ children, onUndo, onNewGame, onHint, won, movesCount, undoDisabled }: { children: unknown; onUndo: () => void; onNewGame: () => void; onHint: (request?: { auto?: boolean }) => void; won: boolean; movesCount: number; undoDisabled: boolean }) => (
      <MockView>
        <MockPressable testID='undo' onPress={onUndo} />
        <MockPressable testID='new-game' onPress={onNewGame} />
        <MockPressable testID='hint' onPress={() => onHint()} />
        <MockPressable testID='auto-hint' onPress={() => onHint({ auto: true })} />
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
async function mount(state: KlondikeState, expectedCards: number, undoStack: unknown[] = [], moves = 0, draw: 1 | 3 = 1) {
  seedGameInProgress('klondike', { state, undoStack, moves, elapsedSeconds: 0, config: draw })
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

/** Drags `dragged` off its foundation and drops it on tableau column `column` (the hit test's answer). */
async function dropFromFoundation(suit: Suit, dragged: Card, column: number) {
  jest.spyOn(DropZoneRegistry.prototype, 'hitTest').mockResolvedValue({ zone: 'tableau', index: column })
  const onDrop = mockFoundationDrops.get(suit)
  expect(onDrop).toBeDefined()
  let applied: boolean = false
  await act(async () => {
    applied = await onDrop!(0, 0, mockMakeFlight(), dragged)
  })
  return applied
}

/** Drags the card `cardId` (with whatever sits on it) out of its column and drops it on `to` - PileView has already hit-tested by then. */
async function dragFromColumn(cardId: string, to: PileRef) {
  const pile = [...mockPiles.values()].find((p) => p.cards.some((c) => c.id === cardId))!
  const count = pile.cards.length - pile.cards.findIndex((c) => c.id === cardId)
  let applied: boolean = false
  await act(async () => {
    applied = await pile.drag.onDrop(to, count, cardId, mockMakeFlight())
  })
  return applied
}

beforeEach(() => {
  jest.useFakeTimers()
  mockPeel.reset()
  mockSettings.autoMove = true
  mockFlight.ms = FLIGHT_MS
  mockMeasureViewMs = 0
  mockPiles.clear()
  mockPileInstance = 0
  mockFoundationDrops.clear()
  mockRegistered.clear()
  mockLog.shown = []
  mockLog.shownAt = []
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
  mockHintGlides.length = 0
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
    expect(movesCount()).toBe('2') // the tap and the auto-play: every move counts
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
    expect(movesCount()).toBe('3') // the tap, then the sweep's draw and its play
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

describe("Klondike screen - auto-play only ever follows the player's own play of a card to a foundation", () => {
  it('a drawn ace stays on the waste for the player to find and play', async () => {
    await mount(board({ tableau: [[card('diamonds', 2, false), card('hearts', 9)]], stock: [card('spades', 7, false), card('clubs', 1, false)], foundation: foundations({}) }), 2)

    await tap('stock-pile')
    await flush(2000)

    expect(mockLog.shown).toEqual([id('clubs', 1)]) // the draw's own flight, and nothing after it
    expect(wasteTop()).toBe(id('clubs', 1))
    expect(foundationTop('clubs')).toBe('empty')
  })

  it("a draw stops a cascade still running from the player's last play, so it cannot take the card just drawn", async () => {
    // Tapping 5 of hearts arms auto-play (6 of hearts would follow); the stock holds the Ace of diamonds.
    await mount(board({ tableau: [[card('hearts', 5)], [card('hearts', 6)], [card('diamonds', 3, false), card('diamonds', 2)]], stock: [card('diamonds', 1, false)], foundation: foundations({ clubs: 13, spades: 13, hearts: 4 }) }), 4)

    await tapCard(id('hearts', 5))
    await tap('stock-pile') // before the cascade's first card leaves
    await flush(2000)

    expect(mockLog.shown).toEqual([id('hearts', 5), id('diamonds', 1)]) // the tap and the draw - no auto-played card
    expect(foundationTop('hearts')).toBe(id('hearts', 5))
    expect(pileIds(1)).toEqual([id('hearts', 6)])
    expect(wasteTop()).toBe(id('diamonds', 1))
    expect(foundationTop('diamonds')).toBe('empty')
  })

  it('an ace a column move flips up stays there for the player to find and play', async () => {
    await mount(board({ tableau: [[card('clubs', 1, false), card('hearts', 9)], [card('spades', 10)]], foundation: foundations({}) }), 3)

    await tapCard(id('hearts', 9)) // onto the 10 of spades: the face-down Ace of clubs turns over
    await flush(2000)

    expect(mockLog.shown).toEqual([id('hearts', 9)]) // the move's own flight, and nothing after it
    expect(pileIds(0)).toEqual([id('clubs', 1)])
    expect(foundationTop('clubs')).toBe('empty')
  })

  it('an ace a move from the waste uncovers on the waste stays there too', async () => {
    await mount(board({ tableau: [[card('spades', 10)]], waste: [card('diamonds', 1), card('hearts', 9)], foundation: foundations({}) }), 2)

    await tap('waste-top') // the 9 of hearts onto the 10 of spades: the Ace of diamonds is the waste's top now
    await flush(2000)

    expect(mockLog.shown).toEqual([id('hearts', 9)])
    expect(wasteTop()).toBe(id('diamonds', 1))
    expect(foundationTop('diamonds')).toBe('empty')
  })

  it("a column move stops a cascade still running from the player's last play, so it cannot take the ace that move flips up", async () => {
    // Tapping 5 of hearts arms auto-play (6 of hearts would follow); moving the 9 of spades onto the 10 of diamonds turns the
    // face-down Ace of diamonds over.
    await mount(board({ tableau: [[card('hearts', 5)], [card('hearts', 6)], [card('diamonds', 1, false), card('spades', 9)], [card('diamonds', 10)]], foundation: foundations({ clubs: 13, spades: 7, hearts: 4 }) }), 5)

    await tapCard(id('hearts', 5))
    await tapCard(id('spades', 9)) // before the cascade's first card leaves
    await flush(2000)

    expect(mockLog.shown).toEqual([id('hearts', 5), id('spades', 9)]) // the two moves - no auto-played card
    expect(foundationTop('hearts')).toBe(id('hearts', 5))
    expect(pileIds(1)).toEqual([id('hearts', 6)])
    expect(pileIds(2)).toEqual([id('diamonds', 1)])
    expect(foundationTop('diamonds')).toBe('empty')
  })

  it('an auto-played card still being measured when the player taps the stock does not go up after the draw', async () => {
    // Real measurements are native round trips: the cascade's next card is still being measured when the stock tap lands, and
    // the draw's own measurement comes back after that.
    jest.spyOn(mockRegistry, 'measure').mockImplementation(async (cardId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return mockRegistered.has(cardId) ? { x: 10, y: 10, width: 40, height: 56 } : null
    })
    await mount(board({ tableau: [[card('hearts', 5)], [card('hearts', 6)], [card('diamonds', 1, false), card('diamonds', 2)]], stock: [card('diamonds', 7, false)], foundation: foundations({ clubs: 13, spades: 13, hearts: 4 }) }), 4)

    await tapCard(id('hearts', 5)) // arms auto-play: the 6 of hearts follows one gap later...
    await flush(AUTO_PLAY_STAGGER_MS + STEP_MS) // ...and is being measured now
    mockMeasureViewMs = 40
    await tap('stock-pile')
    await flush(2000)

    expect(mockLog.shown).toEqual([id('hearts', 5), id('diamonds', 7)]) // the tap and the draw - the 6 never left
    expect(pileIds(1)).toEqual([id('hearts', 6)])
    expect(foundationTop('hearts')).toBe(id('hearts', 5))
    expect(wasteTop()).toBe(id('diamonds', 7))
  })

  it('a New Game while a cascade is still running does not carry it on into the new deal', async () => {
    const newController = klondikeRules.createKlondikeController
    // The new deal has a face-up Ace on top of a column: the old cascade would have sent it straight up.
    jest.spyOn(klondikeRules, 'createKlondikeController').mockImplementation((draw) => ({ ...newController(draw), newGame: () => board({ tableau: [[card('spades', 9, false), card('clubs', 1)], [card('hearts', 8)]], stock: [card('diamonds', 4, false)], foundation: foundations({}) }) }))
    await mount(FIVE_THEN_SIX(), 4)

    await tapCard(id('hearts', 5)) // arms auto-play: the 6 of hearts would follow
    await tap('new-game') // before it leaves
    await flush(2000)

    expect(mockLog.shown).toEqual([id('hearts', 5)]) // the tap's own flight, and nothing after it
    expect(foundationTop('clubs')).toBe('empty')
    expect(screen.getByTestId(`card-${id('clubs', 1)}`)).toBeTruthy()
  })
})

describe('Klondike screen - a card never moves in place of the one the player picked', () => {
  it('a drop for a card that has since left is refused, instead of moving whatever now sits in its place', async () => {
    await mount(board({ tableau: [[card('clubs', 1, false), card('hearts', 9)], [card('spades', 10)]], foundation: foundations({}) }), 3)
    const nine = id('hearts', 9)
    // The drag of the 9 of hearts, picked up while it was still on top of the face-down Ace of clubs...
    const staleDrag = [...mockPiles.values()].find((p) => p.cards.some((c) => c.id === nine))!.drag
    // ...but the 9 has moved on before the drop arrives (an auto-play, say - here a tap sends it onto the 10 of spades).
    await tapCard(nine)
    await flush(200)
    const shownBefore = mockLog.shown.length

    let applied: boolean = true
    await act(async () => {
      applied = await staleDrag.onDrop({ zone: 'foundation', index: SUITS.indexOf('clubs') }, 1, nine, { release: () => {}, flyTo: () => {}, hide: () => {} })
    })
    await flush(200)

    expect(applied).toBe(false) // the Ace of clubs, on top of that column now, did NOT go up under a ghost of the 9
    expect(foundationTop('clubs')).toBe('empty')
    expect(mockLog.shown).toHaveLength(shownBefore)
  })
})

describe('Klondike screen - recycling the waste', () => {
  const underWaste = () => screen.getByTestId('under-waste').props.children as string
  const stockHidden = () => screen.getByTestId('stock-hidden').props.children as string

  it('empties the waste as its cards fly back to the stock - the card on top is not left behind on the waste as well', async () => {
    await mount(board({ tableau: [[card('diamonds', 2, false), card('hearts', 9)]], waste: [card('spades', 7), card('clubs', 4)], foundation: foundations({}) }), 3)

    await tap('stock-pile')
    await flush()

    expect(mockLog.shown).toEqual([`${id('spades', 7)}+${id('clubs', 4)}`]) // the whole waste flies, its top card showing
    expect(wasteTop()).toBe('none')
    expect(underWaste()).toBe('none') // nothing lands on the waste: no frozen copy of the 4 of clubs drawn there under the flight
    expect(stockHidden()).toBe('true') // the stock is where it lands: it keeps its empty look until then

    await flush(FLIGHT_MS + STEP_MS)
    expect(stockHidden()).toBe('false')
    expect(wasteTop()).toBe('none')
  })

  it('undoing it empties the stock as the cards take off, flying them face down onto the waste - no back is left on the stock meanwhile', async () => {
    await mount(board({ tableau: [[card('diamonds', 2, false), card('hearts', 9)]], waste: [card('spades', 7), card('clubs', 4)], foundation: foundations({}) }), 3)
    await tap('stock-pile')
    await flush(FLIGHT_MS + STEP_MS)
    const show = jest.spyOn(mockGhost, 'show')

    await tap('undo')
    await flush()

    expect(show).toHaveBeenCalledTimes(1)
    // One back for the whole pile, carrying the id of the card that ends on top of the waste (the landed ghost waits for its face).
    expect(show.mock.calls[0][0].cards).toEqual([{ ...card('clubs', 4), faceUp: false }])
    expect(stockHidden()).toBe('false') // the stock is where the cards LEAVE: not frozen on a back while they are in the air
    expect(underWaste()).toBe('empty') // the waste is where they land: its empty slot until then
    expect(wasteTop()).toBe(id('clubs', 4))

    await flush(FLIGHT_MS + STEP_MS)
    expect(underWaste()).toBe('none')
    expect(wasteTop()).toBe(id('clubs', 4))
  })
})

// Jay's kids speed through the stock (2026-10-16): every tap is one draw, and the flip-over neither drops taps nor draws a card twice.
describe('Klondike screen - speeding through the stock', () => {
  const underWaste = () => screen.getByTestId('under-waste').props.children as string
  const stockHidden = () => screen.getByTestId('stock-hidden').props.children as string
  const TWO_CARD_WASTE = () => board({ tableau: [[card('diamonds', 2, false), card('hearts', 9)]], waste: [card('spades', 7), card('clubs', 4)], foundation: foundations({}) })

  it('a tap while a turned-over waste is still flying into the stock waits for it to land, then draws - no card comes out of a stock that still looks empty, and no tap is dropped', async () => {
    await mount(TWO_CARD_WASTE(), 3)

    await tap('stock-pile') // turns the waste over
    const turnedOverAt = mockLog.shownAt[0]
    await tap('stock-pile') // while those cards are in the air
    await flush(FLIGHT_MS / 2)
    expect(mockLog.shown).toHaveLength(1)
    expect(stockHidden()).toBe('true')

    await flush(FLIGHT_MS)
    expect(mockLog.shown).toHaveLength(2)
    expect(mockLog.shownAt[1] - turnedOverAt).toBeGreaterThanOrEqual(FLIGHT_MS) // it went once they had landed
    expect(stockHidden()).toBe('false')
    expect(wasteTop()).toBe(mockLog.shown[1])
    expect(movesCount()).toBe('2')
  })

  it('taps made while the turned-over cards fly back go one after another once they land, an auto-play stagger apart - not all at once as one card', async () => {
    await mount(TWO_CARD_WASTE(), 3)

    await tap('stock-pile') // turns the waste over
    await tap('stock-pile')
    await tap('stock-pile') // both wait for it to land
    await flush(FLIGHT_MS + STOCK_QUEUE_GAP_MS + 4 * STEP_MS)

    expect(mockLog.shown).toHaveLength(3)
    expect(mockLog.shownAt[1] - mockLog.shownAt[0]).toBeGreaterThanOrEqual(FLIGHT_MS)
    expect(mockLog.shownAt[2] - mockLog.shownAt[1]).toBeGreaterThanOrEqual(STOCK_QUEUE_GAP_MS)
    expect(mockLog.shown[1]).not.toBe(mockLog.shown[2])
    expect(movesCount()).toBe('3')
  })

  it('turning the waste over while the last card drawn is still flying to it turns that card back in mid-air, and the waste keeps its top card until the ghost of the rest shows', async () => {
    await mount(board({ tableau: [[card('diamonds', 2, false), card('hearts', 9)]], stock: [card('spades', 4, false)], waste: [card('clubs', 2)], foundation: foundations({}) }), 3)
    // Like the real layer: a new ghost's top face is taking off until it has painted (a frame or two).
    const realShow = mockGhost.show
    jest.spyOn(mockGhost, 'show').mockImplementation((spec) => {
      const flight = realShow(spec)
      const release = markGhostPending([spec.cards[spec.cards.length - 1].id])
      setTimeout(release, STEP_MS)
      return flight
    })

    await tap('stock-pile') // draws the 4, which flies to the waste
    await flush(STEP_MS)
    await tap('stock-pile') // turns the waste over while it is still in the air
    await flush()

    expect(mockLog.shown).toEqual([id('spades', 4), id('clubs', 2)]) // only the card that had landed takes off from the waste
    expect(mockPeel.peeled).toEqual([id('spades', 4)]) // the 4 turns back from where it is
    expect(wasteTop()).toBe('none')
    expect(underWaste()).toBe(id('clubs', 2)) // the 2 is still drawn there until its ghost shows
    expect(stockHidden()).toBe('true')

    await flush(STEP_MS)
    expect(underWaste()).toBe('none')
    await flush(FLIGHT_MS + STEP_MS)
    expect(stockHidden()).toBe('false')
    expect(movesCount()).toBe('2')

    // Both are back in the stock: the next two taps draw them.
    await tap('stock-pile')
    await flush(STEP_MS)
    await tap('stock-pile')
    await flush(FLIGHT_MS + STEP_MS)
    expect(mockLog.shown.slice(2).sort()).toEqual([id('clubs', 2), id('spades', 4)].sort())
  })

  it('quick taps overlap their flights, and once a card lands the waste shows it under the ones still in the air - not the card from before them all', async () => {
    await mount(board({ tableau: [[card('diamonds', 2, false), card('hearts', 9)]], stock: [card('spades', 3, false), card('spades', 4, false), card('spades', 5, false)], waste: [card('clubs', 2)], foundation: foundations({}) }), 3)

    await tap('stock-pile')
    await flush(20)
    await tap('stock-pile')
    await flush(20)
    await tap('stock-pile')
    expect(mockLog.shown).toHaveLength(3) // all three in the air at once
    expect(underWaste()).toBe(id('clubs', 2))

    await flush(FLIGHT_MS - 40 + STEP_MS) // the first has landed, the other two are still flying
    expect(underWaste()).toBe(mockLog.shown[0])
    await flush(20)
    expect(underWaste()).toBe(mockLog.shown[1])
    await flush(40)
    expect(underWaste()).toBe('none')
    expect(wasteTop()).toBe(mockLog.shown[2])
    expect(movesCount()).toBe('3')
  })

  it('draw 3: a tap while the last fan is still landing waits for it - the deal layer flies one fan at a time, and a second start cancelled the first for good', async () => {
    const stock = [3, 4, 5, 6, 7, 8].map((rank) => card('spades', rank, false))
    await mount(board({ tableau: [[card('diamonds', 2, false), card('hearts', 9)]], stock, foundation: foundations({}) }), 2, [], 0, 3)

    await tap('stock-pile')
    await tap('stock-pile')
    await flush()
    expect(mockLog.dealt).toHaveLength(3)
    expect(underWaste()).toBe('empty')

    await flush(FLIGHT_MS + 2 * STEP_MS)
    expect(mockLog.dealt).toHaveLength(6) // the second fan, once the first had landed
    await flush(FLIGHT_MS + 2 * STEP_MS)
    expect(underWaste()).toBe('none')
    expect(movesCount()).toBe('2')
  })

  it("a held stock's repeat draws, but never turns the waste over: the hold stops where the stock runs out", async () => {
    await mount(board({ tableau: [[card('diamonds', 2, false), card('hearts', 9)]], stock: [card('spades', 3, false)], waste: [card('clubs', 4)], foundation: foundations({}) }), 3)

    await tap('stock-repeat')
    await flush(FLIGHT_MS + STEP_MS)
    expect(mockLog.shown).toEqual([id('spades', 3)])

    await tap('stock-repeat') // at the empty stock
    await flush(FLIGHT_MS + STEP_MS)
    expect(mockLog.shown).toHaveLength(1)
    expect(movesCount()).toBe('1')

    await tap('stock-pile') // a tap turns it over
    await flush()
    expect(mockLog.shown).toHaveLength(2)
    expect(movesCount()).toBe('2')
  })
})

describe("Klondike screen - the player's draw is worked out from the board as it is once its measurement is back", () => {
  // A draw-1 measures the stock (and the waste) before it commits, a native round trip; MEASURE_MS stands in for it. Anything
  // committed in that window - a second stock tap, a tap-to-move - must be built on, never overwritten.
  const MEASURE_MS = 40

  it('two stock taps inside one measurement draw two different cards, each its own move and its own undo step', async () => {
    await mount(board({ tableau: [[card('diamonds', 2, false), card('hearts', 9)]], stock: [card('spades', 3, false), card('spades', 4, false)], foundation: foundations({}) }), 2)
    mockMeasureViewMs = MEASURE_MS

    await tap('stock-pile')
    await tap('stock-pile') // the first draw is still measuring
    await flush(MEASURE_MS + FLIGHT_MS + 50)

    expect(mockLog.shown).toEqual([id('spades', 4), id('spades', 3)]) // the top card, then the one under it - not the top card twice
    expect(wasteTop()).toBe(id('spades', 3))
    expect(movesCount()).toBe('2')

    // Each undo entry holds the board right before ITS draw: one Undo takes back exactly one card.
    mockMeasureViewMs = 0
    await tap('undo')
    await flush(FLIGHT_MS + 50)
    expect(wasteTop()).toBe(id('spades', 4))
    await tap('undo')
    await flush(FLIGHT_MS + 50)
    expect(wasteTop()).toBe('none')
    expect(undoDisabled()).toBe('true')
  })

  it('a tap-to-move committed while a draw is measuring is not undone by the draw', async () => {
    await mount(board({ tableau: [[card('spades', 10)], [card('diamonds', 2, false), card('hearts', 9)]], stock: [card('clubs', 4, false)], foundation: foundations({}) }), 3)
    mockMeasureViewMs = MEASURE_MS

    await tap('stock-pile')
    await tapCard(id('hearts', 9)) // onto the 10 of spades - it commits at once, while the draw is still measuring
    expect(pileIds(0)).toEqual([id('spades', 10), id('hearts', 9)])
    await flush(MEASURE_MS + FLIGHT_MS + 50)

    expect(pileIds(0)).toEqual([id('spades', 10), id('hearts', 9)]) // still where its ghost flew - the draw built on the move
    expect(pileIds(1)).toEqual([id('diamonds', 2)])
    expect(wasteTop()).toBe(id('clubs', 4))
    expect(mockLog.shown).toEqual([id('hearts', 9), id('clubs', 4)])
    expect(movesCount()).toBe('2')
  })

  it('a second tap made while the first draws the last stock card recycles the waste instead of drawing that card again', async () => {
    await mount(board({ tableau: [[card('diamonds', 2, false), card('hearts', 9)]], stock: [card('spades', 4, false)], waste: [card('clubs', 2)], foundation: foundations({}) }), 3)
    mockMeasureViewMs = MEASURE_MS

    await tap('stock-pile')
    await tap('stock-pile') // tapped on a board with one stock card left - but by the time it commits, the stock is empty
    await flush(MEASURE_MS + FLIGHT_MS + 50)

    // The draw, then the waste back: the card that had landed in a ghost of its own, and the card just drawn - still flying in to
    // the waste - turned back to the stock in mid-air (see 'speeding through the stock' below).
    expect(mockLog.shown).toEqual([id('spades', 4), id('clubs', 2)])
    expect(mockPeel.peeled).toEqual([id('spades', 4)])
    expect(wasteTop()).toBe('none')
    expect(movesCount()).toBe('2')
  })

  it('a New Game while a draw is measuring drops the draw instead of committing the old board over the new deal', async () => {
    const newController = klondikeRules.createKlondikeController
    jest.spyOn(klondikeRules, 'createKlondikeController').mockImplementation((draw) => ({ ...newController(draw), newGame: () => board({ tableau: [[card('hearts', 8)]], stock: [card('diamonds', 4, false)], foundation: foundations({}) }) }))
    await mount(board({ tableau: [[card('diamonds', 2, false), card('hearts', 9)]], stock: [card('spades', 4, false)], foundation: foundations({}) }), 2)
    mockMeasureViewMs = MEASURE_MS

    await tap('stock-pile')
    await tap('new-game') // before the draw's measurement is back
    await flush(MEASURE_MS + FLIGHT_MS + 50)

    expect(mockLog.shown).toEqual([]) // the old deal's card never flew
    expect(wasteTop()).toBe('none')
    expect(pileIds(0)).toEqual([id('hearts', 8)])
    expect(movesCount()).toBe('0')
  })
})

describe('Klondike screen - a foundation card back down to the tableau', () => {
  it('flies onto the column and counts as a move, and one Undo flies it back up', async () => {
    await mount(board({ tableau: [[card('diamonds', 2, false), card('hearts', 9)], [card('diamonds', 3)]], foundation: foundations({ clubs: 2 }) }), 3)

    expect(await dropFromFoundation('clubs', card('clubs', 2), 1)).toBe(true)
    await flush(200)
    expect(foundationTop('clubs')).toBe(id('clubs', 1))
    expect(pileIds(1)).toEqual([id('diamonds', 3), id('clubs', 2)])
    expect(movesCount()).toBe('1')
    expect(mockLog.hides).toBe(0) // the drag's ghost flew to the column - the card never just appeared there

    await tap('undo')
    await flush(200)
    expect(foundationTop('clubs')).toBe(id('clubs', 2))
    expect(pileIds(1)).toEqual([id('diamonds', 3)])
    expect(mockLog.shown).toEqual([id('clubs', 2)]) // the undo's own flight, back up
    expect(mockLog.hides).toBe(0)
  })

  it('is refused (it snaps back) on a column it cannot go on', async () => {
    await mount(board({ tableau: [[card('diamonds', 2, false), card('hearts', 9)], [card('spades', 3)]], foundation: foundations({ clubs: 2 }) }), 3)

    expect(await dropFromFoundation('clubs', card('clubs', 2), 1)).toBe(false)
    await flush(200)
    expect(foundationTop('clubs')).toBe(id('clubs', 2))
    expect(movesCount()).toBe('0')
  })

  it("stops an auto-play still running from the player's last play, like any column move", async () => {
    // Tapping 5 of hearts arms auto-play (the 6 of hearts would follow); the 7 of spades comes down onto the 8 of diamonds
    // before the cascade's first card leaves.
    await mount(board({ tableau: [[card('hearts', 5)], [card('hearts', 6)], [card('diamonds', 8)], [card('diamonds', 1, false), card('diamonds', 2)]], foundation: foundations({ clubs: 13, spades: 7, hearts: 4 }) }), 5)

    await tapCard(id('hearts', 5))
    expect(await dropFromFoundation('spades', card('spades', 7), 2)).toBe(true)
    await flush(2000)

    expect(pileIds(2)).toEqual([id('diamonds', 8), id('spades', 7)])
    expect(foundationTop('spades')).toBe(id('spades', 6))
    expect(pileIds(1)).toEqual([id('hearts', 6)]) // the cascade stopped: nothing went up after the drop
    expect(mockLog.shown).toEqual([id('hearts', 5)])
  })

  it('offers no drag once the deal is won', async () => {
    await mount(KING_IN_COLUMN(), 1)
    expect(mockFoundationDrops.get('diamonds')).toBeDefined()

    await tapCard(id('clubs', 13))
    await flush(200)
    expect(screen.getByTestId('chrome-won').props.children).toBe('true')
    SUITS.forEach((suit) => expect(mockFoundationDrops.get(suit)).toBeUndefined())
  })
})

describe("Klondike screen - once the board is solved, any move of the player's finishes the rest, at a pace that ramps up", () => {
  /** Every card is home but the Jack, Queen and King of clubs and the other three Kings. Clubs only go up to 10, so the Queen of clubs (on the
   * face-down Jack) has no foundation move: moving it onto a red King turns the Jack over, and then nothing is hidden. */
  const SOLVED_BY_COLUMN_MOVE = () => board({ tableau: [[card('clubs', 11, false), card('clubs', 12)], [card('diamonds', 13)], [card('hearts', 13)], [card('clubs', 13)], [card('spades', 13)]], foundation: foundations({ clubs: 10, diamonds: 12, hearts: 12, spades: 12 }) })
  /** The same cards with the Queen of clubs on the waste instead: moving it onto a red King empties the waste. */
  const SOLVED_BY_WASTE_MOVE = () => board({ tableau: [[card('clubs', 11)], [card('diamonds', 13)], [card('hearts', 13)], [card('clubs', 13)], [card('spades', 13)]], waste: [card('clubs', 12)], foundation: foundations({ clubs: 10, diamonds: 12, hearts: 12, spades: 12 }) })
  /** Already solved: nothing face-down, the stock and waste empty, every card able to go up. */
  const SOLVED = () => board({ tableau: [[card('clubs', 11)], [card('diamonds', 13), card('clubs', 12)], [card('hearts', 13)], [card('clubs', 13)], [card('spades', 13)]], foundation: foundations({ clubs: 10, diamonds: 12, hearts: 12, spades: 12 }) })
  /** Tapping the Jack of hearts up arms the cascade, whose first card (the Queen) turns the face-down King of hearts over: then the board is solved. */
  const SOLVED_BY_CASCADE = () => board({ tableau: [[card('hearts', 11)], [card('hearts', 13, false), card('hearts', 12)], [card('clubs', 13)], [card('diamonds', 13)], [card('spades', 13)]], foundation: foundations({ clubs: 12, diamonds: 12, hearts: 10, spades: 12 }) })
  const REMAINING = [id('clubs', 11), id('clubs', 12), id('clubs', 13), id('diamonds', 13), id('hearts', 13), id('spades', 13)]
  const column = (index: number): PileRef => ({ zone: 'tableau', index })
  const won = () => screen.getByTestId('chrome-won').props.children as string
  /** The gaps between consecutive take-offs from `from` on (the player's own flight included, when it is `from - 1`). */
  const gapsFrom = (from: number) => mockLog.shownAt.slice(from).map((t, i) => t - mockLog.shownAt[from + i - 1])
  /** The finish's gaps ramp up: the i-th its finishGapMs(i) (to within one STEP_MS, the harness's resolution), from the cascade's gap
   * toward half that. */
  function expectFinishPace(gaps: number[]) {
    expect(finishGapMs(0)).toBe(AUTO_PLAY_STAGGER_MS)
    gaps.forEach((gap, i) => {
      expect(gap).toBeGreaterThanOrEqual(finishGapMs(i) - STEP_MS)
      expect(gap).toBeLessThan(finishGapMs(i) + 2 * STEP_MS)
    })
  }

  it('a column move that turns the last face-down card over starts it at once: every card left flies exactly once, at the ramping pace, and the game is won', async () => {
    await mount(SOLVED_BY_COLUMN_MOVE(), 6)

    await tapCard(id('clubs', 12)) // no foundation move for it: onto the King of diamonds, and the Jack of clubs turns over
    await flush(3000)

    expect(mockLog.shown[0]).toBe(id('clubs', 12)) // the player's own move...
    const finish = mockLog.shown.slice(1) // ...then the finish, with nothing else in between
    expect(finish).toHaveLength(REMAINING.length)
    expect([...finish].sort()).toEqual([...REMAINING].sort())
    expectFinishPace(gapsFrom(1)) // the first a gap after the player's move, every other one its gap after the card before it
    expect(won()).toBe('true')
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(cardsOnBoard()).toBe(0)
    expect(movesCount()).toBe('7') // the player's move and each finished card
    expect(mockLog.hides).toBe(0)
  })

  it('a drag to a column that leaves the board solved starts it too', async () => {
    await mount(SOLVED_BY_COLUMN_MOVE(), 6)

    expect(await dragFromColumn(id('clubs', 12), column(2))).toBe(true) // onto the King of hearts this time
    await flush(3000)

    expect([...mockLog.shown].sort()).toEqual([...REMAINING].sort()) // every card once (the drag's own flight is not a show())
    expectFinishPace(gapsFrom(1))
    expect(won()).toBe('true')
  })

  it('a move off the waste that empties it starts it too', async () => {
    await mount(SOLVED_BY_WASTE_MOVE(), 6)

    await tap('waste-top') // the Queen of clubs onto the King of diamonds: the waste is empty now
    await flush(3000)

    expect(mockLog.shown[0]).toBe(id('clubs', 12))
    expect([...mockLog.shown.slice(1)].sort()).toEqual([...REMAINING].sort())
    expectFinishPace(gapsFrom(1))
    expect(won()).toBe('true')
    expect(wasteTop()).toBe('none')
  })

  it("a foundation play on a solved board finishes it at the finish's pace, the cascade stepping aside - no card goes twice, no two at once", async () => {
    await mount(SOLVED(), 6)

    await tapCard(id('clubs', 11)) // to its foundation: this arms the cascade too
    await flush(3000)

    expect(mockLog.shown[0]).toBe(id('clubs', 11))
    expect(mockLog.shown).toHaveLength(REMAINING.length) // the tap, then the five cards left - nothing flown twice
    expect([...mockLog.shown].sort()).toEqual([...REMAINING].sort())
    expectFinishPace(gapsFrom(1)) // the cascade sending its own cards alongside would put two take-offs together
    expect(won()).toBe('true')
    expect(mockLog.hides).toBe(0)
  })

  it('the cascade a foundation play set off hands over to the finish the moment it makes the board solved', async () => {
    await mount(SOLVED_BY_CASCADE(), 6)

    await tapCard(id('hearts', 11)) // to its foundation: the cascade sends the Queen of hearts, which turns the King over
    await flush(3000)

    expect(mockLog.shown.slice(0, 3)).toEqual([id('hearts', 11), id('hearts', 12), id('hearts', 13)])
    expect(mockLog.shown).toHaveLength(6)
    expect([...mockLog.shown].sort()).toEqual([id('clubs', 13), id('diamonds', 13), id('hearts', 11), id('hearts', 12), id('hearts', 13), id('spades', 13)])
    expect(mockLog.shownAt[1] - mockLog.shownAt[0]).toBeGreaterThanOrEqual(AUTO_PLAY_STAGGER_MS - STEP_MS) // the cascade's card, at the cascade's pace...
    expectFinishPace(gapsFrom(2)) // ...then the finish's, at its own
    expect(won()).toBe('true')
  })

  it.each([
    ['a face-down card', () => board({ tableau: [[card('clubs', 13, false), card('clubs', 12)], [card('diamonds', 13)], [card('hearts', 13)], [card('spades', 13)]], foundation: foundations({ clubs: 11, diamonds: 12, hearts: 12, spades: 12 }) }), 5, id('diamonds', 13)],
    ['a card in the stock', () => board({ tableau: [[card('clubs', 13)], [card('diamonds', 13)], [card('hearts', 13)]], stock: [card('spades', 13, false)], foundation: foundations({ clubs: 12, diamonds: 12, hearts: 12, spades: 12 }) }), 3, id('clubs', 13)],
    ['a card on the waste', () => board({ tableau: [[card('clubs', 13)], [card('diamonds', 13)], [card('hearts', 13)]], waste: [card('spades', 13)], foundation: foundations({ clubs: 12, diamonds: 12, hearts: 12, spades: 12 }) }), 4, id('clubs', 13)]
  ])('a board that could clear but still has %s does not start it after a column move: the finish never plays a card the player has not seen', async (_name, makeBoard, cards, king) => {
    await mount(makeBoard(), cards)
    const foundationsBefore = SUITS.map(foundationTop)

    expect(await dragFromColumn(king, column(6))).toBe(true) // a King into an empty column: nothing hidden comes to light
    await flush(3000)

    expect(mockLog.shown).toEqual([])
    expect(SUITS.map(foundationTop)).toEqual(foundationsBefore)
    expect(won()).toBe('false')
  })

  it('a resumed solved board sits until the player moves - then any move of theirs starts it', async () => {
    await mount(SOLVED(), 6)
    await flush(3000)
    expect(mockLog.shown).toEqual([])
    expect(cardsOnBoard()).toBe(6)

    expect(await dragFromColumn(id('clubs', 12), column(2))).toBe(true) // the Queen of clubs from one red King to the other
    await flush(3000)

    expect([...mockLog.shown].sort()).toEqual([...REMAINING].sort())
    expect(won()).toBe('true')
  })

  it('undoing the last card it sent up leaves the solved board alone: the card is not sent straight back', async () => {
    await mount(SOLVED(), 6)
    await tapCard(id('clubs', 11))
    await flush(3000)
    expect(won()).toBe('true')
    const lastSent = mockLog.shown[mockLog.shown.length - 1]
    expect(lastSent).toBe(id('spades', 13))
    mockLog.shown = []

    await tap('undo')
    await flush(3000)

    expect(mockLog.shown).toEqual([lastSent]) // the undo's own flight, and nothing after it
    expect(pileIds(4)).toEqual([lastSent])
    expect(foundationTop('spades')).toBe(id('spades', 12))
    expect(won()).toBe('false')
  })

  // The test above pins the behaviour, not the revert's own finish.suppress(): the finish's permission ended with its loop, and an
  // undo's flight keeps undoBusyRef held through the revert's commit, which drops a permission anyway. This one has neither: the
  // player's own winning move leaves its permission standing (the finish never ran, the board went straight to won), and an undo
  // whose card can't be measured flies nothing, so undoBusyRef is let go before the reverted board's effects run.
  it("undoing the player's own winning move off a board that can't fly it back leaves the solved board alone too", async () => {
    await mount(KING_IN_COLUMN(), 1) // resumed solved: it sits
    await tapCard(id('clubs', 13)) // the player's own move wins it - nothing left for the finish to send
    await flush(3000)
    expect(won()).toBe('true')
    expect(foundationTop('clubs')).toBe('empty') // the win cascade has taken over the piles: the King is no longer measurable there...
    mockUnmeasurableSlots.add('clubs') // ...and neither is its slot, so the undo has no origin and no flight
    // The slot's measurement takes a beat, as a native round trip does: the revert then commits from a timer, and undoBusyRef is
    // let go (a microtask after the commit) before React renders it and runs its effects, the order React's scheduler gives outside
    // act (the render is a later task; reasoned from the scheduler, not observed on a device). Measured at once,
    // act renders the revert while undoBusyRef is still held, and the hook drops the permission by itself.
    mockMeasureViewMs = 20
    mockLog.shown = []

    await tap('undo')
    await flush(3000)

    expect(mockLog.shown).toEqual([]) // no undo flight, and the King is not sent straight back up
    expect(pileIds(0)).toEqual([id('clubs', 13)])
    expect(foundationTop('clubs')).toBe(id('clubs', 12))
    expect(won()).toBe('false')
  })

  it('a New Game that deals a solved board leaves it for the player, even with a move of theirs from the last deal still allowing a finish', async () => {
    // The old deal: a foundation play allows a finish that board never reaches - the two red Kings each sit on the other's face-down
    // Queen.
    await mount(board({ tableau: [[card('clubs', 12)], [card('diamonds', 12, false), card('hearts', 13)], [card('hearts', 12, false), card('diamonds', 13)], [card('clubs', 13)]], foundation: foundations({ clubs: 11, diamonds: 11, hearts: 11, spades: 13 }) }), 6)
    await tapCard(id('clubs', 12))
    await flush(3000)
    expect(mockLog.shown[0]).toBe(id('clubs', 12))
    expect(won()).toBe('false')
    mockLog.shown = []
    const newController = klondikeRules.createKlondikeController
    jest.spyOn(klondikeRules, 'createKlondikeController').mockImplementation((draw) => ({ ...newController(draw), newGame: () => SOLVED() }))

    await tap('new-game')
    await flush(3000)

    expect(mockLog.shown).toEqual([]) // the deal's own flights only (not ghost shows)
    expect(cardsOnBoard()).toBe(6)
    expect(foundationTop('clubs')).toBe(id('clubs', 10))
    expect(won()).toBe('false')

    await tapCard(id('clubs', 11)) // the player's first foundation play in the new deal
    await flush(3000)
    expect([...mockLog.shown].sort()).toEqual([...REMAINING].sort())
    expect(won()).toBe('true')
  })

  it('a card the player takes back off a foundation onto a solved board is not sent straight back up; their next move starts it', async () => {
    await mount(SOLVED(), 6)

    expect(await dropFromFoundation('spades', card('spades', 12), 2)).toBe(true) // the Queen of spades onto the King of hearts
    await flush(3000)
    expect(mockLog.shown).toEqual([])
    expect(pileIds(2)).toEqual([id('hearts', 13), id('spades', 12)])
    expect(foundationTop('spades')).toBe(id('spades', 11))

    await tapCard(id('clubs', 11))
    await flush(3000)
    expect([...mockLog.shown].sort()).toEqual([...REMAINING, id('spades', 12)].sort())
    expect(won()).toBe('true')
  })

  it('a card the player takes back off a foundation mid-finish stops it', async () => {
    await mount(SOLVED(), 6)
    await tapCard(id('clubs', 11))
    await flush(finishGapMs(0) + STEP_MS)
    expect(mockLog.shown).toHaveLength(2) // the player's play, then the finish's first card
    const sent = [...mockLog.shown]

    expect(await dropFromFoundation('spades', card('spades', 12), 2)).toBe(true)
    await flush(3000)

    expect(mockLog.shown).toEqual(sent) // nothing after it
    expect(pileIds(2)).toEqual([id('hearts', 13), id('spades', 12)])
    expect(won()).toBe('false')
  })

  it('does not run when Auto-Move to Foundation is off', async () => {
    mockSettings.autoMove = false
    await mount(SOLVED_BY_COLUMN_MOVE(), 6)

    await tapCard(id('clubs', 12))
    await flush(3000)
    await tapCard(id('clubs', 11)) // a foundation play does not start it either
    await flush(3000)

    expect(mockLog.shown).toEqual([id('clubs', 12), id('clubs', 11)])
    expect(cardsOnBoard()).toBe(5)
    expect(won()).toBe('false')
  })
})

describe('hint', () => {
  it('the Hint button glides the hinted card; Auto Hint only rings it', async () => {
    await mount(FIVE_THEN_SIX(), 4)
    await tap('auto-hint')
    expect(mockHintGlides).toEqual([])
    await tap('hint')
    expect(mockHintGlides.length).toBe(1)
  })
})

// A held Undo used to stall whenever the next undo needed cards the one before it was still flying back: it waited for them to land,
// then sent them off again (Jay's Yukon recording, 2026-10-16). Cards flying in to a column or a foundation turn back in mid-air
// instead (ghost.peel); the waste still takes one arrival at a time.
describe('Klondike screen - an undo that needs cards still flying back', () => {
  const col = (index: number): PileRef => ({ zone: 'tableau', index })
  const STOCK: PileRef = { zone: 'stock', index: 0 }
  const WASTE: PileRef = { zone: 'waste', index: 0 }
  const entry = (state: KlondikeState, from: PileRef, to: PileRef, count: number, anchorCardId: string) => ({ state, move: { primary: { from, to, count, anchorCardId }, cascaded: [] } })

  it('turns them back in mid-air at once, instead of waiting for them to land', async () => {
    // The 5 of spades went onto the 6 of hearts, then the 6 and 5 together onto the 7 of clubs.
    const s0 = board({ tableau: [[card('spades', 5)], [card('clubs', 7)], [card('hearts', 6)]], foundation: foundations({}) })
    const s1 = board({ tableau: [[], [card('clubs', 7)], [card('hearts', 6), card('spades', 5)]], foundation: foundations({}) })
    const s2 = board({ tableau: [[], [card('clubs', 7), card('hearts', 6), card('spades', 5)]], foundation: foundations({}) })
    await mount(s2, 3, [entry(s0, col(0), col(2), 1, id('spades', 5)), entry(s1, col(2), col(1), 2, id('hearts', 6))], 2)

    await tap('undo')
    await flush(10)
    expect(mockLog.shown).toEqual([`${id('hearts', 6)}+${id('spades', 5)}`])
    await tap('undo')
    await flush(10)
    expect(mockPeel.peeled).toEqual([id('spades', 5)]) // the 5 turned back out of the pair's flight
    expect(mockPeel.peeledAt[0] - mockLog.shownAt[0]).toBeLessThan(FLIGHT_MS) // while the pair was still in the air
    expect(mockLog.shown).toHaveLength(1)

    await flushUntil(() => mockLog.inAir === 0)
    expect([0, 1, 2].map(pileIds)).toEqual([[id('spades', 5)], [id('clubs', 7)], [id('hearts', 6)]])
  })

  it('a card flying back to the waste is still waited for: the waste takes one arrival at a time', async () => {
    // The 6 of hearts was drawn, then played from the waste onto the 7 of clubs.
    const six = card('hearts', 6)
    const s0 = board({ tableau: [[card('clubs', 7)]], stock: [{ ...six, faceUp: false }], foundation: foundations({}) })
    const s1 = board({ tableau: [[card('clubs', 7)]], waste: [six], foundation: foundations({}) })
    const s2 = board({ tableau: [[card('clubs', 7), six]], foundation: foundations({}) })
    await mount(s2, 2, [entry(s0, STOCK, WASTE, 1, six.id), entry(s1, WASTE, col(0), 1, six.id)], 2)

    await tap('undo')
    await flush(10)
    await tap('undo')
    await flush(10)
    expect(mockPeel.peeled).toEqual([])
    expect(mockLog.shown).toHaveLength(1) // the draw's undo is waiting for the 6 to land on the waste

    await flushUntil(() => mockLog.shown.length === 2)
    expect(mockLog.shownAt[1] - mockLog.shownAt[0]).toBeGreaterThanOrEqual(FLIGHT_MS)
  })
})
