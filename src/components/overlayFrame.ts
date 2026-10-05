import { useRotatedWindowDimensions, useRotation } from '@tastic/core'
import { RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { View } from 'react-native'
import { useSharedValue } from 'react-native-reanimated'

import type { OverlayFrame } from './overlayFrameMath'

export { localOffsetToScreenPoint, type OverlayFrame, rectOffsetToScreenPoint, screenToLocalPoint, toLocal, wasteFanScreenShift } from './overlayFrameMath'

/** Attach `overlayRef` to the overlay's own absolutely-filled View; it measures itself whenever the
 * rotation or window size changes (and once on mount), keeping `frame` current for toLocal. The
 * measurement is async, so `frame` is briefly stale right after a rotation - same window the old
 * per-overlay containerOffset measurement it replaces already had.
 *
 * `ready` is false until that first real measurement lands - `cx`/`cy`/`lw`/`lh` start at 0 (a
 * shared value needs SOME initial number), which toLocal would otherwise treat as a genuine
 * "overlay centred at the screen's top-left corner, zero-sized" frame. A caller whose own work
 * can't wait (a settled, non-animating layout) can ignore `ready` - a wrong `frame` for one frame
 * of a static layout is imperceptible. A caller that computes a SCREEN POSITION and holds onto it
 * (DealLayer's ghost flights: measured once, then flown to) cannot - confirmed live, on a fresh
 * game screen's very first deal specifically (see DealLayer.tsx's own use of `ready`): a card whose
 * flight was already scheduled against the zero'd frame rendered at a wrong, shared position (every
 * such card converges on the same wrong spot, since they all divide by the same zero), then jumped
 * to its real position the instant this hook's real measurement landed and every ghost still reading
 * `cx`/`cy` reactively recomputed - "flies to nowhere, then teleports," and only for the first few
 * cards of the deal, exactly what was reported and reproduced. */
export function useOverlayFrame(): { overlayRef: RefObject<View | null>; frame: OverlayFrame; ready: boolean } {
  const overlayRef = useRef<View>(null)
  const rotationValue = useSharedValue(0)
  const cx = useSharedValue(0)
  const cy = useSharedValue(0)
  const lw = useSharedValue(0)
  const lh = useSharedValue(0)
  const rotation = useRotation()
  const { width: winWidth, height: winHeight } = useRotatedWindowDimensions()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    overlayRef.current?.measureInWindow((x, y, w, h) => {
      const swapped = rotation === 90 || rotation === -90
      rotationValue.value = rotation
      cx.value = x + w / 2
      cy.value = y + h / 2
      lw.value = swapped ? h : w
      lh.value = swapped ? w : h
      setReady(true)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rotation, winWidth, winHeight])

  const frame = useMemo(() => ({ rotation: rotationValue, cx, cy, lw, lh }), [rotationValue, cx, cy, lw, lh])
  return { overlayRef, frame, ready }
}
