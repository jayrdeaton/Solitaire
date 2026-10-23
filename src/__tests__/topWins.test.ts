import { combineReducers, createStore } from '@reduxjs/toolkit'
import { persistReducer, persistStore } from 'redux-persist'

import { addTopWin, describeRank, ordinal, rankWin, TOP_WINS_KEPT, type TopWin, type TopWins, topWinsFrom, type WinsBefore } from '@/engine/topWins'
import recentWins from '@/redux/recentWinsSlice'
import topWins, { topWinsActions } from '@/redux/topWinsSlice'

// A player's best wins in a variant by score and by time (engine/topWins.ts), the win card's rank line ("3rd fastest ever")
// and the Records tab, and how the first boards are built from the wins kept before they existed (redux/topWinsSlice.ts).

const win = (moves: number, seconds: number, at: number | null = null): TopWin => ({ moves, seconds, score: moves + seconds, at })
const boardsOf = (...wins: TopWin[]): TopWins => wins.reduce<TopWins | undefined>((boards, w) => addTopWin(boards, w), undefined)!
// Before a new win, with every earlier one on the boards: the stats count as many wins as the boards saw.
const complete = (top: TopWins | undefined): WinsBefore => ({ top, wins: top?.seen ?? 0, bestScore: null, bestSeconds: null })

describe('the boards', () => {
  it('keep each board in order, lowest score and fastest first, and count every win offered', () => {
    const boards = boardsOf(win(100, 300), win(150, 200), win(120, 250))
    expect(boards.score.map((w) => w.score)).toEqual([350, 370, 400])
    expect(boards.time.map((w) => w.seconds)).toEqual([200, 250, 300])
    expect(boards.seen).toBe(3)
  })

  it('keep the earlier win ahead on a tie', () => {
    const boards = boardsOf(win(100, 200, 1), win(120, 180, 2))
    expect(boards.score.map((w) => w.at)).toEqual([1, 2])
  })

  it(`keep only the best ${TOP_WINS_KEPT} on each, still counting the rest`, () => {
    const boards = boardsOf(...Array.from({ length: 15 }, (_, i) => win(100, 200 + i)))
    expect(boards.time).toHaveLength(TOP_WINS_KEPT)
    expect(boards.time[TOP_WINS_KEPT - 1].seconds).toBe(209)
    expect(boards.seen).toBe(15)
  })

  it('are built from recent wins (oldest first) with no dates', () => {
    const boards = topWinsFrom([
      { moves: 100, seconds: 300, score: 400 },
      { moves: 90, seconds: 200, score: 290 }
    ])
    expect(boards.score).toEqual([win(90, 200), win(100, 300)])
    expect(boards.seen).toBe(2)
  })
})

describe('rankWin', () => {
  const three = boardsOf(win(100, 200), win(100, 300), win(100, 400)) // scores 300, 400, 500

  it('says nothing for a first win: there is nothing to compare it with', () => {
    expect(rankWin(complete(undefined), 'time', 120)).toBeNull()
  })

  it('places a win among every earlier one', () => {
    expect(rankWin(complete(three), 'time', 150)).toEqual({ rank: 1, tied: false })
    expect(rankWin(complete(three), 'time', 250)).toEqual({ rank: 2, tied: false })
    expect(rankWin(complete(three), 'score', 450)).toEqual({ rank: 3, tied: false })
  })

  it('says when it ties an earlier win', () => {
    expect(rankWin(complete(three), 'time', 300)).toEqual({ rank: 2, tied: true })
  })

  it('says nothing for the worst win so far: a 4th fastest of four is just the slowest', () => {
    expect(rankWin(complete(three), 'time', 450)).toBeNull()
    expect(rankWin(complete(three), 'time', 400)).toBeNull() // tied with the slowest, and nothing slower
  })

  it(`says nothing past the ${TOP_WINS_KEPT} best, and does rank the ${TOP_WINS_KEPT}th`, () => {
    const many = boardsOf(...Array.from({ length: 15 }, (_, i) => win(100, 200 + i * 10))) // 200, 210, ... 340; kept to 290
    expect(rankWin(complete(many), 'time', 285)).toEqual({ rank: TOP_WINS_KEPT, tied: false })
    expect(rankWin(complete(many), 'time', 295)).toBeNull()
  })

  it("ranks a tie with the board's last win: nothing kept is slower, but the wins that dropped off it were", () => {
    const many = boardsOf(...Array.from({ length: 15 }, (_, i) => win(100, 200 + i * 10)))
    expect(rankWin(complete(many), 'time', 290)).toEqual({ rank: TOP_WINS_KEPT, tied: true })
  })

  describe('when some earlier wins were never kept (won before the boards existed)', () => {
    // The boards saw three of the player's five wins; the stats know their best.
    const partial = (bestScore: number, bestSeconds: number): WinsBefore => ({ top: three, wins: 5, bestScore, bestSeconds })

    it('ranks only a win better than every one, the stats best included: the best ever', () => {
      expect(rankWin(partial(280, 180), 'time', 170)).toEqual({ rank: 1, tied: false })
      expect(rankWin(partial(280, 180), 'score', 279)).toEqual({ rank: 1, tied: false })
    })

    it('says nothing for a win the unkept ones could beat, or a tie with the best', () => {
      expect(rankWin(partial(280, 180), 'time', 190)).toBeNull() // best on the boards, but not of all
      expect(rankWin(partial(280, 180), 'time', 180)).toBeNull()
      expect(rankWin(partial(280, 180), 'time', 250)).toBeNull()
    })

    it('ranks against the boards when the stats have no best of their own (wins kept only on the boards)', () => {
      expect(rankWin({ top: three, wins: 5, bestScore: null, bestSeconds: null }, 'time', 150)).toEqual({ rank: 1, tied: false })
    })
  })

  it("trusts the boards when they saw more wins than the stats count (guest's stats started later than its recent wins)", () => {
    expect(rankWin({ top: three, wins: 1, bestScore: 450, bestSeconds: 350 }, 'time', 250)).toEqual({ rank: 2, tied: false })
  })
})

describe('the rank line', () => {
  it('names the place on each board', () => {
    expect(describeRank('time', { rank: 1, tied: false })).toBe('Fastest ever')
    expect(describeRank('time', { rank: 3, tied: false })).toBe('3rd fastest ever')
    expect(describeRank('score', { rank: 1, tied: false })).toBe('Best score ever')
    expect(describeRank('score', { rank: 2, tied: false })).toBe('2nd best score ever')
    expect(describeRank('score', { rank: 2, tied: true })).toBe('Tied for 2nd best score ever')
    expect(describeRank('time', { rank: 1, tied: true })).toBe('Tied for fastest ever')
  })

  it('writes ordinals', () => {
    expect([1, 2, 3, 4, 10, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '10th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th'])
  })
})

describe('topWinsSlice', () => {
  it('adds, forgets one player, and clears everyone', () => {
    let state = topWins(undefined, topWinsActions.add({ player: 'kid', variant: 'klondike', win: win(100, 200, 5) }))
    state = topWins(state, topWinsActions.add({ player: 'dad', variant: 'spider', win: win(90, 150, 6) }))
    expect(state.kid?.klondike?.score).toEqual([win(100, 200, 5)])
    state = topWins(state, topWinsActions.forget('kid'))
    expect(Object.keys(state)).toEqual(['dad'])
    expect(topWins(state, topWinsActions.clear())).toEqual({})
  })

  // store.ts's wiring (key 'root', the default reconciler) through real redux-persist against an in-memory storage.
  async function launch(items: Record<string, string>) {
    const storage = {
      getItem: async (key: string) => items[key] ?? null,
      setItem: async (key: string, value: string) => {
        items[key] = value
      },
      removeItem: async (key: string) => {
        delete items[key]
      }
    }
    const store = createStore(persistReducer({ key: 'root', storage, timeout: 0 }, combineReducers({ recentWins, topWins })))
    const persistor = persistStore(store)
    await new Promise<void>((resolve) => {
      if (persistor.getState().bootstrapped) resolve()
      else persistor.subscribe(() => persistor.getState().bootstrapped && resolve())
    })
    await persistor.flush()
    return store
  }

  it("builds each player's first boards from their recent wins, once: a store that has boards keeps them", async () => {
    const recent = { kid: { klondike: [{ moves: 100, seconds: 300, score: 400 }] }, guest: { golf: [{ moves: 40, seconds: 60, score: 100 }] } }
    const items: Record<string, string> = { 'persist:root': JSON.stringify({ recentWins: JSON.stringify(recent), _persist: JSON.stringify({ version: -1, rehydrated: true }) }) }

    const first = await launch(items)
    expect(first.getState().topWins).toEqual({ kid: { klondike: topWinsFrom(recent.kid.klondike) }, guest: { golf: topWinsFrom(recent.guest.golf) } })

    // A win later, the next launch reads the boards back as they were saved, not built again.
    first.dispatch(topWinsActions.add({ player: 'kid', variant: 'klondike', win: win(90, 200, 7) }))
    await persistStore(first).flush()
    const kept = first.getState().topWins
    const second = await launch(items)
    expect(second.getState().topWins).toEqual(kept)
    expect(second.getState().topWins.kid?.klondike?.seen).toBe(2)
  })

  it('starts a fresh install with no boards', async () => {
    expect((await launch({})).getState().topWins).toEqual({})
  })
})
