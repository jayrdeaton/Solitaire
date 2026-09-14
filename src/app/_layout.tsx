import { Provider as ThemeProvider, type ThemeSettings, useAutoPaperTheme, useThemeSettings } from '@rific/auto-paper'
import { FeedbackPressProvider, hapticActions, type HapticSettings, soundActions, type SoundSettings } from '@rific/feedback-press'
import { Toaster, ToastProvider } from '@rific/toaster'
import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { StyleSheet } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import * as RNPaper from 'react-native-paper'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { Provider as ReduxProvider, useDispatch, useSelector } from 'react-redux'
import { PersistGate } from 'redux-persist/integration/react'

import { DEFAULT_SEED_COLOR, previewCardBack, useTableColors } from '@/components/theme'
import { UpdateDialog } from '@/components/UpdateDialog'
import { useCardSoundPlayers } from '@/components/useCardSounds'
import { CARD_FONT_FAMILY, useFontsPreload } from '@/components/useFontsPreload'
import { persistor, type RootState, store } from '@/redux/store'
import { GameStatsProvider } from '@/stores/gameStats'
import { LastActiveGameProvider, loadLastActiveGame } from '@/stores/lastActiveGame'
import { loadInitialProfilesState, ProfilesInitialState, ProfilesProvider, useProfiles } from '@/stores/profiles'
import { DEFAULT_SETTINGS, loadSettings, Settings, SettingsProvider } from '@/stores/settings'
import { SolitaireGameId } from '@/stores/statsTypes'
import { loadThemeSettings, saveThemeSettings } from '@/stores/themeSettings'
import { useSplashReady } from '@/utils/splashGate'

SplashScreen.preventAutoHideAsync()

function ThemedStack() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name='index' options={{ title: 'Solitaire Suite' }} />
      <Stack.Screen name='klondike' options={{ title: 'Klondike' }} />
      <Stack.Screen name='spider' options={{ title: 'Spider' }} />
      <Stack.Screen name='freecell' options={{ title: 'FreeCell' }} />
      <Stack.Screen name='pyramid' options={{ title: 'Pyramid' }} />
      <Stack.Screen name='yukon' options={{ title: 'Yukon' }} />
      <Stack.Screen name='golf' options={{ title: 'Golf' }} />
      <Stack.Screen name='tripeaks' options={{ title: 'TriPeaks' }} />
      <Stack.Screen name='canfield' options={{ title: 'Canfield' }} />
      <Stack.Screen name='fortythieves' options={{ title: 'Forty Thieves' }} />
      <Stack.Screen name='scorpion' options={{ title: 'Scorpion' }} />
      <Stack.Screen name='acesup' options={{ title: 'Aces Up' }} />
      <Stack.Screen name='achievements' options={{ title: 'Achievements' }} />
      <Stack.Screen name='profiles' options={{ title: 'Profiles' }} />
    </Stack>
  )
}

function ThemedToaster() {
  const colors = useTableColors()
  // clearButton/historyButton default to a "clear"/"history" chip stacked above the toasts - this
  // app never surfaces a reason to dig through past toasts or bulk-dismiss them, so both are turned
  // off outright (passing null, not omitting the prop, is what actually suppresses the default -
  // see @rific/toaster's Toaster: `resolvedXButton = xButton === void 0 ? defaultXButton : xButton`).
  // limit is already 3 by default; passed explicitly so it doesn't silently drift with a future
  // library bump.
  return <Toaster backgroundColor={colors.tableFeltDark} textColor='#fff' clearButton={null} historyButton={null} limit={3} />
}

/** Keeps auto-paper's own theme (colors.primary/secondary/tertiary, used by every Paper-flavored
 * dialog/button app-wide - see GameChrome's ConfirmDialog) seeded from the active profile/guest's
 * color, instead of the two silently drifting apart. Without this, auto-paper's seed is whatever
 * loadThemeSettings() last persisted (or the DEFAULT_SEED_COLOR fallback above, on a first launch)
 * and never changes again, regardless of which profile is active or what color they've picked -
 * confirmed live: the card back/felt track the active profile correctly, but every Paper dialog
 * stayed on one fixed color forever.
 *
 * Seeds with previewCardBack's own blended result, not the raw tableColorOverride hex - a
 * profile's color is a vivid, fully-saturated swatch (see profiles.tsx's own color picker), and
 * feeding that straight into auto-paper computes an equally vivid MD3 palette, confirmed live:
 * technically tracking the profile, but reading as neon against this app's own consistently muted
 * felt/card palette (theme.ts's own PROFILE_TINT_ALPHA blend exists for exactly this - "low enough
 * to read as muted, not as the profile's own vivid swatch"). previewCardBack already blends toward
 * the same muted base cardBack every card-table render tints toward, so re-running it here (rather
 * than invent a second, differently-muted formula) keeps the chrome and the table reading as one
 * palette instead of two similarly-muted-but-not-quite-matching ones.
 *
 * Renders nothing itself; must sit inside ProfilesProvider, ThemeProvider, AND (for the `dark`
 * read below) ThemeProvider's own PaperProvider (it does, below - all three wrap it) to read all
 * three. Mirrors useTableColors()'s own DEFAULT_SEED_COLOR fallback exactly, so a guest with no
 * override picked yet still gets the identical seed on both sides instead of diverging there too. */
function ProfileThemeSync() {
  const { tableColorOverride } = useProfiles()
  const { dark } = useAutoPaperTheme()
  const { set } = useThemeSettings()
  useEffect(() => {
    set({ color: previewCardBack(tableColorOverride ?? DEFAULT_SEED_COLOR, dark) })
  }, [tableColorOverride, dark, set])
  return null
}

type FeedbackBridgeProps = {
  children: ReactNode
  playCardSound: () => void
  playInvalidSound: () => void
}

// Redux-backed haptic/sound settings, dispatching through @rific/feedback-press's own
// hapticActions/soundActions — converged onto the same shape as Expo-Starter/Snake/BoxHockey's
// FeedbackBridge, replacing this app's old direct-AsyncStorage loadVibrateEnabled/
// loadSoundFxEnabled version (stores/feedbackSettings.ts).
function FeedbackBridge({ children, playCardSound, playInvalidSound }: FeedbackBridgeProps) {
  const haptic = useSelector((state: RootState) => state.haptic)
  const sound = useSelector((state: RootState) => state.sound)
  const dispatch = useDispatch()
  const onChange = useCallback((next: HapticSettings) => dispatch(hapticActions.initialize(next)), [dispatch])
  const onSoundChange = useCallback((next: SoundSettings) => dispatch(soundActions.initialize(next)), [dispatch])

  // PersistGate (an ancestor, see RootLayout below) already blocks rendering until redux-persist
  // has rehydrated, so by the time this mounts haptic/sound are already the real persisted values
  // — these gates are always ready the instant FeedbackBridge exists, unlike the old version's
  // async AsyncStorage load.
  useSplashReady('haptics', true)
  useSplashReady('sound', true)

  return (
    <FeedbackPressProvider initialValue={haptic} onChange={onChange} soundInitialValue={sound} onSoundChange={onSoundChange} paper={RNPaper} sound={{ selection: playCardSound, notification: playInvalidSound }}>
      {children}
    </FeedbackPressProvider>
  )
}

export default function RootLayout() {
  const [themeInitialValue, setThemeInitialValue] = useState<Partial<ThemeSettings> | undefined>(undefined)
  const [themeLoaded, setThemeLoaded] = useState(false)
  const [appSettings, setAppSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [appSettingsLoaded, setAppSettingsLoaded] = useState(false)
  const [profilesInitial, setProfilesInitial] = useState<ProfilesInitialState | undefined>(undefined)
  const [profilesLoaded, setProfilesLoaded] = useState(false)
  const [lastActiveGame, setLastActiveGame] = useState<SolitaireGameId | null>(null)
  const [lastActiveGameLoaded, setLastActiveGameLoaded] = useState(false)
  // Registers the 'fonts' gate itself (see useFontsPreload's own doc) - unlike the other five gates
  // above, font loading is driven by expo-font's own useFonts hook rather than an AsyncStorage read,
  // so there's no separate useEffect/setState pair for it here.
  const fontsLoaded = useFontsPreload()
  const { playCardSound, playInvalidSound } = useCardSoundPlayers()

  useEffect(() => {
    loadThemeSettings().then((stored) => {
      // Only matters for the single initial paint on a genuinely first launch (stored is null
      // pre-first-launch) - ProfileThemeSync (below) overwrites this with the active
      // profile/guest's own (muted) color the instant it mounts, in that same initial commit.
      // Matching its own DEFAULT_SEED_COLOR fallback here rather than auto-paper's stock purple
      // avoids a real, if imperceptibly brief, flash between the two.
      setThemeInitialValue(stored ?? { color: DEFAULT_SEED_COLOR })
      setThemeLoaded(true)
    })
    loadSettings().then((s) => {
      setAppSettings(s)
      setAppSettingsLoaded(true)
    })
    loadInitialProfilesState().then((s) => {
      setProfilesInitial(s)
      setProfilesLoaded(true)
    })
    loadLastActiveGame().then((g) => {
      setLastActiveGame(g)
      setLastActiveGameLoaded(true)
    })
  }, [])

  useSplashReady('theme', themeLoaded)
  useSplashReady('appSettings', appSettingsLoaded)
  useSplashReady('profiles', profilesLoaded)
  useSplashReady('lastActiveGame', lastActiveGameLoaded)
  // 'fonts' is registered inside useFontsPreload itself, not here - see its own doc comment.
  // 'haptics'/'sound' are registered inside FeedbackBridge (below) instead, once redux-persist has
  // rehydrated - see its own comment.

  if (!themeLoaded || !appSettingsLoaded || !profilesLoaded || !lastActiveGameLoaded || !fontsLoaded) return null

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <ProfilesProvider initialState={profilesInitial!}>
          <GameStatsProvider>
            <LastActiveGameProvider initialValue={lastActiveGame}>
              <SettingsProvider initialValue={appSettings}>
                <ThemeProvider initialValue={themeInitialValue} onChange={saveThemeSettings} fontFamily={CARD_FONT_FAMILY}>
                  <ReduxProvider store={store}>
                    <PersistGate persistor={persistor}>
                      <FeedbackBridge playCardSound={playCardSound} playInvalidSound={playInvalidSound}>
                        <ToastProvider>
                          <ProfileThemeSync />
                          <ThemedStack />
                          <ThemedToaster />
                          <UpdateDialog />
                        </ToastProvider>
                      </FeedbackBridge>
                    </PersistGate>
                  </ReduxProvider>
                </ThemeProvider>
              </SettingsProvider>
            </LastActiveGameProvider>
          </GameStatsProvider>
        </ProfilesProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1
  }
})
