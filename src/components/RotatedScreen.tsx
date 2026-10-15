import { RotatedFrame, type RotatedFrameProps } from '@tastic/hud'

/** A routed screen (Home, Achievements, Profiles) that rotates with the phone: @tastic/hud's RotatedFrame with its own
 * Portal.Host. Game screens get the same turned frame from withGameProviders. The status bar hides while the frame is
 * turned from the root Stack's screen options (_layout.tsx's ThemedStack), so every screen gets that without a part here. */
export function RotatedScreen({ children, rotatedSafeArea, maxContentWidth }: Pick<RotatedFrameProps, 'children' | 'rotatedSafeArea' | 'maxContentWidth'>) {
  return (
    <RotatedFrame portalHost rotatedSafeArea={rotatedSafeArea} maxContentWidth={maxContentWidth}>
      {children}
    </RotatedFrame>
  )
}
