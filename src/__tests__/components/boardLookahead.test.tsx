import { act, renderHook } from '@testing-library/react-native'

import { GameController, Move } from '@/engine/gameTypes'
import { ProgressSpec } from '@/engine/progressSearch'
import { useStuckLossCheck } from '@/games/shared/useStuckLossCheck'

jest.mock('@/stores/gameInProgress', () => ({ clearGameInProgress: jest.fn() }))

// The dead-board check behind the loss dialog: useStuckLossCheck asks useBoardLookahead, which looks ahead from each board in
// the background (in slices, after a short wait) and calls a board dead only once it has looked at everything reachable and
// found no progress. Every game with an idea of progress gets the loss dialog this way, where only Aces Up, Golf, TriPeaks,
// Forty Thieves and Scorpion had one (a coworker of Jay's, 2026-10-22: "There is no game over dialog on a loss").

interface ToyState {
  node: string
}
type Graph = Record<string, { to?: string[]; rescue?: string[]; draw?: string; score?: number }>

let nextId = 0
function toy(graph: Graph, drawIsStep = true) {
  const names = Object.keys(graph)
  const states = Object.fromEntries(names.map((n) => [n, { node: n }])) as Record<string, ToyState>
  const edge = (from: string, to: string): Move => ({ from: { zone: 'n', index: names.indexOf(from) }, to: { zone: 'n', index: names.indexOf(to) }, count: 1 })
  const progress: ProgressSpec<ToyState> = {
    id: `toy-${nextId++}`,
    moves: (s) => (graph[s.node].to ?? []).map((t) => edge(s.node, t)),
    rescueMoves: (s) => (graph[s.node].rescue ?? []).map((t) => edge(s.node, t)),
    drawIsStep,
    key: (s) => s.node,
    progress: (s) => [graph[s.node].score ?? 0]
  }
  const controller: Pick<GameController<ToyState>, 'tryMove' | 'isWon' | 'drawStock' | 'progress'> = {
    tryMove: (s, m) => {
      const from = names[m.from.index]
      const to = names[m.to.index]
      return from === s.node && ((graph[from].to ?? []).includes(to) || (graph[from].rescue ?? []).includes(to)) ? states[to] : null
    },
    drawStock: (s) => (graph[s.node].draw ? states[graph[s.node].draw!] : null),
    isWon: () => false,
    progress
  }
  return { controller, states }
}

const session = (moves: number) => ({ getMoves: () => moves, getElapsed: () => 42 })

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

const settle = () => act(() => jest.advanceTimersByTime(1000))

describe('the dead-board check (useStuckLossCheck + useBoardLookahead)', () => {
  it('calls a board dead once it has looked everywhere and found no progress, and not before', async () => {
    const { controller, states } = toy({ a: { to: ['b'] }, b: { to: ['a'] } })
    const { result } = await renderHook(() => useStuckLossCheck(controller, states.a, 'klondike', jest.fn(), session(3)))
    expect(result.current.stuck).toBe(false)
    await settle()
    expect(result.current.stuck).toBe(true)
  })

  it('leaves a board that can still make progress alone', async () => {
    const { controller, states } = toy({ a: { to: ['b'] }, b: { to: ['c'] }, c: { score: 1 } })
    const { result } = await renderHook(() => useStuckLossCheck(controller, states.a, 'klondike', jest.fn(), session(3)))
    await settle()
    expect(result.current.stuck).toBe(false)
  })

  it('never calls a board dead while a stock that is dealt for good still has cards', async () => {
    const { controller, states } = toy({ a: { to: ['b'], draw: 'z' }, b: { to: ['a'] }, z: {} }, false)
    const { result } = await renderHook(() => useStuckLossCheck(controller, states.a, 'spider', jest.fn(), session(3)))
    await settle()
    expect(result.current.stuck).toBe(false)
  })

  it('tries the rescue moves (a card back down off a foundation) before calling a board dead', async () => {
    const { controller, states } = toy({ a: { to: ['b'], rescue: ['r'] }, b: { to: ['a'] }, r: { to: ['p'] }, p: { score: 1 } })
    const { result } = await renderHook(() => useStuckLossCheck(controller, states.a, 'klondike', jest.fn(), session(3)))
    await settle()
    expect(result.current.stuck).toBe(false)
  })

  it('records the loss, with its time and moves, when the player leaves the dead board', async () => {
    const { controller, states } = toy({ a: { to: ['b'] }, b: { to: ['a'] } })
    const record = jest.fn()
    const { unmount } = await renderHook(() => useStuckLossCheck(controller, states.a, 'yukon', record, session(7)))
    await settle()
    await act(() => unmount())
    expect(record).toHaveBeenCalledWith('yukon', { seconds: 42, moves: 7 })
  })

  it('records nothing for a deal that was dead from the start and left without a move', async () => {
    const { controller, states } = toy({ a: { to: ['b'] }, b: { to: ['a'] } })
    const record = jest.fn()
    const { unmount } = await renderHook(() => useStuckLossCheck(controller, states.a, 'yukon', record, session(0)))
    await settle()
    await act(() => unmount())
    expect(record).not.toHaveBeenCalled()
  })
})
