import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { Profiler } from 'react'
import { StyleSheet } from 'react-native'

import { isGhostPending } from '@/components/cardFacePaint'
import { TAKE_OFF_RELEASE_LAG_MS } from '@/components/dealing/DealLayer'
import { Card } from '@/engine/types'
import { createScorpionController, ScorpionState } from '@/games/scorpion/rules'
import ScorpionScreen from '@/games/scorpion/ScorpionScreen'

import { resetGameInProgress, seedGameInProgress } from '../../../testUtils/gameInProgressStore'

// ---------------------------------------------------------------------------------------------------------------------
// Undoing the assisted stock's deal flies its three cards back to the packet through DealLayer, and the revert that takes them
// out of columns 4-6 commits long before each one's ghost takes off: the restored packet is measured a commit later, then the
// deal pool mounts, then each card waits out its own stagger (its column x DEAL_STAGGER_MS: 140-210ms) - plus a face-up
// ghost's wait for its face to paint. The columns used to drop the cards in the revert commit, so they vanished from the board
// and came back as ghosts one by one. Now each card is marked as taking off (cardFacePaint.ts) right before that commit, so its
// column keeps drawing it (PileView's held cards) until DealLayer gives the hold back, TAKE_OFF_RELEASE_LAG_MS after the
// card's own take-off.
//
// The same harness as spiderUndoDealHold.test.tsx: the REAL ScorpionScreen, PileView, DealLayer and cardFacePaint registry;
// a Reanimated whose withDelay lands on (fake) time and re-renders its owner, so a deal ghost turns visible at its real
// take-off; overlayFrame measured at once; a PlayingCard whose ghost face reports painted a passive effect after it mounts;
// a faithful card registry. "Drawn" = a PlayingCard whose host view has no ancestor at opacity 0.
// ---------------------------------------------------------------------------------------------------------------------

const mockRegistered = new Map<string, unknown>()
const mockGhost = {
  cardRegistry: {
    register: (id: string, ref: unknown) => void mockRegistered.set(id, ref),
    unregister: (id: string, ref: unknown) => {
      if (mockRegistered.get(id) === ref) mockRegistered.delete(id)
    },
    measure: async (id: string) => (mockRegistered.has(id) ? { x: 10, y: 10, width: 50, height: 70 } : null)
  },
  show: () => ({ hide: () => {}, flyTo: (_x: number, _y: number, onDone?: () => void) => setTimeout(() => onDone?.(), 80) })
}

jest.mock('@/redux/store', () => require('../../../testUtils/gameInProgressStore').storeModule)
jest.mock('react-native-reanimated', () => {
  const { useReducer, useRef } = require('react')
  const base = jest.requireActual('../../../__mocks__/react-native-reanimated')
  class MockLiveValue {
    current: unknown
    timer: ReturnType<typeof setTimeout> | null = null
    rerender: () => void = () => {}
    constructor(initial: unknown) {
      this.current = initial
    }
    get value() {
      return this.current
    }
    set value(next: unknown) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      const delayed = next as { mockDelayMs?: number; value?: unknown } | null
      if (delayed && typeof delayed === 'object' && delayed.mockDelayMs !== undefined) {
        this.timer = setTimeout(() => {
          this.timer = null
          this.current = delayed.value
          this.rerender()
        }, delayed.mockDelayMs)
      } else this.current = next
    }
  }
  return {
    ...base,
    useSharedValue: (initial: unknown) => {
      const [, rerender] = useReducer((n: number) => n + 1, 0)
      const ref = useRef(null)
      if (!ref.current) ref.current = new MockLiveValue(initial)
      ref.current.rerender = rerender
      return ref.current
    },
    useAnimatedRef: () => useRef({ current: null }).current,
    withDelay: (ms: number, value: unknown) => ({ mockDelayMs: ms, value }),
    cancelAnimation: (value: { timer?: ReturnType<typeof setTimeout> | null }) => {
      if (value?.timer) clearTimeout(value.timer)
      if (value) value.timer = null
    }
  }
})
jest.mock('@/components/overlayFrame', () => ({
  ...jest.requireActual('@/components/overlayFrame'),
  useOverlayFrame: () => ({ overlayRef: { current: null }, frame: {}, ready: true }),
  toLocal: (x: number, y: number) => ({ x, y })
}))
jest.mock('@/components/dragdrop/DragGhostLayer', () => ({ DragGhostProvider: ({ children }: { children: unknown }) => children, useDragGhost: () => mockGhost }))
jest.mock('@/components/PlayingCard', () => {
  const { useContext, useEffect } = require('react')
  const { View: MockView } = require('react-native')
  const { FaceLoadTrackingContext } = require('@/components/cardFacePaint')
  function MockPlayingCard({ card, style, onFacePainted }: { card: Card; style?: unknown; onFacePainted?: () => void }) {
    const board = useContext(FaceLoadTrackingContext)
    // Every card here has runway before its departure, so its take-off never waits on its face: a face simply reports painted.
    useEffect(() => {
      onFacePainted?.()
    }, [onFacePainted, card.id])
    return <MockView testID={`${board ? 'pc' : 'ghost'}-${card.id}`} style={style} />
  }
  return { PlayingCard: MockPlayingCard, EmptySlot: () => <MockView testID='empty-slot' /> }
})
jest.mock('react-native-gesture-handler', () => {
  const pan = () => {
    const g: Record<string, unknown> = {}
    for (const method of ['minDistance', 'onStart', 'onUpdate', 'onEnd', 'enabled']) g[method] = () => g
    return g
  }
  return { Gesture: { Pan: pan }, GestureDetector: ({ children }: { children: unknown }) => children }
})
jest.mock('@/components/winning/WinCascadeLayer', () => ({
  WinCascadeProvider: ({ children }: { children: unknown }) => children,
  WinCascadeGhosts: () => null,
  useWinCascade: () => ({ startChains: () => {}, clear: () => {} })
}))
jest.mock('@/components/dealing/measureView', () => ({ measureView: async () => ({ x: 5, y: 5 }) }))
jest.mock('@/components/useCardSounds', () => ({ useCardSoundEffects: () => ({ playCardSound: () => {}, playInvalidSound: () => {}, hapticCard: () => {}, hapticInvalid: () => {} }) }))
jest.mock('@rific/feedback-press', () => {
  const { Pressable: MockPressable } = require('react-native')
  return { Pressable: MockPressable, useVibration: () => ({ short: () => {}, selection: () => {} }) }
})
jest.mock('@rific/toaster', () => ({ useToast: () => ({ info: () => {} }) }))
jest.mock('@tastic/sprites/fireworks', () => ({ Fireworks: () => null }))
jest.mock('@/games/shared/WinBanner', () => ({ WinBanner: () => null }))
jest.mock('@/stores/gameStats', () => ({ useGameStats: () => ({ recordDealWon: () => {}, recordDealAbandoned: () => {}, recordHintUsed: () => {} }) }))
jest.mock('@/stores/lastActiveGame', () => ({ useLastActiveGame: () => ({ setLastActiveGame: () => {}, clearLastActiveGame: () => {} }) }))
jest.mock('@/hooks/useSettings', () => {
  const actual = jest.requireActual('@/redux/settingsSlice')
  return { useSettings: () => ({ settings: { ...actual.DEFAULT_SETTINGS, scorpionAssistedStock: true } }) }
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

const controller = createScorpionController(true)

/** A saved game just after the assisted stock's deal (the one entry on the undo stack), and the cards it left in the columns. */
function afterDeal() {
  const prev = controller.newGame(20261004)
  expect(prev.stock).toHaveLength(3)
  const state = controller.drawStock!(prev)!
  const dealt = state.tableau.flatMap((col, i) => (col.length === prev.tableau[i].length + 1 ? [col[col.length - 1].id] : []))
  return { state, undoStack: [{ state: prev, move: null }], dealt }
}

// ------------------------------------------------------------------------------------------------ harness

const STEP_MS = 5

async function flush(ms: number) {
  for (let t = 0; t < ms; t += STEP_MS) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(Math.min(STEP_MS, ms - t))
    })
  }
}

type Node = { props: { style?: unknown; testID?: string }; parent: Node | null }
const all = (testID: string) => screen.queryAllByTestId(testID, { includeHiddenElements: true }) as unknown as Node[]
const flat = (node: Node) => (StyleSheet.flatten(node.props.style as never) ?? {}) as { opacity?: number; pointerEvents?: string }
function visible(node: Node): boolean {
  for (let n: Node | null = node; n; n = n.parent) if (flat(n).opacity === 0) return false
  return true
}
/** A board copy of card `id` is drawn (in its column, or held there as it takes off). */
const onBoard = (id: string) => all(`pc-${id}`).some(visible)
/** A board copy of card `id` is drawn as a HELD card - one that has left its column (PileView's inert `held` card). */
function heldOnBoard(id: string): boolean {
  return all(`pc-${id}`).some((node) => {
    if (!visible(node)) return false
    for (let n: Node | null = node.parent; n; n = n.parent) if (flat(n).pointerEvents === 'none') return true
    return false
  })
}
/** A deal ghost of card `id` is on screen. */
const ghostUp = (id: string) => all(`ghost-${id}`).some(visible)

/** For every watched card, at EVERY commit while recording (a Profiler's onRender runs in each commit, once the host tree
 * is updated): whether its column draws it, and whether its ghost is up - and when (fake time). */
const commits: { at: number; board: Record<string, boolean>; ghost: Record<string, boolean>; held: Record<string, boolean> }[] = []
let recording = false
let watched: string[] = []
function recordCommit() {
  if (!recording) return
  commits.push({
    at: Date.now(),
    board: Object.fromEntries(watched.map((id) => [id, onBoard(id)])),
    ghost: Object.fromEntries(watched.map((id) => [id, ghostUp(id)])),
    held: Object.fromEntries(watched.map((id) => [id, heldOnBoard(id)]))
  })
}
function watch(ids: string[]) {
  watched = ids
  commits.length = 0
  recording = true
}

async function mount(state: ScorpionState, undoStack: unknown[]) {
  seedGameInProgress('scorpion', { state, undoStack, moves: 5, elapsedSeconds: 30, config: 1 })
  await render(
    <Profiler id='scorpion' onRender={recordCommit}>
      <ScorpionScreen />
    </Profiler>
  )
  await flush(STEP_MS) // loadGameInProgress -> restoreGame
}

async function press(testID: 'undo' | 'new-game') {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID))
  })
}

/** Each watched card is drawn in every commit from the undo until its ghost is up - by its column, then by its ghost - and
 * its column keeps drawing it, under its ghost, for DealLayer's TAKE_OFF_RELEASE_LAG_MS after that (on a device the UI thread can
 * show the ghost a frame or so after the JS timer that gives the hold back), then lets go of it. A commit lands at the end of
 * the STEP_MS slice its update fell in, so a commit time is good to STEP_MS. */
function expectDrawnUntilTakeOff(ids: string[]) {
  expect(commits.length).toBeGreaterThan(0)
  ids.forEach((id) => {
    const takeOff = commits.findIndex((c) => c.ghost[id])
    expect({ id, tookOff: takeOff >= 0 }).toEqual({ id, tookOff: true })
    const gaps = commits.slice(0, takeOff + 1).flatMap((c, i) => (c.board[id] || c.ghost[id] ? [] : [i]))
    expect({ id, commitsDrawnNowhere: gaps }).toEqual({ id, commitsDrawnNowhere: [] })
    const takeOffAt = commits[takeOff].at
    const letGoInLag = commits.slice(takeOff).flatMap((c, i) => (!c.board[id] && c.at < takeOffAt + TAKE_OFF_RELEASE_LAG_MS - STEP_MS ? [takeOff + i] : []))
    expect({ id, commitsLetGoWithinTheLag: letGoInLag }).toEqual({ id, commitsLetGoWithinTheLag: [] })
    const lingering = commits.slice(takeOff).flatMap((c, i) => (c.board[id] && c.at >= takeOffAt + TAKE_OFF_RELEASE_LAG_MS + STEP_MS ? [takeOff + i] : []))
    expect({ id, commitsStillHeldAfterTheLag: lingering }).toEqual({ id, commitsStillHeldAfterTheLag: [] })
  })
}

beforeEach(() => {
  jest.useFakeTimers()
  mockRegistered.clear()
  recording = false
  commits.length = 0
})
afterEach(async () => {
  recording = false
  // Every backstop (a take-off mark's included) runs out.
  await act(async () => {
    await jest.runOnlyPendingTimersAsync()
  })
  jest.useRealTimers()
  jest.restoreAllMocks()
})

// Each test starts with no saved games (the store helper is shared across the file).
afterEach(() => resetGameInProgress())

describe('Scorpion - undoing the stock deal keeps every dealt card drawn until its own ghost takes off', () => {
  it('each card stays in its column - inert, where it was - until its ghost is up over it, then the column lets go', async () => {
    const { state, undoStack, dealt } = afterDeal()
    expect(dealt).toHaveLength(3)
    await mount(state, undoStack)
    dealt.forEach((id) => expect(onBoard(id)).toBe(true))
    watch(dealt)

    await press('undo')
    // The revert has committed (the three cards are out of the columns) but no ghost is up yet: every one is held where it was.
    expect(commits.length).toBeGreaterThan(0)
    dealt.forEach((id) => expect({ id, held: heldOnBoard(id), ghost: ghostUp(id) }).toEqual({ id, held: true, ghost: false }))

    await flush(1000) // the whole deal back: the cards leave 140-210ms in and fly 280ms
    expectDrawnUntilTakeOff(dealt)
    dealt.forEach((id) => {
      expect(onBoard(id)).toBe(false) // all back in the packet
      expect(isGhostPending(id)).toBe(false)
    })
  })

  it('a New Game mid-way lets go of every card still held before the fresh board ever shows: none is drawn over it', async () => {
    const { state, undoStack, dealt } = afterDeal()
    await mount(state, undoStack)
    await press('undo')
    await flush(20) // no card has taken off yet: all three are still held in their columns
    expect(dealt.filter(heldOnBoard)).toEqual(dealt)

    watch(dealt)
    await press('new-game')
    recording = false
    // Every tableau card of the fresh deal is hidden until its deal ghost lands, so a dealt card of the old game drawn on the
    // board in any commit since is one still held over the fresh board.
    expect(commits.length).toBeGreaterThan(0)
    expect(commits.filter((c) => dealt.some((id) => c.held[id]))).toEqual([])
    dealt.forEach((id) => expect(isGhostPending(id)).toBe(false))
  })

  it('a hold the deal never gets (no ghost: the packet cannot be measured) is given back at once, not left to its 1s backstop', async () => {
    const { state, undoStack, dealt } = afterDeal()
    await mount(state, undoStack)
    const measure = jest.spyOn(mockGhost.cardRegistry, 'measure')
    measure.mockImplementation(async (id: string) => (id === 'scorpion-stock-packet' ? null : mockRegistered.has(id) ? { x: 10, y: 10, width: 50, height: 70 } : null))

    await press('undo')
    await flush(STEP_MS)
    dealt.forEach((id) => {
      expect(isGhostPending(id)).toBe(false)
      expect(onBoard(id)).toBe(false)
    })
  })
})
