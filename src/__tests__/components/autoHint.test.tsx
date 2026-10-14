import { act, render } from '@testing-library/react-native'
import { AppState } from 'react-native'

import { HintHandler, useAutoHint } from '@/components/autoHint'

// The Auto Hint setting: a hint shows by itself once the board has sat unchanged for the chosen time, counted exactly like
// a pressed one (the screen's own handler does the counting; this only decides when to call it).

function Harness(props: { seconds: number; boardKey: unknown; paused?: boolean; hintShowing?: boolean; onHint: HintHandler }) {
  useAutoHint({ seconds: props.seconds, boardKey: props.boardKey, paused: props.paused ?? false, hintShowing: props.hintShowing ?? false, onHint: props.onHint })
  return null
}

describe('useAutoHint', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('asks for a hint, marked auto, once the board has sat unchanged for the setting', async () => {
    const onHint = jest.fn()
    await render(<Harness seconds={15} boardKey='a' onHint={onHint} />)
    await act(async () => jest.advanceTimersByTime(14_900))
    expect(onHint).not.toHaveBeenCalled()
    await act(async () => jest.advanceTimersByTime(200))
    expect(onHint).toHaveBeenCalledTimes(1)
    expect(onHint).toHaveBeenCalledWith({ auto: true })
  })

  it('never fires when the setting is off', async () => {
    const onHint = jest.fn()
    await render(<Harness seconds={0} boardKey='a' onHint={onHint} />)
    await act(async () => jest.advanceTimersByTime(120_000))
    expect(onHint).not.toHaveBeenCalled()
  })

  it('starts the wait over on every board change', async () => {
    const onHint = jest.fn()
    const view = await render(<Harness seconds={15} boardKey='a' onHint={onHint} />)
    await act(async () => jest.advanceTimersByTime(10_000))
    await view.rerender(<Harness seconds={15} boardKey='b' onHint={onHint} />)
    await act(async () => jest.advanceTimersByTime(10_000))
    expect(onHint).not.toHaveBeenCalled() // 20s since the deal, but only 10s since the last move
    await act(async () => jest.advanceTimersByTime(5_100))
    expect(onHint).toHaveBeenCalledTimes(1)
  })

  it('holds back while a hint is already showing or a dialog is open, and starts the wait over after', async () => {
    const onHint = jest.fn()
    const view = await render(<Harness seconds={15} boardKey='a' hintShowing onHint={onHint} />)
    await act(async () => jest.advanceTimersByTime(30_000))
    await view.rerender(<Harness seconds={15} boardKey='a' paused onHint={onHint} />)
    await act(async () => jest.advanceTimersByTime(30_000))
    expect(onHint).not.toHaveBeenCalled()
    await view.rerender(<Harness seconds={15} boardKey='a' onHint={onHint} />)
    await act(async () => jest.advanceTimersByTime(14_000))
    expect(onHint).not.toHaveBeenCalled() // never the instant the dialog closes
    await act(async () => jest.advanceTimersByTime(1_100))
    expect(onHint).toHaveBeenCalledTimes(1)
  })

  it('asks once per board: with nothing to suggest it waits for the next change instead of asking every 15s', async () => {
    const onHint = jest.fn() // a board with no move: the handler shows nothing, so no hint is ever showing
    const view = await render(<Harness seconds={15} boardKey='a' onHint={onHint} />)
    await act(async () => jest.advanceTimersByTime(60_000))
    expect(onHint).toHaveBeenCalledTimes(1)
    await view.rerender(<Harness seconds={15} boardKey='b' onHint={onHint} />)
    await act(async () => jest.advanceTimersByTime(15_100))
    expect(onHint).toHaveBeenCalledTimes(2)
  })

  it('holds back while the app is in the background', async () => {
    let emit: (state: string) => void = () => {}
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      emit = listener as (state: string) => void
      return { remove: () => {} } as ReturnType<typeof AppState.addEventListener>
    })
    const onHint = jest.fn()
    await render(<Harness seconds={15} boardKey='a' onHint={onHint} />)
    await act(async () => emit('background'))
    await act(async () => jest.advanceTimersByTime(60_000))
    expect(onHint).not.toHaveBeenCalled()
    await act(async () => emit('active'))
    await act(async () => jest.advanceTimersByTime(15_100))
    expect(onHint).toHaveBeenCalledTimes(1)
  })
})
