import { localDateString } from '@tastic/achievements'
import { StatSection, useWellColors } from '@tastic/hud/chrome'
import type { Profile } from '@tastic/profile'
import { StyleSheet, View } from 'react-native'
import { Text } from 'react-native-paper'

import { formatTime } from '@/components/GameChrome'
import { formatDay } from '@/components/PlayCalendar'
import type { GameFilter } from '@/components/StatsFilters'
import { boardValue, TOP_WINS_KEPT, type TopWin, type TopWinsBoard } from '@/engine/topWins'
import { type VariantId, type VariantInfo, VARIANTS } from '@/engine/variants'
import { GUEST_PLAYER_ID } from '@/redux/activeProfileSlice'
import type { TopWinsState } from '@/redux/topWinsSlice'
import { GAME_TITLES, type StatsState } from '@/stores/statsTypes'
import { commaString } from '@/utils/commaString'

interface RecordsListProps {
  board: TopWinsBoard
  topWins: TopWinsState
  stats: StatsState
  profiles: Profile[]
  // null = Everyone (every player's wins on one board, each named); GUEST_PLAYER_ID = guest.
  profileId: string | null
  game: GameFilter
}

interface Entry extends TopWin {
  player: string
}

interface VariantRecords {
  info: VariantInfo
  entries: Entry[]
  // Whether every win in the variant is on the boards, so the places are real (see engine/topWins.ts' rankWin).
  ranked: boolean
}

/** The best wins in one variant, the player's own or (Everyone) every player's together, and whether they can be ranked:
 * the boards saw as many wins as the stats count. Everyone's are each player's boards merged, so they are ranked only when
 * every win on the phone was seen by one of them. */
function recordsOf(variant: VariantId, board: TopWinsBoard, topWins: TopWinsState, stats: StatsState, profileId: string | null): Omit<VariantRecords, 'info'> {
  const players = profileId === null ? Object.keys(topWins) : [profileId]
  const entries = players
    .flatMap((player) => (topWins[player]?.[variant]?.[board] ?? []).map((win) => ({ ...win, player })))
    // By the board's value, then the earlier win first (an undated one is from before any dated one).
    .sort((a, b) => boardValue(board, a) - boardValue(board, b) || (a.at ?? 0) - (b.at ?? 0))
    .slice(0, TOP_WINS_KEPT)
  const seen = players.reduce((sum, player) => sum + (topWins[player]?.[variant]?.seen ?? 0), 0)
  const wins = (profileId === null ? stats : stats.profiles[profileId])?.variants[variant]?.record.wins ?? 0
  return { entries, ranked: seen >= wins }
}

const variantLabel = (info: VariantInfo) => `${GAME_TITLES[info.game]}${info.label ? ` · ${info.label}` : ''}`.toUpperCase()

/**
 * The Stats screen's Records tab (a stats-loving friend of Jay's, 2026-10-23: "high scores are peak"): each rule set's 10
 * best wins, by best score or fastest time, with the other two numbers and the day each was won. Everyone puts every
 * player's wins on one board and names whose each is (with no profile there is only guest, so no names). Only rule sets
 * with a win show; narrowed to one game, its rule sets.
 *
 * A board is ranked only when it holds every win there was: wins from before 2026-10-23 were kept only as far as the
 * player's recent wins go (redux/topWinsSlice.ts), so a player with older wins gets the best of what was kept, unnumbered,
 * and says so. The same rule keeps the win card from claiming a place it can't know.
 */
export function RecordsList({ board, topWins, stats, profiles, profileId, game }: RecordsListProps) {
  const now = new Date()
  const named = profileId === null && profiles.length > 0
  const nameOf = (player: string) => (player === GUEST_PLAYER_ID ? 'Guest' : (profiles.find((p) => p.id === player)?.name ?? ''))
  const shown = VARIANTS.filter((info) => game === 'all' || info.game === game)
    .map((info) => ({ info, ...recordsOf(info.id, board, topWins, stats, profileId) }))
    .filter((records) => records.entries.length > 0)

  if (shown.length === 0)
    return (
      <StatSection label={game === 'all' ? 'RECORDS' : GAME_TITLES[game].toUpperCase()}>
        <EmptyLine />
      </StatSection>
    )

  return (
    <>
      {shown.map(({ info, entries, ranked }) => (
        <StatSection key={info.id} label={variantLabel(info)}>
          <RecordRow header board={board} ranked={ranked} named={named} />
          {entries.map((entry, i) => (
            <RecordRow
              key={i}
              board={board}
              ranked={ranked}
              named={named}
              // Competition ranking: wins exactly as good share a place, and the next place skips past them.
              rank={String(1 + entries.filter((e) => boardValue(board, e) < boardValue(board, entry)).length)}
              score={commaString(entry.score)}
              time={formatTime(entry.seconds)}
              moves={commaString(entry.moves)}
              player={nameOf(entry.player)}
              date={entry.at === null ? '-' : formatDay(localDateString(new Date(entry.at)), now)}
            />
          ))}
          {!ranked && <Footnote />}
        </StatSection>
      ))}
    </>
  )
}

function EmptyLine() {
  const { fgMuted } = useWellColors()
  return (
    <Text variant='bodyMedium' style={{ color: fgMuted }}>
      No wins yet
    </Text>
  )
}

function Footnote() {
  const { fgMuted } = useWellColors()
  return (
    <Text variant='bodySmall' style={[styles.footnote, { color: fgMuted }]}>
      Not ranked: some earlier wins weren&rsquo;t kept
    </Text>
  )
}

interface RecordRowProps {
  board: TopWinsBoard
  ranked: boolean
  named: boolean
  // The column labels instead of a win.
  header?: boolean
  rank?: string
  score?: string
  time?: string
  moves?: string
  player?: string
  date?: string
}

/** One row of the table: place, score, time, then moves, or (Everyone) whose win it was in its place: six columns don't
 * fit a phone, and the name matters more there. Then the date. The app font is bold throughout, so the board's own column
 * stands out by color: full contrast, the rest muted. */
function RecordRow({ board, ranked, named, header = false, rank, score, time, moves, player, date }: RecordRowProps) {
  const { fg, fgMuted } = useWellColors()
  const variant = header ? 'labelSmall' : 'bodyMedium'
  const color = (key?: TopWinsBoard) => ({ color: key === board ? fg : fgMuted })
  // A screen reader hears a win as one line ("#2, score 245, time 2:31, 98 moves, Oct 21"), and skips the labels.
  const label = header ? undefined : [ranked && `#${rank}`, `score ${score}`, `time ${time}`, named ? player : `${moves} moves`, date !== '-' && date].filter(Boolean).join(', ')
  return (
    <View style={styles.row} accessible={!header} accessibilityLabel={label} importantForAccessibility={header ? 'no-hide-descendants' : 'yes'} testID={header ? undefined : 'record-row'}>
      {ranked && (
        <Text variant={variant} style={[styles.rank, color()]}>
          {header ? '#' : rank}
        </Text>
      )}
      <Text variant={variant} style={[styles.number, color('score')]}>
        {header ? 'SCORE' : score}
      </Text>
      <Text variant={variant} style={[styles.number, color('time')]}>
        {header ? 'TIME' : time}
      </Text>
      {named ? (
        <Text variant={variant} style={[styles.player, color()]} numberOfLines={1}>
          {header ? 'PLAYER' : player}
        </Text>
      ) : (
        <Text variant={variant} style={[styles.number, styles.fill, color()]}>
          {header ? 'MOVES' : moves}
        </Text>
      )}
      <Text variant={variant} style={[styles.date, color()]} numberOfLines={1}>
        {header ? 'DATE' : date}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  date: {
    minWidth: 56,
    textAlign: 'right'
  },
  // Moves takes the room a name would have, right-aligned like the other numbers.
  fill: {
    flex: 1
  },
  footnote: {
    marginTop: 4
  },
  number: {
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
    width: 52
  },
  player: {
    flex: 1,
    marginLeft: 8
  },
  rank: {
    fontVariant: ['tabular-nums'],
    width: 20
  },
  row: {
    alignItems: 'baseline',
    flexDirection: 'row',
    gap: 8
  }
})
