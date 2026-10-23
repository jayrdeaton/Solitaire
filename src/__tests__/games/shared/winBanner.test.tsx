import { render, screen } from '@testing-library/react-native'
import { Provider as PaperProvider } from 'react-native-paper'

import { parMedal, PlayerPar, playerParFor, playerParMedal, RecentWin, vsParShort } from '@/engine/par'
import { addTopWin, type TopWins, type WinsBefore } from '@/engine/topWins'
import type { VariantId } from '@/engine/variants'
import { WinBanner } from '@/games/shared/WinBanner'

jest.mock('@/components/useFontsPreload', () => ({ CARD_FONT_FAMILY: 'TestSerif' }))

// The par the latest win was measured against (useGameStats' lastWin), set per test.
let mockLastWin: { variant: VariantId; par: PlayerPar; before?: WinsBefore } | null = null
jest.mock('@/stores/gameStats', () => ({ useGameStats: () => ({ lastWin: mockLastWin }) }))

// The win dialog shows each number over the player's par (engine/par.ts' playerParFor), and says how the score compares.
// Klondike's expert par: 125 moves, 3:40, 345.

const rankLines = () => screen.queryAllByTestId('win-rank').map((line) => line.props.children as string)
const win = (moves: number, seconds: number): RecentWin => ({ moves, seconds, score: moves + seconds })

async function show(moves: number, seconds: number) {
  await render(
    <PaperProvider>
      <WinBanner moves={moves} elapsedSeconds={seconds} score={moves + seconds} variant='klondike' onNewGame={jest.fn()} />
    </PaperProvider>
  )
}

beforeEach(() => {
  mockLastWin = null
})

describe('WinBanner - before a first win, expert par', () => {
  it('shows the par under each number', async () => {
    await show(110, 166)
    expect(screen.getByText('Par 125')).toBeTruthy()
    expect(screen.getByText('Par 345')).toBeTruthy()
    expect(screen.getByText('Par 3:40')).toBeTruthy()
  })

  it('says how far under or over expert par the score is', async () => {
    await show(110, 166) // 276 against 345
    expect(screen.getByText('Score 20% under expert par')).toBeTruthy()
  })

  it('says at par when the score rounds to it', async () => {
    await show(125, 220)
    expect(screen.getByText('Score at expert par')).toBeTruthy()
  })

  it('says over par for a slow win', async () => {
    await show(150, 400) // 550 against 345
    expect(screen.getByText('Score 59% over expert par')).toBeTruthy()
  })

  it("ignores a par taken for another variant's win", async () => {
    mockLastWin = { variant: 'freecell', par: playerParFor('freecell', [win(100, 400)]) }
    await show(110, 166)
    expect(screen.getByText('Par 345')).toBeTruthy()
  })
})

describe('WinBanner - the rank line', () => {
  // The player's earlier Klondike wins, all on the boards: scores 360, 390, 420 and times 4:00, 4:10, 4:20.
  const earlier = [win(120, 240), win(140, 250), win(160, 260)]
  const boards = earlier.reduce<TopWins | undefined>((top, w) => addTopWin(top, { ...w, at: null }), undefined)
  const withBoards = (before: Partial<WinsBefore> = {}) => {
    mockLastWin = { variant: 'klondike', par: playerParFor('klondike', earlier), before: { top: boards, wins: 3, bestScore: 360, bestSeconds: 240, ...before } }
  }

  it("says where the win places among the player's own on each board", async () => {
    withBoards()
    await show(100, 245) // 345, the best score; 4:05, the 2nd fastest
    expect(rankLines()).toEqual(['Best score ever', '2nd fastest ever'])
  })

  it('ranks each board on its own', async () => {
    withBoards()
    await show(170, 230) // 400 is 3rd of four scores... but 3:50 is the fastest
    expect(rankLines()).toEqual(['3rd best score ever', 'Fastest ever'])
  })

  it('says nothing when the win is the worst so far on both boards', async () => {
    withBoards()
    await show(200, 300)
    expect(rankLines()).toEqual([])
  })

  it('says nothing for a first win, or before any win was ranked this session', async () => {
    mockLastWin = { variant: 'klondike', par: playerParFor('klondike', []), before: { top: undefined, wins: 0, bestScore: null, bestSeconds: null } }
    await show(100, 200)
    expect(rankLines()).toEqual([])
  })

  it("ignores another variant's win", async () => {
    withBoards()
    mockLastWin = { ...mockLastWin!, variant: 'freecell' }
    await show(100, 200)
    expect(rankLines()).toEqual([])
  })

  it('claims only the best ever when some earlier wins were never kept', async () => {
    withBoards({ wins: 8, bestScore: 330, bestSeconds: 200 })
    await show(100, 245) // best on the boards, but the stats know a 330 and a 3:20
    expect(rankLines()).toEqual([])
    await show(90, 190) // 280 and 3:10 beat them all
    expect(rankLines()).toEqual(['Best score ever', 'Fastest ever'])
  })
})

describe('WinBanner - your par', () => {
  // Medians of these: 140 moves, 4:30, 410.
  const recent = [win(130, 260), win(140, 270), win(150, 280)]

  it('shows the medians of your recent wins under each number', async () => {
    mockLastWin = { variant: 'klondike', par: playerParFor('klondike', recent) }
    await show(120, 250)
    expect(screen.getByText('Par 140')).toBeTruthy()
    expect(screen.getByText('Par 410')).toBeTruthy()
    expect(screen.getByText('Par 4:30')).toBeTruthy()
  })

  it('says how the score compares with your par', async () => {
    mockLastWin = { variant: 'klondike', par: playerParFor('klondike', recent) }
    await show(120, 250) // 370 against 410
    expect(screen.getByText('Score 10% under your par')).toBeTruthy()
  })

  it('gives silver for beating a par that is over expert par', async () => {
    mockLastWin = { variant: 'klondike', par: playerParFor('klondike', recent) }
    await show(130, 270) // 400: over expert par (345), under yours (410)
    expect(screen.getByTestId('medal-header-silver')).toBeTruthy()
  })

  it('gives bronze for a win over your par, however it does against expert par', async () => {
    mockLastWin = { variant: 'klondike', par: playerParFor('klondike', [win(80, 120), win(90, 130), win(100, 140)]) }
    await show(110, 166) // 276: 20% under expert par, over yours (220)
    expect(screen.getByTestId('medal-header-bronze')).toBeTruthy()
  })

  it('gives gold for a win in your best fifth', async () => {
    // Ten wins from 400 to 490: the best fifth is the best two, so 410 or less is gold.
    const ten = Array.from({ length: 10 }, (_, i) => win(100, 300 + i * 10))
    mockLastWin = { variant: 'klondike', par: playerParFor('klondike', ten) }
    await show(100, 310) // 410
    expect(screen.getByTestId('medal-header-gold')).toBeTruthy()
  })
})

describe('playerParFor', () => {
  it('is expert par before a first win', () => {
    expect(playerParFor('klondike', [])).toEqual({ kind: 'expert', moves: 125, seconds: 220, score: 345, goldScore: null })
  })

  it('takes each number as its own median', () => {
    // An even count takes the mean of the middle two, rounded.
    expect(playerParFor('klondike', [win(100, 300), win(120, 200), win(130, 251), win(90, 400)])).toMatchObject({ kind: 'personal', moves: 110, seconds: 276, score: 391 })
  })

  it('only counts the last 20 wins', () => {
    const old = Array.from({ length: 20 }, () => win(500, 500))
    const latest = Array.from({ length: 20 }, () => win(100, 200))
    expect(playerParFor('klondike', [...old, ...latest]).score).toBe(300)
  })

  it('has no gold before five wins, since a fifth of fewer is nobody', () => {
    expect(playerParFor('klondike', [win(100, 200), win(100, 210), win(100, 220), win(100, 230)]).goldScore).toBeNull()
  })

  it("puts gold at the best fifth's last score", () => {
    // 5 wins: the best one. 20 wins: the 4th best, so at most 3 of the 20 beat a gold win.
    const scores = (n: number) => Array.from({ length: n }, (_, i) => win(100, 200 + i * 10)).reverse()
    expect(playerParFor('klondike', scores(5)).goldScore).toBe(300)
    expect(playerParFor('klondike', scores(20)).goldScore).toBe(330)
  })

  it("makes about half of a steady player's wins silver and about 1 in 5 gold", () => {
    // A player whose scores are spread evenly: each next win is judged against the 20 before it, then joins them.
    let seed = 7
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    const history: RecentWin[] = Array.from({ length: 20 }, () => win(120, Math.round(200 + random() * 200)))
    const medals = { bronze: 0, silver: 0, gold: 0 }
    for (let i = 0; i < 2000; i++) {
      const next = win(120, Math.round(200 + random() * 200))
      medals[playerParMedal(next.score, playerParFor('klondike', history))] += 1
      history.push(next)
    }
    expect(medals.gold / 2000).toBeGreaterThan(0.15)
    expect(medals.gold / 2000).toBeLessThan(0.25)
    expect((medals.gold + medals.silver) / 2000).toBeGreaterThan(0.45)
    expect((medals.gold + medals.silver) / 2000).toBeLessThan(0.55)
  })
})

describe('parMedal (expert par)', () => {
  it('gives bronze at par or over: every win earns a medal', () => {
    expect(parMedal(345, 345)).toBe('bronze')
    expect(parMedal(347, 345)).toBe('bronze') // rounds to "at par"
    expect(parMedal(550, 345)).toBe('bronze')
  })

  it('gives silver for any amount under par, up to gold', () => {
    expect(parMedal(340, 345)).toBe('silver') // "1% under par"
    expect(parMedal(276, 345)).toBe('silver') // 20% under
    expect(parMedal(228, 345)).toBe('silver') // 34% under
  })

  it('gives gold from 35% under par, the gold line of the Low Score achievement', () => {
    expect(parMedal(224, 345)).toBe('gold') // 35% under
    expect(parMedal(100, 345)).toBe('gold')
  })
})

describe('WinBanner - the medal', () => {
  // Its trophy and title in the metal of the medal the score earned (MedalHeader), and still one header to a screen reader.
  it('bronze over par', async () => {
    await show(150, 400) // 59% over par
    expect(screen.getByTestId('medal-header-bronze')).toBeTruthy()
  })

  it('silver just under par', async () => {
    await show(110, 166) // 20% under
    expect(screen.getByTestId('medal-header-silver')).toBeTruthy()
  })

  it('gold from 35% under expert par', async () => {
    await show(80, 140) // 220 against 345: 36% under
    expect(screen.getByTestId('medal-header-gold')).toBeTruthy()
  })

  it('reads as one header, "You Won!"', async () => {
    await show(110, 166)
    expect(screen.getByRole('header', { name: 'You Won!' })).toBeTruthy()
  })
})

describe('vsParShort', () => {
  it("says how a number compares with its par in a word, rounded like the win card's line", () => {
    expect(vsParShort(276, 345)).toBe('20% under')
    expect(vsParShort(345, 345)).toBe('even')
    // Within half a percent rounds to even, as "at par" does.
    expect(vsParShort(346, 345)).toBe('even')
    expect(vsParShort(549, 345)).toBe('59% over')
  })
})
