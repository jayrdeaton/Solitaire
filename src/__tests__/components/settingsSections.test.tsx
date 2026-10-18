import { fireEvent, render, screen } from '@testing-library/react-native'
import { type ReactNode } from 'react'

import { SettingsDialog } from '@/components/SettingsDialog'

// Solitaire's own Settings rows (Jay, 2026-10-15): two labeled sections like hud's APPEARANCE, so no
// bare gap follows the Blur row, and Auto Hint's choice is the row's caption like every other row's.

const mockSetSettings = jest.fn()
let mockAutoHintSeconds = 0

jest.mock('@/hooks/useSettings', () => {
  const { DEFAULT_SETTINGS } = jest.requireActual('@/redux/settingsSlice')
  return { useSettings: () => ({ settings: { ...DEFAULT_SETTINGS, autoHintSeconds: mockAutoHintSeconds }, setSettings: mockSetSettings }) }
})
jest.mock('@tastic/hud/chrome', () => ({
  ...jest.requireActual('@tastic/hud/chrome'),
  BaseSettingsDialog: ({ children }: { children?: ReactNode }) => children
}))
jest.mock('@tastic/hud/guide', () => ({ ...jest.requireActual('@tastic/hud/guide'), useGuide: () => ({ isOpen: false, open: jest.fn(), close: jest.fn(), requestAutoShow: jest.fn() }) }))
jest.mock('@rific/toaster', () => ({ ...jest.requireActual('@rific/toaster'), useToast: () => ({ error: jest.fn(), info: jest.fn(), success: jest.fn() }) }))
jest.mock('@/components/theme', () => {
  const actual = jest.requireActual('@/components/theme')
  return { ...actual, useTableColors: () => actual.lightColors }
})
jest.mock('@/components/useFontsPreload', () => ({ CARD_FONT_FAMILY: 'TestSerif' }))
// The Monogram back's preview shows the selected player's tag; a guest has none.
jest.mock('@/stores/profiles', () => ({ useProfiles: () => ({ activeProfile: null }) }))

beforeEach(() => {
  mockSetSettings.mockClear()
  mockAutoHintSeconds = 0
})

async function renderDialog() {
  await render(<SettingsDialog visible onDismiss={jest.fn()} rotation={0} />)
}

describe("SettingsDialog's own sections", () => {
  it('labels the gameplay rows and the card rows', async () => {
    await renderDialog()

    expect(screen.getByText('GAMEPLAY')).toBeTruthy()
    expect(screen.getByText('CARDS')).toBeTruthy()
  })

  it("shows Auto Hint's choice as the row's caption, and steps to the next one on a tap", async () => {
    await renderDialog()
    expect(screen.getByText('Off')).toBeTruthy()

    await fireEvent.press(screen.getByText('Auto Hint'))
    expect(mockSetSettings).toHaveBeenCalledWith({ autoHintSeconds: 15 })
  })

  it('spells the wait out in the caption', async () => {
    mockAutoHintSeconds = 30
    await renderDialog()

    expect(screen.getByText('After 30 seconds')).toBeTruthy()
  })
})
