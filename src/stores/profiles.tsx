import { type CreateProfileInput, createProfileRecord, Profile, profilesActions, resolveInitialProfiles, useSharedProfilesSync } from '@tastic/profile'
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'

import { activeProfileActions } from '@/redux/activeProfileSlice'
import { type AppDispatch, type RootState } from '@/redux/store'
import { tableColorActions, type TableColorState } from '@/redux/tableColorSlice'
import { SplashGate } from '@/utils/splashGate'

// Same App Group the whole @tastic fleet (BoxHockey, LightCycles, ...) already declares in
// app.json's ios.entitlements - a profile created in any of those apps shows up here too.
const SHARED_GROUP_ID = 'group.com.infinitetoken.tastic'

export type ProfileEditPatch = CreateProfileInput

interface ProfilesContextValue {
  profiles: Profile[]
  activeProfileId: string | null
  activeProfile: Profile | null
  createProfile: (input: ProfileEditPatch) => Profile
  updateProfile: (id: string, patch: Partial<ProfileEditPatch>) => void
  deleteProfile: (id: string) => void
  selectProfile: (profileId: string | null) => void
  /** The seed color in effect (the card back, the felt and the Paper theme follow it): the selected
   * player's pick in Solitaire, else the selected profile's own color. Null only for a guest who has
   * never picked one (theme.ts's useTableColors() then falls back to DEFAULT_SEED_COLOR - every render
   * is tinted by *some* seed). See redux/tableColorSlice.ts. */
  tableColorOverride: string | null
  /** Saves `hex` as the selected player's pick, kept across relaunches. A profile's own color clears
   * its pick, so it follows that color again. */
  setTableColorOverride: (hex: string) => void
}

const ProfilesContext = createContext<ProfilesContextValue | null>(null)

interface Props {
  children: ReactNode
}

// The color in effect for the selection `id`: that profile's pick, else its own color; guest's pick for
// no selection or an id the roster doesn't have (the self-heal below drops one of those).
function colorFor(id: string | null, profiles: Profile[], { guestColor, profileColors }: TableColorState): string | null {
  const profile = id ? profiles.find((p) => p.id === id) : undefined
  if (!profile) return guestColor
  return profileColors?.[profile.id] ?? profile.color
}

const sameColor = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

// Single source of truth for saved player profiles, mounted in _layout.tsx once Redux/PersistGate
// have (see that file's own comment on why ProfilesProvider now sits inside PersistGate rather than
// wrapping the whole app, unlike before this migration) - expo-router keeps prior screens mounted,
// so a per-screen copy could go stale or clobber a concurrent update.
//
// `profiles` itself now lives in Redux (redux/store.ts's `profiles` key, @tastic/profile's own
// profilesReducer) - persisted locally the same way every other slice is (redux-persist), with the
// shared App Group roster layered on top as a separate, cross-app sync target (see
// resolveInitialProfiles/useSharedProfilesSync below). Mirrors Snake's/BoxHockey's/Pong's/
// AirHockey's identically-shaped useProfiles.tsx for that part - but unlike those (all multi-seat,
// with their own redux/profileSelectionSlice.ts holding a per-seat Record<SeatId, string | null>),
// Solitaire is single-player: `activeProfileId` is its own tiny redux/activeProfileSlice.ts holding
// just the one id, and there's a second Solitaire-only concern (each player's color pick,
// redux/tableColorSlice.ts) no other @tastic game has.
export function ProfilesProvider({ children }: Props) {
  const profiles = useSelector((state: RootState) => state.profiles)
  const activeProfileId = useSelector((state: RootState) => state.activeProfile)
  const tableColor = useSelector((state: RootState) => state.tableColor)
  const dispatch = useDispatch<AppDispatch>()
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    // PersistGate (an ancestor - see app/_layout.tsx) already blocks this component from mounting
    // until redux-persist has rehydrated, so `profiles`/`activeProfileId` here are
    // already whatever this device last had locally - resolveInitialProfiles reconciles `profiles`
    // against the shared App Group store (if available), seeding the shared store from it on a
    // first sync, or preferring the shared roster once anything has been shared.
    //
    // One thing beyond @tastic/profile's own helper, specific to Solitaire's extra local state:
    // self-heal activeProfileId if it now points at a profile the resolved roster doesn't have
    // (the shared roster can differ from what this device persisted). Done before `loaded` flips
    // true and SplashGate below releases children, so nothing downstream renders the dropped
    // selection (or its color, which is worked out from the selection) first.
    //
    // A one-time reconciliation against the mount-time snapshot, deliberately not a resync whenever
    // `profiles`/`activeProfileId` change afterward (the empty deps array below is
    // intentional, not a missed dependency - the dispatches inside would otherwise re-trigger this
    // effect).
    resolveInitialProfiles(SHARED_GROUP_ID, profiles).then((resolved) => {
      if (cancelled) return
      dispatch(profilesActions.setAll(resolved))
      const stillActive = activeProfileId && resolved.some((p) => p.id === activeProfileId) ? activeProfileId : null
      if (stillActive !== activeProfileId) dispatch(activeProfileActions.select(stillActive))
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Mirrors local writes out to the shared store (syncToShared, called from each CRUD function
  // below) and picks up remote writes a sibling @tastic app made while this one was backgrounded
  // (onRemoteChange) - see @tastic/profile's own doc for both.
  const { syncToShared } = useSharedProfilesSync({
    groupId: SHARED_GROUP_ID,
    onRemoteChange: useCallback(
      (remote: Profile[]) => {
        // loadSharedProfiles always returns a fresh array reference regardless of whether the
        // shared store's actual content changed - an unconditional setAll here would re-render
        // every useSelector(state => state.profiles) consumer (every visible card, via theme.ts's
        // useTableColors()) on every foreground resume - backgrounding briefly for a notification/
        // call/Control Center mid-game, not just app cold start - even when nothing about the
        // player's profile actually changed. Mirrors the pre-Redux version's identical guard.
        if (JSON.stringify(remote) !== JSON.stringify(profiles)) {
          dispatch(profilesActions.setAll(remote))
        }
        // Self-heal: clears activeProfileId if the profile it pointed at was deleted elsewhere,
        // rather than holding a dangling id, the same way the initial reconciliation effect above does.
        const cleared = activeProfileId && !remote.some((p) => p.id === activeProfileId) ? null : activeProfileId
        if (cleared !== activeProfileId) dispatch(activeProfileActions.select(cleared))
      },
      [dispatch, profiles, activeProfileId]
    )
  })

  const createProfile = useCallback(
    (input: ProfileEditPatch) => {
      const record = createProfileRecord(input)
      dispatch(profilesActions.add(record))
      syncToShared([...profiles, record])
      return record
    },
    [profiles, dispatch, syncToShared]
  )

  const updateProfile = useCallback(
    (id: string, patch: Partial<ProfileEditPatch>) => {
      // A new color for the profile itself (the Profiles screen) replaces its pick in Solitaire, or the
      // change would be hidden here. A save that keeps the color (a rename) leaves the pick alone.
      const current = profiles.find((p) => p.id === id)
      if (patch.color !== undefined && current && !sameColor(patch.color, current.color)) dispatch(tableColorActions.setColor({ id, color: null }))
      dispatch(profilesActions.update({ id, patch }))
      syncToShared(profiles.map((p) => (p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p)))
    },
    [profiles, dispatch, syncToShared]
  )

  const selectProfile = useCallback(
    (profileId: string | null) => {
      dispatch(activeProfileActions.select(profileId))
    },
    [dispatch]
  )

  const deleteProfile = useCallback(
    (id: string) => {
      dispatch(profilesActions.remove(id))
      syncToShared(profiles.filter((p) => p.id !== id))
      if (activeProfileId === id) selectProfile(null)
    },
    [profiles, dispatch, syncToShared, activeProfileId, selectProfile]
  )

  const activeProfile = profiles.find((p) => p.id === activeProfileId) ?? null
  const tableColorOverride = useMemo(() => colorFor(activeProfileId, profiles, tableColor), [activeProfileId, profiles, tableColor])

  const setTableColorOverride = useCallback(
    (hex: string) => {
      if (!activeProfile) dispatch(tableColorActions.setColor({ id: null, color: hex }))
      else dispatch(tableColorActions.setColor({ id: activeProfile.id, color: sameColor(hex, activeProfile.color) ? null : hex }))
    },
    [dispatch, activeProfile]
  )

  // Memoized so a ProfilesProvider re-render whose actual context content is unchanged (e.g. a
  // parent re-rendering for an unrelated reason) doesn't force every useProfiles() consumer - every
  // visible card, via theme.ts's useTableColors() - to re-render too. ProfilesProvider sits near
  // the root of the app (see app/_layout.tsx), so this cascades widely if unmemoized, same
  // reasoning GameStatsProvider's own context value already applies in this directory.
  const value = useMemo<ProfilesContextValue>(
    () => ({
      profiles,
      activeProfileId,
      activeProfile,
      createProfile,
      updateProfile,
      deleteProfile,
      selectProfile,
      tableColorOverride,
      setTableColorOverride
    }),
    [profiles, activeProfileId, activeProfile, createProfile, updateProfile, deleteProfile, selectProfile, tableColorOverride, setTableColorOverride]
  )

  return (
    <ProfilesContext.Provider value={value}>
      {/* Withholds children - everything downstream of this provider, including PlayingCard's/
      HeroCards' own activeProfile reads and theme.ts's useTableColors() - until the reconciliation
      effect above has fully resolved, so nothing can lock onto a pre-reconciliation snapshot. Also
      registers the 'profiles' splash gate (utils/splashGate.ts) from here instead of from
      _layout.tsx's own pre-mount loaders, now that resolving profiles genuinely depends on Redux/
      PersistGate having mounted first. See @rific/splash-gate's own
      README ("Guarding against a child that renders before its data does") for the general pattern
      this follows. */}
      <SplashGate gate='profiles' ready={loaded}>
        {children}
      </SplashGate>
    </ProfilesContext.Provider>
  )
}

export function useProfiles(): ProfilesContextValue {
  const ctx = useContext(ProfilesContext)
  if (!ctx) throw new Error('useProfiles must be used within a ProfilesProvider')
  return ctx
}
