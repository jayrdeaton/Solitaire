import { render, screen } from '@testing-library/react-native'
import { Provider as PaperProvider } from 'react-native-paper'

import { parMedal } from '@/engine/par'
import { WinBanner } from '@/games/shared/WinBanner'

jest.mock('@/components/useFontsPreload', () => ({ CARD_FONT_FAMILY: 'TestSerif' }))

// The win dialog shows each number over its par (engine/par.ts), and says how the score compares.

const par = { moves: 125, seconds: 220, score: 345 }

async function show(moves: number, seconds: number) {
  await render(
    <PaperProvider>
      <WinBanner moves={moves} elapsedSeconds={seconds} score={moves + seconds} par={par} onNewGame={jest.fn()} />
    </PaperProvider>
  )
}

describe('WinBanner', () => {
  it('shows the par under each number', async () => {
    await show(110, 166)
    expect(screen.getByText('Par 125')).toBeTruthy()
    expect(screen.getByText('Par 345')).toBeTruthy()
    expect(screen.getByText('Par 3:40')).toBeTruthy()
  })

  it('says how far under or over par the score is', async () => {
    await show(110, 166) // 276 against 345
    expect(screen.getByText('Score 20% under par')).toBeTruthy()
  })

  it('says at par when the score rounds to it', async () => {
    await show(125, 220)
    expect(screen.getByText('Score at par')).toBeTruthy()
  })

  it('says over par for a slow win', async () => {
    await show(150, 400) // 550 against 345
    expect(screen.getByText('Score 59% over par')).toBeTruthy()
  })
})

describe('parMedal', () => {
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

  it('gold from 35% under par', async () => {
    await show(80, 140) // 220 against 345: 36% under
    expect(screen.getByTestId('medal-header-gold')).toBeTruthy()
  })

  it('reads as one header, "You Won!"', async () => {
    await show(110, 166)
    expect(screen.getByRole('header', { name: 'You Won!' })).toBeTruthy()
  })
})
