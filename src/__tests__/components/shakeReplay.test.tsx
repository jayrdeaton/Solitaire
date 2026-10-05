import { CardSizeProvider } from '@tastic/cards'
import { render } from '@testing-library/react-native'
import { View } from 'react-native'

import { PileView } from '@/components/PileView'
import { useShakeStyle } from '@/components/shakeAnimation'
import type { Card } from '@/engine/types'
import { PyramidCell } from '@/games/pyramid/PyramidScreen'
import { TriPeaksCell } from '@/games/tripeaks/TriPeaksScreen'

// Every playShake() is one withSequence() call, so counting those counts the shakes actually played.
const mockWithSequence = jest.fn((...steps: unknown[]) => steps[steps.length - 1])
const mockGhost = { cardRegistry: { register: jest.fn(), unregister: jest.fn() }, showLive: jest.fn() }

jest.mock('react-native-reanimated', () => {
  const { useRef } = require('react')
  const base = jest.requireActual('../../__mocks__/react-native-reanimated')
  return {
    ...base,
    withSequence: (...steps: unknown[]) => mockWithSequence(...steps),
    // Stable for a component's lifetime, like the real ones (the repo-wide mock hands back new ones every render).
    useSharedValue: (initial: unknown) => useRef({ value: initial }).current,
    useAnimatedRef: () => useRef({ current: null }).current
  }
})
jest.mock('@/components/PlayingCard', () => {
  const { View: MockView } = require('react-native')
  return { PlayingCard: ({ card }: { card: { id: string } }) => <MockView testID={`card-${card.id}`} />, EmptySlot: () => <MockView /> }
})
jest.mock('@/components/dragdrop/DragGhostLayer', () => ({ useDragGhost: () => mockGhost }))
jest.mock('@/components/useCardSounds', () => ({ useCardSoundEffects: () => ({ playCardSound: jest.fn() }) }))
jest.mock('react-native-gesture-handler', () => {
  const pan = () => {
    const g: Record<string, unknown> = {}
    for (const method of ['minDistance', 'onStart', 'onUpdate', 'onEnd', 'enabled']) g[method] = () => g
    return g
  }
  return { Gesture: { Pan: pan }, GestureDetector: ({ children }: { children: unknown }) => children }
})

function Shaker({ token, cardId = 'clubs-5-0' }: { token?: number; cardId?: string }) {
  useShakeStyle(token, cardId)
  return <View />
}

beforeEach(() => mockWithSequence.mockClear())

describe('useShakeStyle', () => {
  it('plays when a mounted card gets a new token, and again for the next one (the same card tapped twice)', async () => {
    const r = await render(<Shaker />)
    await r.rerender(<Shaker token={1} />)
    expect(mockWithSequence).toHaveBeenCalledTimes(1)
    await r.rerender(<Shaker token={2} />)
    expect(mockWithSequence).toHaveBeenCalledTimes(2)
  })

  it('does not play the token a card MOUNTS with - the last shake, still held by the screen, reaching a card that just landed', async () => {
    await render(<Shaker token={3} />)
    expect(mockWithSequence).not.toHaveBeenCalled()
  })

  it('does not replay a token that comes back after the card was out of the shake for a while (a waste card uncovered again)', async () => {
    const r = await render(<Shaker />)
    await r.rerender(<Shaker token={4} />)
    await r.rerender(<Shaker />)
    await r.rerender(<Shaker token={4} />)
    expect(mockWithSequence).toHaveBeenCalledTimes(1)
  })
})

describe('useShakeStyle in a reused slot (the waste top, Canfield reserve - one instance, whichever card is on top)', () => {
  it('does not play a stale token that arrives with a different card the slot starts showing', async () => {
    // X was shaken (token 9) in an earlier pass of the waste; this instance was mounted later, showing Y.
    const r = await render(<Shaker cardId='Y' />)
    // Y is played off and X is uncovered, still holding the screen's last shake.
    await r.rerender(<Shaker cardId='X' token={9} />)
    expect(mockWithSequence).not.toHaveBeenCalled()
  })

  it('still plays a new shake of the card it now shows', async () => {
    const r = await render(<Shaker cardId='Y' />)
    await r.rerender(<Shaker cardId='X' token={9} />)
    await r.rerender(<Shaker cardId='X' token={10} />)
    expect(mockWithSequence).toHaveBeenCalledTimes(1)
  })
})

const card = (rank: number): Card => ({ id: `hearts-${rank}-0`, suit: 'hearts', rank, faceUp: true }) as Card
const drag = { registry: { hitTest: async () => null }, getRunCount: () => 1, onDrop: async () => false } as never

function pile(cards: Card[], props: Partial<React.ComponentProps<typeof PileView>> = {}) {
  return (
    <CardSizeProvider width={64}>
      <PileView cards={cards} drag={drag} onPressCard={() => {}} {...props} />
    </CardSizeProvider>
  )
}

describe('PileView shake', () => {
  it('a shaken card that is moved does not shake again when its flight lands in the new column', async () => {
    const shaken = card(9)
    // Tapped while stuck: it shakes once, in its own column.
    const source = await render(pile([card(10), shaken]))
    await source.rerender(pile([card(10), shaken], { shakeCardId: shaken.id, shakeToken: 1 }))
    expect(mockWithSequence).toHaveBeenCalledTimes(1)
    // Later it moves: in the destination column it is a FlyingCardSlot while its ghost is in the air, then the real
    // card mounts there when the ghost lands - still receiving the screen's last shake, which nothing clears.
    const dest = await render(pile([card(10), shaken], { hiddenCount: 1, shakeCardId: shaken.id, shakeToken: 1 }))
    await dest.rerender(pile([card(10), shaken], { hiddenCount: 0, shakeCardId: shaken.id, shakeToken: 1 }))
    expect(dest.getByTestId(`card-${shaken.id}`)).toBeTruthy()
    expect(mockWithSequence).toHaveBeenCalledTimes(1)
  })

  it('still shakes a whole run when a stuck mid-column card is tapped', async () => {
    const cards = [card(11), card(10), card(9)]
    const r = await render(pile(cards))
    await r.rerender(pile(cards, { shakeCardId: cards[1].id, shakeCount: 2, shakeToken: 7 }))
    expect(mockWithSequence).toHaveBeenCalledTimes(2)
  })
})

// Pyramid's and TriPeaks' board cells are keyed by INDEX and keep one DraggableCard from the moment a card is dealt into the
// cell until it leaves - covered, then exposed - so its painted face survives the uncovering (cardFacePaint.ts). That
// instance can meet the screen's last shake while its card is still COVERED: a New Game deals the card that was shaken last
// into a covered cell (card ids are reused by every deal), either mounting the cell's DraggableCard or re-seeding the one it
// had. The token has to reach the card then, so it is recorded as already played; a cell that masked it while covered
// recorded "no token" and played the stale one the moment a move uncovered the card. (Both screens also drop their shake on
// a New Game - a second line of defence these cell tests deliberately do not lean on.)
const cellRegistry = { register: jest.fn(), unregister: jest.fn() } as never
const shaken = { id: 'diamonds-10-0', suit: 'diamonds', rank: 10, faceUp: true } as Card
const other = { id: 'clubs-4-0', suit: 'clubs', rank: 4, faceUp: true } as Card
type CellProps = { card: Card | null; exposed: boolean; shakeToken?: number }

function pyramidCell({ card: c, exposed, shakeToken }: CellProps) {
  return (
    <CardSizeProvider width={64}>
      <PyramidCell index={15} card={c} exposed={exposed} hidden={false} selected={false} hinted={false} shakeToken={shakeToken} dimHeld={false} left={0} top={0} zIndex={5} dropZones={cellRegistry} onSelect={() => {}} onDrop={async () => false} />
    </CardSizeProvider>
  )
}
function tripeaksCell({ card: c, exposed, shakeToken }: CellProps) {
  return (
    <CardSizeProvider width={64}>
      <TriPeaksCell index={9} card={c} exposed={exposed} hidden={false} hinted={false} shakeToken={shakeToken} left={0} top={0} zIndex={2} dropZones={cellRegistry} onTap={() => {}} onDrop={async () => false} />
    </CardSizeProvider>
  )
}

describe.each([
  ['PyramidCell', pyramidCell],
  ['TriPeaksCell', tripeaksCell]
])('%s and the last shake of the board before a New Game', (_name, cell) => {
  it('does not shake a card that was dealt COVERED with that token when a move uncovers it (the cell mounts with it)', async () => {
    const r = await render(cell({ card: shaken, exposed: false, shakeToken: 5 }))
    await r.rerender(cell({ card: shaken, exposed: true, shakeToken: 5 }))
    expect(mockWithSequence).not.toHaveBeenCalled()
  })

  it('does not shake it either when the cell re-seeds - it held another card before the New Game dealt the shaken one into it', async () => {
    const r = await render(cell({ card: other, exposed: true }))
    await r.rerender(cell({ card: shaken, exposed: false, shakeToken: 5 }))
    await r.rerender(cell({ card: shaken, exposed: true, shakeToken: 5 }))
    expect(mockWithSequence).not.toHaveBeenCalled()
  })

  it('still shakes the uncovered card when the player taps it while it is stuck (a NEW token)', async () => {
    const r = await render(cell({ card: shaken, exposed: false, shakeToken: 5 }))
    await r.rerender(cell({ card: shaken, exposed: true, shakeToken: 5 }))
    await r.rerender(cell({ card: shaken, exposed: true, shakeToken: 6 }))
    expect(mockWithSequence).toHaveBeenCalledTimes(1)
  })
})
