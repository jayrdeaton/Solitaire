import { CardSizeProvider } from '@tastic/cards'
import { render, screen } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'
import type { SharedValue } from 'react-native-reanimated'

import { DIM_FADE_MS, fadeInDimScrim } from '@/components/dimScrimAnimation'
import { PileView } from '@/components/PileView'
import { PlayingCard } from '@/components/PlayingCard'
import type { Card } from '@/engine/types'

// Every dim scrim in the tree is found by this sentinel fill (the real one is a translucent black).
const SCRIM_COLOR = '#123456'

const mockTiming = jest.fn((toValue: number, config: { duration: number }) => ({ __timing: true, toValue, config }))
// `sharedValues` counts shared values CREATED (one per mount, however often the component re-renders): the scrim of a card
// that was never held must not allocate one.
const mockCounters = { sharedValues: 0 }
const mockGhost = { cardRegistry: { register: jest.fn(), unregister: jest.fn() }, showLive: jest.fn() }

// The repo-wide Reanimated mock hands back a NEW shared value every render (and its withTiming is a passthrough). A
// scrim's fade can only be seen across renders, so use stable values instead - and model an animation that has already
// finished: reading a value that was assigned a timing gives its target, while `mockTiming` records what was requested.
jest.mock('react-native-reanimated', () => {
  const { useRef } = require('react')
  const base = jest.requireActual('../../__mocks__/react-native-reanimated')
  class Shared {
    raw: unknown
    constructor(initial: unknown) {
      this.raw = initial
    }
    get value() {
      const raw = this.raw as { __timing?: boolean; toValue?: number }
      return raw && typeof raw === 'object' && raw.__timing ? raw.toValue : this.raw
    }
    set value(next: unknown) {
      this.raw = next
    }
  }
  return {
    ...base,
    withTiming: (...args: [number, { duration: number }]) => mockTiming(...args),
    useSharedValue: (initial: unknown) => {
      const ref = useRef(null as Shared | null)
      if (!ref.current) {
        ref.current = new Shared(initial)
        mockCounters.sharedValues++
      }
      return ref.current
    },
    useAnimatedRef: () => useRef({ current: null }).current
  }
})
jest.mock('react-native-gesture-handler', () => {
  const pan = () => {
    const g: Record<string, unknown> = {}
    for (const method of ['minDistance', 'onStart', 'onUpdate', 'onEnd', 'enabled']) g[method] = () => g
    return g
  }
  return { Gesture: { Pan: pan }, GestureDetector: ({ children }: { children: unknown }) => children }
})
jest.mock('@/components/dragdrop/DragGhostLayer', () => ({ useDragGhost: () => mockGhost }))
jest.mock('@/components/useCardSounds', () => ({ useCardSoundEffects: () => ({ playCardSound: jest.fn() }) }))
jest.mock('@/stores/profiles', () => ({ useProfiles: () => ({ activeProfile: null, tableColorOverride: undefined }) }))
jest.mock('@/stores/settings', () => {
  const actual = jest.requireActual('@/stores/settings')
  const value = { settings: { ...actual.DEFAULT_SETTINGS } }
  return { ...actual, useSettings: () => value }
})
jest.mock('@/components/theme', () => {
  const actual = jest.requireActual('@/components/theme')
  // A stable object: PlayingCard's style sheets are cached per colors reference.
  const colors = { ...actual.lightColors, dimOverlay: '#123456', dimOverlayInverted: '#123456' }
  return { ...actual, useTableColors: () => colors }
})
// The card art is irrelevant here (and heavy) - only the scrim over it is under test.
jest.mock('@tastic/cards', () => {
  const { View } = require('react-native')
  const actual = jest.requireActual('@tastic/cards')
  return { ...actual, CardFace: () => <View />, CardBack: () => <View />, DecoratedCardBack: () => <View /> }
})

type Json = { type: string; props: { style?: unknown; testID?: string }; children?: (Json | string)[] | null }

function walk(node: Json | Json[] | null, out: Json[] = []): Json[] {
  if (!node) return out
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, out))
    return out
  }
  out.push(node)
  ;(node.children ?? []).forEach((child) => typeof child !== 'string' && walk(child, out))
  return out
}

const styleOf = (node: Json) => StyleSheet.flatten(node.props.style as never) as { backgroundColor?: string; opacity?: number }
/** Every dim scrim currently drawn. */
const scrims = () => walk(screen.toJSON() as Json | Json[] | null).filter((node) => styleOf(node)?.backgroundColor === SCRIM_COLOR)
/** The scrim's animated opacity: a number when it is the animated one, undefined for today's plain (fully opaque) scrim. */
const scrimOpacity = () => styleOf(scrims()[0]).opacity

const card = (faceUp = true): Card => ({ id: 'spades-9-0', suit: 'spades', rank: 9, faceUp }) as Card

function playing(props: Partial<React.ComponentProps<typeof PlayingCard>> = {}) {
  return (
    <CardSizeProvider width={64}>
      <PlayingCard card={card()} {...props} />
    </CardSizeProvider>
  )
}

beforeEach(() => {
  mockTiming.mockClear()
  mockCounters.sharedValues = 0
})

describe('fadeInDimScrim', () => {
  it('ramps the scrim to fully dim over DIM_FADE_MS', () => {
    const opacity = { value: 0 } as SharedValue<number>

    fadeInDimScrim(opacity)

    expect(mockTiming).toHaveBeenCalledWith(1, { duration: DIM_FADE_MS })
    expect(opacity.value).toMatchObject({ __timing: true, toValue: 1 })
  })

  it('is shorter than the 270ms a following card takes to cover this one', () => {
    expect(DIM_FADE_MS).toBeLessThan(270)
  })
})

describe('PlayingCard dim scrim hand-off', () => {
  it('without dimHold draws the plain scrim: opaque at once, no animation state at all', async () => {
    const { rerender } = await render(playing({ dimmed: true }))

    expect(scrims()).toHaveLength(1)
    expect(scrimOpacity()).toBeUndefined()
    expect(mockCounters.sharedValues).toBe(0)

    await rerender(playing({ dimmed: true }))
    expect(scrimOpacity()).toBeUndefined()
    expect(mockCounters.sharedValues).toBe(0)
  })

  it('held (dimHold true) draws no scrim at all - the card is pixel-identical to the undimmed ghost it replaces - and allocates no animation state', async () => {
    await render(playing({ dimmed: true, dimHold: true }))

    expect(scrims()).toHaveLength(0)
    expect(mockCounters.sharedValues).toBe(0)
  })

  it('fades the scrim in when the hold is released, instead of popping it on', async () => {
    const { rerender } = await render(playing({ dimmed: true, dimHold: true }))
    expect(scrims()).toHaveLength(0)
    expect(mockTiming).not.toHaveBeenCalled()

    // The release mounts the animated scrim, transparent for its first frame, and asks for the fade.
    await rerender(playing({ dimmed: true, dimHold: false }))
    expect(scrims()).toHaveLength(1)
    expect(scrimOpacity()).toBe(0)
    expect(mockTiming).toHaveBeenCalledTimes(1)
    expect(mockTiming).toHaveBeenCalledWith(1, { duration: DIM_FADE_MS })

    // The mock's value has "finished" by the next render.
    await rerender(playing({ dimmed: true, dimHold: false }))
    expect(scrims()).toHaveLength(1)
    expect(scrimOpacity()).toBe(1)
    // Re-rendering does not restart the fade, and the whole life of the card allocated ONE shared value (at the release).
    expect(mockTiming).toHaveBeenCalledTimes(1)
    expect(mockCounters.sharedValues).toBe(1)
  })

  it('a card held again loses its scrim, and fades in again on the next release', async () => {
    const { rerender } = await render(playing({ dimmed: true, dimHold: true }))
    await rerender(playing({ dimmed: true, dimHold: false }))
    await rerender(playing({ dimmed: true, dimHold: false }))
    expect(scrimOpacity()).toBe(1)

    await rerender(playing({ dimmed: true, dimHold: true }))
    expect(scrims()).toHaveLength(0)

    mockTiming.mockClear()
    await rerender(playing({ dimmed: true, dimHold: false }))
    expect(scrimOpacity()).toBe(0)
    expect(mockTiming).toHaveBeenCalledWith(1, { duration: DIM_FADE_MS })
  })

  it('a card that was never held pays for no animation: plain scrim, no shared value, however dimHold stays', async () => {
    const { rerender } = await render(playing({ dimmed: true, dimHold: false }))

    expect(scrimOpacity()).toBeUndefined()
    expect(mockCounters.sharedValues).toBe(0)

    await rerender(playing({ dimmed: true, dimHold: false }))
    expect(scrimOpacity()).toBeUndefined()
    expect(mockCounters.sharedValues).toBe(0)
    expect(mockTiming).not.toHaveBeenCalled()
  })

  it('a plain-scrim card that then gets held (hidden) drops its scrim while it cannot be seen, and fades it in on release', async () => {
    const { rerender } = await render(playing({ dimmed: true, dimHold: false }))
    expect(scrimOpacity()).toBeUndefined()

    await rerender(playing({ dimmed: true, dimHold: true }))
    expect(scrims()).toHaveLength(0)

    await rerender(playing({ dimmed: true, dimHold: false }))
    expect(mockTiming).toHaveBeenCalledWith(1, { duration: DIM_FADE_MS })
  })

  it('a card that only becomes dimmed after being held is simply dimmed at once (no fade from an earlier hold)', async () => {
    const { rerender } = await render(playing({ dimmed: false, dimHold: true }))
    expect(scrims()).toHaveLength(0)

    await rerender(playing({ dimmed: false, dimHold: false }))
    await rerender(playing({ dimmed: true, dimHold: false }))

    expect(scrims()).toHaveLength(1)
    expect(scrimOpacity()).toBeUndefined()
    expect(mockTiming).not.toHaveBeenCalled()
  })

  it.each([undefined, true, false])('an undimmed card draws no scrim at all, whatever dimHold is (%s)', async (dimHold) => {
    const { rerender } = await render(playing({ dimmed: false, dimHold }))
    expect(scrims()).toHaveLength(0)

    await rerender(playing({ dimmed: false, dimHold: !dimHold }))
    expect(scrims()).toHaveLength(0)
  })

  it('holds a face-down card the same way', async () => {
    const { rerender } = await render(playing({ card: card(false), dimmed: true, dimHold: true }))
    expect(scrims()).toHaveLength(0)

    await rerender(playing({ card: card(false), dimmed: true, dimHold: false }))
    expect(mockTiming).toHaveBeenCalledWith(1, { duration: DIM_FADE_MS })
  })
})

describe('PileView hands its hidden cards to the scrim as a hold', () => {
  const at = (rank: number): Card => ({ id: `spades-${rank}-0`, suit: 'spades', rank, faceUp: true }) as Card
  const CARDS = [at(9), at(8), at(7)]
  // Only the top card is a legal source: the two buried ones are dimmed (like a FreeCell column under a run-breaker).
  const drag = { registry: { hitTest: async () => null }, getRunCount: (indexFromTop: number) => (indexFromTop === 0 ? 1 : 0), onDrop: async () => false } as never

  function pile(props: Partial<React.ComponentProps<typeof PileView>> = {}) {
    return (
      <CardSizeProvider width={64}>
        <PileView cards={CARDS} drag={drag} onPressCard={() => {}} dimUnplayable {...props} />
      </CardSizeProvider>
    )
  }
  const opacities = () => scrims().map((node) => styleOf(node).opacity)

  it('draws a plain, instant scrim on every buried card of a settled board (a resumed save mounts no animation state)', async () => {
    // The column and its cards own shared values regardless of dimming (drag positions, a shake per card): count those
    // first, with nothing dimmed, then require the dimmed board to allocate not one more.
    await render(pile({ dimUnplayable: false }))
    const withoutScrims = mockCounters.sharedValues
    mockCounters.sharedValues = 0

    await render(pile())

    expect(opacities()).toEqual([undefined, undefined])
    expect(mockCounters.sharedValues).toBe(withoutScrims)
  })

  it('a dimmed card still hidden for the deal draws no scrim (and allocates none); revealing it fades the scrim in', async () => {
    const hidden = new Set(CARDS.map((c) => c.id))
    const { rerender } = await render(pile({ hiddenCardIds: hidden }))

    // The two buried cards are dimmed but held back: no scrim yet. The top card is not dimmed at all.
    expect(opacities()).toEqual([])

    // The top card (rank 7, not dimmed) lands first: nothing to fade.
    const [bottom, middle] = CARDS.map((c) => c.id)
    await rerender(pile({ hiddenCardIds: new Set([bottom, middle]) }))
    await rerender(pile({ hiddenCardIds: new Set([bottom, middle]) }))
    expect(opacities()).toEqual([])
    expect(mockTiming).not.toHaveBeenCalled()

    // Then the middle one: only that scrim appears (transparent, then fading in); the still-flying bottom card stays bare.
    await rerender(pile({ hiddenCardIds: new Set([bottom]) }))
    expect(mockTiming).toHaveBeenCalledTimes(1)
    expect(mockTiming).toHaveBeenCalledWith(1, { duration: DIM_FADE_MS })
    expect(opacities()).toEqual([0])
    await rerender(pile({ hiddenCardIds: new Set([bottom]) }))
    expect(opacities()).toEqual([1])

    // The last card lands.
    await rerender(pile({ hiddenCardIds: new Set() }))
    await rerender(pile({ hiddenCardIds: new Set() }))
    expect(mockTiming).toHaveBeenCalledTimes(2)
    expect(opacities()).toEqual([1, 1])
  })

  it('dimUnplayable off draws no scrim, hidden or not', async () => {
    const hidden = new Set(CARDS.map((c) => c.id))
    const { rerender } = await render(pile({ hiddenCardIds: hidden, dimUnplayable: false }))
    expect(scrims()).toHaveLength(0)

    await rerender(pile({ hiddenCardIds: new Set(), dimUnplayable: false }))
    expect(scrims()).toHaveLength(0)
  })
})
