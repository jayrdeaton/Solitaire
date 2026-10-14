import { act, fireEvent, render, screen } from '@testing-library/react-native'

import { FLIGHT_SPRING, springSettleMs } from '@/components/dragdrop/dragSpring'
import { Card, Suit } from '@/engine/types'
import PyramidScreen, { DEFER_MAX_WAIT_MS, topLandedCard } from '@/games/pyramid/PyramidScreen'
import { PyramidController, PyramidState } from '@/games/pyramid/rules'
import { WIN_REVEAL_HOLD_MS } from '@/games/shared/useWinReveal'

import { resetGameInProgress, seedGameInProgress } from '../../../testUtils/gameInProgressStore'

// ---------------------------------------------------------------------------------------------------------------------
// RAPID-INPUT tests for the REAL PyramidScreen (same harness approach as pyramidScreenWin.test.tsx: real rules, flight
// concurrency, undo stack, session and pair-flight overlay; stand-ins only for the native views, the gesture-driven cards and
// the ghost layer). What is new here is a controllable MEASUREMENT LATENCY: on a device every measureInWindow is an async round
// trip, and a fast player's next tap, draw or drop lands inside it. Without latency each move would finish inside its own press
// and nothing could ever overlap. Every scenario below is one that used to corrupt the game or make a card vanish:
//   - a second pair removed while the first pair's two ghosts were still in the air REPLACED the first flight (its ghosts
//     vanished, its landing was dropped, its claim on the flight count was never settled),
//   - a move computed BEFORE the measurement awaits was committed AFTER them, overwriting whatever committed in between (a
//     removal, a draw), and a double-tap on a King removed it twice,
//   - overlapping flights to the discard each landed on a stale pile until the last one arrived,
//   - overlapping DRAW flights each vanished onto the stale waste card from before the whole stream,
//   - undoing a removal committed the reverted board a frame or two BEFORE its ghosts mounted (the restored cards were visible nowhere),
//   - a drawn card tapped/dragged while its own draw ghost was still travelling was shown twice; a draw racing a recycle flight
//     emerged from a frozen-empty stock slot; undoing a draw showed the returned card in the stock at once,
//   - a New Game left queued/airborne flights' ghosts flying across (or mounted over) the freshly dealt board,
//   - several taps parked on the same draw landing all resumed together: the first became a recycle and the next drew from the freshly
//     recycled stock while the recycle's group ghost was still flying into it (a parked action must re-check its gate on resume),
//   - a card tapped during a deferred pair's wait was selected as "the waste top", and once the pair removed that card the selection
//     silently pointed at (and highlighted) the card that had been UNDER it.
// ---------------------------------------------------------------------------------------------------------------------

const FLIGHT_MS = 80
let mockFlightMs = FLIGHT_MS
/** How long every measurement (registry, plain view, the tapped card's own measure, the drop hit test) takes - the window in which other input arrives. */
let mockMeasureMs = 0
let mockHitTestMs = 0
const MEAS = 30
/** How long a pair-flight ghost stays up, however far it goes: the very timer PyramidScreen's FlyingPairCard arms (dragSpring.ts's springSettleMs of
 * FLIGHT_SPRING, the one flight time) - derived, so re-pacing the flights (FLIGHT_TIME_SCALE) re-times every wait below with it. */
const PAIR_FLIGHT_MS = springSettleMs(FLIGHT_SPRING)

interface MockLog {
  /** Every ghost.show() - one per single-card (King, draw) or grouped (recycle) flight the screen started. */
  shown: string[]
  /** Where every single-card flyTo() was aimed. */
  flown: { x: number; y: number }[]
  /** Single-card flyTo() calls still waiting to land. */
  inAir: number
  /** How many times a dragged ghost was retired (hide()). */
  hidden: number
  /** What each drop callback resolved to (true: applied, false: the card snaps back). */
  drops: Promise<boolean>[]
  /** How many single-card flights were still in the air at each ghost.show() (same order as `shown`). */
  airAtShow: number[]
}
const mockLog: MockLog = { shown: [], flown: [], inAir: 0, hidden: 0, drops: [], airAtShow: [] }
/** Card ids whose registry lookup fails. */
const mockUnregistered = new Set<string>()
/** A registered card's own point, when a test wants it to differ from the default one (so a flight's distance - and duration - differs). */
const mockRegistryPoints = new Map<string, { x: number; y: number }>()
/** Piles ('discard' | 'stock' | 'waste') whose host view cannot be measured. */
const mockUnmeasurable = new Set<string>()
/** How many times the "that didn't work" sound played - an illegal pairing (a tap into a selection that no longer makes sense). */
const mockInvalid = { count: 0 }
let mockDropTarget: { zone: string; index: number } | null = null
let mockDealLands = false
let mockSeed = 1

const mockLatency = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve())

/** A flight handle like the real one's: hide() retires it AND runs its pending completion (DragGhostLayer's flushPendingSettle). */
function mockMakeFlight() {
  let pending: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    hide: () => {
      mockLog.hidden += 1
      if (timer) clearTimeout(timer)
      timer = null
      if (pending) {
        const done = pending
        pending = null
        mockLog.inAir -= 1
        done()
      }
    },
    originX: { value: 10 },
    originY: { value: 10 },
    dx: { value: 0 },
    dy: { value: 0 },
    flyTo: (x: number, y: number, onDone?: () => void) => {
      mockLog.flown.push({ x, y })
      mockLog.inAir += 1
      pending = onDone ?? (() => {})
      timer = setTimeout(() => {
        pending = null
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
  show: (spec: { cards: { id: string }[] }) => {
    mockLog.shown.push(spec.cards.map((c) => c.id).join('+'))
    mockLog.airAtShow.push(mockLog.inAir)
    return mockMakeFlight()
  }
}
const mockDealer = {
  start: (entries: { cardId: string }[], _cardWidth: number, onCardLanded: (cardId: string) => void) => {
    if (mockDealLands) entries.forEach((e) => onCardLanded(e.cardId))
  },
  cancel: () => {}
}
const mockDropZones = {
  register: () => {},
  unregister: () => {},
  hitTest: async () => {
    await mockLatency(mockHitTestMs)
    return mockDropTarget
  }
}

jest.mock('@/redux/store', () => require('../../../testUtils/gameInProgressStore').storeModule)
jest.mock('@/components/dragdrop/DragGhostLayer', () => ({ DragGhostProvider: ({ children }: { children: unknown }) => children, useDragGhost: () => mockGhost }))
jest.mock('@/components/dragdrop/DropZoneRegistry', () => ({ useDropZoneRegistry: () => mockDropZones }))
jest.mock('@/components/dealing/DealLayer', () => ({ DealProvider: ({ children }: { children: unknown }) => children, useDealAnimator: () => mockDealer }))
jest.mock('@/components/winning/WinCascadeLayer', () => ({ WinCascadeProvider: ({ children }: { children: unknown }) => children, WinCascadeGhosts: () => null, useWinCascade: () => ({ startChains: () => {}, clear: () => {} }) }))
jest.mock('@/engine/rng', () => ({ ...jest.requireActual('@/engine/rng'), randomSeed: () => mockSeed }))
// Every plain container measures somewhere different (each stand-in below tags its own host view), so a flight's endpoint says which lookup produced it.
jest.mock('@/components/dealing/measureView', () => ({
  measureView: async (view: { __pile?: string } | null) => {
    await mockLatency(mockMeasureMs)
    if (!view) return null
    if (view.__pile && mockUnmeasurable.has(view.__pile)) return null
    return { x: view.__pile === 'discard' ? 100 : view.__pile === 'stock' ? 200 : view.__pile === 'waste' ? 300 : 5, y: 5 }
  }
}))
jest.mock('@tastic/core', () => ({ ...jest.requireActual('@tastic/core'), RotationAwareStatusBar: () => null }))
jest.mock('@/components/useCardSounds', () => ({ useCardSoundEffects: () => ({ playCardSound: () => {}, playInvalidSound: () => mockInvalid.count++, hapticCard: () => {}, hapticInvalid: () => {} }) }))
jest.mock('@rific/feedback-press', () => ({ useVibration: () => ({ short: () => {}, selection: () => {} }) }))
jest.mock('@rific/toaster', () => ({ useToast: () => ({ info: () => {} }) }))
jest.mock('@tastic/sprites/fireworks', () => ({ Fireworks: () => null }))
jest.mock('@/games/shared/WinBanner', () => {
  const { Text: MockText } = require('react-native')
  return { WinBanner: () => <MockText testID='win-banner'>won</MockText> }
})
jest.mock('@/stores/gameStats', () => ({ useGameStats: () => ({ recordDealWon: () => {}, recordDealAbandoned: () => {}, recordHintUsed: () => {} }) }))
jest.mock('@/stores/lastActiveGame', () => ({ useLastActiveGame: () => ({ setLastActiveGame: () => {}, clearLastActiveGame: () => {} }) }))
jest.mock('@/components/theme', () => {
  const actual = jest.requireActual('@/components/theme')
  return { ...actual, useTableColors: () => actual.lightColors }
})
jest.mock('@/components/PlayingCard', () => {
  const { View: MockView } = require('react-native')
  const { useEffect: useMockEffect } = require('react')
  // A face reports its bitmap painted once mounted, as a loaded Image does - a pair's ghosts are invisible until then (see
  // cardFacePaint.ts's useGhostPaintGate).
  function MockPlayingCard({ card, testID, onFacePainted }: { card: { id: string }; testID?: string; onFacePainted?: () => void }) {
    useMockEffect(() => onFacePainted?.(), [onFacePainted])
    return <MockView testID={testID ?? `ghost-${card.id}`} />
  }
  return { PlayingCard: MockPlayingCard, EmptySlot: () => <MockView /> }
})
jest.mock('@/components/dragdrop/DropZone', () => ({ DropZone: ({ children }: { children: unknown }) => children }))
jest.mock('@/components/dragdrop/DraggableCard', () => {
  const { Pressable: MockPressable, View: MockView } = require('react-native')
  return {
    // `pyramid-<id>` taps the card; `drop-<id>` releases a drag of it (the screen decides where it lands via hitTest).
    DraggableCard: ({ card, hidden, selected, onPress, onDrop }: { card: { id: string }; hidden?: boolean; selected?: boolean; onPress: (measure: () => Promise<{ x: number; y: number }>) => void; onDrop: (x: number, y: number, flight: unknown) => Promise<boolean> }) => (
      <MockView>
        <MockPressable
          testID={`pyramid-${card.id}`}
          accessibilityHint={hidden ? 'hidden' : 'visible'}
          accessibilityLabel={selected ? 'selected' : 'idle'}
          onPress={() =>
            onPress(async () => {
              await mockLatency(mockMeasureMs)
              return mockRegistryPoints.get(card.id) ?? { x: 10, y: 10 }
            })
          }
        />
        <MockPressable testID={`drop-${card.id}`} onPress={() => mockLog.drops.push(onDrop(1, 1, mockMakeFlight()))} />
      </MockView>
    )
  }
})
/** A ref callback that both hands the screen its ref and tags the host view with which pile it is (see measureView above). */
const mockTagRef = (name: string, ref: { current: unknown } | undefined) => (el: { __pile?: string } | null) => {
  if (el) el.__pile = name
  if (ref) ref.current = el
}
jest.mock('@/components/StockWaste', () => {
  const { Pressable: MockPressable, Text: MockText, View: MockView } = require('react-native')
  return {
    StockWaste: ({ stockTopCard, wasteTop, wasteSelected, wasteHiddenCount, settledWasteTop, stockHidden, onDrawStock, onWastePress, onWasteDrop, stockRef, wasteRef }: { stockTopCard?: { id: string }; wasteTop?: { id: string }; wasteSelected?: boolean; wasteHiddenCount?: number; settledWasteTop?: { id: string } | null; stockHidden?: boolean; onDrawStock: () => void; onWastePress: (measure: () => Promise<{ x: number; y: number }>) => void; onWasteDrop: (x: number, y: number, flight: unknown) => Promise<boolean>; stockRef: { current: unknown }; wasteRef: { current: unknown } }) => (
      <MockView>
        <MockView ref={mockTagRef('stock', stockRef)} collapsable={false} />
        <MockView ref={mockTagRef('waste', wasteRef)} collapsable={false} />
        <MockText testID='stock-top' onPress={onDrawStock}>
          {stockTopCard ? stockTopCard.id : 'empty'}
        </MockText>
        <MockText
          testID='waste-top'
          onPress={
            wasteTop
              ? () =>
                  onWastePress(async () => {
                    await mockLatency(mockMeasureMs)
                    return { x: 10, y: 10 }
                  })
              : undefined
          }
        >
          {wasteTop ? wasteTop.id : 'empty'}
        </MockText>
        <MockText testID='waste-hidden'>{String(wasteHiddenCount ?? 0)}</MockText>
        <MockText testID='waste-selected'>{String(!!wasteSelected)}</MockText>
        {/* What the real StockWaste paints UNDER the flying card(s) while the waste top is hidden: the screen's settledWasteTop when it passes one ('undefined': it passes none, the frozen copy would be used). */}
        <MockText testID='waste-settled'>{settledWasteTop === undefined ? 'undefined' : settledWasteTop === null ? 'null' : settledWasteTop.id}</MockText>
        <MockText testID='stock-hidden'>{String(!!stockHidden)}</MockText>
        <MockPressable testID='waste-drop' onPress={() => mockLog.drops.push(onWasteDrop(1, 1, mockMakeFlight()))} />
      </MockView>
    )
  }
})
// A stand-in that paints exactly what the real DiscardCell does (see its own test): the real top card, or - while cards are flying
// to it - what sits UNDER the ghosts: `settledCard` when the screen passes one, else the frozen copy of the pre-flight top.
jest.mock('@/games/shared/DiscardCell', () => {
  const { Text: MockText, View: MockView } = require('react-native')
  const { useFrozenWhileHidden } = jest.requireActual('@/components/useFrozenWhileHidden')
  return {
    DiscardCell: ({ card, isFlyingHere, settledCard, viewRef }: { card?: { id: string }; isFlyingHere: boolean; settledCard?: { id: string } | null; viewRef: { current: unknown } }) => {
      const frozenCopy = useFrozenWhileHidden(card, isFlyingHere)
      const under = settledCard === undefined ? frozenCopy : settledCard
      const painted = isFlyingHere ? under : card
      return (
        <MockView ref={mockTagRef('discard', viewRef)} collapsable={false}>
          <MockText testID='discard-painted'>{painted ? painted.id : 'empty'}</MockText>
          <MockText testID='discard-flying'>{String(isFlyingHere)}</MockText>
        </MockView>
      )
    }
  }
})
jest.mock('@/components/GameChrome', () => {
  const { Pressable: MockPressable, Text: MockText, View: MockView } = require('react-native')
  return {
    GAME_CONTENT_PADDING: 6,
    GameChrome: ({ children, onUndo, onNewGame, undoDisabled, movesCount }: { children: unknown; onUndo: () => void; onNewGame: () => void; undoDisabled: boolean; movesCount: number }) => (
      <MockView>
        <MockPressable testID='undo' onPress={onUndo} />
        <MockPressable testID='new-game' onPress={onNewGame} />
        <MockText testID='undo-disabled'>{String(undoDisabled)}</MockText>
        <MockText testID='moves'>{String(movesCount)}</MockText>
        {children}
      </MockView>
    )
  }
})

// ------------------------------------------------------------------------------------------------ boards

const card = (suit: Suit, rank: number, faceUp = true): Card => ({ id: `${suit}-${rank}-0`, suit, rank, faceUp }) as Card
const id = (suit: Suit, rank: number) => `${suit}-${rank}-0`

const Q = card('clubs', 12)
const ACE = card('hearts', 1)
const SEVEN = card('spades', 7)
const SIX = card('diamonds', 6)
const KING = card('diamonds', 13)
const TWO = card('clubs', 2) // never pairs with anything used here: it keeps the pyramid from emptying (no win)

// The bottom row (flat indices 21..27) is always exposed.
const IDX = { q: 21, ace: 22, seven: 23, six: 24, king: 25, two: 27 }

function board(cells: [number, Card][], opts: { stock?: Card[]; waste?: Card[] } = {}): PyramidState {
  const pyramid: (Card | null)[] = Array.from({ length: 28 }, () => null)
  cells.forEach(([index, c]) => (pyramid[index] = c))
  return { pyramid, stock: opts.stock ?? [], waste: opts.waste ?? [], discard: [card('spades', 9), card('spades', 4)], removedCount: 2 }
}
/** Two independent pairs (Q+A, 7+6), a King, and a 2 to keep the triangle from emptying. */
const TWO_PAIRS = (opts: { stock?: Card[]; waste?: Card[] } = {}) =>
  board(
    [
      [IDX.q, Q],
      [IDX.ace, ACE],
      [IDX.seven, SEVEN],
      [IDX.six, SIX],
      [IDX.king, KING],
      [IDX.two, TWO]
    ],
    opts
  )
const PRE_STREAM_TOP = id('spades', 4)

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
const wasteShows = () => text('waste-top')
const discardPainted = () => text('discard-painted')
const moves = () => text('moves')
const flyingGhosts = () =>
  screen
    .queryAllByTestId(/^ghost-/)
    .map((n) => (n.props.testID as string).replace('ghost-', ''))
    .sort()
const inPyramid = (c: Card) => screen.queryByTestId(`pyramid-${c.id}`) !== null
/** Whether the pyramid card is drawn selected (false too when it is gone). */
const pyramidSelected = (c: Card) => screen.queryByTestId(`pyramid-${c.id}`)?.props.accessibilityLabel === 'selected'
const ids = (...cards: Card[]) => cards.map((c) => c.id).sort()

async function press(testID: string) {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID))
  })
}
/** Taps `first` then `second` back to back - the pair completes on the second tap. */
async function pair(first: Card, second: Card) {
  await press(`pyramid-${first.id}`)
  await press(`pyramid-${second.id}`)
}
/** Advances until nothing is left flying (bounded), whatever each flight's own duration is - including a draw that is still being measured
 * before it takes off (its waste top is hidden already) and a stock slot frozen for a flight. */
async function landEverything() {
  for (let waited = 0; (flyingGhosts().length > 0 || mockLog.inAir > 0 || text('discard-flying') === 'true' || text('waste-hidden') !== '0' || text('stock-hidden') === 'true') && waited < 3000; waited += STEP_MS) await flush(STEP_MS)
  await flush(STEP_MS)
}
/** Taps undo and waits out its measurements and flight (a fixed window: there is a stretch, while it measures, with nothing visibly flying yet). */
async function undo() {
  await press('undo')
  await flush(2 * MEAS + PAIR_FLIGHT_MS)
}

beforeEach(() => {
  jest.useFakeTimers()
  mockLog.shown = []
  mockLog.flown = []
  mockLog.inAir = 0
  mockLog.hidden = 0
  mockLog.drops = []
  mockLog.airAtShow = []
  mockUnregistered.clear()
  mockRegistryPoints.clear()
  mockUnmeasurable.clear()
  mockDropTarget = null
  mockInvalid.count = 0
  mockDealLands = false
  mockSeed = 1
  mockFlightMs = FLIGHT_MS
  mockMeasureMs = 0
  mockHitTestMs = 0
})
afterEach(async () => {
  await act(async () => {
    await jest.runOnlyPendingTimersAsync()
  })
  jest.useRealTimers()
  jest.restoreAllMocks()
})

// ------------------------------------------------------------------------------------------------ tests

// Each test starts with no saved games (the store helper is shared across the file).
afterEach(() => resetGameInProgress())

describe('Pyramid screen quick play - pair flights are independent', () => {
  it('a second pair taken while the first pair is still flying: all four ghosts stay in the air, every one lands, nothing is left claimed, and undo works', async () => {
    await mount(TWO_PAIRS())
    mockMeasureMs = MEAS

    await pair(Q, ACE)
    await flush(MEAS) // the first pair commits and its two ghosts take off
    expect(flyingGhosts()).toEqual(ids(Q, ACE))
    await flush(50)
    await pair(SEVEN, SIX)
    await flush(MEAS) // the second pair commits well inside the first pair's flight

    expect(flyingGhosts()).toEqual(ids(Q, ACE, SEVEN, SIX)) // the first pair's ghosts did not vanish when the second took off
    expect(moves()).toBe('2')

    await landEverything()
    expect(flyingGhosts()).toEqual([])
    expect(text('discard-flying')).toBe('false')
    expect(discardPainted()).toBe(SIX.id) // the pile ends on the last card to arrive

    // Nothing is left claimed: undo is not refused (a claim that never settled disables it for the rest of the game).
    await undo()
    expect(inPyramid(SEVEN) && inPyramid(SIX)).toBe(true)
    expect(inPyramid(Q) || inPyramid(ACE)).toBe(false)
    await undo()
    expect(inPyramid(Q) && inPyramid(ACE)).toBe(true)
    expect(text('undo-disabled')).toBe('true')
  })

  it("a pair's ghosts stay up until their spring's real end (springSettleMs), not the bare duration that would retire them short of the discard", async () => {
    await mount(TWO_PAIRS())
    mockMeasureMs = MEAS

    await pair(Q, ACE)
    await flush(MEAS) // the pair commits and its two ghosts take off
    expect(flyingGhosts()).toEqual(ids(Q, ACE))

    const config = FLIGHT_SPRING
    await flush((config.duration ?? 0) + 20) // the bare duration - the old timer - has run out
    expect(flyingGhosts()).toEqual(ids(Q, ACE))
    await flush(PAIR_FLIGHT_MS - (config.duration ?? 0) - 20 + STEP_MS) // ...and now the spring's real end has
    expect(flyingGhosts()).toEqual([])
  })

  it('the deferral bound outlasts even the slowest flight (a draw ghost that is merely slow must land before its waiting tap gives up)', () => {
    expect(DEFER_MAX_WAIT_MS).toBeGreaterThanOrEqual(2 * PAIR_FLIGHT_MS)
  })

  it('the win celebration is not held back by a first flight that was overtaken: the last pair of the deal settles on its own', async () => {
    // Q+A and 7+6 are ALL that is left: taking them back to back wins the game. A claim that never settled would make the
    // celebration wait out its 2.5s maximum instead of its 400ms beat.
    await mount(
      board([
        [IDX.q, Q],
        [IDX.ace, ACE],
        [IDX.seven, SEVEN],
        [IDX.six, SIX]
      ])
    )
    mockMeasureMs = MEAS

    await pair(Q, ACE)
    await flush(MEAS + 50)
    await pair(SEVEN, SIX)
    await flush(MEAS)
    expect(flyingGhosts()).toEqual(ids(Q, ACE, SEVEN, SIX))

    await flush(PAIR_FLIGHT_MS + WIN_REVEAL_HOLD_MS + 100) // both flights have landed and the beat has passed - far short of the fallback wait
    expect(screen.queryByTestId('win-banner')).not.toBeNull()
  })

  it('the discard paints the topmost card that has LANDED as overlapping flights land, not the pile as it was before the whole stream', async () => {
    await mount(TWO_PAIRS())
    mockMeasureMs = MEAS

    await pair(Q, ACE)
    await flush(MEAS + 50)
    await pair(SEVEN, SIX)
    await flush(MEAS)
    expect(flyingGhosts()).toHaveLength(4)
    expect(text('discard-flying')).toBe('true')
    expect(discardPainted()).toBe(PRE_STREAM_TOP) // nothing has landed yet: the pile under the ghosts is the one from before

    // The first pair (in the air since ~30ms) lands while the second (since ~110ms) is still flying: the ghosts of the first are
    // gone and the pile under the second's shows what THEY brought - the Ace, the last card of the first pair - not the old top.
    await flush(PAIR_FLIGHT_MS - 75)
    expect(flyingGhosts()).toEqual(ids(SEVEN, SIX))
    expect(text('discard-flying')).toBe('true')
    expect(discardPainted()).toBe(ACE.id)

    await landEverything()
    expect(discardPainted()).toBe(SIX.id)
    expect(text('discard-flying')).toBe('false')
  })

  it("a solo King's flight overlapping a pair's shares the same landed-card accounting", async () => {
    await mount(TWO_PAIRS())
    mockMeasureMs = MEAS
    mockFlightMs = PAIR_FLIGHT_MS + 250 // the King is still up long after the pair has landed

    await press(`pyramid-${KING.id}`)
    await flush(MEAS)
    await pair(Q, ACE)
    await flush(MEAS)
    expect(mockLog.inAir).toBe(1)
    expect(flyingGhosts()).toEqual(ids(Q, ACE))
    expect(discardPainted()).toBe(PRE_STREAM_TOP)

    await flush(PAIR_FLIGHT_MS + 50) // the pair has landed (after PAIR_FLIGHT_MS), the King has not
    expect(flyingGhosts()).toEqual([])
    expect(text('discard-flying')).toBe('true')
    expect(discardPainted()).toBe(ACE.id) // what the pair brought, under the King's ghost

    await landEverything()
    expect(discardPainted()).toBe(ACE.id) // the pair was committed after the King, so it is on top
  })

  it('a drop-completed pair while another pair is flying: both flights stay up, the dragged ghost is retired, and undo still works afterwards', async () => {
    await mount(TWO_PAIRS())
    mockMeasureMs = MEAS
    mockHitTestMs = 10

    await pair(Q, ACE)
    await flush(MEAS)
    expect(flyingGhosts()).toEqual(ids(Q, ACE))

    mockDropTarget = { zone: 'pyramid', index: IDX.six }
    await press(`drop-${SEVEN.id}`) // drag the 7 onto the 6
    await flush(60)
    expect(await mockLog.drops[0]).toBe(true)
    expect(mockLog.hidden).toBe(1) // the dragged ghost was handed over to the pair's own two ghosts
    expect(flyingGhosts()).toEqual(ids(Q, ACE, SEVEN, SIX))
    expect(moves()).toBe('2')

    await landEverything()
    expect(discardPainted()).toBe(SIX.id)
    await undo()
    await undo()
    expect(inPyramid(Q) && inPyramid(ACE) && inPyramid(SEVEN) && inPyramid(SIX)).toBe(true)
  })
})

describe('Pyramid screen quick play - a pair is two independent flights', () => {
  // The two cards of a pair start from different places but every flight takes the same time, so they land together.
  it.each([
    ['the second card (the top of the pair) starts far away', Q],
    ['the first card starts far away', ACE]
  ])('%s: both still land together, and the pile shows the top of the pair', async (_name, far) => {
    await mount(TWO_PAIRS())
    mockMeasureMs = MEAS
    mockRegistryPoints.set(far.id, { x: 400, y: 300 }) // a full-board flight, against a short hop for the other

    await pair(Q, ACE)
    await flush(MEAS)
    expect(flyingGhosts()).toEqual(ids(Q, ACE))
    expect(discardPainted()).toBe(PRE_STREAM_TOP)

    await flush(PAIR_FLIGHT_MS - 2 * STEP_MS)
    expect(flyingGhosts()).toEqual(ids(Q, ACE)) // neither has landed ahead of the other
    expect(discardPainted()).toBe(PRE_STREAM_TOP)

    await flush(3 * STEP_MS)
    expect(flyingGhosts()).toEqual([]) // both down in the same moment
    expect(discardPainted()).toBe(ACE.id) // the pile ends on the pair's second card
  })

  it('a King dropped on itself flies on the dragged ghost and is counted once', async () => {
    await mount(TWO_PAIRS())
    mockMeasureMs = MEAS
    mockDropTarget = { zone: 'pyramid', index: IDX.king }

    await press(`drop-${KING.id}`)
    await flush(2 * MEAS)

    expect(await mockLog.drops[0]).toBe(true)
    expect(mockLog.flown).toEqual([{ x: 100, y: 5 }]) // the dragged ghost carries on to the discard pile
    expect(mockLog.hidden).toBe(0) // it was not retired - it IS the flight
    expect(moves()).toBe('1')
    expect(text('discard-flying')).toBe('true')
    await landEverything()
    expect(discardPainted()).toBe(KING.id)
  })
})

describe('Pyramid screen quick play - a move is re-validated against the board after its measurements', () => {
  it('a double-tap on a King removes it once: one flight, one move, one undo entry', async () => {
    await mount(TWO_PAIRS())
    mockMeasureMs = MEAS

    await press(`pyramid-${KING.id}`)
    await press(`pyramid-${KING.id}`) // the second tap lands before the first has finished measuring
    await flush(MEAS)

    expect(mockLog.shown).toEqual([KING.id])
    expect(moves()).toBe('1')
    await landEverything()
    expect(inPyramid(KING)).toBe(false)

    await undo() // ONE undo puts it back - it was one entry
    expect(inPyramid(KING)).toBe(true)
    expect(text('undo-disabled')).toBe('true')
    expect(moves()).toBe('1')
  })

  it.each([
    ['a draw begun first', 'draw-first'],
    ['a pair completed first', 'pair-first']
  ])('%s: neither commit overwrites the other, and both animate', async (_name, order) => {
    await mount(TWO_PAIRS({ stock: [card('diamonds', 5, false), card('diamonds', 9, false)] }))
    mockMeasureMs = MEAS

    if (order === 'draw-first') {
      await press('stock-top')
      await pair(Q, ACE)
    } else {
      await pair(Q, ACE)
      await press('stock-top')
    }
    await flush(MEAS)

    expect(wasteShows()).toBe(id('diamonds', 9)) // the draw survived the pair's commit (or the other way round)...
    expect(text('stock-top')).toBe(id('diamonds', 5))
    expect(inPyramid(Q) || inPyramid(ACE)).toBe(false) // ...and so did the pair's removal
    expect(moves()).toBe('2')
    expect(mockLog.shown).toEqual([id('diamonds', 9)]) // the drawn card's ghost
    expect(flyingGhosts()).toEqual(ids(Q, ACE)) // and the pair's two

    await landEverything()
    expect(wasteShows()).toBe(id('diamonds', 9))
    expect(text('waste-hidden')).toBe('0')
    expect(discardPainted()).toBe(ACE.id)

    // Both moves are on the undo stack in commit order, each recorded against the board it was REALLY made on: undoing the later
    // one leaves the earlier one in place.
    await undo()
    if (order === 'draw-first') {
      expect(inPyramid(Q) && inPyramid(ACE)).toBe(true) // the pair (committed last) is undone...
      expect(wasteShows()).toBe(id('diamonds', 9)) // ...and the draw is not
    } else {
      expect(wasteShows()).toBe('empty') // the draw (committed last) is undone...
      expect(inPyramid(Q) || inPyramid(ACE)).toBe(false) // ...and the pair is not
    }
    await undo()
    expect(wasteShows()).toBe('empty')
    expect(text('stock-top')).toBe(id('diamonds', 9))
    expect(inPyramid(Q) && inPyramid(ACE)).toBe(true)
  })

  it('a pair on the waste aborts when a draw replaces the waste top while it measures: it never removes whatever card is on top by then', async () => {
    // The waste's Ace of spades is selected and the Queen tapped (its own lookup misses the registry, so it takes twice as long as a
    // draw). The draw commits first - the Ace of diamonds, which ALSO makes 13 with the Queen, is now the waste top - and the
    // pair must not go through with a card the player never picked.
    const spadesAce = card('spades', 1)
    await mount(TWO_PAIRS({ stock: [card('diamonds', 1, false)], waste: [spadesAce] }))
    mockMeasureMs = MEAS
    mockUnregistered.add(spadesAce.id)

    await press('waste-top')
    await press(`pyramid-${Q.id}`)
    await press('stock-top')
    await flush(3 * MEAS)

    expect(wasteShows()).toBe(id('diamonds', 1))
    expect(inPyramid(Q)).toBe(true)
    expect(moves()).toBe('1') // only the draw counted
    expect(flyingGhosts()).toEqual([])
    await landEverything()
    await undo()
    expect(wasteShows()).toBe(spadesAce.id) // one undo entry, the draw's: the waste is back to the Ace
  })

  it('three rapid stock draws draw three DIFFERENT cards, each with its own ghost, and the waste ends on the last', async () => {
    await mount(TWO_PAIRS({ stock: ['a', 'b', 'c', 'd', 'e'].map((_, i) => card('hearts', 2 + i, false)) })) // hearts 2..6, the 6 on top
    mockMeasureMs = MEAS

    await press('stock-top')
    await press('stock-top')
    await press('stock-top')
    await flush(MEAS)
    expect(mockLog.shown).toEqual([id('hearts', 6), id('hearts', 5), id('hearts', 4)])
    expect(moves()).toBe('3')

    await flush(MEAS + 10) // every landing is measured and all three ghosts are in the air together
    expect(mockLog.inAir).toBe(3)
    expect(text('waste-hidden')).toBe('1')

    await landEverything()
    expect(mockLog.flown).toHaveLength(3)
    expect(wasteShows()).toBe(id('hearts', 4))
    expect(text('stock-top')).toBe(id('hearts', 3))
    expect(text('waste-hidden')).toBe('0') // never stuck hidden

    await undo()
    await undo()
    await undo()
    expect(wasteShows()).toBe('empty')
    expect(text('stock-top')).toBe(id('hearts', 6))
  })

  it('two rapid taps on an empty stock recycle the waste and then draw from it, once the recycle has landed', async () => {
    // UPDATED (was: both ghosts within one measurement of each other). The draw used to start from the stock slot while the recycle's
    // group ghost was still flying into it - the slot is frozen on its empty pre-flight look until that ghost lands, so the drawn card
    // emerged from an empty slot. The second tap now waits for the recycle to land (see 'a draw tapped while a recycle is still
    // flying' below), then draws as it would have on its own.
    await mount(TWO_PAIRS({ waste: [card('hearts', 2), card('hearts', 3), card('hearts', 4)] }))
    mockMeasureMs = MEAS

    await press('stock-top')
    await press('stock-top')
    await flush(MEAS)
    expect(mockLog.shown).toEqual([`${id('hearts', 2)}+${id('hearts', 3)}+${id('hearts', 4)}`]) // the recycle's group ghost; the draw waits for it

    await landEverything()
    expect(mockLog.shown).toEqual([`${id('hearts', 2)}+${id('hearts', 3)}+${id('hearts', 4)}`, id('hearts', 2)]) // then the draw's
    expect(mockLog.airAtShow).toEqual([0, 0]) // the draw started with nothing else in the air
    expect(wasteShows()).toBe(id('hearts', 2)) // the first draw after the recycle
    expect(text('stock-top')).toBe(id('hearts', 3))
    expect(moves()).toBe('2')
    expect(text('stock-hidden')).toBe('false')
    expect(text('waste-hidden')).toBe('0')
  })

  it.each([
    {
      name: 'a pair',
      start: () => pair(Q, ACE),
      // the pair went through and landed (the earlier draw under it untouched: the 9 on the waste, the 8 still in the stock)...
      landed: () => wasteShows() === id('diamonds', 9) && text('stock-top') === id('diamonds', 8) && !inPyramid(Q) && !inPyramid(ACE),
      // ...and the undo then took back the pair, not the draw
      undone: () => wasteShows() === id('diamonds', 9) && text('stock-top') === id('diamonds', 8) && inPyramid(Q) && inPyramid(ACE)
    },
    {
      name: 'a stock draw',
      start: () => press('stock-top'),
      // the new draw put the 8 on top of the earlier one...
      landed: () => wasteShows() === id('diamonds', 8) && text('stock-top') === 'empty',
      // ...and the undo then took back the 8, leaving the earlier draw
      undone: () => wasteShows() === id('diamonds', 9) && text('stock-top') === id('diamonds', 8)
    }
  ])('an undo tapped while $name is still measuring waits for it: the move commits and lands untouched, then the undo takes back that newest move', async ({ start, landed, undone }) => {
    await mount(TWO_PAIRS({ stock: [card('diamonds', 8, false), card('diamonds', 9, false)] }))
    await press('stock-top')
    await landEverything()
    expect(wasteShows()).toBe(id('diamonds', 9))

    mockMeasureMs = MEAS
    await start() // measuring...
    await press('undo') // ...its claim holds the undo back until it has landed
    await flush(MEAS)
    expect(landed()).toBe(true)
    await landEverything()
    await flush(2 * MEAS + PAIR_FLIGHT_MS) // the undo's turn, and its flight
    await landEverything()

    expect(undone()).toBe(true)
    expect(moves()).toBe('2')
    expect(text('undo-disabled')).toBe('false') // one undo, not two: the earlier draw is still there to take back
  })

  it('a drop that loses a race to a tap on the same King aborts (the card snaps back) instead of removing it twice', async () => {
    await mount(TWO_PAIRS())
    mockMeasureMs = MEAS
    mockDropTarget = { zone: 'pyramid', index: IDX.king }

    await press(`pyramid-${KING.id}`) // the tap starts measuring first...
    await press(`drop-${KING.id}`) // ...then the same King is released onto itself
    await flush(MEAS)

    expect(await mockLog.drops[0]).toBe(false)
    expect(moves()).toBe('1')
    await landEverything()
    await undo()
    expect(inPyramid(KING)).toBe(true)
    expect(text('undo-disabled')).toBe('true') // one entry
  })

  it('a drop is for the card that was dragged: a draw that commits while the hit test measures changes what the waste ref points at, and the drop aborts', async () => {
    // The waste top is the 3 (which does not pair with the 6); the stock's 7 does. The drop is released on the 6, and a draw commits
    // while the hit test is still resolving - the 7 is then the waste top, but it is not what was dragged.
    await mount(TWO_PAIRS({ stock: [card('hearts', 7, false)], waste: [card('clubs', 3)] }))
    mockDropTarget = { zone: 'pyramid', index: IDX.six }
    mockHitTestMs = 30
    mockMeasureMs = 10

    await press('waste-drop')
    await press('stock-top')
    await flush(60)

    expect(await mockLog.drops[0]).toBe(false)
    expect(wasteShows()).toBe(id('hearts', 7))
    expect(inPyramid(SIX)).toBe(true)
    expect(moves()).toBe('1') // just the draw
  })
})

describe('Pyramid screen quick play - New Game while flights are in the air', () => {
  it('drops every airborne pair ghost at once, and no late landing from the old game settles a claim of the new one', async () => {
    const dealt = PyramidController.newGame(mockSeed)
    const nextDraw = dealt.stock[dealt.stock.length - 1]
    await mount(TWO_PAIRS())
    mockMeasureMs = MEAS
    mockFlightMs = 300
    mockDealLands = true

    await press(`pyramid-${KING.id}`) // a King's flight on the shared ghost (lands ~330ms)...
    await pair(Q, ACE) // ...and a pair's two ghosts (~180ms)
    await flush(MEAS)
    await pair(SEVEN, SIX)
    await flush(MEAS)
    expect(flyingGhosts()).toEqual(ids(Q, ACE, SEVEN, SIX))
    expect(mockLog.inAir).toBe(1)

    await press('new-game')
    expect(flyingGhosts()).toEqual([]) // the old game's ghosts are gone with its board
    expect(mockLog.inAir).toBe(0) // and so is the King's (a shared-ghost flight is retired by the New Game too - see the New Game tests below)
    await flush(MEAS + 20) // the new deal measures and lands (instantly, mocked)

    // A draw on the NEW game: its own flight is in the air when the old King's ghost lands (~330ms) and calls its completion.
    await press('stock-top')
    await flush(MEAS + 10 + MEAS) // committed, its landing measured, flying (lands ~300ms later)
    expect(wasteShows()).toBe(nextDraw.id)
    expect(mockLog.inAir).toBe(1) // this draw's (the old King's ghost was retired by the New Game: its completion ran then, generation-guarded)
    expect(text('waste-hidden')).toBe('1')

    await flush(250) // the draw is still in the air (this is where the old King's landing used to fire)
    expect(mockLog.inAir).toBe(1)
    await press('undo') // must wait: the draw's own claim was not eaten by the old game's completion
    expect(wasteShows()).toBe(nextDraw.id)
    expect(mockLog.inAir).toBe(1)

    await landEverything() // and once it has landed, the waiting undo goes through on its own
    await flush(2 * MEAS + PAIR_FLIGHT_MS)
    expect(wasteShows()).toBe('empty')
  })
})

describe('Pyramid screen quick play - New Game tapped in the middle of an undo', () => {
  // The old game's board must never be written over the new deal by an undo that was still measuring.
  const newGameTop = () => {
    const dealt = PyramidController.newGame(mockSeed)
    return dealt.stock[dealt.stock.length - 1].id
  }

  it('an undone draw', async () => {
    await mount(TWO_PAIRS({ stock: [card('diamonds', 9, false)] }))
    await press('stock-top')
    await landEverything()
    mockDealLands = true
    mockMeasureMs = MEAS

    await press('undo') // measuring the drawn card...
    await press('new-game')
    await flush(400)

    expect(newGameTop()).not.toBe(id('diamonds', 9))
    expect(text('stock-top')).toBe(newGameTop()) // the fresh deal, not the old board's stock
    expect(wasteShows()).toBe('empty')
  })

  it('an undone removal, while its discard pile is still being measured', async () => {
    await mount(TWO_PAIRS({ stock: [card('diamonds', 9, false)] }))
    await pair(Q, ACE)
    await landEverything()
    mockDealLands = true
    mockMeasureMs = MEAS

    await press('undo') // measuring the discard pile...
    await press('new-game')
    await flush(400)
    expect(text('stock-top')).toBe(newGameTop())
    expect(flyingGhosts()).toEqual([])
  })

  it("an undone removal whose cards' destinations are still being resolved flies no stale ghosts onto the new game", async () => {
    await mount(TWO_PAIRS({ stock: [card('diamonds', 9, false)] }))
    await pair(Q, ACE)
    await landEverything()
    mockDealLands = true
    mockMeasureMs = MEAS

    await press('undo')
    await flush(MEAS + 10) // prevState is committed; the effect is measuring the triangle
    await press('new-game')
    await flush(MEAS + 50) // long enough for the effect to have finished measuring and started its flight
    expect(flyingGhosts()).toEqual([]) // nothing of the old game's cards is flying over the new deal
    await flush(400)
    expect(text('stock-top')).toBe(newGameTop())
  })
})

describe('Pyramid screen quick play - every path settles its claim, even when nothing can fly', () => {
  // Each case commits its move with nothing to animate (the pile it would fly to/from cannot be measured), then taps undo: it is
  // held back for as long as a claim is left outstanding, so undo working proves the bail-out settled.
  const cases: { name: string; state: () => PyramidState; unmeasurable: string; move: () => Promise<void>; committed: () => boolean; restored: () => boolean }[] = [
    {
      name: 'a pair with an unmeasurable discard pile',
      state: () => TWO_PAIRS(),
      unmeasurable: 'discard',
      move: () => pair(Q, ACE),
      committed: () => !inPyramid(Q) && !inPyramid(ACE) && flyingGhosts().length === 0,
      restored: () => inPyramid(Q) && inPyramid(ACE)
    },
    {
      name: 'a King with an unmeasurable discard pile',
      state: () => TWO_PAIRS(),
      unmeasurable: 'discard',
      move: () => press(`pyramid-${KING.id}`),
      committed: () => !inPyramid(KING) && mockLog.shown.length === 0,
      restored: () => inPyramid(KING)
    },
    {
      name: 'a King dropped with an unmeasurable discard pile',
      state: () => TWO_PAIRS(),
      unmeasurable: 'discard',
      move: async () => {
        mockDropTarget = { zone: 'pyramid', index: IDX.king }
        await press(`drop-${KING.id}`)
      },
      committed: () => !inPyramid(KING) && mockLog.flown.length === 0 && mockLog.hidden === 1, // the dragged ghost is retired, not left hanging
      restored: () => inPyramid(KING)
    },
    {
      name: 'a pair dropped with an unmeasurable discard pile',
      state: () => TWO_PAIRS(),
      unmeasurable: 'discard',
      move: async () => {
        mockDropTarget = { zone: 'pyramid', index: IDX.ace }
        await press(`drop-${Q.id}`)
      },
      committed: () => !inPyramid(Q) && !inPyramid(ACE) && flyingGhosts().length === 0 && mockLog.hidden === 1,
      restored: () => inPyramid(Q) && inPyramid(ACE)
    },
    {
      name: 'a draw with an unmeasurable stock pile',
      state: () => TWO_PAIRS({ stock: [card('diamonds', 9, false)] }),
      unmeasurable: 'stock',
      move: () => press('stock-top'),
      committed: () => wasteShows() === id('diamonds', 9) && mockLog.shown.length === 0,
      restored: () => wasteShows() === 'empty'
    },
    {
      name: 'a recycle with an unmeasurable waste',
      state: () => TWO_PAIRS({ waste: [card('hearts', 2)] }),
      unmeasurable: 'waste',
      move: () => press('stock-top'),
      committed: () => text('stock-top') === id('hearts', 2) && mockLog.shown.length === 0,
      restored: () => text('stock-top') === 'empty'
    }
  ]

  it.each(cases)('$name', async ({ state, unmeasurable, move, committed, restored }) => {
    await mount(state())
    mockMeasureMs = MEAS
    mockUnmeasurable.add(unmeasurable)

    await move()
    await flush(MEAS)
    expect(committed()).toBe(true)
    expect(moves()).toBe('1')

    await undo()
    expect(restored()).toBe(true)
  })

  it('a pair whose first card cannot be found anywhere still flies the other card, and nothing is left claimed', async () => {
    const wasteAce = card('spades', 1)
    await mount(TWO_PAIRS({ waste: [card('hearts', 5), wasteAce] }))
    mockMeasureMs = MEAS
    mockUnregistered.add(wasteAce.id)
    mockUnmeasurable.add('waste') // neither its registration nor its slot can be measured

    await press('waste-top') // select the Ace on the waste
    await press(`pyramid-${Q.id}`)
    await flush(2 * MEAS) // the registry lookup misses, then so does the slot's

    expect(flyingGhosts()).toEqual(ids(Q)) // only the card with a position has a ghost
    expect(moves()).toBe('1')
    await landEverything()
    await undo()
    expect(inPyramid(Q)).toBe(true) // undo was not refused
  })
})

describe('Pyramid screen quick play - overlapping draws land on what has landed, not on the card from before the stream', () => {
  const HEARTS = [2, 3, 4, 5, 6].map((rank) => card('hearts', rank, false)) // hearts 2..6, the 6 on top of the stock

  it('the waste slot paints (settledWasteTop) the topmost drawn card whose ghost has landed, as each of several overlapping draws lands', async () => {
    await mount(TWO_PAIRS({ stock: HEARTS }))
    mockMeasureMs = MEAS
    mockFlightMs = 300

    // Three draws ~100ms apart, the way a fast player taps: the flights (300ms) overlap.
    await press('stock-top')
    await flush(100)
    await press('stock-top')
    await flush(100)
    await press('stock-top')
    await flush(30) // t ~230: all three are committed, none has landed
    expect(wasteShows()).toBe(id('hearts', 4))
    expect(text('waste-hidden')).toBe('1')
    expect(text('waste-settled')).toBe('null') // nothing has landed: the empty slot (the waste was empty before the stream)

    await flush(160) // t ~390: the FIRST ghost (the 6) has landed, the 5 and the 4 are still flying
    expect(mockLog.inAir).toBe(2)
    expect(text('waste-settled')).toBe(id('hearts', 6)) // under the two ghosts still flying is the card that landed - not the pre-stream slot

    await flush(100) // t ~490: the 5 has landed too
    expect(mockLog.inAir).toBe(1)
    expect(text('waste-settled')).toBe(id('hearts', 5))

    await landEverything()
    expect(text('waste-hidden')).toBe('0')
    expect(wasteShows()).toBe(id('hearts', 4))
    expect(text('waste-settled')).toBe('undefined') // nothing in the air: the frozen copy is not needed
  })

  it('a flight that is not a stream of draws (an undone removal to the waste) keeps the frozen copy', async () => {
    const spadesAce = card('spades', 1)
    await mount(TWO_PAIRS({ waste: [card('hearts', 5), spadesAce] }))
    await press('waste-top')
    await press(`pyramid-${Q.id}`)
    await landEverything()
    await undo()
    expect(wasteShows()).toBe(spadesAce.id)
    expect(text('waste-settled')).toBe('undefined')
  })
})

describe('Pyramid screen quick play - undoing a move puts its ghosts up in the same commit as the reverted board', () => {
  const STEPS = Math.ceil((2 * MEAS + PAIR_FLIGHT_MS) / STEP_MS) // x 10ms: the measurements and the slowest flight

  // For each restored pyramid card: at EVERY step after the undo is tapped, it is either covered by its ghost or visible in its own cell -
  // never neither (the discard has already shown its older top by then, so a card that is neither is simply missing).
  const pyramidCardCovered = (c: Card) => {
    const cell = screen.queryByTestId(`pyramid-${c.id}`)
    return flyingGhosts().includes(c.id) || (cell !== null && cell.props.accessibilityHint !== 'hidden')
  }

  it('an undone pair flies both cards back from the discard with no frame in which either is visible nowhere', async () => {
    await mount(TWO_PAIRS())
    await pair(Q, ACE)
    await landEverything()
    mockMeasureMs = MEAS

    await press('undo')
    let sawGhosts = false
    for (let step = 0; step < STEPS; step++) {
      await flush(STEP_MS)
      if (inPyramid(Q) || inPyramid(ACE)) {
        // The board has reverted: from this very commit on, both cards are covered.
        expect(pyramidCardCovered(Q)).toBe(true)
        expect(pyramidCardCovered(ACE)).toBe(true)
        // and the ghosts are up in that same commit (a later step may find one card already landed - the window now outlasts the slowest flight)
        if (!sawGhosts) expect(flyingGhosts()).toEqual(ids(Q, ACE))
        sawGhosts = true
      }
    }
    expect(sawGhosts).toBe(true)
    await landEverything()
    expect(inPyramid(Q) && inPyramid(ACE)).toBe(true)
    expect(flyingGhosts()).toEqual([])
    expect(text('undo-disabled')).toBe('true')
  })

  it('an undone waste-bound pair does the same for the card restored to the waste - hidden exactly while its ghost flies, revealed the moment it lands', async () => {
    const wasteAce = card('spades', 1)
    await mount(TWO_PAIRS({ waste: [card('hearts', 5), wasteAce] }))
    await press('waste-top')
    await press(`pyramid-${Q.id}`)
    await landEverything()
    expect(wasteShows()).toBe(card('hearts', 5).id)
    mockMeasureMs = MEAS

    await press('undo')
    let sawGhosts = false
    let sawLanded = false
    for (let step = 0; step < STEPS; step++) {
      await flush(STEP_MS)
      if (wasteShows() === wasteAce.id) {
        // The Ace is back on the waste. From this very commit its real card is hidden exactly while its own ghost is flying over it -
        // never hidden with no ghost (visible nowhere), never showing under a ghost.
        const ghostUp = flyingGhosts().includes(wasteAce.id)
        expect(text('waste-hidden')).toBe(ghostUp ? '1' : '0')
        if (ghostUp) sawGhosts = true
        else sawLanded = true
      }
    }
    expect(sawGhosts).toBe(true)
    expect(sawLanded).toBe(true)
    await landEverything()
    expect(wasteShows()).toBe(wasteAce.id)
    expect(text('waste-hidden')).toBe('0')
  })

  it.each([
    ['a draw', async () => press('stock-top')],
    ['a recycle', async () => press('stock-top')]
  ])('an undone %s starts its flight in the very stretch that mounts its ghost and reverts the board', async (name, move) => {
    const isRecycle = name === 'a recycle'
    await mount(TWO_PAIRS(isRecycle ? { waste: [card('hearts', 2), card('hearts', 3)] } : { stock: [card('diamonds', 9, false)] }))
    await move()
    await landEverything()
    mockMeasureMs = MEAS
    const shownBefore = mockLog.shown.length
    const flownBefore = mockLog.flown.length

    await press('undo')
    let sawFlight = false
    for (let step = 0; step < STEPS && !sawFlight; step++) {
      await flush(STEP_MS)
      if (mockLog.shown.length > shownBefore) {
        // The ghost is up: its flight has to have started at the same moment, not after a post-commit measurement.
        expect(mockLog.flown.length).toBe(flownBefore + 1)
        // A draw's card lands ON the stock, which keeps its pre-flight look until then; a recycle's cards LEAVE it, so it is not frozen.
        expect(text('stock-hidden')).toBe(isRecycle ? 'false' : 'true')
        sawFlight = true
      }
    }
    expect(sawFlight).toBe(true)
    await landEverything()
    expect(text('stock-hidden')).toBe('false')
  })

  it('an undone recycle empties the stock as its cards take off, flying them face down, and the waste shows its empty slot until they land', async () => {
    await mount(TWO_PAIRS({ waste: [card('hearts', 2), card('hearts', 3)] }))
    await press('stock-top') // the recycle
    await landEverything()
    expect(text('stock-top')).not.toBe('empty')
    mockFlightMs = 300
    const show = jest.spyOn(mockGhost, 'show')

    await press('undo')
    await flush(100)
    expect(show).toHaveBeenCalledTimes(1)
    // One back for the whole pile, carrying the id of the card that ends on top of the waste (the landed ghost waits for its face).
    expect(show.mock.calls[0][0].cards).toEqual([{ ...card('hearts', 3), faceUp: false }])
    expect(text('stock-top')).toBe('empty')
    expect(text('stock-hidden')).toBe('false') // not frozen on a back while the whole stock is in the air
    expect(text('waste-hidden')).toBe('1')
    expect(text('waste-settled')).toBe('undefined') // the frozen copy: the empty waste from before the undo
    expect(mockLog.inAir).toBe(1)

    await flush(300)
    expect(mockLog.inAir).toBe(0)
    expect(text('waste-hidden')).toBe('0')
    expect(wasteShows()).toBe(id('hearts', 3))
  })

  it('an undone draw keeps the stock slot frozen until the returning ghost lands, then reveals the returned card', async () => {
    await mount(TWO_PAIRS({ stock: [card('diamonds', 9, false)] }))
    await press('stock-top')
    await landEverything()
    expect(text('stock-top')).toBe('empty') // the stock's only card was drawn
    mockFlightMs = 300

    await press('undo')
    await flush(100)
    expect(text('stock-top')).toBe(id('diamonds', 9)) // the board has reverted...
    expect(text('stock-hidden')).toBe('true') // ...but the slot keeps its pre-flight look (StockWaste's stockHidden) while the card is on its way
    expect(mockLog.inAir).toBe(1)

    await flush(300)
    expect(mockLog.inAir).toBe(0)
    expect(text('stock-hidden')).toBe('false')
  })
})

describe('Pyramid screen quick play - a drawn card tapped or dragged while its draw ghost is still flying', () => {
  const KING_SPADES = card('spades', 13, false)

  it('a King tapped while its own draw is still in the air waits for it to land, THEN flies on - never shown twice', async () => {
    await mount(TWO_PAIRS({ stock: [KING_SPADES] }))
    mockMeasureMs = MEAS
    mockFlightMs = 300

    await press('stock-top')
    await flush(2 * MEAS + 10) // the draw has committed and its landing is measured: its ghost is in the air (it lands ~300ms after it takes off)
    expect(wasteShows()).toBe(KING_SPADES.id)
    expect(mockLog.inAir).toBe(1)
    await press('waste-top') // the quick player taps the King right away
    await flush(150)

    // The tap is NOT ignored, and it does not start a second flight of the same card from the slot the King has not reached yet.
    expect(mockLog.shown).toEqual([KING_SPADES.id]) // only the draw's ghost so far
    expect(moves()).toBe('1')
    expect(wasteShows()).toBe(KING_SPADES.id)

    await flush(300 + 3 * MEAS) // the draw lands (~360ms after it took off), then the King measures and goes
    await landEverything()
    // The draw landed; the King then flew on from where it arrived.
    expect(mockLog.shown).toEqual([KING_SPADES.id, KING_SPADES.id])
    expect(mockLog.airAtShow).toEqual([0, 0]) // the second flight took off with nothing in the air: the first had landed
    expect(moves()).toBe('2')
    expect(wasteShows()).toBe('empty')
    expect(discardPainted()).toBe(KING_SPADES.id)

    // Claims are balanced: undo is not refused, and puts the King back on the waste.
    await undo()
    expect(wasteShows()).toBe(KING_SPADES.id)
  })

  it('a pair completed with the drawn card waits the same way: the drawn card arrives first, then both cards fly to the discard', async () => {
    await mount(TWO_PAIRS({ stock: [card('spades', 1, false)] })) // an Ace: makes 13 with the Queen
    mockMeasureMs = MEAS
    mockFlightMs = 300

    await press('stock-top')
    await flush(2 * MEAS + 10)
    expect(mockLog.inAir).toBe(1)
    await press(`pyramid-${Q.id}`) // select the Queen (a draw clears any earlier selection)
    await press('waste-top') // pair it with the Ace, still flying to the waste
    await flush(150)

    expect(flyingGhosts()).toEqual([]) // no pair flight yet
    expect(inPyramid(Q)).toBe(true)
    expect(moves()).toBe('1')

    for (let waited = 0; moves() === '1' && waited < 1000; waited += STEP_MS) await flush(STEP_MS) // the draw lands; the pair then measures and commits
    expect(mockLog.inAir).toBe(0) // it committed only once the draw had landed
    expect(moves()).toBe('2')
    expect(flyingGhosts()).toEqual(ids(Q, card('spades', 1))) // and both cards fly to the discard from where they are
    await landEverything()
    expect(inPyramid(Q)).toBe(false)
  })

  it('a card dragged and dropped while its draw ghost is still flying waits for it as well', async () => {
    await mount(TWO_PAIRS({ stock: [card('spades', 1, false)] }))
    mockMeasureMs = MEAS
    mockFlightMs = 300
    mockDropTarget = { zone: 'pyramid', index: IDX.q }

    await press('stock-top')
    await flush(2 * MEAS + 10)
    expect(mockLog.inAir).toBe(1)
    await press('waste-drop') // drop the Ace on the Queen
    await flush(150)

    expect(moves()).toBe('1') // not committed while the Ace is still on its way to the waste
    expect(flyingGhosts()).toEqual([])
    await flush(600) // the draw lands, the drop measures and goes
    expect(await mockLog.drops[0]).toBe(true)
    expect(moves()).toBe('2')
    expect(inPyramid(Q)).toBe(false)
    await landEverything()
  })

  it('the wait is bounded: a draw flight that never lands does not swallow the tap for good', async () => {
    await mount(TWO_PAIRS({ stock: [KING_SPADES] }))
    mockFlightMs = 60_000

    await press('stock-top')
    await flush(50)
    await press('waste-top')
    await flush(DEFER_MAX_WAIT_MS - 150)
    expect(moves()).toBe('1') // still waiting

    await flush(300) // past the bound (DEFER_MAX_WAIT_MS): the move goes ahead
    expect(moves()).toBe('2')
    expect(wasteShows()).toBe('empty')
  })

  it('a New Game tapped during the wait ends it safely: nothing of the old game is committed, and undo works on the new one', async () => {
    await mount(TWO_PAIRS({ stock: [KING_SPADES] }))
    mockMeasureMs = MEAS
    mockFlightMs = 300
    mockDealLands = true

    await press('stock-top')
    await flush(MEAS + 20)
    await press('waste-top') // waiting for the draw to land
    await press('new-game')
    await flush(MEAS + 50)
    const dealt = PyramidController.newGame(mockSeed)
    expect(moves()).toBe('0')
    expect(text('stock-top')).toBe(dealt.stock[dealt.stock.length - 1].id)
    expect(wasteShows()).toBe('empty')

    await flush(1500) // the old tap's wait is over: it must not commit anything onto the new deal
    expect(moves()).toBe('0')
    expect(flyingGhosts()).toEqual([])
    await press('stock-top') // a draw on the new game...
    await flush(3 * MEAS)
    await landEverything()
    await undo() // ...and undo is not refused by a claim the old tap left behind
    expect(wasteShows()).toBe('empty')
  })
})

describe('Pyramid screen quick play - a selection made while a deferred move waits', () => {
  // A tap/drop on a card still flying to the waste clears the selection up front, then parks until that draw lands; taps in that window
  // are handled normally. The waste ref {waste, 0} means "whatever is on top", so a selection of it made in the window pointed at the
  // card UNDER the removed one once the deferred pair committed - highlighted, and paired by the player's next tap.
  const ACE_SPADES = card('spades', 1, false) // makes 13 with the Queen
  const FIVE = card('hearts', 5)
  const setup = async () => {
    await mount(TWO_PAIRS({ stock: [ACE_SPADES], waste: [FIVE] }))
    mockMeasureMs = MEAS
    mockFlightMs = 300
    await press('stock-top') // the Ace is drawn onto the 5 and flies there
    await flush(2 * MEAS + 10)
    expect(mockLog.inAir).toBe(1)
    expect(wasteShows()).toBe(ACE_SPADES.id)
  }
  const untilMoves = async (n: string) => {
    for (let waited = 0; moves() !== n && waited < 1500; waited += STEP_MS) await flush(STEP_MS)
    expect(moves()).toBe(n)
  }
  const starts: { name: string; start: () => Promise<void> }[] = [
    {
      name: 'a tap',
      start: async () => {
        await press(`pyramid-${Q.id}`) // select the Queen
        await press('waste-top') // pair it with the Ace, still flying: parked (and the selection cleared)
      }
    },
    {
      name: 'a drop',
      start: async () => {
        mockDropTarget = { zone: 'pyramid', index: IDX.q }
        await press('waste-drop') // drag the Ace onto the Queen: parked
      }
    }
  ]

  it.each(starts)('$name: a selection of the waste top made during the wait is dropped when the pair removes that card - the card underneath is not selected', async ({ start }) => {
    await setup()
    await start()
    await press('waste-top') // during the wait: the player taps the (just drawn) Ace again - selected as "the waste top"
    expect(text('waste-selected')).toBe('true')
    expect(moves()).toBe('1') // nothing has committed yet

    await untilMoves('2') // the draw lands, the deferred pair commits
    expect(inPyramid(Q)).toBe(false)
    expect(wasteShows()).toBe(FIVE.id) // the 5, which was under the Ace, is the waste top now...
    expect(text('waste-selected')).toBe('false') // ...and it is NOT selected: the player never chose it

    await landEverything()
    expect(text('waste-selected')).toBe('false')
    // The next tap on it is a plain selection, not the second half of a pairing the player never started.
    await press('waste-top')
    expect(text('waste-selected')).toBe('true')
    expect(moves()).toBe('2')
  })

  it.each(starts)('$name: a selection of an unrelated card made during the wait survives the commit', async ({ start }) => {
    await setup()
    await start()
    await press(`pyramid-${SEVEN.id}`) // during the wait: the player selects the 7
    expect(pyramidSelected(SEVEN)).toBe(true)

    await untilMoves('2')
    expect(inPyramid(Q)).toBe(false)
    expect(pyramidSelected(SEVEN)).toBe(true) // still selected: the pair that just went through was not about it

    await landEverything()
    await press(`pyramid-${SIX.id}`) // completes 7 + 6 = 13 with the surviving selection
    await flush(2 * MEAS)
    expect(moves()).toBe('3')
    expect(inPyramid(SEVEN) || inPyramid(SIX)).toBe(false)
  })

  it('a selection of a pyramid card that the deferred pair itself removes is dropped too', async () => {
    // The Queen is selected, the Ace is tapped (parked); the Queen is tapped AGAIN during the wait, which selects it - and the pair then
    // removes it. A selection naming a removed card would otherwise dangle on an empty cell.
    await setup()
    await press(`pyramid-${Q.id}`)
    await press('waste-top')
    await press(`pyramid-${Q.id}`) // selected again (the deferred move cleared the first selection)
    expect(pyramidSelected(Q)).toBe(true)

    await untilMoves('2')
    await landEverything()
    expect(inPyramid(Q)).toBe(false)
    // Had the selection dangled on the removed Queen, this tap on the 7 would try to pair with it (illegal: the "didn't work" sound and
    // a shake, the 7 selected instead) - with it dropped, the 7 is simply selected, and the 6 then completes the pair.
    await press(`pyramid-${SEVEN.id}`)
    expect(mockInvalid.count).toBe(0)
    expect(pyramidSelected(SEVEN)).toBe(true)
    await press(`pyramid-${SIX.id}`)
    await flush(2 * MEAS)
    expect(moves()).toBe('3')
  })
})

describe('Pyramid screen quick play - a draw and a recycle never overlap', () => {
  it('a draw tapped while a recycle is still flying into the stock waits for it to land: the card never emerges from the frozen-empty slot', async () => {
    await mount(TWO_PAIRS({ waste: [card('hearts', 2), card('hearts', 3), card('hearts', 4)] }))
    mockMeasureMs = MEAS
    mockFlightMs = 300

    await press('stock-top') // the recycle
    await flush(MEAS + 10)
    expect(mockLog.inAir).toBe(1)
    expect(text('stock-hidden')).toBe('true')
    await press('stock-top') // a draw from the new stock, while the recycle's group ghost is still flying
    await flush(150)

    expect(mockLog.shown).toHaveLength(1) // only the recycle's ghost: the draw has not started
    expect(moves()).toBe('1')

    await landEverything()
    expect(mockLog.shown).toHaveLength(2)
    expect(mockLog.airAtShow).toEqual([0, 0]) // the draw took off with the recycle already landed and the slot revealed
    expect(moves()).toBe('2')
    expect(wasteShows()).toBe(id('hearts', 2))
  })

  it('a recycle tapped while the last stock card is still flying to the waste waits for it: the airborne card is not picked up twice', async () => {
    await mount(TWO_PAIRS({ stock: [card('hearts', 5, false)], waste: [card('hearts', 2), card('hearts', 3)] }))
    mockMeasureMs = MEAS
    mockFlightMs = 300

    await press('stock-top') // draws the 5: the stock is now empty and the 5 is flying to the waste
    await flush(2 * MEAS + 10)
    expect(text('stock-top')).toBe('empty')
    expect(mockLog.inAir).toBe(1)
    await press('stock-top') // the recycle
    await flush(150)

    expect(mockLog.shown).toEqual([id('hearts', 5)]) // no group ghost while the 5 is still in the air
    expect(moves()).toBe('1')

    await landEverything()
    expect(mockLog.shown).toEqual([id('hearts', 5), `${id('hearts', 2)}+${id('hearts', 3)}+${id('hearts', 5)}`]) // then the whole waste, the 5 on it, recycles as one
    expect(mockLog.airAtShow).toEqual([0, 0])
    expect(moves()).toBe('2')
  })

  it('taps parked on the same landing are re-checked one by one: the first becomes a recycle, and the next waits for THAT flight instead of drawing from the freshly recycled stock', async () => {
    // Stock [5], waste [2, 3]: the first tap draws the 5 (the stock is now empty, the 5 flies to the waste); the next two taps, ~100ms
    // apart the way a quick player taps, both park behind that airborne draw. When it lands they resume TOGETHER: the second is a
    // recycle, which freezes the stock again and sends a group ghost into it - the third must wait for it, not draw at once.
    await mount(TWO_PAIRS({ stock: [card('hearts', 5, false)], waste: [card('hearts', 2), card('hearts', 3)] }))
    mockMeasureMs = MEAS
    mockFlightMs = 300

    await press('stock-top')
    await flush(100)
    await press('stock-top')
    await flush(100)
    await press('stock-top')
    await flush(MEAS + 10)
    expect(mockLog.shown).toEqual([id('hearts', 5)]) // only the first draw's ghost: both later taps are parked
    expect(moves()).toBe('1')

    // The draw lands (~360ms): the recycle goes, the third tap does not - at every step, a draw's ghost is never up while the recycle's is.
    const recycleGhost = `${id('hearts', 2)}+${id('hearts', 3)}+${id('hearts', 5)}`
    let sawRecycleAirborne = false
    for (let waited = 0; waited < 1500 && moves() !== '3'; waited += STEP_MS) {
      await flush(STEP_MS)
      if (mockLog.shown.includes(recycleGhost) && text('stock-hidden') === 'true') {
        sawRecycleAirborne = true
        expect(mockLog.shown).toEqual([id('hearts', 5), recycleGhost]) // no draw has taken off from the frozen-empty slot
        expect(text('stock-top')).not.toBe('empty') // (the board has recycled: the stock holds the three cards)
      }
    }
    expect(sawRecycleAirborne).toBe(true)

    await landEverything()
    expect(mockLog.shown).toEqual([id('hearts', 5), recycleGhost, id('hearts', 2)]) // draw, recycle, then the draw from the recycled stock
    expect(mockLog.airAtShow).toEqual([0, 0, 0]) // the last draw took off only once the recycle's group ghost had landed
    expect(moves()).toBe('3')
    expect(wasteShows()).toBe(id('hearts', 2))
    expect(text('stock-top')).toBe(id('hearts', 3))
    expect(text('stock-hidden')).toBe('false')
    expect(text('waste-hidden')).toBe('0')

    // Every claim was settled and every move recorded once: three undos take the deck back exactly as it was.
    await undo()
    await undo()
    await undo()
    expect(wasteShows()).toBe(id('hearts', 3))
    expect(text('stock-top')).toBe(id('hearts', 5))
    expect(text('undo-disabled')).toBe('true')
  })

  it('a parked draw is bounded by ONE deadline for the whole wait: a recycle flight that never lands does not swallow it, however often it is re-checked', async () => {
    await mount(TWO_PAIRS({ waste: [card('hearts', 2), card('hearts', 3)] }))
    mockFlightMs = 60_000

    await press('stock-top') // the recycle: its group ghost never lands, so the stock stays frozen
    await flush(50)
    await press('stock-top') // a draw from the new stock: parked behind it
    await flush(DEFER_MAX_WAIT_MS - 150)
    expect(moves()).toBe('1') // still waiting

    await flush(300) // past the bound (DEFER_MAX_WAIT_MS): the draw goes ahead anyway
    expect(moves()).toBe('2')
    expect(wasteShows()).toBe(id('hearts', 2))
  })

  it('plain draws still overlap each other freely', async () => {
    await mount(TWO_PAIRS({ stock: [2, 3, 4].map((rank) => card('hearts', rank, false)) }))
    mockMeasureMs = MEAS
    mockFlightMs = 300

    await press('stock-top')
    await press('stock-top')
    await flush(MEAS)
    expect(mockLog.shown).toEqual([id('hearts', 4), id('hearts', 3)]) // the second did not wait for the first
    expect(moves()).toBe('2')
  })
})

describe('Pyramid screen quick play - a parked tap or drop re-checks its own gate when it resumes too', () => {
  // What a tap/drop waits for is "my card is no longer flying to the waste". That normally cannot flip back once true - but actions parked
  // on the same landing resume TOGETHER, one after another, and an earlier one can put the very card back in the air: with the waste
  // unmeasurable a recycle takes off nothing (no group ghost holds the stock's gate), so the draw parked beside it draws that same card
  // again from the freshly recycled stock. The tap/drop parked behind them must wait for THAT flight as well - acting at once would
  // measure the card mid-air and fly a second copy of it, the card shown twice.
  const ACE_SPADES = card('spades', 1, false) // makes 13 with the Queen
  const setup = async () => {
    await mount(TWO_PAIRS({ stock: [ACE_SPADES], waste: [] }))
    mockMeasureMs = MEAS
    mockFlightMs = 300
    await press('stock-top') // the Ace is drawn and flies to the waste; the stock is empty
    await flush(2 * MEAS + 10)
    expect(mockLog.inAir).toBe(1)
    expect(text('stock-top')).toBe('empty')

    mockUnmeasurable.add('waste') // from here on a recycle has nowhere to measure its group flight from: it commits and flies nothing
    await press('stock-top') // a recycle, parked behind the airborne draw (stock empty)
    await flush(MEAS + 10)
    await press('stock-top') // another stock tap, parked beside it - it will become a draw of the Ace from the recycled stock
    await flush(MEAS + 10)
  }
  const starts: { name: string; start: () => Promise<void> }[] = [
    {
      name: 'a tap',
      start: async () => {
        await press(`pyramid-${Q.id}`)
        await press('waste-top') // the Queen with the Ace, still flying: parked behind both stock taps
      }
    },
    {
      name: 'a drop',
      start: async () => {
        mockDropTarget = { zone: 'pyramid', index: IDX.q }
        await press('waste-drop') // the Ace dragged onto the Queen: parked behind both stock taps
      }
    }
  ]

  it.each(starts)('$name: waits for the second flight of the same card instead of measuring it mid-air', async ({ start }) => {
    await setup()
    await start()
    expect(moves()).toBe('1')

    // The first draw lands (~360ms): the recycle commits, the draw takes the Ace out again - and the parked move must stay parked.
    await flush(300)
    expect(moves()).toBe('3') // draw, recycle, draw: the pair has NOT committed
    expect(inPyramid(Q)).toBe(true)
    expect(mockLog.inAir).toBe(1) // the Ace's second draw ghost, alone in the air
    expect(mockLog.shown).toEqual([ACE_SPADES.id, ACE_SPADES.id])

    await landEverything() // the Ace lands for the second time: NOW the pair goes
    await flush(2 * MEAS + STEP_MS)
    await landEverything()
    expect(moves()).toBe('4')
    expect(inPyramid(Q)).toBe(false)
    expect(wasteShows()).toBe('empty')
    expect(mockLog.shown).toEqual([ACE_SPADES.id, ACE_SPADES.id]) // and no third ghost of the Ace: the pair flew on the pair overlay
  })
})

describe('Pyramid screen quick play - New Game retires every flight of the old game', () => {
  it('a draw ghost queued for its landing measurement is hidden, not left mounted over the new board', async () => {
    await mount(TWO_PAIRS({ stock: [card('diamonds', 9, false)] }))
    mockMeasureMs = MEAS
    mockDealLands = true

    // The draw commits and queues its ghost for the post-commit measurement in one act() (React commits - and drains the queue - when
    // the act ends); the New Game tapped in that same window finds the entry still queued.
    await act(async () => {
      fireEvent.press(screen.getByTestId('stock-top'))
      await jest.advanceTimersByTimeAsync(MEAS)
      fireEvent.press(screen.getByTestId('new-game'))
    })
    expect(mockLog.shown).toEqual([id('diamonds', 9)])
    expect(mockLog.hidden).toBe(1) // the queued draw's ghost was retired: dropping its entry alone left it mounted for good

    await flush(500)
    expect(mockLog.flown).toEqual([]) // and it never flew
    const dealt = PyramidController.newGame(mockSeed)
    expect(text('stock-top')).toBe(dealt.stock[dealt.stock.length - 1].id)
  })

  it("a King's flight that is airborne is retired when a New Game starts, instead of flying on across the new deal", async () => {
    await mount(TWO_PAIRS())
    mockMeasureMs = MEAS
    mockFlightMs = 300
    mockDealLands = true

    await press(`pyramid-${KING.id}`)
    await flush(MEAS + 20)
    expect(mockLog.inAir).toBe(1)

    await press('new-game')
    expect(mockLog.hidden).toBe(1)
    expect(mockLog.inAir).toBe(0)
    await flush(500)
    expect(text('discard-flying')).toBe('false')
  })

  it("an undone draw's returning ghost and a recycle's group ghost are retired too", async () => {
    await mount(TWO_PAIRS({ stock: [card('diamonds', 9, false)] }))
    mockDealLands = true
    await press('stock-top')
    await landEverything()
    mockFlightMs = 300
    await press('undo')
    await flush(100)
    expect(mockLog.inAir).toBe(1)

    await press('new-game')
    expect(mockLog.hidden).toBe(1)
    expect(mockLog.inAir).toBe(0)
    await flush(400)
    expect(text('stock-hidden')).toBe('false')
  })
})

describe('topLandedCard', () => {
  const pile = [card('spades', 1), card('spades', 2), card('spades', 3)]

  it('is the topmost card that is not in the air, in any landing order', () => {
    expect(topLandedCard(pile, new Set())?.id).toBe(id('spades', 3))
    expect(topLandedCard(pile, new Set([id('spades', 3)]))?.id).toBe(id('spades', 2))
    expect(topLandedCard(pile, new Set([id('spades', 2)]))?.id).toBe(id('spades', 3)) // the top landed first, the one under it is still flying
    expect(topLandedCard(pile, new Set([id('spades', 3), id('spades', 2)]))?.id).toBe(id('spades', 1))
  })

  it('is null (the empty slot) when nothing has landed', () => {
    expect(topLandedCard(pile, new Set(pile.map((c) => c.id)))).toBeNull()
    expect(topLandedCard([], new Set())).toBeNull()
  })
})
