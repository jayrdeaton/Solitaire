// First, so the @tastic/hud <-> @tastic/profile import cycle starts from profile: the '@tastic/hud' mock
// below spreads the real module, which must not be half-evaluated when profile reaches back into it.
import '@tastic/profile'

import { render } from '@testing-library/react-native'

import { SettingsDialog } from '@/components/SettingsDialog'

// The Settings "How to Play" row (BaseSettingsDialog's onShowHowToPlay) replays the guide. It is
// wired through SettingsDialog's showHowToPlay prop, which only Home turns on (GameChrome never does:
// see gameChromeHowToPlay.test.tsx).

const mockOpenGuide = jest.fn()
const mockBaseSettingsDialog = jest.fn((_props: { onShowHowToPlay?: () => void }) => null)

jest.mock('@/hooks/useSettings', () => {
  const { DEFAULT_SETTINGS } = jest.requireActual('@/redux/settingsSlice')
  return { useSettings: () => ({ settings: { ...DEFAULT_SETTINGS }, setSettings: jest.fn() }) }
})
jest.mock('@tastic/hud', () => ({
  ...jest.requireActual('@tastic/hud'),
  BaseSettingsDialog: (props: { onShowHowToPlay?: () => void }) => mockBaseSettingsDialog(props)
}))
jest.mock('@tastic/hud/guide', () => ({ ...jest.requireActual('@tastic/hud/guide'), useGuide: () => ({ isOpen: false, open: mockOpenGuide, close: jest.fn(), requestAutoShow: jest.fn() }) }))
jest.mock('@rific/toaster', () => ({ ...jest.requireActual('@rific/toaster'), useToast: () => ({ error: jest.fn(), info: jest.fn(), success: jest.fn() }) }))
jest.mock('@/components/theme', () => {
  const actual = jest.requireActual('@/components/theme')
  return { ...actual, useTableColors: () => actual.lightColors }
})
jest.mock('@/components/useFontsPreload', () => ({ CARD_FONT_FAMILY: 'TestSerif' }))
// The Monogram back's preview shows the selected player's tag; a guest has none.
jest.mock('@/stores/profiles', () => ({ useProfiles: () => ({ activeProfile: null }) }))

const lastProps = <T,>(mock: jest.Mock<null, [T]>): T => mock.mock.calls[mock.mock.calls.length - 1][0]

beforeEach(() => {
  mockBaseSettingsDialog.mockClear()
})

describe('SettingsDialog: the How to Play row', () => {
  async function renderDialog(showHowToPlay?: boolean) {
    await render(<SettingsDialog visible onDismiss={jest.fn()} rotation={0} showHowToPlay={showHowToPlay} />)
  }

  it("hands the guide's open() to the row when showHowToPlay is on", async () => {
    await renderDialog(true)
    expect(lastProps(mockBaseSettingsDialog).onShowHowToPlay).toBe(mockOpenGuide)
  })

  it('leaves the row out by default', async () => {
    await renderDialog()
    expect(lastProps(mockBaseSettingsDialog).onShowHowToPlay).toBeUndefined()
  })
})
