import { CardSizeProvider } from '@tastic/cards'
import { act, render, screen } from '@testing-library/react-native'
import { ReactElement } from 'react'

import { isAnyFaceLoading, markGhostPending, REVEAL_MAX_MS } from '@/components/cardFacePaint'
import { StockWaste } from '@/components/StockWaste'
import type { Card } from '@/engine/types'
import { ReserveCell } from '@/games/canfield/CanfieldScreen'
import { FreecellCell } from '@/games/freecell/FreeCellScreen'
import { DiscardCell } from '@/games/shared/DiscardCell'
import { FoundationCell } from '@/games/shared/FoundationCell'

// ---------------------------------------------------------------------------------------------------------------------
// The single-card piles' side of the take-off hold (cardFacePaint.ts, useTakeOffHold): the waste top and the stock
// (StockWaste), a foundation (FoundationCell), the discard (DiscardCell), a freecell (FreecellCell) and Canfield's reserve
// (ReserveCell), each with the REAL DraggableCard where it has one. A ghost is a fresh Image, invisible until its face has
// painted; while it is, the pile keeps drawing the card that just left - the same, already painted instance - inert, and
// registering the pile's real top so a flight measuring that card finds it. "Taking off" here is markGhostPending, the
// ghost "showing" its release. Then, when the pile still has a card, the slot's one face Image has just been re-sourced
// from the departed card to it (on iOS it keeps the departed card's bitmap until the new one arrives), so the slot keeps
// the real card hidden and shows its PileOverlay - painted, showing the pile's card since the move's commit - until the
// new face reports painted, or REVEAL_MAX_MS.
//
// Stand-ins: PlayingCard reports its face loading the way the real CardFaceImage does (from a layout effect of the commit
// that mounts or re-sources it, until paint(id)); stable Reanimated values (the repo-wide mock hands back new ones every
// render) with a counter on the shake's withSequence; a gesture stub that records whether the drag is enabled.
// ---------------------------------------------------------------------------------------------------------------------

/** Face loads still open (card id + its done()), and a counter that numbers every card instance mounted. */
const mockFaces = { open: [] as { id: string; done: () => void }[], instances: 0 }
const mockGhost = { cardRegistry: { register: jest.fn(), unregister: jest.fn() }, showLive: jest.fn() }
/** One entry per Gesture.Pan() built: whether the last render enabled it. */
const mockPans: { enabled?: boolean }[] = []
// Every playShake() is one withSequence() call, so counting those counts the shakes actually played.
const mockWithSequence = jest.fn((...steps: unknown[]) => steps[steps.length - 1])

jest.mock('react-native-reanimated', () => {
  const { useRef } = require('react')
  const base = jest.requireActual('../../__mocks__/react-native-reanimated')
  return {
    ...base,
    withSequence: (...steps: unknown[]) => mockWithSequence(...steps),
    useSharedValue: (initial: unknown) => useRef({ value: initial }).current,
    useAnimatedRef: () => useRef({ current: null }).current
  }
})
jest.mock('react-native-gesture-handler', () => {
  const pan = () => {
    const record: { enabled?: boolean } = {}
    mockPans.push(record)
    const g: Record<string, unknown> = {}
    for (const method of ['minDistance', 'onStart', 'onUpdate', 'onEnd']) g[method] = () => g
    g.enabled = (on: boolean) => {
      record.enabled = on
      return g
    }
    return g
  }
  return { Gesture: { Pan: pan }, GestureDetector: ({ children }: { children: unknown }) => children }
})
jest.mock('@/components/PlayingCard', () => {
  const { View: MockView } = require('react-native')
  const { useLayoutEffect: useMockLayoutEffect, useState: useMockState } = require('react')
  const { trackFaceLoad: mockTrackFaceLoad } = require('@/components/cardFacePaint')
  function MockPlayingCard({ card, disabled, hinted, selected, onPress, style, testID }: { card: { id: string; faceUp: boolean }; disabled?: boolean; hinted?: boolean; selected?: boolean; onPress?: () => void; style?: unknown; testID?: string }) {
    // Which mounted instance this is, so a test can tell the SAME instance drawing a held card from a remount.
    const [instance] = useMockState(() => ++mockFaces.instances)
    // Like CardFaceImage: a face-up card's bitmap loads from the commit it is mounted or re-sourced in.
    useMockLayoutEffect(() => {
      if (!card.faceUp) return
      const done = mockTrackFaceLoad(card.id)
      mockFaces.open.push({ id: card.id, done })
      return done
    }, [card.id, card.faceUp])
    return <MockView testID={testID} accessibilityLabel={`card ${card.id}`} style={style} cardState={{ disabled: !!disabled, hinted: !!hinted, selected: !!selected, instance }} onPress={onPress} />
  }
  const MockEmpty = ({ testID }: { testID?: string }) => <MockView testID={testID ?? 'empty-slot'} />
  return { PlayingCard: MockPlayingCard, EmptySlot: MockEmpty, FoundationSlot: () => <MockView testID='empty-slot' /> }
})
jest.mock('@/components/dragdrop/DragGhostLayer', () => ({ useDragGhost: () => mockGhost }))
jest.mock('@/components/useCardSounds', () => ({ useCardSoundEffects: () => ({ playCardSound: () => {}, playInvalidSound: () => {}, hapticCard: () => {}, hapticInvalid: () => {} }) }))
jest.mock('@/components/theme', () => {
  const actual = jest.requireActual('@/components/theme')
  return { ...actual, useTableColors: () => actual.lightColors }
})
// Only imported because FreecellCell / ReserveCell live in their screens' modules.
jest.mock('@tastic/animations/fireworks', () => ({ Fireworks: () => null }))

const card = (rank: number, suit = 'hearts', faceUp = true): Card => ({ id: `${suit}-${rank}-0`, suit, rank, faceUp }) as Card
const X = card(9) // the card that takes off
const W = card(7, 'clubs') // the card under it

// The registries are module-level: every mark and every open face load a test makes is closed after it, pass or fail.
const marks: (() => void)[] = []
function takeOff(id: string) {
  const release = markGhostPending([id])
  marks.push(release)
  return release
}
/** Reports every open load of `id` painted (the face Image's onLoad). */
async function paint(id: string) {
  await act(async () => {
    mockFaces.open.filter((f) => f.id === id).forEach((f) => f.done())
  })
}
beforeEach(() => {
  mockPans.length = 0
  mockWithSequence.mockClear()
  mockGhost.cardRegistry.register.mockClear()
  mockGhost.cardRegistry.unregister.mockClear()
})
afterEach(() => {
  marks.splice(0).forEach((release) => release())
  mockFaces.open.splice(0).forEach((f) => f.done())
  jest.useRealTimers()
})

type Node = ReturnType<typeof screen.getByLabelText>
const styleOf = (n: Node) => Object.assign({}, ...([n.props.style].flat(Infinity) as object[]).filter(Boolean)) as { opacity?: number }
/** Whether `node` is drawn: neither it nor anything above it is at opacity 0. */
function drawn(node: Node | undefined): boolean {
  if (!node) return false
  for (let n: Node | null = node; n; n = n.parent) if (styleOf(n).opacity === 0) return false
  return true
}
/** Inside a pile's PileOverlay - the one layer carrying aria-hidden. */
function inOverlay(node: Node): boolean {
  for (let n: Node | null = node; n; n = n.parent) if (n.props['aria-hidden'] !== undefined) return true
  return false
}
const cardsOf = (c: Card) => screen.queryAllByLabelText(`card ${c.id}`, { includeHiddenElements: true })
/** The pile's own card (not its overlay's copy). */
const real = (c: Card) => cardsOf(c).find((n) => !inOverlay(n))
const overlay = (c: Card) => cardsOf(c).find(inOverlay)
const stateOf = (c: Card) => real(c)!.props.cardState as { disabled: boolean; hinted: boolean; selected: boolean; instance: number }
const lastPanEnabled = () => mockPans[mockPans.length - 1].enabled
const registered = () => mockGhost.cardRegistry.register.mock.calls.map(([id]) => id as string)

const sized = (el: ReactElement) => <CardSizeProvider width={64}>{el}</CardSizeProvider>

/**
 * The reveal every slot with a card left under a take-off shares: X held, then released with W under it. The overlay has
 * shown W since the move's commit (and painted it); the real card's Image is re-sourced to W in the release's commit.
 */
async function expectRevealAfterHold(rerenderWithNext: () => Promise<void>, release: () => void) {
  await rerenderWithNext()
  expect(drawn(real(X))).toBe(true) // still the held card
  await paint(W.id) // the overlay's copy of W, loading since the move's commit, has painted
  await act(async () => release())

  // The real card now shows W - re-sourced, still loading - so it stays hidden behind the overlay's painted W.
  expect(real(X)).toBeUndefined()
  expect(isAnyFaceLoading([W.id])).toBe(true)
  expect(drawn(real(W))).toBe(false)
  expect(drawn(overlay(W))).toBe(true)
  await paint(W.id)
  expect(drawn(real(W))).toBe(true)
  expect(drawn(overlay(W))).toBe(false)
}

/** A reveal whose face never reports is let go after REVEAL_MAX_MS. */
async function expectRevealCapped(rerenderWithNext: () => Promise<void>, release: () => void) {
  jest.useFakeTimers()
  await rerenderWithNext()
  await act(async () => release())
  expect(drawn(real(W))).toBe(false)
  expect(drawn(overlay(W))).toBe(true)
  await act(async () => {
    await jest.advanceTimersByTimeAsync(REVEAL_MAX_MS - 1)
  })
  expect(drawn(real(W))).toBe(false)
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1)
  })
  expect(drawn(real(W))).toBe(true)
  expect(drawn(overlay(W))).toBe(false)
}

// ------------------------------------------------------------------------------------------------ StockWaste

const dropZones = { register: jest.fn(), unregister: jest.fn(), hitTest: jest.fn() } as never
const onWastePress = jest.fn()
const onDrawStock = jest.fn()
function stockWaste(props: Partial<React.ComponentProps<typeof StockWaste>>) {
  return sized(<StockWaste dropZones={dropZones} stockTopCard={undefined} wasteTop={X} onDrawStock={onDrawStock} onWastePress={onWastePress} onWasteDrop={() => false} {...props} />)
}

describe('StockWaste - the waste top', () => {
  beforeEach(() => onWastePress.mockClear())

  it('keeps drawing a card that just left - the same instance - inert: no drag, no hint, no shake, registering the real top', async () => {
    const r = await render(stockWaste({ wasteTop: X, wasteHinted: true }))
    const before = stateOf(X).instance
    expect(lastPanEnabled()).toBe(true)
    takeOff(X.id)
    await r.rerender(stockWaste({ wasteTop: W, wasteHinted: true, wasteShakeToken: 5 }))
    expect(drawn(real(X))).toBe(true)
    expect(stateOf(X).instance).toBe(before) // the same instance, never remounted
    expect(real(W)).toBeUndefined()
    expect(lastPanEnabled()).toBe(false) // a card that has left can never be picked up
    expect(stateOf(X).hinted).toBe(false)
    expect(mockWithSequence).not.toHaveBeenCalled()
    expect(registered()).toContain(W.id) // a flight measuring the real top finds it here
    expect(drawn(overlay(W))).toBe(false)
  })

  it('takes no tap on the held card, even with a card under it (it still looks like the card that left), until its ghost shows', async () => {
    const r = await render(stockWaste({ wasteTop: X }))
    const release = takeOff(X.id)
    await r.rerender(stockWaste({ wasteTop: W }))
    // Passing it on to W would send a card never seen here, and drawn nowhere until its own ghost painted.
    expect(stateOf(X).disabled).toBe(true)
    expect(real(X)!.props.onPress).toBeUndefined()
    expect(lastPanEnabled()).toBe(false)
    await act(async () => release())
    await act(async () => real(W)!.props.onPress())
    expect(onWastePress).toHaveBeenCalledTimes(1)
  })

  it('a card taking off again mid-reveal is held, and the overlay moves on to the next card at once - so the reveal at that hold end has a copy loaded all through it', async () => {
    const V = card(5, 'diamonds')
    const r = await render(stockWaste({ wasteTop: X }))
    const releaseX = takeOff(X.id)
    await r.rerender(stockWaste({ wasteTop: W }))
    await paint(W.id) // the overlay's copy of W
    await act(async () => releaseX())
    expect(drawn(overlay(W))).toBe(true) // revealing W: the real card's re-sourced W is still loading
    // An auto-play takes W before the real card's W has painted.
    const releaseW = takeOff(W.id)
    await r.rerender(stockWaste({ wasteTop: V }))
    // Held by the real card (useTakeOffHold's known residual: its Image may still be on the bitmap before W's)...
    expect(drawn(real(W))).toBe(true)
    // ...while the overlay is already on V, invisibly, loading from this commit on - not pinned to W until the hold ends.
    expect(overlay(W)).toBeUndefined()
    expect(drawn(overlay(V))).toBe(false)
    expect(isAnyFaceLoading([V.id])).toBe(true)
    await paint(V.id) // only the overlay's V is loading yet: it paints during W's hold
    await act(async () => releaseW())
    expect(drawn(real(V))).toBe(false)
    expect(drawn(overlay(V))).toBe(true)
    await paint(V.id)
    expect(drawn(real(V))).toBe(true)
    expect(drawn(overlay(V))).toBe(false)
  })

  it('is not hidden by a draw landing on the waste during the hold - it is the only painted copy of the card that left', async () => {
    const r = await render(stockWaste({ wasteTop: X }))
    takeOff(X.id)
    const D = card(4, 'spades')
    await r.rerender(stockWaste({ wasteTop: D, wasteHiddenCount: 1 }))
    expect(drawn(real(X))).toBe(true)
    expect(screen.queryAllByLabelText(/card /, { includeHiddenElements: true }).filter((n) => inOverlay(n) && drawn(n))).toHaveLength(0)
  })

  it('on release hides the real top behind the overlay until the uncovered card has painted - never the departed bitmap', async () => {
    const r = await render(stockWaste({ wasteTop: X }))
    const release = takeOff(X.id)
    await expectRevealAfterHold(() => r.rerender(stockWaste({ wasteTop: W })), release)
  })

  it('lets the reveal go after REVEAL_MAX_MS if the face never reports', async () => {
    const r = await render(stockWaste({ wasteTop: X }))
    const release = takeOff(X.id)
    await expectRevealCapped(() => r.rerender(stockWaste({ wasteTop: W })), release)
  })

  it('does not reveal anything when the hold ends on an empty waste - the empty slot shows at once', async () => {
    const r = await render(stockWaste({ wasteTop: X }))
    const release = takeOff(X.id)
    await r.rerender(stockWaste({ wasteTop: undefined }))
    await act(async () => release())
    expect(real(X)).toBeUndefined()
    expect(screen.getByTestId('empty-slot')).toBeTruthy()
  })

  it('does not reveal a card that arrives without a hold (a landing, an undo, a deal) - the overlay stays as the flight left it', async () => {
    const r = await render(stockWaste({ wasteTop: X }))
    await r.rerender(stockWaste({ wasteTop: W }))
    expect(drawn(real(W))).toBe(true)
    expect(drawn(overlay(W))).toBe(false)
  })
})

describe('StockWaste - the stock', () => {
  const S1 = card(2, 'diamonds', false)
  const S2 = card(3, 'diamonds', false)

  it('keeps drawing the card a draw took off, still tappable while the stock has cards (the next draw)', async () => {
    const r = await render(stockWaste({ wasteTop: undefined, stockTopCard: S1 }))
    const release = takeOff(S1.id)
    await r.rerender(stockWaste({ wasteTop: undefined, stockTopCard: S2 }))
    expect(drawn(real(S1))).toBe(true)
    expect(real(S2)).toBeUndefined()
    expect(real(S1)!.props.onPress).toBe(onDrawStock)
    await act(async () => release())
    expect(real(S1)).toBeUndefined()
    expect(drawn(real(S2))).toBe(true) // a back is SVG: nothing to reveal
  })

  it('a held last card is not tappable (there is nothing left to draw), and the recycle slot shows once it goes', async () => {
    const r = await render(stockWaste({ wasteTop: undefined, stockTopCard: S1 }))
    const release = takeOff(S1.id)
    await r.rerender(stockWaste({ wasteTop: X, stockTopCard: undefined }))
    expect(drawn(real(S1))).toBe(true)
    expect(real(S1)!.props.onPress).toBeUndefined()
    await act(async () => release())
    expect(real(S1)).toBeUndefined()
  })
})

// ------------------------------------------------------------------------------------------------ FoundationCell

function foundation(props: Partial<React.ComponentProps<typeof FoundationCell>>) {
  return sized(<FoundationCell card={X} isFlyingHere={false} suit='hearts' {...props} />)
}

describe('FoundationCell', () => {
  it('keeps drawing a card an undo took off - the same instance, no hint - and is not hidden by a flight arriving meanwhile', async () => {
    const r = await render(foundation({ card: X, highlighted: true }))
    const before = stateOf(X).instance
    takeOff(X.id)
    await r.rerender(foundation({ card: W, highlighted: true }))
    expect(drawn(real(X))).toBe(true)
    expect(stateOf(X).instance).toBe(before) // the same instance, never remounted
    expect(stateOf(X).hinted).toBe(false)
    expect(registered()).toContain(W.id) // the pile's real top, measurable for a flight landing on it
    await r.rerender(foundation({ card: W, highlighted: true, isFlyingHere: true }))
    expect(drawn(real(X))).toBe(true)
    expect(drawn(overlay(W))).toBe(false)
  })

  it('on release reveals the card under it only once its face has painted', async () => {
    const r = await render(foundation({ card: X }))
    const release = takeOff(X.id)
    await expectRevealAfterHold(() => r.rerender(foundation({ card: W })), release)
  })

  it('lets the reveal go after REVEAL_MAX_MS', async () => {
    const r = await render(foundation({ card: X }))
    const release = takeOff(X.id)
    await expectRevealCapped(() => r.rerender(foundation({ card: W })), release)
  })

  it('shows the empty slot at once when the hold ends on an empty pile', async () => {
    const r = await render(foundation({ card: X }))
    const release = takeOff(X.id)
    await r.rerender(foundation({ card: undefined }))
    expect(drawn(real(X))).toBe(true)
    await act(async () => release())
    expect(real(X)).toBeUndefined()
    expect(screen.getByTestId('empty-slot')).toBeTruthy()
  })

  it('lets its top card be dragged only when the screen offers onDrop (Klondike, Yukon, Canfield) - and never tapped', async () => {
    const onDrop = jest.fn(() => false)
    const r = await render(foundation({ card: X }))
    expect(lastPanEnabled()).toBe(false) // FreeCell, Forty Thieves
    const before = stateOf(X).instance
    await r.rerender(foundation({ card: X, onDrop }))
    expect(lastPanEnabled()).toBe(true)
    expect(stateOf(X).instance).toBe(before) // turning the drag on (or off, once won) never remounts the card
    expect(real(X)!.props.onPress).toBeUndefined()
    expect(registered()).toContain(X.id) // still registered by the cell itself, for flights landing on it
  })

  it('offers no drag while a card is landing on the pile, or while it still draws a card that has left', async () => {
    const onDrop = jest.fn(() => false)
    const r = await render(foundation({ card: X, onDrop }))
    await r.rerender(foundation({ card: W, onDrop, isFlyingHere: true }))
    expect(lastPanEnabled()).toBe(false) // the card under the finger would be the one still in the air
    await r.rerender(foundation({ card: X, onDrop }))
    expect(lastPanEnabled()).toBe(true)
    takeOff(X.id)
    await r.rerender(foundation({ card: W, onDrop }))
    expect(drawn(real(X))).toBe(true)
    expect(lastPanEnabled()).toBe(false)
  })
})

// ------------------------------------------------------------------------------------------------ DiscardCell

const discardRef = { current: null }
function discard(props: Partial<React.ComponentProps<typeof DiscardCell>>) {
  return sized(<DiscardCell card={X} isFlyingHere={false} viewRef={discardRef} {...props} />)
}

describe('DiscardCell', () => {
  it('keeps drawing a card an undo took off - the same instance - and is not hidden by a flight arriving meanwhile', async () => {
    const r = await render(discard({ card: X }))
    const before = stateOf(X).instance
    takeOff(X.id)
    await r.rerender(discard({ card: W }))
    expect(drawn(real(X))).toBe(true)
    expect(stateOf(X).instance).toBe(before) // the same instance, never remounted
    await r.rerender(discard({ card: W, isFlyingHere: true }))
    expect(drawn(real(X))).toBe(true)
    expect(drawn(overlay(W))).toBe(false)
  })

  it('on release reveals the card under it only once its face has painted', async () => {
    const r = await render(discard({ card: X }))
    const release = takeOff(X.id)
    await expectRevealAfterHold(() => r.rerender(discard({ card: W })), release)
  })

  it('lets the reveal go after REVEAL_MAX_MS', async () => {
    const r = await render(discard({ card: X }))
    const release = takeOff(X.id)
    await expectRevealCapped(() => r.rerender(discard({ card: W })), release)
  })
})

// ------------------------------------------------------------------------------------------------ FreecellCell

const onFreecellPress = jest.fn()
function freecell(props: Partial<React.ComponentProps<typeof FreecellCell>>) {
  return sized(<FreecellCell card={X} isFlyingHere={false} onPress={onFreecellPress} onDrop={() => false} {...props} />)
}

describe('FreecellCell', () => {
  it('keeps drawing a card that left - the same instance - inert: disabled, no drag, no hint, no shake, registering nothing', async () => {
    const r = await render(freecell({ card: X, highlighted: true }))
    const before = stateOf(X).instance
    mockGhost.cardRegistry.register.mockClear()
    takeOff(X.id)
    await r.rerender(freecell({ card: undefined, highlighted: true, shakeToken: 3 }))
    expect(drawn(real(X))).toBe(true)
    expect(stateOf(X).instance).toBe(before) // the same instance, never remounted
    expect(stateOf(X).disabled).toBe(true)
    expect(real(X)!.props.onPress).toBeUndefined()
    expect(lastPanEnabled()).toBe(false)
    expect(stateOf(X).hinted).toBe(false)
    expect(mockWithSequence).not.toHaveBeenCalled()
    expect(registered()).toEqual([])
    expect(mockGhost.cardRegistry.unregister).toHaveBeenCalledWith(X.id, expect.anything())
  })

  it('a card sent to the same freecell during the hold does not hide the held card; it is registered, and hidden once the hold ends', async () => {
    const B = card(5, 'spades')
    const r = await render(freecell({ card: X }))
    const release = takeOff(X.id)
    await r.rerender(freecell({ card: undefined }))
    await r.rerender(freecell({ card: B, isFlyingHere: true }))
    expect(drawn(real(X))).toBe(true)
    expect(screen.queryByTestId('empty-slot')).toBeNull() // no overlay over the held card
    expect(registered()).toContain(B.id) // the arriving flight can measure where it lands
    await act(async () => release())
    expect(real(X)).toBeUndefined()
    expect(drawn(real(B))).toBe(false)
    expect(screen.getByTestId('empty-slot')).toBeTruthy() // the frozen (empty) cell, until B lands
  })

  it('shows the empty cell once the hold ends', async () => {
    const r = await render(freecell({ card: X }))
    const release = takeOff(X.id)
    await r.rerender(freecell({ card: undefined }))
    await act(async () => release())
    expect(real(X)).toBeUndefined()
    expect(screen.getByTestId('empty-slot')).toBeTruthy()
  })
})

// ------------------------------------------------------------------------------------------------ ReserveCell

const onReservePress = jest.fn()
function reserve(props: Partial<React.ComponentProps<typeof ReserveCell>>) {
  return sized(<ReserveCell card={X} isFlyingHere={false} onPress={onReservePress} onDrop={() => false} {...props} />)
}

describe('ReserveCell', () => {
  beforeEach(() => onReservePress.mockClear())

  it('keeps drawing a card that left - the same instance - inert: no tap (even with a card under it), drag, hint or shake, registering the real top', async () => {
    const r = await render(reserve({ card: X, highlighted: true }))
    const before = stateOf(X).instance
    const release = takeOff(X.id)
    await r.rerender(reserve({ card: W, highlighted: true, shakeToken: 4 }))
    expect(drawn(real(X))).toBe(true)
    expect(stateOf(X).instance).toBe(before) // the same instance, never remounted
    expect(lastPanEnabled()).toBe(false)
    expect(stateOf(X).hinted).toBe(false)
    expect(mockWithSequence).not.toHaveBeenCalled()
    expect(registered()).toContain(W.id)
    expect(stateOf(X).disabled).toBe(true)
    expect(real(X)!.props.onPress).toBeUndefined()
    await act(async () => release())
    await act(async () => real(W)!.props.onPress())
    expect(onReservePress).toHaveBeenCalledTimes(1)
  })

  it('a held last card is not tappable', async () => {
    const r = await render(reserve({ card: X }))
    takeOff(X.id)
    await r.rerender(reserve({ card: undefined }))
    expect(stateOf(X).disabled).toBe(true)
    expect(real(X)!.props.onPress).toBeUndefined()
  })

  it('is not hidden by a flight arriving during the hold', async () => {
    const r = await render(reserve({ card: X }))
    takeOff(X.id)
    await r.rerender(reserve({ card: W, isFlyingHere: true }))
    expect(drawn(real(X))).toBe(true)
    expect(drawn(overlay(W))).toBe(false)
  })

  it('on release reveals the card under it only once its face has painted', async () => {
    const r = await render(reserve({ card: X }))
    const release = takeOff(X.id)
    await expectRevealAfterHold(() => r.rerender(reserve({ card: W })), release)
  })

  it('lets the reveal go after REVEAL_MAX_MS', async () => {
    const r = await render(reserve({ card: X }))
    const release = takeOff(X.id)
    await expectRevealCapped(() => r.rerender(reserve({ card: W })), release)
  })

  it('never shows a card the deal still hides, reveal or not (card ids repeat across deals)', async () => {
    const r = await render(reserve({ card: X }))
    const release = takeOff(X.id)
    await r.rerender(reserve({ card: W, dealHidden: true }))
    await act(async () => release())
    expect(drawn(real(W))).toBe(false)
    expect(drawn(overlay(W))).toBe(false)
  })
})
