import { act, renderHook } from '@testing-library/react-native'

import { AUTO_PLAY_STAGGER_MS, WIN_SWEEP_STAGGER_MS } from '@/components/dragdrop/dragSpring'
import { AutoCompleteStep } from '@/engine/autoFoundation'
import { AccessibleCard, PileRef } from '@/engine/gameTypes'
import { useAutoFoundationCascade } from '@/games/shared/useAutoFoundationCascade'

const PLAY_ENTRY: AccessibleCard = { ref: { zone: 'tableau', index: 0 }, card: { id: 'hearts-5-0', suit: 'hearts', rank: 5, faceUp: true } }
const PLAY_TO: PileRef = { zone: 'foundation', index: 2 }
const STEP_PLAY: AutoCompleteStep = { kind: 'play', entry: PLAY_ENTRY, to: PLAY_TO }

const ACE_ENTRY: AccessibleCard = { ref: { zone: 'waste', index: 0 }, card: { id: 'clubs-1-0', suit: 'clubs', rank: 1, faceUp: true } }
const ACE_TO: PileRef = { zone: 'foundation', index: 0 }

// Longer than the stagger, like every real auto-play flight (183-373ms against 190ms), so consecutive cards overlap.
const FLIGHT_MS = 300
// A cascade that has to wait for everything to land checks every 16ms, so it notices a landing up to that much later.
const POLL_MS = 16

interface Props {
  state: string | null
  settled: boolean
}

type Config = Parameters<typeof useAutoFoundationCascade<string>>[0]

// renderHook/rerender are async in this @testing-library/react-native version (React 19's concurrent rendering) - every
// render step is awaited. Timers are faked so the cascade's stagger, and the stand-in flights below, can be stepped through
// deterministically.
//
// The board is a stand-in for a screen's stateRef + activeFlightCountRef: every fire commits a new board at once and puts one
// flight in the air for FLIGHT_MS, exactly how the real fire functions resolve (on commit, not on landing).
function setup(overrides: Partial<Config> = {}) {
  const board = { current: 'board-0' as string | null, n: 0, inAir: 0, maxInAir: 0 }
  function commit(flightMs = FLIGHT_MS) {
    board.n += 1
    board.current = `board-${board.n}`
    board.inAir += 1
    board.maxInAir = Math.max(board.maxInAir, board.inAir)
    setTimeout(() => (board.inAir -= 1), flightMs)
  }
  const firePlay = jest.fn(async () => {
    commit()
    return true
  })
  const fireDraw = jest.fn(async () => commit())
  const fireDrawAndPlay = jest.fn(async () => commit())
  const enabled = jest.fn(() => true)
  const isBusy = jest.fn(() => false)
  const computeNextStep = jest.fn((): AutoCompleteStep | null => STEP_PLAY)
  const render = () =>
    renderHook(
      ({ state, settled }: Props) =>
        useAutoFoundationCascade<string>({
          state,
          settled,
          isSettled: () => board.inAir === 0,
          getState: () => board.current,
          enabled,
          isBusy,
          computeNextStep,
          firePlay,
          fireDraw,
          fireDrawAndPlay,
          ...overrides
        }),
      { initialProps: { state: 'board-0', settled: false } as Props }
    )
  return { board, commit, firePlay, fireDraw, fireDrawAndPlay, enabled, isBusy, computeNextStep, render }
}

/** Lets the cascade's pending promise + timer chain run for `ms` of fake time. */
async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
}

describe('useAutoFoundationCascade', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('does not fire merely by settling, without being armed first', async () => {
    const { firePlay, render } = setup()
    const { rerender, unmount } = await render()

    await rerender({ state: 'board-0', settled: true })
    await advance(AUTO_PLAY_STAGGER_MS * 5)
    expect(firePlay).not.toHaveBeenCalled()
    await unmount()
  })

  it("waits for the player's own move to land before the first card leaves", async () => {
    const { firePlay, render } = setup()
    const { result, rerender, unmount } = await render()

    result.current.armFromForwardMove()
    await rerender({ state: 'board-0', settled: false })
    await advance(AUTO_PLAY_STAGGER_MS * 3)
    expect(firePlay).not.toHaveBeenCalled()

    await rerender({ state: 'board-0', settled: true })
    expect(firePlay).toHaveBeenCalledTimes(1)
    expect(firePlay).toHaveBeenCalledWith(STEP_PLAY.entry, STEP_PLAY.to)
    await unmount()
  })

  it('sends a card every AUTO_PLAY_STAGGER_MS without waiting for the one before to land, until computeNextStep runs dry', async () => {
    const { board, firePlay, computeNextStep, render } = setup()
    computeNextStep.mockImplementation(() => (board.n < 4 ? STEP_PLAY : null))
    const { result, rerender, unmount } = await render()

    result.current.armFromForwardMove()
    await rerender({ state: 'board-0', settled: true })
    expect(firePlay).toHaveBeenCalledTimes(1)

    await advance(AUTO_PLAY_STAGGER_MS - 1)
    expect(firePlay).toHaveBeenCalledTimes(1) // not before the stagger...
    await advance(1)
    expect(firePlay).toHaveBeenCalledTimes(2) // ...and not after the first card lands (FLIGHT_MS) either
    expect(board.inAir).toBe(2)

    await advance(AUTO_PLAY_STAGGER_MS * 2)
    expect(firePlay).toHaveBeenCalledTimes(4)
    expect(board.maxInAir).toBe(2)

    await advance(AUTO_PLAY_STAGGER_MS * 5) // ran dry: disarmed
    expect(firePlay).toHaveBeenCalledTimes(4)
    await rerender({ state: 'board-4', settled: true }) // another settle, no fresh arm call
    await advance(AUTO_PLAY_STAGGER_MS * 2)
    expect(firePlay).toHaveBeenCalledTimes(4)
    await unmount()
  })

  it('armFromAceEvent fires the pinned entry first (skipping computeNextStep entirely), then continues the cascade normally', async () => {
    const { firePlay, computeNextStep, render } = setup()
    computeNextStep.mockReturnValueOnce(STEP_PLAY).mockReturnValue(null)
    const { result, rerender, unmount } = await render()

    result.current.armFromAceEvent(ACE_ENTRY, ACE_TO)
    await rerender({ state: 'board-0', settled: true })
    expect(firePlay).toHaveBeenNthCalledWith(1, ACE_ENTRY, ACE_TO)
    expect(computeNextStep).not.toHaveBeenCalled() // the pin short-circuits the scan

    await advance(AUTO_PLAY_STAGGER_MS) // the next card leaves while the ace is still in the air
    expect(computeNextStep).toHaveBeenCalledTimes(1)
    expect(firePlay).toHaveBeenNthCalledWith(2, STEP_PLAY.entry, STEP_PLAY.to)
    await unmount()
  })

  it('an ace pinned by one of its own moves (a reveal) goes next, on the same stagger', async () => {
    const { board, firePlay, computeNextStep, render } = setup()
    computeNextStep.mockImplementation(() => (board.n < 3 ? STEP_PLAY : null))
    const hooks: { pinAce?: () => void } = {}
    firePlay.mockImplementationOnce(async () => {
      board.n += 1
      board.current = `board-${board.n}`
      hooks.pinAce?.() // the move uncovered an ace - armFromAceEvent from inside applyMove
      return true
    })
    const { result, rerender, unmount } = await render()
    hooks.pinAce = () => result.current.armFromAceEvent(ACE_ENTRY, ACE_TO)

    result.current.armFromForwardMove()
    await rerender({ state: 'board-0', settled: true })
    await advance(AUTO_PLAY_STAGGER_MS)
    expect(firePlay).toHaveBeenNthCalledWith(2, ACE_ENTRY, ACE_TO)
    await advance(AUTO_PLAY_STAGGER_MS)
    expect(firePlay).toHaveBeenNthCalledWith(3, STEP_PLAY.entry, STEP_PLAY.to)
    await unmount()
  })

  it('a draw waits for every flight to land before it goes, and the step after it waits for the draw to land; from then on cards leave at the sweep gap', async () => {
    const { board, firePlay, fireDraw, computeNextStep, render } = setup()
    const steps: AutoCompleteStep[] = [STEP_PLAY, { kind: 'draw' }, STEP_PLAY, STEP_PLAY]
    computeNextStep.mockImplementation(() => steps[board.n] ?? null)
    const { result, rerender, unmount } = await render()

    result.current.armFromForwardMove()
    await rerender({ state: 'board-0', settled: true }) // t=0: the first card leaves (lands at FLIGHT_MS)
    expect(firePlay).toHaveBeenCalledTimes(1)

    await advance(FLIGHT_MS - 1)
    expect(fireDraw).not.toHaveBeenCalled() // the first card is still in the air
    await advance(1 + POLL_MS)
    expect(fireDraw).toHaveBeenCalledWith({ sweep: true }) // it landed: the draw goes (and lands FLIGHT_MS later)

    await advance(FLIGHT_MS - POLL_MS - 1)
    expect(firePlay).toHaveBeenCalledTimes(1) // the draw is still in the air
    await advance(1 + POLL_MS)
    expect(firePlay).toHaveBeenCalledTimes(2)
    expect(firePlay).toHaveBeenLastCalledWith(STEP_PLAY.entry, STEP_PLAY.to)

    await advance(WIN_SWEEP_STAGGER_MS) // plays overlap again, at the sweep stagger
    expect(firePlay).toHaveBeenCalledTimes(3)
    expect(board.inAir).toBe(2)
    await unmount()
  })

  it('a draw-and-play is held back the same way', async () => {
    const { board, firePlay, fireDrawAndPlay, computeNextStep, render } = setup()
    const steps: AutoCompleteStep[] = [STEP_PLAY, { kind: 'drawAndPlay', entry: ACE_ENTRY, to: ACE_TO }]
    computeNextStep.mockImplementation(() => steps[board.n] ?? null)
    const { result, rerender, unmount } = await render()

    result.current.armFromForwardMove()
    await rerender({ state: 'board-0', settled: true })
    expect(firePlay).toHaveBeenCalledTimes(1)
    await advance(FLIGHT_MS - 1)
    expect(fireDrawAndPlay).not.toHaveBeenCalled()
    await advance(1 + POLL_MS)
    expect(fireDrawAndPlay).toHaveBeenCalledWith(ACE_ENTRY, ACE_TO)
    await unmount()
  })

  it('when the player moves mid-cascade, the next card waits for every flight (theirs included) to land', async () => {
    const { board, commit, firePlay, computeNextStep, render } = setup()
    computeNextStep.mockImplementation(() => (board.n < 5 ? STEP_PLAY : null))
    const { result, rerender, unmount } = await render()

    result.current.armFromForwardMove()
    await rerender({ state: 'board-0', settled: true }) // t=0: the first card leaves
    expect(firePlay).toHaveBeenCalledTimes(1)

    await advance(100)
    commit(600) // t=100: the player's own (slower) move commits while the cascade's card is in the air - it lands at t=700
    await advance(AUTO_PLAY_STAGGER_MS) // past the stagger, past the cascade's own landing (t=300)
    expect(firePlay).toHaveBeenCalledTimes(1) // held: the board isn't the one the cascade left
    await advance(700 - 100 - AUTO_PLAY_STAGGER_MS - 1)
    expect(firePlay).toHaveBeenCalledTimes(1) // t=699: the player's card is still in the air
    await advance(1 + POLL_MS)
    expect(firePlay).toHaveBeenCalledTimes(2) // everything landed - it carries on from the new board
    await advance(AUTO_PLAY_STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(3) // and overlaps again
    await unmount()
  })

  it('disarm() stops a cascade that is already running', async () => {
    const { firePlay, render } = setup()
    const { result, rerender, unmount } = await render()

    result.current.armFromForwardMove()
    await rerender({ state: 'board-0', settled: true })
    await advance(AUTO_PLAY_STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(2)

    result.current.disarm() // e.g. an undo or a new deal
    await advance(AUTO_PLAY_STAGGER_MS * 5)
    expect(firePlay).toHaveBeenCalledTimes(2)
    await unmount()
  })

  it('stops on its own after a few misses in a row, instead of retrying forever', async () => {
    const { firePlay, render } = setup()
    firePlay.mockImplementation(async () => false) // e.g. the card never measures
    const { result, rerender, unmount } = await render()

    result.current.armFromForwardMove()
    await rerender({ state: 'board-0', settled: true })
    await advance(AUTO_PLAY_STAGGER_MS * 10)
    expect(firePlay).toHaveBeenCalledTimes(3)
    await unmount()
  })

  it('stops mid-cascade when Auto-Move is turned off', async () => {
    const { enabled, firePlay, render } = setup()
    const { result, rerender, unmount } = await render()

    result.current.armFromForwardMove()
    await rerender({ state: 'board-0', settled: true })
    enabled.mockReturnValue(false)
    await advance(AUTO_PLAY_STAGGER_MS * 3)
    expect(firePlay).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('stops mid-cascade when an undo starts', async () => {
    const { isBusy, firePlay, render } = setup()
    const { result, rerender, unmount } = await render()

    result.current.armFromForwardMove()
    await rerender({ state: 'board-0', settled: true })
    isBusy.mockReturnValue(true)
    await advance(AUTO_PLAY_STAGGER_MS * 3)
    expect(firePlay).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('enabled() returning false suppresses firing even while armed and settled', async () => {
    const { enabled, firePlay, render } = setup()
    enabled.mockReturnValue(false)
    const { result, rerender, unmount } = await render()

    result.current.armFromForwardMove()
    await rerender({ state: 'board-0', settled: true })
    await advance(AUTO_PLAY_STAGGER_MS * 3)
    expect(firePlay).not.toHaveBeenCalled()
    await unmount()
  })

  it('isBusy() returning true suppresses firing even while armed and settled', async () => {
    const { isBusy, firePlay, render } = setup()
    isBusy.mockReturnValue(true)
    const { result, rerender, unmount } = await render()

    result.current.armFromForwardMove()
    await rerender({ state: 'board-0', settled: true })
    await advance(AUTO_PLAY_STAGGER_MS * 3)
    expect(firePlay).not.toHaveBeenCalled()
    await unmount()
  })

  it('disarm() drops a pending arm - a later settle fires nothing without a fresh arm call', async () => {
    const { firePlay, computeNextStep, render } = setup()
    const { result, rerender, unmount } = await render()

    result.current.armFromForwardMove()
    result.current.disarm() // e.g. an undo / new game landed before the board settled
    await rerender({ state: 'board-1', settled: true })
    await advance(AUTO_PLAY_STAGGER_MS * 3)
    expect(computeNextStep).not.toHaveBeenCalled()
    expect(firePlay).not.toHaveBeenCalled()
    await unmount()
  })

  it('disarm() also drops a pinned ace, so it cannot fire on a later board', async () => {
    const { firePlay, computeNextStep, render } = setup()
    computeNextStep.mockReturnValue(null)
    const { result, rerender, unmount } = await render()

    result.current.armFromAceEvent(ACE_ENTRY, ACE_TO)
    result.current.disarm()
    await rerender({ state: 'board-1', settled: true })
    await advance(AUTO_PLAY_STAGGER_MS * 3)
    expect(firePlay).not.toHaveBeenCalled()
    await unmount()
  })

  it('stops when the screen unmounts', async () => {
    const { firePlay, render } = setup()
    const { result, rerender, unmount } = await render()

    result.current.armFromForwardMove()
    await rerender({ state: 'board-0', settled: true })
    await unmount()
    await advance(AUTO_PLAY_STAGGER_MS * 5)
    expect(firePlay).toHaveBeenCalledTimes(1)
  })
})
