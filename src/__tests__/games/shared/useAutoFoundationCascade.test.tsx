import { renderHook } from '@testing-library/react-native'

import { AccessibleCard, PileRef } from '@/engine/gameTypes'
import { useAutoFoundationCascade } from '@/games/shared/useAutoFoundationCascade'

const PLAY_ENTRY: AccessibleCard = { ref: { zone: 'tableau', index: 0 }, card: { id: 'hearts-5-0', suit: 'hearts', rank: 5, faceUp: true } }
const PLAY_TO: PileRef = { zone: 'foundation', index: 2 }
const STEP_PLAY = { kind: 'play' as const, entry: PLAY_ENTRY, to: PLAY_TO }

const ACE_ENTRY: AccessibleCard = { ref: { zone: 'waste', index: 0 }, card: { id: 'clubs-1-0', suit: 'clubs', rank: 1, faceUp: true } }
const ACE_TO: PileRef = { zone: 'foundation', index: 0 }

interface Props {
  state: string | null
  settled: boolean
}

// renderHook/rerender are async in this @testing-library/react-native version (React 19's
// concurrent rendering) - every render step below must be awaited, same convention as
// useDeferredDeal.test.tsx.
describe('useAutoFoundationCascade', () => {
  it('does not fire merely by settling, without being armed first', async () => {
    const firePlay = jest.fn()
    const computeNextStep = jest.fn(() => STEP_PLAY)
    const enabled = jest.fn(() => true)
    const isBusy = jest.fn(() => false)
    const { rerender, unmount } = await renderHook(({ state, settled }: Props) => useAutoFoundationCascade({ state, settled, enabled, isBusy, computeNextStep, firePlay }), { initialProps: { state: 's0', settled: false } })

    await rerender({ state: 's0', settled: true })
    expect(firePlay).not.toHaveBeenCalled()
    await unmount()
  })

  it('fires the first step once armed and settled', async () => {
    const firePlay = jest.fn()
    const computeNextStep = jest.fn(() => STEP_PLAY)
    const enabled = jest.fn(() => true)
    const isBusy = jest.fn(() => false)
    const { result, rerender, unmount } = await renderHook(({ state, settled }: Props) => useAutoFoundationCascade({ state, settled, enabled, isBusy, computeNextStep, firePlay }), { initialProps: { state: 's0', settled: false } })

    result.current.armFromForwardMove()
    await rerender({ state: 's0', settled: true }) // settled flips false -> true: a real dep change
    expect(firePlay).toHaveBeenCalledTimes(1)
    expect(firePlay).toHaveBeenCalledWith(STEP_PLAY.entry, STEP_PLAY.to, { sweep: false })
    await unmount()
  })

  it('armFromAceEvent fires the pinned entry first (skipping computeNextStep entirely), then continues the cascade normally', async () => {
    const firePlay = jest.fn()
    const computeNextStep = jest.fn().mockReturnValueOnce(STEP_PLAY).mockReturnValueOnce(null)
    const enabled = jest.fn(() => true)
    const isBusy = jest.fn(() => false)
    const { result, rerender, unmount } = await renderHook(({ state, settled }: Props) => useAutoFoundationCascade({ state, settled, enabled, isBusy, computeNextStep, firePlay }), { initialProps: { state: 's0', settled: false } })

    result.current.armFromAceEvent(ACE_ENTRY, ACE_TO)
    await rerender({ state: 's0', settled: true })
    expect(firePlay).toHaveBeenNthCalledWith(1, ACE_ENTRY, ACE_TO, { sweep: false })
    expect(computeNextStep).not.toHaveBeenCalled() // the pin short-circuits the scan on this first check

    await rerender({ state: 's1', settled: true }) // next settle, after the ace's own flight lands
    expect(computeNextStep).toHaveBeenCalledTimes(1)
    expect(firePlay).toHaveBeenNthCalledWith(2, STEP_PLAY.entry, STEP_PLAY.to, { sweep: false })
    await unmount()
  })

  it('disarms once computeNextStep runs dry, and does not restart without a fresh arm call', async () => {
    const firePlay = jest.fn()
    const computeNextStep = jest.fn(() => null)
    const enabled = jest.fn(() => true)
    const isBusy = jest.fn(() => false)
    const { result, rerender, unmount } = await renderHook(({ state, settled }: Props) => useAutoFoundationCascade({ state, settled, enabled, isBusy, computeNextStep, firePlay }), { initialProps: { state: 's0', settled: false } })

    result.current.armFromForwardMove()
    await rerender({ state: 's0', settled: true })
    expect(computeNextStep).toHaveBeenCalledTimes(1)
    expect(firePlay).not.toHaveBeenCalled()

    await rerender({ state: 's1', settled: true }) // another settle, still no fresh arm call
    expect(computeNextStep).toHaveBeenCalledTimes(1) // stayed disarmed - never re-checked
    await unmount()
  })

  it('enabled() returning false suppresses firing even while armed and settled', async () => {
    const firePlay = jest.fn()
    const computeNextStep = jest.fn(() => STEP_PLAY)
    const enabled = jest.fn(() => false)
    const isBusy = jest.fn(() => false)
    const { result, rerender, unmount } = await renderHook(({ state, settled }: Props) => useAutoFoundationCascade({ state, settled, enabled, isBusy, computeNextStep, firePlay }), { initialProps: { state: 's0', settled: false } })

    result.current.armFromForwardMove()
    await rerender({ state: 's0', settled: true })
    expect(firePlay).not.toHaveBeenCalled()
    await unmount()
  })

  it('isBusy() returning true suppresses firing even while armed and settled', async () => {
    const firePlay = jest.fn()
    const computeNextStep = jest.fn(() => STEP_PLAY)
    const enabled = jest.fn(() => true)
    const isBusy = jest.fn(() => true)
    const { result, rerender, unmount } = await renderHook(({ state, settled }: Props) => useAutoFoundationCascade({ state, settled, enabled, isBusy, computeNextStep, firePlay }), { initialProps: { state: 's0', settled: false } })

    result.current.armFromForwardMove()
    await rerender({ state: 's0', settled: true })
    expect(firePlay).not.toHaveBeenCalled()
    await unmount()
  })

  it('latches sweep:true onto every subsequent step once a draw/drawAndPlay step occurs, even a later plain play', async () => {
    const firePlay = jest.fn()
    const fireDraw = jest.fn()
    const computeNextStep = jest
      .fn()
      .mockReturnValueOnce({ kind: 'draw' as const })
      .mockReturnValueOnce(STEP_PLAY) // arrives after the draw - should still be sweep-speed
      .mockReturnValueOnce(null)
    const enabled = jest.fn(() => true)
    const isBusy = jest.fn(() => false)
    const { result, rerender, unmount } = await renderHook(({ state, settled }: Props) => useAutoFoundationCascade({ state, settled, enabled, isBusy, computeNextStep, firePlay, fireDraw }), { initialProps: { state: 's0', settled: false } })

    result.current.armFromForwardMove()
    await rerender({ state: 's0', settled: true })
    expect(fireDraw).toHaveBeenCalledWith({ sweep: true })

    await rerender({ state: 's1', settled: true })
    expect(firePlay).toHaveBeenCalledWith(STEP_PLAY.entry, STEP_PLAY.to, { sweep: true })

    await rerender({ state: 's2', settled: true }) // disarms
    await unmount()
  })
})
