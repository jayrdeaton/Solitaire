import { act, fireEvent, render, screen, within } from '@testing-library/react-native'

import { AUTO_PLAY_STAGGER_MS, finishGapMs } from '@/components/dragdrop/dragSpring'
import { DropZoneRegistry } from '@/components/dragdrop/DropZoneRegistry'
import { PileRef } from '@/engine/gameTypes'
import { Card, Suit } from '@/engine/types'
import FortyThievesScreen from '@/games/fortythieves/FortyThievesScreen'
import * as fortyThievesRules from '@/games/fortythieves/rules'
import { FortyThievesState } from '@/games/fortythieves/rules'

import { resetGameInProgress, seedGameInProgress } from '../../../testUtils/gameInProgressStore'
import { peelableFlights } from '../../../testUtils/peelableFlights'

// ---------------------------------------------------------------------------------------------------------------------
// A screen-level test for Forty Thieves' win and its no-teleport flights: the REAL FortyThievesScreen, real rules, real
// useFlightConcurrency / useWinReveal / useFoundationWinCheck / useGameSession / gameInProgress store, seeded with a saved
// game through the test store (src/testUtils/gameInProgressStore.ts). Only what needs native views, gestures or animation is replaced (same approach as
// freeCellScreenAutoPlay.test.tsx):
//   - PileView / StockWaste / FoundationCell: stand-ins that REGISTER what they render in a
//     fake CardRegistry - a tableau/waste card while it is shown, a foundation's TOP card only while the cell is
//     given it. That is what makes a flight's landing spot measurable in the real app, and what a hidden (won) foundation
//     loses. The stock/waste/foundation stand-ins also hand their slot container to stockRef/wasteRef/slotRef.
//   - useDragGhost: a fake ghost whose measure() answers only for registered cards and whose flights "land" FLIGHT_MS
//     later (the Reanimated mock's withSpring never calls its completion callback).
//   - useDealAnimator: lands every entry after a beat.
// What is observable: the ids each stand-in renders, every flight started (ghost.show) and when, each flyTo / hide.
// ---------------------------------------------------------------------------------------------------------------------

const FLIGHT_MS = 80
const HOLD_MS = 400 // useWinReveal's WIN_REVEAL_HOLD_MS

const mockRecordWon = jest.fn()
/** Settings' Auto-Move to Foundation - off unless a test is about the auto-play. */
const mockSettings = { autoMove: false }
/** How long a flight stays in the air - a test can stretch it past the celebration's own hold. */
let mockFlightMs = FLIGHT_MS
let mockPileInstance = 0
let mockFoundationInstance = 0
/** Card ids currently rendered by a stand-in - what the fake CardRegistry can measure. */
const mockRegistered = new Set<string>()
/** Ids the registry pretends it cannot find even though they are rendered. */
const mockUnmeasurable = new Set<string>()
/** What a slot-container measurement (measureView) answers for a real, non-null view. */
const SLOT = { x: 5, y: 5 }
const mockSlotView = {}
/** Foundation cells (by position) that do not hand their slot container over - measureView finds nothing for that pile. */
const mockNoSlot = new Set<number>()
/** Each tableau column's cards and drag config, as last rendered (by position) - what a test drives a drag through. */
const mockPiles = new Map<number, { cards: Card[]; drag: { onDrop: (to: PileRef, count: number, anchorCardId: string, flight: unknown) => Promise<boolean> | boolean } }>()
/** The waste's drop handler, as last rendered - what a test drives a drag of the waste card through. */
let mockWasteDrop: ((x: number, y: number, flight: unknown, dragged: Card) => Promise<boolean> | boolean) | undefined
/** Whether each foundation cell (by position) is drawing its real top card as of the last COMMIT (set from a layout effect). */
const mockPilesShown = new Map<number, boolean>()

interface MockFlightLog {
  /** Every ghost.show() - one per card flight the screen started (tap, drop, draw, undo). */
  shown: string[]
  /** When each of those took off (fake time), in the same order. */
  shownAt: number[]
  /** flyTo() calls still waiting to land. */
  inAir: number
  /** Ghosts the screen gave up on (a flight that could not be measured simply vanishes - the card appears at its destination). */
  hidden: number
  flown: number
  /** How many flights were still in the air the moment the win cascade started (-1: it never did). */
  airAtWinCascade: number
  /** How many chains the win cascade was started with (-1: it never was). */
  cascadeChains: number
  /** How many foundation piles were still drawing their real cards the moment the win cascade started (-1: it never did). */
  pilesShownAtCascade: number
}
const mockLog: MockFlightLog = { shown: [], shownAt: [], inAir: 0, hidden: 0, flown: 0, airAtWinCascade: -1, cascadeChains: -1, pilesShownAtCascade: -1 }
/** One entry per React COMMIT that re-rendered the win cascade's ghost layer: whether ghosts were mounted, whether they were on
 * screen (mounted ghosts stay invisible until their faces have painted), and how many foundation piles were drawn bare (their real
 * cards blanked) in that same commit. */
const mockCommits: { mounted: boolean; ghosts: boolean; bare: number }[] = []
/** How long the mocked cascade takes to show after startChains - the real one waits for its parked ghosts' faces to paint. */
const MOCK_GHOSTS_SHOW_MS = 16
const mockBarePiles = () => [...mockPilesShown.values()].filter((shown) => !shown).length

function mockMakeFlight() {
  return {
    hide: () => void (mockLog.hidden += 1),
    flyTo: (_x: number, _y: number, onDone?: () => void) => {
      mockLog.flown += 1
      mockLog.inAir += 1
      setTimeout(() => {
        mockLog.inAir -= 1
        onDone?.()
      }, mockFlightMs)
    }
  }
}
/** An undo turning cards back mid-air (ghost.peel): the cards each flight still carries, and every peel. */
const mockPeel = peelableFlights(() => mockMakeFlight())
const mockGhost = {
  cardRegistry: { register: () => {}, unregister: () => {}, measure: async (id: string) => (mockRegistered.has(id) && !mockUnmeasurable.has(id) ? { x: 10, y: 10 } : null) },
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
// Like the real layer, starting chains is a React STATE update on a provider above the screen and the ghosts are mounted by
// that state - but they are not on screen yet: the real cascade stays invisible until its parked ghosts' faces have painted (a
// frame or two; MOCK_GHOSTS_SHOW_MS here), and calls startChains' onShown in the commit it shows (a layout effect), never for an
// empty cascade, never once a clear() or a newer startChains replaced it. A layout effect on the ghost layer records, per
// commit, whether ghosts are mounted, whether they are on screen, and how many piles are drawn bare in that very commit.
jest.mock('@/components/winning/WinCascadeLayer', () => {
  const { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState } = require('react')
  const { StyleSheet: MockStyleSheet, View: MockView } = require('react-native')
  const CascadeContext = createContext(null)
  const mockStyles = MockStyleSheet.create({ unpainted: { opacity: 0 } })
  type MockCascade = { shown: boolean; onShown?: () => void } | null
  return {
    WinCascadeProvider: ({ children }: { children: unknown }) => {
      const [cascade, setCascade] = useState(null as MockCascade)
      const controller = useMemo(
        () => ({
          startChains: (chains: unknown[], _cardWidth: number, onShown?: () => void) => {
            mockLog.airAtWinCascade = mockLog.inAir
            mockLog.cascadeChains = chains.length
            mockLog.pilesShownAtCascade = [...mockPilesShown.values()].filter((shown) => shown).length
            setCascade(chains.length > 0 ? { shown: false, onShown } : null)
          },
          clear: () => setCascade(null)
        }),
        []
      )
      // The parked faces paint, and the cascade shows (a replaced or cleared cascade's timer goes with it).
      useEffect(() => {
        if (!cascade || cascade.shown) return
        const timer = setTimeout(() => setCascade({ ...cascade, shown: true }), MOCK_GHOSTS_SHOW_MS)
        return () => clearTimeout(timer)
      }, [cascade])
      const value = useMemo(() => ({ controller, cascade }), [controller, cascade])
      return <CascadeContext.Provider value={value}>{children}</CascadeContext.Provider>
    },
    WinCascadeGhosts: () => {
      const { cascade } = useContext(CascadeContext) as { cascade: MockCascade }
      const shown = !!cascade?.shown
      useLayoutEffect(() => {
        mockCommits.push({ mounted: !!cascade, ghosts: shown, bare: mockBarePiles() })
      })
      // In the commit the ghosts show, like the real layer.
      useLayoutEffect(() => {
        if (shown) cascade?.onShown?.()
      }, [shown, cascade])
      return cascade ? <MockView testID='cascade-ghosts' style={shown ? undefined : mockStyles.unpainted} /> : null
    },
    useWinCascade: () => useContext(CascadeContext).controller
  }
})
/** How long a slot-container measurement takes to come back (a real one is a native round trip) - 0 resolves at once. */
let mockMeasureViewMs = 0
jest.mock('@/components/dealing/measureView', () => ({
  measureView: async (view: unknown) => {
    if (mockMeasureViewMs > 0) await new Promise((resolve) => setTimeout(resolve, mockMeasureViewMs))
    return view ? SLOT : null
  }
}))
jest.mock('@/components/useCardSounds', () => ({ useCardSoundEffects: () => ({ playCardSound: () => {}, playInvalidSound: () => {}, hapticCard: () => {}, hapticInvalid: () => {} }) }))
jest.mock('@rific/feedback-press', () => ({ useVibration: () => ({ short: () => {}, selection: () => {} }) }))
jest.mock('@rific/toaster', () => ({ useToast: () => ({ info: () => {} }) }))
jest.mock('@tastic/sprites/fireworks', () => {
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
// Like the real cell: only the top card it is GIVEN is registered, the slot container is always handed to slotRef. It also
// reports what the real cell paints UNDER the incoming ghost(s) while a flight is in the air (the caller's settledCard, or
// the frozen copy of what was on top before the flight began when it gives none) - 'none' when nothing is flying here.
jest.mock('@/games/shared/FoundationCell', () => {
  const { Text: MockText, View: MockView } = require('react-native')
  const { useEffect, useLayoutEffect, useRef } = require('react')
  const { useFrozenWhileHidden } = jest.requireActual('@/components/useFrozenWhileHidden')
  return {
    FoundationCell: ({ card, isFlyingHere, settledCard, slotRef }: { card?: { id: string }; isFlyingHere: boolean; settledCard?: { id: string } | null; slotRef?: (el: unknown) => void }) => {
      // Eight piles share four suits here, so a cell is identified by its position (the first render mounts them in order).
      const index = useRef(mockFoundationInstance++).current
      useLayoutEffect(() => {
        mockPilesShown.set(index, card !== undefined)
      })
      useEffect(() => {
        if (!mockNoSlot.has(index)) slotRef?.(mockSlotView)
        return () => slotRef?.(null)
      }, [slotRef, index])
      useEffect(() => {
        if (!card) return
        const id = card.id
        mockRegistered.add(id)
        return () => void mockRegistered.delete(id)
      }, [card])
      const frozenCopy = useFrozenWhileHidden(card, isFlyingHere)
      const underGhost = settledCard === undefined ? frozenCopy : settledCard
      return (
        <MockView>
          <MockText testID={`foundation-${index}`}>{card ? card.id : 'empty'}</MockText>
          <MockText testID={`under-ghost-${index}`}>{isFlyingHere ? (underGhost ? underGhost.id : 'empty') : 'none'}</MockText>
        </MockView>
      )
    }
  }
})
jest.mock('@/components/StockWaste', () => {
  const { Pressable: MockPressable, View: MockView } = require('react-native')
  const { useEffect } = require('react')
  return {
    StockWaste: ({ wasteTop, stockTopCard, onDrawStock, onWastePress, onWasteDrop, stockRef, wasteRef }: { wasteTop?: { id: string }; stockTopCard?: { id: string }; onDrawStock: () => void; onWastePress: (measure: () => Promise<{ x: number; y: number }>) => void; onWasteDrop: typeof mockWasteDrop; stockRef?: { current: unknown }; wasteRef?: { current: unknown } }) => {
      mockWasteDrop = onWasteDrop
      useEffect(() => {
        if (stockRef) stockRef.current = mockSlotView
        if (wasteRef) wasteRef.current = mockSlotView
      }, [stockRef, wasteRef])
      const wasteId = wasteTop?.id
      useEffect(() => {
        if (!wasteId) return
        mockRegistered.add(wasteId)
        return () => void mockRegistered.delete(wasteId)
      }, [wasteId])
      return (
        <MockView>
          {stockTopCard ? <MockPressable testID='stock-pile' onPress={onDrawStock} /> : null}
          {wasteTop ? <MockPressable testID={`waste-${wasteTop.id}`} onPress={() => onWastePress(async () => ({ x: 10, y: 10 }))} /> : null}
        </MockView>
      )
    }
  }
})
jest.mock('@/components/PileView', () => {
  const { Pressable: MockPressable, View: MockView } = require('react-native')
  const { useEffect, useRef } = require('react')
  return {
    PileView: (props: { cards: Card[]; onPressCard: (card: Card, indexFromTop: number, measure: () => Promise<{ x: number; y: number }>) => void; drag: never }) => {
      const id = useRef(mockPileInstance++).current
      mockPiles.set(id % 10, { cards: props.cards, drag: props.drag })
      const key = props.cards.map((c) => c.id).join(',')
      useEffect(() => {
        const ids = key === '' ? [] : key.split(',')
        ids.forEach((cardId) => mockRegistered.add(cardId))
        return () => ids.forEach((cardId) => mockRegistered.delete(cardId))
      }, [key])
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
  const { Pressable: MockPressable, Text: MockText, View: MockView } = require('react-native')
  return {
    GAME_CONTENT_PADDING: 6,
    GameChrome: ({ children, onUndo, onNewGame, movesCount }: { children: unknown; onUndo: () => void; onNewGame: () => void; movesCount: number }) => (
      <MockView>
        <MockText testID='moves'>{String(movesCount)}</MockText>
        <MockPressable testID='undo' onPress={onUndo} />
        <MockPressable testID='new-game' onPress={onNewGame} />
        {children}
      </MockView>
    )
  }
})

// ------------------------------------------------------------------------------------------------ boards

const card = (suit: Suit, rank: number, deck = 0): Card => ({ id: `${suit}-${rank}-${deck}`, suit, rank, faceUp: true }) as Card
const id = (suit: Suit, rank: number, deck = 0) => `${suit}-${rank}-${deck}`
/** A foundation pile built Ace-first up to `high`. */
const pile = (suit: Suit, high: number, deck = 0): Card[] => Array.from({ length: high }, (_, i) => card(suit, i + 1, deck))
function board(parts: { tableau?: Card[][]; foundation: Card[][]; stock?: Card[]; waste?: Card[] }): FortyThievesState {
  return { tableau: Array.from({ length: 10 }, (_, i) => parts.tableau?.[i] ?? []), foundation: parts.foundation, stock: parts.stock ?? [], waste: parts.waste ?? [] }
}
/** Eight piles: the first deck's four suits (pile 0-3, all full) and the second deck's (pile 4-7) - clubs one short. */
const FOUNDATIONS_ALMOST_FULL = (): Card[][] => [pile('clubs', 13), pile('diamonds', 13), pile('hearts', 13), pile('spades', 13), pile('clubs', 12, 1), pile('diamonds', 13, 1), pile('hearts', 13, 1), pile('spades', 13, 1)]
const LAST_KING = () => card('clubs', 13, 1)
/** Every card is home except the second King of clubs, alone on the waste: tapping it wins the game. */
const ONE_CARD_FROM_WON = () => board({ waste: [LAST_KING()], foundation: FOUNDATIONS_ALMOST_FULL() })
const LAST_KING_ID = id('clubs', 13, 1)
/** The foundation cell of the second deck's clubs. */
const CLUBS_CELL = 'foundation-4'

// ------------------------------------------------------------------------------------------------ harness

const STEP_MS = 10

/** Advances fake time by `ms`, in small steps each inside its OWN act(): React only processes the renders and effects a
 * step's timers queued when its act scope exits, and the landing/cascade chains are "land -> render -> effect -> next". */
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

async function mount(state: FortyThievesState, undoStack: unknown[] = [], expectedCards = 1) {
  seedGameInProgress('fortythieves', { state, undoStack, moves: 0, elapsedSeconds: 0, config: 0 })
  await render(<FortyThievesScreen />)
  await flush() // loadGameInProgress -> restoreGame
  expect(screen.queryAllByTestId(/^card-|^waste-|^stock-/).length).toBe(expectedCards)
}

const foundationTop = (cell: string) => screen.getByTestId(cell).props.children as string
/** What the foundation pile at `index` shows under its incoming ghost(s): a card id, 'empty' (the bare slot), or 'none' (nothing is flying there). */
const underGhost = (index: number) => screen.getByTestId(`under-ghost-${index}`).props.children as string

async function press(testID: string) {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID))
  })
}

beforeEach(() => {
  jest.useFakeTimers()
  mockPeel.reset()
  mockPileInstance = 0
  mockFoundationInstance = 0
  mockRegistered.clear()
  mockUnmeasurable.clear()
  mockLog.shown = []
  mockLog.shownAt = []
  mockLog.inAir = 0
  mockLog.hidden = 0
  mockLog.flown = 0
  mockLog.airAtWinCascade = -1
  mockLog.cascadeChains = -1
  mockLog.pilesShownAtCascade = -1
  mockCommits.length = 0
  mockPilesShown.clear()
  mockNoSlot.clear()
  mockPiles.clear()
  mockWasteDrop = undefined
  mockRecordWon.mockClear()
  mockFlightMs = FLIGHT_MS
  mockMeasureViewMs = 0
  mockSettings.autoMove = false
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

describe('Forty Thieves screen - the win celebration waits for the winning card to fly in and land', () => {
  it('the winning card flies (not vanishes), and neither the foundations nor the banner change until it has landed and a beat has passed', async () => {
    await mount(ONE_CARD_FROM_WON())
    expect(foundationTop(CLUBS_CELL)).toBe(id('clubs', 12, 1))

    await press(`waste-${LAST_KING_ID}`)
    await flush(10) // the move has committed and its ghost is in the air

    expect(mockRecordWon).toHaveBeenCalledTimes(1) // the win is recorded the instant it happens...
    expect(mockLog.shown).toEqual([LAST_KING_ID])
    expect(mockLog.hidden).toBe(0) // ...the winning card was NOT given up on for want of a landing spot...
    expect(mockLog.inAir).toBe(1) // ...it really is flying...
    expect(foundationTop(CLUBS_CELL)).toBe(LAST_KING_ID) // ...to a foundation that is still showing the whole pile,
    expect(screen.queryByTestId('win-banner')).toBeNull() // with no celebration yet
    expect(screen.queryByTestId('fireworks')).toBeNull()
    expect(mockLog.airAtWinCascade).toBe(-1)

    await flush(FLIGHT_MS) // the flight lands
    expect(mockLog.inAir).toBe(0)
    expect(foundationTop(CLUBS_CELL)).toBe(LAST_KING_ID) // the completed board holds for a beat
    expect(screen.queryByTestId('win-banner')).toBeNull()

    await flush(HOLD_MS + 50)
    expect(screen.getByTestId('win-banner')).toBeTruthy() // then the celebration takes over
    expect(screen.getByTestId('fireworks')).toBeTruthy()
    expect(foundationTop(CLUBS_CELL)).toBe('empty')
    expect(mockLog.airAtWinCascade).toBe(0) // with nothing left in the air
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
  })

  it("a flight that takes longer than the celebration's own beat still gets to land first", async () => {
    mockFlightMs = 1500
    await mount(ONE_CARD_FROM_WON())

    await press(`waste-${LAST_KING_ID}`)
    await flush(1400) // well past HOLD_MS, the card is still in the air
    expect(mockLog.inAir).toBe(1)
    expect(foundationTop(CLUBS_CELL)).toBe(LAST_KING_ID)
    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(mockLog.airAtWinCascade).toBe(-1)

    await flush(100 + HOLD_MS + 50) // it lands, then the beat
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(mockLog.airAtWinCascade).toBe(0)
  })

  it('is not withheld by a flight that never lands', async () => {
    await mount(ONE_CARD_FROM_WON())
    jest.spyOn(mockGhost, 'show').mockImplementation(() => ({ hide: () => {}, flyTo: () => {} }) as never) // its flight never calls back

    await press(`waste-${LAST_KING_ID}`)
    await flush(3000)

    expect(screen.getByTestId('win-banner')).toBeTruthy()
  })

  it('undoing the winning move after the celebration has started flies the card back instead of reappearing', async () => {
    await mount(ONE_CARD_FROM_WON())
    await press(`waste-${LAST_KING_ID}`)
    await flush(FLIGHT_MS + HOLD_MS + 50)
    expect(foundationTop(CLUBS_CELL)).toBe('empty') // the real foundation cards are hidden: the King is no longer measurable there
    expect(mockLog.shown).toEqual([LAST_KING_ID])

    await press('undo')
    await flush(10)

    expect(mockLog.shown).toEqual([LAST_KING_ID, LAST_KING_ID]) // the undo's own ghost, from the pile's slot
    expect(mockLog.inAir).toBe(1)
    expect(mockLog.hidden).toBe(0)
    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(screen.queryByTestId('cascade-ghosts')).toBeNull() // the cascade is cleared,
    expect(foundationTop(CLUBS_CELL)).toBe(id('clubs', 12, 1)) // and the reverted board is drawn for real again (the pile is not left bare)
    await flush(FLIGHT_MS)
    expect(screen.queryByTestId(`waste-${LAST_KING_ID}`)).not.toBeNull() // home again
  })

  it('undoing during the beat before the celebration cancels it: the real foundation cards stay, no banner ever comes', async () => {
    await mount(ONE_CARD_FROM_WON())
    await press(`waste-${LAST_KING_ID}`)
    await flush(FLIGHT_MS + 100) // landed, the completed board is holding its beat

    await press('undo')
    await flush(HOLD_MS * 3)

    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(mockLog.airAtWinCascade).toBe(-1) // the win cascade never started
    expect(foundationTop(CLUBS_CELL)).toBe(id('clubs', 12, 1))
    expect(mockLog.hidden).toBe(0)
  })
})

describe('Forty Thieves screen - the win cascade takes over from the real foundation cards once its ghosts show', () => {
  const ALL_CELLS = [0, 1, 2, 3, 4, 5, 6, 7]

  it('the piles keep their real cards until the cascade is started and its ghosts are on screen, and blank in the commit right after they show', async () => {
    await mount(ONE_CARD_FROM_WON())

    await press(`waste-${LAST_KING_ID}`)
    await flush(FLIGHT_MS + HOLD_MS + 50)

    expect(mockLog.cascadeChains).toBe(8)
    expect(mockLog.pilesShownAtCascade).toBe(8) // every pile was still drawing its real cards when the chains started (the origins are measured off the slots, before anything blanks)
    expect(screen.getByTestId('cascade-ghosts')).toBeTruthy()
    ALL_CELLS.forEach((cell) => expect(foundationTop(`foundation-${cell}`)).toBe('empty')) // and the real cards are gone now that the ghosts stand in for them

    // No commit ever drew a pile bare without the cascade's ghosts ON SCREEN to stand in for it (that was ~140ms of empty piles,
    // then - blanking in the commit that mounted the ghosts - a frame or two of blank-faced ones)...
    expect(mockCommits.filter((commit) => commit.bare > 0 && !commit.ghosts)).toEqual([])
    // ...because the piles stayed up while the mounted ghosts were still invisible, and blanked in the commit right after the one
    // the ghosts appeared in (onShown), which still drew them all - the same pixels, twice.
    const firstMounted = mockCommits.findIndex((commit) => commit.mounted)
    const firstGhosts = mockCommits.findIndex((commit) => commit.ghosts)
    expect(firstMounted).toBeGreaterThan(0)
    expect(firstGhosts).toBeGreaterThan(firstMounted)
    expect(mockCommits.slice(firstMounted, firstGhosts).every((commit) => commit.bare === 0)).toBe(true)
    expect(mockCommits[firstGhosts].bare).toBe(0)
    expect(mockCommits[firstGhosts + 1].bare).toBe(8)
  })

  it('a pile whose slot cannot be measured keeps its real cards instead of blanking without a chain to replace them', async () => {
    mockNoSlot.add(2) // the first deck's hearts
    await mount(ONE_CARD_FROM_WON())

    await press(`waste-${LAST_KING_ID}`)
    await flush(FLIGHT_MS + HOLD_MS + 50)

    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(mockLog.cascadeChains).toBe(7) // the seven measurable piles get a chain...
    ALL_CELLS.filter((cell) => cell !== 2).forEach((cell) => expect(foundationTop(`foundation-${cell}`)).toBe('empty'))
    expect(foundationTop('foundation-2')).toBe(id('hearts', 13)) // ...the eighth stays up
  })

  it('leaves the finished piles up when no chain can start, instead of blanking them with nothing to show', async () => {
    ALL_CELLS.forEach((cell) => mockNoSlot.add(cell))
    await mount(ONE_CARD_FROM_WON())

    await press(`waste-${LAST_KING_ID}`)
    await flush(FLIGHT_MS + HOLD_MS + 50)

    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(mockLog.cascadeChains).toBe(0)
    expect(screen.queryByTestId('cascade-ghosts')).toBeNull()
    ALL_CELLS.forEach((cell) => expect(foundationTop(`foundation-${cell}`)).not.toBe('empty'))
  })
})

describe('Forty Thieves screen - a card never moves without its own flight', () => {
  it("a foundation landing whose card cannot be measured flies to the pile's slot instead of being hidden", async () => {
    await mount(ONE_CARD_FROM_WON())
    mockUnmeasurable.add(LAST_KING_ID) // e.g. a later flight to the same pile has already buried it

    await press(`waste-${LAST_KING_ID}`)
    await flush(10)

    expect(mockLog.flown).toBe(1)
    expect(mockLog.hidden).toBe(0)
  })

  it('a drawn card whose waste slot cannot be measured flies to the waste slot instead of being hidden', async () => {
    await mount(board({ tableau: [[card('clubs', 5)]], foundation: [[], [], [], [], [], [], [], []], stock: [card('diamonds', 7)] }), [], 2)
    mockUnmeasurable.add(id('diamonds', 7))

    await press('stock-pile')
    await flush(10)

    expect(mockLog.shown).toEqual([id('diamonds', 7)])
    expect(mockLog.flown).toBe(1)
    expect(mockLog.hidden).toBe(0)
  })

  it('undoing a foundation move whose card is buried under an auto-played card flies THAT card (not the one on top) from the pile', async () => {
    // The player sent the 3 of clubs up; the auto-play then put the 4 on top of it (a save from before auto-plays were their own undo steps).
    const foundationWith = (clubs: Card[]) => [clubs, [], [], [], [], [], [], []]
    const before = board({ tableau: [[card('clubs', 3)], [card('clubs', 4)]], foundation: foundationWith(pile('clubs', 2)) })
    const after = board({ foundation: foundationWith(pile('clubs', 4)) })
    const entry = { state: before, move: { from: { zone: 'tableau', index: 0 } as PileRef, to: { zone: 'foundation', index: 0 } as PileRef, count: 1, anchorCardId: id('clubs', 3) } }
    await mount(after, [entry], 0) // the 3 is buried: only a foundation's top card (the 4) is in the registry
    expect(mockRegistered.has(id('clubs', 3))).toBe(false)

    await press('undo')
    await flush(10)

    expect(mockLog.shown).toEqual([id('clubs', 3)]) // the 3 - not the 4 that happens to be on top
    expect(mockLog.flown).toBe(1)
    await flush(FLIGHT_MS * 2)
    expect(mockLog.hidden).toBe(0)
  })
})

describe('Forty Thieves screen - a foundation pile keeps showing the card that has landed while later flights are still in the air', () => {
  /** The Ace of clubs is up (pile 0), the 2 and the 3 each sit alone in a column (a diamond keeps the game unfinished). */
  const TWO_THEN_THREE = () => board({ tableau: [[card('clubs', 2)], [card('clubs', 3)], [card('diamonds', 5)]], foundation: [pile('clubs', 1), [], [], [], [], [], [], []] })

  it('two quick taps: once the first card lands, the pile shows it under the second ghost instead of reverting to the card from before both', async () => {
    await mount(TWO_THEN_THREE(), [], 3)
    expect(underGhost(0)).toBe('none') // nothing is flying there

    await press(`card-${id('clubs', 2)}`)
    await flush(10)
    expect(mockLog.inAir).toBe(1)
    expect(underGhost(0)).toBe(id('clubs', 1)) // one card in the air: the pile still shows the Ace it had

    await press(`card-${id('clubs', 3)}`) // a second flight sets off before the first has landed
    await flush(10)
    expect(mockLog.inAir).toBe(2)
    expect(foundationTop('foundation-0')).toBe(id('clubs', 3))
    expect(underGhost(0)).toBe(id('clubs', 1)) // both in the air: still the Ace

    await flushUntil(() => mockLog.inAir === 1) // the 2 lands, the 3 is still flying
    expect(underGhost(0)).toBe(id('clubs', 2)) // the pile now shows the 2 - not the Ace again

    await flushUntil(() => mockLog.inAir === 0)
    await flush(10)
    expect(underGhost(0)).toBe('none')
    expect(foundationTop('foundation-0')).toBe(id('clubs', 3))
  })
})

describe('Forty Thieves screen - every auto-played step is its own undo step', () => {
  // Every card is home except: the Jack of clubs (column 0, the player's tap), the Queen over the King of clubs (column 1),
  // and the Queen then King of diamonds in the stock (the King drawn first). Once the Jack is up the rest finishes itself
  // in five automatic steps: the Queen and King of clubs (plays), the King of diamonds (a plain draw - the Queen is not up
  // yet), the Queen of diamonds (a draw-and-play, straight from the stock), then the King of diamonds off the waste.
  const JACK_FINISHES_IT = () =>
    board({
      tableau: [[card('clubs', 11, 1)], [card('clubs', 13, 1), card('clubs', 12, 1)]],
      foundation: [pile('clubs', 13), pile('diamonds', 13), pile('hearts', 13), pile('spades', 13), pile('clubs', 10, 1), pile('diamonds', 11, 1), pile('hearts', 13, 1), pile('spades', 13, 1)],
      stock: [card('diamonds', 12, 1), card('diamonds', 13, 1)]
    })
  const CLUBS = 'foundation-4'
  const DIAMONDS = 'foundation-5'
  const moves = () => screen.getByTestId('moves').props.children as string
  const wasteIds = () => screen.queryAllByTestId(/^waste-/).map((el) => (el.props.testID as string).slice('waste-'.length))

  it('the tap and each automatic step after it are taken back one at a time, each with its own flight, newest first', async () => {
    mockSettings.autoMove = true
    await mount(JACK_FINISHES_IT(), [], 4)

    await press(`card-${id('clubs', 11, 1)}`)
    await flush(3000)
    expect(mockRecordWon).toHaveBeenCalledTimes(1) // it finished itself (the celebration has taken the piles over by now)
    expect(screen.queryAllByTestId(/^card-|^waste-|^stock-/)).toEqual([])
    expect(mockLog.shown).toHaveLength(6) // the tap, then the five automatic steps
    expect(moves()).toBe('7') // the tap and every automatic step after it

    const undo = async () => {
      const before = mockLog.shown.length
      await press('undo')
      await flush(1000)
      expect(mockLog.shown.length).toBe(before + 1) // exactly one card flies back, and nothing is auto-played again
      expect(mockLog.inAir).toBe(0)
    }

    await undo() // the King of diamonds, off the foundation back onto the waste
    expect(foundationTop(DIAMONDS)).toBe(id('diamonds', 12, 1))
    expect(wasteIds()).toEqual([id('diamonds', 13, 1)])
    await undo() // the draw-and-play's play: the Queen of diamonds back onto the waste, over the King
    expect(foundationTop(DIAMONDS)).toBe(id('diamonds', 11, 1))
    expect(wasteIds()).toEqual([id('diamonds', 12, 1)])
    await undo() // ...then its draw: the Queen back into the stock
    expect(wasteIds()).toEqual([id('diamonds', 13, 1)])
    await undo() // the plain draw of the King of diamonds
    expect(wasteIds()).toEqual([])
    await undo() // the King of clubs
    expect(foundationTop(CLUBS)).toBe(id('clubs', 12, 1))
    await undo() // the Queen of clubs
    expect(foundationTop(CLUBS)).toBe(id('clubs', 11, 1))
    await undo() // and only then the tap itself
    expect(foundationTop(CLUBS)).toBe(id('clubs', 10, 1))
    expect(screen.queryByTestId(`card-${id('clubs', 11, 1)}`)).not.toBeNull()

    expect(mockLog.shown.slice(-7)).toEqual([id('diamonds', 13, 1), id('diamonds', 12, 1), id('diamonds', 12, 1), id('diamonds', 13, 1), id('clubs', 13, 1), id('clubs', 12, 1), id('clubs', 11, 1)])
    expect(mockLog.hidden).toBe(0) // every one of them really flew
    expect(moves()).toBe('7') // undoing never takes a move back off the count
  })
})

describe("Forty Thieves screen - once the board is solved, the player's foundation play files the rest away, at a pace that ramps up", () => {
  // Every card is home but the second deck's clubs 8 to King and diamonds 10 to King: their piles (4 and 5) hold the Ace to the 7
  // and the Ace to the 9.
  const foundations = (): Card[][] => [pile('clubs', 13), pile('diamonds', 13), pile('hearts', 13), pile('spades', 13), pile('clubs', 7, 1), pile('diamonds', 9, 1), pile('hearts', 13, 1), pile('spades', 13, 1)]
  /** The second deck's `suit` from `high` down to `low`, the low card on top. */
  const run = (suit: Suit, high: number, low: number): Card[] => Array.from({ length: high - low + 1 }, (_, i) => card(suit, high - i, 1))
  const NINE = () => card('clubs', 9, 1)
  /** Solved: the clubs King to 9 in column 0, the 8 alone in column 1, the diamonds King to 10 in column 2. */
  const SOLVED = () => board({ tableau: [run('clubs', 13, 9), [card('clubs', 8, 1)], run('diamonds', 13, 10)], foundation: foundations() })
  /** One column move from SOLVED: the 9 sits on the 8. Tapped, it has no foundation to go to yet, so it goes onto the 10 in column 0. */
  const NINE_ON_EIGHT = () => board({ tableau: [run('clubs', 13, 10), [card('clubs', 8, 1), NINE()], run('diamonds', 13, 10)], foundation: foundations() })
  /** Already solved, with a column move left: the 9 alone in column 2 can also go onto the 10. */
  const NINE_APART = () => board({ tableau: [run('clubs', 13, 10), [card('clubs', 8, 1)], [NINE()], run('diamonds', 13, 10)], foundation: foundations() })
  /** The 9 is the last card on the waste: moved onto the 10, it leaves the board solved. */
  const NINE_ON_WASTE = () => board({ tableau: [run('clubs', 13, 10), [card('clubs', 8, 1)], run('diamonds', 13, 10)], foundation: foundations(), waste: [NINE()] })
  /** NINE_APART with the diamonds King still on the waste (`where: 'waste'`, every card could go up) or in the stock (drawing it
   * would finish the game): either way something is left there, so it is not solved. */
  const KING_LEFT_IN = (where: 'waste' | 'stock') => board({ tableau: [run('clubs', 13, 10), [card('clubs', 8, 1)], [NINE()], run('diamonds', 12, 10)], foundation: foundations(), [where]: [{ ...card('diamonds', 13, 1), faceUp: where === 'waste' }] })
  /** Every card is home but the second deck's clubs 9 to King (pile 4 holds the Ace to the 8): the King, Queen and Jack in column 0,
   * the 9 alone in column 1, and the 10 in the stock (face down) or on the waste. Not solved until the 10 is up. */
  const TEN_LEFT_IN = (where: 'stock' | 'waste') =>
    board({
      tableau: [run('clubs', 13, 11), [NINE()]],
      foundation: [pile('clubs', 13), pile('diamonds', 13), pile('hearts', 13), pile('spades', 13), pile('clubs', 8, 1), pile('diamonds', 13, 1), pile('hearts', 13, 1), pile('spades', 13, 1)],
      [where]: [{ ...card('clubs', 10, 1), faceUp: where === 'waste' }]
    })
  /** The order the finish sends a solved board's cards up in: the 8 first (the 9 waits on it), then the rest of the clubs, then the diamonds. */
  const FINISH_ORDER = [8, 9, 10, 11, 12, 13].map((rank) => id('clubs', rank, 1)).concat([10, 11, 12, 13].map((rank) => id('diamonds', rank, 1)))
  const COLUMN_0: PileRef = { zone: 'tableau', index: 0 }
  const moves = () => screen.getByTestId('moves').props.children as string
  const cardsOnBoard = () => screen.queryAllByTestId(/^card-|^waste-|^stock-/).length

  /** What PileView does when a drag of `cardId` (and everything on it) ends over `to`. */
  async function dragTo(cardId: string, to: PileRef) {
    const column = [...mockPiles.values()].find((p) => p.cards.some((c) => c.id === cardId))!
    const count = column.cards.length - column.cards.findIndex((c) => c.id === cardId)
    await act(async () => {
      await column.drag.onDrop(to, count, cardId, mockMakeFlight()) // the drag's own ghost comes from PileView: it isn't in mockLog.shown
    })
  }

  /** What StockWaste does when a drag of the waste's top card ends over `to` (the hit test's answer). */
  async function dragWasteTo(dragged: Card, to: PileRef) {
    jest.spyOn(DropZoneRegistry.prototype, 'hitTest').mockResolvedValue(to)
    await act(async () => {
      await mockWasteDrop!(0, 0, mockMakeFlight(), dragged)
    })
  }

  /** Each take-off in `at` follows the one before it by the finish's ramped gap (the n-th by finishGapMs(n - 1)), to within the
   * harness's resolution (STEP_MS). */
  function expectFinishPace(at: number[]) {
    for (let i = 1; i < at.length; i++) {
      expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(finishGapMs(i - 1) - STEP_MS)
      expect(at[i] - at[i - 1]).toBeLessThan(finishGapMs(i - 1) + 2 * STEP_MS)
    }
  }

  beforeEach(() => {
    mockSettings.autoMove = true
  })

  it('a tap that moves a card to a column and leaves the board solved does not start it: the next foundation play does, every card flies once, and the game is won', async () => {
    await mount(NINE_ON_EIGHT(), [], 10)
    await flush(3000)
    expect(mockLog.shown).toEqual([]) // nothing moves on its own

    await press(`card-${id('clubs', 9, 1)}`) // onto the 10: nothing is left to decide, but it is not a foundation play
    await flush(3000)
    expect(mockLog.shown).toEqual([id('clubs', 9, 1)])

    await press(`card-${id('clubs', 8, 1)}`) // to its foundation
    await flush(3000)

    expect(mockLog.shown).toEqual([id('clubs', 9, 1), ...FINISH_ORDER]) // the two taps, then every other card of the game exactly once
    expect(cardsOnBoard()).toBe(0)
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(moves()).toBe('11') // the two taps and each finished card
    expectFinishPace(mockLog.shownAt.slice(1)) // the first card one gap after the foundation play, each later gap shorter
  })

  it('a DRAG to a column that leaves the board solved does not start it either', async () => {
    await mount(NINE_ON_EIGHT(), [], 10)

    await dragTo(id('clubs', 9, 1), COLUMN_0)
    await flush(3000)

    expect(mockLog.shown).toEqual([])
    expect(mockRecordWon).not.toHaveBeenCalled()
  })

  it('a tap that moves the last card off the waste onto a column does not start it either', async () => {
    await mount(NINE_ON_WASTE(), [], 10)
    await flush(3000)
    expect(mockLog.shown).toEqual([]) // every card could go up, but one is still on the waste: not solved

    await press(`waste-${id('clubs', 9, 1)}`)
    await flush(3000)

    expect(mockLog.shown).toEqual([id('clubs', 9, 1)])
    expect(mockRecordWon).not.toHaveBeenCalled()
  })

  it('a DRAG of the last waste card onto a column does not start it either', async () => {
    await mount(NINE_ON_WASTE(), [], 10)

    await dragWasteTo(NINE(), COLUMN_0)
    await flush(3000)

    expect(mockLog.shown).toEqual([])
    expect(mockRecordWon).not.toHaveBeenCalled()
  })

  it('a foundation play on a solved board sends the rest up at the finish pace, each card once: the cascade it also sets off steps aside', async () => {
    await mount(SOLVED(), [], 10)

    await press(`card-${id('clubs', 8, 1)}`) // to its foundation: arms the cascade as well as allowing the finish
    await flush(3000)

    expect(mockLog.shown).toEqual(FINISH_ORDER) // the tap's own 8, then each other card once - neither automation sent one twice
    expect(new Set(mockLog.shown).size).toBe(mockLog.shown.length)
    expectFinishPace(mockLog.shownAt) // never a second card at the cascade's own pace in between
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
  })

  it.each(['stock', 'waste'] as const)('a foundation play whose cascade empties the %s hands the rest to the finish, at its own pace', async (where) => {
    await mount(TEN_LEFT_IN(where), [], 5)

    await press(`card-${id('clubs', 9, 1)}`) // to its foundation: arms the cascade, and the finish holds on to the move's permission
    await flush(3000)

    // The cascade sends the 10 up (a draw-and-play from the stock, or a play off the waste), which leaves the board solved: it
    // steps aside there and the finish files the Jack, Queen and King away - nobody drops them, nobody sends one twice.
    expect(mockLog.shown).toEqual([9, 10, 11, 12, 13].map((rank) => id('clubs', rank, 1)))
    expect(cardsOnBoard()).toBe(0)
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
    const [tapAt, cascadeAt, ...finishAt] = mockLog.shownAt
    expect(cascadeAt - tapAt).toBeGreaterThanOrEqual(AUTO_PLAY_STAGGER_MS - STEP_MS) // the cascade's card, at the cascade's pace
    expectFinishPace([cascadeAt, ...finishAt]) // then the finish's, from the commit that made the board solved
  })

  it('a column move that leaves a card on the waste does not start it, though every card could go up', async () => {
    await mount(KING_LEFT_IN('waste'), [], 10)

    await press(`card-${id('clubs', 9, 1)}`) // onto the 10 - the diamonds King is still on the waste
    await flush(3000)

    expect(mockLog.shown).toEqual([id('clubs', 9, 1)])
    expect(cardsOnBoard()).toBe(10)
    expect(mockRecordWon).not.toHaveBeenCalled()
  })

  it('a column move that leaves a card in the stock does not start it either; a foundation play then finishes it through the stock at the cascade pace', async () => {
    await mount(KING_LEFT_IN('stock'), [], 10)

    await press(`card-${id('clubs', 9, 1)}`) // onto the 10 - the diamonds King is still face down in the stock
    await flush(3000)
    expect(mockLog.shown).toEqual([id('clubs', 9, 1)])
    expect(cardsOnBoard()).toBe(10)

    await press(`card-${id('clubs', 8, 1)}`) // the player's foundation play: the cascade's draws-aware finish, unchanged
    await flush(5000)
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
    expect(mockLog.shown.slice(2)).toEqual([9, 10, 11, 12, 13].map((rank) => id('clubs', rank, 1)).concat([10, 11, 12, 13].map((rank) => id('diamonds', rank, 1))))
    const cascadeAt = mockLog.shownAt.slice(1) // from the player's 8 on
    for (let i = 1; i < cascadeAt.length; i++) expect(cascadeAt[i] - cascadeAt[i - 1]).toBeGreaterThanOrEqual(AUTO_PLAY_STAGGER_MS - STEP_MS)
  })

  it('a resumed solved board sits until the player plays a card to a foundation - a move to a column does not start it', async () => {
    await mount(NINE_APART(), [], 10)
    await flush(3000)
    expect(mockLog.shown).toEqual([])
    expect(cardsOnBoard()).toBe(10)

    await press(`card-${id('clubs', 9, 1)}`) // onto the 10: still solved
    await flush(3000)
    expect(mockLog.shown).toEqual([id('clubs', 9, 1)])

    await press(`card-${id('clubs', 8, 1)}`)
    await flush(3000)
    expect(mockLog.shown).toEqual([id('clubs', 9, 1), ...FINISH_ORDER])
    expectFinishPace(mockLog.shownAt.slice(1))
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
  })

  it('undoing back onto a solved board does not send its cards up again', async () => {
    await mount(SOLVED(), [], 10)
    await press(`card-${id('clubs', 8, 1)}`)
    await flush(3000)
    expect(cardsOnBoard()).toBe(0)
    const before = mockLog.shown.length

    await press('undo')
    await flush(3000)

    expect(mockLog.shown.length).toBe(before + 1) // the undo's own flight, and nothing went up again
    expect(screen.queryByTestId(`card-${id('diamonds', 13, 1)}`)).not.toBeNull() // the last card is back on its column, and stays
  })

  it("an undo pressed mid-finish stops it; the solved board it leaves sits until the player's next foundation play starts it again", async () => {
    await mount(SOLVED(), [], 10)
    await press(`card-${id('clubs', 8, 1)}`)
    await flush(finishGapMs(0) + finishGapMs(1) + STEP_MS) // the 9 and the 10 have gone up after the 8
    expect(mockLog.shown).toEqual(FINISH_ORDER.slice(0, 3))

    await press('undo')
    await flush(3000)
    expect(mockLog.shown).toEqual([...FINISH_ORDER.slice(0, 3), id('clubs', 10, 1)]) // the 10 flies back down, and nothing else moves
    expect(cardsOnBoard()).toBe(8)
    expect(mockRecordWon).not.toHaveBeenCalled()

    await press(`card-${id('clubs', 10, 1)}`) // the player's own foundation play
    await flush(3000)
    expect(mockLog.shown.slice(4)).toEqual(FINISH_ORDER.slice(2)) // the 10 again (theirs), then the rest
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
  })

  it('an undo pressed between two finish cards, with nothing in the air, stops it too', async () => {
    mockFlightMs = 10 // every flight lands well inside the finish's gap
    await mount(SOLVED(), [], 10)
    await press(`card-${id('clubs', 8, 1)}`)
    await flush(finishGapMs(0) + 20) // the 8 and the 9 are up and have landed; the finish is waiting out its gap before the 10
    expect(mockLog.shown).toEqual(FINISH_ORDER.slice(0, 2))
    expect(mockLog.inAir).toBe(0)

    // Nothing is flying, so the undo neither waits nor holds the finish up for long: only its own suppress ends it.
    await press('undo')
    await flush(3000)

    expect(mockLog.shown).toEqual([...FINISH_ORDER.slice(0, 2), id('clubs', 9, 1)]) // the 9 flies back down, and stays there
    expect(screen.queryByTestId(`card-${id('clubs', 9, 1)}`)).not.toBeNull()
    expect(cardsOnBoard()).toBe(9)
    expect(mockRecordWon).not.toHaveBeenCalled()
  })

  it('a new deal that happens to be solved is not filed away either', async () => {
    await mount(NINE_ON_EIGHT(), [], 10)
    await press(`card-${id('diamonds', 10, 1)}`) // a foundation play: the finish may follow the next solved board, but this one isn't (the 8 is buried)
    await flush(3000)
    expect(mockLog.shown).toEqual([id('diamonds', 10, 1)])
    const newController = fortyThievesRules.createFortyThievesController
    jest.spyOn(fortyThievesRules, 'createFortyThievesController').mockImplementation((runMoves) => ({ ...newController(runMoves), newGame: () => SOLVED() }))

    await press('new-game')
    await flush(3000)

    expect(cardsOnBoard()).toBe(10)
    expect(mockLog.shown).toEqual([id('diamonds', 10, 1)]) // no card of the new deal was auto-played
  })

  it('does not run when Auto-Move to Foundation is off', async () => {
    mockSettings.autoMove = false
    await mount(NINE_ON_EIGHT(), [], 10)

    await press(`card-${id('clubs', 9, 1)}`)
    await flush(3000)

    expect(mockLog.shown).toEqual([id('clubs', 9, 1)])
    expect(cardsOnBoard()).toBe(10)
  })
})

describe("Forty Thieves screen - the player's draw is worked out from the board as it is once its measurement is back", () => {
  // A draw measures the stock before it commits, a native round trip; MEASURE_MS stands in for it. Anything committed in that
  // window - a second stock tap, a tap-to-move - must be built on, never overwritten.
  const MEASURE_MS = 40
  const EMPTY_FOUNDATIONS = (): Card[][] => Array.from({ length: 8 }, () => [])
  const moves = () => screen.getByTestId('moves').props.children as string
  const wasteShows = (cardId: string) => screen.queryByTestId(`waste-${cardId}`) !== null
  const pileHas = (pileIndex: number, cardId: string) => within(screen.getByTestId(`pile-${pileIndex}`)).queryByTestId(`card-${cardId}`) !== null

  it('two stock taps inside one measurement draw two different cards, each its own move and its own undo step', async () => {
    await mount(board({ tableau: [[card('clubs', 5)]], foundation: EMPTY_FOUNDATIONS(), stock: [card('spades', 3), card('hearts', 4)] }), [], 2)
    mockMeasureViewMs = MEASURE_MS

    await press('stock-pile')
    await press('stock-pile') // the first draw is still measuring
    await flush(MEASURE_MS + FLIGHT_MS + 50)

    expect(mockLog.shown).toEqual([id('hearts', 4), id('spades', 3)]) // the top card, then the one under it - not the top card twice
    expect(wasteShows(id('spades', 3))).toBe(true)
    expect(moves()).toBe('2')

    // Each undo entry holds the board right before ITS draw: one Undo takes back exactly one card.
    mockMeasureViewMs = 0
    await press('undo')
    await flush(FLIGHT_MS + 50)
    expect(wasteShows(id('hearts', 4))).toBe(true)
    await press('undo')
    await flush(FLIGHT_MS + 50)
    expect(screen.queryByTestId(/^waste-/)).toBeNull()
  })

  it('a tap-to-move committed while a draw is measuring is not undone by the draw', async () => {
    await mount(board({ tableau: [[card('spades', 10)], [card('spades', 9)]], foundation: EMPTY_FOUNDATIONS(), stock: [card('hearts', 4)] }), [], 3)
    mockMeasureViewMs = MEASURE_MS

    await press('stock-pile')
    await press(`card-${id('spades', 9)}`) // onto the 10 of spades - it commits at once, while the draw is still measuring
    expect(pileHas(0, id('spades', 9))).toBe(true)
    await flush(MEASURE_MS + FLIGHT_MS + 50)

    expect(pileHas(0, id('spades', 9))).toBe(true) // still where its ghost flew - the draw built on the move
    expect(pileHas(1, id('spades', 9))).toBe(false)
    expect(wasteShows(id('hearts', 4))).toBe(true)
    expect(mockLog.shown).toEqual([id('spades', 9), id('hearts', 4)])
    expect(moves()).toBe('2')
  })

  it("a second tap made while the first draws the stock's last card draws nothing and counts no move", async () => {
    await mount(board({ tableau: [[card('clubs', 5)]], foundation: EMPTY_FOUNDATIONS(), stock: [card('hearts', 4)] }), [], 2)
    mockMeasureViewMs = MEASURE_MS

    await press('stock-pile')
    await press('stock-pile') // tapped on a board with one stock card left - but by the time it would commit, the stock is empty
    await flush(MEASURE_MS + FLIGHT_MS + 50)

    expect(mockLog.shown).toEqual([id('hearts', 4)])
    expect(wasteShows(id('hearts', 4))).toBe(true)
    expect(moves()).toBe('1')
    await press('undo')
    await flush(FLIGHT_MS + 50)
    expect(screen.queryByTestId(/^waste-/)).toBeNull() // one undo step, for the one card drawn
  })
})

// A held Undo used to stall whenever the next undo needed cards the one before it was still flying back (Jay's Yukon recording,
// 2026-10-16). A card flying in to a column or a foundation turns back in mid-air instead (ghost.peel).
describe('Forty Thieves screen - an undo that needs a card still flying back', () => {
  const col = (index: number): PileRef => ({ zone: 'tableau', index })
  const columnIds = (index: number) =>
    within(screen.getByTestId(`pile-${index}`))
      .queryAllByTestId(/^card-/)
      .map((n) => (n.props.testID as string).slice('card-'.length))
  async function undo() {
    await act(async () => {
      fireEvent.press(screen.getByTestId('undo'))
    })
  }

  it('turns it back in mid-air at once, instead of waiting for it to land', async () => {
    // The 5 of spades went onto the 6 of spades, then on again onto the other 6 of spades.
    const empty = (): Card[][] => Array.from({ length: 8 }, () => [])
    const s0 = board({ tableau: [[card('spades', 5)], [card('spades', 6, 1)], [card('spades', 6)]], foundation: empty() })
    const s1 = board({ tableau: [[], [card('spades', 6, 1)], [card('spades', 6), card('spades', 5)]], foundation: empty() })
    const s2 = board({ tableau: [[], [card('spades', 6, 1), card('spades', 5)], [card('spades', 6)]], foundation: empty() })
    const entry = (state: FortyThievesState, from: number, to: number) => ({ state, move: { from: col(from), to: col(to), count: 1, anchorCardId: id('spades', 5) } })
    await mount(s2, [entry(s0, 0, 2), entry(s1, 2, 1)], 3)

    await undo()
    await flush(10)
    expect(mockLog.shown).toEqual([id('spades', 5)])
    await undo()
    await flush(10)
    expect(mockPeel.peeled).toEqual([id('spades', 5)]) // turned back out of its flight onto the 6
    expect(mockPeel.peeledAt[0] - mockLog.shownAt[0]).toBeLessThan(FLIGHT_MS) // while that flight was still in the air
    expect(mockLog.shown).toHaveLength(1)

    await flushUntil(() => mockLog.inAir === 0)
    expect([0, 1, 2].map(columnIds)).toEqual([[id('spades', 5)], [id('spades', 6, 1)], [id('spades', 6)]])
  })
})
