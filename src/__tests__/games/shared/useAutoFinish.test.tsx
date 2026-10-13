import { act, renderHook } from '@testing-library/react-native'

import { AUTO_PLAY_STAGGER_MS, FINISH_STAGGER_MS } from '@/components/dragdrop/dragSpring'
import { FinishMove } from '@/engine/autoFoundation'
import { AccessibleCard, PileRef } from '@/engine/gameTypes'
import { AutoFinish, FINISH_LANDING_WAIT_MS, useAutoFinish } from '@/games/shared/useAutoFinish'

interface Props {
  state: string | null
}

type Config = Parameters<typeof useAutoFinish<string>>[0]

const STAGGER_MS = 60
const FOUNDATION: PileRef = { zone: 'foundation', index: 1 }
const COLUMN: PileRef = { zone: 'tableau', index: 2 }

/** The card the stand-in board would send up next: one per remaining card, each from its own column. */
function moveFor(remaining: number): FinishMove {
  return { entry: { ref: { zone: 'tableau', index: remaining }, card: { id: `card-${remaining}`, suit: 'spades', rank: 1, faceUp: true } }, to: FOUNDATION }
}

// Same conventions as useAutoFoundationCascade.test.tsx: renderHook/rerender are async here (React
// 19's concurrent rendering), and every step is awaited. Timers are faked so the loop's stagger can
// be stepped through deterministically.
function setup(overrides: Partial<Config> = {}) {
  const board = { current: 'board-0' as string | null, remaining: 3 }
  const firePlay = jest.fn(async (_entry: AccessibleCard, _to: PileRef, _stillWanted: () => boolean) => {
    board.remaining -= 1
    board.current = `board-${3 - board.remaining}`
    return true
  })
  const enabled = jest.fn(() => true)
  const isBusy = jest.fn(() => false)
  const isLanding = jest.fn((_pile: PileRef) => false)
  const canFinish = jest.fn((_s: string) => board.remaining > 0)
  const nextMove = jest.fn((_s: string) => moveFor(board.remaining))
  const render = () =>
    renderHook(
      ({ state }: Props) =>
        useAutoFinish<string>({
          state,
          enabled,
          isBusy,
          getState: () => board.current,
          canFinish,
          nextMove,
          isLanding,
          firePlay,
          staggerMs: STAGGER_MS,
          ...overrides
        }),
      { initialProps: { state: 'board-0' } as Props }
    )
  return { board, firePlay, enabled, isBusy, isLanding, canFinish, nextMove, render }
}

/** Lets the loop's pending promise + timer chain run for `ms` of fake time. */
async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
}

/** What the screen does on a player's move (from a column, to any pile, unless `from` says otherwise): afterPlayerMove in the same
 * breath as the move's commit, so the next render has a new board. */
async function playerMove(finish: AutoFinish, rerender: (props: Props) => Promise<void>, state = 'move-1', from: PileRef = COLUMN) {
  finish.afterPlayerMove(from)
  await rerender({ state })
}

describe('useAutoFinish', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('defaults to FINISH_STAGGER_MS, half the auto-play gap, and keeps the flight time the same (the gap is the only pace knob)', async () => {
    expect(FINISH_STAGGER_MS).toBe(AUTO_PLAY_STAGGER_MS / 2)
    const { firePlay, render } = setup({ staggerMs: undefined })
    const { result, rerender, unmount } = await render()

    await playerMove(result.current, rerender)
    await advance(FINISH_STAGGER_MS - 1)
    expect(firePlay).not.toHaveBeenCalled()
    await advance(1)
    expect(firePlay).toHaveBeenCalledTimes(1)
    await advance(FINISH_STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(2)
    await unmount()
  })

  it('does not start merely because the board changed - a player move has to allow it first', async () => {
    const { firePlay, render } = setup()
    const { rerender, unmount } = await render()

    await rerender({ state: 'board-1' })
    await advance(STAGGER_MS * 5)
    expect(firePlay).not.toHaveBeenCalled()
    await unmount()
  })

  it("once allowed, the first card follows the player's move one stagger later (without waiting for it to land), then one every stagger until canFinish runs out", async () => {
    const { firePlay, render } = setup()
    const { result, rerender, unmount } = await render()

    await playerMove(result.current, rerender)
    await advance(STAGGER_MS - 1)
    expect(firePlay).not.toHaveBeenCalled()
    await advance(1)
    expect(firePlay).toHaveBeenCalledTimes(1)

    await advance(STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(2)
    await advance(STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(3)
    await advance(STAGGER_MS * 5) // board.remaining hit 0 - canFinish is false, the loop ends
    expect(firePlay).toHaveBeenCalledTimes(3)
    await unmount()
  })

  it('hands firePlay the move nextMove picked from the live board, plus a stillWanted check that follows the finish', async () => {
    const { firePlay, render } = setup()
    const { result, rerender, unmount } = await render()

    await playerMove(result.current, rerender)
    await advance(STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(1)
    const [entry, to, stillWanted] = firePlay.mock.calls[0]
    expect(entry).toEqual(moveFor(3).entry)
    expect(to).toEqual(FOUNDATION)
    expect(stillWanted()).toBe(true)
    result.current.suppress()
    expect(stillWanted()).toBe(false)
    await unmount()
  })

  it("starts after the player's move to a column that leaves the board solved - any move counts, not just a foundation play", async () => {
    const { board, firePlay, render } = setup()
    board.remaining = 0 // not solved yet
    const { result, rerender, unmount } = await render()

    await playerMove(result.current, rerender)
    await advance(STAGGER_MS * 3)
    expect(firePlay).not.toHaveBeenCalled()

    board.remaining = 2 // the player's column move (or a freecell move: the hook never sees the destination) solved it
    await playerMove(result.current, rerender, 'move-2')
    await advance(STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('starts when the cascade a foundation play set off (a board change, no further player move) makes the board solved', async () => {
    const { board, firePlay, render } = setup()
    board.remaining = 0
    const { result, rerender, unmount } = await render()

    await playerMove(result.current, rerender)
    await advance(STAGGER_MS * 3)
    expect(firePlay).not.toHaveBeenCalled()

    board.remaining = 2 // one of that play's auto-played cards solved it
    await rerender({ state: 'cascade-1' })
    await advance(STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('a player move mid-finish that keeps the board solved neither stops it nor starts a second loop', async () => {
    const { board, firePlay, render } = setup()
    board.remaining = 10
    const { result, rerender, unmount } = await render()

    await playerMove(result.current, rerender)
    await advance(STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(1)

    await playerMove(result.current, rerender, 'move-2') // a card to a freecell, say: still solved
    await advance(STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(2)
    await advance(STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(3)
    await unmount()
  })

  it('once a finish has ended, a later board change does not start another without a fresh player move', async () => {
    const { board, firePlay, render } = setup()
    const { result, rerender, unmount } = await render()

    await playerMove(result.current, rerender)
    await advance(STAGGER_MS * 6) // all three cards, then canFinish runs out
    expect(firePlay).toHaveBeenCalledTimes(3)
    expect(result.current.isAllowed()).toBe(false)

    board.remaining = 2 // solved again (an undo's earlier board, say) - but no player move
    await rerender({ state: 'board-x' })
    await advance(STAGGER_MS * 3)
    expect(firePlay).toHaveBeenCalledTimes(3)
    await unmount()
  })

  it('suppress() stops a running finish, and nothing restarts it until the next player move - to any pile', async () => {
    const { board, firePlay, render } = setup()
    board.remaining = 10
    const { result, rerender, unmount } = await render()

    await playerMove(result.current, rerender)
    await advance(STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(1)

    result.current.suppress() // an undo, say
    await advance(STAGGER_MS * 4)
    expect(firePlay).toHaveBeenCalledTimes(1) // the loop noticed and ended

    await rerender({ state: 'board-7' }) // still solved (undoing a card off a solved board leaves it solved), no player move
    await advance(STAGGER_MS * 2)
    expect(firePlay).toHaveBeenCalledTimes(1) // still suppressed: the undone card does not fly straight back up

    await playerMove(result.current, rerender, 'move-2')
    await advance(STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(2)
    await unmount()
  })

  it('a suppress() inside the first gap means no card goes at all', async () => {
    const { firePlay, render } = setup()
    const { result, rerender, unmount } = await render()

    await playerMove(result.current, rerender)
    await advance(STAGGER_MS / 2)
    result.current.suppress()
    await advance(STAGGER_MS * 3)
    expect(firePlay).not.toHaveBeenCalled()
    await unmount()
  })

  it('enabled() false never starts it - nor does turning it back on, without a fresh player move', async () => {
    const enabled = jest.fn(() => false)
    const { firePlay, render } = setup({ enabled })
    const { result, rerender, unmount } = await render()

    await playerMove(result.current, rerender)
    await advance(STAGGER_MS * 3)
    expect(firePlay).not.toHaveBeenCalled()

    enabled.mockReturnValue(true)
    await rerender({ state: 'board-x' })
    await advance(STAGGER_MS * 3)
    expect(firePlay).not.toHaveBeenCalled()
    await unmount()
  })

  it('enabled() flipping false mid-finish ends it at the very next step', async () => {
    const enabled = jest.fn(() => true)
    const { board, firePlay, render } = setup({ enabled })
    board.remaining = 10
    const { result, rerender, unmount } = await render()

    await playerMove(result.current, rerender)
    await advance(STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(1)

    enabled.mockReturnValue(false)
    await advance(STAGGER_MS * 4)
    expect(firePlay).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('isBusy() true (an undo in progress) never starts it', async () => {
    const { firePlay, render } = setup({ isBusy: jest.fn(() => true) })
    const { result, rerender, unmount } = await render()

    await playerMove(result.current, rerender)
    await advance(STAGGER_MS * 3)
    expect(firePlay).not.toHaveBeenCalled()
    await unmount()
  })

  it('a player move mid-finish that leaves the board unsolved ends it instead of playing further cards', async () => {
    const { board, firePlay, canFinish, render } = setup()
    board.remaining = 10
    const { result, rerender, unmount } = await render()

    await playerMove(result.current, rerender)
    await advance(STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(1)

    canFinish.mockReturnValue(false)
    await advance(STAGGER_MS * 4)
    expect(firePlay).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('gives up after three consecutive misses rather than retrying forever, and stays given up', async () => {
    const firePlay = jest.fn(async () => false)
    const { board, render } = setup({ firePlay })
    board.remaining = 10
    const { result, rerender, unmount } = await render()

    await playerMove(result.current, rerender)
    await advance(STAGGER_MS * 10)
    expect(firePlay).toHaveBeenCalledTimes(3)

    await rerender({ state: 'board-1' }) // another board change - still given up
    await advance(STAGGER_MS * 3)
    expect(firePlay).toHaveBeenCalledTimes(3)
    await unmount()
  })

  it('a hit between misses resets the count', async () => {
    const results = [false, false, true, false, false, true]
    const firePlay = jest.fn(async () => results.shift() ?? false)
    const { board, render } = setup({ firePlay })
    board.remaining = 100
    const { result, rerender, unmount } = await render()

    await playerMove(result.current, rerender)
    await advance(STAGGER_MS * 20)
    // miss, miss, HIT (count back to 0), miss, miss, HIT (0 again), then every later call misses: three more, then it
    // gives up. Without the reset it would have given up on the 4th call (3 misses in total, hits or not).
    expect(firePlay).toHaveBeenCalledTimes(9)
    await unmount()
  })

  it('isBusy() turning true mid-finish (an undo started) ends it at the very next step', async () => {
    const isBusy = jest.fn(() => false)
    const { board, firePlay, render } = setup({ isBusy })
    board.remaining = 10
    const { result, rerender, unmount } = await render()

    await playerMove(result.current, rerender)
    await advance(STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(1)

    isBusy.mockReturnValue(true)
    await advance(STAGGER_MS * 4)
    expect(firePlay).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('a re-render mid-finish (the board committed, a flight landed) does not start a second loop alongside the first', async () => {
    const { board, firePlay, render } = setup()
    board.remaining = 50
    const { result, rerender, unmount } = await render()

    await playerMove(result.current, rerender)
    await advance(STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(1)

    // What the screen does after every card: the board changes, and renders again as flights land.
    await rerender({ state: 'board-1' })
    await rerender({ state: 'board-2' })
    await advance(STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(2)
    await advance(STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(3) // one card per stagger, not two loops' worth
    await unmount()
  })

  it('asks canFinish and nextMove about the LIVE board (getState), not the one the last render saw', async () => {
    const { nextMove, canFinish, render } = setup()
    const { result, rerender, unmount } = await render()

    await playerMove(result.current, rerender) // no further renders after this one
    await advance(STAGGER_MS * 5)

    expect(nextMove.mock.calls.map(([s]) => s)).toEqual(['board-0', 'board-1', 'board-2'])
    expect(canFinish).toHaveBeenLastCalledWith('board-3')
    await unmount()
  })

  it('keeps a fixed clock: a card that takes a while to measure and commit does not push the next one back', async () => {
    const { board } = setup()
    board.remaining = 10
    const startedAt: number[] = []
    const firePlay = jest.fn(async () => {
      startedAt.push(Date.now())
      await new Promise((resolve) => setTimeout(resolve, 20)) // the measurement round trip
      board.remaining -= 1
      board.current = `board-${10 - board.remaining}`
      return true
    })
    const { result, rerender, unmount } = await renderHook(({ state }: Props) => useAutoFinish<string>({ state, enabled: () => true, isBusy: () => false, getState: () => board.current, canFinish: () => board.remaining > 0, nextMove: () => moveFor(board.remaining), isLanding: () => false, firePlay, staggerMs: STAGGER_MS }), { initialProps: { state: 'board-0' } as Props })
    const t0 = Date.now()

    await playerMove(result.current, rerender)
    await advance(STAGGER_MS * 4)
    // One stagger apart from one take-off to the next - not stagger + 20ms.
    expect(startedAt.map((t) => t - t0)).toEqual([STAGGER_MS, STAGGER_MS * 2, STAGGER_MS * 3, STAGGER_MS * 4])
    await unmount()
  })

  it('a card slower to measure than the whole gap is followed at once, not one more gap later', async () => {
    const { board } = setup()
    board.remaining = 10
    const startedAt: number[] = []
    const firePlay = jest.fn(async () => {
      startedAt.push(Date.now())
      await new Promise((resolve) => setTimeout(resolve, STAGGER_MS * 2))
      board.remaining -= 1
      board.current = `board-${10 - board.remaining}`
      return true
    })
    const { result, rerender, unmount } = await renderHook(({ state }: Props) => useAutoFinish<string>({ state, enabled: () => true, isBusy: () => false, getState: () => board.current, canFinish: () => board.remaining > 0, nextMove: () => moveFor(board.remaining), isLanding: () => false, firePlay, staggerMs: STAGGER_MS }), { initialProps: { state: 'board-0' } as Props })
    const t0 = Date.now()

    await playerMove(result.current, rerender)
    await advance(STAGGER_MS * 5)
    expect(startedAt.map((t) => t - t0)).toEqual([STAGGER_MS, STAGGER_MS * 3, STAGGER_MS * 5])
    await unmount()
  })

  it('holds a card whose own pile is still landing, sends it the moment that pile lands, and re-reads the board after the wait', async () => {
    const { board, firePlay, isLanding, nextMove, render } = setup()
    let landing = true
    isLanding.mockImplementation((pile) => landing && pile.index === 3)
    const { result, rerender, unmount } = await render()

    await playerMove(result.current, rerender)
    await advance(STAGGER_MS + 200)
    expect(firePlay).not.toHaveBeenCalled()

    const asked = nextMove.mock.calls.length
    landing = false
    await advance(16)
    expect(firePlay).toHaveBeenCalledTimes(1)
    expect(nextMove.mock.calls.length).toBeGreaterThan(asked) // asked again after the wait, not the pre-wait answer
    expect(board.remaining).toBe(2)
    await unmount()
  })

  it('a pile still landing after FINISH_LANDING_WAIT_MS is a miss: the card is not sent', async () => {
    const { board, firePlay, isLanding, render } = setup()
    board.remaining = 10
    isLanding.mockImplementation(() => true)
    const { result, rerender, unmount } = await render()

    await playerMove(result.current, rerender)
    await advance(STAGGER_MS + FINISH_LANDING_WAIT_MS + 16)
    expect(firePlay).not.toHaveBeenCalled()
    await advance((STAGGER_MS + FINISH_LANDING_WAIT_MS + 16) * 3) // three misses in a row: it gives up
    expect(result.current.isAllowed()).toBe(false)
    expect(firePlay).not.toHaveBeenCalled()
    await unmount()
  })

  it('a suppress() during a landing wait ends the finish without sending the card', async () => {
    const { firePlay, isLanding, render } = setup()
    isLanding.mockImplementation(() => true)
    const { result, rerender, unmount } = await render()

    await playerMove(result.current, rerender)
    await advance(STAGGER_MS + 100)
    result.current.suppress()
    isLanding.mockImplementation(() => false)
    await advance(STAGGER_MS * 3)
    expect(firePlay).not.toHaveBeenCalled()
    await unmount()
  })

  it('reads the newest config at every step - a fresh enabled closure passed on a re-render is seen mid-finish', async () => {
    interface FreshProps {
      state: string | null
      enabled: () => boolean
    }
    const firePlay = jest.fn(async () => true)
    const { result, rerender, unmount } = await renderHook(({ state, enabled }: FreshProps) => useAutoFinish<string>({ state, enabled, isBusy: () => false, getState: () => 'live', canFinish: () => true, nextMove: () => moveFor(1), isLanding: () => false, firePlay, staggerMs: STAGGER_MS }), { initialProps: { state: 'board-0', enabled: () => true } as FreshProps })

    result.current.afterPlayerMove(COLUMN)
    await rerender({ state: 'move-1', enabled: () => true })
    await advance(STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(1)

    // A brand-new closure now says "off": the loop must notice at its next step.
    await rerender({ state: 'move-1', enabled: () => false })
    await advance(STAGGER_MS * 4)
    expect(firePlay).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('a newly passed staggerMs takes effect at the next wait', async () => {
    interface StaggerProps {
      state: string | null
      staggerMs: number
    }
    const firePlay = jest.fn(async () => true)
    const { result, rerender, unmount } = await renderHook(({ state, staggerMs }: StaggerProps) => useAutoFinish<string>({ state, enabled: () => true, isBusy: () => false, getState: () => 'live', canFinish: () => true, nextMove: () => moveFor(1), isLanding: () => false, firePlay, staggerMs }), { initialProps: { state: 'board-0', staggerMs: STAGGER_MS } as StaggerProps })
    result.current.afterPlayerMove(COLUMN)
    await rerender({ state: 'move-1', staggerMs: STAGGER_MS })
    await advance(STAGGER_MS / 2)
    await rerender({ state: 'move-1', staggerMs: 1000 }) // during the first gap, which already started at the old value...
    await advance(STAGGER_MS / 2)
    expect(firePlay).toHaveBeenCalledTimes(1)

    await advance(STAGGER_MS * 3) // ...and the wait after it reads the new one
    expect(firePlay).toHaveBeenCalledTimes(1) // waiting out the new, longer stagger
    await advance(1000)
    expect(firePlay).toHaveBeenCalledTimes(2)
    await unmount()
  })

  it('does not start with no board rendered yet, even if the live board is solved', async () => {
    const { firePlay, render } = setup()
    const { result, rerender, unmount } = await render()

    result.current.afterPlayerMove(COLUMN)
    await rerender({ state: null }) // getState() still answers 'board-0'
    await advance(STAGGER_MS * 3)
    expect(firePlay).not.toHaveBeenCalled()
    await unmount()
  })

  it('stops when the screen unmounts', async () => {
    const { board, firePlay, render } = setup()
    board.remaining = 10
    const { result, rerender, unmount } = await render()

    await playerMove(result.current, rerender)
    await advance(STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(1)

    await unmount()
    await advance(STAGGER_MS * 5)
    expect(firePlay).toHaveBeenCalledTimes(1)
  })

  it("the player's move of a card back OFF a foundation onto a solved board does not start it - the card is not sent straight back up", async () => {
    const { firePlay, render } = setup()
    const { result, rerender, unmount } = await render()

    await playerMove(result.current, rerender, 'move-1', FOUNDATION)
    await advance(STAGGER_MS * 3)
    expect(firePlay).not.toHaveBeenCalled()

    await playerMove(result.current, rerender, 'move-2') // their next move (from anywhere else) does
    await advance(STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('a card taken back off a foundation mid-finish stops it, and drops a permission an earlier move left behind', async () => {
    const { board, firePlay, render } = setup()
    board.remaining = 10
    const { result, rerender, unmount } = await render()

    await playerMove(result.current, rerender)
    await advance(STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(1)

    await playerMove(result.current, rerender, 'move-2', FOUNDATION)
    await advance(STAGGER_MS * 4)
    expect(firePlay).toHaveBeenCalledTimes(1)
    expect(result.current.isAllowed()).toBe(false)
    await unmount()
  })

  it('isAllowed() reflects afterPlayerMove() and suppress()', async () => {
    const { render } = setup()
    const { result, unmount } = await render()

    expect(result.current.isAllowed()).toBe(false)
    result.current.afterPlayerMove(COLUMN)
    expect(result.current.isAllowed()).toBe(true)
    result.current.suppress()
    expect(result.current.isAllowed()).toBe(false)
    result.current.afterPlayerMove({ zone: 'freecell', index: 0 })
    expect(result.current.isAllowed()).toBe(true)
    result.current.afterPlayerMove(FOUNDATION)
    expect(result.current.isAllowed()).toBe(false)
    await unmount()
  })

  it('a suppress() that lands while a step is still awaiting ends the finish after that step - nothing further fires', async () => {
    let releaseStep: () => void = () => {}
    const firePlay = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          releaseStep = () => resolve(true)
        })
    )
    const { board, render } = setup({ firePlay })
    board.remaining = 10
    const { result, rerender, unmount } = await render()

    await playerMove(result.current, rerender)
    await advance(STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(1)

    result.current.suppress() // an undo, while firePlay's measurement is still running
    await act(async () => releaseStep())
    await advance(STAGGER_MS * 4)
    expect(firePlay).toHaveBeenCalledTimes(1)
    await unmount()
  })
})
