import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { useEffect } from 'react'
import { StyleSheet, type ViewStyle } from 'react-native'

import { ChainSpec, useWinCascade, WIN_CASCADE_PAINT_MAX_MS, WinCascadeController, WinCascadeGhosts, WinCascadeProvider } from '@/components/winning/WinCascadeLayer'
import { Card, Suit, SUITS } from '@/engine/types'
import KlondikeScreen from '@/games/klondike/KlondikeScreen'
import { KlondikeState } from '@/games/klondike/rules'

import { resetGameInProgress, seedGameInProgress } from '../../testUtils/gameInProgressStore'

// ---------------------------------------------------------------------------------------------------------------------
// The win cascade's take-over from the real piles, against a face that paints LATE. A card face is one React Native <Image>, and its
// bitmap arrives a frame or two after the commit that mounts it (cardFacePaint.ts): a ghost parked on a pile shows a blank face until
// then. So the cascade must stay invisible - and its clock stopped - until every face drawn while parked has painted (WIN_CASCADE_PAINT_MAX_MS
// at most), and the screen hands its piles over (blanks the real cards) only from startChains' onShown, in the commit the ghosts show.
//
// The REAL WinCascadeProvider / WinCascadeGhosts, with Reanimated replaced by a stand-in whose shared values are stable per component,
// whose animated style reads them LIVE, and whose frame callbacks the test fires itself with a chosen timestamp (the same stand-in as
// winCascadeLayer.test.tsx). PlayingCard is a bare View that never paints by itself: the test delivers each face's bitmap (paint()),
// like the native image pipeline does a frame or two after the mount.
//
// The last part runs one REAL game screen (Klondike, with the stand-ins klondikeScreenWin.test.tsx uses for its board) on the real
// cascade: every commit that draws a foundation pile bare must have that pile's King standing in for it - on screen, its face painted.
// ---------------------------------------------------------------------------------------------------------------------

const mockFrames = new Set<{ current: (info: { timestamp: number }) => void }>()

jest.mock('@/redux/store', () => require('../../testUtils/gameInProgressStore').storeModule)
jest.mock('react-native-reanimated', () => {
  const base = jest.requireActual('../../__mocks__/react-native-reanimated')
  const { useEffect: useMockEffect, useRef } = require('react')
  return {
    ...base,
    useSharedValue: <T,>(value: T) => useRef({ value }).current,
    // Live: every read of a style property re-runs the updater, so the style always shows the shared values as of NOW.
    useAnimatedStyle: (updater: () => Record<string, unknown>) => {
      const style: Record<string, unknown> = {}
      Object.keys(updater()).forEach((key) => Object.defineProperty(style, key, { enumerable: true, get: () => updater()[key] }))
      return style
    },
    useFrameCallback: (callback: (info: { timestamp: number }) => void) => {
      const ref = useRef(callback)
      ref.current = callback
      useMockEffect(() => {
        mockFrames.add(ref)
        return () => {
          mockFrames.delete(ref)
        }
      }, [])
    }
  }
})

jest.mock('@tastic/core', () => ({
  ...jest.requireActual('@tastic/core'),
  RotationAwareStatusBar: () => null,
  useRotation: () => 0,
  useRotatedWindowDimensions: () => ({ width: 400, height: 800 }),
  rotateInsets: (insets: unknown) => insets
}))

/** Every mounted card face by id: whether its bitmap has been delivered, and the PlayingCard's latest onFacePainted. */
const mockFaces = new Map<string, { painted: boolean; report?: () => void }>()

jest.mock('@/components/PlayingCard', () => {
  const { View: MockView } = require('react-native')
  const { useLayoutEffect: useMockLayoutEffect } = require('react')
  function MockPlayingCard({ card, onFacePainted }: { card: { id: string }; onFacePainted?: () => void }) {
    // Mounted unpainted; the test delivers the bitmap (paint()), which reports through onFacePainted like a real face's onLoad.
    useMockLayoutEffect(() => {
      const face = mockFaces.get(card.id) ?? { painted: false }
      face.report = onFacePainted
      mockFaces.set(card.id, face)
    }, [card.id, onFacePainted])
    useMockLayoutEffect(() => () => void mockFaces.delete(card.id), [card.id])
    return <MockView testID={`ghost-${card.id}`} />
  }
  return { PlayingCard: MockPlayingCard, EmptySlot: () => <MockView />, FoundationSlot: () => <MockView /> }
})

/** Delivers the bitmaps of `ids` (each mounted face's onLoad). */
async function paint(ids: string[]) {
  await act(async () => {
    ids.forEach((id) => {
      const face = mockFaces.get(id)
      if (!face || face.painted) return
      face.painted = true
      face.report?.()
    })
  })
}

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
}

/** Fires every ghost's frame callback with this frame timestamp (the same clock as performance.now()). */
async function frameAt(timestamp: number) {
  await act(async () => {
    mockFrames.forEach((frame) => frame.current({ timestamp }))
  })
}

/** Drawn on screen: neither the ghost's own wrapper nor anything above it (the whole cascade, before it shows) is at opacity 0. */
const isDrawn = (id: string) => {
  for (let node = screen.getByTestId(`ghost-${id}`).parent; node; node = node.parent) if (StyleSheet.flatten(node.props.style as ViewStyle)?.opacity === 0) return false
  return true
}
const positionOf = (id: string) => {
  const style = StyleSheet.flatten(screen.getByTestId(`ghost-${id}`).parent!.props.style as ViewStyle)
  const [{ translateX }, { translateY }] = style.transform as [{ translateX: number }, { translateY: number }]
  return { x: translateX, y: translateY }
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.spyOn(Math, 'random').mockReturnValue(0.5)
  mockFrames.clear()
  mockFaces.clear()
})
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

// ------------------------------------------------------------------------------------------------ the layer

// Each test starts with no saved games (the store helper is shared across the file).
afterEach(() => resetGameInProgress())

describe('WinCascadeGhosts - shown only once the parked faces have painted', () => {
  const CARD_WIDTH = 64
  const card = (n: number, faceUp = true): Card => ({ id: `c${n}`, suit: 'spades', rank: n, faceUp }) as unknown as Card
  const cards = (from: number, count: number): Card[] => Array.from({ length: count }, (_, i) => card(from + i))
  const ORIGIN_A = { x: 40, y: 300 }
  const ORIGIN_B = { x: 200, y: 320 }
  /** Two chains: A enters at once (its head leaves the moment the clock starts), B one stagger later. */
  const TWO_CHAINS: ChainSpec[] = [
    { cards: cards(1, 3), origin: ORIGIN_A, entranceDelayMs: 0 },
    { cards: cards(11, 3), origin: ORIGIN_B, entranceDelayMs: 220 }
  ]

  let controller: WinCascadeController
  function Capture() {
    const winCascade = useWinCascade()
    useEffect(() => {
      controller = winCascade
    })
    return null
  }

  async function mountLayer() {
    await render(
      <WinCascadeProvider>
        <Capture />
        <WinCascadeGhosts />
      </WinCascadeProvider>
    )
  }
  async function start(chains: ChainSpec[], onShown?: () => void) {
    await act(async () => {
      controller.startChains(chains, CARD_WIDTH, onShown)
    })
  }

  it('keeps every ghost invisible - and the clock stopped - until every parked face has painted, then shows them all and starts the clock there', async () => {
    await mountLayer()
    const onShown = jest.fn()
    await start(TWO_CHAINS, onShown)

    // Mounted and parked where the real cards stand, but not on screen: a parked head drawn now would be a blank face.
    for (const id of ['c1', 'c11']) expect(isDrawn(id)).toBe(false)
    expect(positionOf('c1')).toEqual(ORIGIN_A)
    // Frames keep coming while it waits, and nothing moves: the clock has not started (it used to start at startChains, so a
    // chain entering at once had left its pile before anyone could see it).
    await frameAt(performance.now() + 500)
    expect(positionOf('c1')).toEqual(ORIGIN_A)
    expect(positionOf('c11')).toEqual(ORIGIN_B)

    await paint(['c1']) // one head painted: the cascade still waits for the other
    expect(isDrawn('c1')).toBe(false)
    expect(onShown).not.toHaveBeenCalled()

    await advance(30) // (still well inside WIN_CASCADE_PAINT_MAX_MS)
    const shownAt = performance.now()
    // The followers (c2, c3, c12, c13) never paint here: they are hidden under their heads until the card ahead has left, so the
    // cascade does not wait for them.
    await paint(['c11'])
    expect(isDrawn('c1')).toBe(true)
    expect(isDrawn('c11')).toBe(true)
    expect(onShown).toHaveBeenCalledTimes(1)

    // The clock starts at the moment the cascade showed: the heads leave from where they were seen standing.
    await frameAt(shownAt)
    expect(positionOf('c1')).toEqual(ORIGIN_A)
    await frameAt(shownAt + 100)
    expect(positionOf('c1')).not.toEqual(ORIGIN_A) // chain A is under way...
    expect(positionOf('c11')).toEqual(ORIGIN_B) // ...chain B enters 220ms in
  })

  it('calls onShown once, when the ghosts are already on screen, and before that never', async () => {
    await mountLayer()
    const seen: boolean[] = []
    const onShown = jest.fn(() => seen.push(isDrawn('c1') && isDrawn('c11')))
    await start(TWO_CHAINS, onShown)
    await paint(['c1', 'c11'])
    await advance(1000)
    await paint(['c2', 'c3', 'c12', 'c13'])
    expect(onShown).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([true]) // a screen blanking its piles from here never shows a frame with neither
  })

  it('waits for every card that stands in a spot of its own (cardOrigins), not just the head', async () => {
    await mountLayer()
    const onShown = jest.fn()
    const FAN = [
      { x: 40, y: 500 },
      { x: 40, y: 478 },
      { x: 40, y: 456 }
    ]
    await start([{ cards: cards(1, 3), origin: FAN[2], cardOrigins: FAN, entranceDelayMs: 0 }], onShown)

    await paint(['c1'])
    expect(isDrawn('c1')).toBe(false) // c2 and c3 are on screen while parked too, and still blank
    await paint(['c2', 'c3'])
    expect(['c1', 'c2', 'c3'].map(isDrawn)).toEqual([true, true, true])
    expect(onShown).toHaveBeenCalledTimes(1)
  })

  it('does not wait for a face-down card: a back is drawn in the frame it mounts', async () => {
    await mountLayer()
    const onShown = jest.fn()
    await start([{ cards: [card(1, false), card(2)], origin: ORIGIN_A, entranceDelayMs: 0 }], onShown)

    expect(isDrawn('c1')).toBe(true)
    expect(onShown).toHaveBeenCalledTimes(1)
  })

  it(`shows them anyway WIN_CASCADE_PAINT_MAX_MS (${WIN_CASCADE_PAINT_MAX_MS}ms) after they mounted if a face never reports, and starts the clock then`, async () => {
    await mountLayer()
    const onShown = jest.fn()
    await start(TWO_CHAINS, onShown)

    await advance(WIN_CASCADE_PAINT_MAX_MS - 1)
    expect(isDrawn('c1')).toBe(false)
    expect(onShown).not.toHaveBeenCalled()

    await advance(1)
    const shownAt = performance.now()
    expect(isDrawn('c1')).toBe(true)
    expect(isDrawn('c11')).toBe(true)
    expect(onShown).toHaveBeenCalledTimes(1)
    await frameAt(shownAt)
    expect(positionOf('c1')).toEqual(ORIGIN_A)
    await frameAt(shownAt + 100)
    expect(positionOf('c1')).not.toEqual(ORIGIN_A)
  })

  it('never calls onShown for a cascade cleared before it showed', async () => {
    await mountLayer()
    const onShown = jest.fn()
    await start(TWO_CHAINS, onShown)

    await act(async () => {
      controller.clear()
    })
    await paint(['c1', 'c11'])
    await advance(WIN_CASCADE_PAINT_MAX_MS * 3)

    expect(onShown).not.toHaveBeenCalled()
    expect(screen.queryAllByTestId(/^ghost-/)).toHaveLength(0)
  })

  it("never calls a replaced cascade's onShown: a newer startChains drops it, even with the same cards", async () => {
    await mountLayer()
    const first = jest.fn()
    const second = jest.fn()
    await start(TWO_CHAINS, first)
    // A fresh win's cascade - the same card ids (they are reused across deals) from new spots - before the first one showed.
    await start([{ cards: cards(1, 3), origin: ORIGIN_B, entranceDelayMs: 0 }], second)

    await paint(['c1'])
    expect(isDrawn('c1')).toBe(true)
    expect(positionOf('c1')).toEqual(ORIGIN_B)
    await advance(WIN_CASCADE_PAINT_MAX_MS * 3)

    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('never calls onShown for an empty cascade: there is nothing to hand over to', async () => {
    await mountLayer()
    const onShown = jest.fn()
    await start([], onShown)
    await advance(WIN_CASCADE_PAINT_MAX_MS * 3)

    expect(onShown).not.toHaveBeenCalled()
  })
})

// ------------------------------------------------------------------------------------------------ a real screen

const FLIGHT_MS = 80
const HOLD_MS = 400 // useWinReveal's WIN_REVEAL_HOLD_MS

/** Per commit that drew a foundation pile bare (no real card): whether its King's ghost was on screen, and painted, right then. */
const mockBlankCommits: { suit: string; ghostDrawn: boolean; ghostPainted: boolean }[] = []
const mockKingId = (suit: string) => `${suit}-13-0`
/** Read from inside the foundation stand-in, at its commit - hence hoisted-mock naming. */
function mockGhostOnScreen(id: string): boolean {
  const ghost = screen.queryByTestId(`ghost-${id}`)
  if (!ghost) return false
  for (let node = ghost.parent; node; node = node.parent) if (StyleSheet.flatten(node.props.style as ViewStyle)?.opacity === 0) return false
  return true
}

function mockMakeFlight() {
  return {
    hide: () => {},
    flyTo: (_x: number, _y: number, onDone?: () => void) => {
      setTimeout(() => onDone?.(), FLIGHT_MS)
    }
  }
}
const mockRegistered = new Set<string>()
const mockGhost = {
  cardRegistry: { register: () => {}, unregister: () => {}, measure: async (cardId: string) => (mockRegistered.has(cardId) ? { x: 10, y: 10, width: 40, height: 56 } : null) },
  show: () => mockMakeFlight()
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
function MockRegister({ cardId }: { cardId: string | undefined }) {
  useEffect(() => {
    if (!cardId) return
    mockRegistered.add(cardId)
    return () => void mockRegistered.delete(cardId)
  }, [cardId])
  return null
}

jest.mock('@/components/dragdrop/DragGhostLayer', () => ({ DragGhostProvider: ({ children }: { children: unknown }) => children, useDragGhost: () => mockGhost }))
jest.mock('@/components/dealing/DealLayer', () => ({ DealProvider: ({ children }: { children: unknown }) => children, useDealAnimator: () => mockDeal }))
jest.mock('@/components/dealing/measureView', () => ({ measureView: async () => ({ x: 5, y: 5 }) }))
jest.mock('@/components/useCardSounds', () => ({ useCardSoundEffects: () => ({ playCardSound: () => {}, playInvalidSound: () => {}, hapticCard: () => {}, hapticInvalid: () => {} }) }))
jest.mock('@rific/feedback-press', () => ({ useVibration: () => ({ short: () => {}, selection: () => {} }) }))
jest.mock('@rific/toaster', () => ({ useToast: () => ({ info: () => {} }) }))
jest.mock('@tastic/animations/fireworks', () => ({ Fireworks: () => null }))
jest.mock('@/games/shared/WinBanner', () => {
  const { Text: MockText } = require('react-native')
  return { WinBanner: () => <MockText testID='win-banner'>won</MockText> }
})
jest.mock('@/stores/gameStats', () => ({ useGameStats: () => ({ recordDealWon: () => {}, recordDealAbandoned: () => {}, recordHintUsed: () => {} }) }))
jest.mock('@/stores/lastActiveGame', () => ({ useLastActiveGame: () => ({ setLastActiveGame: () => {}, clearLastActiveGame: () => {} }) }))
jest.mock('@/hooks/useSettings', () => {
  const actual = jest.requireActual('@/redux/settingsSlice')
  return { useSettings: () => ({ settings: actual.DEFAULT_SETTINGS }) }
})
jest.mock('@/components/theme', () => {
  const actual = jest.requireActual('@/components/theme')
  return { ...actual, useTableColors: () => actual.lightColors }
})
// The real cell draws its top card (or nothing, once the cascade has taken over). This one records, in the commit it is drawn
// bare, whether the ghost standing in for its King is on screen with its face painted at that very commit.
jest.mock('@/games/shared/FoundationCell', () => {
  const { Text: MockText, View: MockView } = require('react-native')
  const { useLayoutEffect: useMockLayoutEffect } = require('react')
  function MockFoundationCell({ card, suit, slotRef }: { card?: { id: string }; suit: string; slotRef?: (el: { suit: string } | null) => void }) {
    useMockLayoutEffect(() => {
      slotRef?.({ suit })
      return () => slotRef?.(null)
    }, [slotRef, suit])
    useMockLayoutEffect(() => {
      if (card) return
      const king = mockKingId(suit)
      mockBlankCommits.push({ suit, ghostDrawn: mockGhostOnScreen(king), ghostPainted: !!mockFaces.get(king)?.painted })
    }, [card, suit])
    return (
      <MockView>
        <MockRegister cardId={card?.id} />
        <MockText testID={`foundation-${suit}`}>{card ? card.id : 'empty'}</MockText>
      </MockView>
    )
  }
  return { FoundationCell: MockFoundationCell }
})
jest.mock('@/components/StockWaste', () => ({ StockWaste: () => null }))
jest.mock('@/components/PileView', () => {
  const { Pressable: MockPressable, View: MockView } = require('react-native')
  return {
    PileView: (props: { cards: Card[]; onPressCard: (card: Card, indexFromTop: number, measure: () => Promise<{ x: number; y: number }>) => void }) => (
      <MockView>
        {props.cards.map((c, i) => (
          <MockPressable key={c.id} testID={`card-${c.id}`} onPress={() => props.onPressCard(c, props.cards.length - 1 - i, async () => ({ x: 10, y: 10 }))}>
            <MockRegister cardId={c.id} />
          </MockPressable>
        ))}
      </MockView>
    )
  }
})
jest.mock('@/components/GameChrome', () => {
  const { Pressable: MockPressable, View: MockView } = require('react-native')
  return {
    GAME_CONTENT_PADDING: 6,
    GameChrome: ({ children, onUndo }: { children: unknown; onUndo: () => void }) => (
      <MockView>
        <MockPressable testID='undo' onPress={onUndo} />
        {children}
      </MockView>
    )
  }
})

describe('a game screen hands its piles over to the real cascade only once the ghosts standing in for them are on screen', () => {
  const card = (suit: Suit, rank: number): Card => ({ id: `${suit}-${rank}-0`, suit, rank, faceUp: true }) as Card
  /** Every card home except the King of clubs, alone in a column: tapping it wins. */
  const KING_IN_COLUMN = (): KlondikeState => ({
    tableau: Array.from({ length: 7 }, (_, i) => (i === 0 ? [card('clubs', 13)] : [])),
    foundation: SUITS.map((suit) => Array.from({ length: suit === 'clubs' ? 12 : 13 }, (_, i) => card(suit, i + 1))),
    stock: [],
    waste: []
  })
  const kings = () => SUITS.map((suit) => mockKingId(suit))
  const foundationTops = () => SUITS.map((suit) => screen.getByTestId(`foundation-${suit}`).props.children as string)

  async function mountWinnable() {
    seedGameInProgress('klondike', { state: KING_IN_COLUMN(), undoStack: [], moves: 0, elapsedSeconds: 0, config: 1 })
    await render(<KlondikeScreen />)
    await advance(0) // loadGameInProgress -> restoreGame
    mockBlankCommits.length = 0
  }
  /** Wins, lets the King land and the finished board hold its beat: the cascade has started, its ghosts mounted. */
  async function winUntilCascadeStarts() {
    await act(async () => {
      fireEvent.press(screen.getByTestId(`card-${mockKingId('clubs')}`))
    })
    for (let t = 0; t < FLIGHT_MS + HOLD_MS + 100 && !screen.queryByTestId(`ghost-${mockKingId('clubs')}`); t += 10) await advance(10)
    expect(screen.queryByTestId(`ghost-${mockKingId('clubs')}`)).not.toBeNull()
  }

  it('keeps every real King drawn while the ghosts paint, and blanks a pile only in a commit where its ghost is on screen with its face painted', async () => {
    await mountWinnable()
    await winUntilCascadeStarts()

    // The four chains' ghosts are mounted, parked on the four piles - and invisible, their faces still loading. The real
    // Kings stay drawn meanwhile: blanking them here (in the commit that mounts the ghosts) was a blank card on every pile.
    for (const king of kings()) expect(mockGhostOnScreen(king)).toBe(false)
    expect(foundationTops()).toEqual(kings())
    expect(screen.getByTestId('win-banner')).toBeTruthy()

    await paint(kings().slice(0, 3))
    expect(foundationTops()).toEqual(kings()) // one head still loading: still nobody hands over
    await paint([mockKingId(SUITS[3])])

    for (const king of kings()) expect(mockGhostOnScreen(king)).toBe(true)
    expect(foundationTops()).toEqual(SUITS.map(() => 'empty'))
    // Every pile went bare exactly once, and in that commit its King's ghost already stood there, painted.
    expect(mockBlankCommits.map((c) => c.suit).sort()).toEqual([...SUITS].sort())
    expect(mockBlankCommits.filter((c) => !c.ghostDrawn || !c.ghostPainted)).toEqual([])
  })

  it('still hands over if a face never reports - WIN_CASCADE_PAINT_MAX_MS after the ghosts mounted - and never with the ghosts off screen', async () => {
    await mountWinnable()
    await winUntilCascadeStarts()

    await advance(WIN_CASCADE_PAINT_MAX_MS)

    expect(foundationTops()).toEqual(SUITS.map(() => 'empty'))
    expect(mockBlankCommits.filter((c) => !c.ghostDrawn)).toEqual([])
  })

  it('an undo while the ghosts are still painting keeps every pile up: the cleared cascade never hands over', async () => {
    await mountWinnable()
    await winUntilCascadeStarts()

    await act(async () => {
      fireEvent.press(screen.getByTestId('undo'))
    })
    await paint(kings())
    await advance(1000)

    expect(screen.queryAllByTestId(/^ghost-/)).toHaveLength(0)
    expect(foundationTops()).toEqual(SUITS.map((suit) => (suit === 'clubs' ? 'clubs-12-0' : mockKingId(suit)))) // the King flew home
    expect(mockBlankCommits).toEqual([])
  })
})
