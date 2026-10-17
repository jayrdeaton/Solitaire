import { act, renderHook } from '@testing-library/react-native'

import { useHintHold } from '@/components/hintHold'

const REPEAT_MS = 830

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
}

/** A screen's hint handler with `choices` moves to cycle through (0: nothing to suggest), counting what it was asked for. */
function screenHint(choices: number) {
  const onHint = jest.fn(() => choices > 1)
  return { onHint }
}

describe('useHintHold', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('shows a hint at the long press, then the next one every repeat while the finger stays down', async () => {
    const screen = screenHint(3)
    const { result } = await renderHook(() => useHintHold(screen.onHint, REPEAT_MS))

    await act(async () => result.current.onLongPress())
    expect(screen.onHint).toHaveBeenCalledTimes(1)
    await advance(REPEAT_MS - 1)
    expect(screen.onHint).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(screen.onHint).toHaveBeenCalledTimes(2)
    // Past the last one it wraps, as pressing Hint again does: the hold doesn't stop at the end of the cycle.
    await advance(3 * REPEAT_MS)
    expect(screen.onHint).toHaveBeenCalledTimes(5)
  })

  it('lifting the finger stops it', async () => {
    const screen = screenHint(3)
    const { result } = await renderHook(() => useHintHold(screen.onHint, REPEAT_MS))

    await act(async () => result.current.onLongPress())
    await advance(REPEAT_MS)
    await act(async () => result.current.onPressOut())
    await advance(10 * REPEAT_MS)
    expect(screen.onHint).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['a lone move or a stock draw', 1],
    ['no move at all (the screen toasts)', 0]
  ])('stops after the first when there is nothing new to show: %s', async (_name, choices) => {
    const screen = screenHint(choices)
    const { result } = await renderHook(() => useHintHold(screen.onHint, REPEAT_MS))

    await act(async () => result.current.onLongPress())
    await advance(10 * REPEAT_MS)
    expect(screen.onHint).toHaveBeenCalledTimes(1)
  })

  it('asks the latest handler, so each step reads the hint the last one set', async () => {
    const first = jest.fn(() => true)
    const second = jest.fn(() => true)
    const { result, rerender } = await renderHook(({ onHint }: { onHint: () => boolean }) => useHintHold(onHint, REPEAT_MS), { initialProps: { onHint: first } })

    await act(async () => result.current.onLongPress())
    await act(async () => rerender({ onHint: second }))
    await advance(REPEAT_MS)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('a new hold starts its own loop; the old one stops', async () => {
    const screen = screenHint(3)
    const { result } = await renderHook(() => useHintHold(screen.onHint, REPEAT_MS))

    await act(async () => result.current.onLongPress())
    await advance(REPEAT_MS / 2)
    await act(async () => result.current.onLongPress()) // a second long press before the first one's press-out
    await advance(REPEAT_MS)
    expect(screen.onHint).toHaveBeenCalledTimes(3) // two long presses and one repeat, not two loops' worth
  })

  it('unmounting stops it', async () => {
    const screen = screenHint(3)
    const { result, unmount } = await renderHook(() => useHintHold(screen.onHint, REPEAT_MS))

    await act(async () => result.current.onLongPress())
    await act(async () => unmount())
    await advance(10 * REPEAT_MS)
    expect(screen.onHint).toHaveBeenCalledTimes(1)
  })
})
