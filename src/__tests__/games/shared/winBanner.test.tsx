import { render, screen } from '@testing-library/react-native'
import { Provider as PaperProvider } from 'react-native-paper'

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
    expect(screen.getByText('20% under par. Lower is better.')).toBeTruthy()
  })

  it('says at par when the score rounds to it', async () => {
    await show(125, 220)
    expect(screen.getByText('At par. Lower is better.')).toBeTruthy()
  })

  it('says over par for a slow win', async () => {
    await show(150, 400) // 550 against 345
    expect(screen.getByText('59% over par. Lower is better.')).toBeTruthy()
  })
})
