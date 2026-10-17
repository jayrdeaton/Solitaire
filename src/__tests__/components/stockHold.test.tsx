import { act, renderHook } from '@testing-library/react-native'

import { StockRequestOptions, useStockHold } from '@/components/stockHold'

const REPEAT_MS = 96

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
}

/** A screen's stock handler with `stock` cards to draw and a waste to turn over, each draw starting `startMs` after it is asked for. */
function screenStock(stock: number, startMs = 0) {
  const calls: StockRequestOptions[] = []
  let left = stock
  let turnedOver = 0
  const onDrawStock = jest.fn((opts?: StockRequestOptions) => {
    calls.push(opts ?? {})
    return new Promise<boolean>((resolve) =>
      setTimeout(() => {
        if (opts?.cancelled?.()) return resolve(false)
        if (left === 0) {
          // A repeat never turns the waste over.
          if (opts?.repeat) return resolve(false)
          turnedOver += 1
          left = stock
          return resolve(true)
        }
        left -= 1
        resolve(true)
      }, startMs)
    )
  })
  return { onDrawStock, calls, drawn: () => stock - left, turnedOver: () => turnedOver }
}

describe('useStockHold', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('draws at the long press, then once more every repeat after each draw has started', async () => {
    const screen = screenStock(10)
    const { result } = await renderHook(() => useStockHold(screen.onDrawStock, REPEAT_MS))

    await act(async () => result.current.onLongPress())
    await advance(0)
    expect(screen.drawn()).toBe(1)
    for (let n = 2; n <= 5; n++) {
      await advance(REPEAT_MS + 1)
      expect(screen.drawn()).toBe(n)
    }
    // The long press is a plain draw, every one after it a repeat that may be cancelled.
    expect(screen.calls[0]).toEqual({})
    expect(screen.calls.slice(1).every((c) => c.repeat === true && typeof c.cancelled === 'function')).toBe(true)
  })

  it('stops where the stock runs out: a hold never turns the waste over', async () => {
    const screen = screenStock(3)
    const { result } = await renderHook(() => useStockHold(screen.onDrawStock, REPEAT_MS))

    await act(async () => result.current.onLongPress())
    await advance(10 * REPEAT_MS)
    expect(screen.drawn()).toBe(3)
    expect(screen.turnedOver()).toBe(0)
    expect(screen.onDrawStock).toHaveBeenCalledTimes(4) // the three draws, and the repeat at the empty stock that ended it
  })

  it('held on an empty stock, turns the waste over at the long press and then draws through it', async () => {
    const screen = screenStock(3)
    const { result } = await renderHook(() => useStockHold(screen.onDrawStock, REPEAT_MS))
    // Draw the stock dry first, by taps.
    for (let i = 0; i < 3; i++) await act(async () => void screen.onDrawStock())
    await advance(0)

    await act(async () => result.current.onLongPress())
    await advance(0)
    expect(screen.turnedOver()).toBe(1)
    await advance(10 * REPEAT_MS)
    expect(screen.drawn()).toBe(3)
    expect(screen.turnedOver()).toBe(1)
  })

  it('a draw that has to wait its turn holds the next one back - the repeat counts from when it started', async () => {
    const screen = screenStock(10, 250) // each draw waits 250ms (a draw-3 fan waiting for the last one to land)
    const { result } = await renderHook(() => useStockHold(screen.onDrawStock, REPEAT_MS))

    await act(async () => result.current.onLongPress())
    await advance(250)
    expect(screen.drawn()).toBe(1)
    await advance(REPEAT_MS - 1)
    expect(screen.onDrawStock).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(screen.onDrawStock).toHaveBeenCalledTimes(2)
  })

  it('letting go stops it, and a draw still waiting when the finger lifts is dropped', async () => {
    const screen = screenStock(10, 50)
    const { result } = await renderHook(() => useStockHold(screen.onDrawStock, REPEAT_MS))

    await act(async () => result.current.onLongPress())
    await advance(50 + REPEAT_MS + 1) // the second draw has been asked for and is waiting
    expect(screen.onDrawStock).toHaveBeenCalledTimes(2)
    await act(async () => result.current.onPressOut())
    await advance(10 * REPEAT_MS)
    expect(screen.drawn()).toBe(1)
    expect(screen.onDrawStock).toHaveBeenCalledTimes(2)
  })

  it('a handler that answers nothing (a stock that is never held) gets one draw, not a stream', async () => {
    const onDrawStock = jest.fn(() => {})
    const { result } = await renderHook(() => useStockHold(onDrawStock, REPEAT_MS))

    await act(async () => result.current.onLongPress())
    await advance(10 * REPEAT_MS)
    expect(onDrawStock).toHaveBeenCalledTimes(1)
  })
})
