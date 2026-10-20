import type { Card } from '@/engine/types'
import { buildAcesUpPreview } from '@/games/acesup/previewLayout'
import { buildCanfieldPreview } from '@/games/canfield/previewLayout'
import { buildFortyThievesPreview } from '@/games/fortythieves/previewLayout'
import { buildFreeCellPreview } from '@/games/freecell/previewLayout'
import { buildGolfPreview } from '@/games/golf/previewLayout'
import { buildKlondikePreview } from '@/games/klondike/previewLayout'
import { buildPyramidPreview } from '@/games/pyramid/previewLayout'
import { buildScorpionPreview } from '@/games/scorpion/previewLayout'
import { buildSpiderPreview } from '@/games/spider/previewLayout'
import { buildTriPeaksPreview } from '@/games/tripeaks/previewLayout'
import { buildYukonPreview } from '@/games/yukon/previewLayout'

import { PREVIEW_CANVAS_HEIGHT, PREVIEW_CANVAS_WIDTH, PREVIEW_CARD_HEIGHT, PREVIEW_CARD_WIDTH, PREVIEW_MARGIN, type PreviewCardPlacement, previewFrame } from '../../components/GamePreview'
import { buildBackStrips, isStripSafe, roundedRectPath } from '../../components/previewGeometry'

const METRICS = { cardWidth: PREVIEW_CARD_WIDTH, cardHeight: PREVIEW_CARD_HEIGHT }
const STYLE = { cardRadius: 2.6, backFrame: 1.4 }

const card = (suit: Card['suit'], faceUp = true) => ({ id: `${suit}-1-0`, suit, rank: 1, faceUp }) as Card
const place = (x: number, y: number, suit: Card['suit'], faceUp = true): PreviewCardPlacement => ({ x, y, card: card(suit, faceUp), faceUp })
const subpaths = (d: string) => (d.match(/M/g) ?? []).length

describe('isStripSafe', () => {
  it('accepts stacked columns that never overlap sideways', () => {
    const col = [place(10, 0, 'hearts', false), place(10, 5, 'spades'), place(10, 16, 'clubs'), place(60, 0, 'hearts')]

    expect(isStripSafe(col, METRICS)).toBe(true)
  })

  it('rejects staggered rows (a Pyramid overlaps sideways as well as down)', () => {
    const pyramid = [place(50, 0, 'hearts'), place(36, 20, 'spades'), place(64, 20, 'clubs')]

    expect(isStripSafe(pyramid, METRICS)).toBe(false)
  })

  it('rejects a column whose draw order is not top-to-bottom (a later card would show above an earlier one)', () => {
    expect(isStripSafe([place(10, 16, 'hearts'), place(10, 0, 'spades')], METRICS)).toBe(false)
  })

  it.each([
    ['klondike', buildKlondikePreview, true],
    ['freecell', buildFreeCellPreview, true],
    ['yukon', buildYukonPreview, true],
    ['canfield', buildCanfieldPreview, true],
    ['fortythieves', buildFortyThievesPreview, true],
    ['spider', buildSpiderPreview, true],
    ['scorpion', buildScorpionPreview, true],
    ['golf', buildGolfPreview, true],
    ['acesup', buildAcesUpPreview, true],
    // Overlapping in both axes - these two stay per-card.
    ['pyramid', buildPyramidPreview, false],
    ['tripeaks', buildTriPeaksPreview, false]
  ])('classifies the real %s preview layout', (_name, build, expected) => {
    expect(isStripSafe(build(), METRICS)).toBe(expected)
  })
})

describe('buildBackStrips', () => {
  it('returns null for an overlapping layout', () => {
    expect(buildBackStrips(buildPyramidPreview(), METRICS, STYLE)).toBeNull()
  })

  it('draws one strip per face-down card and nothing for a face-up one (those are the pre-rendered image)', () => {
    const placements = buildKlondikePreview()
    const faceDown = placements.filter((p) => !p.faceUp).length

    expect(subpaths(buildBackStrips(placements, METRICS, STYLE)!)).toBe(faceDown)
    expect(buildBackStrips([place(10, 0, 'hearts')], METRICS, STYLE)).toBe('')
  })

  it('shows only the visible strip of a covered back, and the whole of an uncovered one', () => {
    // A face-down card with a face-up one 5 units below it: 5 units of the back show.
    expect(buildBackStrips([place(10, 0, 'hearts', false), place(10, 5, 'spades')], METRICS, STYLE)).toBe(roundedRectPath(10 + 0.7, 0 + 0.7, PREVIEW_CARD_WIDTH - 1.4, 5 - 1.4, 2.6, true))
    expect(buildBackStrips([place(10, 0, 'hearts', false)], METRICS, STYLE)).toBe(roundedRectPath(10 + 0.7, 0 + 0.7, PREVIEW_CARD_WIDTH - 1.4, PREVIEW_CARD_HEIGHT - 1.4, 2.6, false))
  })

  // The whole point of merging: nothing overlaps, so a stroke can never bleed across a neighbour.
  it.each([
    ['klondike', buildKlondikePreview],
    ['spider', buildSpiderPreview],
    ['freecell', buildFreeCellPreview],
    ['fortythieves', buildFortyThievesPreview]
  ])('the %s strips never overlap each other', (_name, build) => {
    const placements = build()
    const columns = new Map<number, PreviewCardPlacement[]>()
    placements.forEach((p) => columns.set(p.x, [...(columns.get(p.x) ?? []), p]))
    columns.forEach((col) => {
      col.sort((a, b) => a.y - b.y)
      for (let i = 0; i < col.length - 1; i++) {
        const visible = Math.min(col[i + 1].y - col[i].y, PREVIEW_CARD_HEIGHT)
        expect(col[i].y + visible).toBeLessThanOrEqual(col[i + 1].y + 1e-6)
      }
    })
    expect(buildBackStrips(placements, METRICS, STYLE)).not.toBeNull()
  })
})

// Each tile zooms onto its own deal (Home's tiles used to place every game's cards at one fixed size spread across
// the whole canvas, so a 7-column deal showed small cards with gaps nearly as wide as the cards).
describe('previewFrame', () => {
  const ALL = [buildKlondikePreview, buildFreeCellPreview, buildYukonPreview, buildCanfieldPreview, buildFortyThievesPreview, buildSpiderPreview, buildScorpionPreview, buildPyramidPreview, buildGolfPreview, buildTriPeaksPreview, buildAcesUpPreview]

  it.each(ALL.map((build) => [build.name, build]))('%s: the cards fill the tile but for the margin, on one axis at least', (_name, build) => {
    const placements = build()
    const frame = previewFrame(placements)
    const scale = PREVIEW_CANVAS_WIDTH / frame.width

    expect(frame.width / frame.height).toBeCloseTo(PREVIEW_CANVAS_WIDTH / PREVIEW_CANVAS_HEIGHT)
    // In canvas units: every card at least the margin from each edge, and the tighter axis exactly at it.
    const left = Math.min(...placements.map((p) => (p.x - frame.x) * scale))
    const right = Math.max(...placements.map((p) => (p.x + PREVIEW_CARD_WIDTH - frame.x) * scale))
    const top = Math.min(...placements.map((p) => (p.y - frame.y) * scale))
    const bottom = Math.max(...placements.map((p) => (p.y + PREVIEW_CARD_HEIGHT - frame.y) * scale))
    expect(left).toBeGreaterThanOrEqual(PREVIEW_MARGIN - 1e-6)
    expect(top).toBeGreaterThanOrEqual(PREVIEW_MARGIN - 1e-6)
    expect(PREVIEW_CANVAS_WIDTH - right).toBeCloseTo(left)
    expect(PREVIEW_CANVAS_HEIGHT - bottom).toBeCloseTo(top)
    expect(Math.min(left, top)).toBeCloseTo(PREVIEW_MARGIN)
  })
})
