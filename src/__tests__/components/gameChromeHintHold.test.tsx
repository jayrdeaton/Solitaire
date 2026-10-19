import { FeedbackPressProvider } from '@rific/feedback-press'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { Provider as PaperProvider } from 'react-native-paper'

import { GameChrome } from '@/components/GameChrome'
import { HINT_GLIDE_LANDED_MS } from '@/components/hinting/HintGlideLayer'

// Holding Hint steps through the hints one tap at a time would (see hintHold.test.tsx for the loop itself), and each one
// clicks like a tap does. A footer button's long press adds no feedback of its own: feedback-press's default plays the
// 'notification' one there, which this app maps to the invalid-move sound.

jest.mock('@/components/SettingsDialog', () => ({ SettingsDialog: () => null }))
jest.mock('@/components/RulesDialog', () => ({ RulesDialog: () => null }))
jest.mock('@/hooks/useSettings', () => ({ useSettings: () => ({ settings: { ...jest.requireActual('@/redux/settingsSlice').DEFAULT_SETTINGS }, setSettings: jest.fn() }) }))
jest.mock('@/components/useFontsPreload', () => ({ CARD_FONT_FAMILY: 'TestSerif' }))
jest.mock('@/stores/lastActiveGame', () => ({ useLastActiveGame: () => ({ clearLastActiveGame: jest.fn(), setLastActiveGame: jest.fn(), consumeResumeGame: () => null }) }))

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
}

async function renderChrome(onHint: () => boolean, onUndo = jest.fn()) {
  const click = jest.fn()
  const invalid = jest.fn()
  await render(
    <PaperProvider>
      <FeedbackPressProvider soundInitialValue={{ enabled: true }} sound={{ selection: click, notification: invalid }}>
        <GameChrome title='Klondike' onNewGame={jest.fn()} onUndo={onUndo} undoDisabled={false} onHint={onHint} autoHintKey={null} hintShowing={false} won={false} winRevealed={false} hasProgress={false} getElapsedSeconds={() => 0} pauseClock={jest.fn()} par={{ moves: 100, seconds: 200, score: 300 }} clockRunning={false} movesCount={0} rules={[]}>
          {null}
        </GameChrome>
      </FeedbackPressProvider>
    </PaperProvider>
  )
  return { click, invalid }
}

describe('GameChrome: holding Hint', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('steps to the next hint each time the last one has landed, with a click each, until the finger lifts', async () => {
    const onHint = jest.fn(() => true)
    const { click, invalid } = await renderChrome(onHint)
    const hint = screen.getByLabelText('Hint')

    await act(async () => fireEvent(hint, 'pressIn'))
    expect(click).toHaveBeenCalledTimes(1) // the press's own, at touch-down
    await act(async () => fireEvent(hint, 'longPress'))
    expect(onHint).toHaveBeenCalledTimes(1)
    expect(click).toHaveBeenCalledTimes(2)
    await advance(HINT_GLIDE_LANDED_MS)
    expect(onHint).toHaveBeenCalledTimes(2)
    expect(click).toHaveBeenCalledTimes(3)
    await act(async () => fireEvent(hint, 'pressOut'))
    await advance(5 * HINT_GLIDE_LANDED_MS)
    expect(onHint).toHaveBeenCalledTimes(2)
    expect(invalid).not.toHaveBeenCalled()
  })

  it('stops after one when there is nothing else to show', async () => {
    const onHint = jest.fn(() => false)
    await renderChrome(onHint)

    await act(async () => fireEvent(screen.getByLabelText('Hint'), 'longPress'))
    await advance(5 * HINT_GLIDE_LANDED_MS)
    expect(onHint).toHaveBeenCalledTimes(1)
  })

  it("a tap still shows one hint, and holding Undo doesn't play the invalid-move sound either", async () => {
    const onHint = jest.fn(() => true)
    const onUndo = jest.fn(() => Promise.resolve(false))
    const { invalid } = await renderChrome(onHint, onUndo)

    await act(async () => fireEvent.press(screen.getByLabelText('Hint')))
    expect(onHint).toHaveBeenCalledTimes(1)
    await act(async () => fireEvent(screen.getByLabelText('Undo'), 'longPress'))
    expect(onUndo).toHaveBeenCalled()
    expect(invalid).not.toHaveBeenCalled()
  })
})
