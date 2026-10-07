import { act, renderHook } from '@testing-library/react-native'

import { UndoRequestOptions, useUndoHold } from '@/components/undoHold'

const REPEAT_MS = 96

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
}

/** A screen's undo handler whose undos each start `startMs` after they are asked for (0: at once), with `left` undos to give. */
function screenUndo(left: number, startMs = 0) {
  const calls: UndoRequestOptions[] = []
  let undone = 0
  const onUndo = jest.fn((opts?: UndoRequestOptions) => {
    calls.push(opts ?? {})
    return new Promise<boolean>((resolve) =>
      setTimeout(() => {
        if (opts?.cancelled?.() || undone >= left) return resolve(false)
        undone += 1
        resolve(true)
      }, startMs)
    )
  })
  return { onUndo, calls, undone: () => undone }
}

describe('useUndoHold', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('undoes at the long press, then once more every repeat after each undo has started - one undo per repeat', async () => {
    const screen = screenUndo(10)
    const { result } = await renderHook(() => useUndoHold(screen.onUndo, REPEAT_MS))

    await act(async () => result.current.onLongPress())
    await advance(0)
    expect(screen.undone()).toBe(1)
    for (let n = 2; n <= 5; n++) {
      await advance(REPEAT_MS + 1)
      expect(screen.undone()).toBe(n)
    }
    expect(screen.onUndo).toHaveBeenCalledTimes(5) // no tick that did nothing
  })

  it('an undo that has to wait its turn holds the next one back - the repeat counts from when it started', async () => {
    const screen = screenUndo(10, 250) // each undo waits 250ms for its gate
    const { result } = await renderHook(() => useUndoHold(screen.onUndo, REPEAT_MS))

    await act(async () => result.current.onLongPress())
    await advance(249)
    expect(screen.onUndo).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(screen.undone()).toBe(1)
    await advance(REPEAT_MS - 1)
    expect(screen.onUndo).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(screen.onUndo).toHaveBeenCalledTimes(2)
  })

  it('lifting the finger stops the loop, and cancels an undo still waiting its turn', async () => {
    const screen = screenUndo(10, 250)
    const { result } = await renderHook(() => useUndoHold(screen.onUndo, REPEAT_MS))

    await act(async () => result.current.onLongPress())
    await advance(100)
    await act(async () => result.current.onPressOut())
    expect(screen.calls[0].cancelled?.()).toBe(true)
    await advance(2000)
    expect(screen.undone()).toBe(0)
    expect(screen.onUndo).toHaveBeenCalledTimes(1)
  })

  it('stops once there is nothing left to undo, even if the press never ends', async () => {
    const screen = screenUndo(2)
    const { result } = await renderHook(() => useUndoHold(screen.onUndo, REPEAT_MS))

    await act(async () => result.current.onLongPress())
    await advance(10 * REPEAT_MS)
    expect(screen.undone()).toBe(2)
    expect(screen.onUndo).toHaveBeenCalledTimes(3) // the third was refused, and nothing was asked for after it
  })

  it('a new hold starts its own loop; the old one stops', async () => {
    const screen = screenUndo(10, 250)
    const { result } = await renderHook(() => useUndoHold(screen.onUndo, REPEAT_MS))

    await act(async () => result.current.onLongPress())
    await act(async () => result.current.onLongPress()) // a second long press before the first one's press-out
    expect(screen.calls[0].cancelled?.()).toBe(true)
    expect(screen.calls[1].cancelled?.()).toBe(false)
    await advance(250)
    expect(screen.undone()).toBe(1)
  })

  it('unmounting stops the loop', async () => {
    const screen = screenUndo(10)
    const { result, unmount } = await renderHook(() => useUndoHold(screen.onUndo, REPEAT_MS))

    await act(async () => result.current.onLongPress())
    await advance(0)
    await act(async () => unmount())
    await advance(10 * REPEAT_MS)
    expect(screen.onUndo).toHaveBeenCalledTimes(1)
  })
})
