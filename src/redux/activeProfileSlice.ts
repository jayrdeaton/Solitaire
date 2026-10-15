import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

// Which profile THIS device is currently playing as - always local, never part of the shared App
// Group roster (@tastic/profile's own profiles slice, see store.ts). Solitaire is single-player,
// so unlike Snake/BoxHockey/Pong/AirHockey's per-seat profileSelectionSlice (a Record<SeatId,
// string | null>, one id per seat), this is just the one active id - its own slice rather than a
// field folded into `profiles` or `tableColor`, so each stays a single, obviously-named concern.
export type ActiveProfileState = string | null

// The key everything kept per player (saved games, settings) files Guest under while no profile is
// selected. Profile ids are `profile-<time>-<random>`, so it can never name a real profile.
export const GUEST_PLAYER_ID = 'guest'

const slice = createSlice({
  initialState: null as ActiveProfileState,
  name: 'activeProfile',
  reducers: {
    select: (_state, action: PayloadAction<string | null>) => action.payload
  }
})

export const activeProfileActions = slice.actions
export default slice.reducer
