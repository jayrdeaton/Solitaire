import { act, render, screen } from '@testing-library/react-native'
import { useEffect } from 'react'

import { CardRegistry } from '@/components/dragdrop/CardRegistry'
import { DropZoneRegistry } from '@/components/dragdrop/DropZoneRegistry'
import { HINT_GLIDE_TOTAL_MS, HintGlideProvider } from '@/components/hinting/HintGlideLayer'
import { Card } from '@/engine/types'
import { HintGlideTarget, useHintGlide } from '@/games/shared/useHintGlide'

// The Hint button's glide: a see-through copy of the hinted card goes onto where it would land, then fades. It is only a
// preview: it starts after its measurements, never for a board that has moved on, and is gone with the board it was for.

jest.mock('@/components/PlayingCard', () => {
  const { View } = require('react-native')
  const { useEffect: useMockEffect } = require('react')
  function MockPlayingCard({ card, onFacePainted }: { card: { id: string }; onFacePainted?: () => void }) {
    useMockEffect(() => onFacePainted?.(), [onFacePainted])
    return <View testID={`glide-card-${card.id}`} />
  }
  return { PlayingCard: MockPlayingCard }
})
jest.mock('@/components/overlayFrame', () => {
  const frame = { rotation: { value: 0 }, cx: { value: 200 }, cy: { value: 400 }, lw: { value: 400 }, lh: { value: 800 } }
  return { useOverlayFrame: () => ({ overlayRef: { current: null }, frame }), toLocal: jest.requireActual('@/components/overlayFrameMath').toLocal }
})

const card = (id: string): Card => ({ id, suit: 'hearts', rank: 5, faceUp: true })
const rect = (x: number, y: number) => ({ x, y, width: 50, height: 70 })

let play: (target: HintGlideTarget) => Promise<void>
function Screen({ board, cards, zones }: { board: unknown; cards: CardRegistry; zones: DropZoneRegistry }) {
  const glide = useHintGlide(board, cards, zones)
  useEffect(() => {
    play = glide
  })
  return null
}

function setup(measure: (id: string) => Promise<ReturnType<typeof rect> | null>) {
  const cards = new CardRegistry()
  jest.spyOn(cards, 'measure').mockImplementation(measure)
  const zones = new DropZoneRegistry()
  jest.spyOn(zones, 'measure').mockResolvedValue(rect(300, 100))
  const ui = (board: unknown) => (
    <HintGlideProvider>
      <Screen board={board} cards={cards} zones={zones} />
    </HintGlideProvider>
  )
  return { ui, zones }
}

describe('hint glide', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('glides a copy of the hinted run, then is gone', async () => {
    const { ui } = setup(async (id) => (id === 'a' ? rect(10, 20) : rect(100, 20)))
    await render(ui('board'))
    await act(async () => play({ moving: [card('a'), card('b')], dest: [card('t')], destFanned: true, cardWidth: 50 }))
    expect(screen.getByTestId('hint-glide')).toBeTruthy()
    expect(screen.getByTestId('glide-card-a')).toBeTruthy()
    expect(screen.getByTestId('glide-card-b')).toBeTruthy()
    await act(async () => jest.advanceTimersByTime(HINT_GLIDE_TOTAL_MS + 100))
    expect(screen.queryByTestId('hint-glide')).toBeNull()
  })

  it('lands on the drop zone of an empty pile', async () => {
    const { ui, zones } = setup(async () => rect(10, 20))
    await render(ui('board'))
    await act(async () => play({ moving: [card('a')], dest: [], destFanned: true, slot: { zone: 'tableau', index: 3 }, cardWidth: 50 }))
    expect(zones.measure).toHaveBeenCalledWith({ zone: 'tableau', index: 3 })
    expect(screen.getByTestId('hint-glide')).toBeTruthy()
  })

  it('is dropped when the board changes under it', async () => {
    const { ui } = setup(async () => rect(10, 20))
    const view = await render(ui('board'))
    await act(async () => play({ moving: [card('a')], dest: [card('t')], destFanned: true, cardWidth: 50 }))
    expect(screen.getByTestId('hint-glide')).toBeTruthy()
    await view.rerender(ui('next board'))
    expect(screen.queryByTestId('hint-glide')).toBeNull()
  })

  it('never starts for a board that changed while it was measuring', async () => {
    let resolve: (r: ReturnType<typeof rect>) => void = () => {}
    const { ui } = setup((id) => (id === 'a' ? new Promise((r) => (resolve = r)) : Promise.resolve(rect(100, 20))))
    const view = await render(ui('board'))
    let pending: Promise<void> = Promise.resolve()
    await act(async () => {
      pending = play({ moving: [card('a')], dest: [card('t')], destFanned: true, cardWidth: 50 })
    })
    await view.rerender(ui('next board'))
    await act(async () => {
      resolve(rect(10, 20))
      await pending
    })
    expect(screen.queryByTestId('hint-glide')).toBeNull()
  })

  it('does nothing when the card to move cannot be measured', async () => {
    const { ui } = setup(async (id) => (id === 'a' ? null : rect(100, 20)))
    await render(ui('board'))
    await act(async () => play({ moving: [card('a')], dest: [card('t')], destFanned: true, cardWidth: 50 }))
    expect(screen.queryByTestId('hint-glide')).toBeNull()
  })
})
