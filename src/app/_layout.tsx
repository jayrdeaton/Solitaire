import { useAutoPaperTheme, useThemeSettings } from '@rific/auto-paper'
import { FeedbackPressProvider, hapticActions, type HapticSettings, soundActions, type SoundSettings } from '@rific/feedback-press'
import { Toaster, ToastProvider } from '@rific/toaster'
import { OrientationProvider, useThemedRootBackground } from '@tastic/core'
import { ProfileColorProvider } from '@tastic/profile'
import { DarkTheme, Stack, ThemeProvider as NavigationThemeProvider } from 'expo-router'
import { DeviceMotion } from 'expo-sensors'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { type ReactNode, useCallback, useEffect } from 'react'
import { Platform, StyleSheet, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import * as RNPaper from 'react-native-paper'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { Provider as ReduxProvider, useDispatch, useSelector } from 'react-redux'
import { PersistGate } from 'redux-persist/integration/react'

import { GuideHost } from '@/components/GuideHost'
import { RotatedFrame } from '@/components/RotatedScreen'
import { TableBackground } from '@/components/TableBackground'
import { previewCardBack, useTableColors } from '@/components/theme'
import { ThemeBridge } from '@/components/ThemeBridge'
import { UpdateDialog } from '@/components/UpdateDialog'
import { useCardSoundPlayers } from '@/components/useCardSounds'
import { useFontsPreload } from '@/components/useFontsPreload'
import { DEFAULT_SEED_COLOR } from '@/constants/theme'
import { useSettings } from '@/hooks/useSettings'
import { persistor, type RootState, store } from '@/redux/store'
import { GameStatsProvider } from '@/stores/gameStats'
import { LastActiveGameProvider } from '@/stores/lastActiveGame'
import { ProfilesProvider, useProfiles } from '@/stores/profiles'

SplashScreen.preventAutoHideAsync()

// React Navigation paints `colors.background` from its theme on the layers around every screen - on native
// the ScreenStack's own container, on web each screen's wrapper - and a screen's `contentStyle` only reaches
// the layer inside those. So the app-wide felt behind the Stack (see ThemedStack) is only visible if the
// theme's background is itself transparent. Nothing else in this app reads the navigation theme (headers
// are hidden; Paper has its own).
const TRANSPARENT_NAVIGATION_THEME = { ...DarkTheme, colors: { ...DarkTheme.colors, background: 'transparent' } }

function ThemedStack() {
  // Hardcoded `true`, not this app's own live system-theme `dark` (see useAutoPaperTheme()'s `dark`
  // used elsewhere in this file, e.g. ProfileThemeSync) - theme.ts's own felt palettes are dark-toned
  // in every appearance mode by design ("Both felt palettes below are dark-toned green in every
  // appearance mode"), so syncing the OS root-window background to a light-system-theme user's live
  // `dark` would flash white against this app's always-dark table during a push/pop transition, which
  // is worse than the black-default corner-flash this hook exists to fix. gestureEnabled left at the
  // hook's own default (false) - this Stack had no prior gestureEnabled setting to preserve.
  const rootBackground = useThemedRootBackground(true, false)
  // The hook's opaque black `contentStyle` is replaced with a transparent one: the felt (TableBackground,
  // below) is painted ONCE behind the whole Stack and every screen draws over it, instead of each screen
  // painting its own copy of the felt as its first child. The hook's root-window sync (the OS-level
  // corner-flash fix) is unaffected - that is a separate layer beneath even this.
  //
  // Android also gets a crossfade. Its default push/pop animation (react-native-screens' rns_default_* tweens)
  // holds the OUTGOING screen at full alpha for ~450ms while the incoming one slides over it, which only
  // looked right because every screen used to be opaque; with transparent screens Home would show straight
  // through the game board for the whole push. rns_fade_* is a 150ms symmetric alpha crossfade, so nothing
  // sits at full opacity under the incoming screen. iOS is left on its own UIKit push (checked frame by
  // frame in the simulator - no bleed-through). Derived from the installed react-native-screens sources; NOT
  // yet observed on an Android device or emulator.
  const screenOptions = { ...rootBackground, contentStyle: { backgroundColor: 'transparent' }, animation: Platform.select({ android: 'fade' as const }) }
  return (
    <View style={styles.root}>
      <TableBackground />
      {/* Explicitly light, not the default `auto`: every screen here sits on the dark-toned felt in
      every appearance mode (see theme.ts), so `auto` flips to dark status-bar text in a light-mode
      system and reads poorly against it. Mounted here, next to the Stack, rather than once at the
      very root - confirmed live on iOS that a root-level instance never took effect (the bar stayed
      dark on the menu) while this one does. Game screens, Home, Achievements and Profiles layer their own
      rotation-aware hide on top - see GameStatusBar and RotatedScreen. */}
      <StatusBar style='light' />
      <NavigationThemeProvider value={TRANSPARENT_NAVIGATION_THEME}>
        <Stack screenOptions={screenOptions}>
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
      </NavigationThemeProvider>
    </View>
  )
}

/** The toaster and the update dialog, laid OVER the whole app in a frame that turns with the phone - they used to
 * sit outside the rotation (toasts on the physical bottom edge, the "Update Available" card upright while
 * everything else was sideways). `passThrough` because this frame covers the Stack: only a toast card / the
 * dialog claims a touch. `rotatedSafeArea` so the toaster's own `useSafeAreaInsets()` bottom offset lands on the
 * frame's bottom edge; `portalHost` so the update dialog's Paper Portal lands inside the frame (its `rotation`
 * stays 0). The absoluteFill wrapper takes the frame out of the Stack's layout. The toaster renders inline in the
 * frame (ToastProvider is given no `paper`, so it does not portal); only the update dialog uses the frame's
 * Portal.Host. Two of the toaster's behaviours still assume an upright screen: its swipe-to-dismiss reads the
 * pan in window space (wrong axis when turned - toasts still auto-dismiss) until @rific/toaster learns a `rotation`
 * prop, and its keyboard-aware lift is switched off when turned (ThemedToaster). */
function RootOverlays() {
  return (
    <View style={styles.overlays} pointerEvents='box-none'>
      <RotatedFrame rotatedSafeArea portalHost passThrough>
        <ThemedToaster />
        <UpdateDialog />
      </RotatedFrame>
    </View>
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
 * the store's `theme` slice last persisted (or its DEFAULT_SEED_COLOR default, on a first launch)
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
 * Renders nothing itself; must sit inside ProfilesProvider and ThemeBridge (whose auto-paper Provider
 * also supplies the PaperProvider the `dark` read below needs) - it does, below. Mirrors useTableColors()'s own DEFAULT_SEED_COLOR fallback exactly, so a guest with no
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

/** Draws every profile color app-wide (each ProfileChip, the picker's selected row, the profile
 * editor's swatches, and @tastic/hud components that show a ProfileChip) through the same
 * previewCardBack blend the card backs and ProfileThemeSync use, so a profile never shows as its raw,
 * vivid swatch next to the muted table. Must sit inside ThemeBridge for the `dark` read. */
function MutedProfileColors({ children }: { children: ReactNode }) {
  const { dark } = useAutoPaperTheme()
  const preview = useCallback((hex: string) => previewCardBack(hex, dark), [dark])
  return <ProfileColorProvider preview={preview}>{children}</ProfileColorProvider>
}

/** Mounted once, wrapping every route via ThemedStack below AND the root overlays (toaster, update dialog) -
 * every screen's rotated frame (see RotatedScreen, and withGameProviders for the games) reads the live rotation
 * this provides via @tastic/core's useRotation()/RotatedGameView. Reads the persisted Lock Orientation setting
 * through useSettings() (the Redux `settings` slice), so it sits inside PersistGate: the saved lock is already
 * rehydrated when this first renders. */
function OrientationBridge({ children }: { children: ReactNode }) {
  const { settings, setSettings } = useSettings()
  // `freezeWhileLocked`: Lock Orientation freezes the provider's ONE shared reading, so every consumer
  // (rotated frames, status bar, overlays, hud dialogs) holds together, including a screen that mounts
  // after the lock. The lock's angle round-trips through `lockedRotation`, so a relaunch reopens in
  // the orientation the player locked to instead of portrait.
  // `portraitWhileKeyboard`: the software keyboard can't turn with a faked rotation (it's always drawn in the
  // device's real, portrait interface orientation), so every rotated screen reads portrait for as long as it's
  // showing, and the real rotation again once it hides - see @tastic/core's own doc for the full reasoning.
  return (
    <OrientationProvider deviceMotion={DeviceMotion} freezeWhileLocked lockInitialValue={{ locked: settings.lockOrientation, rotation: settings.lockedRotation }} onLockChange={(next) => setSettings({ lockOrientation: next.locked, lockedRotation: next.rotation })} portraitWhileKeyboard>
      {children}
    </OrientationProvider>
  )
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

  return (
    <FeedbackPressProvider initialValue={haptic} onChange={onChange} soundInitialValue={sound} onSoundChange={onSoundChange} paper={RNPaper} sound={{ selection: playCardSound, notification: playInvalidSound }}>
      {children}
    </FeedbackPressProvider>
  )
}

export default function RootLayout() {
  // Registers the 'fonts' gate itself (see useFontsPreload's own doc): expo-font's own load is the one
  // thing left that has to finish before anything renders. Every other splash gate is marked from
  // inside PersistGate once its Redux state has rehydrated: 'theme' by ThemeBridge, 'profiles' by
  // ProfilesProvider.
  const fontsLoaded = useFontsPreload()
  const { playCardSound, playInvalidSound } = useCardSoundPlayers()

  if (!fontsLoaded) return null

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <ReduxProvider store={store}>
          <PersistGate persistor={persistor}>
            {/* Everything this app persists (settings, theme, profiles, stats, the last active game,
            saved boards) lives in the Redux store, so every provider that reads it sits inside
            PersistGate and sees rehydrated values from its first render. ThemeBridge comes first because
            everything below reads the theme; GameStatsProvider stays inside ProfilesProvider because
            it calls useProfiles() (for activeProfileId). */}
            <ThemeBridge>
              <LastActiveGameProvider>
                <ProfilesProvider>
                  <MutedProfileColors>
                    <GameStatsProvider>
                      <FeedbackBridge playCardSound={playCardSound} playInvalidSound={playInvalidSound}>
                        <ToastProvider>
                          <ProfileThemeSync />
                          <OrientationBridge>
                            {/* Wraps the stack (rather than sitting beside it like RootOverlays) because
                            Home's useAutoShowGuide() and its Settings "How to Play" row reach it through
                            context (see GuideHost's own doc). Must stay inside PersistGate (the seen
                            version is read already rehydrated), FeedbackBridge (the card portals into
                            FeedbackPressProvider's Portal.Host) and OrientationBridge (it reads the
                            live tilt). */}
                            <GuideHost>
                              <ThemedStack />
                            </GuideHost>
                            <RootOverlays />
                          </OrientationBridge>
                        </ToastProvider>
                      </FeedbackBridge>
                    </GameStatsProvider>
                  </MutedProfileColors>
                </ProfilesProvider>
              </LastActiveGameProvider>
            </ThemeBridge>
          </PersistGate>
        </ReduxProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}

const styles = StyleSheet.create({
  overlays: {
    ...StyleSheet.absoluteFill
  },
  root: {
    flex: 1
  }
})
