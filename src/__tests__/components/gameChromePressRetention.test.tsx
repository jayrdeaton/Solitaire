import { render, screen } from '@testing-library/react-native'
import { View } from 'react-native'
import { Provider as PaperProvider } from 'react-native-paper'

import { GameChrome } from '@/components/GameChrome'

// With Reanimated's IOS_SYNCHRONOUSLY_UPDATE_UI_PROPS on (package.json), `measure`, which RN's Pressable reads when a
// press begins, can put the scoreboard where it was before its 57pt drop for over a second, and the footer 24pt low
// after it comes back (measured on the Simulator); a press that then moved a little was dropped, so "Show controls"
// right after hiding them could do nothing. RN keeps a press within 20pt of its button (30 below): GameChrome widens
// each side a slide can lag on by the slide.

jest.mock('@/components/SettingsDialog', () => ({ SettingsDialog: () => null }))
jest.mock('@/components/RulesDialog', () => ({ RulesDialog: () => null }))
jest.mock('@/hooks/useSettings', () => ({ useSettings: () => ({ settings: { ...jest.requireActual('@/redux/settingsSlice').DEFAULT_SETTINGS }, setSettings: jest.fn() }) }))
jest.mock('@/components/useFontsPreload', () => ({ CARD_FONT_FAMILY: 'TestSerif' }))
jest.mock('@/stores/lastActiveGame', () => ({ useLastActiveGame: () => ({ clearLastActiveGame: jest.fn(), setLastActiveGame: jest.fn(), consumeResumeGame: () => null }) }))
// RN's Pressable keeps pressRetentionOffset to itself; this copy also hands it to its view, where a test can read it.
jest.mock('react-native/Libraries/Components/Pressable/Pressable', () => {
  const React = jest.requireActual('react')
  const Real = jest.requireActual('react-native/Libraries/Components/Pressable/Pressable').default
  const Exposed = React.forwardRef(function ExposedPressable(props: { pressRetentionOffset?: unknown }, ref: unknown) {
    return React.createElement(Real, { ...props, ref, testOnlyPressRetention: props.pressRetentionOffset })
  })
  return { __esModule: true, default: Exposed }
})

it('the scoreboard and footer keep a press that moves while their slide has not reached measure() yet', async () => {
  await render(
    <PaperProvider>
      <GameChrome title='Yukon' onNewGame={jest.fn()} onUndo={jest.fn()} undoDisabled onHint={jest.fn()} autoHintKey={null} hintShowing={false} won={false} winRevealed={false} hasProgress={false} getElapsedSeconds={() => 0} pauseClock={jest.fn()} par={{ moves: 100, seconds: 200, score: 300 }} clockRunning={false} movesCount={0} rules={[]}>
        <View />
      </GameChrome>
    </PaperProvider>
  )
  const retention = (label: string) => screen.getByLabelText(label).props.testOnlyPressRetention
  expect(retention('Hide controls')).toEqual({ top: 20 + 57, bottom: 30 + 57 })
  for (const label of ['New Game', 'Undo', 'Hint']) expect(retention(label)).toEqual({ top: 20 + 24 })
})
