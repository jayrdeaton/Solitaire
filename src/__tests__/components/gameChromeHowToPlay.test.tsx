import { render } from '@testing-library/react-native'
import { Provider as PaperProvider } from 'react-native-paper'

import { GameChrome } from '@/components/GameChrome'

// A game's Settings dialog never offers the "How to Play" row: the score counts elapsed seconds, so a
// guide opened mid-deal would cost the player score. Only Home passes SettingsDialog's showHowToPlay
// (see settingsHowToPlay.test.tsx for what the prop does, homeGuide.test.tsx for Home's side).

const mockSettingsDialog = jest.fn((_props: { visible: boolean; showHowToPlay?: boolean }) => null)

jest.mock('@/components/SettingsDialog', () => ({ SettingsDialog: (props: { visible: boolean; showHowToPlay?: boolean }) => mockSettingsDialog(props) }))
jest.mock('@/hooks/useSettings', () => ({ useSettings: () => ({ settings: { ...jest.requireActual('@/redux/settingsSlice').DEFAULT_SETTINGS }, setSettings: jest.fn() }) }))
jest.mock('@/components/RulesDialog', () => ({ RulesDialog: () => null }))
jest.mock('@/components/useFontsPreload', () => ({ CARD_FONT_FAMILY: 'TestSerif' }))
jest.mock('@/stores/lastActiveGame', () => ({ useLastActiveGame: () => ({ clearLastActiveGame: jest.fn(), setLastActiveGame: jest.fn(), consumeResumeGame: () => null }) }))

describe('GameChrome: no How to Play row in a game', () => {
  it('renders its Settings dialog without showHowToPlay', async () => {
    await render(
      <PaperProvider>
        <GameChrome title='Klondike' onNewGame={jest.fn()} onUndo={jest.fn()} undoDisabled onHint={jest.fn()} autoHintKey={null} hintShowing={false} won={false} hasProgress={false} getElapsedSeconds={() => 0} clockRunning={false} movesCount={0} rules={[]}>
          {null}
        </GameChrome>
      </PaperProvider>
    )

    expect(mockSettingsDialog).toHaveBeenCalled()
    for (const [props] of mockSettingsDialog.mock.calls) {
      expect(props.showHowToPlay).toBeFalsy()
    }
  })
})
