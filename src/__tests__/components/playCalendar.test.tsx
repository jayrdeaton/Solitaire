import { getBlendedColor, useAutoPaperTheme } from '@rific/auto-paper'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { Provider as PaperProvider } from 'react-native-paper'

import { describeDay, EMPTY_DAY_FELT, formatDay, PlayCalendar } from '@/components/PlayCalendar'
import type { DayRecord } from '@/stores/statsTypes'

const FELT = '#1e6b4a'
jest.mock('@/components/theme', () => ({ ...jest.requireActual('@/components/theme'), useTableColors: () => ({ tableFelt: '#1e6b4a' }) }))

// The Stats screen's calendar of play (@rific/heatmap): a square a day for the last year, shaded by the deals that ended on
// it (the stats' day log), with a tap showing that day's deals and wins. A day with no deals is the felt, softened.

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
  it("draws a year of days and shows a tapped day's deals and wins", async () => {
    await render(
      <PaperProvider>
        <PlayCalendar days={{ '2026-10-22': day(3, 2), '2026-10-20': day(1, 0) }} />
      </PaperProvider>
    )
    // The grid draws once the runtime is idle.
    await act(() => jest.advanceTimersByTime(100))
    await act(() => fireEvent.press(screen.getByLabelText('2026-10-22: 3 events')))
    expect(screen.getByText('3 deals, 2 won')).toBeTruthy()
    expect(screen.getByText('Oct 22, 2026')).toBeTruthy()
    expect(screen.getByLabelText('2026-10-20: 1 event')).toBeTruthy()
    expect(screen.getByLabelText('2025-10-23: 0 events')).toBeTruthy()
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

  it('says how a day went in words', () => {
    expect(describeDay(0, 0)).toBe('No deals')
    expect(describeDay(1, 0)).toBe('1 deal')
    expect(describeDay(4, 1)).toBe('4 deals, 1 won')
    expect(formatDay('2027-01-05')).toBe('Jan 5, 2027')
  })
})
