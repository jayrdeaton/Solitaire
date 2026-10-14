import { act, renderHook } from '@testing-library/react-native'
import { AppState } from 'react-native'

import { useGameSession } from '@/components/useGameSession'
import { useSaveInProgressBackstop } from '@/games/shared/useSaveInProgress'

jest.mock('@/stores/gameInProgress', () => ({ flushGameInProgress: jest.fn(() => Promise.resolve()) }))

// The score is moves plus seconds of PLAY: the clock starts with the first move, pauses while the app is out of the
// foreground, and a resumed deal gets back the time it had when it was left, not the time of its last save.

let listeners: ((state: string) => void)[] = []

beforeEach(() => {
  jest.useFakeTimers()
  listeners = []
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    listeners.push(listener as (state: string) => void)
    return { remove: () => (listeners = listeners.filter((l) => l !== listener)) } as ReturnType<typeof AppState.addEventListener>
  })
})

afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
})

const emit = (state: string) => act(() => listeners.forEach((l) => l(state)))
const wait = (ms: number) => act(() => jest.advanceTimersByTime(ms))

describe('useGameSession', () => {
  it('starts the clock on the first move, not before', async () => {
    const { result } = await renderHook(() => useGameSession())
    await wait(5000)
    expect(result.current.getElapsed()).toBe(0)
    await act(() => void result.current.registerMove())
    await wait(3000)
    expect(result.current.getElapsed()).toBe(3)
  })

  it('pauses while the app is in the background and picks up on return', async () => {
    const { result } = await renderHook(() => useGameSession())
    await act(() => void result.current.registerMove())
    await wait(4000)
    await emit('background')
    await wait(600_000)
    expect(result.current.getElapsed()).toBe(4)
    await emit('active')
    await wait(2000)
    expect(result.current.getElapsed()).toBe(6)
  })

  it('keeps the part-second a pause lands in', async () => {
    const { result } = await renderHook(() => useGameSession())
    await act(() => void result.current.registerMove())
    for (let i = 0; i < 4; i++) {
      await wait(500)
      await emit('inactive')
      await emit('active')
    }
    expect(result.current.getElapsed()).toBe(2)
  })

  it('does not start a clock that has not started, or restart a stopped one, on return', async () => {
    const { result } = await renderHook(() => useGameSession())
    await emit('background')
    await emit('active')
    await wait(3000)
    expect(result.current.getElapsed()).toBe(0)
    await act(() => void result.current.registerMove())
    await wait(2000)
    await act(() => result.current.stopClock())
    await emit('background')
    await emit('active')
    await wait(5000)
    expect(result.current.getElapsed()).toBe(2)
  })

  it('holds the clock while any reason holds it, a dialog and the app alike', async () => {
    const { result } = await renderHook(() => useGameSession())
    await act(() => void result.current.registerMove())
    await wait(1000)
    await act(() => result.current.setPaused('dialog', true))
    await wait(30_000)
    await emit('background')
    await act(() => result.current.setPaused('dialog', false))
    await wait(30_000)
    expect(result.current.getElapsed()).toBe(1)
    await emit('active')
    await wait(2000)
    expect(result.current.getElapsed()).toBe(3)
  })

  it('a first move made while held starts the clock held', async () => {
    const { result } = await renderHook(() => useGameSession())
    await act(() => result.current.setPaused('dialog', true))
    await act(() => void result.current.registerMove())
    await wait(5000)
    expect(result.current.getElapsed()).toBe(0)
    await act(() => result.current.setPaused('dialog', false))
    await wait(2000)
    expect(result.current.getElapsed()).toBe(2)
  })

  it('getMoves is the live count, ahead of a render that closed over the old one', async () => {
    const { result } = await renderHook(() => useGameSession())
    const closedOver = result.current
    await act(() => void result.current.registerMove())
    await act(() => void result.current.registerMove())
    expect(closedOver.moves).toBe(0)
    expect(closedOver.getMoves()).toBe(2)
  })
})

describe('useSaveInProgressBackstop', () => {
  it('saves afresh when the screen is left, so a resume gets the time it was left at', async () => {
    const save = jest.fn()
    const { unmount } = await renderHook(() => useSaveInProgressBackstop(true, save))
    await wait(9000)
    expect(save).not.toHaveBeenCalled()
    await act(() => unmount())
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('saves afresh when the app leaves the foreground', async () => {
    const save = jest.fn()
    await renderHook(() => useSaveInProgressBackstop(true, save))
    await emit('background')
    expect(save).toHaveBeenCalledTimes(1)
    await emit('active')
    expect(save).toHaveBeenCalledTimes(1)
  })
})
