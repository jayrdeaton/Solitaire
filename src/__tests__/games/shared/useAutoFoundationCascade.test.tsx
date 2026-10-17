import { act, renderHook } from '@testing-library/react-native'

import { AUTO_PLAY_STAGGER_MS } from '@/components/dragdrop/dragSpring'
import { AutoCompleteStep } from '@/engine/autoFoundation'
import { AccessibleCard, PileRef } from '@/engine/gameTypes'
import { AutoFoundationCascade, useAutoFoundationCascade } from '@/games/shared/useAutoFoundationCascade'

const PLAY_ENTRY: AccessibleCard = { ref: { zone: 'tableau', index: 0 }, card: { id: 'hearts-5-0', suit: 'hearts', rank: 5, faceUp: true } }
const PLAY_TO: PileRef = { zone: 'foundation', index: 2 }
const STEP_PLAY: AutoCompleteStep = { kind: 'play', entry: PLAY_ENTRY, to: PLAY_TO }

const ACE_ENTRY: AccessibleCard = { ref: { zone: 'waste', index: 0 }, card: { id: 'clubs-1-0', suit: 'clubs', rank: 1, faceUp: true } }
const ACE_TO: PileRef = { zone: 'foundation', index: 0 }
const WASTE: PileRef = { zone: 'waste', index: 0 }
const COLUMN: PileRef = { zone: 'tableau', index: 4 }

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
  /** The player's own move to `to` - committed, and reported to the cascade the way applyMove does, in the same breath. */
  async function playerMove(rerender: (props: Props) => Promise<void>, cascade: AutoFoundationCascade, to: PileRef = PLAY_TO) {
    commit(to)
    cascade.afterPlayerMove(to)
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

  it("never starts from the player's move to anywhere but a foundation - not even one that uncovers a playable card", async () => {
    const { playerMove, firePlay, computeNextStep, render } = setup()
    const { result, rerender, unmount } = await render()

    // computeNextStep would offer a card every time (e.g. an ace the move flipped up), but nothing may even look
    for (const to of [COLUMN, WASTE, { zone: 'freecell', index: 0 }, { zone: 'reserve', index: 0 }]) {
      await playerMove(rerender, result.current, to)
      await advance(AUTO_PLAY_STAGGER_MS * 3)
    }
    expect(computeNextStep).not.toHaveBeenCalled()
    expect(firePlay).not.toHaveBeenCalled()
    await unmount()
  })

  it("the player's next move to anywhere but a foundation stops the cascade their last play set off; their next foundation play starts a new one", async () => {
    const { playerMove, firePlay, render } = setup()
    const { result, rerender, unmount } = await render()

    await playerMove(rerender, result.current)
    await advance(AUTO_PLAY_STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(1)

    await playerMove(rerender, result.current, COLUMN) // e.g. a column move that flips up an ace: that card is theirs
    await advance(AUTO_PLAY_STAGGER_MS * 5)
    expect(firePlay).toHaveBeenCalledTimes(1)

    await playerMove(rerender, result.current)
    await advance(AUTO_PLAY_STAGGER_MS)
    expect(firePlay).toHaveBeenCalledTimes(2)
    await unmount()
  })

  it("follows the player's own card one gap later, while that card is still in the air", async () => {
    const { board, playerMove, firePlay, render } = setup()
    const { result, rerender, unmount } = await render()

    await playerMove(rerender, result.current)
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

    await playerMove(rerender, result.current)
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

  // Jay, 2026-10-17: the auto-play's haptic should be rhythmic. The gap used to be counted from each card's COMMIT, after its
  // measurement (a different time every card), and the click and buzz played there too.
  it("keeps a fixed clock and plays each card's beat as it leaves - a card slow to measure doesn't push the next one back", async () => {
    const { board, commit, playerMove, computeNextStep } = setup()
    computeNextStep.mockImplementation(() => (board.n < 5 ? STEP_PLAY : null))
    const left: number[] = []
    const beats: number[] = []
    const firePlay = jest.fn(async (_entry: AccessibleCard, to: PileRef) => {
      left.push(Date.now())
      await new Promise((resolve) => setTimeout(resolve, 30)) // the measurement round trip
      commit(to)
      return true
    })
    const beat = jest.fn(() => beats.push(Date.now()))
    const { result, rerender, unmount } = await renderHook(
      ({ state }: Props) =>
        useAutoFoundationCascade<string>({
          state,
          isLanding: () => false,
          getState: () => board.current,
          enabled: () => true,
          isBusy: () => false,
          computeNextStep,
          firePlay,
          beat
        }),
      { initialProps: { state: 'board-0' } as Props }
    )
    const t0 = Date.now()

    await playerMove(rerender, result.current)
    await advance(AUTO_PLAY_STAGGER_MS * 5)
    const gaps = [1, 2, 3, 4].map((i) => AUTO_PLAY_STAGGER_MS * i)
    expect(left.map((t) => t - t0)).toEqual(gaps)
    expect(beats.map((t) => t - t0)).toEqual(gaps)
    await unmount()
  })

  it('a plain draw plays no beat of its own here (fireDraw plays its own); a draw-and-play does', async () => {
    const { board, playerMove, computeNextStep } = setup()
    const beat = jest.fn()
    computeNextStep.mockImplementation(() => (board.n === 1 ? { kind: 'draw' } : board.n === 2 ? { kind: 'drawAndPlay', entry: ACE_ENTRY, to: ACE_TO } : null))
    const { result, rerender, unmount } = await renderHook(
      ({ state }: Props) =>
        useAutoFoundationCascade<string>({
          state,
          isLanding: () => false,
          getState: () => board.current,
          enabled: () => true,
          isBusy: () => false,
          computeNextStep,
          firePlay: jest.fn(async () => true),
          fireDraw: jest.fn(async () => {
            board.n += 1
            board.current = `board-${board.n}`
          }),
          fireDrawAndPlay: jest.fn(async () => {
            board.n += 1
            board.current = `board-${board.n}`
          }),
          beat
        }),
      { initialProps: { state: 'board-0' } as Props }
    )

    await playerMove(rerender, result.current)
    await advance(AUTO_PLAY_STAGGER_MS * 4)
    expect(beat).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('a card still flying in to its own pile (one the sweep just drew) waits for it to land, then goes at once', async () => {
    const { board, playerMove, firePlay, fireDraw, computeNextStep, render } = setup()
    // the player's move, the sweep's draw, then a play of the drawn card off the waste
    const steps: (AutoCompleteStep | null)[] = [null, { kind: 'draw' }, { kind: 'play', entry: ACE_ENTRY, to: ACE_TO }]
    computeNextStep.mockImplementation(() => steps[board.n] ?? null)
    const { result, rerender, unmount } = await render()

    await playerMove(rerender, result.current)
    await advance(AUTO_PLAY_STAGGER_MS) // t=96: the draw - its card is flying onto the waste
    expect(fireDraw).toHaveBeenCalledTimes(1)
    await advance(FLIGHT_MS - 1) // one ms before it lands
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

    await playerMove(rerender, result.current)
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
    const steps: (AutoCompleteStep | null)[] = [null, null, { kind: 'drawAndPlay', entry: ACE_ENTRY, to: ACE_TO }]
    computeNextStep.mockImplementation(() => steps[board.n] ?? null)
    const { result, rerender, unmount } = await render()

    commit(WASTE) // a card the player dropped on the waste is still landing there
    commit(PLAY_TO) // and their foundation play arms the cascade
    result.current.afterPlayerMove(PLAY_TO)
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

    await playerMove(rerender, result.current)
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

    await playerMove(rerender, result.current)
    await advance(AUTO_PLAY_STAGGER_MS * 10)
    expect(firePlay).toHaveBeenCalledTimes(3)
    await rerender({ state: 'board-x' }) // a later board change, no foundation play: it stays stopped
    await advance(AUTO_PLAY_STAGGER_MS * 10)
    expect(firePlay).toHaveBeenCalledTimes(3)
    await unmount()
  })

  it('stops mid-cascade when Auto-Move is turned off, and does not pick up again when it is turned back on', async () => {
    const { enabled, playerMove, firePlay, render } = setup()
    const { result, rerender, unmount } = await render()

    await playerMove(rerender, result.current)
    await advance(AUTO_PLAY_STAGGER_MS)
    enabled.mockReturnValue(false)
    await advance(AUTO_PLAY_STAGGER_MS * 3)
    expect(firePlay).toHaveBeenCalledTimes(1)

    enabled.mockReturnValue(true)
    await playerMove(rerender, result.current, COLUMN) // the player's next move goes to a column
    await advance(AUTO_PLAY_STAGGER_MS * 3)
    expect(firePlay).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('stops mid-cascade when an undo starts, and does not pick up again once it is done', async () => {
    const { isBusy, playerMove, firePlay, render } = setup()
    const { result, rerender, unmount } = await render()

    await playerMove(rerender, result.current)
    await advance(AUTO_PLAY_STAGGER_MS)
    isBusy.mockReturnValue(true)
    await advance(AUTO_PLAY_STAGGER_MS * 3)
    expect(firePlay).toHaveBeenCalledTimes(1)

    isBusy.mockReturnValue(false)
    await rerender({ state: 'board-x' }) // a later board change, no foundation play
    await advance(AUTO_PLAY_STAGGER_MS * 3)
    expect(firePlay).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('a wait for a landing that never comes ends the cascade - a later board change fires nothing', async () => {
    const { board, commit, playerMove, firePlay, computeNextStep, render } = setup()
    computeNextStep.mockReturnValue({ kind: 'play', entry: ACE_ENTRY, to: ACE_TO })
    board.landing.set(key(WASTE), 1) // a card that never lands on the waste
    const { result, rerender, unmount } = await render()

    await playerMove(rerender, result.current)
    await advance(AUTO_PLAY_STAGGER_MS + 3000 + POLL_MS * 2) // past the hook's 3s MAX_LANDING_WAIT_MS
    expect(firePlay).not.toHaveBeenCalled()

    board.landing.set(key(WASTE), 0)
    commit(COLUMN) // the player's next move goes to a column
    await rerender({ state: board.current })
    await advance(AUTO_PLAY_STAGGER_MS * 3)
    expect(firePlay).not.toHaveBeenCalled()
    await unmount()
  })

  it('does not start while Auto-Move is off, or while an undo is running - and that play never fires later', async () => {
    for (const blocked of ['enabled', 'isBusy'] as const) {
      const harness = setup()
      if (blocked === 'enabled') harness.enabled.mockReturnValue(false)
      else harness.isBusy.mockReturnValue(true)
      const { result, rerender, unmount } = await harness.render()

      await harness.playerMove(rerender, result.current)
      await advance(AUTO_PLAY_STAGGER_MS * 3)
      expect([blocked, harness.firePlay.mock.calls.length]).toEqual([blocked, 0])

      // Auto-Move turned back on / the undo done, then a board change that is not a foundation play
      harness.enabled.mockReturnValue(true)
      harness.isBusy.mockReturnValue(false)
      harness.commit(COLUMN)
      await rerender({ state: harness.board.current })
      await advance(AUTO_PLAY_STAGGER_MS * 3)
      expect([blocked, harness.firePlay.mock.calls.length]).toEqual([blocked, 0])
      await unmount()
    }
  })

  it('disarm() drops a pending arm - a later board change fires nothing without a fresh arm call', async () => {
    const { firePlay, computeNextStep, render } = setup()
    const { result, rerender, unmount } = await render()

    result.current.afterPlayerMove(PLAY_TO)
    result.current.disarm() // e.g. an undo / new game landed in the same breath
    await rerender({ state: 'board-1' })
    await advance(AUTO_PLAY_STAGGER_MS * 3)
    expect(computeNextStep).not.toHaveBeenCalled()
    expect(firePlay).not.toHaveBeenCalled()
    await unmount()
  })

  it("isArmed() follows the player's moves and the loop, so a fire that awaited can re-check before it commits", async () => {
    const { board, playerMove, computeNextStep, render } = setup()
    computeNextStep.mockImplementation(() => (board.n < 3 ? STEP_PLAY : null))
    const { result, rerender, unmount } = await render()

    expect(result.current.isArmed()).toBe(false)
    await playerMove(rerender, result.current)
    expect(result.current.isArmed()).toBe(true)
    await playerMove(rerender, result.current, COLUMN) // the player's move elsewhere ends it
    expect(result.current.isArmed()).toBe(false)

    await playerMove(rerender, result.current)
    await advance(AUTO_PLAY_STAGGER_MS * 5) // runs dry
    expect(result.current.isArmed()).toBe(false)
    await unmount()
  })

  it('stops when the screen unmounts', async () => {
    const { playerMove, firePlay, render } = setup()
    const { result, rerender, unmount } = await render()

    await playerMove(rerender, result.current)
    await advance(AUTO_PLAY_STAGGER_MS)
    await unmount()
    await advance(AUTO_PLAY_STAGGER_MS * 5)
    expect(firePlay).toHaveBeenCalledTimes(1)
  })
})
