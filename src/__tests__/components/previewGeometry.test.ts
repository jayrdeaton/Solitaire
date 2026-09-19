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

import { PREVIEW_CARD_HEIGHT, PREVIEW_CARD_WIDTH, type PreviewCardPlacement } from '../../components/GamePreview'
import { buildMergedPreview, isStripSafe, roundedRectPath, transformPath } from '../../components/previewGeometry'

const METRICS = { cardWidth: PREVIEW_CARD_WIDTH, cardHeight: PREVIEW_CARD_HEIGHT }
const STYLE = { cardRadius: 2.6, backFrame: 1.4, pipScale: 0.85, pipInsetX: 3.2, pipInsetY: 1.8, medallionHalf: 6 }

const card = (suit: Card['suit'], faceUp = true) => ({ id: `${suit}-1-0`, suit, rank: 1, faceUp }) as Card
const place = (x: number, y: number, suit: Card['suit'], faceUp = true): PreviewCardPlacement => ({ x, y, card: card(suit, faceUp), faceUp })
const subpaths = (d: string) => (d.match(/M/g) ?? []).length

describe('transformPath', () => {
  it('scales then translates every coordinate of an absolute M/L/C/Z path', () => {
    expect(transformPath('M1 2 L3 4 Z', 2, 10, 20)).toBe('M12.00 24.00 L16.00 28.00 Z')
    expect(transformPath('M0 0 C1 1 2 2 3 3 Z', 1, 5, 7)).toBe('M5.00 7.00 C6.00 8.00 7.00 9.00 8.00 10.00 Z')
  })
})

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

describe('buildMergedPreview', () => {
  it('returns null for an overlapping layout', () => {
    expect(buildMergedPreview(buildPyramidPreview(), METRICS, STYLE)).toBeNull()
  })

  it('draws one strip per card, split by face and back, with a pip per face-up card', () => {
    const placements = buildKlondikePreview()
    const faceUp = placements.filter((p) => p.faceUp).length
    const merged = buildMergedPreview(placements, METRICS, STYLE)!

    expect(subpaths(merged.faces)).toBe(faceUp)
    expect(subpaths(merged.backs)).toBe(placements.length - faceUp)
    // A pip is one subpath, except the club's four (three lobes + stem).
    const clubs = placements.filter((p) => p.faceUp && p.card?.suit === 'clubs').length
    expect(subpaths(merged.redPips) + subpaths(merged.blackPips)).toBe(faceUp - clubs + clubs * 4)
  })

  it('shows only the visible strip of a covered card, and the whole last card', () => {
    // A face-down card with a face-up one 5 units below it: 5 units of the back show, the full card of the face.
    const merged = buildMergedPreview([place(10, 0, 'hearts', false), place(10, 5, 'spades')], METRICS, STYLE)!

    // The covered back is inset by half the frame on every side and only 5 units tall (minus the frame).
    expect(merged.backs).toBe(roundedRectPath(10 + 0.7, 0 + 0.7, PREVIEW_CARD_WIDTH - 1.4, 5 - 1.4, 2.6, true))
    expect(merged.faces).toBe(roundedRectPath(10, 5, PREVIEW_CARD_WIDTH, PREVIEW_CARD_HEIGHT, 2.6, false))
    // No medallion on a covered back.
    expect(merged.medallions).toBe('')
  })

  it('keeps a lone face-down card whole, medallion included', () => {
    const merged = buildMergedPreview([place(10, 0, 'hearts', false)], METRICS, STYLE)!

    expect(subpaths(merged.medallions)).toBe(1)
  })

  it('puts pips of red suits and black suits in separate paths', () => {
    const merged = buildMergedPreview([place(10, 0, 'hearts'), place(60, 0, 'diamonds'), place(110, 0, 'spades')], METRICS, STYLE)!

    expect(subpaths(merged.redPips)).toBe(2)
    expect(subpaths(merged.blackPips)).toBe(1)
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
    expect(buildMergedPreview(placements, METRICS, STYLE)).not.toBeNull()
  })
})
