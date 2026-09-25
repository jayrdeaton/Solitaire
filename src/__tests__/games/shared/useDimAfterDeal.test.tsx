import { act, renderHook } from '@testing-library/react-native'

import { DEAL_DIM_MAX_HOLD_MS, DEAL_DIM_SETTLE_MS, useDimAfterDeal } from '@/games/shared/useDimAfterDeal'

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
}

// renderHook/act are async in this @testing-library/react-native version - same convention as useWinReveal.test.tsx.
describe('useDimAfterDeal', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('dims nothing while a deal is in the air, then the whole board at once, a beat after it lands', async () => {
    const { result, unmount } = await renderHook(() => useDimAfterDeal())
    expect(result.current.held).toBe(false)

    await act(async () => result.current.hold())
    expect(result.current.held).toBe(true)
    await advance(DEAL_DIM_MAX_HOLD_MS - 1000) // however long the deal takes
    expect(result.current.held).toBe(true)

    await act(async () => result.current.release()) // the last card has landed
    await advance(DEAL_DIM_SETTLE_MS - 1)
    expect(result.current.held).toBe(true)
    await advance(1)
    expect(result.current.held).toBe(false)
    await unmount()
  })

  it('a resumed board dims at once', async () => {
    const { result, unmount } = await renderHook(() => useDimAfterDeal())
    await act(async () => result.current.hold())

    await act(async () => result.current.releaseNow())
    expect(result.current.held).toBe(false)
    await unmount()
  })

  it('a New Game in the beat after a deal lands keeps holding for the new deal', async () => {
    const { result, unmount } = await renderHook(() => useDimAfterDeal())
    await act(async () => result.current.hold())
    await act(async () => result.current.release())
    await advance(DEAL_DIM_SETTLE_MS / 2)

    await act(async () => result.current.hold()) // the next deal starts before the first one's release fired
    await advance(DEAL_DIM_SETTLE_MS * 2)
    expect(result.current.held).toBe(true) // the stale release must not dim the new deal mid-flight
    await unmount()
  })

  it('still dims if a deal never reports that it landed', async () => {
    const { result, unmount } = await renderHook(() => useDimAfterDeal())
    await act(async () => result.current.hold())

    await advance(DEAL_DIM_MAX_HOLD_MS - 1)
    expect(result.current.held).toBe(true)
    await advance(1)
    expect(result.current.held).toBe(false)
    await unmount()
  })
})
