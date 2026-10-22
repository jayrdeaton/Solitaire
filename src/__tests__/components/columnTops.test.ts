import { columnTops, MIN_FACE_DOWN_FAN_SCALE, MIN_FACE_UP_FAN_SCALE } from '@/components/columnTops'
import { Card } from '@/engine/types'

// PileView's fan: where each card of a column sits, and how tall the column is. Compressed to fit `maxHeight`, face-down
// steps first, but never below MIN_FACE_DOWN_FAN_SCALE and MIN_FACE_UP_FAN_SCALE - a column that needs more runs past it (PileView sizes its box to `totalHeight`) and GameChrome's
// board scrolls to it (boardScroll.ts), instead of squeezing every covered card's index until it can't be read or tapped.

const UP = 25
const DOWN = 10
const CARD_HEIGHT = 80
const NONE = [] as const

const cardsOf = (faceDown: number, faceUp: number): Card[] => Array.from({ length: faceDown + faceUp }, (_, i) => ({ id: `spades-${(i % 13) + 1}-${i}`, suit: 'spades', rank: (i % 13) + 1, faceUp: i >= faceDown }) as Card)
const tops = (cards: Card[], maxHeight?: number) => columnTops(cards, NONE, UP, DOWN, CARD_HEIGHT, maxHeight)

describe('columnTops', () => {
  it('fans each card one step below the card under it: face-down cards a face-down step, face-up cards a face-up step', () => {
    expect(tops(cardsOf(2, 3)).tops).toEqual([0, DOWN, 2 * DOWN, 2 * DOWN + UP, 2 * DOWN + 2 * UP])
  })

  it('is as tall as the top of its last card plus one card: the top card shows whole, its own step is not part of the fan', () => {
    expect(tops(cardsOf(2, 3)).totalHeight).toBe(2 * DOWN + 2 * UP + CARD_HEIGHT)
    expect(tops(cardsOf(0, 1)).totalHeight).toBe(CARD_HEIGHT)
    expect(tops([]).totalHeight).toBe(CARD_HEIGHT)
  })

  it('leaves a column that exactly fits its maxHeight uncompressed (it used to count one step too many, and squeeze it)', () => {
    const cards = cardsOf(0, 9)
    const fits = 8 * UP + CARD_HEIGHT
    expect(tops(cards, fits).tops).toEqual(cards.map((_, i) => i * UP))
    expect(tops(cards, fits).totalHeight).toBe(fits)
  })

  it('compresses a column that does not fit, face-down steps first, until its last card ends exactly at maxHeight', () => {
    const cards = cardsOf(4, 10)
    // 4 face-down steps (40) and 9 face-up ones (225) over a card: 345 natural. 335 is room for the face-down steps alone to give.
    const { tops: compressed, totalHeight } = tops(cards, 335)
    expect(compressed[compressed.length - 1] + CARD_HEIGHT).toBeCloseTo(335, 9)
    expect(totalHeight).toBeCloseTo(335, 9)
    expect(compressed[1] / DOWN).toBeCloseTo(0.75, 9)
    expect(compressed[5] - compressed[4]).toBeCloseTo(UP, 9)
  })

  it('squeezes the face-up steps only once the face-down ones are at their tightest', () => {
    const cards = cardsOf(4, 10)
    const { tops: compressed, totalHeight } = tops(cards, 320)
    expect(totalHeight).toBeCloseTo(320, 9)
    expect(compressed[1]).toBeCloseTo(DOWN * MIN_FACE_DOWN_FAN_SCALE, 9)
    const upScale = (compressed[5] - compressed[4]) / UP
    expect(upScale).toBeGreaterThan(MIN_FACE_UP_FAN_SCALE)
    expect(upScale).toBeLessThan(1)
  })

  it('never compresses past the floors: a column too long for them runs past maxHeight, and says how far', () => {
    const cards = cardsOf(6, 34) // a 40-card Yukon column
    const maxHeight = 520
    const { tops: compressed, totalHeight } = tops(cards, maxHeight)
    expect(compressed[1] - compressed[0]).toBeCloseTo(DOWN * MIN_FACE_DOWN_FAN_SCALE, 9)
    expect(compressed[39] - compressed[38]).toBeCloseTo(UP * MIN_FACE_UP_FAN_SCALE, 9)
    expect(totalHeight).toBeCloseTo(6 * DOWN * MIN_FACE_DOWN_FAN_SCALE + 33 * UP * MIN_FACE_UP_FAN_SCALE + CARD_HEIGHT, 9)
    expect(totalHeight).toBeGreaterThan(maxHeight)
  })

  it('keeps the whole rank of every covered face-up card readable: never under 0.4275 of a card width', () => {
    // @tastic/cards' faceUpFanOffset is 0.45W, and a Q's tail reaches 0.417W down the card.
    expect(0.45 * MIN_FACE_UP_FAN_SCALE).toBeGreaterThanOrEqual(0.4275)
  })

  it('never fans upward, however short maxHeight is (shorter than a card, or 0)', () => {
    for (const maxHeight of [CARD_HEIGHT - 1, 10, 0]) {
      const { tops: laidOut, totalHeight } = tops(cardsOf(3, 5), maxHeight)
      laidOut.forEach((top, i) => i > 0 && expect(top).toBeGreaterThan(laidOut[i - 1]))
      expect(laidOut[1]).toBeCloseTo(DOWN * MIN_FACE_DOWN_FAN_SCALE, 9)
      expect(totalHeight).toBeGreaterThan(CARD_HEIGHT)
    }
  })

  it('a lone card under a maxHeight shorter than itself is simply drawn at the top', () => {
    expect(tops(cardsOf(0, 1), 10)).toEqual({ tops: [0], totalHeight: CARD_HEIGHT, slots: 1 })
  })

  it("lays a column out in the fan of a card still held over it, that card's own step counted by its own face", () => {
    const cards = cardsOf(1, 2)
    const heldDown = { card: { id: 'hearts-5-0', suit: 'hearts', rank: 5, faceUp: false } as Card, top: 0, zIndex: 4, slots: 6 }
    // Slots 0-2 are the column's cards, 3 has no held card (face-up), 4 is the held face-down card, 5 the top.
    const { tops: laidOut, totalHeight, slots } = columnTops(cards, [heldDown], UP, DOWN, CARD_HEIGHT, undefined)
    expect(slots).toBe(6)
    expect(laidOut).toEqual([0, DOWN, DOWN + UP])
    expect(totalHeight).toBe(DOWN + UP + UP + UP + DOWN + CARD_HEIGHT)
  })
})
