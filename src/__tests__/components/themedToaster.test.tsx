import { getTintTextColor } from '@rific/auto-paper'
import { Toast, Toaster, type ToasterProps } from '@rific/toaster'
import { OverlayCard } from '@tastic/hud/chrome'
import { render, screen } from '@testing-library/react-native'
import { StyleSheet, Text } from 'react-native'
import { Icon, Provider as PaperProvider } from 'react-native-paper'

import { ThemedToaster, TOAST_BADGE_SIZE, TOAST_LEVEL_ICONS, TOAST_MAX_WIDTH, TOAST_TOP, toastBadgeInk, toastStackFrame } from '@/components/ThemedToaster'
import { showNoHintToast } from '@/games/shared/gameToasts'

jest.mock('@/components/useFontsPreload', () => ({ CARD_FONT_FAMILY: 'TestSerif' }))

// The toaster itself is stood in for: what's pinned here is what ThemedToaster hands it (the toaster's own stacking, swiping and timing are
// @rific/toaster's tests).
jest.mock('@rific/toaster', () => ({ ...jest.requireActual('@rific/toaster'), Toaster: jest.fn(() => null) }))

// Paper's Icon, wrapped so a test can see what each badge's glyph was drawn with.
jest.mock('react-native-paper', () => {
  const actual = jest.requireActual('react-native-paper')
  return { ...actual, Icon: jest.fn((props: object) => actual.Icon(props)) }
})

// The real card, wrapped so a test can see the toast was drawn on it.
jest.mock('@tastic/hud/chrome', () => {
  const actual = jest.requireActual('@tastic/hud/chrome')
  return { ...actual, OverlayCard: jest.fn((props: object) => actual.OverlayCard(props)) }
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

  // Jay, 2026-10-17: the toasts were "still missing custom colors or icons". A bare 20pt glyph in the dark theme's primary (the muted card back)
  // all but vanished on the dark frosted pill, so each icon is now a filled badge in its level's color with the glyph knocked out of it.
  it("gives every level a bare glyph for its badge (the badge is the circle, so no ringed icons) in the theme's role for it", async () => {
    const props = await toasterProps()
    expect(props.levelIcons).toBe(TOAST_LEVEL_ICONS)
    expect(TOAST_LEVEL_ICONS).toEqual({ error: 'close-thick', info: 'information-variant', success: 'check-bold', warning: 'exclamation-thick' })
    const { colors } = await new Promise<{ colors: Record<string, string> }>((resolve) => {
      const { useAutoPaperTheme } = jest.requireActual('@rific/auto-paper')
      function Read() {
        resolve(useAutoPaperTheme())
        return null
      }
      void render(
        <PaperProvider>
          <Read />
        </PaperProvider>
      )
    })
    expect(props.levelColors).toEqual({ error: colors.danger, info: colors.primary, success: colors.success, warning: colors.warning })
  })

  it("draws the icon as a filled badge in the toast's color, as tall as a one-line pill less its inset, with the glyph in a contrasting ink", async () => {
    const { Icon: ToastIcon } = await toasterProps()
    await render(<PaperProvider>{ToastIcon ? <ToastIcon color='#9d2d53' name='lightbulb-off-outline' size={20} /> : null}</PaperProvider>)
    const glyph = (Icon as unknown as jest.Mock).mock.lastCall![0]
    expect(glyph).toMatchObject({ color: toastBadgeInk('#9d2d53'), source: 'lightbulb-off-outline' })
    expect(toastBadgeInk('#9d2d53')).toBe(getTintTextColor('#9d2d53', '#9d2d53', 1))
    expect(StyleSheet.flatten(screen.getByTestId('toast-badge').props.style)).toMatchObject({ backgroundColor: '#9d2d53', borderRadius: TOAST_BADGE_SIZE / 2, height: TOAST_BADGE_SIZE, width: TOAST_BADGE_SIZE })
  })
})

describe('showNoHintToast', () => {
  it("shows the no-hint copy with the Hint button's light bulb, switched off", () => {
    const info = jest.fn()
    showNoHintToast(info)
    expect(info).toHaveBeenCalledWith('No helpful moves right now.', undefined, undefined, { icon: 'lightbulb-off-outline' })
  })
})
