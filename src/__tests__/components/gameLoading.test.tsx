import { render } from '@testing-library/react-native'
import { cancelAnimation } from 'react-native-reanimated'

import { GameLoading, LoadingIndicator } from '@/components/GameLoading'

// Counts every element in a rendered tree (host nodes - react-native and react-native-svg both render as host
// components under jest-expo).
function countNodes(node: unknown): number {
  if (!node || typeof node !== 'object') return 0
  const { children } = node as { children?: unknown[] | null }
  return 1 + (children ?? []).reduce<number>((sum, child) => sum + countNodes(child), 0)
}

describe('LoadingIndicator', () => {
  it('is one accessible "Loading" progressbar rather than four separate suit elements', async () => {
    const screen = await render(<LoadingIndicator />)
    expect(screen.getAllByRole('progressbar')).toHaveLength(1)
    expect(screen.getByLabelText('Loading')).toBeTruthy()
  })

  it('draws all four suits', async () => {
    const screen = await render(<LoadingIndicator />)
    for (const suit of ['♠', '♥', '♦', '♣']) {
      expect(screen.getByText(suit, { includeHiddenElements: true })).toBeTruthy()
    }
  })

  it('stops every one of its looping animations when it unmounts', async () => {
    const screen = await render(<LoadingIndicator />)
    ;(cancelAnimation as jest.Mock).mockClear()
    await screen.unmount()
    // one for the fade-in, one per suit - a suit's pulse loops forever, so leaving it running leaks.
    expect(cancelAnimation).toHaveBeenCalledTimes(5)
  })
})

describe('GameLoading', () => {
  // No background of its own: the app-wide felt (TableBackground, mounted once in _layout.tsx) shows through.
  it('renders just the indicator, over the app-wide felt', async () => {
    const screen = await render(<GameLoading />)
    expect(screen.getAllByRole('progressbar')).toHaveLength(1)
  })

  // Every game screen mounts this on every entry, so it must stay a handful of views - not grow into
  // something that itself stalls the thread it is covering for. A centering View plus the indicator (a row
  // of 4 suits) is ~7 host nodes; the generous ceiling catches a heavy rewrite, not a small addition.
  it('stays a small tree', async () => {
    const screen = await render(<GameLoading />)
    expect(countNodes(screen.toJSON())).toBeLessThan(20)
  })
})
