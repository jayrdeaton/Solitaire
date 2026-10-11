import { CARD_GAP_MAX, CARD_GAP_MIN, CARD_WIDTH_MAX, cardLayoutForRow, SPLIT_TOP_ROW_MIN_GAP, splitTopRowGroupGap } from '@/components/cardLayout'
import { GAME_CONTENT_MAX_WIDTH, GAME_CONTENT_PADDING } from '@/components/gameLayout'

/** Where a split top row's two groups end up when laid out space-between in a row as wide as the tableau (FreeCell's and
 * Forty Thieves' topRow): the gap inside each group and the split left between them. */
function splitTopRow(rowWidth: number, cardWidth: number, tableauGap: number, groups: [number, number]) {
  const groupGap = splitTopRowGroupGap(tableauGap)
  const groupWidth = (cards: number) => cards * cardWidth + (cards - 1) * groupGap
  return { groupGap, split: rowWidth - groupWidth(groups[0]) - groupWidth(groups[1]) }
}

const PHONE_AND_TABLET_WIDTHS = [320, 375, 393, 402, 440, 768, 820, 1024, 1366]

describe('cardLayoutForRow', () => {
  it('defaults to the CARD_GAP_MIN floor', () => {
    expect(cardLayoutForRow(398, 8)).toEqual({ cardWidth: 48, gap: CARD_GAP_MIN })
    expect(cardLayoutForRow(398, 8)).toEqual(cardLayoutForRow(398, 8, CARD_GAP_MIN))
  })

  it('sizes the cards around a raised gap floor', () => {
    // 398 - 7 gaps of 4 = 370, over 8 cards.
    expect(cardLayoutForRow(398, 8, SPLIT_TOP_ROW_MIN_GAP)).toEqual({ cardWidth: 46.25, gap: SPLIT_TOP_ROW_MIN_GAP })
  })

  it('keeps the raised floor once the cards max out and the gap grows', () => {
    // 800 - 8 x 96 = 32 over 7 gaps = 4.57: past CARD_GAP_MIN's floor, still above the raised one.
    expect(cardLayoutForRow(800, 8, SPLIT_TOP_ROW_MIN_GAP).gap).toBeCloseTo(32 / 7)
    // Just wide enough to max the cards at the raised floor.
    expect(cardLayoutForRow(CARD_WIDTH_MAX * 8 + SPLIT_TOP_ROW_MIN_GAP * 7, 8, SPLIT_TOP_ROW_MIN_GAP)).toEqual({ cardWidth: CARD_WIDTH_MAX, gap: SPLIT_TOP_ROW_MIN_GAP })
    expect(cardLayoutForRow(GAME_CONTENT_MAX_WIDTH, 8, SPLIT_TOP_ROW_MIN_GAP).gap).toBe(CARD_GAP_MAX)
  })
})

describe('the split top row', () => {
  it.each([
    ['FreeCell', 8, [4, 4] as [number, number]],
    ['Forty Thieves', 10, [8, 2] as [number, number]]
  ])('%s: never squeezes a group below CARD_GAP_MIN, and splits the groups by columns * gap / 2', (_name, columns, groups) => {
    for (const windowWidth of PHONE_AND_TABLET_WIDTHS) {
      const rowWidth = Math.min(windowWidth, GAME_CONTENT_MAX_WIDTH) - GAME_CONTENT_PADDING * 2
      const { cardWidth, gap } = cardLayoutForRow(rowWidth, columns, SPLIT_TOP_ROW_MIN_GAP)
      const tableauWidth = columns * cardWidth + (columns - 1) * gap
      const { groupGap, split } = splitTopRow(tableauWidth, cardWidth, gap, groups)
      expect(groupGap).toBeGreaterThanOrEqual(CARD_GAP_MIN)
      expect(split).toBeCloseTo((columns * gap) / 2, 10)
      // A split that reads as one: at least four of the gaps inside a group.
      expect(split).toBeGreaterThanOrEqual(groupGap * 4)
    }
  })

  it("gives FreeCell's groups a 16pt split on a 402pt phone, for ~1.75pt of card width", () => {
    const rowWidth = 402 - GAME_CONTENT_PADDING * 2
    const before = cardLayoutForRow(rowWidth, 8)
    const { cardWidth, gap } = cardLayoutForRow(rowWidth, 8, SPLIT_TOP_ROW_MIN_GAP)
    expect(splitTopRow(rowWidth, cardWidth, gap, [4, 4])).toEqual({ groupGap: CARD_GAP_MIN, split: 16 })
    expect(before.cardWidth - cardWidth).toBeCloseTo(1.75, 10)
  })
})
