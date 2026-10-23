import { renderHook } from '@testing-library/react-native'

import { useStuckLossCheck } from '@/games/shared/useStuckLossCheck'
import { clearGameInProgress } from '@/stores/gameInProgress'

jest.mock('@/stores/gameInProgress', () => ({ clearGameInProgress: jest.fn(() => Promise.resolve()) }))
// The dead-board loss is off for now (constants/deadBoardLoss.ts); these cases cover it as it works when it is back on.
const mockDeadBoardLoss = { on: true }
jest.mock('@/constants/deadBoardLoss', () => ({
  get DEAD_BOARD_LOSS() {
    return mockDeadBoardLoss.on
  }
}))

// A dead board's loss is recorded when the player LEAVES it, so an Undo out of the loss dialog cancels it instead of
// leaving a recorded loss behind (which then counted the deal twice: a loss and a win, or two losses).
// New Game records it through the screen's own handleNewGame; leaving the screen (Home) records it here.

const controller = { isStuck: (s: { dead: boolean }) => s.dead }

async function setup(initial: { dead: boolean }) {
  const record = jest.fn()
  const view = await renderHook(({ state }: { state: { dead: boolean } }) => useStuckLossCheck(controller, state, 'golf', record), { initialProps: { state: initial } })
  return { record, view }
}

beforeEach(() => {
  mockDeadBoardLoss.on = true
  jest.mocked(clearGameInProgress).mockClear()
})

describe('useStuckLossCheck', () => {
  it('reports a dead board without recording or clearing anything', async () => {
    const { record, view } = await setup({ dead: false })
    await view.rerender({ state: { dead: true } })
    expect(view.result.current.stuck).toBe(true)
    expect(record).not.toHaveBeenCalled()
    expect(clearGameInProgress).not.toHaveBeenCalled()
  })

  it('records the loss once, and clears the save, when the player leaves the dead board', async () => {
    const { record, view } = await setup({ dead: false })
    await view.rerender({ state: { dead: true } })
    await view.unmount()
    expect(record).toHaveBeenCalledTimes(1)
    expect(record).toHaveBeenCalledWith('golf')
    expect(clearGameInProgress).toHaveBeenCalledWith('golf')
  })

  it('records nothing when an Undo took the board out of the loss before leaving', async () => {
    const { record, view } = await setup({ dead: false })
    await view.rerender({ state: { dead: true } })
    await view.rerender({ state: { dead: false } })
    await view.unmount()
    expect(record).not.toHaveBeenCalled()
    expect(clearGameInProgress).not.toHaveBeenCalled()
  })

  it('is off by default: a dead board is never stuck, so nothing is shown, stopped or recorded', async () => {
    mockDeadBoardLoss.on = jest.requireActual('@/constants/deadBoardLoss').DEAD_BOARD_LOSS
    expect(mockDeadBoardLoss.on).toBe(false)
    const { record, view } = await setup({ dead: true })
    expect(view.result.current.stuck).toBe(false)
    await view.unmount()
    expect(record).not.toHaveBeenCalled()
    expect(clearGameInProgress).not.toHaveBeenCalled()
  })
})
