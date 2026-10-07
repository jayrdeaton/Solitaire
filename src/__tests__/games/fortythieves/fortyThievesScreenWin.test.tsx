import AsyncStorage from '@react-native-async-storage/async-storage'
import { act, fireEvent, render, screen } from '@testing-library/react-native'

import { PileRef } from '@/engine/gameTypes'
import { Card, Suit } from '@/engine/types'
import FortyThievesScreen from '@/games/fortythieves/FortyThievesScreen'
import { FortyThievesState } from '@/games/fortythieves/rules'

// ---------------------------------------------------------------------------------------------------------------------
// A screen-level test for Forty Thieves' win and its no-teleport flights: the REAL FortyThievesScreen, real rules, real
// useFlightConcurrency / useWinReveal / useFoundationWinCheck / useGameSession / gameInProgress store, seeded with a saved
// game through the AsyncStorage mock. Only what needs native views, gestures or animation is replaced (same approach as
// freeCellScreenAutoPlay.test.tsx):
//   - PileView / StockWaste / FoundationCell: stand-ins that REGISTER what they render in a
//     fake CardRegistry - a tableau/waste card while it is shown, a foundation's TOP card only while the cell is
//     given it. That is what makes a flight's landing spot measurable in the real app, and what a hidden (won) foundation
//     loses. The stock/waste/foundation stand-ins also hand their slot container to stockRef/wasteRef/slotRef.
//   - useDragGhost: a fake ghost whose measure() answers only for registered cards and whose flights "land" FLIGHT_MS
//     later (the Reanimated mock's withSpring never calls its completion callback).
//   - useDealAnimator: lands every entry after a beat.
// What is observable: the ids each stand-in renders, every flight started (ghost.show), each flyTo / hide.
// ---------------------------------------------------------------------------------------------------------------------

const FLIGHT_MS = 80
const HOLD_MS = 400 // useWinReveal's WIN_REVEAL_HOLD_MS
const SAVE_KEY = 'solitaire.game-in-progress.v1.fortythieves'

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
/** Whether each foundation cell (by position) is drawing its real top card as of the last COMMIT (set from a layout effect). */
const mockPilesShown = new Map<number, boolean>()

interface MockFlightLog {
  /** Every ghost.show() - one per card flight the screen started (tap, drop, draw, undo). */
  shown: string[]
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
const mockLog: MockFlightLog = { shown: [], inAir: 0, hidden: 0, flown: 0, airAtWinCascade: -1, cascadeChains: -1, pilesShownAtCascade: -1 }
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
const mockGhost = {
  cardRegistry: { register: () => {}, unregister: () => {}, measure: async (id: string) => (mockRegistered.has(id) && !mockUnmeasurable.has(id) ? { x: 10, y: 10 } : null) },
  show: (spec: { cards: { id: string }[] }) => {
    mockLog.shown.push(spec.cards.map((c) => c.id).join('+'))
    return mockMakeFlight()
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
jest.mock('@/components/dealing/measureView', () => ({ measureView: async (view: unknown) => (view ? SLOT : null) }))
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
    StockWaste: ({ wasteTop, stockTopCard, onDrawStock, onWastePress, stockRef, wasteRef }: { wasteTop?: { id: string }; stockTopCard?: { id: string }; onDrawStock: () => void; onWastePress: (measure: () => Promise<{ x: number; y: number }>) => void; stockRef?: { current: unknown }; wasteRef?: { current: unknown } }) => {
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
    PileView: (props: { cards: Card[]; onPressCard: (card: Card, indexFromTop: number, measure: () => Promise<{ x: number; y: number }>) => void }) => {
      const id = useRef(mockPileInstance++).current
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
  jest.spyOn(AsyncStorage, 'getItem').mockImplementation(async (key: string) => (key === SAVE_KEY ? JSON.stringify({ state, undoStack, moves: 0, elapsedSeconds: 0, config: 0 }) : null))
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
  mockPileInstance = 0
  mockFoundationInstance = 0
  mockRegistered.clear()
  mockUnmeasurable.clear()
  mockLog.shown = []
  mockLog.inAir = 0
  mockLog.hidden = 0
  mockLog.flown = 0
  mockLog.airAtWinCascade = -1
  mockLog.cascadeChains = -1
  mockLog.pilesShownAtCascade = -1
  mockCommits.length = 0
  mockPilesShown.clear()
  mockNoSlot.clear()
  mockRecordWon.mockClear()
  mockFlightMs = FLIGHT_MS
  mockSettings.autoMove = false
})
afterEach(async () => {
  await act(async () => {
    await jest.runOnlyPendingTimersAsync()
  })
  jest.useRealTimers()
  jest.restoreAllMocks()
})

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
    expect(moves()).toBe('1') // only the tap counts as a move - none of the auto-plays do

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
    expect(moves()).toBe('1')
  })
})
