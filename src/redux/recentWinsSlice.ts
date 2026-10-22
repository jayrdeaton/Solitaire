import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

import { RECENT_WINS_KEPT, type RecentWin } from '@/engine/par'
import type { VariantId } from '@/engine/variants'

// Each player's latest wins in each variant, oldest first, the most RECENT_WINS_KEPT: what their par is made from
// (engine/par.ts' playerParFor). Keyed by player (a profile id, or GUEST_PLAYER_ID while no profile is selected), then
// variant. Written by stores/gameStats.tsx's recordDealWon; a player's are dropped with their stats (stores/playerData.ts),
// everyone's by Reset Stats on Everyone. Stats only keep a best per variant, so nothing from before this (2026-10-17)
// fills it: every player starts on expert par.
export type RecentWinsState = Record<string, Partial<Record<VariantId, RecentWin[]>>>

const initialState: RecentWinsState = {}

const slice = createSlice({
  initialState,
  name: 'recentWins',
  reducers: {
    add: (state, action: PayloadAction<{ player: string; variant: VariantId; win: RecentWin }>) => {
      const { player, variant, win } = action.payload
      const wins = state[player] ?? (state[player] = {})
      wins[variant] = [...(wins[variant] ?? []), win].slice(-RECENT_WINS_KEPT)
    },
    forget: (state, action: PayloadAction<string>) => {
      delete state[action.payload]
    },
    clear: () => initialState
  }
})

export const recentWinsActions = slice.actions
export default slice.reducer
