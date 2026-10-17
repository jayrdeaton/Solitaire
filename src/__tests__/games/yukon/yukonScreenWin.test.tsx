import { act, fireEvent, render, screen } from '@testing-library/react-native'

import { AUTO_PLAY_STAGGER_MS, finishGapMs } from '@/components/dragdrop/dragSpring'
import { DropZoneRegistry } from '@/components/dragdrop/DropZoneRegistry'
import { PileRef } from '@/engine/gameTypes'
import { Card, Suit, SUITS } from '@/engine/types'
import * as yukonRules from '@/games/yukon/rules'
import { YukonState } from '@/games/yukon/rules'
import YukonScreen from '@/games/yukon/YukonScreen'

import { resetGameInProgress, seedGameInProgress, storedGame } from '../../../testUtils/gameInProgressStore'
import { peelableFlights } from '../../../testUtils/peelableFlights'

// ---------------------------------------------------------------------------------------------------------------------
// A screen-level test for Yukon's win: the REAL YukonScreen, real rules, real useFlightConcurrency / useWinReveal /
// useFoundationWinCheck / useGameSession / gameInProgress store, seeded with a saved game through the test store (src/testUtils/gameInProgressStore.ts).
// Only what needs native views, gestures or animation is replaced (same approach as freeCellScreenAutoPlay.test.tsx):
//   - PileView / FoundationCell: stand-ins that REGISTER what they render in a fake CardRegistry - a tableau card while
//     it is on a column, a foundation's TOP card only while the cell is given it. That is what makes a flight's landing
//     spot measurable in the real app, and what a hidden (won) foundation loses.
//   - useDragGhost: a fake ghost whose measure() answers only for registered cards and whose flights "land" FLIGHT_MS
//     later (the Reanimated mock's withSpring never calls its completion callback).
//   - useDealAnimator: lands every entry after a beat (the cascade-undo path flies through it).
// What is observable: the ids each stand-in renders, every flight started (ghost.show), each flyTo / hide.
// ---------------------------------------------------------------------------------------------------------------------

const FLIGHT_MS = 80
const HOLD_MS = 400 // useWinReveal's WIN_REVEAL_HOLD_MS

const mockRecordWon = jest.fn()
/** Settings' Auto-Move to Foundation - off for every test here except the ones about auto-play itself. */
const mockSettings = { autoMove: false }
/** How long a flight stays in the air - a test can stretch it past the celebration's own hold. */
let mockFlightMs = FLIGHT_MS
/** What a column's drag hands the screen when a drag of its cards ends over a pile (PileView's drag.onDrop). */
type MockDrop = (to: PileRef, count: number, anchorCardId: string, flight: unknown) => Promise<boolean> | boolean
const mockPiles = new Map<number, { cards: Card[]; drag?: { onDrop: MockDrop }; hiddenCount?: number }>()
/** Each foundation cell's onDrop (a card dragged back down to the tableau), by suit - unset while the screen gives none
 * (won) or a card is flying in to that pile, like the real cell. */
const mockFoundationDrops = new Map<string, ((x: number, y: number, flight: unknown, dragged: Card) => Promise<boolean> | boolean) | undefined>()
let mockPileInstance = 0
/** Card ids currently rendered by a stand-in - what the fake CardRegistry can measure. */
const mockRegistered = new Set<string>()
/** Ids the registry pretends it cannot find even though they are rendered (a foundation top buried by a later flight). */
const mockUnmeasurable = new Set<string>()
/** What a slot-container measurement (measureView) answers for a real, non-null view. */
const SLOT = { x: 5, y: 5 }
const mockSlotView = {}
/** Suits whose foundation cell does not hand its slot container over - measureView finds nothing for that pile. */
const mockNoSlot = new Set<string>()
/** Whether each foundation cell (by suit) is drawing its real top card as of the last COMMIT (set from a layout effect). */
const mockPilesShown = new Map<string, boolean>()
/** When set, a CardRegistry measurement of this id waits for the promise - holds a flight in its "still being measured" gap. */
let mockMeasureGate: { id: string; promise: Promise<void> } | null = null

interface MockFlightLog {
  /** Every ghost.show() - one per card flight the screen started (tap, drop, cascade step, finish step, undo). */
  shown: string[]
  /** When (fake time) each of those took off - same order as `shown`. */
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
  /** DealLayer batches started (a cascade undo's return flights). */
  dealStarts: number
}
const mockLog: MockFlightLog = { shown: [], shownAt: [], inAir: 0, hidden: 0, flown: 0, airAtWinCascade: -1, cascadeChains: -1, pilesShownAtCascade: -1, dealStarts: 0 }
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
/** An undo turning cards back mid-air: the cards each flight still carries, and every peel. */
const mockPeel = peelableFlights(() => mockMakeFlight())
const mockGhost = {
  cardRegistry: {
    register: () => {},
    unregister: () => {},
    measure: async (id: string) => {
      if (mockMeasureGate?.id === id) await mockMeasureGate.promise
      return mockRegistered.has(id) && !mockUnmeasurable.has(id) ? { x: 10, y: 10 } : null
    }
  },
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
/** Every deal.start() the screen made (the initial deal and a cascade undo's return flights alike): the entries it flew and the callbacks it handed over. */
interface MockDealCall {
  entries: { cardId: string; delayMs: number; card: { faceUp: boolean } }[]
  onLanded: (id: string) => void
  onDone?: () => void
  onDealt?: (id: string) => void
}
const mockDealCalls: MockDealCall[] = []
/** While set the stand-in deal layer never takes off or lands anything by itself - a test drives onDealt/onLanded/onDone by hand, like the real layer's clock would. */
let mockHoldDeal = false
const mockDeal = {
  start: (entries: MockDealCall['entries'], _w: number, onLanded: (id: string) => void, onDone?: () => void, onDealt?: (id: string) => void) => {
    mockLog.dealStarts += 1
    mockDealCalls.push({ entries, onLanded, onDone, onDealt })
    if (mockHoldDeal) return
    setTimeout(() => {
      entries.forEach((e) => onDealt?.(e.cardId))
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
jest.mock('@/components/dealing/measureView', () => ({ measureView: async (view: unknown) => (view ? SLOT : null) }))
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
  // Forwards testID so the deck placeholder (the standalone deal origin) can be found.
  return { PlayingCard: ({ testID }: { testID?: string }) => <MockView testID={testID} />, EmptySlot: () => <MockView />, FoundationSlot: () => <MockView /> }
})
// Like the real cell: only the top card it is GIVEN is registered, the slot container is always handed to slotRef. It also
// reports what the real cell paints UNDER the incoming ghost(s) while a flight is in the air (the caller's settledCard, or
// the frozen copy of what was on top before the flight began when it gives none) - 'none' when nothing is flying here.
jest.mock('@/games/shared/FoundationCell', () => {
  const { Text: MockText, View: MockView } = require('react-native')
  const { useEffect, useLayoutEffect } = require('react')
  const { useFrozenWhileHidden } = jest.requireActual('@/components/useFrozenWhileHidden')
  return {
    FoundationCell: ({ card, suit, isFlyingHere, settledCard, slotRef, onDrop }: { card?: { id: string }; suit: string; isFlyingHere: boolean; settledCard?: { id: string } | null; slotRef?: (el: unknown) => void; onDrop?: (x: number, y: number, flight: unknown, dragged: Card) => Promise<boolean> | boolean }) => {
      useLayoutEffect(() => {
        mockPilesShown.set(suit, card !== undefined)
      })
      // The real cell takes no drop while a card is flying in to it.
      mockFoundationDrops.set(suit, isFlyingHere ? undefined : onDrop)
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
jest.mock('@/components/PileView', () => {
  const { Pressable: MockPressable, View: MockView } = require('react-native')
  const { useEffect, useRef } = require('react')
  return {
    PileView: (props: { cards: Card[]; onPressCard: (card: Card, indexFromTop: number, measure: () => Promise<{ x: number; y: number }>) => void; drag?: { onDrop: MockDrop }; hiddenCount?: number }) => {
      const id = useRef(mockPileInstance++).current
      mockPiles.set(id, { cards: props.cards, drag: props.drag, hiddenCount: props.hiddenCount })
      const key = props.cards.map((c) => c.id).join(',')
      useEffect(() => {
        const ids = key === '' ? [] : key.split(',')
        ids.forEach((cardId) => mockRegistered.add(cardId))
        return () => ids.forEach((cardId) => mockRegistered.delete(cardId))
      }, [key])
      useEffect(() => () => void mockPiles.delete(id), [id])
      return (
        <MockView testID={`pile-${id % 7}`}>
          {props.cards.map((card, i) => (
            <MockPressable key={card.id} testID={`card-${card.id}`} onPress={() => props.onPressCard(card, props.cards.length - 1 - i, async () => ({ x: 10, y: 10 }))} />
          ))}
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

const card = (suit: Suit, rank: number): Card => ({ id: `${suit}-${rank}-0`, suit, rank, faceUp: true }) as Card
const id = (suit: Suit, rank: number) => `${suit}-${rank}-0`
/** A foundation pile built Ace-first up to `high`. */
const pile = (suit: Suit, high: number): Card[] => Array.from({ length: high }, (_, i) => card(suit, i + 1))
function board(tableau: Card[][], foundation: Card[][]): YukonState {
  return { tableau: Array.from({ length: 7 }, (_, i) => tableau[i] ?? []), foundation }
}
/** Every card is home except the King of clubs, sitting alone in a column: tapping it wins the game. */
const ONE_CARD_FROM_WON = () => board([[card('clubs', 13)]], [pile('clubs', 12), pile('diamonds', 13), pile('hearts', 13), pile('spades', 13)])
/** A LEGACY save (written before every auto-play became its own undo step): the player sent the 3 of clubs up, the
 * auto-play then put the 4 on top of it, and that auto-play was folded into the 3's entry as `cascaded`. Undo: the 3 is
 * under the 4, and one press takes both back. */
const THREE_UNDER_AUTOPLAYED_FOUR = () => {
  const before = board([[card('clubs', 3)], [card('clubs', 4)]], [pile('clubs', 2), [], [], []])
  const after = board([], [pile('clubs', 4), [], [], []])
  const entry = {
    state: before,
    move: {
      primary: { from: { zone: 'tableau', index: 0 } as PileRef, to: { zone: 'foundation', index: SUITS.indexOf('clubs') } as PileRef, count: 1, anchorCardId: id('clubs', 3) },
      cascaded: [{ from: { zone: 'tableau', index: 1 } as PileRef, to: { zone: 'foundation', index: SUITS.indexOf('clubs') } as PileRef, count: 1, anchorCardId: id('clubs', 4) }]
    }
  }
  return { after, entry }
}

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

async function mount(state: YukonState, undoStack: unknown[] = [], expectedCards = 1) {
  seedGameInProgress('yukon', { state, undoStack, moves: 0, elapsedSeconds: 0 })
  await render(<YukonScreen />)
  await flush() // loadGameInProgress -> restoreGame
  expect(screen.queryAllByTestId(/^card-/).length).toBe(expectedCards)
}

const foundationTop = (suit: Suit) => screen.getByTestId(`foundation-${suit}`).props.children as string
/** What the foundation pile shows under its incoming ghost(s): a card id, 'empty' (the bare slot), or 'none' (nothing is flying there). */
const underGhost = (suit: Suit) => screen.getByTestId(`under-ghost-${suit}`).props.children as string

async function tap(cardId: string) {
  await act(async () => {
    fireEvent.press(screen.getByTestId(`card-${cardId}`))
  })
}
async function undo() {
  await act(async () => {
    fireEvent.press(screen.getByTestId('undo'))
  })
}

beforeEach(() => {
  jest.useFakeTimers()
  mockPiles.clear()
  mockPileInstance = 0
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
  mockLog.dealStarts = 0
  mockPeel.reset()
  mockDealCalls.length = 0
  mockHoldDeal = false
  mockCommits.length = 0
  mockPilesShown.clear()
  mockFoundationDrops.clear()
  mockNoSlot.clear()
  mockMeasureGate = null
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

// Each test starts with no saved games (the store helper is shared across the file).
afterEach(() => resetGameInProgress())

describe('Yukon screen - the win celebration waits for the winning card to fly in and land', () => {
  it('the winning card flies (not vanishes), and neither the foundations nor the banner change until it has landed and a beat has passed', async () => {
    await mount(ONE_CARD_FROM_WON())
    expect(foundationTop('clubs')).toBe(id('clubs', 12))

    await tap(id('clubs', 13))
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

    await tap(id('clubs', 13))
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

    await tap(id('clubs', 13))
    await flush(3000)

    expect(screen.getByTestId('win-banner')).toBeTruthy()
  })

  it('undoing the winning move after the celebration has started flies the card back instead of reappearing', async () => {
    await mount(ONE_CARD_FROM_WON())
    await tap(id('clubs', 13))
    await flush(FLIGHT_MS + HOLD_MS + 50)
    expect(foundationTop('clubs')).toBe('empty') // the real foundation cards are hidden: the King is no longer measurable there
    expect(mockLog.shown).toEqual([id('clubs', 13)])

    await undo()
    await flush(10)

    expect(mockLog.shown).toEqual([id('clubs', 13), id('clubs', 13)]) // the undo's own ghost, from the pile's slot
    expect(mockLog.inAir).toBe(1)
    expect(mockLog.hidden).toBe(0)
    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(screen.queryByTestId('cascade-ghosts')).toBeNull() // the cascade is cleared,
    expect(foundationTop('clubs')).toBe(id('clubs', 12)) // and the reverted board is drawn for real again (the pile is not left bare)
    await flush(FLIGHT_MS)
    expect(screen.queryByTestId(`card-${id('clubs', 13)}`)).not.toBeNull() // home again
  })

  it('undoing during the beat before the celebration cancels it: the real foundation cards stay, no banner ever comes', async () => {
    await mount(ONE_CARD_FROM_WON())
    await tap(id('clubs', 13))
    await flush(FLIGHT_MS + 100) // landed, the completed board is holding its beat

    await undo()
    await flush(HOLD_MS * 3)

    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(mockLog.airAtWinCascade).toBe(-1) // the win cascade never started
    expect(foundationTop('clubs')).toBe(id('clubs', 12))
    expect(mockLog.hidden).toBe(0)
  })
})

describe('Yukon screen - the win cascade takes over from the real foundation cards once its ghosts show', () => {
  it('the piles keep their real cards until the cascade is started and its ghosts are on screen, and blank in the commit right after they show', async () => {
    await mount(ONE_CARD_FROM_WON())

    await tap(id('clubs', 13))
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

    await tap(id('clubs', 13))
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

    await tap(id('clubs', 13))
    await flush(FLIGHT_MS + HOLD_MS + 50)

    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(mockLog.cascadeChains).toBe(0)
    expect(screen.queryByTestId('cascade-ghosts')).toBeNull()
    expect(SUITS.map((suit) => foundationTop(suit))).toEqual([id('clubs', 13), id('diamonds', 13), id('hearts', 13), id('spades', 13)])
  })
})

describe('Yukon screen - a card never moves without its own flight', () => {
  it("a foundation landing whose card cannot be measured flies to the pile's slot instead of being hidden", async () => {
    await mount(ONE_CARD_FROM_WON())
    mockUnmeasurable.add(id('clubs', 13)) // e.g. a later flight to the same pile has already buried it

    await tap(id('clubs', 13))
    await flush(10)

    expect(mockLog.flown).toBe(1)
    expect(mockLog.hidden).toBe(0)
  })

  it("undoing a legacy save's foundation move whose card is buried under an auto-played cascade flies THAT card (not the one on top) from the pile", async () => {
    const { after, entry } = THREE_UNDER_AUTOPLAYED_FOUR()
    await mount(after, [entry], 0) // the 3 is buried: only a foundation's top card (the 4) is in the registry
    expect(mockRegistered.has(id('clubs', 3))).toBe(false)

    await undo()
    await flush(10)

    expect(mockLog.shown).toEqual([id('clubs', 3)]) // the 3 - not the 4 that happens to be on top
    expect(mockLog.flown).toBe(1)
    await flush(FLIGHT_MS * 2)
    expect(mockLog.hidden).toBe(0)
  })
})

describe('Yukon screen - a foundation pile keeps showing the card that has landed while other cards are still flying', () => {
  /** The Ace of clubs is up, the 2 and the 3 each sit alone in a column (a diamond keeps the game unfinished). */
  const TWO_THEN_THREE = () => board([[card('clubs', 2)], [card('clubs', 3)], [card('diamonds', 5)]], [pile('clubs', 1), [], [], []])

  it('two quick taps: once the first card lands, the pile shows it under the second ghost instead of reverting to the card from before both', async () => {
    await mount(TWO_THEN_THREE(), [], 3)
    expect(underGhost('clubs')).toBe('none') // nothing is flying there

    await tap(id('clubs', 2))
    await flush(10)
    expect(mockLog.inAir).toBe(1)
    expect(underGhost('clubs')).toBe(id('clubs', 1)) // one card in the air: the pile still shows the Ace it had

    await tap(id('clubs', 3)) // a second flight sets off before the first has landed
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

  it("a legacy save's cascade undo keeps the card that is about to fly away on its pile until its return flight is under way, instead of letting it vanish first", async () => {
    const { after, entry } = THREE_UNDER_AUTOPLAYED_FOUR()
    await mount(after, [entry], 0)
    expect(foundationTop('clubs')).toBe(id('clubs', 4))
    let release: () => void = () => {}
    // The 4's return ghost only starts once its destination has been measured (and, for real, the deal layer has mounted its slots):
    // hold that measurement to stretch the gap the pile has to cover on its own.
    mockMeasureGate = { id: id('clubs', 4), promise: new Promise<void>((resolve) => (release = resolve)) }

    await undo()
    await flush(10) // the revert has committed and taken both departing cards off the pile; the 4's ghost has not started

    expect(mockLog.dealStarts).toBe(0)
    expect(foundationTop('clubs')).toBe(id('clubs', 2))
    expect(underGhost('clubs')).toBe(id('clubs', 4)) // the pile still shows the 4 (what was on top), not what is under it: the 4 has not vanished

    release()
    await flush(10)
    expect(mockLog.dealStarts).toBe(1) // its flight is under way now

    await flush(FLIGHT_MS * 2)
    expect(underGhost('clubs')).toBe('none') // everything has landed: the pile is its real self again
    expect(foundationTop('clubs')).toBe(id('clubs', 2))
  })
})

describe('Yukon screen - auto-play and undo', () => {
  /** Every Ace is up. The 2s of clubs, hearts and spades each sit alone in a column; the 2 of diamonds is buried under the 3,
   * so the board is never finishable. Once the 2 of clubs goes up, the 2s of hearts and spades are both safe to auto-play. */
  const SAFE_TWOS = () => board([[card('clubs', 2)], [card('hearts', 2)], [card('spades', 2)], [card('diamonds', 2), card('diamonds', 3)]], [pile('clubs', 1), pile('diamonds', 1), pile('hearts', 1), pile('spades', 1)])
  /** The moves count of the latest save - what the player is scored on. */
  const savedMoves = () => (storedGame('yukon') as { moves: number }).moves

  it('every auto-played card is its own undo step, taken back one at a time before the tap that set them off', async () => {
    mockSettings.autoMove = true
    await mount(SAFE_TWOS(), [], 5)

    await tap(id('clubs', 2))
    await flush(3000)
    expect(SUITS.map((suit) => foundationTop(suit))).toEqual([id('clubs', 2), id('diamonds', 1), id('hearts', 2), id('spades', 2)])
    expect(mockLog.shown).toHaveLength(3) // the tap, then the two auto-plays
    expect(savedMoves()).toBe(3) // the tap and both auto-plays: every move counts

    const undoOne = async () => {
      const before = mockLog.shown.length
      await undo()
      await flush(3000)
      expect(mockLog.shown.length).toBe(before + 1) // one card flies back, and nothing is auto-played again
      expect(mockLog.dealStarts).toBe(0) // not through the legacy all-at-once cascade undo
    }

    await undoOne() // the last card auto-played...
    await undoOne() // ...then the other one
    expect(SUITS.map((suit) => foundationTop(suit))).toEqual([id('clubs', 2), id('diamonds', 1), id('hearts', 1), id('spades', 1)])
    expect(screen.queryByTestId(`card-${id('hearts', 2)}`)).not.toBeNull()
    expect(screen.queryByTestId(`card-${id('spades', 2)}`)).not.toBeNull()
    await undoOne() // and only then the tap itself
    expect(SUITS.map((suit) => foundationTop(suit))).toEqual([id('clubs', 1), id('diamonds', 1), id('hearts', 1), id('spades', 1)])
    expect(mockLog.hidden).toBe(0)
  })
})

describe("Yukon screen - auto-play only ever follows the player's own play of a card to a foundation", () => {
  it('an ace a column move flips up stays there for the player to find and play', async () => {
    mockSettings.autoMove = true
    await mount(board([[{ ...card('clubs', 1), faceUp: false }, card('hearts', 9)], [card('spades', 10)]], [[], [], [], []]), [], 3)

    await tap(id('hearts', 9)) // onto the 10 of spades: the face-down Ace of clubs turns over
    await flush(2000)

    expect(mockLog.shown).toEqual([id('hearts', 9)]) // the move's own flight, and nothing after it
    expect(foundationTop('clubs')).toBe('empty')
    expect(screen.queryByTestId(`card-${id('clubs', 1)}`)).not.toBeNull()
  })
})

describe("Yukon screen - once the board is solved, any move of the player's finishes the rest, at a pace that ramps up", () => {
  /** Clubs and diamonds home up to the 9, hearts up to the 10, spades complete: the other 11 cards are on the tableau. */
  const FOUNDATIONS = () => [pile('clubs', 9), pile('diamonds', 9), pile('hearts', 10), pile('spades', 13)]
  /** A column `high` at the bottom down to `low` on top, each card free to go up once the one below it in rank has. */
  const run = (suit: Suit, high: number, low: number): Card[] => Array.from({ length: high - low + 1 }, (_, i) => card(suit, high - i))
  const faceDown = (c: Card): Card => ({ ...c, faceUp: false })
  /** Solved: the 11 cards left are all face up and clear by foundation moves alone - nothing hidden, nothing left to decide. */
  const SOLVED = () => board([run('clubs', 13, 10), run('diamonds', 13, 10), run('hearts', 13, 11)], FOUNDATIONS())
  /** One move from solved: the King of hearts sits on the last face-down card, the 10 of diamonds. It has nowhere to go but an
   * empty column, and moving it there turns the 10 over. */
  const ONE_MOVE_FROM_SOLVED = () => board([run('clubs', 13, 10), [...run('diamonds', 13, 11), faceDown(card('diamonds', 10)), card('hearts', 13)], run('hearts', 12, 11)], FOUNDATIONS())
  /** The same with the Jack of diamonds face down too: moving the King turns over only the 10. Foundation moves alone would still
   * clear the rest (and turn the Jack over on the way), but a card is hidden, so the board is not solved. */
  const TWO_HIDDEN = () => board([run('clubs', 13, 10), [card('diamonds', 13), card('diamonds', 12), faceDown(card('diamonds', 11)), faceDown(card('diamonds', 10)), card('hearts', 13)], run('hearts', 12, 11)], FOUNDATIONS())
  const EMPTY_COLUMN: PileRef = { zone: 'tableau', index: 5 }

  /** Cards still on the tableau - 52 minus this many are home. */
  const cardsOnBoard = () => screen.queryAllByTestId(/^card-/).length
  /** The gaps between consecutive take-offs, from flight `from` on. */
  const gapsFrom = (from: number) => mockLog.shownAt.slice(from + 1).map((t, i) => t - mockLog.shownAt[from + i])
  /** The finish's gaps ramp up: the i-th its finishGapMs(i), to within the harness's resolution (STEP_MS). */
  const expectFinishPace = (gaps: number[]) =>
    gaps.forEach((gap, i) => {
      expect(gap).toBeGreaterThanOrEqual(finishGapMs(i) - STEP_MS)
      expect(gap).toBeLessThan(finishGapMs(i) + 2 * STEP_MS)
    })

  /** What PileView does when a drag of `cardId` (with everything above it) ends over `to`. */
  async function dragTo(cardId: string, to: PileRef) {
    const column = [...mockPiles.values()].find((p) => p.cards.some((c) => c.id === cardId))!
    const count = column.cards.length - column.cards.findIndex((c) => c.id === cardId)
    await act(async () => {
      // The drag's own ghost comes from PileView, not from the screen - it isn't counted in mockLog.shown.
      await column.drag!.onDrop(to, count, cardId, mockMakeFlight())
    })
  }

  /** Drags `dragged` off its foundation and drops it on tableau column `column` (the hit test's answer). */
  async function dropFromFoundation(suit: Suit, dragged: Card, column: number) {
    jest.spyOn(DropZoneRegistry.prototype, 'hitTest').mockResolvedValue({ zone: 'tableau', index: column })
    const onDrop = mockFoundationDrops.get(suit)
    expect(onDrop).toBeDefined()
    let applied = false
    await act(async () => {
      applied = await onDrop!(0, 0, mockMakeFlight(), dragged)
    })
    return applied
  }

  beforeEach(() => {
    mockSettings.autoMove = true
  })

  it('a tap that moves a card to a column and leaves the board solved starts it at once - no foundation play needed', async () => {
    await mount(ONE_MOVE_FROM_SOLVED(), [], 11)

    await tap(id('hearts', 13)) // nowhere to go but an empty column, and it turns over the last face-down card
    await flush(3000)

    expect(cardsOnBoard()).toBe(0)
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
    expect(mockLog.shown).toHaveLength(1 + 11) // the tap, then every card left...
    expect(new Set(mockLog.shown.slice(1)).size).toBe(11) // ...each one once
    // The first one gap after the tap, the gaps closing in on half the cascade's.
    expectFinishPace(gapsFrom(0))
  })

  it('a DRAG to a column that leaves the board solved starts it too', async () => {
    await mount(ONE_MOVE_FROM_SOLVED(), [], 11)

    await dragTo(id('hearts', 13), EMPTY_COLUMN)
    await flush(3000)

    expect(cardsOnBoard()).toBe(0)
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(mockLog.shown).toHaveLength(11) // every card left, each once (the drag's own ghost is not counted here)
    expect(new Set(mockLog.shown).size).toBe(11)
    expectFinishPace(gapsFrom(0))
  })

  it("a card the player's own move is still flying in to waits for it to land before going up (taken mid-air it would show twice)", async () => {
    mockFlightMs = 1000 // the King's flight to its new column outlasts the ten finish cards in front of it
    await mount(ONE_MOVE_FROM_SOLVED(), [], 11)

    await tap(id('hearts', 13)) // starts the finish while the King is still flying
    await flush(4000)

    expect(cardsOnBoard()).toBe(0)
    const kingUp = mockLog.shown.lastIndexOf(id('hearts', 13))
    expect(kingUp).toBe(11) // the last card to go up...
    expect(mockLog.shownAt[kingUp]).toBeGreaterThanOrEqual(mockLog.shownAt[0] + 1000) // ...once its own flight had landed
    expectFinishPace(gapsFrom(0).slice(0, 10)) // the ten in front of it kept the finish's pace
  })

  it('a tap to a foundation on a solved board sends the rest up at the finish pace, each card once - the cascade steps aside', async () => {
    await mount(SOLVED(), [], 11)
    await flush(3000)
    expect(mockLog.shown).toEqual([]) // a solved board alone (a resumed one, here) starts nothing

    await tap(id('clubs', 10))
    await flush(3000)

    expect(cardsOnBoard()).toBe(0)
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
    expect(mockLog.shown).toHaveLength(11) // the tap, then the other ten...
    expect(new Set(mockLog.shown).size).toBe(11) // ...each one once
    // Never two at once and never at the cascade's slower pace: only the finish sent them.
    expectFinishPace(gapsFrom(0))
  })

  it("a foundation play's cascade that turns the last hidden card over hands the rest to the finish, at its own pace, each card once", async () => {
    await mount(TWO_HIDDEN(), [], 11)
    await tap(id('hearts', 13)) // turns over the 10 of diamonds only - the Jack stays hidden
    await flush(500)
    await tap(id('clubs', 10)) // a foundation play: the cascade follows it, and foundation moves alone clear the rest
    await flush(3000)

    expect(cardsOnBoard()).toBe(0)
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
    const auto = mockLog.shown.slice(2)
    expect(auto).toHaveLength(10)
    expect(new Set(auto).size).toBe(10)
    // The cascade's own cards - the clubs, then the 10 of diamonds that turns the Jack over - an auto-play gap apart...
    expect(auto.slice(0, 4)).toEqual([id('clubs', 11), id('clubs', 12), id('clubs', 13), id('diamonds', 10)])
    gapsFrom(1)
      .slice(0, 4)
      .forEach((gap) => expect(gap).toBeGreaterThanOrEqual(AUTO_PLAY_STAGGER_MS - STEP_MS))
    // ...then, with nothing hidden any more, the finish's, a finish gap apart.
    expectFinishPace(gapsFrom(5))
  })

  it('a move that leaves a card face down starts nothing, even though foundation moves alone would clear the rest', async () => {
    await mount(TWO_HIDDEN(), [], 11)

    await tap(id('hearts', 13)) // turns over the 10 of diamonds; the Jack under it stays face down
    await flush(3000)

    expect(mockLog.shown).toEqual([id('hearts', 13)]) // the move's own flight, and nothing after it
    expect(cardsOnBoard()).toBe(11)
  })

  it('a resumed solved board is left alone until the player moves - then any move of theirs starts it', async () => {
    await mount(SOLVED(), [], 11)
    await flush(3000)
    expect(mockLog.shown).toEqual([])

    await tap(id('hearts', 13)) // the whole hearts column onto an empty one: still solved
    await flush(3000)

    expect(mockLog.shown[0]).toBe([id('hearts', 13), id('hearts', 12), id('hearts', 11)].join('+'))
    expect(mockLog.shown).toHaveLength(1 + 11)
    expect(cardsOnBoard()).toBe(0)
  })

  it('undoing back onto a solved board does not send its cards up again', async () => {
    await mount(SOLVED(), [], 11)
    await tap(id('clubs', 10))
    await flush(3000)
    expect(cardsOnBoard()).toBe(0)
    const before = mockLog.shown.length

    await undo()
    await flush(3000)
    await undo()
    await flush(3000)

    expect(cardsOnBoard()).toBe(2) // the last two cards the finish played are back...
    expect(mockLog.shown.length).toBe(before + 2) // ...through the undos' own flights only - nothing went up again
    expect(screen.queryByTestId('win-banner')).toBeNull()
  })

  it('an undo pressed mid-finish stops it, and nothing sends the rest up afterwards', async () => {
    await mount(SOLVED(), [], 11)
    await tap(id('clubs', 10))
    await flush(finishGapMs(0) + 20) // the first finish card has left
    await undo()
    await flush(3000)

    const sent = mockLog.shown.length
    const left = cardsOnBoard()
    expect(mockLog.shown.at(-1)).toBe(mockLog.shown.at(-2)) // the last flight is the undo's, taking back the card that went up just before it
    expect(left).toBe(11 - (sent - 1) + 1)
    expect(left).toBeGreaterThan(5) // stopped well short of the end
    await flush(3000)
    expect(mockLog.shown.length).toBe(sent)
    expect(cardsOnBoard()).toBe(left)
  })

  it("a new deal that happens to be solved is not finished either, even right after a foundation play of the player's", async () => {
    const realCreate = yukonRules.createYukonController
    jest.spyOn(yukonRules, 'createYukonController').mockImplementation(() => ({ ...realCreate(), newGame: () => SOLVED() }))
    await mount(TWO_HIDDEN(), [], 11)
    await tap(id('clubs', 10)) // a foundation play on a board short of solved (two hidden cards): the finish is allowed, and waits
    await flush(50) // before its cascade's first card
    expect(cardsOnBoard()).toBe(10)
    const before = mockLog.shown.length

    await act(async () => {
      fireEvent.press(screen.getByTestId('new-game'))
    })
    await flush(3000)

    expect(cardsOnBoard()).toBe(11) // the new deal, every card where it was dealt
    expect(mockLog.shown.length).toBe(before) // none of it auto-played
  })

  it("a card dragged back off a foundation onto a solved board is not sent straight back up - the player's next move sends it with the rest", async () => {
    await mount(SOLVED(), [], 11)

    expect(await dropFromFoundation('clubs', card('clubs', 9), 5)).toBe(true)
    await flush(3000)
    expect(foundationTop('clubs')).toBe(id('clubs', 8))
    expect(screen.queryByTestId(`card-${id('clubs', 9)}`)).not.toBeNull()
    expect(mockLog.shown).toEqual([]) // nothing went up (the drag's own ghost is the cell's, not the screen's)

    await tap(id('diamonds', 10)) // the player's next foundation play
    await flush(3000)
    expect(cardsOnBoard()).toBe(0)
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
  })

  it('dragging a card back off a foundation mid-finish stops it there', async () => {
    await mount(SOLVED(), [], 11)
    await tap(id('clubs', 10))
    await flush(finishGapMs(0) + 20) // the first finish card has left

    expect(await dropFromFoundation('hearts', card('hearts', 10), 5)).toBe(true)
    const sent = mockLog.shown.length
    await flush(3000)

    expect(mockLog.shown.length).toBe(sent) // nothing more went up
    expect(screen.queryByTestId(`card-${id('hearts', 10)}`)).not.toBeNull()
    expect(cardsOnBoard()).toBe(11 - sent + 1)
    expect(screen.queryByTestId('win-banner')).toBeNull()
  })

  it('does not run when Auto-Move to Foundation is off', async () => {
    mockSettings.autoMove = false
    await mount(ONE_MOVE_FROM_SOLVED(), [], 11)

    await tap(id('hearts', 13))
    await flush(3000)
    expect(mockLog.shown).toEqual([id('hearts', 13)])
    expect(cardsOnBoard()).toBe(11)

    await tap(id('clubs', 10)) // nor after a foundation play
    await flush(3000)
    expect(mockLog.shown).toEqual([id('hearts', 13), id('clubs', 10)])
    expect(cardsOnBoard()).toBe(10)
  })
})

describe("Yukon screen - the deck placeholder leaves with the last card, on the deal layer's own clock", () => {
  const PLACEHOLDER = 'yukon-deck-origin'
  const deckShown = () => screen.queryByTestId(PLACEHOLDER) !== null

  /** A brand-new game (nothing saved), its initial deal held at the start: returns that deal's start() call. */
  async function mountFreshDeal() {
    mockHoldDeal = true
    resetGameInProgress()
    await render(<YukonScreen />)
    await flush() // loadGameInProgress -> startNewGame
    await flush() // the deferred [state] effect -> runDeal (measures, then deal.start)
    expect(mockDealCalls).toHaveLength(1)
    return mockDealCalls[0]
  }
  const byDelay = (call: MockDealCall) => [...call.entries].sort((a, b) => a.delayMs - b.delayMs)
  const takeOff = async (call: MockDealCall, cardIds: string[]) => {
    await act(async () => {
      cardIds.forEach((cardId) => call.onDealt?.(cardId))
    })
  }

  it('keeps the 28 face-down base cards at the compressed pace and slows the 24 face-up ones to 44ms apart (~1.8s in all)', async () => {
    const call = await mountFreshDeal()
    const ordered = byDelay(call)
    expect(ordered).toHaveLength(52)
    expect(ordered.slice(0, 28).every((entry) => !entry.card.faceUp)).toBe(true) // phase 1 flies blind
    expect(ordered.slice(28).every((entry) => entry.card.faceUp)).toBe(true)

    const gaps = ordered.slice(1).map((entry, i) => entry.delayMs - ordered[i].delayMs)
    gaps.slice(0, 27).forEach((gap) => expect(gap).toBeCloseTo(920 / 51, 6)) // the face-down deal is exactly as compressed as before
    gaps.slice(27).forEach((gap) => expect(gap).toBeCloseTo(44, 6)) // the face-up run - starting with the step off the last base card - is spaced out
    expect(ordered[51].delayMs + 280).toBeGreaterThan(1815)
    expect(ordered[51].delayMs + 280).toBeLessThan(1830)
    expect(typeof call.onDealt).toBe('function')
  })

  it('shows the placeholder while dealing, and it does not disappear on a timer the deal layer never agreed to', async () => {
    await mountFreshDeal()
    expect(deckShown()).toBe(true)
    await flush(5000) // far past the last card's scheduled delay - the old setTimeout(lastDelayMs) would have hidden it by now
    expect(deckShown()).toBe(true)
  })

  it('stays up until the LAST card to leave has taken off, then goes', async () => {
    const call = await mountFreshDeal()
    const ordered = byDelay(call)
    const last = ordered[ordered.length - 1]

    await takeOff(
      call,
      ordered.slice(0, -1).map((entry) => entry.cardId)
    ) // every card but the last has left the deck
    expect(deckShown()).toBe(true)

    await takeOff(call, [last.cardId])
    expect(deckShown()).toBe(false)
  })

  it('is gone after a skip, which reports every take-off that had not happened yet at once', async () => {
    const call = await mountFreshDeal()
    const ordered = byDelay(call)
    await takeOff(
      call,
      ordered.slice(0, 5).map((entry) => entry.cardId)
    )
    expect(deckShown()).toBe(true)

    await takeOff(
      call,
      ordered.slice(5).map((entry) => entry.cardId)
    ) // the skip: the other 47 in one go, last card included
    expect(deckShown()).toBe(false)
  })

  it('still clears when the deal finishes without the last take-off having been reported (the onAllLanded safety net)', async () => {
    const call = await mountFreshDeal()
    await act(async () => {
      call.entries.forEach((entry) => call.onLanded(entry.cardId))
      call.onDone?.()
    })
    expect(deckShown()).toBe(false)
  })

  it('ignores a take-off report from a deal that a New Game has since replaced', async () => {
    const first = await mountFreshDeal()
    const last = byDelay(first).at(-1)!

    await act(async () => {
      fireEvent.press(screen.getByTestId('new-game'))
    })
    await flush()
    await flush()
    expect(mockDealCalls).toHaveLength(2) // the new game dealt again
    expect(deckShown()).toBe(true)

    await takeOff(first, [last.cardId]) // the old deal's last card - stale, must not empty the NEW deal's deck
    expect(deckShown()).toBe(true)

    const second = mockDealCalls[1]
    await takeOff(second, [byDelay(second).at(-1)!.cardId])
    expect(deckShown()).toBe(false)
  })
})

// A held Undo used to stall whenever the next undo needed cards the one before it was still flying back: it waited for them
// to land, then sent them off again (Jay's recording, 2026-10-16). The cards turn back in mid-air instead (ghost.peel), and the
// rest of that flight lands as before.
describe('Yukon screen - an undo that needs cards still flying back', () => {
  const col = (index: number): PileRef => ({ zone: 'tableau', index })
  /** The 5 of hearts went onto the 6 of spades, then the 6 and 5 together onto the 7 of clubs: undoing both takes the 5 back
   * off the pair the first undo is still flying in. */
  const CHAIN = () => {
    const s0 = board([[card('hearts', 5)], [card('clubs', 7)], [card('spades', 6)]], [[], [], [], []])
    const s1 = board([[], [card('clubs', 7)], [card('spades', 6), card('hearts', 5)]], [[], [], [], []])
    const s2 = board([[], [card('clubs', 7), card('spades', 6), card('hearts', 5)], []], [[], [], [], []])
    const undoStack = [
      { state: s0, move: { primary: { from: col(0), to: col(2), count: 1, anchorCardId: id('hearts', 5) }, cascaded: [] } },
      { state: s1, move: { primary: { from: col(2), to: col(1), count: 2, anchorCardId: id('spades', 6) }, cascaded: [] } }
    ]
    return { s2, undoStack }
  }
  /** The hidden count each column is drawn with (cards still flying in), by column. */
  const hiddenCounts = () => [...mockPiles.entries()].sort(([a], [b]) => a - b).map(([, p]) => p.hiddenCount ?? 0)

  it('turns them back in mid-air at once, instead of waiting for them to land', async () => {
    const { s2, undoStack } = CHAIN()
    await mount(s2, undoStack, 3)

    await undo()
    await flush(10) // the pair is flying back to the 6's column
    expect(mockLog.shown).toEqual([`${id('spades', 6)}+${id('hearts', 5)}`])
    expect(mockLog.inAir).toBe(1)
    const pairLeft = mockLog.shownAt[0]

    await undo()
    await flush(10)
    expect(mockPeel.peeled).toEqual([id('hearts', 5)]) // the 5 turned back out of the pair's flight
    expect(mockPeel.peeledAt[0] - pairLeft).toBeLessThan(FLIGHT_MS) // while the pair was still in the air
    expect(mockLog.shown).toHaveLength(1) // no second ghost from where the pair will land
    expect(mockLog.inAir).toBe(2)
    expect(hiddenCounts().slice(0, 3)).toEqual([1, 0, 1]) // the 5 flies home to its column; the pair's flight now brings only the 6

    await flushUntil(() => mockLog.inAir === 0)
    expect(hiddenCounts().slice(0, 3)).toEqual([0, 0, 0])
    expect(mockPiles.size).toBe(7)
    expect([...mockPiles.values()].slice(0, 3).map((p) => p.cards.map((c) => c.id))).toEqual([[id('hearts', 5)], [id('clubs', 7)], [id('spades', 6)]])
  })

  it('still waits for the landing when the cards are not the top of what is in the air', async () => {
    const { s2, undoStack } = CHAIN()
    await mount(s2, undoStack, 3)
    jest.spyOn(mockGhost, 'canPeel').mockReturnValue(false)

    await undo()
    await flush(10)
    await undo()
    await flush(10)
    expect(mockPeel.peeled).toEqual([])
    expect(mockLog.shown).toHaveLength(1) // the second undo is waiting for the pair to land

    await flushUntil(() => mockLog.shown.length === 2)
    expect(mockLog.shownAt[1] - mockLog.shownAt[0]).toBeGreaterThanOrEqual(FLIGHT_MS)
  })
})

// Jay's recording, 2026-10-16: a run tapped onto the 9C, then the QH above that 9C tapped before the run had landed. The QH's
// run took the cards still in the air along as if they were on the column: they were drawn twice (the first ghost still landing
// them, the new ghost carrying them off), and the column's landing count, still waiting for them, hid every card left in it (the
// face-down card, turned up by the move) until the first flight landed. The cards in the air now go on from mid-air (ghost.peel).
describe('Yukon screen - a tapped run that reaches into cards still flying in to its column', () => {
  const down = (suit: Suit, rank: number): Card => ({ ...card(suit, rank), faceUp: false })
  /** The 8D and 7C go onto the 9C (the only place they can), then the QH, the 9C and them onto the KC. */
  const QUICK = () =>
    board(
      [
        [card('clubs', 13), card('diamonds', 8), card('clubs', 7)],
        [down('spades', 2), card('hearts', 12), card('clubs', 9)]
      ],
      [[], [], [], []]
    )
  /** The hidden count each column is drawn with (cards still flying in), by column. */
  const hiddenCounts = () => [...mockPiles.entries()].sort(([a], [b]) => a - b).map(([, p]) => p.hiddenCount ?? 0)
  const columns = () => [...mockPiles.entries()].sort(([a], [b]) => a - b).map(([, p]) => p.cards.map((c) => `${c.id}${c.faceUp ? '' : ' down'}`))

  it('sends them on from mid-air, and the cards left in their column show at once', async () => {
    await mount(QUICK(), [], 6)

    await tap(id('diamonds', 8))
    await flush(10) // the 8D and 7C are flying to the 9C
    expect(mockLog.shown).toEqual([`${id('diamonds', 8)}+${id('clubs', 7)}`])
    expect(mockLog.inAir).toBe(1)
    const runLeft = mockLog.shownAt[0]

    await tap(id('hearts', 12))
    await flush(10)
    expect(mockLog.shown[1]).toBe(`${id('hearts', 12)}+${id('clubs', 9)}`) // only the cards on the column lift off it
    expect(mockPeel.peeled).toEqual([`${id('diamonds', 8)}+${id('clubs', 7)}`]) // the cards in the air turn toward the KC
    expect(mockPeel.peeledAt[0] - runLeft).toBeLessThan(FLIGHT_MS) // while they were still in the air
    expect(mockLog.shown).toHaveLength(2)
    expect(hiddenCounts().slice(0, 2)).toEqual([4, 0]) // the column they left hides nothing: its turned-up 2S shows
    expect(columns()[1]).toEqual([id('spades', 2)])

    await flushUntil(() => mockLog.inAir === 0)
    expect(hiddenCounts().slice(0, 2)).toEqual([0, 0])
    expect(columns().slice(0, 2)).toEqual([[id('clubs', 13), id('hearts', 12), id('clubs', 9), id('diamonds', 8), id('clubs', 7)], [id('spades', 2)]])
  })

  it("waits for them to land when they can't be taken out of the air yet", async () => {
    await mount(QUICK(), [], 6)
    jest.spyOn(mockGhost, 'canPeel').mockReturnValue(false)

    await tap(id('diamonds', 8))
    await flush(10)
    await tap(id('hearts', 12))
    await flush(10)
    expect(mockLog.shown).toHaveLength(1) // the QH waits for the 8D and 7C to land
    expect(hiddenCounts().slice(0, 2)).toEqual([0, 2])

    await flushUntil(() => mockLog.shown.length === 2)
    expect(mockLog.shown[1]).toBe(`${id('hearts', 12)}+${id('clubs', 9)}+${id('diamonds', 8)}+${id('clubs', 7)}`)
    expect(mockLog.shownAt[1] - mockLog.shownAt[0]).toBeGreaterThanOrEqual(FLIGHT_MS)
    expect(hiddenCounts().slice(0, 2)).toEqual([4, 0])

    await flushUntil(() => mockLog.inAir === 0)
    expect(columns().slice(0, 2)).toEqual([[id('clubs', 13), id('hearts', 12), id('clubs', 9), id('diamonds', 8), id('clubs', 7)], [id('spades', 2)]])
  })
})
