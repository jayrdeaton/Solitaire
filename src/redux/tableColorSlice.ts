import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

export interface TableColorState {
  // The live table-felt color currently in effect - the active profile's own color by default,
  // guest's remembered color when no profile is active, or a same-session pick that overrides
  // either of those (see stores/profiles.tsx's own ProfilesContextValue.tableColorOverride doc:
  // "Only guest's picks are remembered, since guest has no profile record of its own to reset back
  // to"). redux-persist still persists this field verbatim, same as every other slice - no
  // blacklist/transform - but that persisted value is never trusted as-is on its own:
  // stores/profiles.tsx's ProfilesProvider always overwrites it with a freshly-computed reset (the
  // resolved active profile's own color, or guestColor) once Redux has rehydrated and
  // resolveInitialProfiles has settled, the same one-time-reconciliation shape `profiles` itself
  // goes through. That reset is what actually keeps a profile's own ephemeral pick from surviving a
  // reload, not the persistence config - see the effect's own comment for why.
  override: string | null
  // Guest's own remembered pick - null only if guest has never chosen one. The one field in this
  // slice that genuinely is meant to survive a reload as-is, mirroring the pre-Redux version's own
  // separate GUEST_COLOR_KEY AsyncStorage entry.
  guestColor: string | null
}

const initialState: TableColorState = { guestColor: null, override: null }

const slice = createSlice({
  initialState,
  name: 'tableColor',
  reducers: {
    // A same-session pick made while a real profile is active - live only, deliberately never
    // mirrored into guestColor (see this file's own TableColorState.override doc).
    setOverride: (state, action: PayloadAction<string | null>) => {
      state.override = action.payload
    },
    // A same-session pick made while nobody's the active profile (guest) - unlike setOverride,
    // this one IS meant to survive a reload, so it updates both fields together.
    setGuestColor: (state, action: PayloadAction<string>) => {
      state.guestColor = action.payload
      state.override = action.payload
    }
  }
})

export const tableColorActions = slice.actions
export default slice.reducer
