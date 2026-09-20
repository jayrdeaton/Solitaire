import { act, renderHook } from '@testing-library/react-native'

import { useAutoFinish } from '@/games/shared/useAutoFinish'

interface Props {
  state: string | null
  settled: boolean
}

const STAGGER_MS = 60

// Same conventions as useAutoFoundationCascade.test.tsx: renderHook/rerender are async here (React
// 19's concurrent rendering), and every step is awaited. Timers are faked so the loop's stagger can
// be stepped through deterministically.
function setup(overrides: Partial<Parameters<typeof useAutoFinish<string>>[0]> = {}) {
  const board = { current: 'board-0' as string | null, remaining: 3 }
  const fireNext = jest.fn(async () => {
    board.remaining -= 1
    board.current = `board-${3 - board.remaining}`
    return true
  })
  const enabled = jest.fn(() => true)
  const isBusy = jest.fn(() => false)
  const canFinish = jest.fn(() => board.remaining > 0)
  const render = () =>
    renderHook(
      ({ state, settled }: Props) =>
        useAutoFinish<string>({
          state,
          settled,
          enabled,
          isBusy,
          getState: () => board.current,
          canFinish,
          fireNext,
          staggerMs: STAGGER_MS,
          ...overrides
        }),
      { initialProps: { state: 'board-0', settled: false } as Props }
    )
  return { board, fireNext, enabled, isBusy, canFinish, render }
}

/** Lets the loop's pending promise + timer chain run for `ms` of fake time. */
async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
}

describe('useAutoFinish', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('does not start merely by settling - a player move has to allow it first', async () => {
    const { fireNext, render } = setup()
    const { rerender, unmount } = await render()

    await rerender({ state: 'board-0', settled: true })
    await advance(STAGGER_MS * 5)
    expect(fireNext).not.toHaveBeenCalled()
    await unmount()
  })

  it('once allowed and settled, fires a card every stagger - without waiting for any flight to land - until canFinish runs out', async () => {
    const { fireNext, render } = setup()
    const { result, rerender, unmount } = await render()

    result.current.allow()
    await rerender({ state: 'board-0', settled: true })
    expect(fireNext).toHaveBeenCalledTimes(1) // first card leaves immediately

    await advance(STAGGER_MS)
    expect(fireNext).toHaveBeenCalledTimes(2)
    await advance(STAGGER_MS)
    expect(fireNext).toHaveBeenCalledTimes(3)
    await advance(STAGGER_MS * 5) // board.remaining hit 0 - canFinish is false, the loop ends
    expect(fireNext).toHaveBeenCalledTimes(3)
    await unmount()
  })

  it("does not start until settled, even when allowed (the player's own move has to land first)", async () => {
    const { fireNext, render } = setup()
    const { result, rerender, unmount } = await render()

    result.current.allow()
    await rerender({ state: 'board-1', settled: false })
    await advance(STAGGER_MS * 3)
    expect(fireNext).not.toHaveBeenCalled()

    await rerender({ state: 'board-1', settled: true })
    expect(fireNext).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('does not start while the board is not finishable, and starts later once it is', async () => {
    const { board, fireNext, render } = setup()
    board.remaining = 0 // not finishable yet
    const { result, rerender, unmount } = await render()

    result.current.allow()
    await rerender({ state: 'board-0', settled: true })
    expect(fireNext).not.toHaveBeenCalled()

    board.remaining = 2 // the player's next move made it finishable
    await rerender({ state: 'board-1', settled: true })
    expect(fireNext).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('suppress() stops a running finish, and nothing restarts it until the next allow()', async () => {
    const { board, fireNext, render } = setup()
    board.remaining = 10
    const { result, rerender, unmount } = await render()

    result.current.allow()
    await rerender({ state: 'board-0', settled: true })
    expect(fireNext).toHaveBeenCalledTimes(1)

    result.current.suppress() // an undo, say
    await advance(STAGGER_MS * 4)
    expect(fireNext).toHaveBeenCalledTimes(1) // the loop noticed and ended

    await rerender({ state: 'board-7', settled: true }) // settles onto another finishable board
    expect(fireNext).toHaveBeenCalledTimes(1) // still suppressed

    result.current.allow()
    await rerender({ state: 'board-8', settled: true })
    expect(fireNext).toHaveBeenCalledTimes(2)
    await unmount()
  })

  it('enabled() false never starts it', async () => {
    const { fireNext, render } = setup({ enabled: jest.fn(() => false) })
    const { result, rerender, unmount } = await render()

    result.current.allow()
    await rerender({ state: 'board-0', settled: true })
    await advance(STAGGER_MS * 3)
    expect(fireNext).not.toHaveBeenCalled()
    await unmount()
  })

  it('enabled() flipping false mid-finish ends it at the very next step', async () => {
    const enabled = jest.fn(() => true)
    const { board, fireNext, render } = setup({ enabled })
    board.remaining = 10
    const { result, rerender, unmount } = await render()

    result.current.allow()
    await rerender({ state: 'board-0', settled: true })
    expect(fireNext).toHaveBeenCalledTimes(1)

    enabled.mockReturnValue(false)
    await advance(STAGGER_MS * 4)
    expect(fireNext).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('isBusy() true (an undo in progress) never starts it', async () => {
    const { fireNext, render } = setup({ isBusy: jest.fn(() => true) })
    const { result, rerender, unmount } = await render()

    result.current.allow()
    await rerender({ state: 'board-0', settled: true })
    await advance(STAGGER_MS * 3)
    expect(fireNext).not.toHaveBeenCalled()
    await unmount()
  })

  it('a player move mid-finish that leaves the board unfinishable ends it instead of playing further cards', async () => {
    const { board, fireNext, canFinish, render } = setup()
    board.remaining = 10
    const { result, rerender, unmount } = await render()

    result.current.allow()
    await rerender({ state: 'board-0', settled: true })
    expect(fireNext).toHaveBeenCalledTimes(1)

    canFinish.mockReturnValue(false)
    await advance(STAGGER_MS * 4)
    expect(fireNext).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('gives up after three consecutive misses rather than retrying forever, and stays given up', async () => {
    const fireNext = jest.fn(async () => false)
    const { board, render } = setup({ fireNext })
    board.remaining = 10
    const { result, rerender, unmount } = await render()

    result.current.allow()
    await rerender({ state: 'board-0', settled: true })
    await advance(STAGGER_MS * 10)
    expect(fireNext).toHaveBeenCalledTimes(3)

    await rerender({ state: 'board-1', settled: true }) // another settle - still given up
    expect(fireNext).toHaveBeenCalledTimes(3)
    await unmount()
  })

  it('a hit between misses resets the count', async () => {
    const results = [false, false, true, false, false, true]
    const fireNext = jest.fn(async () => results.shift() ?? false)
    const { board, render } = setup({ fireNext })
    board.remaining = 100
    const { result, rerender, unmount } = await render()

    result.current.allow()
    await rerender({ state: 'board-0', settled: true })
    await advance(STAGGER_MS * 20)
    // miss, miss, HIT (count back to 0), miss, miss, HIT (0 again), then every later call misses: three more, then it
    // gives up. Without the reset it would have given up on the 4th call (3 misses in total, hits or not).
    expect(fireNext).toHaveBeenCalledTimes(9)
    await unmount()
  })

  it('isBusy() turning true mid-finish (an undo started) ends it at the very next step', async () => {
    const isBusy = jest.fn(() => false)
    const { board, fireNext, render } = setup({ isBusy })
    board.remaining = 10
    const { result, rerender, unmount } = await render()

    result.current.allow()
    await rerender({ state: 'board-0', settled: true })
    expect(fireNext).toHaveBeenCalledTimes(1)

    isBusy.mockReturnValue(true)
    await advance(STAGGER_MS * 4)
    expect(fireNext).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('a re-render mid-finish (the board committed, a flight landed) does not start a second loop alongside the first', async () => {
    const { board, fireNext, render } = setup()
    board.remaining = 50
    const { result, rerender, unmount } = await render()

    result.current.allow()
    await rerender({ state: 'board-0', settled: true })
    expect(fireNext).toHaveBeenCalledTimes(1)

    // What the screen does after every card: the board changes and `settled` flips false then true again.
    await rerender({ state: 'board-1', settled: false })
    await rerender({ state: 'board-1', settled: true })
    expect(fireNext).toHaveBeenCalledTimes(1) // still the one loop, still waiting out its stagger

    await advance(STAGGER_MS)
    expect(fireNext).toHaveBeenCalledTimes(2)
    await advance(STAGGER_MS)
    expect(fireNext).toHaveBeenCalledTimes(3) // one card per stagger, not two loops' worth
    await unmount()
  })

  it('hands each step the LIVE board (getState), not the one the last render saw', async () => {
    const seen: string[] = []
    const fireNext = jest.fn(async (s: string) => {
      seen.push(s)
      board.remaining -= 1
      board.current = `board-${3 - board.remaining}`
      return true
    })
    const { board, render } = setup({ fireNext })
    const { result, rerender, unmount } = await render()

    result.current.allow()
    await rerender({ state: 'board-0', settled: true }) // no further renders after this one
    await advance(STAGGER_MS * 5)

    expect(seen).toEqual(['board-0', 'board-1', 'board-2'])
    await unmount()
  })

  it('reads the newest config at every step - a fresh enabled/getState/staggerMs closure passed on a re-render is seen mid-finish', async () => {
    interface FreshProps {
      state: string | null
      settled: boolean
      enabled: () => boolean
      staggerMs: number
    }
    const fireNext = jest.fn(async () => true)
    const { result, rerender, unmount } = await renderHook(({ state, settled, enabled, staggerMs }: FreshProps) => useAutoFinish<string>({ state, settled, enabled, isBusy: () => false, getState: () => 'live', canFinish: () => true, fireNext, staggerMs }), { initialProps: { state: 'board-0', settled: false, enabled: () => true, staggerMs: STAGGER_MS } as FreshProps })

    result.current.allow()
    await rerender({ state: 'board-0', settled: true, enabled: () => true, staggerMs: STAGGER_MS })
    expect(fireNext).toHaveBeenCalledTimes(1)

    // A brand-new closure now says "off": the loop must notice at its next step.
    await rerender({ state: 'board-0', settled: true, enabled: () => false, staggerMs: STAGGER_MS })
    await advance(STAGGER_MS * 4)
    expect(fireNext).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('a newly passed staggerMs takes effect at the next wait', async () => {
    const fireNext = jest.fn(async () => true)
    const { result, rerender, unmount } = await renderHook(({ state, settled, staggerMs }: { state: string | null; settled: boolean; staggerMs: number }) => useAutoFinish<string>({ state, settled, enabled: () => true, isBusy: () => false, getState: () => 'live', canFinish: () => true, fireNext, staggerMs }), { initialProps: { state: 'board-0', settled: false, staggerMs: STAGGER_MS } as { state: string | null; settled: boolean; staggerMs: number } })
    result.current.allow()
    await rerender({ state: 'board-0', settled: true, staggerMs: 1000 })
    expect(fireNext).toHaveBeenCalledTimes(1)
    await advance(STAGGER_MS * 3)
    expect(fireNext).toHaveBeenCalledTimes(1) // waiting out the new, longer stagger
    await advance(1000)
    expect(fireNext).toHaveBeenCalledTimes(2)
    await unmount()
  })

  it('does not start with no board rendered yet, even if the live board is finishable', async () => {
    const { fireNext, render } = setup()
    const { result, rerender, unmount } = await render()

    result.current.allow()
    await rerender({ state: null, settled: true }) // getState() still answers 'board-0'
    await advance(STAGGER_MS * 3)
    expect(fireNext).not.toHaveBeenCalled()
    await unmount()
  })

  it('stops when the screen unmounts', async () => {
    const { board, fireNext, render } = setup()
    board.remaining = 10
    const { result, rerender, unmount } = await render()

    result.current.allow()
    await rerender({ state: 'board-0', settled: true })
    expect(fireNext).toHaveBeenCalledTimes(1)

    await unmount()
    await advance(STAGGER_MS * 5)
    expect(fireNext).toHaveBeenCalledTimes(1)
  })

  it('isAllowed() reflects allow(), suppress() and a give-up, so a fireNext that awaited can re-check before firing', async () => {
    const { render } = setup()
    const { result, unmount } = await render()

    expect(result.current.isAllowed()).toBe(false)
    result.current.allow()
    expect(result.current.isAllowed()).toBe(true)
    result.current.suppress()
    expect(result.current.isAllowed()).toBe(false)
    await unmount()
  })

  it('a suppress() that lands while a step is still awaiting ends the finish after that step - nothing further fires', async () => {
    let releaseStep: () => void = () => {}
    const fireNext = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          releaseStep = () => resolve(true)
        })
    )
    const { board, render } = setup({ fireNext })
    board.remaining = 10
    const { result, rerender, unmount } = await render()

    result.current.allow()
    await rerender({ state: 'board-0', settled: true })
    expect(fireNext).toHaveBeenCalledTimes(1)

    result.current.suppress() // an undo, while the last-card wait inside fireNext is still running
    await act(async () => releaseStep())
    await advance(STAGGER_MS * 4)
    expect(fireNext).toHaveBeenCalledTimes(1)
    await unmount()
  })
})
