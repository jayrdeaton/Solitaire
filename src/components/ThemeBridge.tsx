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
  // theme's solid surface instead, and hud's Settings hides the Blur row.
  return (
    <AutoPaperProvider {...bridgeProps} expoBlur={ExpoBlur} fontFamily={CARD_FONT_FAMILY}>
      {children}
    </AutoPaperProvider>
  )
}
