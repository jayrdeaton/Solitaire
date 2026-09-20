import { render } from '@testing-library/react-native'

import { StockWaste } from '@/components/StockWaste'
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
