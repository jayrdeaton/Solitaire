import { getBlendedColor, useAutoPaperTheme } from '@rific/auto-paper'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { Provider as PaperProvider } from 'react-native-paper'

import { dayLabel, describeDay, EMPTY_DAY_FELT, formatDay, PlayCalendar } from '@/components/PlayCalendar'
import type { DayRecord } from '@/stores/statsTypes'

const FELT = '#1e6b4a'
jest.mock('@/components/theme', () => ({ ...jest.requireActual('@/components/theme'), useTableColors: () => ({ tableFelt: '#1e6b4a' }) }))

// The Stats screen's calendar of play (@rific/heatmap): a square a day for the last year, shaded by the deals that ended on
// it (the stats' day log), with a tap showing that day's deals and wins on the well's title line. A day with no deals is
// the felt, softened.

const day = (played: number, won: number): DayRecord => ({ played, won, seconds: 0, games: {} })

type Json = { props?: Record<string, unknown>; children?: (Json | string)[] | null } | string
/** Every `fill` drawn, in tree order (host elements only). */
function fills(node: Json | Json[] | null): unknown[] {
  if (!node || typeof node === 'string') return []
  if (Array.isArray(node)) return node.flatMap(fills)
  return [...(node.props?.fill !== undefined ? [node.props.fill] : []), ...(node.children ?? []).flatMap((child) => fills(child as Json))]
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date(2026, 9, 22, 12))
})
afterEach(() => jest.useRealTimers())

describe('PlayCalendar', () => {
  it("draws a year of days and shows today's deals and wins on one line, or a tapped day's until it is tapped again", async () => {
    await render(
      <PaperProvider>
        <PlayCalendar days={{ '2026-10-22': day(3, 2), '2026-10-20': day(1, 0) }} />
      </PaperProvider>
    )
    // The grid draws once the runtime is idle.
    await act(() => jest.advanceTimersByTime(100))
    expect(screen.getByText('Today · 3 deals, 2 won')).toBeTruthy()

    await act(() => fireEvent.press(screen.getByLabelText('2026-10-20: 1 event')))
    expect(screen.getByText('Tuesday · 1 deal')).toBeTruthy()
    // Last year's days carry their year.
    await act(() => fireEvent.press(screen.getByLabelText('2025-10-23: 0 events')))
    expect(screen.getByText('Oct 23, 2025 · No deals')).toBeTruthy()
    await act(() => fireEvent.press(screen.getByLabelText('2025-10-23: 0 events')))
    expect(screen.getByText('Today · 3 deals, 2 won')).toBeTruthy()
  })

  it('reads a picked day from the days as they are now (the game and player pickers change them)', async () => {
    const { rerender } = await render(
      <PaperProvider>
        <PlayCalendar days={{ '2026-10-20': day(3, 2) }} />
      </PaperProvider>
    )
    await act(() => jest.advanceTimersByTime(100))
    await act(() => fireEvent.press(screen.getByLabelText('2026-10-20: 3 events')))
    await rerender(
      <PaperProvider>
        <PlayCalendar days={{ '2026-10-20': day(1, 1) }} />
      </PaperProvider>
    )
    expect(screen.getByText('Tuesday · 1 deal, 1 won')).toBeTruthy()
  })

  it('draws a day with no deals in the felt, softened over the well', async () => {
    let surface = ''
    function Probe() {
      surface = useAutoPaperTheme().colors.surface
      return null
    }
    await render(
      <PaperProvider>
        <Probe />
        <PlayCalendar days={{ '2026-10-22': day(2, 1) }} />
      </PaperProvider>
    )
    await act(() => jest.advanceTimersByTime(100))
    const emptyFill = getBlendedColor(FELT, surface, EMPTY_DAY_FELT)
    // react-native-svg hands a fill to its native view as an ARGB number.
    const emptyArgb = 0xff000000 + parseInt(emptyFill.slice(1), 16)
    expect(fills(screen.toJSON()).filter((fill) => (fill as { payload?: number } | null)?.payload === emptyArgb).length).toBeGreaterThan(300)
  })

  it('names the past week by its days, then by dates', () => {
    // Thursday, Oct 22, 2026, late in the evening.
    const now = new Date(2026, 9, 22, 23, 30)
    expect(dayLabel('2026-10-22', now)).toBe('Today')
    expect(dayLabel('2026-10-21', now)).toBe('Yesterday')
    expect(dayLabel('2026-10-20', now)).toBe('Tuesday')
    expect(dayLabel('2026-10-16', now)).toBe('Friday')
    // A week back would read as this week's Thursday.
    expect(dayLabel('2026-10-15', now)).toBe('Oct 15')
    expect(dayLabel('2025-10-23', now)).toBe('Oct 23, 2025')
    // Across the clocks going back (Nov 1, 2026 in the US): still one day per day.
    expect(dayLabel('2026-10-31', new Date(2026, 10, 1, 0, 30))).toBe('Yesterday')
    expect(dayLabel('2026-10-27', new Date(2026, 10, 2, 23, 30))).toBe('Tuesday')
    expect(dayLabel('2026-10-26', new Date(2026, 10, 2, 23, 30))).toBe('Oct 26')
  })

  it('says how a day went in words', () => {
    expect(describeDay(0, 0)).toBe('No deals')
    expect(describeDay(1, 0)).toBe('1 deal')
    expect(describeDay(4, 1)).toBe('4 deals, 1 won')
    expect(formatDay('2027-01-05')).toBe('Jan 5, 2027')
    expect(formatDay('2027-01-05', new Date(2027, 5, 1))).toBe('Jan 5')
    expect(formatDay('2026-12-30', new Date(2027, 0, 2))).toBe('Dec 30, 2026')
  })
})
