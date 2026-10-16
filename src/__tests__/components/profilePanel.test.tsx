import type { PopoverHost } from '@tastic/hud'
import type { Profile, ProfilePickerColorSection } from '@tastic/profile'
import { render } from '@testing-library/react-native'

import { ProfilePanel } from '@/components/ProfilePanel'
import { useProfilePickerAlign } from '@/components/useProfilePickerAlign'

// Home's player button: the picker itself is @tastic/profile's (tested there), so this pins only what the panel
// hands it.
const mockPicker = jest.fn((_props: { colorSection: ProfilePickerColorSection }) => null)
jest.mock('@tastic/profile', () => ({ ProfilePicker: (props: { colorSection: ProfilePickerColorSection }) => mockPicker(props) }))
jest.mock('@/components/useProfilePickerAlign', () => ({ useProfilePickerAlign: jest.fn(() => ({ align: 'center', verticalAlign: 'below', maxHeight: 400, measured: true, triggerRef: { current: null } })) }))
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }))

const kid: Profile = { id: 'kid', name: 'Kid', color: '#e91e63', tag: 'K', createdAt: 1, updatedAt: 1 }
let mockActive: Profile | null = null
const mockSetColor = jest.fn()
jest.mock('@/stores/profiles', () => ({
  useProfiles: () => ({ profiles: [kid], activeProfileId: mockActive?.id ?? null, activeProfile: mockActive, selectProfile: jest.fn(), tableColorOverride: '#009688', setTableColorOverride: mockSetColor })
}))

const host: PopoverHost = { openId: null, toggle: jest.fn(), close: jest.fn() }
const colorSection = () => mockPicker.mock.calls[mockPicker.mock.calls.length - 1][0].colorSection

describe('ProfilePanel', () => {
  beforeEach(() => jest.clearAllMocks())

  it("captions the color 'Solitaire only' for a profile, and commits a pick through the profiles store", async () => {
    mockActive = kid
    await render(<ProfilePanel host={host} />)

    expect(colorSection()).toMatchObject({ label: 'Color', caption: 'Solitaire only', value: '#009688' })
    colorSection().onChange('#3f51b5')
    expect(mockSetColor).toHaveBeenCalledWith('#3f51b5')
  })

  it('leaves the caption out for Guest, who has no color in the other games', async () => {
    mockActive = null
    await render(<ProfilePanel host={host} />)

    expect(colorSection().caption).toBeUndefined()
  })

  it('sizes the placement from the same color section the picker draws', async () => {
    mockActive = kid
    await render(<ProfilePanel host={host} />)

    expect(useProfilePickerAlign).toHaveBeenLastCalledWith(false, 1, true, colorSection())
  })
})
