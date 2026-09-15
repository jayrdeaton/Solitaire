import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

// Which profile THIS device is currently playing as - always local, never part of the shared App
// Group roster (@tastic/profile's own profiles slice, see store.ts). Solitaire is single-player,
// so unlike Snake/BoxHockey/Pong/AirHockey's per-seat profileSelectionSlice (a Record<SeatId,
// string | null>, one id per seat), this is just the one active id - its own slice rather than a
// field folded into `profiles` or `tableColor`, so each stays a single, obviously-named concern.
export type ActiveProfileState = string | null

const slice = createSlice({
  initialState: null as ActiveProfileState,
  name: 'activeProfile',
  reducers: {
    select: (_state, action: PayloadAction<string | null>) => action.payload
  }
})

export const activeProfileActions = slice.actions
export default slice.reducer
