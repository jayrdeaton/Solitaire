import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

// The color each player has picked in Solitaire (the card back, the felt and the Paper theme all follow
// it): Home's player dropdown, "Solitaire only". It stays in Solitaire: a profile's own color (the
// one every Tastic game shares) is only ever changed on the Profiles screen. Kept across relaunches
// (Jay, 2026-10-16: "an override SHOULD live on relaunch"); before that a profile's pick lasted only
// until the next launch or profile switch, and only guest's was kept. The live color is never stored:
// stores/profiles.tsx works it out from this, the roster and the selection (`colorFor`), so a
// selection change, a deletion or a sibling app's roster change can't leave a stale one behind.
//
// Stores saved before 2026-10-16 also hold an `override` key (the old live color); nothing reads it.
export interface TableColorState {
  // Guest's pick - null until guest picks one.
  guestColor: string | null
  // Each profile's pick, by profile id. A profile not listed shows its own color. Absent in a store
  // saved before 2026-10-16 (redux-persist puts the saved slice back as it was).
  profileColors?: Record<string, string>
}

const initialState: TableColorState = { guestColor: null, profileColors: {} }

const slice = createSlice({
  initialState,
  name: 'tableColor',
  reducers: {
    // A pick: `id` null is guest. A profile given back its own color (`color` null) is dropped from the
    // map, so it follows that color again, including later changes to it.
    setColor: (state, action: PayloadAction<{ id: string | null; color: string | null }>) => {
      const { id, color } = action.payload
      if (id === null) {
        state.guestColor = color
        return
      }
      const profileColors = { ...state.profileColors }
      if (color === null) delete profileColors[id]
      else profileColors[id] = color
      state.profileColors = profileColors
    },
    // A deleted profile (stores/playerData.ts' forgetPlayer).
    forget: (state, action: PayloadAction<string>) => {
      if (!state.profileColors?.[action.payload]) return
      const profileColors = { ...state.profileColors }
      delete profileColors[action.payload]
      state.profileColors = profileColors
    }
  }
})

export const tableColorActions = slice.actions
export default slice.reducer
