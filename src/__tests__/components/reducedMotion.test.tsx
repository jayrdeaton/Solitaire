import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { type ReactNode } from 'react'
import { AccessibilityInfo, Text } from 'react-native'

import { FLIGHT_SPRING, SPRING_START_LAG_MS, springSettleMs } from '@/components/dragdrop/dragSpring'
import { isMotionReduced, ReducedMotionBridge, useMotionReduced } from '@/components/reducedMotion'
import { setMotionReduced } from '@/components/reducedMotionFlag'
import { SettingsDialog } from '@/components/SettingsDialog'

// Reduce Motion is on when the Settings row is OR the device's setting is, live (reducedMotion.tsx), so the App Store's
// Reduced Motion accessibility claim holds: a player who turned it on in iOS Settings gets no card flights.

// The device setting: AccessibilityInfo's first answer, then whatever its reduceMotionChanged listener is told.
const mockSystemInitial = false
const systemListeners: ((enabled: boolean) => void)[] = []
jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockImplementation(() => Promise.resolve(mockSystemInitial))
jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(((event: string, listener: (enabled: boolean) => void) => {
  if (event === 'reduceMotionChanged') systemListeners.push(listener)
  return { remove: jest.fn() }
}) as unknown as typeof AccessibilityInfo.addEventListener)

const mockSetSettings = jest.fn()
let mockRowOn = false
jest.mock('@/hooks/useSettings', () => {
  const { DEFAULT_SETTINGS } = jest.requireActual('@/redux/settingsSlice')
  return { useSettings: () => ({ settings: { ...DEFAULT_SETTINGS, reduceMotion: mockRowOn }, setSettings: mockSetSettings }) }
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
jest.mock('@/stores/profiles', () => ({ useProfiles: () => ({ activeProfile: null }) }))

function Probe() {
  return <Text testID='reduced'>{String(useMotionReduced())}</Text>
}

async function setSystem(enabled: boolean) {
  await act(async () => {
    systemListeners.forEach((listener) => listener(enabled))
  })
}

beforeEach(async () => {
  mockRowOn = false
  mockSetSettings.mockClear()
  setMotionReduced(false)
  // Back to off for the next test (the device setting is one module-level value, shared by every reader).
  await setSystem(false)
})

describe('Reduce Motion: the Settings row or the device setting', () => {
  it('is off with both off', async () => {
    await render(<Probe />)
    expect(screen.getByTestId('reduced')).toHaveTextContent('false')
  })

  it('is on with the Settings row on', async () => {
    mockRowOn = true
    await render(<Probe />)
    expect(screen.getByTestId('reduced')).toHaveTextContent('true')
  })

  it('follows the device setting live, both ways', async () => {
    await render(<Probe />)
    await setSystem(true)
    expect(screen.getByTestId('reduced')).toHaveTextContent('true')
    await setSystem(false)
    expect(screen.getByTestId('reduced')).toHaveTextContent('false')
  })
})

describe('ReducedMotionBridge', () => {
  it('hands the combined flag to the timers outside render', async () => {
    await render(<ReducedMotionBridge />)
    expect(isMotionReduced()).toBe(false)
    await setSystem(true)
    expect(isMotionReduced()).toBe(true)
    await setSystem(false)
    expect(isMotionReduced()).toBe(false)
  })
})

describe('springSettleMs under Reduce Motion', () => {
  it('covers only the UI thread start lag, since the spring lands at once', () => {
    expect(springSettleMs(FLIGHT_SPRING)).toBeGreaterThan(400)
    setMotionReduced(true)
    expect(springSettleMs(FLIGHT_SPRING)).toBe(SPRING_START_LAG_MS)
    expect(springSettleMs({ duration: 0 })).toBe(0)
  })
})

describe("SettingsDialog's Reduce Motion row", () => {
  async function renderDialog() {
    await render(<SettingsDialog visible onDismiss={jest.fn()} rotation={0} />)
  }

  it('toggles the row with the device setting off', async () => {
    await renderDialog()
    expect(screen.queryByText('On in device settings')).toBeNull()
    await fireEvent.press(screen.getByText('Reduce Motion'))
    expect(mockSetSettings).toHaveBeenCalledWith({ reduceMotion: true })
  })

  it('shows on, says why and takes no tap while the device setting is on', async () => {
    await renderDialog()
    await setSystem(true)
    expect(screen.getByText('On in device settings')).toBeTruthy()
    await fireEvent.press(screen.getByText('Reduce Motion'))
    expect(mockSetSettings).not.toHaveBeenCalled()
  })
})
