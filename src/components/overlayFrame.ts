import { useRotatedWindowDimensions, useRotation } from '@tastic/core'
import { RefObject, useEffect, useMemo, useRef } from 'react'
import { View } from 'react-native'
import { useSharedValue } from 'react-native-reanimated'

import type { OverlayFrame } from './overlayFrameMath'

export { localOffsetToScreenPoint, type OverlayFrame, screenToLocalPoint, toLocal, wasteFanScreenShift } from './overlayFrameMath'

/** Attach `overlayRef` to the overlay's own absolutely-filled View; it measures itself whenever the
 * rotation or window size changes (and once on mount), keeping `frame` current for toLocal. The
 * measurement is async, so `frame` is briefly stale right after a rotation - same window the old
 * per-overlay containerOffset measurement it replaces already had. */
export function useOverlayFrame(): { overlayRef: RefObject<View | null>; frame: OverlayFrame } {
  const overlayRef = useRef<View>(null)
  const rotationValue = useSharedValue(0)
  const cx = useSharedValue(0)
  const cy = useSharedValue(0)
  const lw = useSharedValue(0)
  const lh = useSharedValue(0)
  const rotation = useRotation()
  const { width: winWidth, height: winHeight } = useRotatedWindowDimensions()

  useEffect(() => {
    overlayRef.current?.measureInWindow((x, y, w, h) => {
      const swapped = rotation === 90 || rotation === -90
      rotationValue.value = rotation
      cx.value = x + w / 2
      cy.value = y + h / 2
      lw.value = swapped ? h : w
      lh.value = swapped ? w : h
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rotation, winWidth, winHeight])

  const frame = useMemo(() => ({ rotation: rotationValue, cx, cy, lw, lh }), [rotationValue, cx, cy, lw, lh])
  return { overlayRef, frame }
}
