import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { Profiler } from 'react'
import { StyleSheet } from 'react-native'

import { GHOST_PAINT_MAX_MS, isAnyFaceLoading, LANDED_GHOST_MAX_MS, markGhostPending } from '@/components/cardFacePaint'
import { FLIGHT_SPRING, springSettleMs } from '@/components/dragdrop/dragSpring'
import { CHAIN_SEGMENT_DELAY_MS } from '@/components/winning/winCascadeMotion'
import { PileRef } from '@/engine/gameTypes'
import { Card } from '@/engine/types'
import { MoveInfo } from '@/games/shared/undoTypes'
import { createSpiderController, SpiderState } from '@/games/spider/rules'
import SpiderScreen from '@/games/spider/SpiderScreen'

import { resetGameInProgress, seedGameInProgress } from '../../../testUtils/gameInProgressStore'

// ---------------------------------------------------------------------------------------------------------------------
// Spider's completed-run flights (SequenceFlightGhosts) against the paint machinery in cardFacePaint.ts: a card face is ONE
// Image whose bitmap arrives a frame or two after the commit that mounts it, so a card must stay drawn - by its source, its
// ghost, or the real card it lands on - through every commit of a take-off and a landing. The REAL SpiderScreen, PileView
// (and its take-off hold), useTakeOffHold and cardFacePaint registry; stand-ins only for what needs native views:
//   - PlayingCard: a board face (FaceLoadTrackingContext on) is "loading" (trackFaceLoad) from the commit it mounts until a
//     passive effect later - its bitmap arriving - unless a test holds it (mockPaint.holdBoard). A ghost's face reports
//     painted (onFacePainted) the same way, unless held (mockPaint.holdGhost).
//   - DragGhostLayer: the tap/undo ghost is a small model of the real one's take-off - show() marks its face-up cards as
//     taking off (markGhostPending), its ghost is drawn at opacity 0 until its faces have painted (the real
//     useGhostPaintGate), which releases the mark - plus a faithful card registry (a card measures only while some pile
//     registers it, like CardRegistry).
//   - DealLayer, the win cascade, slot measurement, chrome, sounds: as in spiderScreenWin.test.tsx.
// "Drawn" = a PlayingCard whose host view has no ancestor at opacity 0 (a hidden pile card, an unpainted ghost). "Seen" is
// stricter: drawn by a ghost that is showing, or by a board card whose face has painted (not a blank face).
// ---------------------------------------------------------------------------------------------------------------------

const FLIGHT_MS = 80

const mockMeasureView = jest.fn(async (): Promise<{ x: number; y: number } | null> => ({ x: 5, y: 5 }))
const mockRegistered = new Map<string, unknown>()

/** Paint control: ids whose board face / ghost face does not report painted until the test says so. */
const mockPaint = {
  holdBoard: new Set<string>(),
  holdGhost: new Set<string>(),
  boardWaiting: new Map<string, (() => void)[]>(),
  ghostWaiting: new Map<string, (() => void)[]>()
}
function mockQueue(waiting: Map<string, (() => void)[]>, id: string, done: () => void) {
  waiting.set(id, [...(waiting.get(id) ?? []), done])
}

/** The tap/undo ghosts on screen (DragGhostLayer stand-in) - see the header. */
interface MockDragFlight {
  id: number
  cards: Card[]
  release: () => void
}
const mockDrag = { flights: [] as MockDragFlight[], listeners: new Set<() => void>(), nextId: 0 }
function mockSetDragFlights(flights: MockDragFlight[]) {
  mockDrag.flights = flights
  mockDrag.listeners.forEach((listener) => listener())
}
const mockGhost = {
  cardRegistry: {
    register: (id: string, ref: unknown) => void mockRegistered.set(id, ref),
    unregister: (id: string, ref: unknown) => {
      if (mockRegistered.get(id) === ref) mockRegistered.delete(id)
    },
    measure: async (id: string) => (mockRegistered.has(id) ? { x: 10, y: 10, width: 50, height: 70 } : null)
  },
  show: (spec: { cards: Card[] }) => {
    // Like the real addFlight: marked synchronously, before the move's own commit renders.
    const release = markGhostPending(spec.cards.filter((c) => c.faceUp).map((c) => c.id))
    const flight: MockDragFlight = { id: ++mockDrag.nextId, cards: spec.cards, release }
    mockSetDragFlights([...mockDrag.flights, flight])
    const end = () => {
      release()
      mockSetDragFlights(mockDrag.flights.filter((f) => f.id !== flight.id))
    }
    return {
      hide: end,
      flyTo: (_x: number, _y: number, onDone?: () => void) => {
        setTimeout(() => {
          end()
          onDone?.()
        }, FLIGHT_MS)
      }
    }
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
jest.mock('@/components/dragdrop/DragGhostLayer', () => {
  const { useMemo, useSyncExternalStore } = require('react')
  const { View: MockView } = require('react-native')
  const { FaceLoadTrackingContext, useGhostPaintGate } = require('@/components/cardFacePaint')
  const { PlayingCard: MockPlayingCard } = require('@/components/PlayingCard')
  const unpainted = { opacity: 0 }
  const subscribe = (listener: () => void) => {
    mockDrag.listeners.add(listener)
    return () => void mockDrag.listeners.delete(listener)
  }
  function MockDragGhost({ flight }: { flight: MockDragFlight }) {
    const faceIds = useMemo(() => flight.cards.filter((c) => c.faceUp).map((c) => c.id), [flight])
    const { shown, markPainted } = useGhostPaintGate(faceIds, flight.release)
    return (
      <MockView testID='drag-ghost' style={shown ? undefined : unpainted}>
        <FaceLoadTrackingContext.Provider value={false}>
          {flight.cards.map((c) => (
            <MockPlayingCard key={c.id} card={c} onFacePainted={() => markPainted(c.id)} />
          ))}
        </FaceLoadTrackingContext.Provider>
      </MockView>
    )
  }
  function MockDragGhosts() {
    const flights: MockDragFlight[] = useSyncExternalStore(subscribe, () => mockDrag.flights)
    return flights.map((flight) => <MockDragGhost key={flight.id} flight={flight} />)
  }
  return {
    DragGhostProvider: ({ children }: { children: unknown }) => (
      <>
        {children}
        <MockDragGhosts />
      </>
    ),
    useDragGhost: () => mockGhost
  }
})
jest.mock('@/components/PlayingCard', () => {
  const { useContext, useEffect, useLayoutEffect, useRef } = require('react')
  const { View: MockView } = require('react-native')
  const { FaceLoadTrackingContext, trackFaceLoad } = require('@/components/cardFacePaint')
  function MockPlayingCard({ card, style, onFacePainted }: { card: Card; style?: unknown; onFacePainted?: () => void }) {
    const board = useContext(FaceLoadTrackingContext)
    const tracked = board && card.faceUp
    const loaded: { current: (() => void) | null } = useRef(null)
    // A board face is loading from the commit it mounts (CardFaceImage's layout effect)...
    useLayoutEffect(() => {
      if (!tracked) return
      const done = trackFaceLoad(card.id)
      loaded.current = done
      return done
    }, [tracked, card.id])
    // ...until its bitmap arrives, a passive effect later - or when the test lets it.
    useEffect(() => {
      if (!tracked || !loaded.current) return
      if (mockPaint.holdBoard.has(card.id)) mockQueue(mockPaint.boardWaiting, card.id, loaded.current)
      else loaded.current()
    }, [tracked, card.id])
    // A ghost's face reports itself painted the same way.
    useEffect(() => {
      if (!onFacePainted) return
      if (mockPaint.holdGhost.has(card.id)) mockQueue(mockPaint.ghostWaiting, card.id, onFacePainted)
      else onFacePainted()
    }, [onFacePainted, card.id])
    return <MockView testID={`${board ? 'pc' : 'ghost'}-${card.id}`} style={style} />
  }
  return { PlayingCard: MockPlayingCard, EmptySlot: () => <MockView testID='empty-slot' /> }
})
jest.mock('react-native-reanimated', () => {
  const { useRef } = require('react')
  const base = jest.requireActual('../../../__mocks__/react-native-reanimated')
  return { ...base, useSharedValue: (initial: unknown) => useRef({ value: initial }).current, useAnimatedRef: () => useRef({ current: null }).current }
})
jest.mock('react-native-gesture-handler', () => {
  const pan = () => {
    const g: Record<string, unknown> = {}
    for (const method of ['minDistance', 'onStart', 'onUpdate', 'onEnd', 'enabled']) g[method] = () => g
    return g
  }
  return { Gesture: { Pan: pan }, GestureDetector: ({ children }: { children: unknown }) => children }
})
jest.mock('@/components/dealing/DealLayer', () => ({ DealProvider: ({ children }: { children: unknown }) => children, useDealAnimator: () => mockDeal }))
jest.mock('@/components/winning/WinCascadeLayer', () => ({
  WinCascadeProvider: ({ children }: { children: unknown }) => children,
  WinCascadeGhosts: () => null,
  useWinCascade: () => ({ startChains: () => {}, clear: () => {} })
}))
jest.mock('@/components/dealing/measureView', () => ({ measureView: () => mockMeasureView() }))
jest.mock('@tastic/core', () => ({ ...jest.requireActual('@tastic/core'), RotationAwareStatusBar: () => null }))
jest.mock('@/components/useCardSounds', () => ({ useCardSoundEffects: () => ({ playCardSound: () => {}, playInvalidSound: () => {}, hapticCard: () => {}, hapticInvalid: () => {} }) }))
jest.mock('@rific/feedback-press', () => {
  const { Pressable: MockPressable } = require('react-native')
  return { Pressable: MockPressable, useVibration: () => ({ short: () => {}, selection: () => {} }) }
})
jest.mock('@rific/toaster', () => ({ useToast: () => ({ info: () => {} }) }))
jest.mock('@tastic/animations/fireworks', () => ({ Fireworks: () => null }))
jest.mock('@/games/shared/WinBanner', () => ({ WinBanner: () => null }))
jest.mock('@/stores/gameStats', () => ({ useGameStats: () => ({ recordDealWon: () => {}, recordDealAbandoned: () => {}, recordHintUsed: () => {} }) }))
jest.mock('@/stores/lastActiveGame', () => ({ useLastActiveGame: () => ({ setLastActiveGame: () => {}, clearLastActiveGame: () => {} }) }))
jest.mock('@/hooks/useSettings', () => {
  const actual = jest.requireActual('@/redux/settingsSlice')
  return { useSettings: () => ({ settings: { ...actual.DEFAULT_SETTINGS, spiderSuits: 1 } }) }
})
jest.mock('@/components/theme', () => {
  const actual = jest.requireActual('@/components/theme')
  return { ...actual, useTableColors: () => actual.lightColors }
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
const run = (high: number, low: number, deck: number): Card[] => {
  const cards: Card[] = []
  for (let r = high; r >= low; r--) cards.push(card(r, deck))
  return cards
}
const KING = 'spades-13-0'
const ACE = 'spades-1-0'
const controller = createSpiderController(1)
const tableau = (index: number): PileRef => ({ zone: 'tableau', index })

/** King..2 of deck 0 on a 6 in column 0, its Ace on a 9 in column 1, a 9 in every other column, one deal left. The deal's 5s
 * are decks 10-19: a deck-0 5 there would be a second copy of the run's own 5 (see spiderScreenWin.test.tsx's same board). */
function firstRunOneMoveAway(): SpiderState {
  const cols: Card[][] = Array.from({ length: 10 }, () => [])
  cols[0] = [card(6, 8), ...run(13, 2, 0)]
  cols[1] = [card(9, 1), card(1, 0)]
  for (let col = 2; col < 10; col++) cols[col] = [card(9, col)]
  const stock = Array.from({ length: 10 }, (_, d) => ({ ...card(5, 10 + d), faceUp: false }))
  return { tableau: cols, stock, completed: [], completedRuns: [] }
}

/** The same board, but it is the stock deal that brings the Ace (top of the stock) onto column 0's 2. */
function dealCompletesFirstRun(): SpiderState {
  const state = firstRunOneMoveAway()
  const [ace] = state.tableau[1].splice(1, 1)
  state.stock = [{ ...ace, faceUp: false }, ...state.stock.slice(1)]
  return state
}

/** A saved game just after the Ace was moved onto the 2: the run is complete and swept into slot 0, and the move is the one
 * entry on the undo stack - so Undo flies the run back out of its slot, then the Ace home to column 1. */
function afterCompletingMove() {
  const prev = firstRunOneMoveAway()
  const move: MoveInfo = { from: tableau(1), to: tableau(0), count: 1, anchorCardId: ACE }
  const state = controller.tryMove(prev, { from: move.from, to: move.to, count: 1 })!
  expect(state.completed.map((c) => c.id)).toEqual([KING])
  return { state, undoStack: [{ state: prev, move }] }
}

/** A saved game just after the stock deal that completed the run (swept into slot 0): Undo flies the run back out of its
 * slot while the nine other dealt cards fly back to the stock. */
function afterCompletingDeal() {
  const prev = dealCompletesFirstRun()
  const state = controller.drawStock!(prev)!
  expect(state.completed.map((c) => c.id)).toEqual([KING])
  return { state, undoStack: [{ state: prev, move: null }] }
}

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

type Node = { props: { style?: unknown; testID?: string }; parent: Node | null }
const all = (testID: string) => screen.queryAllByTestId(testID, { includeHiddenElements: true }) as unknown as Node[]
function visible(node: Node): boolean {
  for (let n: Node | null = node; n; n = n.parent) if ((StyleSheet.flatten(n.props.style as never) as { opacity?: number } | undefined)?.opacity === 0) return false
  return true
}
function inDragGhost(node: Node): boolean {
  for (let n: Node | null = node.parent; n; n = n.parent) if (n.props.testID === 'drag-ghost') return true
  return false
}
/** Card `id` is drawn somewhere: on the board (a pile, a slot, a pile's take-off hold) or as a ghost that is showing. */
const drawn = (id: string) => [...all(`pc-${id}`), ...all(`ghost-${id}`)].some(visible)
/** Card `id` can really be seen: a ghost of it is showing, or a board copy whose face has painted (never a blank face). */
const seen = (id: string) => all(`ghost-${id}`).some(visible) || (all(`pc-${id}`).some(visible) && !isAnyFaceLoading([id]))
/** The completed-run flights' ghosts of card `id` (mounted, whatever their opacity) - not the tap/undo ghosts. */
const sequenceGhosts = (id: string) => all(`ghost-${id}`).filter((n) => !inDragGhost(n))
const dragGhostShowing = (id: string) => all(`ghost-${id}`).some((n) => inDragGhost(n) && visible(n))

/** Whether each watched card was drawn (or, with `strict`, seen), recorded at EVERY commit (a Profiler's onRender runs in
 * each commit, once the host tree has been updated) while `recording`. */
const commits: Record<string, boolean>[] = []
let recording = false
let watched: string[] = []
let strict = false
function recordCommit() {
  if (!recording) return
  commits.push(Object.fromEntries(watched.map((id) => [id, strict ? seen(id) : drawn(id)])))
}
function watch(ids: string[], { seenOnly = false } = {}) {
  watched = ids
  strict = seenOnly
  commits.length = 0
  recording = true
}

async function mount(state: SpiderState, undoStack: unknown[] = []) {
  seedGameInProgress('spider', { state, undoStack, moves: 5, elapsedSeconds: 30, config: 1 })
  await render(
    <Profiler id='spider' onRender={recordCommit}>
      <SpiderScreen />
    </Profiler>
  )
  await flush() // loadGameInProgress -> restoreGame
}

async function press(testID: 'undo' | 'new-game') {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID))
  })
}

async function tapStock() {
  await act(async () => {
    fireEvent.press(all('pc-stock-packet')[0] as never)
  })
}

async function paintGhost(id: string) {
  mockPaint.holdGhost.delete(id)
  const waiting = mockPaint.ghostWaiting.get(id) ?? []
  mockPaint.ghostWaiting.delete(id)
  await act(async () => waiting.forEach((painted) => painted()))
}

async function paintBoard(id: string) {
  mockPaint.holdBoard.delete(id)
  const waiting = mockPaint.boardWaiting.get(id) ?? []
  mockPaint.boardWaiting.delete(id)
  await act(async () => {
    waiting.forEach((painted) => painted())
    await Promise.resolve() // cardFacePaint notifies its listeners from a promise job
  })
}

/** A restore's whole flight: the run leaves its slot one CHAIN_SEGMENT_DELAY_MS apart, King first, Ace last. */
const RESTORE_MS = 12 * CHAIN_SEGMENT_DELAY_MS + springSettleMs(FLIGHT_SPRING)

beforeEach(() => {
  jest.useFakeTimers()
  mockRegistered.clear()
  mockSetDragFlights([])
  mockPaint.holdBoard.clear()
  mockPaint.holdGhost.clear()
  mockPaint.boardWaiting.clear()
  mockPaint.ghostWaiting.clear()
  mockMeasureView.mockClear()
  mockMeasureView.mockImplementation(async () => ({ x: 5, y: 5 }))
  recording = false
  commits.length = 0
})
afterEach(async () => {
  recording = false
  mockPaint.holdBoard.clear()
  mockPaint.holdGhost.clear()
  // Anything still waiting is let through, and every backstop (a take-off mark's included) runs out.
  await act(async () => {
    mockPaint.ghostWaiting.forEach((waiting) => waiting.forEach((painted) => painted()))
    mockPaint.boardWaiting.forEach((waiting) => waiting.forEach((painted) => painted()))
    await jest.runOnlyPendingTimersAsync()
  })
  jest.useRealTimers()
  jest.restoreAllMocks()
})

// The forward sweep: the run's ghosts land on its slot in the commit that mounts the slot's King - a new face Image, blank
// for a frame or two. The ghosts used to go in that same commit, so the King showed blank.

// Each test starts with no saved games (the store helper is shared across the file).
afterEach(() => resetGameInProgress())

describe('Spider - a sweep keeps its ghosts over the slot until the King there has painted', () => {
  async function sweepToSlot() {
    await mount(dealCompletesFirstRun())
    await tapStock()
    await flush(FLIGHT_MS + 10) // the deal lands, the Ace completes King..Ace on column 0, and the run leaves for slot 0
    expect(sequenceGhosts(ACE)).toHaveLength(1)
    expect(sequenceGhosts(ACE).every(visible)).toBe(true)
  }

  it('the landed ghosts stay - still and shadowless - until the slot King face has painted, then go at once', async () => {
    await sweepToSlot()
    mockPaint.holdBoard.add(KING) // the slot's King, once it mounts, stays loading
    await flush(RESTORE_MS) // the King - the last card to leave - has landed: the slot draws it from this commit on

    expect(all(`pc-${KING}`)).toHaveLength(1) // the slot's King is mounted (its face still loading)...
    const landed = sequenceGhosts(KING)
    expect(landed).toHaveLength(1) // ...under the run's ghosts, still standing on it
    expect(sequenceGhosts(ACE)).toHaveLength(1)
    expect(landed.every(visible)).toBe(true)
    // A landed ghost draws no shadow: the real card under it draws its own.
    expect(StyleSheet.flatten(landed[0].props.style as never)).toEqual(expect.objectContaining({ shadowOpacity: 0, elevation: 0 }))

    await paintBoard(KING)
    expect(sequenceGhosts(KING)).toHaveLength(0)
    expect(sequenceGhosts(ACE)).toHaveLength(0)
    expect(all(`pc-${KING}`).every(visible)).toBe(true)
  })

  it('a face that never reports holds them no longer than LANDED_GHOST_MAX_MS', async () => {
    await sweepToSlot()
    mockPaint.holdBoard.add(KING)
    await flush(RESTORE_MS)
    expect(sequenceGhosts(KING)).toHaveLength(1)

    await flush(LANDED_GHOST_MAX_MS + STEP_MS)
    expect(sequenceGhosts(KING)).toHaveLength(0)
  })

  it('the slot King is never a blank face: in every commit from the landing on it is seen by its ghost, then by its own painted face', async () => {
    await sweepToSlot()
    mockPaint.holdBoard.add(KING)
    await flush(RESTORE_MS - 3 * STEP_MS) // just short of the King's landing
    watch([KING], { seenOnly: true })
    await flush(5 * STEP_MS)
    await paintBoard(KING)
    await flush(LANDED_GHOST_MAX_MS)
    expect(commits.length).toBeGreaterThan(0)
    expect(commits.filter((c) => !c[KING])).toEqual([])
  })
})

// An undo of a move that completed a run is two flights: the run back out of its slot into column 0 (King first, the Ace
// last), then - from the Ace's landing - the Ace home to column 1 as a new tap/undo ghost, invisible until its face has
// painted. The Ace's landing used to drop the run's ghosts in that very commit, while the column (which had only a
// FlyingCardSlot for the Ace there) had nothing to hold: the Ace was drawn nowhere until the new ghost showed.
describe('Spider - undoing a run-completing move never leaves its top card drawn nowhere', () => {
  it('the Ace is drawn in every commit from the moment the run leaves its slot to the moment it is home', async () => {
    const { state, undoStack } = afterCompletingMove()
    await mount(state, undoStack)
    watch([ACE])

    await press('undo')
    await flush(5 * STEP_MS) // the run's ghosts are on screen and flying back to column 0
    expect(sequenceGhosts(ACE).every(visible)).toBe(true)
    mockPaint.holdGhost.add(ACE) // the Ace's own flight home will stay invisible until its face paints

    await flush(RESTORE_MS - 5 * STEP_MS + 2 * STEP_MS) // the Ace has landed in column 0 and taken off again
    expect(all('drag-ghost')).toHaveLength(1)
    expect(dragGhostShowing(ACE)).toBe(false) // its new ghost is not on screen yet...
    expect(sequenceGhosts(ACE).filter(visible)).toHaveLength(1) // ...so the run's landed ghost still stands over it

    await paintGhost(ACE)
    expect(dragGhostShowing(ACE)).toBe(true)
    expect(sequenceGhosts(ACE)).toHaveLength(0) // and goes the commit the new ghost shows

    await flush(FLIGHT_MS + 2 * STEP_MS) // the Ace is home in column 1
    expect(all('drag-ghost')).toHaveLength(0)
    expect(all(`pc-${ACE}`).filter(visible)).toHaveLength(1)

    const firstDrawn = commits.findIndex((c) => c[ACE])
    expect(firstDrawn).toBeGreaterThanOrEqual(0)
    expect(commits.slice(firstDrawn).filter((c) => !c[ACE])).toEqual([])
  })

  it('a phase-2 ghost that never reports painted still shows by its backstop, and the Ace is drawn throughout', async () => {
    const { state, undoStack } = afterCompletingMove()
    await mount(state, undoStack)
    watch([ACE])

    await press('undo')
    await flush(5 * STEP_MS)
    mockPaint.holdGhost.add(ACE)
    await flush(RESTORE_MS + GHOST_PAINT_MAX_MS + FLIGHT_MS + LANDED_GHOST_MAX_MS)

    expect(all(`pc-${ACE}`).filter(visible)).toHaveLength(1)
    expect(sequenceGhosts(ACE)).toHaveLength(0)
    const firstDrawn = commits.findIndex((c) => c[ACE])
    expect(commits.slice(firstDrawn).filter((c) => !c[ACE])).toEqual([])
  })
})

// The revert of an undo takes the King out of its slot, but the restore's ghosts only exist once their destinations have
// been measured (the commit after) and only show once their faces have painted. The slot used to go empty in the revert
// commit, so for that whole wait the run was drawn nowhere.
describe('Spider - a run flying back out of its slot leaves the King there until its ghosts are on screen', () => {
  async function undoAndHoldRestoreGhosts(saved: { state: SpiderState; undoStack: unknown[] }) {
    await mount(saved.state, saved.undoStack)
    mockPaint.holdGhost.add(KING) // the restore group stays invisible until the King's ghost face has painted
    expect(all(`pc-${KING}`).every(visible)).toBe(true)
    watch([KING])
    await press('undo')
    await flush(3 * STEP_MS) // the restore group is mounted, waiting on that face
  }

  it.each([
    ['a move that completed a run', afterCompletingMove],
    ['a stock deal that completed a run', afterCompletingDeal]
  ])('undoing %s', async (_name, saved) => {
    await undoAndHoldRestoreGhosts(saved())

    expect(sequenceGhosts(KING)).toHaveLength(1)
    expect(sequenceGhosts(KING).some(visible)).toBe(false) // the ghosts are not on screen yet...
    const kingInSlot = all(`pc-${KING}`)
    expect(kingInSlot).toHaveLength(1) // ...so the slot still draws its King (the run's cards in column 0 are only
    expect(kingInSlot.every(visible)).toBe(true) // FlyingCardSlots until their flights land)

    await paintGhost(KING)
    expect(sequenceGhosts(KING).every(visible)).toBe(true) // the ghosts show...
    expect(all(`pc-${KING}`)).toHaveLength(0) // ...and the slot lets go in that same commit
    expect(all('empty-slot').length).toBeGreaterThan(0)

    await flush(RESTORE_MS + GHOST_PAINT_MAX_MS + FLIGHT_MS + LANDED_GHOST_MAX_MS)
    expect(commits.length).toBeGreaterThan(0)
    expect(commits.filter((c) => !c[KING])).toEqual([]) // drawn in every commit: the slot, its ghost, then column 0
    expect(all(`pc-${KING}`).filter(visible)).toHaveLength(1)
  })

  it('a restore that cannot measure its destinations gives the slot hold back at once instead of leaving it to its backstop', async () => {
    const { state, undoStack } = afterCompletingMove()
    await mount(state, undoStack)
    // Every card measurement from here on fails: the run is revealed in column 0 without a flight.
    const measure = jest.spyOn(mockGhost.cardRegistry, 'measure').mockImplementation(async () => null)
    await press('undo')
    await flush(STEP_MS)
    measure.mockRestore()

    expect(sequenceGhosts(KING)).toHaveLength(0)
    expect(all(`pc-${KING}`)).toHaveLength(1) // only one King: the one revealed in column 0, not a second one held in the slot
  })
})
