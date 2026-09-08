import { renderHook } from '@testing-library/react-native'

import { useDeferredDeal } from '@/games/shared/useDeferredDeal'

// Encodes the exact race this hook guards against (see its own doc comment and this project's
// .claude/CLAUDE.md): a naive "measure right after setState" deal implementation returned null
// for 25 of 28 destinations in production. These cases pin down that the fix's actual decision
// logic - not just "it compiles" - holds for a normal deal and for the two supersession races.
// renderHook/rerender are async in this @testing-library/react-native version (React 19's
// concurrent rendering) - every render step below must be awaited.
describe('useDeferredDeal', () => {
  it('fires runDeal once state commits, with the token that was scheduled', async () => {
    const runDeal = jest.fn()
    const genRef = { current: 1 }
    const { result, rerender, unmount } = await renderHook(({ state }: { state: string | null }) => useDeferredDeal(state, genRef, runDeal), { initialProps: { state: null as string | null } })

    result.current(1)
    await rerender({ state: 'dealt' })

    expect(runDeal).toHaveBeenCalledTimes(1)
    expect(runDeal).toHaveBeenCalledWith('dealt', 1)
    await unmount()
  })

  it('never fires if a restore (which never schedules) bumps the generation before state commits', async () => {
    const runDeal = jest.fn()
    const genRef = { current: 1 }
    const { result, rerender, unmount } = await renderHook(({ state }: { state: string | null }) => useDeferredDeal(state, genRef, runDeal), { initialProps: { state: null as string | null } })

    result.current(1) // a startNewGame schedules a deal for generation 1...
    genRef.current = 2 // ...but a restoreGame supersedes it first, without scheduling anything
    await rerender({ state: 'restored' })

    expect(runDeal).not.toHaveBeenCalled()
    await unmount()
  })

  it('when two deals are scheduled before either commits, only the later one fires', async () => {
    const runDeal = jest.fn()
    const genRef = { current: 1 }
    const { result, rerender, unmount } = await renderHook(({ state }: { state: string | null }) => useDeferredDeal(state, genRef, runDeal), { initialProps: { state: null as string | null } })

    result.current(1) // first rapid "New Game" tap
    genRef.current = 2
    result.current(2) // second rapid "New Game" tap, before the first ever committed
    await rerender({ state: 'second-deal' })

    expect(runDeal).toHaveBeenCalledTimes(1)
    expect(runDeal).toHaveBeenCalledWith('second-deal', 2)
    await unmount()
  })

  it('does not re-fire on a later render that leaves state unchanged', async () => {
    const runDeal = jest.fn()
    const genRef = { current: 1 }
    const { result, rerender, unmount } = await renderHook(({ state }: { state: string | null }) => useDeferredDeal(state, genRef, runDeal), { initialProps: { state: null as string | null } })

    result.current(1)
    await rerender({ state: 'dealt' })
    expect(runDeal).toHaveBeenCalledTimes(1)

    await rerender({ state: 'dealt' })
    expect(runDeal).toHaveBeenCalledTimes(1)
    await unmount()
  })
})
