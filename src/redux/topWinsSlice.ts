import { createSlice, type PayloadAction, type UnknownAction } from '@reduxjs/toolkit'
import { REHYDRATE } from 'redux-persist'

import { addTopWin, type TopWin, type TopWins, topWinsFrom } from '@/engine/topWins'
import type { VariantId } from '@/engine/variants'

import type { RecentWinsState } from './recentWinsSlice'

// Each player's best wins in each variant, by score and by time (engine/topWins.ts): the win card's rank line and the Stats
// screen's Records tab. Keyed by player (a profile id, or GUEST_PLAYER_ID while no profile is selected), then variant.
// Written by stores/gameStats.tsx's recordDealWon; a player's are dropped with their stats (stores/playerData.ts),
// everyone's by Reset Stats on Everyone.
//
// Started 2026-10-23. A store from before has no `topWins`, so on that first rehydrate each player's boards are built from
// the wins their par is made from (redux/recentWinsSlice.ts: their latest 20 in each variant, kept since 2026-10-17), the
// only wins from before with a time, moves and score. Wins older than those were never kept, which rankWin allows for.
export type TopWinsState = Record<string, Partial<Record<VariantId, TopWins>>>

const initialState: TopWinsState = {}

interface RehydrateAction extends UnknownAction {
  type: typeof REHYDRATE
  key: string
  payload?: { topWins?: TopWinsState; recentWins?: RecentWinsState }
}

const isRootRehydrate = (action: UnknownAction): action is RehydrateAction => action.type === REHYDRATE && (action as RehydrateAction).key === 'root'

/** Every player's boards built from their recent wins. */
export function topWinsFromRecent(recent: RecentWinsState): TopWinsState {
  return Object.fromEntries(Object.entries(recent).map(([player, variants]) => [player, Object.fromEntries(Object.entries(variants).map(([variant, wins]) => [variant, topWinsFrom(wins ?? [])]))]))
}

const slice = createSlice({
  initialState,
  name: 'topWins',
  reducers: {
    add: (state, action: PayloadAction<{ player: string; variant: VariantId; win: TopWin }>) => {
      const { player, variant, win } = action.payload
      const wins = state[player] ?? (state[player] = {})
      wins[variant] = addTopWin(wins[variant], win)
    },
    forget: (state, action: PayloadAction<string>) => {
      delete state[action.payload]
    },
    clear: () => initialState
  },
  extraReducers: (builder) => {
    // A changed value here is kept over the (missing) stored one: redux-persist's default merge takes a stored key only
    // where the reducers left the state alone, so a store that already has boards rehydrates them untouched.
    builder.addMatcher(isRootRehydrate, (state, action) => (action.payload && action.payload.topWins === undefined && action.payload.recentWins ? topWinsFromRecent(action.payload.recentWins) : state))
  }
})

export const topWinsActions = slice.actions
export default slice.reducer
