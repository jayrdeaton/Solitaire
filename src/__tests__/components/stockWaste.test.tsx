import { CardSizeProvider, faceUpFanOffset, RANK_INK_RIGHT_FRACTION } from '@tastic/cards'
import { render, screen } from '@testing-library/react-native'
import { StyleSheet, ViewStyle } from 'react-native'

import { StockWaste } from '@/components/StockWaste'
import * as wasteFan from '@/components/wasteFan'
import { WASTE_FAN_CLEAR_MARGIN_FRACTION, wasteFanStep, wasteFanStepFor } from '@/components/wasteFan'
import type { Card } from '@/engine/types'

// The real StockWaste, with the card art and the gesture-driven card replaced by bare views. What is under test is which card the waste
// slot paints UNDER the flying ghost(s) while its real top is hidden (wasteHiddenCount > 0): the frozen copy of the pre-flight top by
// default, or - when the screen passes one - settledWasteTop, the top card that has already landed.
jest.mock('@/components/dragdrop/DraggableCard', () => {
  const { View } = require('react-native')
  return { DraggableCard: ({ hidden }: { hidden?: boolean }) => <View testID='waste-top' accessibilityHint={hidden ? 'hidden' : 'visible'} /> }
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
    EmptySlot: ({ testID }: { testID?: string }) => <View testID={testID ?? 'slot'} />
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
    const { rerender, queryByTestId } = await render(waste({ wasteTop: undefined }))

    await rerender(waste({ wasteTop: heart(4), wasteHiddenCount: 1, settledWasteTop: null }))

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
