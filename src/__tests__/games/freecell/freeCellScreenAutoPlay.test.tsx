import AsyncStorage from '@react-native-async-storage/async-storage'
import { act, fireEvent, render, screen } from '@testing-library/react-native'

import { AUTO_MOVE_SPRING, scaledMs, springSettleMs, winSweepSpringFor } from '@/components/dragdrop/dragSpring'
import { PileRef } from '@/engine/gameTypes'
import { Card, Suit, SUITS } from '@/engine/types'
import FreeCellScreen, { FINISH_LAST_CARD_WAIT_MS, FINISH_STAGGER_MS } from '@/games/freecell/FreeCellScreen'
import { FreeCellController, FreeCellState } from '@/games/freecell/rules'

// ---------------------------------------------------------------------------------------------------------------------
// A screen-level test for FreeCell's auto-play policy (see src/games/freecell/autoPlay.ts): the REAL FreeCellScreen, real
// game rules, real useFlightConcurrency / useAutoFoundationCascade / useAutoFinish / useGameSession / useFoundationWinCheck /
// gameInProgress store, seeded with a saved game through the AsyncStorage mock. Only the parts that need native views,
// gestures or animation are replaced, each by a stand-in that honors the same contract the screen relies on:
//   - PileView / DraggableCard: a tap calls onPressCard(card, indexFromTop, measure) / onPress(measure); a drop calls
//     drag.onDrop(target, count, anchorCardId, flight) - exactly how the real ones drive the screen.
//   - useDragGhost: a fake ghost whose flights "land" FLIGHT_MS later (the Reanimated mock's withSpring never calls its
//     completion callback, so the real ghost's flights would never settle and nothing downstream could ever fire).
//   - useDealAnimator: lands every entry after a beat (the cascade-undo path flies through it).
// What is observable: the card ids each stand-in renders (pile/freecell/foundation contents) and every flight started.
// ---------------------------------------------------------------------------------------------------------------------

const FLIGHT_MS = 80
/** How long a finish (sweep-tier) flight stays up: the real ghost keeps it up springSettleMs of a winSweepSpringFor spring (~110-215ms over the board's
 * distances; ~160ms for a 200px hop) - derived, so re-pacing the flights (dragSpring.ts's FLIGHT_TIME_SCALE) keeps the stand-in honest. Every other flight
 * stays at FLIGHT_MS. */
const SWEEP_FLIGHT_MS = springSettleMs(winSweepSpringFor(200))
const SAVE_KEY = 'solitaire.game-in-progress.v1.freecell'

const mockSettings = { autoMove: true }
const mockRecordWon = jest.fn()
const mockPiles = new Map<number, { cards: Card[]; drag: { onDrop: (to: PileRef, count: number, anchorCardId: string, flight: unknown) => Promise<boolean> | boolean; getRunCount: (i: number) => number } }>()
let mockPileInstance = 0

interface MockFlightLog {
  /** Every ghost.show() - one per card flight the screen started (tap, drop, cascade step, finish step, undo). */
  shown: string[]
  /** flyTo() calls still waiting to land. */
  inAir: number
  maxInAir: number
  /** How many flights were still in the air the moment the win cascade started (-1: it never did). */
  airAtWinCascade: number
  /** How many chains the win cascade was started with (-1: it never started). */
  chainsAtWinCascade: number
  /** What each foundation pile was showing (a card id, or 'empty') the moment the win cascade started - null if it never did. */
  foundationsAtWinCascade: string[] | null
  /** Commit-time order of the hand-off: 'cascade' when startChains is called, 'blank-<suit>' when a foundation cell commits with no
   * real card (an empty pile mid-game shows up here too, so only tests that start from full piles read it). */
  events: string[]
  /** The pace flags every flyTo() was asked for, in order - a plain tap/drop asks for neither, a cascade step is `fast`, a
   * finish step is `sweep` (dragSpring.ts's fastest spring). */
  paces: { fast?: boolean; sweep?: boolean }[]
}
const mockLog: MockFlightLog = { shown: [], inAir: 0, maxInAir: 0, airAtWinCascade: -1, chainsAtWinCascade: -1, foundationsAtWinCascade: null, events: [], paces: [] }
/** Suits whose foundation slot container fails to measure (the rare origin-measurement failure). */
const mockUnmeasurableSlots = new Set<string>()
/** What every foundation cell shows right now - read from inside the mocked cascade, hence hoisted-mock naming. */
const mockFoundationsNow = () => SUITS.map((suit) => screen.getByTestId(`foundation-${suit}`).props.children as string)

function mockMakeFlight() {
  return {
    hide: () => {},
    flyTo: (_x: number, _y: number, onDone?: () => void, opts?: { fast?: boolean; sweep?: boolean }) => {
      mockLog.paces.push({ fast: opts?.fast, sweep: opts?.sweep })
      mockLog.inAir += 1
      mockLog.maxInAir = Math.max(mockLog.maxInAir, mockLog.inAir)
      setTimeout(
        () => {
          mockLog.inAir -= 1
          onDone?.()
        },
        opts?.sweep ? SWEEP_FLIGHT_MS : FLIGHT_MS
      )
    }
  }
}
const mockGhost = {
  cardRegistry: { register: () => {}, unregister: () => {}, measure: async () => ({ x: 10, y: 10 }) },
  show: (spec: { cards: { id: string }[] }) => {
    mockLog.shown.push(spec.cards.map((c) => c.id).join('+'))
    return mockMakeFlight()
  }
}
/** Every deal.start() the screen made (initial deals and cascade-undo batches alike): the entries it flew and the callbacks it handed over. */
interface MockDealCall {
  entries: { cardId: string; delayMs: number; card: { faceUp: boolean } }[]
  onLanded: (id: string) => void
  onDone: () => void
  onDealt?: (id: string) => void
}
const mockDealCalls: MockDealCall[] = []
/** While set the stand-in deal layer never takes off or lands anything by itself - a test drives onDealt/onLanded/onDone by hand, like the real layer's clock would. */
let mockHoldDeal = false
const mockDeal = {
  start: (entries: MockDealCall['entries'], _w: number, onLanded: (id: string) => void, onDone: () => void, onDealt?: (id: string) => void) => {
    mockDealCalls.push({ entries, onLanded, onDone, onDealt })
    if (mockHoldDeal) return
    setTimeout(() => {
      entries.forEach((e) => onDealt?.(e.cardId))
      entries.forEach((e) => onLanded(e.cardId))
      onDone()
    }, FLIGHT_MS)
  },
  cancel: () => {}
}

jest.mock('@/components/dragdrop/DragGhostLayer', () => ({ DragGhostProvider: ({ children }: { children: unknown }) => children, useDragGhost: () => mockGhost }))
jest.mock('@/components/dealing/DealLayer', () => ({ DealProvider: ({ children }: { children: unknown }) => children, useDealAnimator: () => mockDeal }))
jest.mock('@/components/winning/WinCascadeLayer', () => ({
  WinCascadeProvider: ({ children }: { children: unknown }) => children,
  WinCascadeGhosts: () => null,
  useWinCascade: () => ({
    startChains: (chains: unknown[]) => {
      mockLog.airAtWinCascade = mockLog.inAir
      mockLog.chainsAtWinCascade = chains.length
      mockLog.foundationsAtWinCascade = mockFoundationsNow()
      mockLog.events.push('cascade')
    },
    clear: () => {}
  })
}))
// A foundation slot container measures like any view unless its suit is in mockUnmeasurableSlots; every other view (the deal origin the
// stand-ins never attach, so null) keeps answering.
jest.mock('@/components/dealing/measureView', () => ({ measureView: async (view: { suit?: string } | null) => (view?.suit && mockUnmeasurableSlots.has(view.suit) ? null : { x: 5, y: 5 }) }))
// DropZone (the real one, wrapping the mocked PileView above) still registers its own view for real, but this test
// environment's measureInWindow never actually calls back (the same reason measureView itself is mocked above) - so
// the deal's own column-container measurement (runDeal's analytical destination math - see FreeCellScreen's own doc
// comment on it) needs a working stand-in too, or every column comes back unresolved and no deal ever starts at all.
// One column-index-sized step per column is enough for a deterministic, distinct rect per column - the exact pixels
// are never asserted here, only that entries end up with sane, present `to` coordinates.
jest.mock('@/components/dragdrop/DropZoneRegistry', () => ({
  useDropZoneRegistry: () => ({
    register: () => {},
    unregister: () => {},
    measure: async (ref: { index: number }) => ({ x: ref.index * 60, y: 100, width: 50, height: 70 }),
    hitTest: async () => null
  })
}))
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
  return { ...actual, useSettings: () => ({ settings: { ...actual.DEFAULT_SETTINGS, autoMoveToFoundation: mockSettings.autoMove } }) }
})
jest.mock('@/components/theme', () => {
  const actual = jest.requireActual('@/components/theme')
  return { ...actual, useTableColors: () => actual.lightColors }
})
jest.mock('@/components/PlayingCard', () => {
  const { View: MockView } = require('react-native')
  // Forwards testID so the deck placeholder (FreeCell's far-right freecell while dealing) can be found.
  return { PlayingCard: ({ testID }: { testID?: string }) => <MockView testID={testID} />, EmptySlot: () => <MockView />, FoundationSlot: () => <MockView /> }
})
jest.mock('@/games/shared/FoundationCell', () => {
  const { Text: MockText } = require('react-native')
  const { useEffect: mockEffect } = require('react')
  function MockFoundationCell({ card, suit, slotRef }: { card?: { id: string }; suit: string; slotRef?: (el: { suit: string } | null) => void }) {
    // Like the real cell's outer container: always mounted, whether or not a real card is drawn, and handed to the screen as the slot to measure.
    mockEffect(() => {
      slotRef?.({ suit })
      return () => slotRef?.(null)
    }, [slotRef, suit])
    mockEffect(() => {
      if (!card) mockLog.events.push(`blank-${suit}`)
    }, [card, suit])
    return <MockText testID={`foundation-${suit}`}>{card ? card.id : 'empty'}</MockText>
  }
  return { FoundationCell: MockFoundationCell }
})
jest.mock('@/components/dragdrop/DraggableCard', () => {
  const { Pressable: MockPressable } = require('react-native')
  return { DraggableCard: ({ card, onPress }: { card: { id: string }; onPress: (measure: () => Promise<{ x: number; y: number }>) => void }) => <MockPressable testID={`freecell-${card.id}`} onPress={() => onPress(async () => ({ x: 10, y: 10 }))} /> }
})
jest.mock('@/components/PileView', () => {
  const { Pressable: MockPressable, View: MockView } = require('react-native')
  const { useEffect, useRef } = require('react')
  return {
    PileView: (props: { cards: Card[]; onPressCard: (card: Card, indexFromTop: number, measure: () => Promise<{ x: number; y: number }>) => void; drag: never }) => {
      const id = useRef(mockPileInstance++).current
      mockPiles.set(id, { cards: props.cards, drag: props.drag })
      useEffect(() => () => void mockPiles.delete(id), [id])
      return (
        <MockView testID={`pile-${id % 8}`}>
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
/** A column already sorted for finishing: `high` at the bottom down to `low` on top. */
const column = (suit: Suit, high: number, low: number): Card[] => {
  const cards: Card[] = []
  for (let r = high; r >= low; r--) cards.push(card(suit, r))
  return cards
}
function board(columns: Card[][]): FreeCellState {
  const tableau: Card[][] = Array.from({ length: 8 }, (_, i) => columns[i] ?? [])
  return { tableau, freecells: [null, null, null, null], foundation: [[], [], [], []] }
}
const id = (suit: Suit, rank: number) => `${suit}-${rank}-0`

/** Every column sorted (highest at the bottom): finishable by foundation moves alone, from the very start. */
const FINISHABLE = () => board([column('clubs', 13, 1), column('diamonds', 13, 1), column('hearts', 13, 1), column('spades', 13, 1)])
/** Finishable except 2 of clubs sits on the Ace of clubs: ONE non-foundation move (2C anywhere else) fixes it. */
const ONE_MOVE_FROM_FINISHABLE = () => board([column('clubs', 13, 3), column('diamonds', 13, 1), column('hearts', 13, 1), column('spades', 13, 1), [card('clubs', 1), card('clubs', 2)]])
/** NOT finishable (2 of diamonds sits on the Ace of diamonds and stays there) but full of safe cards: A of clubs is on top
 * of 2 of clubs, and the Aces of hearts and spades are on top of their columns. */
const SAFE_CARDS_BOARD = () => board([column('clubs', 13, 3), column('diamonds', 13, 3), column('hearts', 13, 1), column('spades', 13, 1), [card('clubs', 2), card('clubs', 1)], [card('diamonds', 1), card('diamonds', 2)]])

/** Two deadlocks (2 of diamonds on the Ace of diamonds, 2 of hearts on the Ace of hearts), so the board stays unfinishable
 * whichever ONE of those 2s is moved - with the Aces of clubs and spades, both safe to play, sitting on top of their columns. */
const TWO_DEADLOCKS_BOARD = () => board([column('clubs', 13, 3), column('diamonds', 13, 3), column('hearts', 13, 3), column('spades', 13, 1), [card('clubs', 2), card('clubs', 1)], [card('diamonds', 1), card('diamonds', 2)], [card('hearts', 1), card('hearts', 2)]])

/** Every card is home except the King of clubs, sitting alone in a column: tapping it wins the game. */
const ONE_CARD_FROM_WON = (): FreeCellState => ({
  tableau: [[card('clubs', 13)], [], [], [], [], [], [], []],
  freecells: [null, null, null, null],
  foundation: SUITS.map((suit) => column(suit, suit === 'clubs' ? 12 : 13, 1).reverse())
})

const HOLD_MS = 400 // useWinReveal's WIN_REVEAL_HOLD_MS

// ------------------------------------------------------------------------------------------------ harness

const STEP_MS = 10

/** Advances fake time by `ms`, in small steps each inside its OWN act(): React only processes the renders and effects a
 * step's timers queued when its act scope exits, and the cascade/finish are chains of "land -> render -> effect -> next
 * card", so one big advance would starve them. */
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

/** Keeps advancing fake time until `done()` - for "the cascade has just started", whose exact moment the test does not pin. */
async function flushUntil(done: () => boolean, maxMs = 2000) {
  for (let t = 0; !done() && t < maxMs; t += STEP_MS) await flush(STEP_MS)
}

async function mount(state: FreeCellState, expectedCards = 52) {
  jest.spyOn(AsyncStorage, 'getItem').mockImplementation(async (key: string) => (key === SAVE_KEY ? JSON.stringify({ state, undoStack: [], moves: 0, elapsedSeconds: 0 }) : null))
  await render(<FreeCellScreen />)
  await flush() // loadGameInProgress -> restoreGame
  expect(screen.queryAllByTestId(/^card-|^freecell-/).length).toBe(expectedCards)
}

const foundationTop = (suit: Suit) => screen.getByTestId(`foundation-${suit}`).props.children as string
const foundationTops = () => Object.fromEntries(SUITS.map((s) => [s, foundationTop(s)]))
/** Cards still on the tableau/freecells - so 52 minus this is the number on the foundations. */
const cardsOnBoard = () => screen.queryAllByTestId(/^card-|^freecell-/).length

async function tap(cardId: string) {
  await act(async () => {
    fireEvent.press(screen.getByTestId(`card-${cardId}`))
  })
}

/** What PileView does when a drag of `cardId` (with everything under it) ends over `to`. */
async function dragTo(cardId: string, to: PileRef) {
  const pile = [...mockPiles.values()].find((p) => p.cards.some((c) => c.id === cardId))!
  const index = pile.cards.findIndex((c) => c.id === cardId)
  const count = pile.cards.length - index
  expect(pile.drag.getRunCount(count - 1)).toBeGreaterThan(0)
  await act(async () => {
    // The drag's own pick-up ghost comes from PileView, not from the screen - it isn't counted in mockLog.shown.
    await pile.drag.onDrop(to, count, cardId, mockMakeFlight())
  })
}

const CLUBS_FOUNDATION: PileRef = { zone: 'foundation', index: SUITS.indexOf('clubs') }
const EMPTY_COLUMN: PileRef = { zone: 'tableau', index: 6 }

beforeEach(() => {
  jest.useFakeTimers()
  mockSettings.autoMove = true
  mockPiles.clear()
  mockPileInstance = 0
  mockLog.shown = []
  mockLog.inAir = 0
  mockLog.maxInAir = 0
  mockLog.airAtWinCascade = -1
  mockLog.chainsAtWinCascade = -1
  mockLog.foundationsAtWinCascade = null
  mockLog.events = []
  mockLog.paces = []
  mockUnmeasurableSlots.clear()
  mockRecordWon.mockClear()
  mockDealCalls.length = 0
  mockHoldDeal = false
})
afterEach(async () => {
  await act(async () => {
    await jest.runOnlyPendingTimersAsync()
  })
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('FreeCell screen - the safe-card cascade needs a TAP that went to a foundation', () => {
  it('a resumed board never plays anything by itself, even one full of safe cards', async () => {
    await mount(SAFE_CARDS_BOARD())
    await flush(3000)
    expect(mockLog.shown).toEqual([])
    expect(cardsOnBoard()).toBe(52)
  })

  it('tapping a card that goes to a foundation starts the follow-up auto-play of the safe cards', async () => {
    await mount(SAFE_CARDS_BOARD())

    await tap(id('clubs', 1))
    await flush(3000)

    // The tap itself, then the cascade: the Aces of hearts and spades, then the 2 of hearts (which needs both black
    // foundations at Ace). The 2s of clubs/spades still wait on the Ace of diamonds, which is buried.
    expect(foundationTops()).toEqual({ clubs: id('clubs', 1), diamonds: 'empty', hearts: id('hearts', 2), spades: id('spades', 1) })
    expect(mockLog.shown).toHaveLength(4)
    // The tap flew at the ordinary pace; each follow-up at the (still unhurried) auto-play pace - never the finish's sweep.
    expect(mockLog.paces).toEqual([{ fast: undefined, sweep: undefined }, ...Array.from({ length: 3 }, () => ({ fast: true, sweep: false }))])
  })

  it('every auto-played card is its own undo step, taken back one at a time before the tap that set them off', async () => {
    await mount(SAFE_CARDS_BOARD())
    await tap(id('clubs', 1))
    await flush(3000)
    expect(foundationTops()).toEqual({ clubs: id('clubs', 1), diamonds: 'empty', hearts: id('hearts', 2), spades: id('spades', 1) })

    const undo = async () => {
      const before = mockLog.shown.length
      await act(async () => {
        fireEvent.press(screen.getByTestId('undo'))
      })
      await flush(3000)
      expect(mockLog.shown.length).toBe(before + 1) // one card flies back, and nothing is auto-played again
      expect(mockDealCalls).toHaveLength(0) // not through the old all-at-once cascade undo
    }

    await undo() // the 2 of hearts, the last card auto-played
    expect(foundationTops()).toEqual({ clubs: id('clubs', 1), diamonds: 'empty', hearts: id('hearts', 1), spades: id('spades', 1) })
    await undo() // one of the auto-played Aces...
    await undo() // ...then the other
    expect(foundationTops()).toEqual({ clubs: id('clubs', 1), diamonds: 'empty', hearts: 'empty', spades: 'empty' })
    await undo() // and only then the tap itself
    expect(foundationTops()).toEqual({ clubs: 'empty', diamonds: 'empty', hearts: 'empty', spades: 'empty' })
    expect(cardsOnBoard()).toBe(52)
  })

  it('dragging that same card onto the foundation does NOT start it', async () => {
    await mount(SAFE_CARDS_BOARD())

    await dragTo(id('clubs', 1), CLUBS_FOUNDATION)
    await flush(3000)

    // The drop landed on the foundation, and that is all: no card was sent up after it (the Aces of hearts and spades sit
    // right there, safe, waiting).
    expect(foundationTops()).toEqual({ clubs: id('clubs', 1), diamonds: 'empty', hearts: 'empty', spades: 'empty' })
    expect(mockLog.shown).toEqual([])
  })

  it('a tap that lands on a column (not a foundation) does not start it either', async () => {
    await mount(TWO_DEADLOCKS_BOARD())

    await tap(id('diamonds', 2)) // 2 of diamonds -> onto the black 3 of clubs; the Aces of clubs/spades/diamonds are all safe now
    await flush(3000)

    expect(foundationTops()).toEqual({ clubs: 'empty', diamonds: 'empty', hearts: 'empty', spades: 'empty' })
    expect(mockLog.shown).toHaveLength(1)
  })

  it('does nothing when Auto-Move to Foundation is off', async () => {
    mockSettings.autoMove = false
    await mount(SAFE_CARDS_BOARD())

    await tap(id('clubs', 1))
    await flush(3000)

    expect(foundationTops()).toEqual({ clubs: id('clubs', 1), diamonds: 'empty', hearts: 'empty', spades: 'empty' })
    expect(mockLog.shown).toHaveLength(1)
  })
})

describe('FreeCell screen - once every column is solved the rest finishes itself', () => {
  it('a tap that moves a card to a column (not a foundation) and leaves the board finishable sweeps the whole board up', async () => {
    await mount(ONE_MOVE_FROM_FINISHABLE())
    await flush(3000)
    expect(mockLog.shown).toEqual([]) // finishable-in-one-move is not finishable: nothing happens by itself

    await tap(id('clubs', 2)) // 2 of clubs -> off the Ace, onto an empty column
    expect(cardsOnBoard()).toBe(52) // the tap's own move is not a foundation move...
    expect(foundationTops()).toEqual({ clubs: 'empty', diamonds: 'empty', hearts: 'empty', spades: 'empty' })
    await flush(10000) // ...but it leaves the board finishable

    expect(cardsOnBoard()).toBe(0)
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(screen.getByTestId('fireworks')).toBeTruthy()
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
    expect(mockLog.shown).toHaveLength(1 + 52) // the tap, then every card of the game
    // The tap flew at the ordinary pace; all 52 finish flights are sweep-speed (the fastest spring), not the cascade's pace.
    expect(mockLog.paces).toHaveLength(1 + 52)
    expect(mockLog.paces[0]).toEqual({ fast: undefined, sweep: undefined })
    expect(mockLog.paces.slice(1).every((p) => p.sweep === true && p.fast === false)).toBe(true)
  })

  it('a DRAG that leaves the board finishable does too', async () => {
    await mount(ONE_MOVE_FROM_FINISHABLE())

    await dragTo(id('clubs', 2), EMPTY_COLUMN)
    expect(cardsOnBoard()).toBe(52)
    await flush(10000)

    expect(cardsOnBoard()).toBe(0)
    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(screen.getByTestId('fireworks')).toBeTruthy()
    expect(mockLog.shown).toHaveLength(52) // every card of the game, none of them the drag's own flight
  })

  it('a resumed board that is already finishable is left alone until the player moves', async () => {
    await mount(FINISHABLE())
    await flush(3000)
    expect(mockLog.shown).toEqual([])
    expect(cardsOnBoard()).toBe(52)
  })

  it('the last card waits for the earlier flights to land, so the win cascade does not start over cards still in the air', async () => {
    await mount(ONE_MOVE_FROM_FINISHABLE())

    await tap(id('clubs', 2))
    await flush(10000)

    expect(mockLog.airAtWinCascade).toBeGreaterThanOrEqual(0) // it did start
    expect(mockLog.airAtWinCascade).toBeLessThanOrEqual(1) // at most the winning card's own flight
  })

  it('flights overlap - it does not wait for each card to land before sending the next', async () => {
    await mount(ONE_MOVE_FROM_FINISHABLE())

    await tap(id('clubs', 2))
    await flush(10000)

    expect(mockLog.maxInAir).toBeGreaterThanOrEqual(2)
  })

  it('does not run when Auto-Move to Foundation is off', async () => {
    mockSettings.autoMove = false
    await mount(ONE_MOVE_FROM_FINISHABLE())

    await tap(id('clubs', 2))
    await flush(10000)

    expect(cardsOnBoard()).toBe(52)
    expect(mockLog.shown).toHaveLength(1)
  })

  it('undoing back onto a finishable board does not send its cards up again', async () => {
    await mount(FINISHABLE())

    await tap(id('clubs', 1)) // a foundation tap on a finishable board: the finish sweeps the rest
    await flush(10000)
    expect(cardsOnBoard()).toBe(0)
    const before = mockLog.shown.length

    await act(async () => {
      fireEvent.press(screen.getByTestId('undo'))
    })
    await flush(10000)

    expect(cardsOnBoard()).toBe(1) // the last card the finish played is back...
    expect(mockLog.shown.length).toBe(before + 1) // ...through the undo's own flight only - nothing went up again
  })

  it('a new deal that happens to be finishable is not swept up either', async () => {
    await mount(SAFE_CARDS_BOARD())
    await tap(id('diamonds', 2)) // a player move: the finish is now "allowed"
    await flush(3000)
    const before = mockLog.shown.length
    jest.spyOn(FreeCellController, 'newGame').mockReturnValue(FINISHABLE())

    await act(async () => {
      fireEvent.press(screen.getByTestId('new-game'))
    })
    await flush(10000)

    expect(cardsOnBoard()).toBe(52)
    expect(mockLog.shown.length).toBe(before) // no card of the new deal was auto-played
  })
})

describe('FreeCell screen - the win celebration waits for the winning card to fly in and land', () => {
  it('the winning card flies (not vanishes), and neither the foundations nor the banner change until it has landed and a beat has passed', async () => {
    await mount(ONE_CARD_FROM_WON(), 1)
    expect(foundationTops().clubs).toBe(id('clubs', 12))

    await tap(id('clubs', 13))
    await flush(10) // the move has committed and its ghost is in the air

    expect(mockRecordWon).toHaveBeenCalledTimes(1) // the win is recorded the instant it happens...
    expect(mockLog.shown).toEqual([id('clubs', 13)])
    expect(mockLog.inAir).toBe(1) // ...the winning card really is flying...
    expect(foundationTops().clubs).toBe(id('clubs', 13)) // ...to a foundation that is still showing the whole pile,
    expect(screen.queryByTestId('win-banner')).toBeNull() // with no celebration yet
    expect(screen.queryByTestId('fireworks')).toBeNull()
    expect(mockLog.airAtWinCascade).toBe(-1)

    await flush(80) // the flight lands
    expect(mockLog.inAir).toBe(0)
    expect(foundationTops().clubs).toBe(id('clubs', 13)) // the completed board holds for a beat
    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(screen.queryByTestId('fireworks')).toBeNull()

    await flush(HOLD_MS + 50)
    expect(screen.getByTestId('win-banner')).toBeTruthy() // then the celebration takes over
    expect(screen.getByTestId('fireworks')).toBeTruthy()
    expect(foundationTops().clubs).toBe('empty')
    expect(mockLog.airAtWinCascade).toBe(0) // with nothing left in the air
    expect(mockRecordWon).toHaveBeenCalledTimes(1)
  })

  it('a finish that wins the game does the same for its last card', async () => {
    await mount(ONE_MOVE_FROM_FINISHABLE())

    await tap(id('clubs', 2))
    await flush(10000)

    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(screen.getByTestId('fireworks')).toBeTruthy()
    expect(mockLog.airAtWinCascade).toBe(0) // the win cascade started only once every finish flight, the last card's too, had landed
    expect(mockLog.shown).toHaveLength(1 + 52)
  })

  it('is not withheld by a flight that never lands', async () => {
    await mount(ONE_CARD_FROM_WON(), 1)
    const tapMove = jest.spyOn(mockGhost, 'show').mockImplementation(() => ({ hide: () => {}, flyTo: () => {} }) as never) // its flight never calls back

    await tap(id('clubs', 13))
    await flush(3000)

    expect(screen.getByTestId('win-banner')).toBeTruthy()
    expect(screen.getByTestId('fireworks')).toBeTruthy()
    expect(tapMove).toHaveBeenCalledTimes(1)
  })
})

describe('FreeCell screen - the foundation piles hand over to the win cascade in one commit', () => {
  const settleAndHold = 10 + FLIGHT_MS + HOLD_MS + 100
  const kings = () => SUITS.map((suit) => id(suit, 13))

  it('every pile is still fully drawn when the cascade starts, and they blank in that same step - never a frame of empty piles before the ghosts', async () => {
    await mount(ONE_CARD_FROM_WON(), 1)

    await tap(id('clubs', 13))
    await flushUntil(() => mockLog.events.includes('cascade'))

    // Blanking on the reveal alone emptied all four piles first, and only THEN (after the origin measurement) started the
    // cascade whose ghosts stand in for them - a few empty frames in between.
    expect(mockLog.chainsAtWinCascade).toBe(4)
    expect(mockLog.foundationsAtWinCascade).toEqual(kings())
    // The piles blanked in the commit that follows startChains: already, within the very step it was called in (not on a later timer).
    expect(mockLog.events).toEqual(['cascade', ...SUITS.map((suit) => `blank-${suit}`)])
    expect(Object.values(foundationTops())).toEqual(SUITS.map(() => 'empty'))
    expect(screen.getByTestId('win-banner')).toBeTruthy()
  })

  it('a finish that wins the game hands over the same way, after its last flight', async () => {
    await mount(ONE_MOVE_FROM_FINISHABLE())

    await tap(id('clubs', 2))
    await flushUntil(() => mockLog.events.includes('cascade'), 10000)

    expect(mockLog.chainsAtWinCascade).toBe(4)
    expect(mockLog.foundationsAtWinCascade).toEqual(kings())
    expect(mockLog.events.slice(mockLog.events.indexOf('cascade'))).toEqual(['cascade', ...SUITS.map((suit) => `blank-${suit}`)])
    expect(Object.values(foundationTops())).toEqual(SUITS.map(() => 'empty'))
  })

  it('a pile whose slot cannot be measured keeps its real card (it gets no chain, so nothing would stand in), while the rest hand over', async () => {
    mockUnmeasurableSlots.add('hearts')
    await mount(ONE_CARD_FROM_WON(), 1)

    await tap(id('clubs', 13))
    await flush(settleAndHold)

    expect(mockLog.chainsAtWinCascade).toBe(3)
    expect(mockLog.foundationsAtWinCascade).toEqual(kings())
    expect(mockLog.events).toEqual(['cascade', ...SUITS.filter((suit) => suit !== 'hearts').map((suit) => `blank-${suit}`)])
    expect(foundationTops()).toEqual({ clubs: 'empty', diamonds: 'empty', hearts: id('hearts', 13), spades: 'empty' })
    expect(screen.getByTestId('win-banner')).toBeTruthy()
  })

  it('leaves every pile up when no chain can start, instead of blanking them with nothing to show', async () => {
    SUITS.forEach((suit) => mockUnmeasurableSlots.add(suit))
    await mount(ONE_CARD_FROM_WON(), 1)

    await tap(id('clubs', 13))
    await flush(settleAndHold)

    expect(mockLog.chainsAtWinCascade).toBe(0)
    expect(mockLog.events).toEqual(['cascade'])
    expect(Object.values(foundationTops())).toEqual(kings())
    expect(screen.getByTestId('win-banner')).toBeTruthy()
  })

  it('an undo out of the celebration brings every pile back', async () => {
    await mount(ONE_CARD_FROM_WON(), 1)
    await tap(id('clubs', 13))
    await flush(settleAndHold)
    expect(Object.values(foundationTops())).toEqual(SUITS.map(() => 'empty'))

    await act(async () => {
      fireEvent.press(screen.getByTestId('undo'))
    })
    await flush(1000)

    expect(screen.queryByTestId('win-banner')).toBeNull()
    expect(foundationTops()).toEqual({ clubs: id('clubs', 12), diamonds: id('diamonds', 13), hearts: id('hearts', 13), spades: id('spades', 13) })
  })

  it("a second win in the same mounted screen (after a New Game) hands over on its own - the first win's hand-off never blanks the new piles early", async () => {
    await mount(ONE_CARD_FROM_WON(), 1)
    await tap(id('clubs', 13))
    await flush(settleAndHold)
    expect(mockLog.events).toEqual(['cascade', ...SUITS.map((suit) => `blank-${suit}`)]) // the first win handed over

    // The next deal is one move from won again.
    jest.spyOn(FreeCellController, 'newGame').mockReturnValue(ONE_CARD_FROM_WON())
    await act(async () => {
      fireEvent.press(screen.getByTestId('new-game'))
    })
    await flush(3000)
    expect(cardsOnBoard()).toBe(1)
    expect(foundationTops()).toEqual({ clubs: id('clubs', 12), diamonds: id('diamonds', 13), hearts: id('hearts', 13), spades: id('spades', 13) })
    mockLog.events = []
    mockLog.foundationsAtWinCascade = null

    await tap(id('clubs', 13))
    await flushUntil(() => mockLog.events.includes('cascade'))

    expect(mockLog.foundationsAtWinCascade).toEqual(kings()) // still every real card when the second cascade starts
    expect(mockLog.events).toEqual(['cascade', ...SUITS.map((suit) => `blank-${suit}`)])
  })
})

describe('FreeCell screen - a card never moves without its own flight', () => {
  it('a drop for a card that has since left is refused, instead of moving whatever now sits in its place', async () => {
    await mount(TWO_DEADLOCKS_BOARD())
    const twoOfDiamonds = id('diamonds', 2)
    // The drag of the 2 of diamonds, picked up while it was still on top of the Ace of diamonds...
    const staleDrag = [...mockPiles.values()].find((p) => p.cards.some((c) => c.id === twoOfDiamonds))!.drag
    // ...but the 2 is moved away (a tap sends it onto the black 3) before the drop arrives.
    await tap(twoOfDiamonds)
    await flush(200)
    const shownBefore = mockLog.shown.length

    let applied = true
    await act(async () => {
      applied = await staleDrag.onDrop({ zone: 'tableau', index: 7 }, 1, twoOfDiamonds, mockMakeFlight())
    })
    await flush(200)

    expect(applied).toBe(false) // the Ace of diamonds, now on top of that column, did NOT move to the empty column
    expect(mockLog.shown).toHaveLength(shownBefore)
    const acePile = [...mockPiles.values()].find((p) => p.cards.some((c) => c.id === id('diamonds', 1)))!
    expect(acePile.cards.map((c) => c.id)).toEqual([id('diamonds', 1)])
  })
})

describe('FreeCell finish pacing follows the flight pace', () => {
  // The finish stream (useAutoFinish) sends a card every FINISH_STAGGER_MS while each flies at the sweep tier. It was tuned at scale 1 - 60ms against
  // 40-90ms flights - and must keep overlapping them the same way whatever dragSpring.ts's FLIGHT_TIME_SCALE is, so it derives from the same knob.
  it('the finish stagger keeps the same fraction of a sweep flight at every distance: it is the scale-1 60ms re-paced with the flights', () => {
    expect(FINISH_STAGGER_MS).toBe(scaledMs(60))
    for (const distance of [60, 100, 200, 300, 360, 900]) {
      const scale1Flight = 40 + Math.max(0, Math.min(1, (distance - 60) / 300)) * (90 - 40)
      expect(FINISH_STAGGER_MS / (winSweepSpringFor(distance).duration ?? 0)).toBeCloseTo(60 / scale1Flight, 1)
    }
  })

  it('the stagger is shorter than the shortest sweep flight stays up, so flights still overlap; and above the cascade feedback floor, so each card keeps its tick', () => {
    expect(FINISH_STAGGER_MS).toBeLessThan(springSettleMs(winSweepSpringFor(60)))
    expect(FINISH_STAGGER_MS).toBeGreaterThan(45) // useCascadeFeedback's CASCADE_FEEDBACK_MIN_INTERVAL_MS
  })

  it("the last card's wait comfortably outlasts the slowest sweep flight, and a tap flight that may still be in the air", () => {
    expect(FINISH_LAST_CARD_WAIT_MS).toBeGreaterThanOrEqual(2 * springSettleMs(winSweepSpringFor(Infinity)))
    expect(FINISH_LAST_CARD_WAIT_MS).toBeGreaterThanOrEqual(springSettleMs(AUTO_MOVE_SPRING))
  })
})

describe("FreeCell screen - the deck placeholder leaves with the last card, on the deal layer's own clock", () => {
  const PLACEHOLDER = 'freecell-deck-origin'
  const deckShown = () => screen.queryByTestId(PLACEHOLDER) !== null

  /** A brand-new game (nothing saved), its initial deal held at the start: returns that deal's start() call. */
  async function mountFreshDeal() {
    mockHoldDeal = true
    jest.spyOn(AsyncStorage, 'getItem').mockResolvedValue(null)
    await render(<FreeCellScreen />)
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

  it('flies all 52 cards face-up, paced to ~2s instead of the compressed 1.2s', async () => {
    const call = await mountFreshDeal()
    expect(call.entries).toHaveLength(52)
    expect(call.entries.every((entry) => entry.card.faceUp)).toBe(true)
    const delays = byDelay(call).map((entry) => entry.delayMs)
    expect(delays[0]).toBe(0)
    expect(delays[51] + 280).toBeGreaterThan(1990) // the last card lands ~2000ms after the first leaves
    expect(delays[51] + 280).toBeLessThanOrEqual(2001)
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
      call.onDone()
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
