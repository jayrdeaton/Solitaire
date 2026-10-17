import { DialogHeader } from '@tastic/hud'
import { fireEvent, render, screen, within } from '@testing-library/react-native'
import { BackHandler } from 'react-native'
import { Provider as PaperProvider } from 'react-native-paper'

import { RulesDialog } from '@/components/RulesDialog'
import { LossBanner } from '@/games/shared/LossBanner'
import { WinBanner } from '@/games/shared/WinBanner'

jest.mock('@/components/useFontsPreload', () => ({ CARD_FONT_FAMILY: 'TestSerif' }))

// The real header, wrapped so a test can read what each dialog handed it. A Proxy, not a spread:
// hud and @tastic/profile import each other, so the module is still half-loaded when this factory
// runs, and every export has to be read lazily.
jest.mock('@tastic/hud', () => {
  const actual = jest.requireActual('@tastic/hud')
  const DialogHeader = jest.fn((props: object) => actual.DialogHeader(props))
  return new Proxy(actual, { get: (target, key) => (key === 'DialogHeader' ? DialogHeader : target[key]) })
})

// Jay, 2026-10-15: "I value consistency above all else." Every dialog opens with @tastic/hud's
// DialogHeader (icon + title in the theme's primary, the same compact rule) and ends in the shared
// action row, on the same untinted card. These pin Solitaire's own three dialogs to it; hud's tests
// pin ConfirmDialog, the How to Play guide and the Settings sheet.

function lastHeaderProps() {
  return (DialogHeader as unknown as jest.Mock).mock.lastCall![0]
}

async function show(node: React.ReactNode) {
  await render(<PaperProvider>{node}</PaperProvider>)
}

describe('RulesDialog', () => {
  const rules = ['Build the foundations up by suit.', 'Move any King to an empty column.']

  it('renders nothing while closed', async () => {
    await show(<RulesDialog visible={false} onDismiss={jest.fn()} title='Klondike' rules={rules} />)
    expect(screen.queryByText('Klondike')).toBeNull()
  })

  it("opens with the fleet's header: the info icon (the button that opens it) and the game's name", async () => {
    await show(<RulesDialog visible onDismiss={jest.fn()} title='Klondike' rules={rules} />)

    expect(lastHeaderProps()).toEqual(expect.objectContaining({ icon: 'information-outline', title: 'Klondike', compact: false }))
    expect(lastHeaderProps().color).toBeUndefined()
    expect(screen.getByText('Build the foundations up by suit.')).toBeTruthy()
  })

  it('closes with a single Done button like every other one-button dialog', async () => {
    const onDismiss = jest.fn()
    await show(<RulesDialog visible onDismiss={onDismiss} title='Klondike' rules={rules} />)

    expect(screen.queryByText('Got it')).toBeNull()
    await fireEvent.press(screen.getByText('Done'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  // Jay, 2026-10-15: the header scrolls away with the rules so a long list gets the whole card, and
  // Done stays pinned below the scroll area.
  it('scrolls the header away with the rules, and keeps Done outside the scroll area', async () => {
    await show(<RulesDialog visible onDismiss={jest.fn()} title='Klondike' rules={rules} />)

    const scroll = within(screen.getByTestId('rules-scroll'))
    expect(scroll.getByText('Klondike')).toBeTruthy()
    expect(scroll.getByText('Build the foundations up by suit.')).toBeTruthy()
    expect(scroll.queryByText('Done')).toBeNull()
    expect(screen.getByText('Done')).toBeTruthy()
  })

  it('like the Settings sheet, a tap outside the card or Android back closes it', async () => {
    const remove = jest.fn()
    const addListener = jest.spyOn(BackHandler, 'addEventListener').mockImplementation(() => ({ remove }))
    const onDismiss = jest.fn()
    await show(<RulesDialog visible onDismiss={onDismiss} title='Klondike' rules={rules} />)

    // The backdrop sits beside a card marked modal for screen readers, so queries see it as hidden.
    await fireEvent.press(screen.getByLabelText('Close rules', { includeHiddenElements: true }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
    const handler = addListener.mock.calls.find(([event]) => event === 'hardwareBackPress')![1]
    expect((handler as () => boolean)()).toBe(true)
    expect(onDismiss).toHaveBeenCalledTimes(2)
    addListener.mockRestore()
  })
})

describe('the win and loss cards', () => {
  it("WinBanner opens with the fleet's header layout, the trophy over the title, in the metal of the medal the score earned (its one deliberate look of its own)", async () => {
    await show(<WinBanner moves={110} elapsedSeconds={166} score={276} par={{ moves: 125, seconds: 220, score: 345 }} onNewGame={jest.fn()} />)

    // MedalHeader: DialogHeader's own layout, drawn itself because DialogHeader takes one flat color (20% under par: silver).
    expect(screen.getByTestId('medal-header-silver')).toBeTruthy()
    expect(screen.getByRole('header', { name: 'You Won!' })).toBeTruthy()
  })

  it("LossBanner opens with the same header, in the theme's primary too (not a muted one of its own)", async () => {
    await show(<LossBanner onNewGame={jest.fn()} onUndo={jest.fn()} />)

    expect(lastHeaderProps()).toEqual(expect.objectContaining({ icon: 'cards-outline', title: 'No Moves Left', compact: false }))
    expect(lastHeaderProps().color).toBeUndefined()
  })
})
