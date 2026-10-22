import { GameController, Move } from '@/engine/gameTypes'
import { findHint } from '@/engine/hint'
import { ProgressSearch, ProgressSpec } from '@/engine/progressSearch'

// The look-ahead behind Hint and the dead-board check (engine/progressSearch.ts), on a toy game: each position is a node of
// a small graph, a move goes along an edge, a draw follows a node's own draw edge, and a node's `score` is its progress.

interface Node {
  to?: string[]
  draw?: string
  score?: number
  /** Edges only the dead-board check may take (ProgressSpec.rescueMoves). */
  rescue?: string[]
}
interface ToyState {
  node: string
}

function toyGame(graph: Record<string, Node>, opts: { drawIsStep?: boolean; scores?: Record<string, number> } = {}) {
  const names = Object.keys(graph)
  const states = Object.fromEntries(names.map((n) => [n, { node: n }])) as Record<string, ToyState>
  const edge = (from: string, to: string): Move => ({ from: { zone: 'n', index: names.indexOf(from) }, to: { zone: 'n', index: names.indexOf(to) }, count: 1 })
  const progress: ProgressSpec<ToyState> = {
    id: `toy-${Math.random()}`,
    moves: (s) => (graph[s.node].to ?? []).map((t) => edge(s.node, t)),
    rescueMoves: (s) => (graph[s.node].rescue ?? []).map((t) => edge(s.node, t)),
    drawIsStep: opts.drawIsStep ?? true,
    key: (s) => s.node,
    progress: (s) => [graph[s.node].score ?? 0]
  }
  const controller: GameController<ToyState> = {
    id: 'toy',
    title: 'Toy',
    newGame: () => states[names[0]],
    legalMoves: (s) => progress.moves(s),
    tryMove: (s, m) => {
      const from = names[m.from.index]
      const to = names[m.to.index]
      if (from !== s.node) return null
      return (graph[from].to ?? []).includes(to) || (graph[from].rescue ?? []).includes(to) ? states[to] : null
    },
    drawStock: (s) => (graph[s.node].draw ? states[graph[s.node].draw!] : null),
    isWon: () => false,
    scoreHintMove: (s, m) => opts.scores?.[`${s.node}>${names[m.to.index]}`] ?? 0,
    progress
  }
  return { controller, states, edge }
}

describe('ProgressSearch', () => {
  it('offers the first step of the shortest way to progress, not the first move it sees', () => {
    const { controller, states, edge } = toyGame({ a: { to: ['c', 'b'] }, b: { to: ['d'] }, c: { to: ['e'] }, d: { score: 1 }, e: { to: ['f'] }, f: { score: 1 } })
    const outcome = new ProgressSearch(controller, controller.progress!, states.a, 'hint').run(100)
    expect(outcome.found).toBe('progress')
    expect(outcome.firstSteps).toEqual([{ kind: 'move', move: edge('a', 'b') }])
  })

  it('gives the first step of every equally short way, once each', () => {
    const { controller, states, edge } = toyGame({ a: { to: ['b', 'c', 'd'] }, b: { to: ['x'] }, c: { to: ['y', 'x'] }, d: { to: ['a'] }, x: { score: 1 }, y: { score: 1 } })
    const outcome = new ProgressSearch(controller, controller.progress!, states.a, 'hint').run(100)
    expect(outcome.firstSteps).toEqual([
      { kind: 'move', move: edge('a', 'b') },
      { kind: 'move', move: edge('a', 'c') }
    ])
  })

  it('looks at every reachable position before it says there is no progress (exhausted)', () => {
    const { controller, states } = toyGame({ a: { to: ['b'] }, b: { to: ['a', 'c'] }, c: { to: ['b'] } })
    const outcome = new ProgressSearch(controller, controller.progress!, states.a, 'hint').run(100)
    expect(outcome).toMatchObject({ found: null, exhausted: true, firstSteps: [] })
  })

  it('stops at its budget without claiming the board is dead', () => {
    const long: Record<string, Node> = {}
    for (let i = 0; i < 50; i++) long[`n${i}`] = { to: [`n${i + 1}`] }
    long.n50 = { score: 1 }
    const { controller, states } = toyGame(long)
    const outcome = new ProgressSearch(controller, controller.progress!, states.n0, 'hint').run(10)
    expect(outcome).toMatchObject({ found: null, exhausted: false, nodes: 10 })
  })

  it('takes a draw as a step when the stock comes round again (drawIsStep)', () => {
    const { controller, states } = toyGame({ a: { draw: 'w' }, w: { score: 1 } })
    expect(new ProgressSearch(controller, controller.progress!, states.a, 'hint').run(100).firstSteps).toEqual([{ kind: 'draw' }])
    const dealt = toyGame({ a: { draw: 'w' }, w: { score: 1 } }, { drawIsStep: false })
    expect(new ProgressSearch(dealt.controller, dealt.controller.progress!, dealt.states.a, 'hint').run(100)).toMatchObject({ found: null, exhausted: true })
  })

  it('tries the rescue moves only when asked whether the board is alive', () => {
    const { controller, states } = toyGame({ a: { to: ['b'], rescue: ['r'] }, b: { to: ['a'] }, r: { to: ['p'] }, p: { score: 1 } })
    expect(new ProgressSearch(controller, controller.progress!, states.a, 'hint').run(100)).toMatchObject({ found: null, exhausted: true })
    expect(new ProgressSearch(controller, controller.progress!, states.a, 'alive').run(100)).toMatchObject({ found: 'progress', exhausted: false })
  })
})

describe('findHint with a look-ahead', () => {
  it('keeps the scored hint while it has something productive to offer', () => {
    // b scores; the look-ahead's shortest way to progress starts with c.
    const { controller, states, edge } = toyGame({ a: { to: ['b', 'c'] }, b: { to: ['x'] }, x: { to: ['y'] }, y: { score: 1 }, c: { score: 1 } }, { scores: { 'a>b': 5 } })
    expect(findHint(controller, states.a)).toEqual({ kind: 'move', move: edge('a', 'b'), choices: 2 })
  })

  it('replaces a move that gets nothing with the first step of the shortest way to progress', () => {
    // Nothing scores above 0: the scored hint would offer b, a dead end.
    const { controller, states, edge } = toyGame({ a: { to: ['b', 'c'] }, b: {}, c: { to: ['d'] }, d: { score: 1 } })
    expect(findHint(controller, states.a)).toEqual({ kind: 'move', move: edge('a', 'c'), choices: 1 })
  })

  it('offers no move on a board that can make no progress, and the stock if it still has cards to deal', () => {
    const dead = toyGame({ a: { to: ['b'] }, b: { to: ['a'] } }, { scores: { 'a>b': 5 } })
    expect(findHint(dead.controller, dead.states.a)).toEqual({ kind: 'none' })
    const withStock = toyGame({ a: { to: ['b'], draw: 'z' }, b: { to: ['a'] }, z: {} }, { drawIsStep: false })
    expect(findHint(withStock.controller, withStock.states.a)).toEqual({ kind: 'drawStock' })
  })

  it('offers a rescue move (a card back down off a foundation) when it is the only way on', () => {
    const { controller, states, edge } = toyGame({ a: { to: ['b'], rescue: ['r'] }, b: { to: ['a'] }, r: { to: ['p'] }, p: { score: 1 } })
    expect(findHint(controller, states.a)).toEqual({ kind: 'move', move: edge('a', 'r'), choices: 1 })
  })

  it('steps through the equally short ways with skip', () => {
    const { controller, states, edge } = toyGame({ a: { to: ['b', 'c'] }, b: { to: ['x'] }, c: { to: ['x2'] }, x: { score: 1 }, x2: { score: 1 } })
    expect(findHint(controller, states.a, 0)).toEqual({ kind: 'move', move: edge('a', 'b'), choices: 2 })
    expect(findHint(controller, states.a, 1)).toEqual({ kind: 'move', move: edge('a', 'c'), choices: 2 })
  })
})
