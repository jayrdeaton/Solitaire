import { act, renderHook } from '@testing-library/react-native'

import { useWinReveal, WIN_REVEAL_HOLD_MS, WIN_REVEAL_MAX_WAIT_MS } from '@/games/shared/useWinReveal'

interface Props {
  won: boolean
  settled: boolean
}

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
}

// renderHook/rerender are async in this @testing-library/react-native version - same convention as
// useAutoFoundationCascade.test.tsx.
describe('useWinReveal', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  const render = (initial: Props) => renderHook(({ won, settled }: Props) => useWinReveal(won, settled), { initialProps: initial })

  it('is false until the game is won', async () => {
    const { result, unmount } = await render({ won: false, settled: true })
    await advance(WIN_REVEAL_MAX_WAIT_MS * 2)
    expect(result.current).toBe(false)
    await unmount()
  })

  it('waits for the flights to settle, then holds a beat before revealing', async () => {
    const { result, rerender, unmount } = await render({ won: false, settled: false })

    await rerender({ won: true, settled: false }) // the winning move committed, its card still flying
    await advance(WIN_REVEAL_HOLD_MS * 3)
    expect(result.current).toBe(false) // not while anything is still in the air

    await rerender({ won: true, settled: true }) // it landed
    await advance(WIN_REVEAL_HOLD_MS - 1)
    expect(result.current).toBe(false)
    await advance(1)
    expect(result.current).toBe(true)
    await unmount()
  })

  it('never withholds a win: reveals after the max wait even if the flights never settle', async () => {
    const { result, rerender, unmount } = await render({ won: false, settled: false })

    await rerender({ won: true, settled: false })
    await advance(WIN_REVEAL_MAX_WAIT_MS - 1)
    expect(result.current).toBe(false)
    await advance(1)
    expect(result.current).toBe(true)
    await unmount()
  })

  it('a longer maxWaitMs (a screen whose win starts a sequence of its own) withholds the reveal until then, and the hold still applies once settled', async () => {
    const LONG = WIN_REVEAL_MAX_WAIT_MS * 2
    const { result, rerender, unmount } = await renderHook(({ won, settled }: Props) => useWinReveal(won, settled, LONG), { initialProps: { won: false, settled: false } })

    await rerender({ won: true, settled: false })
    await advance(WIN_REVEAL_MAX_WAIT_MS + 500) // past the DEFAULT max wait: still withheld
    expect(result.current).toBe(false)
    await advance(LONG - WIN_REVEAL_MAX_WAIT_MS - 500 - 1)
    expect(result.current).toBe(false)
    await advance(1) // the longer max wait runs out
    expect(result.current).toBe(true)
    await unmount()

    const settledOnTime = await renderHook(({ won, settled }: Props) => useWinReveal(won, settled, LONG), { initialProps: { won: true, settled: true } })
    await advance(WIN_REVEAL_HOLD_MS) // settled: the hold, not the max wait
    expect(settledOnTime.result.current).toBe(true)
    await settledOnTime.unmount()
  })

  it('a flight starting again before the hold ends restarts the wait', async () => {
    const { result, rerender, unmount } = await render({ won: true, settled: true })

    await advance(WIN_REVEAL_HOLD_MS - 50)
    await rerender({ won: true, settled: false }) // something took off again
    await advance(WIN_REVEAL_HOLD_MS * 2)
    expect(result.current).toBe(false)
    await unmount()
  })

  it('un-winning (undo) hides it at once and rearms it, so a later re-win waits again instead of revealing instantly', async () => {
    const { result, rerender, unmount } = await render({ won: true, settled: true })
    await advance(WIN_REVEAL_HOLD_MS)
    expect(result.current).toBe(true)

    await rerender({ won: false, settled: true })
    expect(result.current).toBe(false)

    await rerender({ won: true, settled: false }) // won again, last card flying
    expect(result.current).toBe(false)
    await unmount()
  })
})
