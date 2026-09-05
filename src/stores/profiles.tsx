import AsyncStorage from '@react-native-async-storage/async-storage';
import { isSharedProfileStoreAvailable, isValidProfile, loadSharedProfiles, type Profile, saveSharedProfiles } from '@tastic/profile';
import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

const LOCAL_KEY = 'solitaire.profiles.v1';
// Same App Group the whole @tastic fleet (BoxHockey, LightCycles, ...) already declares in
// app.json's ios.entitlements - a profile created in any of those apps shows up here too.
const SHARED_GROUP_ID = 'group.com.infinitetoken.tastic';
// Device-local only, deliberately separate from the shared-App-Group profile sync above - Guest
// isn't a profile record, just this device's own remembered color for when nobody's selected.
const GUEST_COLOR_KEY = 'solitaire.guest-color.v1';

interface LocalProfilesState {
  // Only authoritative when isSharedProfileStoreAvailable is false (Android/web, or an iOS build
  // that hasn't been prebuilt since the entitlement was added).
  localBase: Profile[];
  // Which profile THIS device is playing as is always local, never shared.
  activeProfileId: string | null;
}

const DEFAULT_LOCAL_STATE: LocalProfilesState = { localBase: [], activeProfileId: null };

function isValidLocalState(value: unknown): value is LocalProfilesState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<LocalProfilesState>;
  return (
    Array.isArray(v.localBase) &&
    v.localBase.every(isValidProfile) &&
    (v.activeProfileId === null || typeof v.activeProfileId === 'string')
  );
}

export interface ProfilesInitialState {
  profiles: Profile[];
  activeProfileId: string | null;
  // Guest's own remembered table color override - null only when guest has never picked one.
  guestColor: string | null;
}

async function loadProfilesAndActiveId(): Promise<{ profiles: Profile[]; activeProfileId: string | null }> {
  let local = DEFAULT_LOCAL_STATE;
  try {
    const raw = await AsyncStorage.getItem(LOCAL_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (isValidLocalState(parsed)) local = parsed;
    }
  } catch {
    // corrupt/unavailable - DEFAULT_LOCAL_STATE is a complete fallback
  }

  if (!isSharedProfileStoreAvailable) {
    return { profiles: local.localBase, activeProfileId: local.activeProfileId };
  }

  try {
    const shared = await loadSharedProfiles(SHARED_GROUP_ID);
    // First time this build has ever touched the shared store: seed it from what was already
    // saved locally so an upgrading user's own profile doesn't just vanish.
    if (shared.length === 0 && local.localBase.length > 0) {
      saveSharedProfiles(SHARED_GROUP_ID, local.localBase).catch(() => {});
      return { profiles: local.localBase, activeProfileId: local.activeProfileId };
    }
    return { profiles: shared, activeProfileId: local.activeProfileId };
  } catch {
    return { profiles: local.localBase, activeProfileId: local.activeProfileId };
  }
}

/** Pre-mount loader for _layout.tsx's splash-gate - resolves before ProfilesProvider's first
 * mount, mirroring loadThemeSettings()'s role for ThemeProvider's own `initialValue`. */
export async function loadInitialProfilesState(): Promise<ProfilesInitialState> {
  const [base, guestColor] = await Promise.all([loadProfilesAndActiveId(), AsyncStorage.getItem(GUEST_COLOR_KEY).catch(() => null)]);
  return { ...base, guestColor };
}

export interface ProfileEditPatch {
  name: string;
  color: string;
  tag: string;
}

interface ProfilesContextValue {
  profiles: Profile[];
  activeProfileId: string | null;
  activeProfile: Profile | null;
  createProfile: (input: ProfileEditPatch) => Profile;
  updateProfile: (id: string, patch: Partial<ProfileEditPatch>) => void;
  deleteProfile: (id: string) => void;
  selectProfile: (profileId: string | null) => void;
  /** Independent, session-scoped table color - null only when no profile is active AND guest has
   * never picked one (theme.ts's useTableColors() then falls back to DEFAULT_SEED_COLOR, not an
   * untinted palette - every render is tinted by *some* seed). Resets to the newly-active
   * selection's own color on every real profile switch; a profile's own override is otherwise
   * never persisted, matching every other @tastic loadout screen's identical rule. Only guest's
   * picks are remembered, since guest has no profile record of its own to reset back to. */
  tableColorOverride: string | null;
  setTableColorOverride: (hex: string) => void;
}

const ProfilesContext = createContext<ProfilesContextValue | null>(null);

export function ProfilesProvider({ initialState, children }: { initialState: ProfilesInitialState; children: ReactNode }) {
  const [profiles, setProfiles] = useState<Profile[]>(() => initialState.profiles);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(() => initialState.activeProfileId);
  const profilesRef = useRef(profiles);
  useEffect(() => {
    profilesRef.current = profiles;
  }, [profiles]);

  const [guestColor, setGuestColor] = useState<string | null>(() => initialState.guestColor);
  const guestColorRef = useRef(guestColor);
  useEffect(() => {
    guestColorRef.current = guestColor;
  }, [guestColor]);

  const [tableColorOverride, setTableColorOverrideState] = useState<string | null>(() => {
    const initialProfile = initialState.activeProfileId ? (initialState.profiles.find((p) => p.id === initialState.activeProfileId) ?? null) : null;
    return initialProfile ? initialProfile.color : initialState.guestColor;
  });

  const activeProfileIdRef = useRef(activeProfileId);
  useEffect(() => {
    activeProfileIdRef.current = activeProfileId;
  }, [activeProfileId]);

  // Shared by persistActiveProfileId (explicit selection) and the AppState resync effect below (a
  // profile disappearing out from under an already-active selection) - both are "the active
  // selection changed to `id`" from the override's own point of view.
  const resetTableColorOverrideFor = useCallback((id: string | null) => {
    const nextProfile = id ? (profilesRef.current.find((p) => p.id === id) ?? null) : null;
    setTableColorOverrideState(nextProfile ? nextProfile.color : guestColorRef.current);
  }, []);

  const persistProfiles = useCallback(
    (next: Profile[]) => {
      setProfiles(next);
      if (isSharedProfileStoreAvailable) {
        saveSharedProfiles(SHARED_GROUP_ID, next).catch(() => {});
      } else {
        AsyncStorage.setItem(LOCAL_KEY, JSON.stringify({ localBase: next, activeProfileId })).catch(() => {});
      }
    },
    [activeProfileId]
  );

  const persistActiveProfileId = useCallback(
    (id: string | null) => {
      if (id !== activeProfileIdRef.current) resetTableColorOverrideFor(id);
      setActiveProfileId(id);
      AsyncStorage.setItem(LOCAL_KEY, JSON.stringify({ localBase: profilesRef.current, activeProfileId: id })).catch(() => {});
    },
    [resetTableColorOverrideFor]
  );

  const setTableColorOverride = useCallback((hex: string) => {
    setTableColorOverrideState(hex);
    // Only guest has nothing of its own to reset back to - a profile's own recolor here is
    // deliberately ephemeral (see resetTableColorOverrideFor), only guest's picks are worth
    // remembering.
    if (activeProfileIdRef.current === null) {
      setGuestColor(hex);
      AsyncStorage.setItem(GUEST_COLOR_KEY, hex).catch(() => {});
    }
  }, []);

  // The shared store is a plain UserDefaults read/write with no cross-process push, so re-sync on
  // foreground. Clears activeProfileId if the profile it pointed at was deleted elsewhere, rather
  // than holding a dangling id.
  useEffect(() => {
    if (!isSharedProfileStoreAvailable) return;
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      loadSharedProfiles(SHARED_GROUP_ID).then((shared) => {
        setProfiles(shared);
        const current = activeProfileIdRef.current;
        const cleared = current && !shared.some((p) => p.id === current) ? null : current;
        if (cleared !== current) {
          resetTableColorOverrideFor(cleared);
          setActiveProfileId(cleared);
        }
      });
    });
    return () => sub.remove();
  }, [resetTableColorOverrideFor]);

  const createProfile = useCallback(
    (input: ProfileEditPatch) => {
      const now = Date.now();
      const profile: Profile = {
        id: `profile-${now}-${Math.random().toString(36).slice(2, 8)}`,
        ...input,
        createdAt: now,
        updatedAt: now,
      };
      persistProfiles([...profilesRef.current, profile]);
      return profile;
    },
    [persistProfiles]
  );

  const updateProfile = useCallback(
    (id: string, patch: Partial<ProfileEditPatch>) => {
      persistProfiles(profilesRef.current.map((p) => (p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p)));
    },
    [persistProfiles]
  );

  const deleteProfile = useCallback(
    (id: string) => {
      persistProfiles(profilesRef.current.filter((p) => p.id !== id));
      if (activeProfileId === id) persistActiveProfileId(null);
    },
    [persistProfiles, persistActiveProfileId, activeProfileId]
  );

  const activeProfile = profiles.find((p) => p.id === activeProfileId) ?? null;

  return (
    <ProfilesContext.Provider
      value={{
        profiles,
        activeProfileId,
        activeProfile,
        createProfile,
        updateProfile,
        deleteProfile,
        selectProfile: persistActiveProfileId,
        tableColorOverride,
        setTableColorOverride,
      }}
    >
      {children}
    </ProfilesContext.Provider>
  );
}

export function useProfiles(): ProfilesContextValue {
  const ctx = useContext(ProfilesContext);
  if (!ctx) throw new Error('useProfiles must be used within a ProfilesProvider');
  return ctx;
}
