import type { RecentWin } from './par'

// A player's best wins in one variant, by score and by time (a stats-loving friend of Jay's, 2026-10-23: "high scores are
// peak", and "game rank, 3rd fastest ever"). What the win card's rank line ("3rd fastest ever") and the Stats screen's
// Records tab read. Kept in redux/topWinsSlice.ts, by player, then variant.

/** How many of a player's best wins in a variant are kept, on each board. */
export const TOP_WINS_KEPT = 10

/** One win. `at`: when it was won (ms since the epoch), or null for a win kept from before the boards existed (seeded from
 * the player's recent wins, which have no date). */
export interface TopWin extends RecentWin {
  at: number | null
}

/** A board's ordering: lowest score first, or fastest first. */
export type TopWinsBoard = 'score' | 'time'

/** A player's best wins in one variant. `seen`: how many of their wins in it the boards have been offered (a win too slow
 * for either still counts), so comparing it with their wins in the stats tells whether every one of them was seen. */
export interface TopWins {
  score: TopWin[]
  time: TopWin[]
  seen: number
}

export const boardValue = (board: TopWinsBoard, win: RecentWin): number => (board === 'score' ? win.score : win.seconds)

// After every win at least as good, so on a tie the earlier win stays ahead.
function insert(board: TopWinsBoard, wins: readonly TopWin[], win: TopWin): TopWin[] {
  const value = boardValue(board, win)
  const at = wins.findIndex((w) => boardValue(board, w) > value)
  const next = at === -1 ? [...wins, win] : [...wins.slice(0, at), win, ...wins.slice(at)]
  return next.slice(0, TOP_WINS_KEPT)
}

/** The boards with one more win offered to them. */
export function addTopWin(prev: TopWins | undefined, win: TopWin): TopWins {
  return { score: insert('score', prev?.score ?? [], win), time: insert('time', prev?.time ?? [], win), seen: (prev?.seen ?? 0) + 1 }
}

/** Boards built from a player's recent wins (oldest first): the wins kept before the boards existed. */
export function topWinsFrom(recent: readonly RecentWin[]): TopWins {
  return recent.reduce<TopWins>((boards, win) => addTopWin(boards, { ...win, at: null }), { score: [], time: [], seen: 0 })
}

/** Where a win places among the player's earlier wins: 1 for the best. `tied` when an earlier win was exactly as good. */
export interface WinRank {
  rank: number
  tied: boolean
}

/** What is known about a player's wins in a variant just before a new one: their boards, and from their stats how many
 * wins they had and their best score and time (lower is better for both). */
export interface WinsBefore {
  top: TopWins | undefined
  wins: number
  bestScore: number | null
  bestSeconds: number | null
}

/**
 * Where a new win places on one board among the player's earlier wins, or null when it isn't worth saying or isn't known:
 * - Every earlier win was seen by the boards (`seen` covers the stats' wins): its exact place, if it is in the top
 *   TOP_WINS_KEPT and at least one earlier win was worse (a 3rd fastest of three is just the slowest).
 * - Some weren't (won before the boards existed, beyond the recent wins they were built from): nothing past the boards can
 *   be ranked, so only a win better than every one, the stats' best included, is: the best ever.
 * - A first win: there is nothing to compare it with.
 */
export function rankWin(before: WinsBefore, board: TopWinsBoard, value: number): WinRank | null {
  const kept = before.top?.[board] ?? []
  const seen = before.top?.seen ?? 0
  if (seen === 0 && before.wins === 0) return null
  if (seen >= before.wins) {
    const better = kept.filter((w) => boardValue(board, w) < value).length
    const worse = kept.some((w) => boardValue(board, w) > value) || seen > kept.length
    if (better >= TOP_WINS_KEPT || !worse) return null
    return { rank: better + 1, tied: kept.some((w) => boardValue(board, w) === value) }
  }
  const best = board === 'score' ? before.bestScore : before.bestSeconds
  const bests = [best, kept.length > 0 ? boardValue(board, kept[0]) : null].filter((b): b is number => b !== null)
  return bests.length > 0 && value < Math.min(...bests) ? { rank: 1, tied: false } : null
}

/** "1st", "2nd", "3rd", "11th", "22nd". */
export function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`
}

/** One board's rank as the win card says it: "Best score ever", "3rd fastest ever", "Tied for 2nd best score ever". */
export function describeRank(board: TopWinsBoard, { rank, tied }: WinRank): string {
  const place = rank === 1 ? '' : `${ordinal(rank)} `
  const what = board === 'score' ? `${place}best score` : `${place}fastest`
  return tied ? `Tied for ${what} ever` : `${what.charAt(0).toUpperCase()}${what.slice(1)} ever`
}
