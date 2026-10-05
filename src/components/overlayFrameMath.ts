import type { SharedValue } from 'react-native-reanimated'

/** Everything a ghost overlay needs to turn a screen-space rect (what measureInWindow / Reanimated's
 * measure() / e.absoluteX report) into a position inside its own overlay View - see toLocal below.
 * All SharedValues so a ghost's useAnimatedStyle worklet reads them live, with no React re-render
 * needed when a measurement lands or the phone rotates. */
export interface OverlayFrame {
  /** Degrees the overlay is rotated on screen relative to the (portrait-locked) window: 0, 90, -90 or 180. */
  rotation: SharedValue<number>
  /** Overlay's centre in window/screen coordinates. */
  cx: SharedValue<number>
  cy: SharedValue<number>
  /** Overlay's own unrotated (local) width/height - swapped relative to its screen bbox at +/-90deg. */
  lw: SharedValue<number>
  lh: SharedValue<number>
}

/** Converts the screen-space top-left of a card-sized rect into that card's top-left in the
 * overlay's own coordinate space, for a card whose unrotated size is `cw` x `ch`.
 *
 * Every measurement in this app (measureInWindow, Reanimated's measure(), the pointer's
 * absoluteX/Y) is in true screen space, and for a rotated view iOS reports its transformed
 * bounding box - the top-left of the rotated footprint, not of the card's own unrotated box. A ghost
 * overlay living inside RotatedGameView is positioned in the ROTATED local frame instead, so
 * `screen - overlayOffset` (correct only at rotation 0) sends a ghost to the wrong place - and, for
 * a drag, moves it along the wrong axis - at any other angle. Going through the card's centre
 * (which a rotation leaves fixed relative to the container's centre) and rotating by -angle gets
 * both right; it reduces to `screen - overlayTopLeft` exactly at 0deg.
 *
 * Assumes the measured rect is the card's own footprint (or at least the same size and rotation
 * pivot) - true for every card, slot and pile this app flies a ghost between. */
export function toLocal(sx: number, sy: number, cw: number, ch: number, frame: OverlayFrame): { x: number; y: number } {
  'worklet'
  const rot = frame.rotation.value
  const swapped = rot === 90 || rot === -90
  const bw = swapped ? ch : cw
  const bh = swapped ? cw : ch
  const dx = sx + bw / 2 - frame.cx.value
  const dy = sy + bh / 2 - frame.cy.value
  // Rotate by -rot (clockwise-positive angles, y down). Only ever a multiple of 90, so use exact
  // cos/sin instead of trig to keep the 0deg case bit-identical to a plain subtraction.
  const cos = rot === 0 ? 1 : rot === 180 ? -1 : 0
  const sin = rot === 90 ? -1 : rot === -90 ? 1 : 0
  const lx = dx * cos - dy * sin
  const ly = dx * sin + dy * cos
  return { x: frame.lw.value / 2 + lx - cw / 2, y: frame.lh.value / 2 + ly - ch / 2 }
}

/** Pure-JS mirror of toLocal for a caller that has no overlay to measure (see WinCascadeProvider):
 * assumes the rotated container is centred in a window of `winWidth` x `winHeight`, which is exactly
 * how RotatedGameView lays it out. */
export function screenToLocalPoint(sx: number, sy: number, cw: number, ch: number, rotation: number, winWidth: number, winHeight: number): { x: number; y: number } {
  const swapped = rotation === 90 || rotation === -90
  const frame = { rotation: { value: rotation }, cx: { value: winWidth / 2 }, cy: { value: winHeight / 2 }, lw: { value: swapped ? winHeight : winWidth }, lh: { value: swapped ? winWidth : winHeight } } as unknown as OverlayFrame
  return toLocal(sx, sy, cw, ch, frame)
}

/** The screen-space bounding-box top-left of a card that sits at (`offsetLeft`, `offsetTop`) inside a
 * container, given only that container's own MEASURED screen bounding-box top-left (measureView /
 * measureInWindow) and how far the container is rotated.
 *
 * Pyramid and TriPeaks position cards analytically - a measured container origin plus a local
 * `cardPosition()` offset - and hand the sum to a ghost as a screen point. That sum is only right at
 * 0deg: a rotated container reports the top-left of its rotated footprint, not of its own
 * (unrotated) top-left, and the local offset points along the container's rotated axes, not the
 * screen's. This goes through the container's centre (invariant under the rotation) instead:
 * container centre from the bbox, the card's centre relative to the container's centre in LOCAL
 * axes, rotated by +rotation into screen axes, then back to the card's own bbox top-left. Exactly
 * `containerTopLeft + offset` at 0deg. Inverse direction of screenToLocalPoint/toLocal. */
export function localOffsetToScreenPoint(containerTopLeft: { x: number; y: number }, containerWidth: number, containerHeight: number, offsetLeft: number, offsetTop: number, cardWidth: number, cardHeight: number, rotation: number): { x: number; y: number } {
  const swapped = rotation === 90 || rotation === -90
  const containerBBoxW = swapped ? containerHeight : containerWidth
  const containerBBoxH = swapped ? containerWidth : containerHeight
  const containerCx = containerTopLeft.x + containerBBoxW / 2
  const containerCy = containerTopLeft.y + containerBBoxH / 2
  const relX = offsetLeft + cardWidth / 2 - containerWidth / 2
  const relY = offsetTop + cardHeight / 2 - containerHeight / 2
  const cos = rotation === 0 ? 1 : rotation === 180 ? -1 : 0
  const sin = rotation === 90 ? 1 : rotation === -90 ? -1 : 0
  const cardCx = containerCx + relX * cos - relY * sin
  const cardCy = containerCy + relX * sin + relY * cos
  const bboxW = swapped ? cardHeight : cardWidth
  const bboxH = swapped ? cardWidth : cardHeight
  return { x: cardCx - bboxW / 2, y: cardCy - bboxH / 2 }
}

/** localOffsetToScreenPoint for a container known only by its MEASURED screen rect (DropZoneRegistry.measure, measureView
 * with a size): under a quarter turn that rect is the rotated footprint, so its width and height are the container's own
 * height and width. FreeCell's deal places each card `offsetTop` down its column this way - `rect.y + offsetTop` was only
 * right at 0deg, so in landscape every dealt card flew to the wrong spot and snapped into place when it landed. */
export function rectOffsetToScreenPoint(rect: { x: number; y: number; width: number; height: number }, offsetLeft: number, offsetTop: number, cardWidth: number, cardHeight: number, rotation: number): { x: number; y: number } {
  const swapped = rotation === 90 || rotation === -90
  return localOffsetToScreenPoint(rect, swapped ? rect.height : rect.width, swapped ? rect.width : rect.height, offsetLeft, offsetTop, cardWidth, cardHeight, rotation)
}

/** Screen-space vector for a draw-3 waste fan card sitting `distance` points to the LEFT (local axes)
 * of the waste top card, under a fake landscape rotation of `rotation` degrees (0, 90, -90 or 180,
 * clockwise-positive, y down).
 *
 * Deal-style flights are positioned from MEASURED screen-space rects (measureInWindow), so a fan
 * card's destination/origin has to be the top card's rect shifted along the rotated axes. Subtracting
 * `distance` from `x` directly is only right at 0deg: at +90 the local left edge is the screen's TOP
 * (fan should run up), at -90 it is the screen's BOTTOM, at 180 it is the screen's RIGHT. Exactly
 * `{ x: -distance, y: 0 }` at 0deg. Found in the simulator: Klondike/Canfield draw-3 ghosts flew to the
 * wrong side of the waste and then jumped. */
export function wasteFanScreenShift(distance: number, rotation: number): { x: number; y: number } {
  const cos = rotation === 0 ? 1 : rotation === 180 ? -1 : 0
  const sin = rotation === 90 ? 1 : rotation === -90 ? -1 : 0
  // `+ 0` normalises -0 (e.g. -distance * 0) so callers/tests never see a negative zero.
  return { x: -distance * cos + 0, y: -distance * sin + 0 }
}
