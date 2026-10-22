import { getBlendedColor, useAutoPaperTheme } from '@rific/auto-paper'
import Heatmap, { type DataPoint, type TooltipData } from '@rific/heatmap'
import { useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import { Text, useTheme } from 'react-native-paper'

import type { DayRecord } from '@/stores/statsTypes'
import { commaString } from '@/utils/commaString'

import { isMotionReduced } from './reducedMotionFlag'
import { useTableColors } from './theme'

/** How much of the felt an empty day keeps, over the well's surface: a softened ("disabled") felt that still reads as felt in dark mode (at 0.45 it all but vanished there). */
export const EMPTY_DAY_FELT = 0.7

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Oct 22, 2026" from a day's YYYY-MM-DD key. */
export function formatDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return `${MONTHS[month - 1]} ${day}, ${year}`
}

/** What a tapped day says: its deals and wins, or none. */
export function describeDay(played: number, won: number): string {
  if (played === 0) return 'No deals'
  const deals = `${commaString(played)} ${played === 1 ? 'deal' : 'deals'}`
  return won > 0 ? `${deals}, ${commaString(won)} won` : deals
}

/**
 * A year of play, a square a day, the most recent week on the right and the year before it a scroll away
 * (@rific/heatmap's calendar): each day shaded by the deals that ended on it, in the player's color, with a tap showing
 * that day's deals and wins. Fed by the stats' day log (statsTypes.ts' `days`, kept from 2026-10-22, so older play
 * doesn't show). Drawn on the Stats screen's Activity well, so it takes the well's surface colors (hud's wellSurface). Its
 * load ripple and today's pulse are left out under Reduce Motion (reducedMotion.tsx).
 */
export function PlayCalendar({ days }: { days: Record<string, DayRecord> }) {
  const { colors } = useAutoPaperTheme()
  const { tableFelt } = useTableColors()
  const { dark } = useTheme()
  const data = useMemo<DataPoint[]>(() => Object.entries(days).map(([date, day]) => ({ date, value: day.played, metadata: { won: day.won } })), [days])
  const theme = useMemo(() => ({ backgroundColor: 'transparent', monthLabelColor: colors.onSurfaceVariant, dayLabelColor: colors.onSurfaceVariant, todayBorderColor: colors.onSurface, selectedBorderColor: colors.onSurface }), [colors])
  // An empty day is the felt, muted (Jay, 2026-10-22: "the felt color, or a disabled variant of it"); a day played is the
  // player's color, in even steps from a pale tint to full. The package's own scale fades from near-black in dark mode (or
  // white in light), so its lightest shades sat almost on the empty color against this well.
  const colorScale = useMemo(() => {
    const empty = getBlendedColor(tableFelt, colors.surface, EMPTY_DAY_FELT)
    const shade = (amount: number) => getBlendedColor(colors.primary, colors.surface, amount)
    return { emptyColor: empty, colors: [empty, shade(0.35), shade(0.58), shade(0.8), colors.primary] }
  }, [colors, tableFelt])
  const renderTooltip = ({ date, value, metadata }: TooltipData) => (
    <View style={[styles.tooltip, { backgroundColor: colors.inverseSurface }]} pointerEvents='none'>
      <Text variant='labelLarge' style={{ color: colors.inverseOnSurface }}>
        {describeDay(value, typeof metadata?.won === 'number' ? metadata.won : 0)}
      </Text>
      <Text variant='labelSmall' style={{ color: colors.inverseOnSurface }}>
        {formatDay(date)}
      </Text>
    </View>
  )
  return (
    <View testID='play-calendar'>
      <Heatmap.Calendar data={data} color={colors.primary} colorScheme={dark ? 'dark' : 'light'} colorScale={colorScale} theme={theme} animated={!isMotionReduced()} renderTooltip={renderTooltip} tooltipLabel='deal' tooltipEmptyLabel='No deals' />
    </View>
  )
}

const styles = StyleSheet.create({
  // Where the package's own tooltip sits (just above the grid), in the app's font and the theme's inverse surface.
  tooltip: {
    alignSelf: 'center',
    borderRadius: 8,
    bottom: '100%',
    paddingHorizontal: 10,
    paddingVertical: 6,
    position: 'absolute',
    zIndex: 100
  }
})
