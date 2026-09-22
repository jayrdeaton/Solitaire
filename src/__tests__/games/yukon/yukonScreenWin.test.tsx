import AsyncStorage from '@react-native-async-storage/async-storage'
import { act, fireEvent, render, screen } from '@testing-library/react-native'

import { PileRef } from '@/engine/gameTypes'
import { Card, Suit, SUITS } from '@/engine/types'
import { YukonState } from '@/games/yukon/rules'
import YukonScreen from '@/games/yukon/YukonScreen'

// ---------------------------------------------------------------------------------------------------------------------
// A screen-level test for Yukon's win: the REAL YukonScreen, real rules, real useFlightConcurrency / useWinReveal /
// useFoundationWinCheck / useGameSession / gameInProgress store, seeded with a saved game through the AsyncStorage mock.
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
const SAVE_KEY = 'solitaire.game-in-progress.v1.yukon'

const mockRecordWon = jest.fn()
/** How long a flight stays in the air - a test can stretch it past the celebration's own hold. */
let mockFlightMs = FLIGHT_MS
const mockPiles = new Map<number, { cards: Card[] }>()
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
  /** Every ghost.show() - one per card flight the screen started (tap, drop, cascade step, undo). */
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
  /** DealLayer batches started (a cascade undo's return flights). */
  dealStarts: number
}
const mockLog: MockFlightLog = { shown: [], inAir: 0, hidden: 0, flown: 0, airAtWinCascade: -1, cascadeChains: -1, pilesShownAtCascade: -1, dealStarts: 0 }
/** One entry per React COMMIT that re-rendered the win cascade's ghost layer: whether ghosts were mounted, and how many foundation
 * piles were drawn bare (their real cards blanked) in that same commit. */
const mockCommits: { ghosts: boolean; bare: number }[] = []
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
    return mockMakeFlight()
  }
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

jest.mock('@/components/dragdrop/DragGhostLayer', () => ({ DragGhostProvider: ({ children }: { children: unknown }) => children, useDragGhost: () => mockGhost }))
jest.mock('@/components/dealing/DealLayer', () => ({ DealProvider: ({ children }: { children: unknown }) => children, useDealAnimator: () => mockDeal }))
// Like the real layer, starting chains is a React STATE update on a provider above the screen (so it batches with whatever
// state the screen sets in the same tick) and the ghosts are mounted by the same state. A layout effect on the ghost layer
// records, per commit, whether ghosts are up and how many piles are drawn bare in that very commit.
jest.mock('@/components/winning/WinCascadeLayer', () => {
  const { createContext, useContext, useLayoutEffect, useMemo, useState } = require('react')
  const { View: MockView } = require('react-native')
  const CascadeContext = createContext(null)
  return {
    WinCascadeProvider: ({ children }: { children: unknown }) => {
      const [started, setStarted] = useState(false)
      const controller = useMemo(
        () => ({
          startChains: (chains: unknown[]) => {
            mockLog.airAtWinCascade = mockLog.inAir
            mockLog.cascadeChains = chains.length
            mockLog.pilesShownAtCascade = [...mockPilesShown.values()].filter((shown) => shown).length
            setStarted(chains.length > 0)
          },
          clear: () => setStarted(false)
        }),
        []
      )
      const value = useMemo(() => ({ controller, started }), [controller, started])
      return <CascadeContext.Provider value={value}>{children}</CascadeContext.Provider>
    },
    WinCascadeGhosts: () => {
      const { started } = useContext(CascadeContext)
      useLayoutEffect(() => {
        mockCommits.push({ ghosts: started, bare: mockBarePiles() })
      })
      return started ? <MockView testID='cascade-ghosts' /> : null
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
  return { ...actual, useSettings: () => ({ settings: { ...actual.DEFAULT_SETTINGS, autoMoveToFoundation: false } }) }
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
jest.mock('@/components/PileView', () => {
  const { Pressable: MockPressable, View: MockView } = require('react-native')
  const { useEffect, useRef } = require('react')
  return {
    PileView: (props: { cards: Card[]; onPressCard: (card: Card, indexFromTop: number, measure: () => Promise<{ x: number; y: number }>) => void }) => {
      const id = useRef(mockPileInstance++).current
      mockPiles.set(id, { cards: props.cards })
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
/** The player sent the 3 of clubs up; the auto-play then put the 4 on top of it. Undo: the 3 is under the 4. */
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
  jest.spyOn(AsyncStorage, 'getItem').mockImplementation(async (key: string) => (key === SAVE_KEY ? JSON.stringify({ state, undoStack, moves: 0, elapsedSeconds: 0 }) : null))
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
  mockLog.inAir = 0
  mockLog.hidden = 0
  mockLog.flown = 0
  mockLog.airAtWinCascade = -1
  mockLog.cascadeChains = -1
  mockLog.pilesShownAtCascade = -1
  mockLog.dealStarts = 0
  mockDealCalls.length = 0
  mockHoldDeal = false
  mockCommits.length = 0
  mockPilesShown.clear()
  mockNoSlot.clear()
  mockMeasureGate = null
  mockRecordWon.mockClear()
  mockFlightMs = FLIGHT_MS
})
afterEach(async () => {
  await act(async () => {
    await jest.runOnlyPendingTimersAsync()
  })
  jest.useRealTimers()
  jest.restoreAllMocks()
})

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

describe('Yukon screen - the win cascade takes over from the real foundation cards in one commit', () => {
  it('the piles keep their real cards until the cascade is started, and blank in the very commit that mounts its ghosts', async () => {
    await mount(ONE_CARD_FROM_WON())

    await tap(id('clubs', 13))
    await flush(FLIGHT_MS + HOLD_MS + 50)

    expect(mockLog.cascadeChains).toBe(4)
    expect(mockLog.pilesShownAtCascade).toBe(4) // every pile was still drawing its real cards when the chains started (the origins are measured off the slots, before anything blanks)
    expect(screen.getByTestId('cascade-ghosts')).toBeTruthy()
    SUITS.forEach((suit) => expect(foundationTop(suit)).toBe('empty')) // and the real cards are gone now that the ghosts stand in for them

    // No commit ever drew a pile bare without the cascade's ghosts mounted to stand in for it (that was ~140ms of empty piles)...
    expect(mockCommits.filter((commit) => commit.bare > 0 && !commit.ghosts)).toEqual([])
    // ...because the commit that mounted the ghosts is the same one that blanked the piles, the one before it drawing them all.
    const firstGhosts = mockCommits.findIndex((commit) => commit.ghosts)
    expect(firstGhosts).toBeGreaterThan(0)
    expect(mockCommits[firstGhosts].bare).toBe(4)
    expect(mockCommits[firstGhosts - 1].bare).toBe(0)
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

  it('undoing a foundation move whose card is buried under an auto-played cascade flies THAT card (not the one on top) from the pile', async () => {
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

  it('a cascade undo keeps the card that is about to fly away on its pile until its return flight is under way, instead of letting it vanish first', async () => {
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

describe("Yukon screen - the deck placeholder leaves with the last card, on the deal layer's own clock", () => {
  const PLACEHOLDER = 'yukon-deck-origin'
  const deckShown = () => screen.queryByTestId(PLACEHOLDER) !== null

  /** A brand-new game (nothing saved), its initial deal held at the start: returns that deal's start() call. */
  async function mountFreshDeal() {
    mockHoldDeal = true
    jest.spyOn(AsyncStorage, 'getItem').mockResolvedValue(null)
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
