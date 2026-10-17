import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'

import { GHOST_PAINT_MAX_MS, LANDED_GHOST_MAX_MS } from '@/components/cardFacePaint'
import { FLIGHT_SPRING, springSettleMs } from '@/components/dragdrop/dragSpring'
import { Card, Suit } from '@/engine/types'
import PyramidScreen from '@/games/pyramid/PyramidScreen'
import { PyramidState } from '@/games/pyramid/rules'

import { resetGameInProgress, seedGameInProgress } from '../../../testUtils/gameInProgressStore'

// ---------------------------------------------------------------------------------------------------------------------
// The REAL PyramidScreen's board cells and pair-flight ghosts (real rules, flight concurrency, undo stack, the memoized
// PyramidCell with its real useTakeOffHold and real DropZone, and the real pair-flight overlay), with the same kind of
// stand-ins as pyramidScreenQuickPlay.test.tsx for what needs native views. What it pins:
//   - a shake does not replay on a card a New Game dealt COVERED once a move uncovers it (card ids are reused by every deal,
//     and the cell's DraggableCard is kept from covered to exposed - see PyramidCell),
//   - a held cell (its card has just taken off, its ghost is not on screen yet) is not a touch target, while the card its
//     leaving uncovered is already playable,
//   - an unrelated screen render does not re-render a covered cell (PyramidCell is memoized, its callbacks stable),
//   - a landed pair card's ghost stays - shadowless - until the face it revealed on the discard has painted (the landed
//     hold), while everything the landing owes (the discard count, the claim) is settled at the landing itself.
// ---------------------------------------------------------------------------------------------------------------------

/** How long a pair-flight ghost flies: the very timer FlyingPairCard arms. */
const PAIR_FLIGHT_MS = springSettleMs(FLIGHT_SPRING)
const FLIGHT_MS = 80

// Every playShake() is one withSequence() call, so counting those counts the shakes actually played.
const mockWithSequence = jest.fn((...steps: unknown[]) => steps[steps.length - 1])
/** Board DraggableCard renders per card id - what the memoization test counts. */
const mockRenders = new Map<string, number>()
/** The next New Game's board (null: a real shuffled deal). */
let mockNextDeal: PyramidState | null = null
/** The ghosts' faces: deferred, they report painted only at useGhostPaintGate's backstop - the window in which a source holds its card. */
const mockPaint = { defer: false }
/** The discard's face Image: `slow`, a face it shows reports itself loading (cardFacePaint.ts's trackFaceLoad, as PlayingCard's does)
 * until the test delivers its bitmap. */
const mockFaces = {
  slow: false,
  loading: new Map<string, () => void>(),
  deliver(cardId: string) {
    mockFaces.loading.get(cardId)?.()
    mockFaces.loading.delete(cardId)
  }
}

function mockMakeFlight() {
  return {
    hide: () => {},
    originX: { value: 10 },
    originY: { value: 10 },
    dx: { value: 0 },
    dy: { value: 0 },
    flyTo: (_x: number, _y: number, onDone?: () => void) => {
      setTimeout(() => onDone?.(), FLIGHT_MS)
    }
  }
}
const mockGhost = { cardRegistry: { register: () => {}, unregister: () => {}, measure: async () => ({ x: 10, y: 10 }) }, show: () => mockMakeFlight() }
const mockDealer = {
  // The deal lands every card a beat after it starts.
  start: (entries: { cardId: string }[], _cardWidth: number, onCardLanded: (cardId: string) => void, onAllLanded?: () => void) => {
    setTimeout(() => {
      entries.forEach((e) => onCardLanded(e.cardId))
      onAllLanded?.()
    }, 0)
  },
  cancel: () => {}
}
const mockDropZones = { register: () => {}, unregister: () => {}, hitTest: async () => null }

jest.mock('@/redux/store', () => require('../../../testUtils/gameInProgressStore').storeModule)
jest.mock('react-native-reanimated', () => {
  const { useRef } = require('react')
  const base = jest.requireActual('../../../__mocks__/react-native-reanimated')
  return {
    ...base,
    withSequence: (...steps: unknown[]) => mockWithSequence(...steps),
    // Stable for a component's lifetime, like the real ones (the repo-wide mock hands back new ones every render).
    useSharedValue: (initial: unknown) => useRef({ value: initial }).current
  }
})
jest.mock('@/games/pyramid/rules', () => {
  const actual = jest.requireActual('@/games/pyramid/rules')
  return { ...actual, PyramidController: { ...actual.PyramidController, newGame: (seed: number) => mockNextDeal ?? actual.PyramidController.newGame(seed) } }
})
jest.mock('@/components/dragdrop/DragGhostLayer', () => ({ DragGhostProvider: ({ children }: { children: unknown }) => children, useDragGhost: () => mockGhost }))
jest.mock('@/components/dragdrop/DropZoneRegistry', () => ({ useDropZoneRegistry: () => mockDropZones }))
jest.mock('@/components/dealing/DealLayer', () => ({ DealProvider: ({ children }: { children: unknown }) => children, useDealAnimator: () => mockDealer }))
jest.mock('@/components/winning/WinCascadeLayer', () => ({ WinCascadeProvider: ({ children }: { children: unknown }) => children, WinCascadeGhosts: () => null, useWinCascade: () => ({ startChains: () => {}, clear: () => {} }) }))
jest.mock('@/components/dealing/measureView', () => ({ measureView: async (view: unknown) => (view ? { x: 5, y: 5 } : null) }))
jest.mock('@/components/useCardSounds', () => ({ useCardSoundEffects: () => ({ playCardSound: () => {}, playInvalidSound: () => {}, hapticCard: () => {}, hapticInvalid: () => {} }) }))
jest.mock('@rific/feedback-press', () => ({ useVibration: () => ({ short: () => {}, selection: () => {} }) }))
jest.mock('@rific/toaster', () => ({ useToast: () => ({ info: () => {} }) }))
jest.mock('@/components/winning/PipFireworks', () => ({ PipFireworks: () => null }))
jest.mock('@/games/shared/WinBanner', () => ({ WinBanner: () => null }))
jest.mock('@/stores/gameStats', () => ({ useGameStats: () => ({ recordDealWon: () => {}, recordDealAbandoned: () => {}, recordHintUsed: () => {} }) }))
jest.mock('@/stores/lastActiveGame', () => ({ useLastActiveGame: () => ({ setLastActiveGame: () => {}, clearLastActiveGame: () => {} }) }))
jest.mock('@/components/theme', () => {
  const actual = jest.requireActual('@/components/theme')
  return { ...actual, useTableColors: () => actual.lightColors }
})
// Only the pair ghosts draw a PlayingCard here (the board's cards are the DraggableCard stand-in below): `ghost-<id>`, telling a
// landed ghost (its shadowless style) from a flying one.
jest.mock('@/components/PlayingCard', () => {
  const { View: MockView } = require('react-native')
  const { useEffect: useMockEffect } = require('react')
  function MockPlayingCard({ card, style, onFacePainted }: { card: { id: string }; style?: object; onFacePainted?: () => void }) {
    useMockEffect(() => {
      if (!mockPaint.defer) onFacePainted?.()
    }, [onFacePainted])
    return <MockView testID={`ghost-${card.id}`} accessibilityHint={style ? 'landed' : 'flying'} />
  }
  return { PlayingCard: MockPlayingCard, EmptySlot: () => <MockView /> }
})
// A board card: the REAL shake hook (so a replayed token really plays), a render counter, and whether it is playable.
jest.mock('@/components/dragdrop/DraggableCard', () => {
  const { Pressable: MockPressable } = require('react-native')
  const { useShakeStyle } = require('@/components/shakeAnimation')
  return {
    DraggableCard: ({ card, disabled, shakeToken, onPress }: { card: { id: string }; disabled?: boolean; shakeToken?: number; onPress?: (measure: () => Promise<{ x: number; y: number }>) => void }) => {
      mockRenders.set(card.id, (mockRenders.get(card.id) ?? 0) + 1)
      useShakeStyle(shakeToken, card.id)
      return <MockPressable testID={`pyramid-${card.id}`} accessibilityLabel={disabled ? 'disabled' : 'playable'} onPress={() => onPress?.(async () => ({ x: 10, y: 10 }))} />
    }
  }
})
jest.mock('@/components/StockWaste', () => {
  const { Text: MockText, View: MockView } = require('react-native')
  return {
    StockWaste: ({ stockTopCard, wasteTop, onDrawStock, stockRef, wasteRef }: { stockTopCard?: { id: string }; wasteTop?: { id: string }; onDrawStock: () => void; stockRef: { current: unknown }; wasteRef: { current: unknown } }) => (
      <MockView>
        <MockView ref={stockRef} collapsable={false} />
        <MockView ref={wasteRef} collapsable={false} />
        <MockText testID='stock-top' onPress={onDrawStock}>
          {stockTopCard ? stockTopCard.id : 'empty'}
        </MockText>
        <MockText testID='waste-top'>{wasteTop ? wasteTop.id : 'empty'}</MockText>
      </MockView>
    )
  }
})
// Paints what the real DiscardCell does (the real top, or what sits under cards still flying to it), and - like its face Image - reports
// each face it starts showing as loading while mockFaces.slow, until the test delivers it (and as done once it shows another).
jest.mock('@/games/shared/DiscardCell', () => {
  const { Text: MockText, View: MockView } = require('react-native')
  const { useLayoutEffect: useMockLayoutEffect } = require('react')
  const { useFrozenWhileHidden } = jest.requireActual('@/components/useFrozenWhileHidden')
  const { trackFaceLoad } = require('@/components/cardFacePaint')
  return {
    DiscardCell: ({ card, isFlyingHere, settledCard, viewRef }: { card?: { id: string }; isFlyingHere: boolean; settledCard?: { id: string } | null; viewRef: { current: unknown } }) => {
      const frozenCopy = useFrozenWhileHidden(card, isFlyingHere)
      const under = settledCard === undefined ? frozenCopy : settledCard
      const painted = isFlyingHere ? under : card
      const paintedId = painted?.id
      useMockLayoutEffect(() => {
        if (!paintedId || !mockFaces.slow) return
        const done = trackFaceLoad(paintedId)
        mockFaces.loading.set(paintedId, done)
        return done
      }, [paintedId])
      return (
        <MockView ref={viewRef} collapsable={false}>
          <MockText testID='discard-painted'>{paintedId ?? 'empty'}</MockText>
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

// Flat indices: 15 is row 5's first card, covered by 21 and 22 (row 6, the always-exposed bottom row).
const COVERED = 15
const [LEFT, RIGHT] = [21, 22]

function board(cells: [number, Card][], opts: { stock?: Card[]; discard?: Card[] } = {}): PyramidState {
  const pyramid: (Card | null)[] = Array.from({ length: 28 }, () => null)
  cells.forEach(([index, c]) => (pyramid[index] = c))
  const discard = opts.discard ?? []
  return { pyramid, stock: opts.stock ?? [], waste: [], discard, removedCount: discard.length }
}

const FIVE = card('clubs', 5)
const THREE = card('clubs', 3) // 5 + 3 is no pair: tapping the 5 with the 3 selected shakes the 5
const TWO = card('diamonds', 2) // pairs with nothing used here: keeps the triangle from emptying (no win)
const SIX = card('hearts', 6)
const SEVEN = card('spades', 7) // 6 + 7 = 13: a pair
const Q = card('clubs', 12)
const ACE = card('hearts', 1) // Q + A = 13: a pair
const EIGHT = card('spades', 8)

// ------------------------------------------------------------------------------------------------ harness

const STEP_MS = 10

/** Advances fake time in small steps, each inside its OWN act() (see pyramidScreenQuickPlay.test.tsx). */
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

async function press(testID: string) {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID))
  })
}
const text = (testID: string) => screen.getByTestId(testID).props.children as string
const ghost = (c: Card) => screen.queryByTestId(`ghost-${c.id}`)
const onBoard = (c: Card) => screen.queryByTestId(`pyramid-${c.id}`) !== null
const playable = (c: Card) => screen.getByTestId(`pyramid-${c.id}`).props.accessibilityLabel === 'playable'
const renders = (c: Card) => mockRenders.get(c.id) ?? 0
/** The cell's own positioned box (the DropZone's View) around a board card. */
function cellStyle(c: Card): { position?: string; pointerEvents?: string } {
  let node = screen.getByTestId(`pyramid-${c.id}`).parent
  const flat = (n: typeof node) => (StyleSheet.flatten(n?.props.style) ?? {}) as { position?: string; pointerEvents?: string }
  while (node && flat(node).position !== 'absolute') node = node.parent
  return flat(node)
}

beforeEach(() => {
  jest.useFakeTimers()
  mockWithSequence.mockClear()
  mockRenders.clear()
  mockNextDeal = null
  mockPaint.defer = false
  mockFaces.slow = false
})
afterEach(async () => {
  await act(async () => {
    await jest.runOnlyPendingTimersAsync()
  })
  // The face registry is module-level: nothing a test left loading may hold a ghost in the next one.
  ;[...mockFaces.loading.keys()].forEach((id) => mockFaces.deliver(id))
  jest.useRealTimers()
  jest.restoreAllMocks()
})

// ------------------------------------------------------------------------------------------------ tests

// Each test starts with no saved games (the store helper is shared across the file).
afterEach(() => resetGameInProgress())

describe('Pyramid cells - a shake is never replayed on a card the next deal put under others', () => {
  it('the card shaken last, dealt COVERED by a New Game, does not shake when a pair uncovers it - and still shakes when tapped stuck', async () => {
    await mount(
      board([
        [LEFT, FIVE],
        [RIGHT, THREE]
      ])
    )
    await press(`pyramid-${THREE.id}`) // select the 3
    await press(`pyramid-${FIVE.id}`) // 3 + 5 is no pair: the 5 shakes
    expect(mockWithSequence).toHaveBeenCalledTimes(1)

    // The next deal puts the 5 in row 5, under a 6 and a 7 (card ids are reused by every deal).
    mockNextDeal = board([
      [COVERED, FIVE],
      [LEFT, SIX],
      [RIGHT, SEVEN],
      [27, TWO]
    ])
    await press('new-game')
    await flush(50) // dealt and landed
    expect(playable(FIVE)).toBe(false)

    await press(`pyramid-${SIX.id}`)
    await press(`pyramid-${SEVEN.id}`) // the pair goes, uncovering the 5
    await flush(PAIR_FLIGHT_MS + GHOST_PAINT_MAX_MS + 50)
    expect(onBoard(SIX) || onBoard(SEVEN)).toBe(false)
    expect(playable(FIVE)).toBe(true)
    expect(mockWithSequence).toHaveBeenCalledTimes(1) // uncovered without a wiggle

    await press(`pyramid-${TWO.id}`) // select the 2
    await press(`pyramid-${FIVE.id}`) // 2 + 5 is no pair: a NEW shake still plays
    expect(mockWithSequence).toHaveBeenCalledTimes(2)
  })
})

describe('Pyramid cells - a held cell is not a touch target', () => {
  it('a removed card still drawn while its ghost is not on screen passes touches through to the card it uncovered, which is already playable', async () => {
    await mount(
      board([
        [COVERED, EIGHT],
        [LEFT, Q],
        [RIGHT, ACE],
        [27, TWO]
      ])
    )
    expect(cellStyle(Q).pointerEvents).toBeUndefined() // a live cell takes touches as usual

    mockPaint.defer = true // the pair's ghosts are not painted yet: their sources keep drawing the cards
    await press(`pyramid-${Q.id}`)
    await press(`pyramid-${ACE.id}`)
    await flush(10)
    expect(onBoard(Q) && onBoard(ACE)).toBe(true) // held: still drawn, by the same cells
    expect(playable(Q) || playable(ACE)).toBe(false)
    expect(cellStyle(Q).pointerEvents).toBe('none')
    expect(cellStyle(ACE).pointerEvents).toBe('none')
    expect(playable(EIGHT)).toBe(true) // the card they uncovered is live in the same moment...
    expect(cellStyle(EIGHT).pointerEvents).toBeUndefined() // ...and takes its touches

    await flush(GHOST_PAINT_MAX_MS + 20) // the ghosts show: the hold ends
    expect(onBoard(Q) || onBoard(ACE)).toBe(false)
  })
})

describe('Pyramid cells - an unrelated screen render does not re-render a covered cell', () => {
  it('a selection, a deselection and a whole stock draw re-render the cells that changed, never the covered one', async () => {
    await mount(
      board(
        [
          [COVERED, EIGHT],
          [LEFT, Q],
          [RIGHT, THREE],
          [27, TWO]
        ],
        { stock: [card('clubs', 9, false)] }
      )
    )
    const coveredBefore = renders(EIGHT)
    const selectedBefore = renders(Q)
    expect(coveredBefore).toBeGreaterThan(0)

    await press(`pyramid-${Q.id}`) // select
    await press(`pyramid-${Q.id}`) // deselect
    await press('stock-top') // draw: a claim, the commit, the flight, its landing - several screen renders
    await flush(FLIGHT_MS + 50)
    expect(text('waste-top')).toBe(card('clubs', 9).id)

    expect(renders(Q)).toBeGreaterThan(selectedBefore) // the counter works: the selected cell did re-render
    expect(renders(EIGHT)).toBe(coveredBefore)
  })
})

describe('Pyramid pair flights - a landed card keeps its ghost until the card it revealed has painted', () => {
  const TWO_PAIRS = () =>
    board(
      [
        [LEFT, Q],
        [RIGHT, ACE],
        [23, SEVEN],
        [24, SIX],
        [27, TWO]
      ],
      { discard: [card('spades', 9), card('spades', 4)] }
    )

  async function landPair() {
    mockFaces.slow = true
    await press(`pyramid-${Q.id}`)
    await press(`pyramid-${ACE.id}`)
    await flush(10)
    expect(ghost(Q)?.props.accessibilityHint).toBe('flying')
    expect(ghost(ACE)?.props.accessibilityHint).toBe('flying')
    await flush(PAIR_FLIGHT_MS + 10) // both land
  }

  it('the top card of the pile waits, shadowless, for its face on the discard; everything the landing owes is settled at once', async () => {
    await mount(TWO_PAIRS())
    await landPair()

    // Settled at the landing: the pile counts both cards, nothing is in the air, the claim is released (undo works), the move counted.
    expect(text('discard-flying')).toBe('false')
    expect(text('discard-painted')).toBe(ACE.id)
    expect(text('undo-disabled')).toBe('false')
    expect(text('moves')).toBe('1')
    // ...but the Ace's face on the discard has not painted: its ghost stays over it, landed (no shadow of its own)...
    expect(ghost(ACE)?.props.accessibilityHint).toBe('landed')
    // ...while the Queen, under it with nothing of hers still loading, has gone at once.
    expect(ghost(Q)).toBeNull()

    await act(async () => mockFaces.deliver(ACE.id))
    await flush()
    expect(ghost(ACE)).toBeNull()
  })

  it('with another pair still flying to the discard, the overlay re-sourced to the card that landed holds its ghost the same way', async () => {
    await mount(TWO_PAIRS())
    mockFaces.slow = true
    await press(`pyramid-${Q.id}`)
    await press(`pyramid-${ACE.id}`)
    await flush(60)
    await press(`pyramid-${SEVEN.id}`)
    await press(`pyramid-${SIX.id}`)
    await flush(PAIR_FLIGHT_MS - 50) // the first pair has landed, the second is still in the air

    expect(text('discard-flying')).toBe('true')
    expect(text('discard-painted')).toBe(ACE.id) // what the overlay shows under the second pair's ghosts
    expect(ghost(ACE)?.props.accessibilityHint).toBe('landed')
    expect(ghost(SEVEN)?.props.accessibilityHint).toBe('flying')

    await act(async () => mockFaces.deliver(ACE.id))
    await flush()
    expect(ghost(ACE)).toBeNull()
    expect(ghost(SEVEN)).not.toBeNull()
  })

  it('a face that never reports does not keep the ghost up for good', async () => {
    await mount(TWO_PAIRS())
    await landPair()
    expect(ghost(ACE)).not.toBeNull()
    await flush(LANDED_GHOST_MAX_MS - 40)
    expect(ghost(ACE)).not.toBeNull()
    await flush(60)
    expect(ghost(ACE)).toBeNull()
  })

  it('a New Game drops a landed ghost that is still waiting, at once', async () => {
    await mount(TWO_PAIRS())
    await landPair()
    expect(ghost(ACE)).not.toBeNull()
    await press('new-game')
    expect(ghost(ACE)).toBeNull()
    expect(ghost(Q)).toBeNull()
  })
})
