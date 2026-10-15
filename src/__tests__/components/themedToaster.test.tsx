import { Toast, Toaster, type ToasterProps } from '@rific/toaster'
import { OverlayCard } from '@tastic/hud'
import { render, screen } from '@testing-library/react-native'
import { Text } from 'react-native'
import { Provider as PaperProvider } from 'react-native-paper'

import { ThemedToaster, TOAST_LEVEL_ICONS, TOAST_MAX_WIDTH, TOAST_TOP, toastStackFrame } from '@/components/ThemedToaster'
import { showNoHintToast } from '@/games/shared/gameToasts'

jest.mock('@/components/useFontsPreload', () => ({ CARD_FONT_FAMILY: 'TestSerif' }))

// The toaster itself is stood in for: what's pinned here is what ThemedToaster hands it (the toaster's own stacking, swiping and timing are
// @rific/toaster's tests).
jest.mock('@rific/toaster', () => ({ ...jest.requireActual('@rific/toaster'), Toaster: jest.fn(() => null) }))

// The real card, wrapped so a test can see the toast was drawn on it. A Proxy, not a spread: hud and @tastic/profile import each other, so the
// module is still half-loaded when this factory runs, and every export has to be read lazily.
jest.mock('@tastic/hud', () => {
  const actual = jest.requireActual('@tastic/hud')
  const OverlayCard = jest.fn((props: object) => actual.OverlayCard(props))
  return new Proxy(actual, { get: (target, key) => (key === 'OverlayCard' ? OverlayCard : target[key]) })
})

// Jay, 2026-10-15: the toast sat on the footer, so "No helpful moves right now." covered Undo, the button the player wanted next. It now sits in
// the top band between the corner buttons, where a game's title is, on the dialogs' own card.
describe('toastStackFrame', () => {
  it("sits between the corner buttons on a phone, on their line, like a game's title", () => {
    expect(toastStackFrame(402, { left: 0, right: 0 })).toEqual({ left: 60, right: 60, marginTop: TOAST_TOP })
  })

  it("clears each side's own inset (a phone held sideways), centred between them and capped at the dialogs' card width", () => {
    const frame = toastStackFrame(874, { left: 62, right: 34 })
    expect(874 - frame.left - frame.right).toBe(TOAST_MAX_WIDTH)
    // Centred between 122 (60 + 62) and 780 (874 - 60 - 34).
    expect(frame.left - 122).toBe(780 - (874 - frame.right))
  })

  it('never goes negative in a frame too narrow for it', () => {
    const frame = toastStackFrame(100, { left: 0, right: 0 })
    expect(100 - frame.left - frame.right).toBe(0)
  })
})

describe('ThemedToaster', () => {
  async function toasterProps(): Promise<ToasterProps> {
    await render(
      <PaperProvider>
        <ThemedToaster />
      </PaperProvider>
    )
    return (Toaster as unknown as jest.Mock).mock.lastCall![0]
  }

  it('stacks from the top, in the band between the corner buttons, with no history or clear chips', async () => {
    const props = await toasterProps()
    expect(props.position).toBe('top')
    expect(props.wrapperStyle).toEqual(expect.objectContaining({ marginTop: TOAST_TOP }))
    expect(props.clearButton).toBeNull()
    expect(props.historyButton).toBeNull()
  })

  it("draws each toast on the dialogs' own card (OverlayCard), as a 40pt pill", async () => {
    const { Card, toastStyle } = await toasterProps()
    expect(toastStyle).toMatchObject({ borderRadius: 20, marginHorizontal: 0, minHeight: 40 })

    await render(
      <PaperProvider>
        {Card ? (
          <Card style={toastStyle} toast={new Toast({ title: 'Saved' })}>
            <Text>Saved</Text>
          </Card>
        ) : null}
      </PaperProvider>
    )
    expect(screen.getByText('Saved')).toBeTruthy()
    expect((OverlayCard as unknown as jest.Mock).mock.lastCall![0].style).toBe(toastStyle)
  })

  it('gives every level an outline icon, the set the dialog headers use', async () => {
    const props = await toasterProps()
    expect(props.levelIcons).toBe(TOAST_LEVEL_ICONS)
    expect(TOAST_LEVEL_ICONS).toEqual({ error: 'alert-circle-outline', info: 'information-outline', success: 'check-circle-outline', warning: 'alert-outline' })
    expect(props.Icon).toBeDefined()
  })
})

describe('showNoHintToast', () => {
  it("shows the no-hint copy with the Hint button's light bulb, switched off", () => {
    const info = jest.fn()
    showNoHintToast(info)
    expect(info).toHaveBeenCalledWith('No helpful moves right now.', undefined, undefined, { icon: 'lightbulb-off-outline' })
  })
})
