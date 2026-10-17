import { CardSizeProvider, faceUpFanOffset, RANK_INK_RIGHT_FRACTION } from '@tastic/cards'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { StyleSheet, ViewStyle } from 'react-native'

import { markGhostPending } from '@/components/cardFacePaint'
import { StockWaste } from '@/components/StockWaste'
import * as wasteFan from '@/components/wasteFan'
import { WASTE_FAN_CLEAR_MARGIN_FRACTION, wasteFanStep, wasteFanStepFor } from '@/components/wasteFan'
import type { Card } from '@/engine/types'

// The real StockWaste, with the card art and the gesture-driven card replaced by bare views. What is under test is which card the waste
// slot paints UNDER the flying ghost(s) while its real top is hidden (wasteHiddenCount > 0): the frozen copy of the pre-flight top by
// default, or - when the screen passes one - settledWasteTop, the top card that has already landed.
// It also reports the card it draws (nativeID) and what a drag would uncover under it (accessibilityLabel): the card it was handed,
// the empty outline, or nothing.
jest.mock('@/components/dragdrop/DraggableCard', () => {
  const { View } = require('react-native')
  return {
    DraggableCard: ({ card, hidden, underCard, emptyFallback }: { card: { id: string }; hidden?: boolean; underCard?: { id: string } | null; emptyFallback?: unknown }) => <View testID='waste-top' nativeID={card.id} accessibilityHint={hidden ? 'hidden' : 'visible'} accessibilityLabel={underCard ? underCard.id : emptyFallback ? 'outline' : 'nothing'} />
  }
})
jest.mock('@/components/dragdrop/DropZone', () => {
  const { View } = require('react-native')
  return { DropZone: ({ children }: { children: unknown }) => <View>{children as never}</View> }
})
jest.mock('@/components/theme', () => {
  const actual = jest.requireActual('@/components/theme')
  return { ...actual, useTableColors: () => actual.lightColors }
})
jest.mock('@/components/PlayingCard', () => {
  const { View } = require('react-native')
  // A pile's own cards carry a testID of their own (stock-pile); anything else - the card painted under a flying ghost - is `card-<id>`.
  return {
    PlayingCard: ({ card, testID }: { card: { id: string }; testID?: string }) => <View testID={testID ?? `card-${card.id}`} />,
    EmptySlot: ({ testID, onPress, children }: { testID?: string; onPress?: () => void; children?: unknown }) => (
      <View testID={testID ?? 'slot'} accessibilityHint={onPress ? 'tappable' : 'inert'}>
        {children as never}
      </View>
    )
  }
})

const heart = (rank: number): Card => ({ id: `hearts-${rank}-0`, suit: 'hearts', rank, faceUp: true }) as Card
const dropZones = { register: jest.fn(), unregister: jest.fn(), hitTest: jest.fn() } as never

function waste(props: Partial<React.ComponentProps<typeof StockWaste>>) {
  return <StockWaste dropZones={dropZones} stockTopCard={undefined} wasteTop={heart(4)} onDrawStock={() => {}} onWastePress={() => {}} onWasteDrop={() => false} {...props} />
}

describe('StockWaste - what the waste slot paints under flying draws', () => {
  it('without settledWasteTop keeps the frozen copy of the top from before the flight (every other caller)', async () => {
    const { rerender, queryByTestId } = await render(waste({ wasteTop: heart(2) }))

    // Three draws in a row: the real top is already the 4, hidden - the slot keeps showing the 2 from before the stream.
    await rerender(waste({ wasteTop: heart(4), wasteHiddenCount: 1 }))
    expect(queryByTestId('card-hearts-2-0')).not.toBeNull()
    expect(queryByTestId('waste-top')!.props.accessibilityHint).toBe('hidden')

    // The first drawn card lands, the others are still flying: the frozen copy is never refreshed (the hidden count never dropped).
    await rerender(waste({ wasteTop: heart(4), wasteHiddenCount: 1 }))
    expect(queryByTestId('card-hearts-2-0')).not.toBeNull()
  })

  it('shows settledWasteTop under the ghosts, and follows it as overlapping draws land (the frozen copy would stay stale)', async () => {
    const { rerender, queryByTestId } = await render(waste({ wasteTop: heart(2) }))

    await rerender(waste({ wasteTop: heart(4), wasteHiddenCount: 1, settledWasteTop: heart(2) })) // nothing of the stream has landed
    expect(queryByTestId('card-hearts-2-0')).not.toBeNull()

    await rerender(waste({ wasteTop: heart(4), wasteHiddenCount: 1, settledWasteTop: heart(3) })) // the 3 has landed; the 4 is still flying
    expect(queryByTestId('card-hearts-3-0')).not.toBeNull() // the card that just landed, not the 2 from before the whole stream
    expect(queryByTestId('card-hearts-2-0')).toBeNull()
  })

  it('a null settledWasteTop shows the empty slot under the ghosts', async () => {
    // A stock with a card in it, so the only empty slot on screen is the waste's.
    const { rerender, queryByTestId } = await render(waste({ wasteTop: undefined, stockTopCard: heart(9) }))

    await rerender(waste({ wasteTop: heart(4), wasteHiddenCount: 1, settledWasteTop: null, stockTopCard: heart(9) }))

    expect(queryByTestId('slot')).not.toBeNull()
    expect(queryByTestId('card-hearts-4-0')).toBeNull()
  })

  it('paints no overlay at all while nothing is hidden, whatever settledWasteTop says', async () => {
    const { queryByTestId } = await render(waste({ wasteTop: heart(5), wasteHiddenCount: 0, settledWasteTop: heart(3) }))

    expect(queryByTestId('card-hearts-3-0')).toBeNull()
    expect(queryByTestId('waste-top')!.props.accessibilityHint).toBe('visible')
  })
})

// Where the '10' of a compact/numeric/tarot corner ends, as a fraction of card width: @tastic/cards' RANK_INK_RIGHT_FRACTION to 4
// decimals, written out so a change to the package's value shows up here (see wasteFanStepFor's tests).
const TEN_INK_RIGHT = 0.5073

describe('wasteFanStep - how far apart the draw-3 fan spreads its cards', () => {
  it('is exactly the plain face-up strip when no rank ink extent is given', () => {
    for (const w of [28, 38.86, 46.71, 50.57, 61.04, 96]) {
      expect(wasteFanStep(w)).toBe(faceUpFanOffset(w))
      expect(wasteFanStep(w, undefined)).toBe(faceUpFanOffset(w))
      expect(wasteFanStep(w, 0)).toBe(faceUpFanOffset(w))
    }
  })

  it('widens to clear the rank ink plus the margin, so a covered 10 keeps its whole 0', () => {
    for (const w of [28, 38.86, 46.71, 50.57, 61.04, 96]) {
      const step = wasteFanStep(w, TEN_INK_RIGHT)
      expect(step).toBeGreaterThanOrEqual((TEN_INK_RIGHT + WASTE_FAN_CLEAR_MARGIN_FRACTION) * w)
      expect(step).toBeGreaterThan(faceUpFanOffset(w))
    }
  })

  it('is never narrower than the strip, however small the reported ink extent', () => {
    for (const w of [28, 50.57, 96]) {
      expect(wasteFanStep(w, 0.1)).toBe(faceUpFanOffset(w))
      expect(wasteFanStep(w, 0.3)).toBe(faceUpFanOffset(w))
      expect(wasteFanStep(w, TEN_INK_RIGHT)).toBeGreaterThanOrEqual(faceUpFanOffset(w))
    }
  })

  it('scales linearly with card width (the ghosts and the board model both rely on it)', () => {
    expect(wasteFanStep(100, TEN_INK_RIGHT) / 100).toBeCloseTo(wasteFanStep(50, TEN_INK_RIGHT) / 50, 10)
  })
})

describe('wasteFanStepFor - the installed @tastic/cards export', () => {
  it("is the package's own RANK_INK_RIGHT_FRACTION (the '10' ink extent these tests assume)", () => {
    expect(RANK_INK_RIGHT_FRACTION).toBeCloseTo(TEN_INK_RIGHT, 4)
  })

  it('widens to clear the ink', () => {
    expect(wasteFanStepFor(50.57)).toBeCloseTo((RANK_INK_RIGHT_FRACTION + WASTE_FAN_CLEAR_MARGIN_FRACTION) * 50.57, 10)
    expect(wasteFanStepFor(50.57)).toBeGreaterThan(faceUpFanOffset(50.57))
  })

  it('widen false is the plain strip (a screen whose fan has no room to spread)', () => {
    expect(wasteFanStepFor(50.57, false)).toBe(faceUpFanOffset(50.57))
  })
})

describe('StockWaste - the draw-3 fan', () => {
  const leftOf = (cardId: string) => (StyleSheet.flatten(screen.getByTestId(`card-${cardId}`).parent!.props.style) as ViewStyle).left

  it('lays the two cards behind the top out one step and two steps to its left - the step the flights offset their ghosts by', async () => {
    await render(waste({ cardWidth: 60, wasteTop: heart(4), wasteBehind: [heart(3), heart(2)] }))

    const step = wasteFanStepFor(60)
    expect(leftOf('hearts-3-0')).toBe(-step) // wasteBehind[0]: directly under the top
    expect(leftOf('hearts-2-0')).toBe(-step * 2)
  })

  it('takes its step from wasteFanStepFor alone (not a second copy of the strip), so a wider step moves the cards', async () => {
    const spy = jest.spyOn(wasteFan, 'wasteFanStepFor').mockReturnValue(33)
    try {
      await render(waste({ cardWidth: 60, wasteTop: heart(4), wasteBehind: [heart(3), heart(2)] }))

      expect(leftOf('hearts-3-0')).toBe(-33)
      expect(leftOf('hearts-2-0')).toBe(-66)
    } finally {
      spy.mockRestore()
    }
  })

  it('widenFan false keeps the plain face-up strip, the step Canfield offsets its own flight ghosts by', async () => {
    await render(waste({ cardWidth: 60, widenFan: false, wasteTop: heart(4), wasteBehind: [heart(3), heart(2)] }))

    expect(leftOf('hearts-3-0')).toBe(-faceUpFanOffset(60))
    expect(leftOf('hearts-2-0')).toBe(-faceUpFanOffset(60) * 2)
  })

  it('never fans tighter than the plain face-up strip', async () => {
    await render(waste({ cardWidth: 60, wasteTop: heart(4), wasteBehind: [heart(3)] }))

    expect(-(leftOf('hearts-3-0') as number)).toBeGreaterThanOrEqual(faceUpFanOffset(60))
  })

  it('fans by the context card size when no cardWidth is passed', async () => {
    await render(<CardSizeProvider width={80}>{waste({ wasteTop: heart(4), wasteBehind: [heart(3)] })}</CardSizeProvider>)

    expect(leftOf('hearts-3-0')).toBe(-wasteFanStepFor(80))
  })
})

describe('StockWaste - an exhausted stock', () => {
  it('offers the recycle arrow, and the tap, when the game recycles', async () => {
    const onDrawStock = jest.fn()
    await render(waste({ stockTopCard: undefined, wasteTop: heart(4), onDrawStock }))
    expect(screen.queryByText('↺')).not.toBeNull()
    await fireEvent.press(screen.getByTestId('stock-pile'))
    expect(onDrawStock).toHaveBeenCalledTimes(1)
  })

  it('is a plain, inert slot when the game never recycles (Golf, TriPeaks, Forty Thieves)', async () => {
    const onDrawStock = jest.fn()
    await render(waste({ stockTopCard: undefined, wasteTop: heart(4), canRecycle: false, onDrawStock }))
    expect(screen.queryByText('↺')).toBeNull()
    expect(screen.getByTestId('stock-pile').props.accessibilityState?.disabled).toBe(true)
    await fireEvent.press(screen.getByTestId('stock-pile'))
    expect(onDrawStock).not.toHaveBeenCalled()
  })
})

// Every stock tap must reach the screen, however fast (Jay's kids speed through the stock): the press target is one view, never
// unmounted or hidden, and the art inside it is.
describe('StockWaste - the stock takes every tap', () => {
  const back = (rank: number): Card => ({ id: `spades-${rank}-0`, suit: 'spades', rank, faceUp: false }) as Card
  const opacityOf = (el: { props: { style?: unknown } }) => StyleSheet.flatten(el.props.style as ViewStyle)?.opacity

  it('is the same press target whether the stock draws a card or the empty slot - a press is never cut off by the swap', async () => {
    const { rerender } = await render(waste({ stockTopCard: back(3) }))
    const before = screen.getByTestId('stock-pile')

    await rerender(waste({ stockTopCard: undefined }))
    expect(screen.getByTestId('stock-pile')).toBe(before)
    await rerender(waste({ stockTopCard: back(5) }))
    expect(screen.getByTestId('stock-pile')).toBe(before)
  })

  it('takes a tap while it is hidden for cards flying into it: the target is never drawn at opacity 0 (iOS hit-tests no such view)', async () => {
    const onDrawStock = jest.fn()
    await render(waste({ stockTopCard: back(3), stockHidden: true, onDrawStock }))

    // Neither the target nor anything around it is see-through; only the art inside it is.
    const target = screen.getByTestId('stock-pile')
    for (let el: typeof target | null = target; el; el = el.parent) expect(opacityOf(el)).not.toBe(0)
    const hidden = (el: typeof target): boolean => opacityOf(el) === 0 || el.children.some((c) => typeof c !== 'string' && hidden(c))
    expect(target.children.some((c) => typeof c !== 'string' && hidden(c))).toBe(true)
    await fireEvent.press(target)
    expect(onDrawStock).toHaveBeenCalledTimes(1)
  })

  it('takes a tap while the last card is still taking off (its ghost not on screen yet), instead of ignoring it', async () => {
    const onDrawStock = jest.fn()
    const { rerender } = await render(waste({ stockTopCard: back(3), onDrawStock }))
    let release = () => {}
    await act(async () => {
      release = markGhostPending([back(3).id])
    })

    await rerender(waste({ stockTopCard: undefined, onDrawStock }))
    expect(screen.queryByTestId('card-spades-3-0')).not.toBeNull() // still drawn where it was
    await fireEvent.press(screen.getByTestId('stock-pile'))
    expect(onDrawStock).toHaveBeenCalledTimes(1)
    await act(async () => release())
  })

  it('a tap asks for one draw, with nothing else: not the press event', async () => {
    const onDrawStock = jest.fn()
    await render(waste({ stockTopCard: back(3), onDrawStock }))
    await fireEvent.press(screen.getByTestId('stock-pile'), { nativeEvent: {} })
    expect(onDrawStock).toHaveBeenCalledWith()
  })
})

describe('StockWaste - holding the stock', () => {
  const back = (rank: number): Card => ({ id: `spades-${rank}-0`, suit: 'spades', rank, faceUp: false }) as Card
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('streams draws where the stock turns over, and stops when the finger lifts', async () => {
    const onDrawStock = jest.fn(async () => true)
    await render(waste({ stockTopCard: back(3), onDrawStock }))
    await fireEvent(screen.getByTestId('stock-pile'), 'longPress')
    await act(async () => {
      await jest.advanceTimersByTimeAsync(500)
    })
    await fireEvent(screen.getByTestId('stock-pile'), 'pressOut')
    const drawn = onDrawStock.mock.calls.length
    expect(drawn).toBeGreaterThan(2)
    await act(async () => {
      await jest.advanceTimersByTimeAsync(500)
    })
    expect(onDrawStock).toHaveBeenCalledTimes(drawn)
  })

  it('is never held where the stock runs out for good: one hold would deal the whole of it', async () => {
    const onDrawStock = jest.fn(async () => true)
    await render(waste({ stockTopCard: back(3), onDrawStock, canRecycle: false }))
    await fireEvent(screen.getByTestId('stock-pile'), 'longPress')
    await act(async () => {
      await jest.advanceTimersByTimeAsync(500)
    })
    expect(onDrawStock).not.toHaveBeenCalled()
  })
})

describe('StockWaste - one card landing on a fanned waste', () => {
  it('keeps the whole pre-flight fan until it lands, so the old top is never shown twice', async () => {
    // Before: 1, 2 behind the 3. One card (the 4) is drawn: the real fan is now 2, 3 behind the 4, but the 4 is still flying.
    const { rerender } = await render(waste({ wasteTop: heart(3), wasteBehind: [heart(2), heart(1)] }))
    await rerender(waste({ wasteTop: heart(4), wasteBehind: [heart(3), heart(2)], wasteHiddenCount: 1 }))
    expect(screen.queryAllByTestId('card-hearts-3-0')).toHaveLength(1) // under the ghost, at the top - not in the fan too
    expect(screen.queryByTestId('card-hearts-1-0')).not.toBeNull() // the fan has not moved yet

    await rerender(waste({ wasteTop: heart(4), wasteBehind: [heart(3), heart(2)], wasteHiddenCount: 0 }))
    expect(screen.queryByTestId('card-hearts-1-0')).toBeNull()
    expect(screen.queryAllByTestId('card-hearts-3-0')).toHaveLength(1)
  })

  it('still reveals a draw-3 fan slot by slot as its three ghosts land', async () => {
    const { rerender } = await render(waste({ wasteTop: heart(3), wasteBehind: [heart(2), heart(1)] }))
    const next = { wasteTop: heart(6), wasteBehind: [heart(5), heart(4)] }
    await rerender(waste({ ...next, wasteHiddenCount: 3 }))
    await rerender(waste({ ...next, wasteHiddenCount: 2 })) // the far card (4) has landed
    expect(screen.queryByTestId('card-hearts-4-0')).not.toBeNull()
    await rerender(waste({ ...next, wasteHiddenCount: 1 })) // the 5 has landed, the 6 is still in the air
    expect(screen.queryByTestId('card-hearts-5-0')).not.toBeNull()
  })
})

describe('StockWaste - what a drag uncovers when it lifts the top card', () => {
  const underLifted = () => screen.getByTestId('waste-top').props.accessibilityLabel as string

  it('draw-1: the card under the top, not the empty outline', async () => {
    await render(waste({ wasteTop: heart(4), wasteUnder: heart(3) }))
    expect(underLifted()).toBe('hearts-3-0')
  })

  it('a lone card: the empty outline', async () => {
    await render(waste({ wasteTop: heart(4) }))
    expect(underLifted()).toBe('outline')
  })

  it('draw-3: nothing more - the fan already shows that card beside the slot, and an outline would cross its face', async () => {
    await render(waste({ wasteTop: heart(4), wasteBehind: [heart(3), heart(2)], wasteUnder: heart(3) }))
    expect(underLifted()).toBe('nothing')
  })

  it('a card still drawn after it has left (its ghost not on screen yet): the waste top, the card that is under it now', async () => {
    const { rerender } = await render(waste({ wasteTop: heart(4), wasteUnder: heart(3) }))
    const release = markGhostPending([heart(4).id])
    try {
      await rerender(waste({ wasteTop: heart(3), wasteUnder: heart(2) }))
      expect(screen.getByTestId('waste-top').props.nativeID).toBe('hearts-4-0') // held
      expect(underLifted()).toBe('hearts-3-0') // not the 2, two cards down
    } finally {
      release()
    }
  })
})
