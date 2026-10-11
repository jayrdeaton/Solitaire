import { render } from '@testing-library/react-native'

import type { Card } from '@/engine/types'
import { FoundationCell } from '@/games/shared/FoundationCell'

const mockGhost = { cardRegistry: { register: jest.fn(), unregister: jest.fn() } }

jest.mock('@/components/dragdrop/DragGhostLayer', () => ({ useDragGhost: () => mockGhost }))
jest.mock('@/components/PlayingCard', () => {
  const { View } = require('react-native')
  return {
    PlayingCard: ({ card }: { card: { id: string } }) => <View testID={`card-${card.id}`} />,
    FoundationSlot: () => <View testID='slot' />
  }
})
// The top card is a DraggableCard (its drag is slotTakeOffHold.test.tsx's business) - drawn here as the card it shows.
jest.mock('@/components/dragdrop/DraggableCard', () => {
  const { View } = require('react-native')
  return { DraggableCard: ({ card }: { card: { id: string } }) => <View testID={`card-${card.id}`} /> }
})

const spade = (rank: number): Card => ({ id: `spades-${rank}-0`, suit: 'spades', rank, faceUp: true }) as Card

function cell(props: Partial<React.ComponentProps<typeof FoundationCell>>) {
  return <FoundationCell card={spade(1)} isFlyingHere={false} suit='spades' {...props} />
}

describe('FoundationCell overlay while cards are flying in', () => {
  it('with no settledCard, keeps showing the frozen copy of what was on top before the flight (one flight at a time)', async () => {
    const { rerender, queryByTestId } = await render(cell({ card: spade(2) }))

    await rerender(cell({ card: spade(3), isFlyingHere: true }))

    expect(queryByTestId('card-spades-2-0')).not.toBeNull() // the outgoing top, frozen under the ghost
    expect(queryByTestId('card-spades-3-0')).not.toBeNull() // the real, hidden, incoming top stays mounted for the flight to measure
  })

  it('shows settledCard under the ghosts, and follows it as overlapping flights land one by one (the frozen copy would stay stale)', async () => {
    const { rerender, queryByTestId } = await render(cell({ card: spade(1) }))

    // 2 and 3 committed back to back: two flights in the air, the pile's real top is already the 3.
    await rerender(cell({ card: spade(3), isFlyingHere: true, settledCard: spade(1) }))
    expect(queryByTestId('card-spades-1-0')).not.toBeNull()

    // The 2 lands while the 3 is still in the air, and a 4 has committed meanwhile - isFlyingHere never drops.
    await rerender(cell({ card: spade(4), isFlyingHere: true, settledCard: spade(2) }))
    expect(queryByTestId('card-spades-2-0')).not.toBeNull() // the newly landed card, not the pre-stream Ace
    expect(queryByTestId('card-spades-1-0')).toBeNull()

    await rerender(cell({ card: spade(4), isFlyingHere: true, settledCard: spade(3) }))
    expect(queryByTestId('card-spades-3-0')).not.toBeNull()
  })

  it('a null settledCard shows the empty slot under the ghosts', async () => {
    const { rerender, queryByTestId } = await render(cell({ card: undefined }))

    await rerender(cell({ card: spade(1), isFlyingHere: true, settledCard: null }))

    expect(queryByTestId('slot')).not.toBeNull()
    expect(queryByTestId('card-spades-1-0')).not.toBeNull() // only the real, hidden top card
  })

  it('shows no overlay at all once nothing is flying', async () => {
    const { queryByTestId } = await render(cell({ card: spade(5), isFlyingHere: false, settledCard: spade(4) }))

    expect(queryByTestId('card-spades-4-0')).toBeNull()
    expect(queryByTestId('card-spades-5-0')).not.toBeNull()
  })
})
