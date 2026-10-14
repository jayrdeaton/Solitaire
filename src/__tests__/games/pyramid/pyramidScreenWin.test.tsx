import { act, fireEvent, render, screen } from '@testing-library/react-native'

import { FLIGHT_SPRING, springSettleMs } from '@/components/dragdrop/dragSpring'
import { CHAIN_MAX_SPAN_MS, chainSegmentDelayMs } from '@/components/winning/winCascadeMotion'
import { Card, Suit } from '@/engine/types'
import PyramidScreen, { SWEEP_WIN_REVEAL_MAX_WAIT_MS, winHoldView } from '@/games/pyramid/PyramidScreen'
import { PyramidController, PyramidState } from '@/games/pyramid/rules'
import { WIN_REVEAL_MAX_WAIT_MS } from '@/games/shared/useWinReveal'

import { resetGameInProgress, seedGameInProgress } from '../../../testUtils/gameInProgressStore'

// ---------------------------------------------------------------------------------------------------------------------
// A screen-level test for what Pyramid's WINNING removal does: the REAL PyramidScreen (real rules, real useFlightConcurrency /
// useDerivedWinCheck / useWinReveal / useGameSession / gameInProgress store, and the real pair-flight overlay), seeded with a
// saved game through the test store (src/testUtils/gameInProgressStore.ts). Only the parts that need native views, gestures or animation are replaced, each by
// a stand-in that honors the same contract the screen relies on (same approach as freeCellScreenAutoPlay.test.tsx):
//   - DraggableCard / StockWaste / DiscardCell: render the card ids they were handed, so the test can see exactly what each pile
//     is showing at every moment, and a tap calls onPress(measure) like the real ones.
//   - useDragGhost: a fake ghost whose flights "land" FLIGHT_MS later (the Reanimated mock's withSpring never calls its
//     completion callback). The pair flight's own overlay is NOT mocked: it settles on a timer.
//   - useDealAnimator: a fake deal that follows the real one's TIMELINE (each card TAKES OFF - onCardDealt - delayMs after the deal's
//     clock starts and lands the 280ms deal spring later, onAllLanded after the last, a skip takes off and lands everything at once,
//     a new start() - or an empty one - silences the old deal) and records every entry it was handed. The real deal's clock only
//     starts once its ghost pool has rendered and mounted, which takes a while on a phone: `mockDealTakeoffLatencyMs` is that gap.
//   - useWinCascade: records the chains it was asked to launch.
// The scenario is the one that used to teleport: rules.ts's sweepRemainderOnWin folds the stock and waste into the discard on the
// winning move, so the board used to lose those piles - and the last card used to be followed at once by the cascade - with nothing
// flying anywhere. Now the leftovers are DEALT onto the discard, and only when all of them have landed does the celebration start,
// as ONE chain out of the single discard pile.
// ---------------------------------------------------------------------------------------------------------------------

const FLIGHT_MS = 80
/** How long the fake ghost takes to land - a test raises it past the win hold to prove the celebration waits for the LANDING, not just for time to pass. */
let mockFlightMs = FLIGHT_MS
/** How long every measurement (registry, plain view, the tapped card's own measure) takes. */
let mockMeasureMs = 0
const HOLD_MS = 400 // useWinReveal's WIN_REVEAL_HOLD_MS
/** The longest a real flight keeps its ghost up (every flight is dragSpring.ts's FLIGHT_SPRING: springSettleMs of it) - derived, so re-pacing the flights re-times the waits below. */
const SLOWEST_FLIGHT_MS = springSettleMs(FLIGHT_SPRING)
const DEAL_SPRING_MS = 280 // dealSpring.ts's DEAL_SPRING.duration - a dealt card lands this long after its own take-off
const STAGGER_MS = 35 // dealStaggerMs() for any sweep of up to 28 cards
/** The pile-blank lag PyramidScreen adds to a pile's last take-off (SWEEP_PILE_BLANK_LAG_MS). */
const BLANK_LAG_MS = 20
/** How long the fake deal's ghost pool takes to mount before its clock starts: every card's take-off (and landing) is this much later than
 * the start() call. 0 by default - the real deal's latency is a few frames to ~80ms on a phone (see the sweep's pile-blank tests). */
let mockDealTakeoffLatencyMs = 0
let mockSeed = 1

const mockRecordWon = jest.fn()

interface MockDealEntry {
  cardId: string
  faceUp: boolean
  from: { x: number; y: number }
  to: { x: number; y: number }
  delayMs: number
}

interface MockLog {
  /** Every ghost.show() - one per single-card flight the screen started. */
  shown: string[]
  /** Where each of those flights took off from (same order as `shown`). */
  shownFrom: { x: number; y: number }[]
  /** Where every single-card flyTo() was aimed. */
  flown: { x: number; y: number }[]
  /** Single-card flyTo() calls still waiting to land. */
  inAir: number
  /** The chains the win cascade was launched with (null: it never started), and how many single-card flights were still in the air. */
  chains: { ids: string[]; origin: { x: number; y: number }; segmentDelayMs?: number }[] | null
  airAtWinCascade: number
  /** What the discard / stock / waste were showing (a top card's id, or 'empty') at the instant the cascade started (null: it never did). */
  atCascade: { discard: string; stock: string; waste: string } | null
  /** How many dealt cards had not landed yet when the cascade started. */
  dealPendingAtCascade: number
  /** The same, at the instant the cascade's ghosts showed (its onShown) - null: they never did. */
  atGhostsShown: { discard: string; stock: string; waste: string } | null
  /** Renders of the DISCARD showing nothing before the cascade's ghosts showed: a pile blanked ahead of its ghosts sat empty until
   * they arrived (or, blanked with startChains, under blank-faced ghosts until their faces painted). */
  blankDiscardRendersBeforeGhosts: number
  /** Every deal the screen started (a sweep, or a new game's initial deal), each with its entries; the empty start()s (cancels) counted apart. */
  deals: MockDealEntry[][]
  cancelled: number
  /** Per deal (same index as `deals`): the ids reported landed, in order. */
  landed: string[][]
  /** The ids of the current/most recent deal that have TAKEN OFF (onCardDealt reported), in order - a ghost is drawn over its card from then on. */
  takenOff: string[]
  /** When (fake clock) each of those took off. */
  takenOffAt: Record<string, number>
  /** Single-card flights still in the air at the moment each deal started. */
  airAtDealStart: number[]
  /** When (fake clock) the last card of the most recent deal landed, and when the banner and the cascade first appeared. */
  allLandedAt: number | null
  bannerAt: number | null
  chainsAt: number | null
}
const mockLog: MockLog = { shown: [], shownFrom: [], flown: [], inAir: 0, chains: null, airAtWinCascade: -1, atCascade: null, dealPendingAtCascade: -1, atGhostsShown: null, blankDiscardRendersBeforeGhosts: 0, deals: [], cancelled: 0, landed: [], takenOff: [], takenOffAt: {}, airAtDealStart: [], allLandedAt: null, bannerAt: null, chainsAt: null }
/** The real cascade shows - and calls startChains' onShown - only once its parked ghosts' faces have painted, a frame or two after
 * startChains (WinCascadeLayer's CascadeChains); the mock stands in for that wait with a timer. */
const MOCK_GHOSTS_SHOW_MS = 16
let mockGhostsShowTimer: ReturnType<typeof setTimeout> | undefined
/** Read from inside the mocked cascade, hence hoisted-mock naming. */
const mockText = (testID: string) => screen.getByTestId(testID).props.children as string
/** Card ids whose registry lookup fails (a card that isn't registered/mounted at the instant it is measured). */
const mockUnregistered = new Set<string>()
/** A registered card's own point, when a test wants it to differ from the default one (and so from every plain-view point below). */
const mockRegistryPoints = new Map<string, { x: number; y: number }>()
/** Piles ('discard' | 'stock' | 'waste') whose host view cannot be measured. */
const mockUnmeasurable = new Set<string>()
let mockFlightsLand = true
/** When true the fake deal never lands a card (a deal that hangs). */
let mockDealNeverLands = false

const mockLatency = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve())

function mockMakeFlight() {
  return {
    hide: () => {},
    originX: { value: 10 },
    originY: { value: 10 },
    dx: { value: 0 },
    dy: { value: 0 },
    flyTo: (x: number, y: number, onDone?: () => void) => {
      mockLog.flown.push({ x, y })
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
  cardRegistry: {
    register: () => {},
    unregister: () => {},
    measure: async (id: string) => {
      await mockLatency(mockMeasureMs)
      return mockUnregistered.has(id) ? null : (mockRegistryPoints.get(id) ?? { x: 10, y: 10 })
    }
  },
  show: (spec: { cards: { id: string }[] }, from: { x: number; y: number }) => {
    mockLog.shown.push(spec.cards.map((c) => c.id).join('+'))
    mockLog.shownFrom.push(from)
    return mockMakeFlight()
  }
}

// The fake deal. `mockDealActive` is the deal a real DealProvider would still be running: a new start() silences it (its timers stop
// and its callbacks are never called), exactly what the real one does by bumping its generation.
interface MockDealRun {
  index: number
  total: number
  landed: Set<string>
  takenOff: Set<string>
  onCardLanded: (cardId: string) => void
  onAllLanded: () => void
  onCardDealt?: (cardId: string) => void
}
let mockDealActive: MockDealRun | null = null
let mockDealTimers: ReturnType<typeof setTimeout>[] = []
function mockTakeOff(run: MockDealRun, cardId: string) {
  if (mockDealActive !== run || run.takenOff.has(cardId)) return
  run.takenOff.add(cardId)
  mockLog.takenOff.push(cardId)
  mockLog.takenOffAt[cardId] = Date.now()
  run.onCardDealt?.(cardId)
}
function mockLand(run: MockDealRun, cardId: string) {
  if (mockDealActive !== run || run.landed.has(cardId)) return
  mockTakeOff(run, cardId) // a skip lands cards that had not taken off yet: the real deal reports their take-off first
  run.landed.add(cardId)
  mockLog.landed[run.index].push(cardId)
  run.onCardLanded(cardId)
  if (run.landed.size >= run.total) {
    mockLog.allLandedAt = Date.now()
    mockDealActive = null
    run.onAllLanded()
  }
}
const mockDeal = {
  start: (entries: { cardId: string; card: { faceUp: boolean }; from: { x: number; y: number }; to: { x: number; y: number }; delayMs: number }[], _cardWidth: number, onCardLanded: (cardId: string) => void, onAllLanded: () => void, onCardDealt?: (cardId: string) => void) => {
    mockDealTimers.forEach(clearTimeout)
    mockDealTimers = []
    mockDealActive = null
    if (entries.length === 0) {
      mockLog.cancelled += 1
      onAllLanded()
      return
    }
    const index = mockLog.deals.length
    mockLog.deals.push(entries.map((e) => ({ cardId: e.cardId, faceUp: e.card.faceUp, from: e.from, to: e.to, delayMs: e.delayMs })))
    mockLog.landed.push([])
    mockLog.takenOff = []
    mockLog.takenOffAt = {}
    mockLog.airAtDealStart.push(mockLog.inAir)
    const run: MockDealRun = { index, total: new Set(entries.map((e) => e.cardId)).size, landed: new Set(), takenOff: new Set(), onCardLanded, onAllLanded, onCardDealt }
    mockDealActive = run
    if (mockDealNeverLands) return
    entries.forEach((e) => {
      // Like the real deal: the clock starts only after the pool has mounted, and a card takes off at its delay and lands one spring later.
      mockDealTimers.push(setTimeout(() => mockTakeOff(run, e.cardId), mockDealTakeoffLatencyMs + e.delayMs))
      mockDealTimers.push(setTimeout(() => mockLand(run, e.cardId), mockDealTakeoffLatencyMs + e.delayMs + DEAL_SPRING_MS))
    })
  },
  /** The skip tap: every card of the deal in progress lands at once. */
  skip: () => {
    const run = mockDealActive
    if (!run) return
    mockDealTimers.forEach(clearTimeout)
    mockDealTimers = []
    mockLog.deals[run.index].forEach((e) => mockLand(run, e.cardId))
  }
}

jest.mock('@/redux/store', () => require('../../../testUtils/gameInProgressStore').storeModule)
jest.mock('@/components/dragdrop/DragGhostLayer', () => ({ DragGhostProvider: ({ children }: { children: unknown }) => children, useDragGhost: () => mockGhost }))
jest.mock('@/components/dealing/DealLayer', () => ({ DealProvider: ({ children }: { children: unknown }) => children, useDealAnimator: () => mockDeal }))
jest.mock('@/engine/rng', () => ({ ...jest.requireActual('@/engine/rng'), randomSeed: () => mockSeed }))
jest.mock('@/components/winning/WinCascadeLayer', () => ({
  // Unmounting drops a cascade that has not shown yet, like the real provider (a test can end mid-wait).
  WinCascadeProvider: ({ children }: { children: unknown }) => {
    require('react').useEffect(() => () => clearTimeout(mockGhostsShowTimer), [])
    return children
  },
  WinCascadeGhosts: () => null,
  useWinCascade: () => ({
    startChains: (chains: { cards: { id: string }[]; origin: { x: number; y: number }; segmentDelayMs?: number }[], _cardWidth: number, onShown?: () => void) => {
      mockLog.chains = chains.map((c) => ({ ids: c.cards.map((card) => card.id), origin: c.origin, segmentDelayMs: c.segmentDelayMs }))
      mockLog.chainsAt = Date.now()
      mockLog.airAtWinCascade = mockLog.inAir
      mockLog.dealPendingAtCascade = mockDealActive ? mockDealActive.total - mockDealActive.landed.size : 0
      mockLog.atCascade = { discard: mockText('discard-top'), stock: mockText('stock-top'), waste: mockText('waste-top') }
      // Like the real controller: never for an empty cascade, and dropped by clear() or a newer startChains.
      clearTimeout(mockGhostsShowTimer)
      if (chains.length > 0 && onShown)
        mockGhostsShowTimer = setTimeout(() => {
          mockLog.atGhostsShown = { discard: mockText('discard-top'), stock: mockText('stock-top'), waste: mockText('waste-top') }
          onShown()
        }, MOCK_GHOSTS_SHOW_MS)
    },
    clear: () => clearTimeout(mockGhostsShowTimer)
  })
}))
// Every plain container measures somewhere different (each stand-in below tags its own host view), so a chain's origin says which
// pile it left from.
jest.mock('@/components/dealing/measureView', () => ({
  measureView: async (view: { __pile?: string } | null) => {
    await mockLatency(mockMeasureMs)
    if (!view) return null
    if (view.__pile && mockUnmeasurable.has(view.__pile)) return null
    return { x: view.__pile === 'discard' ? 100 : view.__pile === 'stock' ? 200 : view.__pile === 'waste' ? 300 : 5, y: 5 }
  }
}))
jest.mock('@tastic/core', () => ({ ...jest.requireActual('@tastic/core'), RotationAwareStatusBar: () => null }))
jest.mock('@/components/useCardSounds', () => ({ useCardSoundEffects: () => ({ playCardSound: () => {}, playInvalidSound: () => {}, hapticCard: () => {}, hapticInvalid: () => {} }) }))
jest.mock('@rific/feedback-press', () => ({ useVibration: () => ({ short: () => {}, selection: () => {} }) }))
jest.mock('@rific/toaster', () => ({ useToast: () => ({ info: () => {} }) }))
jest.mock('@tastic/sprites/fireworks', () => {
  const { View: MockView } = require('react-native')
  return { Fireworks: () => <MockView testID='fireworks' /> }
})
jest.mock('@/games/shared/WinBanner', () => {
  const { Text: MockText } = require('react-native')
  return {
    WinBanner: () => {
      if (mockLog.bannerAt === null) mockLog.bannerAt = Date.now()
      return <MockText testID='win-banner'>won</MockText>
    }
  }
})
jest.mock('@/stores/gameStats', () => ({ useGameStats: () => ({ recordDealWon: mockRecordWon, recordDealAbandoned: () => {}, recordHintUsed: () => {} }) }))
jest.mock('@/stores/lastActiveGame', () => ({ useLastActiveGame: () => ({ setLastActiveGame: () => {}, clearLastActiveGame: () => {} }) }))
jest.mock('@/components/theme', () => {
  const actual = jest.requireActual('@/components/theme')
  return { ...actual, useTableColors: () => actual.lightColors }
})
jest.mock('@/components/PlayingCard', () => {
  const { View: MockView } = require('react-native')
  return { PlayingCard: ({ card, testID }: { card: { id: string }; testID?: string }) => <MockView testID={testID ?? `ghost-${card.id}`} />, EmptySlot: () => <MockView /> }
})
jest.mock('@/components/dragdrop/DropZone', () => ({ DropZone: ({ children }: { children: unknown }) => children }))
jest.mock('@/components/dragdrop/DraggableCard', () => {
  const { Pressable: MockPressable } = require('react-native')
  return {
    DraggableCard: ({ card, onPress }: { card: { id: string }; onPress: (measure: () => Promise<{ x: number; y: number }>) => void }) => (
      <MockPressable
        testID={`pyramid-${card.id}`}
        onPress={() =>
          onPress(async () => {
            await mockLatency(mockMeasureMs)
            return { x: 10, y: 10 }
          })
        }
      />
    )
  }
})
/** A ref callback that both hands the screen its ref and tags the host view with which pile it is (see measureView above). */
const mockTagRef = (name: string, ref: { current: unknown } | undefined) => (el: { __pile?: string } | null) => {
  if (el) el.__pile = name
  if (ref) ref.current = el
}
jest.mock('@/components/StockWaste', () => {
  const { Text: MockText, View: MockView } = require('react-native')
  return {
    StockWaste: ({ stockTopCard, wasteTop, onDrawStock, onWastePress, stockRef, wasteRef }: { stockTopCard?: { id: string }; wasteTop?: { id: string }; onDrawStock: () => void; onWastePress: (measure: () => Promise<{ x: number; y: number }>) => void; stockRef: { current: unknown }; wasteRef: { current: unknown } }) => (
      <MockView>
        <MockView ref={mockTagRef('stock', stockRef)} collapsable={false} />
        <MockView ref={mockTagRef('waste', wasteRef)} collapsable={false} />
        <MockText testID='stock-top' onPress={onDrawStock}>
          {stockTopCard ? stockTopCard.id : 'empty'}
        </MockText>
        <MockText testID='waste-top' onPress={wasteTop ? () => onWastePress(async () => ({ x: 10, y: 10 })) : undefined}>
          {wasteTop ? wasteTop.id : 'empty'}
        </MockText>
      </MockView>
    )
  }
})
// A stand-in that paints exactly what the real DiscardCell does (see its own test): the real top card, or - while cards are flying to
// it - what sits UNDER the ghosts: `settledCard` when the screen passes one, else the frozen copy of the pre-flight top.
// `discard-top` is the REAL top card the screen handed over, `discard-painted` what is drawn.
jest.mock('@/games/shared/DiscardCell', () => {
  const { Text: MockText, View: MockView } = require('react-native')
  const { useFrozenWhileHidden } = jest.requireActual('@/components/useFrozenWhileHidden')
  return {
    DiscardCell: ({ card, isFlyingHere, settledCard, viewRef }: { card?: { id: string }; isFlyingHere: boolean; settledCard?: { id: string } | null; viewRef: { current: unknown } }) => {
      const frozenCopy = useFrozenWhileHidden(card, isFlyingHere)
      const under = settledCard === undefined ? frozenCopy : settledCard
      const painted = isFlyingHere ? under : card
      if (!card && mockLog.atGhostsShown === null) mockLog.blankDiscardRendersBeforeGhosts += 1
      return (
        <MockView ref={mockTagRef('discard', viewRef)} collapsable={false}>
          <MockText testID='discard-top'>{card ? card.id : 'empty'}</MockText>
          <MockText testID='discard-painted'>{painted ? painted.id : 'empty'}</MockText>
          <MockText testID='discard-flying'>{String(isFlyingHere)}</MockText>
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

const card = (suit: Suit, rank: number, faceUp = true): Card => ({ id: `${suit}-${rank}-0`, suit, rank, faceUp }) as Card
const id = (suit: Suit, rank: number) => `${suit}-${rank}-0`

/** Only the apex (flat index 0) is left in the triangle, with `waste`/`stock` (both bottom-to-top) still to sweep. */
function board(apex: Card, waste: Card[] = [], stock: Card[] = [], discard: Card[] = [card('spades', 9), card('spades', 4)]): PyramidState {
  const pyramid: (Card | null)[] = Array.from({ length: 28 }, () => null)
  pyramid[0] = apex
  return { pyramid, stock, waste, discard, removedCount: 2 }
}
/** The King of clubs alone in the triangle - one tap wins - over a 2-card waste and a 2-card face-down stock. */
const KING_WITH_PILES = () => board(card('clubs', 13), [card('spades', 2), card('spades', 3)], [card('hearts', 5, false), card('diamonds', 6, false)])
/** A Queen at the apex and an Ace on the waste (pairing to 13), over a 2-card waste and a 1-card stock. */
const PAIR_WITH_WASTE = () => board(card('clubs', 12), [card('spades', 2), card('hearts', 1)], [card('diamonds', 6, false)])
/** A whole 52-card deck in play: the King of clubs alone in the triangle, `waste` and `stock` cards still to sweep, the rest already discarded. */
function fullDeckBoard(waste: number, stock: number): PyramidState {
  const suits: Suit[] = ['spades', 'hearts', 'diamonds', 'clubs']
  const others: Card[] = suits.flatMap((suit) => Array.from({ length: 13 }, (_, i) => card(suit, i + 1))).filter((c) => c.id !== id('clubs', 13))
  const discard = others.slice(waste + stock)
  return board(
    card('clubs', 13),
    others.slice(0, waste),
    others.slice(waste, waste + stock).map((c) => ({ ...c, faceUp: false })),
    discard
  )
}

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

async function mount(state: PyramidState) {
  seedGameInProgress('pyramid', { state, undoStack: [], moves: 0, elapsedSeconds: 0 })
  await render(<PyramidScreen />)
  await flush() // loadGameInProgress -> restoreGame
  expect(screen.queryByTestId('stock-top')).not.toBeNull()
}

const text = (testID: string) => screen.getByTestId(testID).props.children as string
/** What the waste shows (its top card's id, or 'empty'). */
const wasteShows = () => text('waste-top')
const stockShows = () => text('stock-top')
const discardPainted = () => text('discard-painted')
const flyingGhosts = () => screen.queryAllByTestId(/^ghost-/).map((n) => n.props.testID as string)

async function press(testID: string) {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID))
  })
}

/** Taps the lone King and runs until the sweep's deal has started (the King landed and the leftovers are about to fly). */
async function winAndStartSweep() {
  await press(`pyramid-${id('clubs', 13)}`)
  for (let waited = 0; mockLog.deals.length === 0 && waited < 3000; waited += STEP_MS) await flush(STEP_MS)
  expect(mockLog.deals).toHaveLength(1)
}

beforeEach(() => {
  jest.useFakeTimers()
  mockLog.shown = []
  mockLog.shownFrom = []
  mockLog.flown = []
  mockLog.inAir = 0
  mockLog.chains = null
  mockLog.airAtWinCascade = -1
  mockLog.atCascade = null
  mockLog.dealPendingAtCascade = -1
  mockLog.atGhostsShown = null
  mockLog.blankDiscardRendersBeforeGhosts = 0
  mockLog.deals = []
  mockLog.cancelled = 0
  mockLog.landed = []
  mockLog.takenOff = []
  mockLog.takenOffAt = {}
  mockLog.airAtDealStart = []
  mockLog.allLandedAt = null
  mockLog.bannerAt = null
  mockLog.chainsAt = null
  mockUnregistered.clear()
  mockRegistryPoints.clear()
  mockUnmeasurable.clear()
  mockFlightsLand = true
  mockDealNeverLands = false
  mockDealTakeoffLatencyMs = 0
  mockDealActive = null
  mockDealTimers = []
  mockFlightMs = FLIGHT_MS
  mockMeasureMs = 0
  mockSeed = 1
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

describe('Pyramid screen - a winning King', () => {
  it('flies to the discard first, the stock/waste stay where they are until the leftovers are dealt, and the celebration starts only after the last has landed and a beat has passed', async () => {
    await mount(KING_WITH_PILES())
    expect(text('discard-top')).toBe(id('spades', 4))

    await press(`pyramid-${id('clubs', 13)}`)
    await flush(10) // the move has committed and the King's ghost is in the air

    expect(mockRecordWon).toHaveBeenCalledTimes(1) // the win is recorded the instant it happens...
    expect(mockLog.shown).toEqual([id('clubs', 13)])
    expect(mockLog.inAir).toBe(1) // ...the winning card really is flying...
    expect(text('discard-flying')).toBe('true')
    expect(discardPainted()).toBe(id('spades', 4)) // ...over the pile as it was
    expect(stockShows()).toBe(id('diamonds', 6)) // ...while the stock and waste - swept by the win itself - still show what they did
    expect(wasteShows()).toBe(id('spades', 3))
    expect(mockLog.deals).toHaveLength(0) // and no leftover has taken off: the King's own flight has not landed
    expect(screen.queryByTestId('win-banner')).toBeNull() // with no celebration yet
    expect(screen.queryByTestId('fireworks')).toBeNull()
    expect(mockLog.chains).toBeNull()

    await flush(FLIGHT_MS) // the King lands: the leftovers are dealt after it
    expect(mockLog.inAir).toBe(0)
    expect(mockLog.deals).toHaveLength(1)
    expect(mockLog.airAtDealStart).toEqual([0]) // the deal started with nothing else in the air
    expect(discardPainted()).toBe(id('clubs', 13)) // the King now sits on the discard
    expect(text('discard-flying')).toBe('true') // and the pile is still waiting for the rest
    expect(mockRecordWon).toHaveBeenCalledTimes(1)

    await flush(DEAL_SPRING_MS + 3 * STAGGER_MS + 20) // the last leftover lands
    expect(text('discard-flying')).toBe('false')
    expect(discardPainted()).toBe(id('diamonds', 6)) // every card is on the pile: the top is the last stock card
    expect(stockShows()).toBe('empty')
    expect(wasteShows()).toBe('empty')
    expect(screen.queryByTestId('win-banner')).toBeNull() // the finished pile holds for a beat...
    expect(screen.queryByTestId('fireworks')).toBeNull()
    expect(mockLog.chains).toBeNull()

    await flush(HOLD_MS + 50) // ...then the celebration takes over
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(screen.getByTestId('fireworks')).toBeTruthy()
    expect(text('discard-top')).toBe('empty') // the discard blanks as the cascade takes it
    expect(mockLog.airAtWinCascade).toBe(0)
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
  })

  it('waits for the LANDING, not just for time to pass: a flight slower than the hold keeps the sweep and the celebration back until it lands', async () => {
    await mount(KING_WITH_PILES())
    mockFlightMs = 1200

    await press(`pyramid-${id('clubs', 13)}`)
    await flush(HOLD_MS * 2) // well past the hold, the King still in the air
    expect(mockLog.inAir).toBe(1)
    expect(mockLog.deals).toHaveLength(0) // the leftovers wait for it
    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(screen.queryByTestId('fireworks')).toBeNull()
    expect(mockLog.chains).toBeNull()
    expect(stockShows()).toBe(id('diamonds', 6))

    await flush(1200 - HOLD_MS * 2 + 10) // it lands: the sweep starts
    expect(mockLog.inAir).toBe(0)
    expect(mockLog.deals).toHaveLength(1)
    expect(screen.queryByTestId('win-banner')).toBeNull()
    await flush(DEAL_SPRING_MS + 3 * STAGGER_MS + 20) // the sweep lands; only then does the beat start
    expect(screen.queryByTestId('win-banner')).toBeNull()
    await flush(HOLD_MS + 50)
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(screen.getByTestId('fireworks')).toBeTruthy()
    expect(mockLog.airAtWinCascade).toBe(0)
  })

  it('deals every leftover card onto the discard exactly once, each from its own pile, in the order the discard holds them, face-up', async () => {
    await mount(KING_WITH_PILES())
    await winAndStartSweep()

    const entries = mockLog.deals[0]
    // The discard array order rules.ts produces: the waste bottom-to-top, then the stock bottom-to-top.
    expect(entries.map((e) => e.cardId)).toEqual([id('spades', 2), id('spades', 3), id('hearts', 5), id('diamonds', 6)])
    expect(new Set(entries.map((e) => e.cardId)).size).toBe(entries.length) // each exactly once
    expect(entries.map((e) => e.from.x)).toEqual([300, 300, 200, 200]) // the waste's two from the waste slot (x 300), the stock's from the stock (x 200)
    expect(entries.every((e) => e.to.x === 100)).toBe(true) // every one to the discard (x 100)
    expect(entries.map((e) => e.delayMs)).toEqual([0, STAGGER_MS, 2 * STAGGER_MS, 3 * STAGGER_MS]) // staggered like a deal
    // The stock's cards are face-down on the board; they fly face-up (the deal layer cannot turn a card over in flight), never with no flight.
    expect(entries.every((e) => e.faceUp)).toBe(true)

    await flush(2000)
    expect([...mockLog.landed[0]].sort()).toEqual(entries.map((e) => e.cardId).sort()) // and each landed exactly once
    expect(mockLog.landed[0]).toHaveLength(4)
  })

  it('empties the piles as their last cards take off and advances the discard top as each card lands', async () => {
    await mount(KING_WITH_PILES())
    await winAndStartSweep()
    // The deal has just started (t = 0 of its own clock): both piles still show what the board showed.
    expect(wasteShows()).toBe(id('spades', 3))
    expect(stockShows()).toBe(id('diamonds', 6))
    expect(discardPainted()).toBe(id('clubs', 13))

    // The waste's last card (its second) takes off at 35ms: the slot is empty a beat later, while the stock still shows its top.
    await flush(STAGGER_MS)
    expect(wasteShows()).toBe(id('spades', 3))
    await flush(BLANK_LAG_MS + STEP_MS)
    expect(wasteShows()).toBe('empty')
    expect(stockShows()).toBe(id('diamonds', 6))

    // The stock's last card takes off at 105ms.
    await flush(3 * STAGGER_MS - STAGGER_MS - BLANK_LAG_MS - STEP_MS)
    expect(stockShows()).toBe(id('diamonds', 6))
    await flush(BLANK_LAG_MS + 2 * STEP_MS)
    expect(stockShows()).toBe('empty')

    // Cards land 280ms after their take-off: 280, 315, 350 and 385ms into the deal - the top follows them, in order.
    const sofar = 3 * STAGGER_MS + BLANK_LAG_MS + 2 * STEP_MS
    await flush(DEAL_SPRING_MS - sofar + STEP_MS)
    expect(discardPainted()).toBe(id('spades', 2))
    await flush(STAGGER_MS)
    expect(discardPainted()).toBe(id('spades', 3))
    await flush(STAGGER_MS)
    expect(discardPainted()).toBe(id('hearts', 5))
    await flush(STAGGER_MS)
    expect(discardPainted()).toBe(id('diamonds', 6))
    expect(text('discard-flying')).toBe('false')
  })

  it('starts the celebration exactly one hold after the last leftover lands, as ONE chain of the whole discard that begins only once the sweep is over', async () => {
    await mount(KING_WITH_PILES())
    await winAndStartSweep()
    await flush(3000)

    expect(mockLog.allLandedAt).not.toBeNull()
    expect(mockLog.bannerAt! - mockLog.allLandedAt!).toBeGreaterThanOrEqual(HOLD_MS)
    expect(mockLog.bannerAt! - mockLog.allLandedAt!).toBeLessThanOrEqual(HOLD_MS + 2 * STEP_MS)
    expect(mockLog.dealPendingAtCascade).toBe(0) // the cascade started with no dealt card still in the air

    const chains = mockLog.chains!
    expect(chains).toHaveLength(1) // ONE chain: no separate stock / waste chains any more
    expect(chains[0].origin.x).toBe(100) // out of the discard pile
    // Head = the card on top of the discard: the last card swept in, then back through the whole pile to the oldest discard.
    expect(chains[0].ids).toEqual([id('diamonds', 6), id('hearts', 5), id('spades', 3), id('spades', 2), id('clubs', 13), id('spades', 4), id('spades', 9)])
    expect(chains[0].segmentDelayMs).toBe(chainSegmentDelayMs(7)) // a short chain keeps the usual per-card delay
  })

  it('hands the discard over to the cascade once its ghosts show: its real top is still drawn when the cascade starts and when its ghosts appear, and it was never blank before that', async () => {
    await mount(KING_WITH_PILES())
    await winAndStartSweep()
    await flush(3000)

    expect(mockLog.chains).toHaveLength(1)
    // The cascade measured (and mounted its parked ghosts) while the pile still showed its top (the swept piles are empty by then: the sweep emptied them)...
    expect(mockLog.atCascade).toEqual({ discard: id('diamonds', 6), stock: 'empty', waste: 'empty' })
    // ...and kept it up until the ghosts were on screen (their faces paint a frame or two after they mount: blanking with
    // startChains showed a blank-faced head there)...
    expect(mockLog.atGhostsShown).toEqual({ discard: id('diamonds', 6), stock: 'empty', waste: 'empty' })
    // ...and the discard never sat empty before that: blanking on the reveal alone left it empty for the few frames runWinCascade
    // takes to measure, then the ghosts appeared (a pile that teleported away).
    expect(mockLog.blankDiscardRendersBeforeGhosts).toBe(0)
    expect(text('discard-top')).toBe('empty') // and it is blank now
  })

  it('a skip tap during the sweep lands every leftover at once: nothing is left hidden or in the air, and the celebration is not blocked', async () => {
    await mount(KING_WITH_PILES())
    await winAndStartSweep()
    await flush(STAGGER_MS * 2) // partway through: the first cards are still flying

    expect(mockLog.landed[0]).toHaveLength(0)
    await act(async () => {
      mockDeal.skip()
    })
    expect(mockLog.landed[0]).toEqual([id('spades', 2), id('spades', 3), id('hearts', 5), id('diamonds', 6)])
    expect(text('discard-flying')).toBe('false')
    expect(discardPainted()).toBe(id('diamonds', 6))
    expect(stockShows()).toBe('empty')
    expect(wasteShows()).toBe('empty')
    expect(screen.queryByTestId('win-banner')).toBeNull()

    await flush(HOLD_MS + 50) // one hold after the skip - not the max wait
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(mockLog.chains).toHaveLength(1)
    expect(mockLog.chains![0].ids).toHaveLength(7)
  })

  it('leaves the whole finished board up when the discard cannot be measured (nothing can fly, no chain can start), instead of blanking it with nothing to show', async () => {
    await mount(KING_WITH_PILES())
    mockUnmeasurable.add('discard') // the discard is the destination of every flight and the origin of the chain, so with no position nothing can

    await press(`pyramid-${id('clubs', 13)}`)
    await flush(FLIGHT_MS + HOLD_MS + 50)

    expect(screen.getByTestId('win-banner')).toBeTruthy() // the win is celebrated all the same
    expect(screen.getByTestId('fireworks')).toBeTruthy()
    expect(mockLog.deals).toHaveLength(0) // no sweep (nowhere to fly to)
    expect(mockLog.chains).toBeNull() // and no cascade could start
    expect(text('discard-top')).toBe(id('clubs', 13)) // so every pile stays as the finished board showed it
    expect(stockShows()).toBe(id('diamonds', 6))
    expect(wasteShows()).toBe(id('spades', 3))
  })

  it('an undo out of the celebration brings the piles back, and a re-win never blanks the discard without a cascade to show', async () => {
    await mount(KING_WITH_PILES())
    await winAndStartSweep()
    await flush(3000)
    expect(text('discard-top')).toBe('empty')

    await press('undo')
    await flush(FLIGHT_MS + 100 + SLOWEST_FLIGHT_MS) // the King flies back on the pair-flight overlay: up to a full-distance flight
    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(text('discard-top')).toBe(id('spades', 4)) // the King is back on the pyramid, the discard is what it was
    expect(stockShows()).toBe(id('diamonds', 6))
    expect(wasteShows()).toBe(id('spades', 3))

    // Winning again does not relaunch the cascade (the win is only recorded - and its cascade only queued - once per deal), so nothing
    // takes over from the finished board: it must stay up under the banner (the whole deck on the discard), not blank with nothing to show.
    mockLog.chains = null
    await press(`pyramid-${id('clubs', 13)}`)
    await flush(3000)
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(mockLog.chains).toBeNull()
    expect(text('discard-top')).toBe(id('diamonds', 6))
    expect(stockShows()).toBe('empty')
    expect(wasteShows()).toBe('empty')
  })

  it('a King with nothing left to sweep is unchanged: no sweep, one chain of the discard', async () => {
    await mount(board(card('clubs', 13)))
    await press(`pyramid-${id('clubs', 13)}`)
    await flush(FLIGHT_MS + HOLD_MS + 50)

    expect(mockLog.deals).toHaveLength(0)
    expect(mockLog.chains).toEqual([{ ids: [id('clubs', 13), id('spades', 4), id('spades', 9)], origin: { x: 100, y: 5 }, segmentDelayMs: chainSegmentDelayMs(3) }])
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(screen.getByTestId('fireworks')).toBeTruthy()
  })

  it('is not withheld by a flight that never lands: the celebration starts after the (longer) max wait, with every card in one chain', async () => {
    await mount(KING_WITH_PILES())
    mockFlightsLand = false

    await press(`pyramid-${id('clubs', 13)}`)
    await flush(WIN_REVEAL_MAX_WAIT_MS + 200)
    expect(screen.queryByTestId('win-banner')).toBeNull() // the sweep's own longer wait has not run out yet

    await flush(3000)
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(screen.getByTestId('fireworks')).toBeTruthy()
    expect(mockLog.deals).toHaveLength(0) // the sweep never started (the King never landed)...
    expect(mockLog.chains).toHaveLength(1) // ...and the cascade carries every card from the discard regardless
    expect(mockLog.chains![0].ids).toHaveLength(7)
  })

  it('is not withheld by a sweep that never lands: the fallback cuts it short (its deal is silenced) and the cascade takes every card', async () => {
    await mount(KING_WITH_PILES())
    mockDealNeverLands = true
    await winAndStartSweep()

    await flush(3000)
    expect(screen.queryByTestId('win-banner')).toBeNull() // still waiting on the deal
    await flush(2000)

    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(mockLog.cancelled).toBe(1) // the deal was silenced (an empty start())
    expect(mockLog.chains).toHaveLength(1)
    expect(mockLog.chains![0].ids).toEqual([id('diamonds', 6), id('hearts', 5), id('spades', 3), id('spades', 2), id('clubs', 13), id('spades', 4), id('spades', 9)])
    expect(text('discard-top')).toBe('empty') // and the pile is handed over, with every leftover marked as landed (no ghost is left hiding the real top)
    expect(text('discard-flying')).toBe('false')
  })
})

describe('Pyramid screen - a pile empties when its last card has TAKEN OFF, not on a timer armed ahead of it', () => {
  // The deal layer's own clock starts only after its ghost pool has rendered and mounted, and a card's real take-off is that clock plus
  // its delay: on a phone the gap is several frames. A blank timer armed when the deal was HANDED OVER ran ahead of it by that much -
  // the pile's top card vanished and its slot sat empty until the ghost popped in. Worst for a pile whose last card leaves at delay 0
  // (a single leftover waste card) and for the stock's last card. `mockDealTakeoffLatencyMs` is that gap; the invariant, checked at
  // every 10ms step, is that a pile shows nothing only once its last card's ghost is up (the fake deal's take-off).
  const MOUNT_MS = 90

  const cases: { name: string; state: () => PyramidState; lastWaste: string | null; lastStock: string | null }[] = [
    { name: 'a two-card waste and a two-card stock', state: KING_WITH_PILES, lastWaste: id('spades', 3), lastStock: id('diamonds', 6) },
    // Each pile's last card is its FIRST (delay 0 for the waste's): the blank timer used to fire 20ms in, ~70ms before the ghost is drawn.
    { name: 'a single-card waste (its last card leaves at delay 0) and a single-card stock', state: () => board(card('clubs', 13), [card('spades', 2)], [card('diamonds', 6, false)]), lastWaste: id('spades', 2), lastStock: id('diamonds', 6) },
    { name: 'a waste and no stock', state: () => board(card('clubs', 13), [card('spades', 2), card('spades', 3)]), lastWaste: id('spades', 3), lastStock: null },
    { name: 'a stock and no waste', state: () => board(card('clubs', 13), [], [card('hearts', 5, false), card('diamonds', 6, false)]), lastWaste: null, lastStock: id('diamonds', 6) }
  ]

  it.each(cases)('$name: neither pile is ever blank before its last ghost is up, and both are blank afterwards', async ({ state, lastWaste, lastStock }) => {
    await mount(state())
    mockDealTakeoffLatencyMs = MOUNT_MS
    await winAndStartSweep()

    const lastLanding = MOUNT_MS + 3 * STAGGER_MS + DEAL_SPRING_MS
    let wasteBlankedAt: number | null = null
    let stockBlankedAt: number | null = null
    for (let t = 0; t <= lastLanding; t += STEP_MS) {
      const wasteEmpty = wasteShows() === 'empty'
      const stockEmpty = stockShows() === 'empty'
      // A pile blanks only once its last card has left - a pile with no leftover card at all (null) is empty from the start.
      if (lastWaste) expect(wasteEmpty && !mockLog.takenOff.includes(lastWaste)).toBe(false)
      if (lastStock) expect(stockEmpty && !mockLog.takenOff.includes(lastStock)).toBe(false)
      if (wasteEmpty && wasteBlankedAt === null) wasteBlankedAt = t
      if (stockEmpty && stockBlankedAt === null) stockBlankedAt = t
      await flush(STEP_MS)
    }

    expect(wasteShows()).toBe('empty')
    expect(stockShows()).toBe('empty')
    // ...and they do blank promptly after it (not only when the whole sweep ends): the last card takes off at MOUNT_MS + its own delay.
    if (lastWaste) expect(wasteBlankedAt!).toBeGreaterThanOrEqual(MOUNT_MS)
    if (lastStock) expect(stockBlankedAt!).toBeGreaterThanOrEqual(MOUNT_MS)
    if (lastStock) expect(stockBlankedAt!).toBeLessThan(lastLanding - DEAL_SPRING_MS / 2) // well before the sweep is over
  })

  it('blanks each pile a beat after ITS last card leaves, whatever the mount latency', async () => {
    await mount(KING_WITH_PILES())
    mockDealTakeoffLatencyMs = MOUNT_MS
    await winAndStartSweep()

    // The waste's last card (its second) leaves at MOUNT_MS + 35ms; the stock's (its fourth card) at MOUNT_MS + 105ms.
    await flush(MOUNT_MS + STAGGER_MS - STEP_MS)
    expect(wasteShows()).toBe(id('spades', 3))
    await flush(STEP_MS + BLANK_LAG_MS + STEP_MS)
    expect(wasteShows()).toBe('empty')
    expect(stockShows()).toBe(id('diamonds', 6))
    await flush(2 * STAGGER_MS)
    expect(stockShows()).toBe('empty')
  })

  it("waits SWEEP_PILE_BLANK_LAG_MS after the take-off itself: the ghost's first frame is up before the real top card goes, never the other way round", async () => {
    await mount(KING_WITH_PILES())
    mockDealTakeoffLatencyMs = MOUNT_MS
    await winAndStartSweep()

    // One millisecond of fake time per act(), so the moment each pile blanks is read exactly (the 10ms steps elsewhere are too coarse for a 20ms lag).
    let wasteBlankedAt: number | null = null
    let stockBlankedAt: number | null = null
    for (let t = 0; t < MOUNT_MS + 4 * STAGGER_MS + 200 && (wasteBlankedAt === null || stockBlankedAt === null); t++) {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1)
      })
      if (wasteBlankedAt === null && wasteShows() === 'empty') wasteBlankedAt = Date.now()
      if (stockBlankedAt === null && stockShows() === 'empty') stockBlankedAt = Date.now()
    }

    expect(wasteBlankedAt).not.toBeNull()
    expect(stockBlankedAt).not.toBeNull()
    expect(wasteBlankedAt! - mockLog.takenOffAt[id('spades', 3)]).toBeGreaterThanOrEqual(BLANK_LAG_MS)
    expect(stockBlankedAt! - mockLog.takenOffAt[id('diamonds', 6)]).toBeGreaterThanOrEqual(BLANK_LAG_MS)
    // ...but only a beat: the pile is not left showing a card that has already flown for longer than a frame or two.
    expect(wasteBlankedAt! - mockLog.takenOffAt[id('spades', 3)]).toBeLessThanOrEqual(BLANK_LAG_MS + 2 * STEP_MS)
    expect(stockBlankedAt! - mockLog.takenOffAt[id('diamonds', 6)]).toBeLessThanOrEqual(BLANK_LAG_MS + 2 * STEP_MS)
  })

  it('a skip tap before any card has taken off still reports every take-off and empties both piles at once', async () => {
    await mount(KING_WITH_PILES())
    mockDealTakeoffLatencyMs = 400 // nothing has taken off yet when the skip lands
    await winAndStartSweep()
    await flush(STAGGER_MS)
    expect(mockLog.takenOff).toEqual([])

    await act(async () => {
      mockDeal.skip()
    })
    expect(mockLog.takenOff).toEqual([id('spades', 2), id('spades', 3), id('hearts', 5), id('diamonds', 6)]) // every card is reported taken off (once each)
    expect(stockShows()).toBe('empty')
    expect(wasteShows()).toBe('empty')
    expect(discardPainted()).toBe(id('diamonds', 6))
    expect(mockLog.landed[0]).toHaveLength(4)
  })

  it('a New Game before the last card has taken off leaves no blank pending for the new board', async () => {
    await mount(KING_WITH_PILES())
    mockDealTakeoffLatencyMs = MOUNT_MS
    await winAndStartSweep()
    await flush(MOUNT_MS + STAGGER_MS + STEP_MS) // the waste's last card has taken off: its blank timer is armed

    await press('new-game')
    await flush(3000)
    const fresh = PyramidController.newGame(mockSeed)
    expect(stockShows()).toBe(fresh.stock[fresh.stock.length - 1].id) // the new deal's stock is untouched by the old sweep
    expect(wasteShows()).toBe('empty')
  })
})

describe('Pyramid screen - the win sweep is timed to fit its wait', () => {
  it('the worst case - 24 leftover cards, the last removal flying its longest, every measurement slow - reveals well inside the default 2.5s max wait', async () => {
    await mount(fullDeckBoard(12, 12))
    mockMeasureMs = 30
    mockFlightMs = SLOWEST_FLIGHT_MS // the longest flight: a distance-scaled spring's ceiling, plus the spring's real end
    const t0 = Date.now()

    await press(`pyramid-${id('clubs', 13)}`)
    for (let waited = 0; !screen.queryByTestId('win-banner') && waited < 6000; waited += STEP_MS) await flush(STEP_MS)
    const revealedAfter = mockLog.bannerAt! - t0
    await flush(100) // the cascade measures the discard (30ms) before it starts

    expect(mockLog.deals[0]).toHaveLength(24)
    expect(mockLog.dealPendingAtCascade).toBe(0)
    // measure (30) + King (the slowest flight) + sweep measure (30) + 23 * 35 + 280 + hold 400 = ~2.2s: not the fallback timer's doing.
    expect(revealedAfter).toBeLessThan(SWEEP_WIN_REVEAL_MAX_WAIT_MS - 400)
    expect(revealedAfter).toBeGreaterThanOrEqual(30 + SLOWEST_FLIGHT_MS + 30 + 23 * STAGGER_MS + DEAL_SPRING_MS + HOLD_MS)
  })

  it('hands ONE chain of all 52 cards to the cascade, head on top of the discard, its per-card delay capped so the whole chain stays one snake', async () => {
    const state = fullDeckBoard(12, 12)
    await mount(state)
    await winAndStartSweep()
    await flush(4000)

    const chains = mockLog.chains!
    expect(chains).toHaveLength(1)
    expect(chains[0].ids).toHaveLength(52)
    expect(new Set(chains[0].ids).size).toBe(52) // every card, once
    // What the discard array holds after the win: what was discarded, the King, the waste (bottom-to-top), the stock (bottom-to-top).
    const won = PyramidController.tryMove(state, { from: { zone: 'pyramid', index: 0 }, to: { zone: 'pyramid', index: 0 }, count: 1 })!
    expect(chains[0].ids).toEqual(won.discard.map((c) => c.id).reverse())
    expect(chains[0].ids[0]).toBe(state.stock[state.stock.length - 1].id) // the head is the card on top of the pile: the last one dealt onto it
    expect(chains[0].origin.x).toBe(100)
    const perCard = chains[0].segmentDelayMs!
    expect(perCard).toBeCloseTo(CHAIN_MAX_SPAN_MS / 51, 5)
    expect(perCard * 51).toBeLessThanOrEqual(CHAIN_MAX_SPAN_MS + 1e-6) // the whole head-to-tail span
  })
})

describe('Pyramid screen - a winning pair', () => {
  it('sends both cards to the discard independently, keeps the rest of the waste and the stock in place until they land, deals the leftovers, then celebrates', async () => {
    await mount(PAIR_WITH_WASTE())

    await press(`pyramid-${id('clubs', 12)}`) // select the Queen
    await press('waste-top') // ...and pair it with the Ace on the waste
    await flush(10)

    expect(mockRecordWon).toHaveBeenCalledTimes(1)
    expect(flyingGhosts().sort()).toEqual([`ghost-${id('clubs', 12)}`, `ghost-${id('hearts', 1)}`].sort()) // both cards of the pair are in the air, each its own ghost
    expect(text('discard-flying')).toBe('true')
    expect(wasteShows()).toBe(id('spades', 2)) // the card under the Ace - swept by the win, not flown yet - is still showing
    expect(stockShows()).toBe(id('diamonds', 6))
    expect(mockLog.deals).toHaveLength(0)
    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(screen.queryByTestId('fireworks')).toBeNull()
    expect(mockLog.chains).toBeNull()

    // both land (each on its own distance-scaled timer) - stop at the first moment nothing is left in the air
    for (let waited = 0; flyingGhosts().length > 0 && waited < 2000; waited += STEP_MS) await flush(STEP_MS)
    expect(flyingGhosts()).toEqual([])
    await flush(STEP_MS * 2) // the leftovers (the waste's 2, the stock's 6) are dealt after the pair
    expect(mockLog.deals).toHaveLength(1)
    expect(mockLog.deals[0].map((e) => e.cardId)).toEqual([id('spades', 2), id('diamonds', 6)])
    expect(mockLog.deals[0].map((e) => e.from.x)).toEqual([300, 200])
    expect(discardPainted()).toBe(id('hearts', 1)) // until they land the pile shows the pair's last card
    expect(screen.queryByTestId('win-banner')).toBeNull()

    await flush(DEAL_SPRING_MS + STAGGER_MS + 50)
    expect(discardPainted()).toBe(id('diamonds', 6))
    expect(screen.queryByTestId('win-banner')).toBeNull() // ...the finished pile holds for a beat...

    await flush(HOLD_MS + 50)
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(screen.getByTestId('fireworks')).toBeTruthy()
    expect(stockShows()).toBe('empty')
    expect(wasteShows()).toBe('empty')
    expect(mockLog.chains).toHaveLength(1)
    expect(mockLog.chains![0].ids).toEqual([id('diamonds', 6), id('spades', 2), id('hearts', 1), id('clubs', 12), id('spades', 4), id('spades', 9)])
  })

  it('still flies when the selected card cannot be found in the registry: it starts from its own slot instead of vanishing', async () => {
    await mount(PAIR_WITH_WASTE())
    mockUnregistered.add(id('clubs', 12)) // the Queen, selected on the previous tap, is not registered at the instant it is measured

    await press(`pyramid-${id('clubs', 12)}`)
    await press('waste-top')
    await flush(10)

    expect(flyingGhosts()).toContain(`ghost-${id('clubs', 12)}`) // it is in the air (from its own triangle cell), not gone
    expect(flyingGhosts()).toContain(`ghost-${id('hearts', 1)}`)
  })
})

describe('Pyramid screen - New Game in the middle of the sweep', () => {
  it('silences the deal, leaves no stuck ghost, hidden pile or leaked claim, and the new game plays normally', async () => {
    await mount(KING_WITH_PILES())
    await winAndStartSweep()
    await flush(STAGGER_MS * 2) // partway through the sweep
    expect(mockLog.landed[0]).toHaveLength(0)

    await press('new-game')
    await flush(10)
    expect(mockLog.cancelled).toBe(1) // the sweep's deal was silenced
    const fresh = PyramidController.newGame(mockSeed)
    expect(stockShows()).toBe(fresh.stock[fresh.stock.length - 1].id) // the new deal, not the old board's piles
    expect(wasteShows()).toBe('empty')
    expect(text('discard-top')).toBe('empty')
    expect(text('discard-flying')).toBe('false')
    expect(flyingGhosts()).toEqual([])

    // The old sweep never lands anything into the new game, and no celebration starts for the abandoned win.
    await flush(3000)
    expect(mockLog.landed[0]).toHaveLength(0)
    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(mockLog.chains).toBeNull()
    expect(mockRecordWon).toHaveBeenCalledTimes(1)

    // No claim was leaked: a draw on the new game flies and lands, and undo - refused while ANY claim is outstanding - works.
    await press('stock-top')
    await flush(FLIGHT_MS + 100)
    expect(wasteShows()).toBe(fresh.stock[fresh.stock.length - 1].id)
    await press('undo')
    await flush(FLIGHT_MS + 100)
    expect(wasteShows()).toBe('empty')
  })

  it('a New Game tapped while the King is still flying (before the sweep exists as a deal) leaves nothing claimed either', async () => {
    await mount(KING_WITH_PILES())
    mockFlightMs = 300
    await press(`pyramid-${id('clubs', 13)}`)
    await flush(50) // the King in the air, the sweep claimed but waiting

    await press('new-game')
    await flush(3000)
    expect(mockLog.deals.filter((deal) => deal.length === 4)).toHaveLength(0) // the sweep never dealt anything
    expect(mockLog.chains).toBeNull()

    const fresh = PyramidController.newGame(mockSeed)
    await press('stock-top')
    await flush(mockFlightMs + 100)
    expect(wasteShows()).toBe(fresh.stock[fresh.stock.length - 1].id)
    await press('undo')
    await flush(mockFlightMs + 100)
    expect(wasteShows()).toBe('empty') // undo not refused: no claim leaked
  })
})

describe('Pyramid screen - a card is never left without its own flight', () => {
  it('a drawn card whose waste view is not registered yet still flies to the waste slot instead of appearing there', async () => {
    await mount(KING_WITH_PILES())
    mockUnregistered.add(id('diamonds', 6)) // the card about to be drawn

    await press('stock-top')
    await flush(10)

    expect(mockLog.shown).toEqual([id('diamonds', 6)])
    expect(mockLog.inAir).toBe(1) // the ghost flies (its landing measured from the waste slot) - it was not just hidden

    await flush(FLIGHT_MS)
    expect(mockLog.inAir).toBe(0)
    expect(wasteShows()).toBe(id('diamonds', 6))
  })
})

describe('Pyramid screen - every leftover still flies when a pile cannot be measured', () => {
  async function winWithKing(unmeasurable: string[]) {
    await mount(KING_WITH_PILES())
    unmeasurable.forEach((pile) => mockUnmeasurable.add(pile))
    await press(`pyramid-${id('clubs', 13)}`)
    await flush(FLIGHT_MS + DEAL_SPRING_MS + 3 * STAGGER_MS + HOLD_MS + 150)
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    return mockLog.chains!
  }

  it("deals the stock's cards from the waste slot when the stock cannot be measured: all four still fly, one chain of every card follows", async () => {
    const chains = await winWithKing(['stock'])

    expect(mockLog.deals[0].map((e) => e.cardId)).toEqual([id('spades', 2), id('spades', 3), id('hearts', 5), id('diamonds', 6)])
    expect(mockLog.deals[0].map((e) => e.from.x)).toEqual([300, 300, 300, 300]) // no card teleports: the stock's leave from the waste instead
    expect(chains).toHaveLength(1)
    expect(chains[0].ids).toHaveLength(7)
  })

  it("deals the waste's cards from the stock slot when the waste cannot be measured", async () => {
    const chains = await winWithKing(['waste'])

    expect(mockLog.deals[0].map((e) => e.from.x)).toEqual([200, 200, 200, 200])
    expect(chains).toHaveLength(1)
    expect(chains[0].ids).toHaveLength(7)
  })

  it('with neither pile measurable no card can fly: the leftovers simply land, the piles empty, and the celebration still starts with every card in one chain', async () => {
    const chains = await winWithKing(['stock', 'waste'])

    expect(mockLog.deals).toHaveLength(0) // nothing to fly from - none is invented
    expect(stockShows()).toBe('empty')
    expect(wasteShows()).toBe('empty')
    expect(text('discard-flying')).toBe('false') // and no leftover is left marked as in the air (it would hide the pile's real top for good)
    expect(chains).toHaveLength(1)
    expect(chains[0].ids).toEqual([id('diamonds', 6), id('hearts', 5), id('spades', 3), id('spades', 2), id('clubs', 13), id('spades', 4), id('spades', 9)])
  })
})

describe('Pyramid screen - a flight aims at the card the registry can see, not at the slot behind it', () => {
  // A distinct point per card: neither the registry default (10, 10) nor any plain-view point (5 / 100 / 200 / 300), so a flight's
  // endpoint says which lookup produced it.
  const DRAWN_POINT = { x: 77, y: 88 }

  it('a drawn card flies to its own registered position, not to the waste slot', async () => {
    await mount(KING_WITH_PILES())
    mockRegistryPoints.set(id('diamonds', 6), DRAWN_POINT)

    await press('stock-top')
    await flush(10)

    expect(mockLog.shown).toEqual([id('diamonds', 6)])
    expect(mockLog.shownFrom).toEqual([{ x: 200, y: 5 }]) // it took off from the stock slot...
    expect(mockLog.flown).toEqual([DRAWN_POINT]) // ...and landed on the card the registry found (the waste slot is at x 300)
  })

  it('undoing a draw takes the card off from its own registered position, not from the waste slot', async () => {
    await mount(KING_WITH_PILES())
    mockRegistryPoints.set(id('diamonds', 6), DRAWN_POINT)
    await press('stock-top')
    await flush(FLIGHT_MS + 50)
    expect(wasteShows()).toBe(id('diamonds', 6))
    mockLog.shownFrom = []
    mockLog.flown = []

    await press('undo')
    await flush(10)

    expect(mockLog.shownFrom).toEqual([DRAWN_POINT])
    expect(mockLog.flown).toEqual([{ x: 200, y: 5 }]) // and it flies back to the stock slot
  })

  it('an unregistered card falls back to the waste slot for both', async () => {
    await mount(KING_WITH_PILES())
    mockRegistryPoints.set(id('diamonds', 6), DRAWN_POINT)
    mockUnregistered.add(id('diamonds', 6))
    await press('stock-top')
    await flush(FLIGHT_MS + 50)
    expect(mockLog.flown).toEqual([{ x: 300, y: 5 }])
    mockLog.shownFrom = []

    await press('undo')
    await flush(10)

    expect(mockLog.shownFrom).toEqual([{ x: 300, y: 5 }])
  })
})

describe('winHoldView', () => {
  const entry = (state: PyramidState, cards: { cardId: string; zone: 'pyramid' | 'waste' }[]) => ({ state, removedCards: cards.map((c) => ({ cardId: c.cardId, ref: { zone: c.zone, index: 0 } })) })
  const won = (before: PyramidState, removed: Card[]): PyramidState => ({ ...before, pyramid: before.pyramid.map(() => null), stock: [], waste: [], discard: [...before.discard, ...removed, ...before.waste.filter((c) => !removed.includes(c)), ...before.stock] })

  it('splits a swept discard back into what was kept, and the waste and stock that were swept', () => {
    const before = KING_WITH_PILES()
    const king = before.pyramid[0]!
    const view = winHoldView(won(before, [king]), entry(before, [{ cardId: king.id, zone: 'pyramid' }]))
    expect(view!.discardCards.map((c) => c.id)).toEqual([id('spades', 9), id('spades', 4), id('clubs', 13)])
    expect(view!.wasteCards.map((c) => c.id)).toEqual([id('spades', 2), id('spades', 3)])
    expect(view!.stockCards.map((c) => c.id)).toEqual([id('hearts', 5), id('diamonds', 6)])
  })

  it('does not count a waste card the pair itself consumed as swept', () => {
    const before = PAIR_WITH_WASTE()
    const queen = before.pyramid[0]!
    const ace = before.waste[1]
    const view = winHoldView(
      won(before, [queen, ace]),
      entry(before, [
        { cardId: queen.id, zone: 'pyramid' },
        { cardId: ace.id, zone: 'waste' }
      ])
    )
    expect(view!.discardCards.map((c) => c.id)).toEqual([id('spades', 9), id('spades', 4), id('clubs', 12), id('hearts', 1)])
    expect(view!.wasteCards.map((c) => c.id)).toEqual([id('spades', 2)])
    expect(view!.stockCards.map((c) => c.id)).toEqual([id('diamonds', 6)])
  })

  it('gives up (null) when there is no removal record or the counts do not add up', () => {
    const before = KING_WITH_PILES()
    const king = before.pyramid[0]!
    expect(winHoldView(won(before, [king]), undefined)).toBeNull()
    expect(winHoldView(won(before, [king]), { state: before, removedCards: null })).toBeNull()
    expect(winHoldView({ ...won(before, [king]), discard: [] }, entry(before, [{ cardId: king.id, zone: 'pyramid' }]))).toBeNull()
  })
})
