import { View } from 'react-native'

export interface ScreenPoint {
  x: number
  y: number
}

/** Promise-wraps RN's async measureInWindow, the same shape as CardRegistry's own measurement -
 * used here for the one-off stock-pile/triangle-container origin points a deal needs, which
 * (unlike per-card registry entries) never need id-based lookup. */
export function measureView(view: View | null): Promise<ScreenPoint | null> {
  return new Promise((resolve) => {
    if (!view) {
      resolve(null)
      return
    }
    view.measureInWindow((x, y, width, height) => {
      resolve(width === 0 && height === 0 ? null : { x, y })
    })
  })
}
