import { RotationAwareStatusBar } from '@tastic/core'
import { RotatedFrame, type RotatedFrameProps } from '@tastic/hud'
import { useIsFocused } from 'expo-router'

/** The status bar for a routed screen that rotates: always light and hidden while the frame is turned, the same
 * bar withGameProviders gives the games (see its doc), mounted here rather than in the root layout because the root
 * overlays (toaster, update dialog) turn with the phone too but never own the bar. Mounted only while that screen is
 * focused: a screen stays mounted beneath whatever is pushed over it, and expo-status-bar keeps a mount-order stack of
 * props (latest mounted wins), so a covered screen's hidden bar would stay hidden over a screen that has its own say.
 * Its own leaf, so a focus flip re-renders just this. */
function FocusedStatusBar() {
  return useIsFocused() ? <RotationAwareStatusBar style='light' /> : null
}

/** A routed screen (Home, Achievements, Profiles) that rotates with the phone: the focus-gated status bar plus
 * @tastic/hud's RotatedFrame with its own Portal.Host. Game screens get the same turned frame from withGameProviders. */
export function RotatedScreen({ children, rotatedSafeArea, maxContentWidth }: Pick<RotatedFrameProps, 'children' | 'rotatedSafeArea' | 'maxContentWidth'>) {
  return (
    <>
      <FocusedStatusBar />
      <RotatedFrame portalHost rotatedSafeArea={rotatedSafeArea} maxContentWidth={maxContentWidth}>
        {children}
      </RotatedFrame>
    </>
  )
}
