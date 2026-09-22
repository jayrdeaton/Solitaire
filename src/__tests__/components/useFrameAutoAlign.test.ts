import { localOffsetToScreenPoint } from '@/components/overlayFrameMath'
import { computeFramePlacement, FRAME_ALIGN_EDGE_MARGIN, frameRectFromScreen } from '@/components/useFrameAutoAlign'

// A 402x874 portrait window. RotatedGameView keeps the game frame centred in it and rotates it, so the frame's
// own (local) size is 402x874 at 0/180 and 874x402 at +/-90 - and its screen bounding box always fills the window.
const WIN_W = 402
const WIN_H = 874

const isSwapped = (rotation: number) => rotation === 90 || rotation === -90
const frameSize = (rotation: number) => (isSwapped(rotation) ? { width: WIN_H, height: WIN_W } : { width: WIN_W, height: WIN_H })

/** What measureInWindow would report for a `width` x `height` (local) trigger at frame-local (`x`, `y`): the
 * top-left AND the size of its transformed bounding box (size swapped at +/-90). Built on the existing forward
 * model. The frame's own screen bbox top-left is (0, 0) at every angle (it fills the window). */
function measuredBox(x: number, y: number, width: number, height: number, rotation: number) {
  const frame = frameSize(rotation)
  const topLeft = localOffsetToScreenPoint({ x: 0, y: 0 }, frame.width, frame.height, x, y, width, height, rotation)
  return { x: topLeft.x, y: topLeft.y, boxWidth: isSwapped(rotation) ? height : width, boxHeight: isSwapped(rotation) ? width : height }
}

describe('FRAME_ALIGN_EDGE_MARGIN', () => {
  it('is @tastic/hud EDGE_MARGIN (12), so a popover keeps the margin it always had', () => {
    expect(FRAME_ALIGN_EDGE_MARGIN).toBe(12)
  })
})

describe('frameRectFromScreen', () => {
  const POSITIONS: [number, number][] = [
    [0, 0],
    [100, 50],
    [413, 20],
    [700, 300]
  ]

  it.each([0, 90, -90, 180])('recovers a 48x48 trigger exactly from its screen bounding box at %i degrees', (rotation) => {
    for (const [x, y] of POSITIONS) {
      const box = measuredBox(x, y, 48, 48, rotation)
      const rect = frameRectFromScreen(box.x, box.y, box.boxWidth, box.boxHeight, rotation, WIN_W, WIN_H)
      expect(rect.x).toBeCloseTo(x, 6)
      expect(rect.y).toBeCloseTo(y, 6)
      expect(rect.width).toBe(48)
      expect(rect.height).toBe(48)
    }
  })

  it.each([0, 90, -90, 180])('un-swaps a non-square 60x36 trigger (reported swapped at +/-90) at %i degrees', (rotation) => {
    for (const [x, y] of POSITIONS) {
      const box = measuredBox(x, y, 60, 36, rotation)
      // Sanity: the screen bounding box really is swapped at +/-90, so the width/height swap is doing the work.
      expect(box.boxWidth).toBe(isSwapped(rotation) ? 36 : 60)
      expect(box.boxHeight).toBe(isSwapped(rotation) ? 60 : 36)
      const rect = frameRectFromScreen(box.x, box.y, box.boxWidth, box.boxHeight, rotation, WIN_W, WIN_H)
      expect(rect.x).toBeCloseTo(x, 6)
      expect(rect.y).toBeCloseTo(y, 6)
      expect(rect.width).toBe(60)
      expect(rect.height).toBe(36)
    }
  })

  // Hand-computed screen positions of a 48x48 trigger at frame-local (100, 50), independent of the forward
  // model above: +90 turns local +x into screen +y and local +y into screen -x (the frame's local top-left lands
  // at the screen's top-right); -90 is the mirror image; 180 flips both.
  it.each([
    [0, 100, 50],
    [90, 402 - 50 - 48, 100],
    [-90, 50, 874 - 100 - 48],
    [180, 402 - 100 - 48, 874 - 50 - 48]
  ])('maps the hand-computed screen top-left at %i degrees back to local (100, 50)', (rotation, screenX, screenY) => {
    const rect = frameRectFromScreen(screenX, screenY, 48, 48, rotation, WIN_W, WIN_H)
    expect(rect.x).toBeCloseTo(100, 6)
    expect(rect.y).toBeCloseTo(50, 6)
    expect(rect.width).toBe(48)
    expect(rect.height).toBe(48)
  })

  it('is a plain pass-through at 0 degrees', () => {
    expect(frameRectFromScreen(37, 412, 48, 30, 0, WIN_W, WIN_H)).toEqual({ x: 37, y: 412, width: 48, height: 30 })
  })
})

describe('computeFramePlacement', () => {
  // A phone held sideways: 874x402 frame, home-indicator/notch side insets like the simulator reported.
  const FRAME_W = 874
  const FRAME_H = 402
  const INSETS = { top: 0, right: 34, bottom: 0, left: 62 }
  const CONTENT_W = 183
  const CONTENT_H = 200
  const trigger = (x: number, y: number, width = 48, height = 48) => ({ x, y, width, height })
  const place = (t: ReturnType<typeof trigger>, contentW = CONTENT_W, contentH = CONTENT_H, insets = INSETS, frameW = FRAME_W, frameH = FRAME_H) => computeFramePlacement(t, contentW, contentH, frameW, frameH, insets)

  describe('horizontal alignment', () => {
    it('centres a popover on a trigger with room on both sides', () => {
      const result = place(trigger(400, 20))
      expect(result.align).toBe('center')
      expect(result.verticalAlign).toBe('below')
      // frameHeight - insets.bottom - (y + height) - margin
      expect(result.maxHeight).toBe(FRAME_H - INSETS.bottom - (20 + 48) - FRAME_ALIGN_EDGE_MARGIN)
      expect(result.maxHeight).toBe(322)
    })

    it("aligns 'left' when a centred popover would spill past the left bound", () => {
      // centre x = 104, so a 183-wide popover would start at 12.5 - left of the 62 + 12 = 74 bound.
      expect(place(trigger(80, 20)).align).toBe('left')
    })

    it("aligns 'right' when a centred popover would spill past the right bound", () => {
      // centre x = 804 -> right edge 895.5, past 874 - 34 - 12 = 828.
      expect(place(trigger(780, 20)).align).toBe('right')
    })

    it("falls back to 'center' when the popover is wider than the frame has room for on either side", () => {
      // Usable span is 74..828 (754pt); an 800pt popover on a mid-frame trigger overflows both edges.
      const result = place(trigger(413, 20), 800)
      expect(result.align).toBe('center')
    })

    it('a popover that exactly touches the right bound does not overflow (strict comparison)', () => {
      // 180-wide popover centred on x = 738 ends at exactly 828.
      expect(place(trigger(714, 20), 180).align).toBe('center')
      expect(place(trigger(715, 20), 180).align).toBe('right')
    })

    it('a popover that exactly touches the left bound does not overflow (strict comparison)', () => {
      // 180-wide popover centred on x = 164 starts at exactly 74.
      expect(place(trigger(140, 20), 180).align).toBe('center')
      expect(place(trigger(139, 20), 180).align).toBe('left')
    })

    it('honours the LEFT safe-area inset: a popover that fits the raw frame is still pushed off a notch-side inset', () => {
      // centre x = 110 -> starts at 18.5: inside the raw frame's 12pt margin, but inside the 62pt inset.
      const t = trigger(86, 20)
      expect(place(t, CONTENT_W, CONTENT_H, { top: 0, right: 0, bottom: 0, left: 0 }).align).toBe('center')
      expect(place(t).align).toBe('left')
    })

    it('honours the RIGHT safe-area inset: a popover that fits the raw frame is still pushed off a notch-side inset', () => {
      // centre x = 750 -> ends at 841.5: inside the raw frame's 862 bound, but past the 828 inset bound.
      const t = trigger(726, 20)
      expect(place(t, CONTENT_W, CONTENT_H, { top: 0, right: 0, bottom: 0, left: 0 }).align).toBe('center')
      expect(place(t).align).toBe('right')
    })

    it('works in the portrait frame too (a trigger in the top-right corner opens right-aligned)', () => {
      const result = place(trigger(402 - 16 - 48, 60), CONTENT_W, CONTENT_H, { top: 47, right: 0, bottom: 34, left: 0 }, 402, 874)
      expect(result.align).toBe('right')
      expect(result.verticalAlign).toBe('below')
    })
  })

  describe('vertical direction and maxHeight', () => {
    it('maxHeight below is the room between the trigger and the bottom inset, less the margin', () => {
      const insets = { top: 10, right: 34, bottom: 21, left: 62 }
      const result = place(trigger(400, 100), CONTENT_W, CONTENT_H, insets)
      expect(result.verticalAlign).toBe('below')
      expect(result.maxHeight).toBe(FRAME_H - insets.bottom - (100 + 48) - FRAME_ALIGN_EDGE_MARGIN)
    })

    it("flips 'above' for a low trigger with more room above and content taller than the room below", () => {
      // roomBelow = 402 - 378 - 12 = 12, roomAbove = 330 - 12 = 318.
      const result = place(trigger(400, 330))
      expect(result.verticalAlign).toBe('above')
      expect(result.maxHeight).toBe(318)
    })

    it('measures the room above from the top inset', () => {
      const insets = { top: 10, right: 34, bottom: 21, left: 62 }
      // roomBelow = 402 - 21 - 328 - 12 = 41, roomAbove = 280 - 10 - 12 = 258.
      const result = place(trigger(400, 280), CONTENT_W, 100, insets)
      expect(result.verticalAlign).toBe('above')
      expect(result.maxHeight).toBe(258)
    })

    it('never flips when the content fits below, even if there is more room above', () => {
      // roomBelow = 402 - 248 - 12 = 142 (fits a 100pt popover), roomAbove = 200 - 12 = 188.
      const result = place(trigger(400, 200), CONTENT_W, 100)
      expect(result.verticalAlign).toBe('below')
      expect(result.maxHeight).toBe(142)
    })

    it('stays below (capped to the room below) when the content is too tall but there is less room above', () => {
      // roomBelow = 402 - 148 - 12 = 242, roomAbove = 100 - 12 = 88.
      const result = place(trigger(400, 100), CONTENT_W, 300)
      expect(result.verticalAlign).toBe('below')
      expect(result.maxHeight).toBe(242)
    })

    it('stays below on an exact tie between the room above and below (flip needs strictly more room)', () => {
      // roomAbove = 177 - 12 = 165, roomBelow = 402 - 225 - 12 = 165.
      const result = place(trigger(400, 177), CONTENT_W, 300)
      expect(result.verticalAlign).toBe('below')
      expect(result.maxHeight).toBe(165)
    })

    it('never reports a negative maxHeight when the trigger overhangs the frame (flipped above)', () => {
      // roomBelow = 402 - 405 - 12 = -15, roomAbove = 5 - 12 = -7: above wins, clamped to 0.
      const result = place(trigger(400, 5, 48, 400))
      expect(result.verticalAlign).toBe('above')
      expect(result.maxHeight).toBe(0)
    })

    it('never reports a negative maxHeight when the trigger overhangs the frame (staying below)', () => {
      // roomBelow = 402 - 400 - 12 = -10, roomAbove = 0 - 12 = -12: below wins, clamped to 0.
      const result = place(trigger(400, 0, 48, 400))
      expect(result.verticalAlign).toBe('below')
      expect(result.maxHeight).toBe(0)
    })
  })

  describe('with frameRectFromScreen (the useFrameAutoAlign pipeline)', () => {
    it.each([0, 90, -90, 180])('a trigger reported in screen space at %i degrees is placed as if measured in the frame', (rotation) => {
      const frame = frameSize(rotation)
      const local = trigger(120, 40)
      const box = measuredBox(local.x, local.y, local.width, local.height, rotation)
      const recovered = frameRectFromScreen(box.x, box.y, box.boxWidth, box.boxHeight, rotation, WIN_W, WIN_H)
      // The frame is 874x402 at +/-90 and 402x874 at 0/180: the placement must follow the frame, not the window.
      const insets = { top: 0, right: 34, bottom: 0, left: 62 }
      const viaScreen = computeFramePlacement(recovered, CONTENT_W, CONTENT_H, frame.width, frame.height, insets)
      const direct = computeFramePlacement(local, CONTENT_W, CONTENT_H, frame.width, frame.height, insets)
      expect(viaScreen).toEqual(direct)
    })
  })
})
