import { localOffsetToScreenPoint, screenToLocalPoint, wasteFanScreenShift } from '@/components/overlayFrameMath'

// A 402x874 portrait window, and a 96x140 card (the size the FreeCell simulator run measured).
const WIN_W = 402
const WIN_H = 874
const CARD_W = 96
const CARD_H = 140

/** Independent forward model of FakeLandscapeView/RotatedGameView: a container of local size
 * (localW x localH), centred in the window, rotated `rotation` degrees clockwise about its centre. Maps a
 * card's LOCAL top-left to the top-left of the bounding box iOS reports for it in screen space. */
function localToScreenBBoxTopLeft(lx: number, ly: number, rotation: number) {
  const swapped = Math.abs(rotation) === 90
  const localW = swapped ? WIN_H : WIN_W
  const localH = swapped ? WIN_W : WIN_H
  const rad = (rotation * Math.PI) / 180
  const relX = lx + CARD_W / 2 - localW / 2
  const relY = ly + CARD_H / 2 - localH / 2
  const screenCx = WIN_W / 2 + relX * Math.cos(rad) - relY * Math.sin(rad)
  const screenCy = WIN_H / 2 + relX * Math.sin(rad) + relY * Math.cos(rad)
  const bboxW = swapped ? CARD_H : CARD_W
  const bboxH = swapped ? CARD_W : CARD_H
  return { x: screenCx - bboxW / 2, y: screenCy - bboxH / 2 }
}

describe('screenToLocalPoint', () => {
  it.each([0, 90, -90, 180])('inverts the rotated-container transform at %i degrees', (rotation) => {
    for (const [lx, ly] of [
      [0, 0],
      [100, 50],
      [250, 20]
    ]) {
      const screen = localToScreenBBoxTopLeft(lx, ly, rotation)
      const local = screenToLocalPoint(screen.x, screen.y, CARD_W, CARD_H, rotation, WIN_W, WIN_H)
      expect(local.x).toBeCloseTo(lx, 6)
      expect(local.y).toBeCloseTo(ly, 6)
    }
  })

  it('is a plain identity at 0 degrees for a window-filling overlay', () => {
    expect(screenToLocalPoint(37, 412, CARD_W, CARD_H, 0, WIN_W, WIN_H)).toEqual({ x: 37, y: 412 })
  })

  it('maps a finger drag along screen +x to local -y at +90 degrees (ghost follows the finger)', () => {
    const start = screenToLocalPoint(35, 772, CARD_W, CARD_H, 90, WIN_W, WIN_H)
    const dragged = screenToLocalPoint(35 + 90, 772 - 110, CARD_W, CARD_H, 90, WIN_W, WIN_H)
    // Measured live: screen (+90, -110) became local (-110, -90).
    expect(dragged.x - start.x).toBeCloseTo(-110, 6)
    expect(dragged.y - start.y).toBeCloseTo(-90, 6)
  })
})

describe('localOffsetToScreenPoint', () => {
  // A 300x200 (local) container sitting in the rotated frame, holding a card at a known local offset.
  const CONTAINER_LOCAL_W = 300
  const CONTAINER_LOCAL_H = 200
  const CONTAINER_LOCAL_LEFT = 120
  const CONTAINER_LOCAL_TOP = 40

  it.each([0, 90, -90, 180])('agrees with the full-frame forward model at %i degrees', (rotation) => {
    for (const [offsetLeft, offsetTop] of [
      [0, 0],
      [60, 30],
      [204, 60]
    ]) {
      // Ground truth: the card's LOCAL top-left in the frame, forward-transformed to screen.
      const truth = localToScreenBBoxTopLeft(CONTAINER_LOCAL_LEFT + offsetLeft, CONTAINER_LOCAL_TOP + offsetTop, rotation)
      // What a measureView() of the container would report: the container's own bbox top-left.
      const containerBBox = (() => {
        const swapped = Math.abs(rotation) === 90
        const rad = (rotation * Math.PI) / 180
        const localW = swapped ? WIN_H : WIN_W
        const localH = swapped ? WIN_W : WIN_H
        const relX = CONTAINER_LOCAL_LEFT + CONTAINER_LOCAL_W / 2 - localW / 2
        const relY = CONTAINER_LOCAL_TOP + CONTAINER_LOCAL_H / 2 - localH / 2
        const cx = WIN_W / 2 + relX * Math.cos(rad) - relY * Math.sin(rad)
        const cy = WIN_H / 2 + relX * Math.sin(rad) + relY * Math.cos(rad)
        const bw = swapped ? CONTAINER_LOCAL_H : CONTAINER_LOCAL_W
        const bh = swapped ? CONTAINER_LOCAL_W : CONTAINER_LOCAL_H
        return { x: cx - bw / 2, y: cy - bh / 2 }
      })()
      const got = localOffsetToScreenPoint(containerBBox, CONTAINER_LOCAL_W, CONTAINER_LOCAL_H, offsetLeft, offsetTop, CARD_W, CARD_H, rotation)
      expect(got.x).toBeCloseTo(truth.x, 6)
      expect(got.y).toBeCloseTo(truth.y, 6)
    }
  })

  it('is exactly container top-left plus the offset at 0 degrees', () => {
    expect(localOffsetToScreenPoint({ x: 10, y: 20 }, 300, 200, 55, 33, CARD_W, CARD_H, 0)).toEqual({ x: 65, y: 53 })
  })

  it('round-trips with screenToLocalPoint', () => {
    for (const rotation of [90, -90, 180]) {
      const containerBBox = { x: 40, y: 120 }
      const screen = localOffsetToScreenPoint(containerBBox, 300, 200, 60, 30, CARD_W, CARD_H, rotation)
      const local = screenToLocalPoint(screen.x, screen.y, CARD_W, CARD_H, rotation, WIN_W, WIN_H)
      const containerLocal = screenToLocalPoint(containerBBox.x, containerBBox.y, 300, 200, rotation, WIN_W, WIN_H)
      expect(local.x - containerLocal.x).toBeCloseTo(60, 6)
      expect(local.y - containerLocal.y).toBeCloseTo(30, 6)
    }
  })
})

describe('wasteFanScreenShift', () => {
  it('runs left on screen at 0deg', () => {
    expect(wasteFanScreenShift(30, 0)).toEqual({ x: -30, y: 0 })
  })
  it('runs up the screen at +90 (local left = screen top)', () => {
    expect(wasteFanScreenShift(30, 90)).toEqual({ x: 0, y: -30 })
  })
  it('runs down the screen at -90 (local left = screen bottom)', () => {
    expect(wasteFanScreenShift(30, -90)).toEqual({ x: 0, y: 30 })
  })
  it('runs right on screen at 180', () => {
    expect(wasteFanScreenShift(30, 180)).toEqual({ x: 30, y: 0 })
  })
  it('is zero for a zero distance', () => {
    expect(wasteFanScreenShift(0, 90)).toEqual({ x: 0, y: 0 })
  })
})
