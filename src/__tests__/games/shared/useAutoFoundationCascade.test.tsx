import { act, renderHook } from '@testing-library/react-native'

import { AUTO_PLAY_STAGGER_MS } from '@/components/dragdrop/dragSpring'
import { AutoCompleteStep } from '@/engine/autoFoundation'
import { AccessibleCard, PileRef } from '@/engine/gameTypes'
import { useAutoFoundationCascade } from '@/games/shared/useAutoFoundationCascade'

const PLAY_ENTRY: AccessibleCard = { ref: { zone: 'tableau', index: 0 }, card: { id: 'hearts-5-0', suit: 'hearts', rank: 5, faceUp: true } }
const PLAY_TO: PileRef = { zone: 'foundation', index: 2 }
const STEP_PLAY: AutoCompleteStep = { kind: 'play', entry: PLAY_ENTRY, to: PLAY_TO }

const ACE_ENTRY: AccessibleCard = { ref: { zone: 'waste', index: 0 }, card: { id: 'clubs-1-0', suit: 'clubs', rank: 1, faceUp: true } }
const ACE_TO: PileRef = { zone: 'foundation', index: 0 }
const WASTE: PileRef = { zone: 'waste', index: 0 }

// Far longer than the gap between two cards, like every real flight (~483ms of ghost against 96ms), so cards overlap.
const FLIGHT_MS = 480
// A card waiting for its pile to land checks every 16ms, so it notices a landing up to that much later.
const POLL_MS = 16

interface Props {
  state: string | null
}

type Config = Parameters<typeof useAutoFoundationCascade<string>>[0]

const key = (pile: PileRef) => `${pile.zone}-${pile.index}`

// renderHook/rerender are async in this @testing-library/react-native version (React 19's concurrent rendering) - every
// render step is awaited. Timers are faked so the cascade's gaps, and the stand-in flights below, can be stepped through
// deterministically.
//
// The board is a stand-in for a screen's stateRef + its `flying` entries: every fire commits a new board at once and puts one
// flight in the air, landing on its destination pile FLIGHT_MS later - exactly how the real fire functions resolve (on commit,
// not on landing).
function setup(overrides: Partial<Config> = {}) {
  const board = { current: 'board-0' as string | null, n: 0, inAir: 0, maxInAir: 0, landing: new Map<string, number>() }
  function commit(to: PileRef, flightMs = FLIGHT_MS) {
    board.n += 1
    board.current = `board-${board.n}`
    board.inAir += 1
    board.maxInAir = Math.max(board.maxInAir, board.inAir)
    board.landing.set(key(to), (board.landing.get(key(to)) ?? 0) + 1)
    setTimeout(() => {
      board.inAir -= 1
      board.landing.set(key(to), (board.landing.get(key(to)) ?? 1) - 1)
    }, flightMs)
  }
  const firePlay = jest.fn(async (_entry: AccessibleCard, to: PileRef) => {
    commit(to)
    return true
  })
  const fireDraw = jest.fn(async () => commit(WASTE))
  const fireDrawAndPlay = jest.fn(async (_entry: AccessibleCard, to: PileRef) => commit(to))
  const enabled = jest.fn(() => true)
  const isBusy = jest.fn(() => false)
  const computeNextStep = jest.fn((): AutoCompleteStep | null => STEP_PLAY)
  const render = () =>
    renderHook(
      ({ state }: Props) =>
        useAutoFoundationCascade<string>({
          state,
          isLanding: (pile) => (board.landing.get(key(pile)) ?? 0) > 0,
          getState: () => board.current,
          enabled,
          isBusy,
          computeNextStep,
          firePlay,
          fireDraw,
          fireDrawAndPlay,
          ...overrides
        }),
      { initialProps: { state: 'board-0' } as Props }
    )
  /** The player's own move to `to` - committed, and arming the cascade the way applyMove does, in the same breath. */
  async function playerMove(rerender: (props: Props) => Promise<void>, arm: () => void, to: PileRef = PLAY_TO) {
    commit(to)
    arm()
    await rerender({ state: board.current })
  }
  return { board, commit, playerMove, firePlay, fireDraw, fireDrawAndPlay, enabled, isBusy, computeNextStep, render }
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

  it('does not fire on a board change without being armed first', async () => {
    const { firePlay, render } = setup()
    const { rerender, unmount } = await render()

    await rerender({ state: 'board-1' })
    await advance(AUTO_PLAY_STAGGER_MS * 5)
    expect(firePlay).not.toHaveBeenCalled()
    await unmount()
  })

  it("follows the player's own card one gap later, while that card is still in the air", async () => {
    const { board, playerMove, firePlay, render } = setup()
    const { result, rerender, unmount } = await render()

    await playerMove(rerender, () => result.current.armFromForwardMove())
    await advance(AUTO_PLAY_STAGGER_MS - 1)
    expect(firePlay).not.toHaveBeenCalled()
    await advance(1)
    expect(firePlay).toHaveBeenCalledTimes(1)
    expect(firePlay).toHaveBeenCalledWith(STEP_PLAY.entry, STEP_PLAY.to)
    expect(board.inAir).toBe(2) // the player's card has not landed, and did not have to
    await unmount()
  })

  it('sends a card every AUTO_PLAY_STAGGER_MS without waiting for the one before to land, until computeNextStep runs dry', async () => {
    const { board, playerMove, firePlay, computeNextStep, render } = setup()
    computeNextStep.mockImplementation(() => (board.n < 5 ? STEP_PLAY : null)) // the player's move, then four cards
    const { result, rerender, unmount } = await render()

    await playerMove(rerender, () => result.current.armFromForwardMove())
    for (let i = 1; i <= 4; i++) {
      await advance(AUTO_PLAY_STAGGER_MS)
      expect(firePlay).toHaveBeenCalledTimes(i)
    }
    expect(board.maxInAir).toBe(5) // nothing had landed yet: every card overlapped every other

    await advance(AUTO_PLAY_STAGGER_MS * 5) // ran dry: disarmed
    expect(firePlay).toHaveBeenCalledTimes(4)
    await rerender({ state: 'board-x' }) // another board change, no fresh arm call
    await advance(AUTO_PLAY_STAGGER_MS * 3)
    expect(firePlay).toHaveBeenCalledTimes(4)
    await unmount()
  })

  it('armFromAceEvent fires the pinned entry first (skipping computeNextStep), then continues the cascade normally', async () => {
    const { firePlay, computeNextStep, render, board } = setup()
    computeNextStep.mockReturnValueOnce(STEP_PLAY).mockReturnValue(null)
    const { result, rerender, unmount } = await render()

    board.n += 1 // the move that revealed the ace (in place - nothing is landing on its pile)
    board.current = 'board-1'
    result.current.armFromAceEvent({ ...ACE_ENTRY, ref: { zone: 'tableau', index: 3 } }, ACE_TO)
    await rerender({ state: 'board-1' })
    await advance(AUTO_PLAY_STAGGER_MS)
    expect(firePlay).toHaveBeenNthCalledWith(1, { ...ACE_ENTRY, ref: { zone: 'tableau', index: 3 } }, ACE_TO)
    expect(computeNextStep).not.toHaveBeenCalled() // the pin short-circuits the scan

    await advance(AUTO_PLAY_STAGGER_MS) // the next card leaves while the ace is still in the air
    expect(computeNextStep).toHaveBeenCalledTimes(1)
    expect(firePlay).toHaveBeenNthCalledWith(2, STEP_PLAY.entry, STEP_PLAY.to)
    await unmount()
  })

  it('an ace pinned by one of its own moves (a reveal) goes next, on the same gap', async () => {
    const { board, playerMove, firePlay, computeNextStep, render } = setup()
    computeNextStep.mockImplementation(() => (board.n < 4 ? STEP_PLAY : null))
    const revealed = { ...ACE_ENTRY, ref: { zone: 'tableau', index: 3 } as PileRef }
    const hooks: { pinAce?: () => void } = {}
    firePlay.mockImplementationOnce(async (_entry, to) => {
      board.n += 1
      board.current = `board-${board.n}`
      board.landing.set(key(to), 1)
      hooks.pinAce?.() // the move uncovered an ace - armFromAceEvent from inside applyMove
      return true
    })
    const { result, rerender, unmount } = await render()
    hooks.pinAce = () => result.current.armFromAceEvent(revealed, ACE_TO)

    await playerMove(rerender, () => result.current.armFromForwardMove())
    await advance(AUTO_PLAY_STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(1)
    await advance(AUTO_PLAY_STAGGER_MS)
    expect(firePlay).toHaveBeenNthCalledWith(2, revealed, ACE_TO)
    await advance(AUTO_PLAY_STAGGER_MS)
    expect(firePlay).toHaveBeenNthCalledWith(3, STEP_PLAY.entry, STEP_PLAY.to)
    await unmount()
  })

  it('a card still flying in to its own pile (a drawn ace) waits for it to land, then goes at once', async () => {
    const { board, commit, firePlay, computeNextStep, render } = setup()
    computeNextStep.mockReturnValue(null)
    const { result, rerender, unmount } = await render()

    commit(WASTE) // the player's draw: the ace is flying onto the waste
    result.current.armFromAceEvent(ACE_ENTRY, ACE_TO)
    await rerender({ state: board.current })
    await advance(FLIGHT_MS - 1)
    expect(firePlay).not.toHaveBeenCalled() // picked up mid-air it would show twice
    await advance(1 + POLL_MS)
    expect(firePlay).toHaveBeenCalledWith(ACE_ENTRY, ACE_TO) // landed: no further gap
    await unmount()
  })

  it('a draw waits for the stock and waste to be quiet, while plays from other piles keep overlapping', async () => {
    const { board, playerMove, firePlay, fireDraw, computeNextStep, render } = setup()
    // the player's move, a draw, a play from the tableau, another draw
    const steps: (AutoCompleteStep | null)[] = [null, { kind: 'draw' }, STEP_PLAY, { kind: 'draw' }]
    computeNextStep.mockImplementation(() => steps[board.n] ?? null)
    const { result, rerender, unmount } = await render()

    await playerMove(rerender, () => result.current.armFromForwardMove())
    await advance(AUTO_PLAY_STAGGER_MS) // t=96: nothing is landing on the stock/waste - the draw goes
    expect(fireDraw).toHaveBeenCalledTimes(1)
    expect(fireDraw).toHaveBeenCalledWith({ sweep: true })

    await advance(AUTO_PLAY_STAGGER_MS) // t=192: a tableau play does not wait for the draw
    expect(firePlay).toHaveBeenCalledTimes(1)

    await advance(AUTO_PLAY_STAGGER_MS) // t=288: the next draw does - the first is still landing on the waste
    expect(fireDraw).toHaveBeenCalledTimes(1)
    await advance(AUTO_PLAY_STAGGER_MS + FLIGHT_MS - 3 * AUTO_PLAY_STAGGER_MS + POLL_MS) // past t=96+FLIGHT_MS
    expect(fireDraw).toHaveBeenCalledTimes(2)
    await unmount()
  })

  it('a draw-and-play is held back the same way', async () => {
    const { board, commit, fireDrawAndPlay, computeNextStep, render } = setup()
    const steps: (AutoCompleteStep | null)[] = [null, { kind: 'drawAndPlay', entry: ACE_ENTRY, to: ACE_TO }]
    computeNextStep.mockImplementation(() => steps[board.n] ?? null)
    const { result, rerender, unmount } = await render()

    commit(WASTE) // the player's own draw is still landing on the waste
    result.current.armFromForwardMove()
    await rerender({ state: board.current })
    await advance(FLIGHT_MS - 1)
    expect(fireDrawAndPlay).not.toHaveBeenCalled()
    await advance(1 + POLL_MS)
    expect(fireDrawAndPlay).toHaveBeenCalledWith(ACE_ENTRY, ACE_TO)
    await unmount()
  })

  it('disarm() stops a cascade that is already running', async () => {
    const { playerMove, firePlay, render } = setup()
    const { result, rerender, unmount } = await render()

    await playerMove(rerender, () => result.current.armFromForwardMove())
    await advance(AUTO_PLAY_STAGGER_MS * 2)
    expect(firePlay).toHaveBeenCalledTimes(2)

    result.current.disarm() // e.g. an undo or a new deal
    await advance(AUTO_PLAY_STAGGER_MS * 5)
    expect(firePlay).toHaveBeenCalledTimes(2)
    await unmount()
  })

  it('stops on its own after a few misses in a row, instead of retrying forever', async () => {
    const { playerMove, firePlay, render } = setup()
    firePlay.mockImplementation(async () => false) // e.g. the card never measures
    const { result, rerender, unmount } = await render()

    await playerMove(rerender, () => result.current.armFromForwardMove())
    await advance(AUTO_PLAY_STAGGER_MS * 10)
    expect(firePlay).toHaveBeenCalledTimes(3)
    await unmount()
  })

  it('stops mid-cascade when Auto-Move is turned off', async () => {
    const { enabled, playerMove, firePlay, render } = setup()
    const { result, rerender, unmount } = await render()

    await playerMove(rerender, () => result.current.armFromForwardMove())
    await advance(AUTO_PLAY_STAGGER_MS)
    enabled.mockReturnValue(false)
    await advance(AUTO_PLAY_STAGGER_MS * 3)
    expect(firePlay).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('stops mid-cascade when an undo starts', async () => {
    const { isBusy, playerMove, firePlay, render } = setup()
    const { result, rerender, unmount } = await render()

    await playerMove(rerender, () => result.current.armFromForwardMove())
    await advance(AUTO_PLAY_STAGGER_MS)
    isBusy.mockReturnValue(true)
    await advance(AUTO_PLAY_STAGGER_MS * 3)
    expect(firePlay).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('does not start while Auto-Move is off, or while an undo is running', async () => {
    for (const blocked of ['enabled', 'isBusy'] as const) {
      const harness = setup()
      if (blocked === 'enabled') harness.enabled.mockReturnValue(false)
      else harness.isBusy.mockReturnValue(true)
      const { result, rerender, unmount } = await harness.render()

      await harness.playerMove(rerender, () => result.current.armFromForwardMove())
      await advance(AUTO_PLAY_STAGGER_MS * 3)
      expect([blocked, harness.firePlay.mock.calls.length]).toEqual([blocked, 0])
      await unmount()
    }
  })

  it('disarm() drops a pending arm - a later board change fires nothing without a fresh arm call', async () => {
    const { firePlay, computeNextStep, render } = setup()
    const { result, rerender, unmount } = await render()

    result.current.armFromForwardMove()
    result.current.disarm() // e.g. an undo / new game landed in the same breath
    await rerender({ state: 'board-1' })
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
    await rerender({ state: 'board-1' })
    await advance(AUTO_PLAY_STAGGER_MS * 3)
    expect(firePlay).not.toHaveBeenCalled()
    await unmount()
  })

  it('stops when the screen unmounts', async () => {
    const { playerMove, firePlay, render } = setup()
    const { result, rerender, unmount } = await render()

    await playerMove(rerender, () => result.current.armFromForwardMove())
    await advance(AUTO_PLAY_STAGGER_MS)
    await unmount()
    await advance(AUTO_PLAY_STAGGER_MS * 5)
    expect(firePlay).toHaveBeenCalledTimes(1)
  })
})
