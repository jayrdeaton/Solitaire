import AsyncStorage from '@react-native-async-storage/async-storage'
import { act, fireEvent, render, screen } from '@testing-library/react-native'

import { PileRef } from '@/engine/gameTypes'
import { Card, Suit, SUITS } from '@/engine/types'
import CanfieldScreen from '@/games/canfield/CanfieldScreen'
import { CanfieldState } from '@/games/canfield/rules'

// ---------------------------------------------------------------------------------------------------------------------
// A screen-level test for Canfield's win and its no-teleport flights: the REAL CanfieldScreen, real rules, real
// useFlightConcurrency / useWinReveal / useFoundationWinCheck / useGameSession / gameInProgress store, seeded with a saved
// game through the AsyncStorage mock. Only what needs native views, gestures or animation is replaced (same approach as
// freeCellScreenAutoPlay.test.tsx):
//   - PileView / DraggableCard (the reserve) / StockWaste / FoundationCell: stand-ins that REGISTER what they render in a
//     fake CardRegistry - a tableau/reserve/waste card while it is shown, a foundation's TOP card only while the cell is
//     given it. That is what makes a flight's landing spot measurable in the real app, and what a hidden (won) foundation
//     loses. The stock/waste/foundation stand-ins also hand their slot container to stockRef/wasteRef/slotRef.
//   - useDragGhost: a fake ghost whose measure() answers only for registered cards and whose flights "land" FLIGHT_MS
//     later (the Reanimated mock's withSpring never calls its completion callback).
//   - useDealAnimator: lands every entry after a beat.
// What is observable: the ids each stand-in renders, every flight started (ghost.show), each flyTo / hide.
// ---------------------------------------------------------------------------------------------------------------------

const FLIGHT_MS = 80
const HOLD_MS = 400 // useWinReveal's WIN_REVEAL_HOLD_MS
const SAVE_KEY = 'solitaire.game-in-progress.v1.canfield'

const mockRecordWon = jest.fn()
/** Settings' Auto-Move to Foundation - off except where a test turns it on. */
let mockAutoMove = false
/** How long a flight stays in the air - a test can stretch it past the celebration's own hold. */
let mockFlightMs = FLIGHT_MS
let mockPileInstance = 0
/** Card ids currently rendered by a stand-in - what the fake CardRegistry can measure. */
const mockRegistered = new Set<string>()
/** Ids the registry pretends it cannot find even though they are rendered. */
const mockUnmeasurable = new Set<string>()
/** What a slot-container measurement (measureView) answers for a real, non-null view. */
const SLOT = { x: 5, y: 5 }
const mockSlotView = {}
/** Suits whose foundation cell does not hand its slot container over - measureView finds nothing for that pile. */
const mockNoSlot = new Set<string>()
/** Whether each foundation cell (by suit) is drawing its real top card as of the last COMMIT (set from a layout effect). */
const mockPilesShown = new Map<string, boolean>()

interface MockFlightLog {
  /** Every ghost.show() - one per card flight the screen started (tap, drop, draw, undo). */
  shown: string[]
  /** flyTo() calls still waiting to land. */
  inAir: number
  /** Ghosts the screen gave up on (a flight that could not be measured simply vanishes - the card appears at its destination). */
  hidden: number
  flown: number
  /** Card ids handed to the deal animator (a draw-3 fan flies through it) - one entry per card, in order. */
  dealt: string[]
  /** How many flights were still in the air the moment the win cascade started (-1: it never did). */
  airAtWinCascade: number
  /** How many chains the win cascade was started with (-1: it never was). */
  cascadeChains: number
  /** How many foundation piles were still drawing their real cards the moment the win cascade started (-1: it never did). */
  pilesShownAtCascade: number
}
const mockLog: MockFlightLog = { shown: [], inAir: 0, hidden: 0, flown: 0, dealt: [], airAtWinCascade: -1, cascadeChains: -1, pilesShownAtCascade: -1 }
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
jest.mock('@/stores/settings', () => {
  const actual = jest.requireActual('@/stores/settings')
  return { ...actual, useSettings: () => ({ settings: { ...actual.DEFAULT_SETTINGS, autoMoveToFoundation: mockAutoMove } }) }
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
  const { useEffect, useLayoutEffect } = require('react')
  const { useFrozenWhileHidden } = jest.requireActual('@/components/useFrozenWhileHidden')
  return {
    FoundationCell: ({ card, suit, isFlyingHere, settledCard, slotRef }: { card?: { id: string }; suit: string; isFlyingHere: boolean; settledCard?: { id: string } | null; slotRef?: (el: unknown) => void }) => {
      useLayoutEffect(() => {
        mockPilesShown.set(suit, card !== undefined)
      })
      useEffect(() => {
        if (!mockNoSlot.has(suit)) slotRef?.(mockSlotView)
        return () => slotRef?.(null)
      }, [slotRef, suit])
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
          <MockText testID={`foundation-${suit}`}>{card ? card.id : 'empty'}</MockText>
          <MockText testID={`under-ghost-${suit}`}>{isFlyingHere ? (underGhost ? underGhost.id : 'empty') : 'none'}</MockText>
        </MockView>
      )
    }
  }
})
// The reserve's single visible card.
jest.mock('@/components/dragdrop/DraggableCard', () => {
  const { Pressable: MockPressable } = require('react-native')
  const { useEffect } = require('react')
  return {
    DraggableCard: ({ card, onPress }: { card: { id: string }; onPress: (measure: () => Promise<{ x: number; y: number }>) => void }) => {
      useEffect(() => {
        const id = card.id
        mockRegistered.add(id)
        return () => void mockRegistered.delete(id)
      }, [card.id])
      return <MockPressable testID={`reserve-${card.id}`} onPress={() => onPress(async () => ({ x: 10, y: 10 }))} />
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
        <MockView testID={`pile-${id % 4}`}>
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
        <MockText testID='moves'>{movesCount}</MockText>
        <MockPressable testID='undo' onPress={onUndo} />
        <MockPressable testID='new-game' onPress={onNewGame} />
        {children}
      </MockView>
    )
  }
})

// ------------------------------------------------------------------------------------------------ boards

const card = (suit: Suit, rank: number): Card => ({ id: `${suit}-${rank}-0`, suit, rank, faceUp: true }) as Card
const id = (suit: Suit, rank: number) => `${suit}-${rank}-0`
/** A foundation pile built Ace-first up to `high` (the foundation rank is the Ace here). */
const pile = (suit: Suit, high: number): Card[] => Array.from({ length: high }, (_, i) => card(suit, i + 1))
function board(parts: { tableau?: Card[][]; foundation: Card[][]; reserve?: Card[]; stock?: Card[]; waste?: Card[] }): CanfieldState {
  return { tableau: Array.from({ length: 4 }, (_, i) => parts.tableau?.[i] ?? []), foundation: parts.foundation, foundationRank: 1, reserve: parts.reserve ?? [], stock: parts.stock ?? [], waste: parts.waste ?? [] }
}
/** Every card is home except the King of clubs, alone in the reserve: tapping it wins the game. */
const ONE_CARD_FROM_WON = () => board({ reserve: [card('clubs', 13)], foundation: [pile('clubs', 12), pile('diamonds', 13), pile('hearts', 13), pile('spades', 13)] })

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

async function mount(state: CanfieldState, undoStack: unknown[] = [], expectedCards = 1) {
  jest.spyOn(AsyncStorage, 'getItem').mockImplementation(async (key: string) => (key === SAVE_KEY ? JSON.stringify({ state, undoStack, moves: 0, elapsedSeconds: 0, config: 3 }) : null))
  await render(<CanfieldScreen />)
  await flush() // loadGameInProgress -> restoreGame
  expect(screen.queryAllByTestId(/^card-|^reserve-|^waste-|^stock-/).length).toBe(expectedCards)
}

const foundationTop = (suit: Suit) => screen.getByTestId(`foundation-${suit}`).props.children as string
/** What the foundation pile shows under its incoming ghost(s): a card id, 'empty' (the bare slot), or 'none' (nothing is flying there). */
const underGhost = (suit: Suit) => screen.getByTestId(`under-ghost-${suit}`).props.children as string

async function press(testID: string) {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID))
  })
}

beforeEach(() => {
  jest.useFakeTimers()
  mockPileInstance = 0
  mockRegistered.clear()
  mockUnmeasurable.clear()
  mockLog.shown = []
  mockLog.inAir = 0
  mockLog.hidden = 0
  mockLog.flown = 0
  mockLog.dealt = []
  mockLog.airAtWinCascade = -1
  mockLog.cascadeChains = -1
  mockLog.pilesShownAtCascade = -1
  mockCommits.length = 0
  mockPilesShown.clear()
  mockNoSlot.clear()
  mockRecordWon.mockClear()
  mockFlightMs = FLIGHT_MS
  mockAutoMove = false
})
afterEach(async () => {
  await act(async () => {
    await jest.runOnlyPendingTimersAsync()
  })
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('Canfield screen - the win celebration waits for the winning card to fly in and land', () => {
  it('the winning card flies (not vanishes), and neither the foundations nor the banner change until it has landed and a beat has passed', async () => {
    await mount(ONE_CARD_FROM_WON())
    expect(foundationTop('clubs')).toBe(id('clubs', 12))

    await press(`reserve-${id('clubs', 13)}`)
    await flush(10) // the move has committed and its ghost is in the air

    expect(mockRecordWon).toHaveBeenCalledTimes(1) // the win is recorded the instant it happens...
    expect(mockLog.shown).toEqual([id('clubs', 13)])
    expect(mockLog.hidden).toBe(0) // ...the winning card was NOT given up on for want of a landing spot...
    expect(mockLog.inAir).toBe(1) // ...it really is flying...
    expect(foundationTop('clubs')).toBe(id('clubs', 13)) // ...to a foundation that is still showing the whole pile,
    expect(screen.queryByTestId('win-banner')).toBeNull() // with no celebration yet
    expect(screen.queryByTestId('fireworks')).toBeNull()
    expect(mockLog.airAtWinCascade).toBe(-1)

    await flush(FLIGHT_MS) // the flight lands
    expect(mockLog.inAir).toBe(0)
    expect(foundationTop('clubs')).toBe(id('clubs', 13)) // the completed board holds for a beat
    expect(screen.queryByTestId('win-banner')).toBeNull()

    await flush(HOLD_MS + 50)
    expect(screen.getByTestId('win-banner')).toBeTruthy() // then the celebration takes over
    expect(screen.getByTestId('fireworks')).toBeTruthy()
    expect(foundationTop('clubs')).toBe('empty')
    expect(mockLog.airAtWinCascade).toBe(0) // with nothing left in the air
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
  })

  it("a flight that takes longer than the celebration's own beat still gets to land first", async () => {
    mockFlightMs = 1500
    await mount(ONE_CARD_FROM_WON())

    await press(`reserve-${id('clubs', 13)}`)
    await flush(1400) // well past HOLD_MS, the card is still in the air
    expect(mockLog.inAir).toBe(1)
    expect(foundationTop('clubs')).toBe(id('clubs', 13))
    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(mockLog.airAtWinCascade).toBe(-1)

    await flush(100 + HOLD_MS + 50) // it lands, then the beat
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(mockLog.airAtWinCascade).toBe(0)
  })

  it('is not withheld by a flight that never lands', async () => {
    await mount(ONE_CARD_FROM_WON())
    jest.spyOn(mockGhost, 'show').mockImplementation(() => ({ hide: () => {}, flyTo: () => {} }) as never) // its flight never calls back

    await press(`reserve-${id('clubs', 13)}`)
    await flush(3000)

    expect(screen.getByTestId('win-banner')).toBeTruthy()
  })

  it('undoing the winning move after the celebration has started flies the card back instead of reappearing', async () => {
    await mount(ONE_CARD_FROM_WON())
    await press(`reserve-${id('clubs', 13)}`)
    await flush(FLIGHT_MS + HOLD_MS + 50)
    expect(foundationTop('clubs')).toBe('empty') // the real foundation cards are hidden: the King is no longer measurable there
    expect(mockLog.shown).toEqual([id('clubs', 13)])

    await press('undo')
    await flush(10)

    expect(mockLog.shown).toEqual([id('clubs', 13), id('clubs', 13)]) // the undo's own ghost, from the pile's slot
    expect(mockLog.inAir).toBe(1)
    expect(mockLog.hidden).toBe(0)
    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(screen.queryByTestId('cascade-ghosts')).toBeNull() // the cascade is cleared,
    expect(foundationTop('clubs')).toBe(id('clubs', 12)) // and the reverted board is drawn for real again (the pile is not left bare)
    await flush(FLIGHT_MS)
    expect(screen.queryByTestId(`reserve-${id('clubs', 13)}`)).not.toBeNull() // home again
  })

  it('undoing during the beat before the celebration cancels it: the real foundation cards stay, no banner ever comes', async () => {
    await mount(ONE_CARD_FROM_WON())
    await press(`reserve-${id('clubs', 13)}`)
    await flush(FLIGHT_MS + 100) // landed, the completed board is holding its beat

    await press('undo')
    await flush(HOLD_MS * 3)

    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(mockLog.airAtWinCascade).toBe(-1) // the win cascade never started
    expect(foundationTop('clubs')).toBe(id('clubs', 12))
    expect(mockLog.hidden).toBe(0)
  })
})

describe('Canfield screen - the win cascade takes over from the real foundation cards once its ghosts show', () => {
  it('the piles keep their real cards until the cascade is started and its ghosts are on screen, and blank in the commit right after they show', async () => {
    await mount(ONE_CARD_FROM_WON())

    await press(`reserve-${id('clubs', 13)}`)
    await flush(FLIGHT_MS + HOLD_MS + 50)

    expect(mockLog.cascadeChains).toBe(4)
    expect(mockLog.pilesShownAtCascade).toBe(4) // every pile was still drawing its real cards when the chains started (the origins are measured off the slots, before anything blanks)
    expect(screen.getByTestId('cascade-ghosts')).toBeTruthy()
    SUITS.forEach((suit) => expect(foundationTop(suit)).toBe('empty')) // and the real cards are gone now that the ghosts stand in for them

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
    expect(mockCommits[firstGhosts + 1].bare).toBe(4)
  })

  it('a pile whose slot cannot be measured keeps its real cards instead of blanking without a chain to replace them', async () => {
    mockNoSlot.add('hearts')
    await mount(ONE_CARD_FROM_WON())

    await press(`reserve-${id('clubs', 13)}`)
    await flush(FLIGHT_MS + HOLD_MS + 50)

    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(mockLog.cascadeChains).toBe(3) // the three measurable piles get a chain...
    expect(foundationTop('clubs')).toBe('empty')
    expect(foundationTop('diamonds')).toBe('empty')
    expect(foundationTop('spades')).toBe('empty')
    expect(foundationTop('hearts')).toBe(id('hearts', 13)) // ...the fourth stays up
  })

  it('leaves the finished piles up when no chain can start, instead of blanking them with nothing to show', async () => {
    SUITS.forEach((suit) => mockNoSlot.add(suit))
    await mount(ONE_CARD_FROM_WON())

    await press(`reserve-${id('clubs', 13)}`)
    await flush(FLIGHT_MS + HOLD_MS + 50)

    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(mockLog.cascadeChains).toBe(0)
    expect(screen.queryByTestId('cascade-ghosts')).toBeNull()
    expect(SUITS.map((suit) => foundationTop(suit))).toEqual([id('clubs', 13), id('diamonds', 13), id('hearts', 13), id('spades', 13)])
  })
})

describe('Canfield screen - a card never moves without its own flight', () => {
  it("a foundation landing whose card cannot be measured flies to the pile's slot instead of being hidden", async () => {
    await mount(ONE_CARD_FROM_WON())
    mockUnmeasurable.add(id('clubs', 13)) // e.g. a later flight to the same pile has already buried it

    await press(`reserve-${id('clubs', 13)}`)
    await flush(10)

    expect(mockLog.flown).toBe(1)
    expect(mockLog.hidden).toBe(0)
  })

  it('a drawn card whose waste slot cannot be measured flies to the waste slot instead of being hidden', async () => {
    // One card left in the stock: a single-card draw (draw-3 falls back to one) flies from the stock to the waste.
    await mount(board({ tableau: [[card('clubs', 5)]], foundation: [[], [], [], []], stock: [card('diamonds', 7)] }), [], 2)
    mockUnmeasurable.add(id('diamonds', 7))

    await press('stock-pile')
    await flush(10)

    expect(mockLog.shown).toEqual([id('diamonds', 7)])
    expect(mockLog.flown).toBe(1)
    expect(mockLog.hidden).toBe(0)
  })

  it('a draw-3 fan whose top card cannot be measured still flies out of the stock to the waste slot', async () => {
    const stock = [card('diamonds', 7), card('hearts', 9), card('spades', 4), card('clubs', 8)]
    await mount(board({ tableau: [[card('clubs', 5)]], foundation: [[], [], [], []], stock }), [], 2)
    stock.forEach((c) => mockUnmeasurable.add(c.id)) // whichever three it draws, the new top cannot be found in the registry

    await press('stock-pile')
    await flush(10)

    expect(mockLog.dealt).toHaveLength(3) // all three drawn cards fly (deal-style), none just appears
    await flush(FLIGHT_MS * 2)
    expect(mockLog.hidden).toBe(0)
  })

  it('undoing a draw-3 whose top waste card cannot be measured still flies the fan back to the stock', async () => {
    const drawn = [card('diamonds', 7), card('hearts', 9), card('spades', 4)]
    const before = board({ tableau: [[card('clubs', 5)]], foundation: [[], [], [], []], stock: [card('clubs', 8), ...drawn.slice().reverse()] })
    const after = board({ tableau: [[card('clubs', 5)]], foundation: [[], [], [], []], stock: [card('clubs', 8)], waste: drawn })
    const entry = { state: before, move: { from: { zone: 'stock', index: 0 } as PileRef, to: { zone: 'waste', index: 0 } as PileRef, count: 3, anchorCardId: id('spades', 4) } }
    await mount(after, [entry], 3)
    mockUnmeasurable.add(id('spades', 4)) // the waste top

    await press('undo')
    await flush(10)

    expect(mockLog.dealt).toHaveLength(3) // all three fly back (deal-style), none just vanishes
    await flush(FLIGHT_MS * 2)
    expect(mockLog.hidden).toBe(0)
  })

  it('undoing a foundation move whose card is buried under an auto-played card flies THAT card (not the one on top) from the pile', async () => {
    // The player sent the 3 of clubs up; the auto-play then put the 4 on top of it - in a save written before auto-plays became
    // their own undo steps, the 4 has no entry of its own.
    const before = board({ tableau: [[card('clubs', 3)], [card('clubs', 4)]], foundation: [pile('clubs', 2), [], [], []] })
    const after = board({ foundation: [pile('clubs', 4), [], [], []] })
    const entry = { state: before, move: { from: { zone: 'tableau', index: 0 } as PileRef, to: { zone: 'foundation', index: SUITS.indexOf('clubs') } as PileRef, count: 1, anchorCardId: id('clubs', 3) } }
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

describe('Canfield screen - a foundation pile keeps showing the card that has landed while other cards are still flying', () => {
  /** The Ace of clubs is up, the 2 and the 3 each sit alone in a column (a diamond in the reserve keeps the game unfinished). */
  const TWO_THEN_THREE = () => board({ tableau: [[card('clubs', 2)], [card('clubs', 3)]], reserve: [card('diamonds', 5)], foundation: [pile('clubs', 1), [], [], []] })

  it('two quick taps: once the first card lands, the pile shows it under the second ghost instead of reverting to the card from before both', async () => {
    await mount(TWO_THEN_THREE(), [], 3)
    expect(underGhost('clubs')).toBe('none') // nothing is flying there

    await press(`card-${id('clubs', 2)}`)
    await flush(10)
    expect(mockLog.inAir).toBe(1)
    expect(underGhost('clubs')).toBe(id('clubs', 1)) // one card in the air: the pile still shows the Ace it had

    await press(`card-${id('clubs', 3)}`) // a second flight sets off before the first has landed
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

  it('a new deal shows the starter pile as a bare slot until its own card lands, not the card the last game left there', async () => {
    // Every pile holds cards from the game being replaced, so whichever suit the new starter turns out to be has an old top card.
    await mount(ONE_CARD_FROM_WON())

    await press('new-game')
    await flush(10)

    expect(mockLog.dealt.length).toBeGreaterThan(0) // the deal is in flight, the starter's card among them
    const starterSuit = SUITS.find((suit) => foundationTop(suit) !== 'empty')!
    expect(underGhost(starterSuit)).toBe('empty') // not the old game's top card, and not the starter itself before it has flown in

    await flush(FLIGHT_MS + 50) // the deal lands
    expect(underGhost(starterSuit)).toBe('none')
  })
})

describe('Canfield screen - every auto-played step is its own undo step', () => {
  const moves = () => screen.getByTestId('moves').props.children as number

  /** Presses Undo and lets it finish: exactly one card flies back (`fan` - a draw-3 fan flying back deal-style instead), and
   * nothing is auto-played again on the board it lands on. */
  async function undoOne(fan = 0) {
    const shown = mockLog.shown.length
    const dealt = mockLog.dealt.length
    await press('undo')
    await flush(1000)
    expect(mockLog.shown.length).toBe(shown + (fan ? 0 : 1))
    expect(mockLog.dealt.length).toBe(dealt + fan)
    expect(mockLog.hidden).toBe(0)
  }

  it('the safe cards a foundation tap sets off are taken back one at a time, before the tap itself', async () => {
    mockAutoMove = true
    // Tapping the 3 of clubs up makes the red 2s safe; the 10 of clubs in the reserve keeps the board from finishing itself.
    await mount(board({ tableau: [[card('clubs', 3)], [card('diamonds', 2)], [card('hearts', 2)], [card('spades', 5)]], reserve: [card('clubs', 10)], foundation: [pile('clubs', 2), pile('diamonds', 1), pile('hearts', 1), pile('spades', 1)] }), [], 5)

    await press(`card-${id('clubs', 3)}`)
    await flush(1000)
    expect(mockLog.shown).toEqual([id('clubs', 3), id('diamonds', 2), id('hearts', 2)]) // the tap, then two auto-plays
    expect(moves()).toBe(1) // the auto-plays do not count
    expect([foundationTop('diamonds'), foundationTop('hearts')]).toEqual([id('diamonds', 2), id('hearts', 2)])

    await undoOne() // the last card auto-played...
    expect(mockLog.shown.at(-1)).toBe(id('hearts', 2))
    expect([foundationTop('clubs'), foundationTop('diamonds'), foundationTop('hearts')]).toEqual([id('clubs', 3), id('diamonds', 2), id('hearts', 1)])
    await undoOne() // ...then the one before it (the 2 of hearts, safe again, is left where the player put it back)
    expect(mockLog.shown.at(-1)).toBe(id('diamonds', 2))
    expect([foundationTop('clubs'), foundationTop('diamonds'), foundationTop('hearts')]).toEqual([id('clubs', 3), id('diamonds', 1), id('hearts', 1)])
    await undoOne() // and only then the tap
    expect(mockLog.shown.at(-1)).toBe(id('clubs', 3))
    expect(foundationTop('clubs')).toBe(id('clubs', 2))
    expect(screen.queryByTestId(`card-${id('clubs', 3)}`)).not.toBeNull()
  })

  it("a sweep's draw-and-play is two undo steps: the card back to the waste, then the draw back into the stock", async () => {
    mockAutoMove = true
    // Tapping the 10 of clubs up leaves a board that finishes itself: one draw-3 turns up the J (waste top), which goes
    // straight up with the Q and K after it.
    const others = [pile('diamonds', 13), pile('hearts', 13), pile('spades', 13)]
    await mount(board({ tableau: [[card('clubs', 10)]], foundation: [pile('clubs', 9), ...others], stock: [card('clubs', 13), card('clubs', 12), card('clubs', 11)] }), [], 2)

    await press(`card-${id('clubs', 10)}`)
    await flush(1500)
    expect(mockLog.shown).toEqual([id('clubs', 10), id('clubs', 11), id('clubs', 12), id('clubs', 13)])
    expect(mockLog.dealt).toEqual([]) // the draw-and-play flew the J straight from the stock, no waste stop
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
    expect(moves()).toBe(1)

    await undoOne() // the K, back to the waste
    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(screen.queryByTestId(`waste-${id('clubs', 13)}`)).not.toBeNull()
    await undoOne() // the Q
    await undoOne() // the J - the play half of the draw-and-play
    expect(screen.queryByTestId(`waste-${id('clubs', 11)}`)).not.toBeNull()
    expect(foundationTop('clubs')).toBe(id('clubs', 10))
    await undoOne(3) // the draw half: the three drawn cards fly back into the stock
    expect(screen.queryByTestId(/^waste-/)).toBeNull()
    expect(screen.queryByTestId('stock-pile')).not.toBeNull()
    await undoOne() // and the tap
    expect(mockLog.shown.at(-1)).toBe(id('clubs', 10))
    expect(foundationTop('clubs')).toBe(id('clubs', 9))
  })
})
