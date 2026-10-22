import { getBlendedColor, useAutoPaperTheme } from '@rific/auto-paper'
import Heatmap, { type DataPoint, type TooltipData } from '@rific/heatmap'
import { localDateString } from '@tastic/achievements'
import { useEffect, useMemo, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { Text, useTheme } from 'react-native-paper'

import type { DayRecord } from '@/stores/statsTypes'
import { commaString } from '@/utils/commaString'

import { isMotionReduced } from './reducedMotionFlag'
import { useTableColors } from './theme'

/** How much of the felt an empty day keeps, over the well's surface: a softened ("disabled") felt that still reads as felt in dark mode (at 0.45 it all but vanished there). */
export const EMPTY_DAY_FELT = 0.7

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** "Oct 22, 2026" from a day's YYYY-MM-DD key, or "Oct 22" when `now` is in the same year. */
export function formatDay(date: string, now?: Date): string {
  const [year, month, day] = date.split('-').map(Number)
  return now && now.getFullYear() === year ? `${MONTHS[month - 1]} ${day}` : `${MONTHS[month - 1]} ${day}, ${year}`
}

/**
 * A day's name on the calendar's line, counted from `now` (Jay, 2026-10-22): Today, Yesterday, then the weekday for the
 * rest of the past week, then the date (a weekday a week back would read as this week's).
 */
export function dayLabel(date: string, now: Date): string {
  const [year, month, day] = date.split('-').map(Number)
  const then = new Date(year, month - 1, day)
  // Rounded, since a day across a daylight saving change is 23 or 25 hours.
  const daysAgo = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - then.getTime()) / 86_400_000)
  if (daysAgo === 0) return 'Today'
  if (daysAgo === 1) return 'Yesterday'
  if (daysAgo > 1 && daysAgo < 7) return WEEKDAYS[then.getDay()]
  return formatDay(date, now)
}

/** What a tapped day says: its deals and wins, or none. */
export function describeDay(played: number, won: number): string {
  if (played === 0) return 'No deals'
  const deals = `${commaString(played)} ${played === 1 ? 'deal' : 'deals'}`
  return won > 0 ? `${deals}, ${commaString(won)} won` : deals
}

/** How far in from the well's left edge the day's line may reach: 12pt clear of the well's "CALENDAR" label (93pt on the web build). */
export const DAY_LINE_LEFT = 105

// Lifts the heatmap's selected day out to PlayCalendar: the package keeps which day is picked to itself and only hands it
// to renderTooltip while one is (a tap on it again, or anywhere else in the calendar, clears it), so this stands in as the
// tooltip and reports the day, and null when it is cleared. Following onDayPress instead would miss those clears.
function SelectedDayReporter({ date, onChange }: { date: string; onChange: (date: string | null) => void }) {
  useEffect(() => {
    onChange(date)
    return () => onChange(null)
  }, [date, onChange])
  return null
}

/**
 * A year of play, a square a day, the most recent week on the right and the year before it a scroll away
 * (@rific/heatmap's calendar): each day shaded by the deals that ended on it, in the player's color. A tapped day (the
 * package outlines it) shows its deals and wins on the well's title line, right of the label (Jay, 2026-10-22: the
 * package's popover ignored the theme and Blur, poked out above the well and would have covered days near the one tapped);
 * with none tapped, the line shows today.
 * Fed by the stats' day log (statsTypes.ts' `days`, kept from 2026-10-22, so older play doesn't show). Drawn on the
 * Stats screen's Calendar well, so it takes the well's surface colors (hud's wellSurface). Its load ripple and today's
 * pulse are left out under Reduce Motion (reducedMotion.tsx).
 */
export function PlayCalendar({ days }: { days: Record<string, DayRecord> }) {
  const { colors } = useAutoPaperTheme()
  const { tableFelt } = useTableColors()
  const { dark } = useTheme()
  const data = useMemo<DataPoint[]>(() => Object.entries(days).map(([date, day]) => ({ date, value: day.played })), [days])
  const theme = useMemo(() => ({ backgroundColor: 'transparent', monthLabelColor: colors.onSurfaceVariant, dayLabelColor: colors.onSurfaceVariant, todayBorderColor: colors.onSurface, selectedBorderColor: colors.onSurface }), [colors])
  // An empty day is the felt, muted (Jay, 2026-10-22: "the felt color, or a disabled variant of it"); a day played is the
  // player's color, in even steps from a pale tint to full. The package's own scale fades from near-black in dark mode (or
  // white in light), so its lightest shades sat almost on the empty color against this well.
  const colorScale = useMemo(() => {
    const empty = getBlendedColor(tableFelt, colors.surface, EMPTY_DAY_FELT)
    const shade = (amount: number) => getBlendedColor(colors.primary, colors.surface, amount)
    return { emptyColor: empty, colors: [empty, shade(0.35), shade(0.58), shade(0.8), colors.primary] }
  }, [colors, tableFelt])
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  // Today until a day is tapped (Jay, 2026-10-22). Read from the days as they are now, not as they were at the tap: the
  // game and player pickers change them under a day that stays picked.
  const now = new Date()
  const today = localDateString(now)
  const shownDate = selectedDate ?? today
  const shown = { label: dayLabel(shownDate, now), played: days[shownDate]?.played ?? 0, won: days[shownDate]?.won ?? 0 }
  const renderTooltip = ({ date }: TooltipData) => <SelectedDayReporter date={date} onChange={setSelectedDate} />
  return (
    <View testID='play-calendar'>
      <Text variant='labelMedium' numberOfLines={1} accessibilityLiveRegion='polite' style={[styles.dayLine, { color: colors.onSurfaceVariant }]}>
        {`${shown.label} · ${describeDay(shown.played, shown.won)}`}
      </Text>
      <Heatmap.Calendar data={data} color={colors.primary} colorScheme={dark ? 'dark' : 'light'} colorScale={colorScale} theme={theme} animated={!isMotionReduced()} renderTooltip={renderTooltip} tooltipLabel='deal' tooltipEmptyLabel='No deals' />
    </View>
  )
}

const styles = StyleSheet.create({
  // On the well's title line: above the calendar by StatSection's 8pt gap, on the label's 16pt line, right-aligned and
  // cut short with an ellipsis before it reaches the label.
  dayLine: {
    bottom: '100%',
    left: DAY_LINE_LEFT,
    marginBottom: 8,
    position: 'absolute',
    right: 0,
    textAlign: 'right'
  }
})
