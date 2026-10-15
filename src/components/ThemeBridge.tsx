import MaskedView from '@react-native-masked-view/masked-view'
import { Provider as AutoPaperProvider, themeActions, type ThemeSettings, useThemeBridgeProps } from '@rific/auto-paper'
import * as ExpoBlur from 'expo-blur'
import { ReactNode, useCallback } from 'react'
import { shallowEqual, useDispatch, useSelector } from 'react-redux'

import { CARD_FONT_FAMILY } from '@/components/useFontsPreload'
import { type RootState } from '@/redux/store'
import { markSplashReady } from '@/utils/splashGate'

// auto-paper's Provider, bridged to the store's `theme` slice the same way the fleet's other games do
// it: settings come from Redux (already rehydrated under PersistGate), every change auto-paper makes
// (ProfileThemeSync's color, the appearance toggle) is dispatched back, and the 'theme' splash gate
// opens once auto-paper reports it has painted. Must sit inside ReduxProvider/PersistGate and above
// everything that reads the theme.
export function ThemeBridge({ children }: { children: ReactNode }) {
  const settings = useSelector((state: RootState) => state.theme, shallowEqual)
  const dispatch = useDispatch()
  const onChange = useCallback((next: ThemeSettings) => dispatch(themeActions.initialize(next)), [dispatch])
  const onReady = useCallback(() => markSplashReady('theme'), [])
  const bridgeProps = useThemeBridgeProps({ initialValue: settings, onChange, onReady })
  // expoBlur is what lets auto-paper's BlurView actually blur (the settings sheet, Paper menus and
  // @tastic/hud's overlay cards) while the player's Blur setting is on. Without it they paint the
  // theme's solid surface instead, and hud's Settings hides the Blur row. maskedView is what lets
  // auto-paper's FadingScrollView fade the Settings and Rules rows out above their Done button on
  // iOS/Android (without it they just scroll; web needs nothing). statusBar={false}: the status bar is set
  // per screen (the root Stack's screen options, see _layout.tsx's ThemedStack), so auto-paper must not mount
  // React Native's StatusBar, which logs an error with view controller-based status bar appearance on.
  return (
    <AutoPaperProvider {...bridgeProps} expoBlur={ExpoBlur} fontFamily={CARD_FONT_FAMILY} maskedView={MaskedView} statusBar={false}>
      {children}
    </AutoPaperProvider>
  )
}
