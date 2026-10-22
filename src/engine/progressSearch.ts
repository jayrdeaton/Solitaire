import { GameController, Move } from './gameTypes'

/** One step of a search: a move, or a draw from the stock. */
export type SearchStep = { kind: 'move'; move: Move } | { kind: 'draw' }

/**
 * A game's idea of progress, for the look-ahead behind Hint (engine/hint.ts) and the dead-board check
 * (games/shared/useStuckLossCheck.ts). Optional on GameController: a game without one keeps the plain scored Hint.
 */
export interface ProgressSpec<S> {
  /** The rules this describes, e.g. 'klondike-draw3': a board's look-ahead is kept by it (engine/hint.ts), and two specs
   * with the same id search alike, so a screen's rules made twice share one. */
  id: string
  /** Every move worth looking at from here. Unlike legalMoves, which narrows each run to the one column tap-to-move would
   * pick, every destination: the dead-board check is only exact when nothing reachable is left out (see allDestinations). */
  moves(state: S): Move[]
  /** Moves the dead-board check also tries but Hint never suggests: a card back down off a foundation. Hint leaving them
   * out isn't only taste: the board after one is a foundation card short, so from there the card going straight back up
   * is "progress", and Hint would offer the two moves turn about. */
  rescueMoves?(state: S): Move[]
  /** Whether a draw is a step of the search. True for a stock that turns over and comes round again (Klondike, Canfield,
   * Pyramid): drawing is only a way to reach its cards. False for a stock dealt out for good (Spider, Scorpion, Aces Up,
   * Forty Thieves): the search stays on the board in front of the player, and a draw is what's left when it finds nothing. */
  drawIsStep: boolean
  /** Two states with the same key are the same position (columns may be listed in any order). */
  key(state: S): string
  /** Counts that only ever go up as a deal is won: cards turned over, cards on the foundations, runs completed, cards
   * cleared. A position is progress when any of them is higher than where the search started. Winning always raises one,
   * so a board from which no position is progress can't be won. */
  progress(state: S): number[]
}

export interface SearchOutcome {
  /** Whether the search reached progress. */
  found: 'progress' | null
  /** The first step of every shortest way there, in the order Hint should offer them. */
  firstSteps: SearchStep[]
  /** Every position reachable from the start was looked at, so `found: null` means the board can't make progress. */
  exhausted: boolean
  /** Positions expanded. */
  nodes: number
}

/** 'hint' finds the shortest ways to progress (all of their first steps); 'alive' stops at the first progress it finds,
 * and is only interested in whether there is any (and tries the rescue moves too). */
export type SearchMode = 'hint' | 'alive'

interface SearchNode<S> {
  state: S
  first: SearchStep | null
  depth: number
}

function higher(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] > b[i]) return true
  return false
}

function stepKey(step: SearchStep): string {
  return step.kind === 'draw' ? 'draw' : `${step.move.from.zone}${step.move.from.index}>${step.move.to.zone}${step.move.to.index}x${step.move.count}`
}

type SearchController<S> = Pick<GameController<S>, 'tryMove'> & Partial<Pick<GameController<S>, 'drawStock' | 'scoreHintMove'>>

/**
 * A breadth-first look-ahead from one position, run in slices (`step`) so a long one can be spread over several frames.
 * Every position is expanded once (by `spec.key`). A position that is progress over the start is a goal and is not looked
 * past: Hint only needs the first step toward it, and a card turned over is all the search may know about it (it can see
 * face-down cards, but a hint must not lean on them).
 */
export class ProgressSearch<S> {
  private readonly queue: SearchNode<S>[] = []
  private head = 0
  private readonly seen = new Set<string>()
  private readonly startProgress: number[]
  private progressDepth = Infinity
  private readonly progressFirst: SearchStep[] = []
  private readonly progressKeys = new Set<string>()
  private nodes = 0
  private done = false
  private exhausted = false

  constructor(
    private readonly controller: SearchController<S>,
    private readonly spec: ProgressSpec<S>,
    start: S,
    private readonly mode: SearchMode
  ) {
    this.startProgress = spec.progress(start)
    this.seen.add(spec.key(start))
    this.queue.push({ state: start, first: null, depth: 0 })
  }

  /** Expands up to `maxNodes` more positions; true once the search has its answer. */
  step(maxNodes: number): boolean {
    if (this.done) return true
    const stopAt = this.nodes + maxNodes
    while (this.nodes < stopAt) {
      if (this.head >= this.queue.length) {
        this.exhausted = true
        this.done = true
        return true
      }
      const node = this.queue[this.head]
      // Every shortest way to progress has been found once the level before it is fully expanded.
      if (node.depth >= this.progressDepth) {
        this.done = true
        return true
      }
      this.queue[this.head++] = undefined as unknown as SearchNode<S>
      this.nodes++
      if (this.expand(node)) {
        this.done = true
        return true
      }
    }
    return false
  }

  /** Positions expanded so far. */
  get expanded(): number {
    return this.nodes
  }

  /** Runs to the end, or until `budget` positions have been expanded, or (given) `maxMs` have passed. */
  run(budget: number, maxMs = Infinity): SearchOutcome {
    const until = Date.now() + maxMs
    while (this.nodes < budget && !this.step(Math.min(25, budget - this.nodes))) {
      if (Date.now() >= until) break
    }
    return this.outcome()
  }

  outcome(): SearchOutcome {
    const found = this.progressFirst.length > 0 ? 'progress' : null
    return { found, firstSteps: this.progressFirst, exhausted: this.exhausted && found === null, nodes: this.nodes }
  }

  /** True when the search can stop (alive mode found progress). */
  private expand(node: SearchNode<S>): boolean {
    const { controller, spec } = this
    const moves = this.orderedMoves(node)
    if (this.mode === 'alive' && spec.rescueMoves) moves.push(...spec.rescueMoves(node.state))
    const steps: SearchStep[] = moves.map((move) => ({ kind: 'move', move }))
    if (spec.drawIsStep && controller.drawStock) steps.push({ kind: 'draw' })
    for (const step of steps) {
      const next = step.kind === 'draw' ? controller.drawStock!(node.state) : controller.tryMove(node.state, step.move)
      if (!next) continue
      const key = spec.key(next)
      if (this.seen.has(key)) continue
      this.seen.add(key)
      const first = node.first ?? step
      const depth = node.depth + 1
      if (higher(spec.progress(next), this.startProgress)) {
        if (this.mode === 'alive') {
          this.progressFirst.push(first)
          return true
        }
        this.progressDepth = Math.min(this.progressDepth, depth)
        const firstKey = stepKey(first)
        if (depth === this.progressDepth && !this.progressKeys.has(firstKey)) {
          this.progressKeys.add(firstKey)
          this.progressFirst.push(first)
        }
        continue
      }
      this.queue.push({ state: next, first, depth })
    }
    return false
  }

  /** At the start, the order Hint should offer moves in when several get somewhere equally soon: foundation moves first,
   * then the game's own scorer. Deeper down the order doesn't matter, so it is left as it comes. */
  private orderedMoves(node: SearchNode<S>): Move[] {
    const moves = this.spec.moves(node.state)
    if (node.depth > 0 || this.mode === 'alive') return moves
    const score = this.controller.scoreHintMove
    const rank = (m: Move) => (m.to.zone === 'foundation' ? 1e9 : 0) + (score ? score(node.state, m) : 0)
    return moves
      .map((m, i) => ({ m, i, r: rank(m) }))
      .sort((a, b) => b.r - a.r || a.i - b.i)
      .map((x) => x.m)
  }
}

/** Positions, and milliseconds, a Hint press looks at itself when the look-ahead run after the last move hasn't finished
 * yet. A position costs ~5-15us in Node (Klondike to Spider with empty columns: ~70us), several times that in Hermes, so the
 * time cap is what holds on a phone; the few boards that need more get the background's answer once it has one. */
export const HINT_SEARCH_BUDGET = 1500
export const HINT_SEARCH_MAX_MS = 80

/** Positions the look-ahead after each move expands (games/shared/useBoardLookahead.ts), a few at a time: enough to find
 * progress on nearly every board, and to see that a dead board is dead (5,000-11,000 positions on Klondike's hardest).
 * LOOKAHEAD_MAX_MS caps the time it spends, in slices, on any one board, whatever the phone: a board it runs out on is
 * simply not known to be dead. */
export const LOOKAHEAD_BUDGET = 40000
export const LOOKAHEAD_MAX_MS = 1000

/** Whether an outcome is the whole answer: progress found, or every reachable position looked at. Anything else is
 * worth looking at further. */
export function isConclusive(outcome: SearchOutcome): boolean {
  return outcome.found === 'progress' || outcome.exhausted
}

/**
 * legalMoves narrowed to one destination per run (the column tap-to-move picks); this adds every other pile of the
 * `zones` named (e.g. { tableau: 7 }) that takes the same run, and any `extra` moves the game allows but legalMoves never
 * offers (a card back down off a foundation). Duplicates are dropped.
 */
export function allDestinations<S>(controller: Pick<GameController<S>, 'legalMoves' | 'tryMove'>, state: S, zones: Record<string, number>, extra: Move[] = []): Move[] {
  const out: Move[] = []
  const seen = new Set<string>()
  const add = (move: Move, checked: boolean) => {
    const key = `${move.from.zone}${move.from.index}>${move.to.zone}${move.to.index}x${move.count}`
    if (seen.has(key)) return
    seen.add(key)
    if (checked || controller.tryMove(state, move)) out.push(move)
  }
  const legal = controller.legalMoves(state)
  for (const move of legal) add(move, true)
  for (const move of legal) {
    const size = zones[move.to.zone]
    if (size === undefined) continue
    for (let i = 0; i < size; i++) if (i !== move.to.index) add({ from: move.from, to: { zone: move.to.zone, index: i }, count: move.count }, false)
  }
  for (const move of extra) add(move, false)
  return out
}

/** A foundation's top card back down onto each column that takes it (`takes(column, [card])`), for a game whose tryMove
 * allows it but whose legalMoves never offers it (see allDestinations' `extra`). */
export function foundationDownMoves<C>(foundations: readonly (readonly C[])[], columns: readonly C[][], takes: (column: C[], moving: C[]) => boolean): Move[] {
  const moves: Move[] = []
  foundations.forEach((pile, f) => {
    const card = pile[pile.length - 1]
    if (card === undefined) return
    columns.forEach((column, t) => {
      if (takes(column, [card])) moves.push({ from: { zone: 'foundation', index: f }, to: { zone: 'tableau', index: t }, count: 1 })
    })
  })
  return moves
}

// One character per card in a position key: its suit and rank, and whether it is face-down (the deck it came from doesn't
// matter: two of a kind are interchangeable).
const SUIT_CODE: Record<string, number> = { clubs: 0, diamonds: 1, hearts: 2, spades: 3 }

/** A pile in a position key. */
export function pileKey(cards: readonly { suit: string; rank: number; faceUp: boolean }[]): string {
  let key = ''
  for (const c of cards) key += String.fromCharCode(48 + (SUIT_CODE[c.suit] ?? 0) * 13 + c.rank + (c.faceUp ? 0 : 60))
  return key
}

/** Columns in a position key, in any order: the same cards in other columns are the same position. */
export function columnsKey(columns: readonly (readonly { suit: string; rank: number; faceUp: boolean }[])[]): string {
  return columns.map(pileKey).sort().join('|')
}

/** Cards face-down in the columns. */
export function faceDownCount(columns: readonly (readonly { faceUp: boolean }[])[]): number {
  let n = 0
  for (const col of columns) for (const c of col) if (!c.faceUp) n++
  return n
}
