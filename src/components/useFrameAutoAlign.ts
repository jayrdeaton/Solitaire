import { rotateInsets, useRotatedWindowDimensions, useRotation } from '@tastic/core'
import { type AlignResult, type PopoverAlign, type PopoverVerticalAlign } from '@tastic/hud'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useWindowDimensions, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { type LayoutInsets } from './gameLayout'
import { screenToLocalPoint } from './overlayFrameMath'

// Minimum breathing room between a popover's outer edge and the frame's usable edge - @tastic/hud's own
// EDGE_MARGIN, so a popover keeps the same margin it had before.
export const FRAME_ALIGN_EDGE_MARGIN = 12

export interface FrameRect {
  x: number
  y: number
  width: number
  height: number
}

/** A trigger's rect in the ROTATED FRAME's own coordinates, from what measureInWindow reported.
 *
 * Every measurement in this app is a rect in true screen space, and for a view inside a rotated frame it is
 * the transformed bounding box (see overlayFrameMath.ts) - `width`/`height` are therefore swapped at
 * +/-90deg. screenToLocalPoint undoes the rotation about the frame's centre, which RotatedGameView keeps at
 * the window's own centre (`windowWidth`/`windowHeight` are the RAW window here, not the rotated one). */
export function frameRectFromScreen(screenX: number, screenY: number, boxWidth: number, boxHeight: number, rotation: number, windowWidth: number, windowHeight: number): FrameRect {
  const swapped = rotation === 90 || rotation === -90
  const width = swapped ? boxHeight : boxWidth
  const height = swapped ? boxWidth : boxHeight
  const { x, y } = screenToLocalPoint(screenX, screenY, width, height, rotation, windowWidth, windowHeight)
  return { x, y, width, height }
}

export interface FramePlacement {
  align: PopoverAlign
  verticalAlign: PopoverVerticalAlign
  maxHeight: number
}

/** Where a `contentWidth` x `contentHeight` popover should open from `trigger`, all in the frame's own
 * coordinates - the same decision @tastic/hud's useAutoAlign makes (centred if it fits, else flush to
 * whichever edge has room; below unless there is genuinely more room above), but measured against the
 * frame and its safe-area insets instead of the raw portrait window, which is the wrong axes entirely once
 * the screen is fake-rotated (useAutoAlign compares a screen-space rect with the un-rotated window, and its
 * own rotation fix assumes a pre-transform rect, so it double-rotates a transformed one). Also keeps the
 * popover off a notch/island-side inset, which useAutoAlign never knew about. */
export function computeFramePlacement(trigger: FrameRect, contentWidth: number, contentHeight: number, frameWidth: number, frameHeight: number, insets: LayoutInsets): FramePlacement {
  const leftBound = insets.left + FRAME_ALIGN_EDGE_MARGIN
  const rightBound = frameWidth - insets.right - FRAME_ALIGN_EDGE_MARGIN
  const centerX = trigger.x + trigger.width / 2
  const overflowsRight = centerX + contentWidth / 2 > rightBound
  const overflowsLeft = centerX - contentWidth / 2 < leftBound
  // Both overflowing means the popover is wider than the frame has room for either way - centred is the
  // least-bad choice there (symmetric clipping beats asymmetric).
  const align: PopoverAlign = overflowsRight && !overflowsLeft ? 'right' : overflowsLeft && !overflowsRight ? 'left' : 'center'

  const roomBelow = frameHeight - insets.bottom - (trigger.y + trigger.height) - FRAME_ALIGN_EDGE_MARGIN
  const roomAbove = trigger.y - insets.top - FRAME_ALIGN_EDGE_MARGIN
  // Below is preferred - flips only when there is genuinely more room the other way.
  const above = contentHeight > roomBelow && roomAbove > roomBelow
  return { align, verticalAlign: above ? 'above' : 'below', maxHeight: Math.max(above ? roomAbove : roomBelow, 0) }
}

/** Drop-in for useAutoAlign, for a popover trigger inside a fake-rotated frame (Home). Same result shape,
 * so it goes straight into a hud component's `alignOverride`.
 *
 * Re-measures whenever `open` flips true, and again if the frame changes under an open popover (a rotation
 * or resize) - `measured` only resets on a genuine (re)open, via the render-phase edge check, so an
 * already-open popover never flickers hidden just because the window changed. */
export function useFrameAutoAlign(open: boolean, contentWidth: number, contentHeight: number): AlignResult {
  const triggerRef = useRef<View>(null)
  const rotation = useRotation()
  const { width: windowWidth, height: windowHeight } = useWindowDimensions()
  const { width: frameWidth, height: frameHeight } = useRotatedWindowDimensions()
  const rawInsets = useSafeAreaInsets()
  const { top, right, bottom, left } = rotateInsets(rawInsets, rotation)
  const [placement, setPlacement] = useState<FramePlacement>({ align: 'center', verticalAlign: 'below', maxHeight: contentHeight })
  // False from the instant `open` goes true until this open's own measurement lands (measureInWindow is a
  // native callback), so the caller can hold the popover hidden instead of painting it at a stale guess.
  const [measured, setMeasured] = useState(false)
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) setMeasured(false)
  }

  const measure = useCallback(() => {
    triggerRef.current?.measureInWindow((x, y, width, height) => {
      const trigger = frameRectFromScreen(x, y, width, height, rotation, windowWidth, windowHeight)
      setPlacement(computeFramePlacement(trigger, contentWidth, contentHeight, frameWidth, frameHeight, { top, right, bottom, left }))
      setMeasured(true)
    })
  }, [rotation, windowWidth, windowHeight, contentWidth, contentHeight, frameWidth, frameHeight, top, right, bottom, left])

  useEffect(() => {
    if (open) measure()
  }, [open, measure])

  return { ...placement, measured, triggerRef }
}
