import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { StyleSheet, View } from 'react-native'
import { Provider as PaperProvider } from 'react-native-paper'

import { GameChrome } from '@/components/GameChrome'

// Jay, 2026-10-19: the score vanished the moment the winning card was played, while it was still in the air, because
// the scoreboard and the controls unmounted on `won` (the winning move's own commit). They now stay as they were, taking
// no presses, until the win dialog is up (`winRevealed`), then fade out under it and unmount.

jest.mock('@/components/SettingsDialog', () => ({ SettingsDialog: () => null }))
jest.mock('@/components/RulesDialog', () => ({ RulesDialog: () => null }))
jest.mock('@/hooks/useSettings', () => ({ useSettings: () => ({ settings: { ...jest.requireActual('@/redux/settingsSlice').DEFAULT_SETTINGS }, setSettings: jest.fn() }) }))
jest.mock('@/components/useFontsPreload', () => ({ CARD_FONT_FAMILY: 'TestSerif' }))
jest.mock('@/stores/lastActiveGame', () => ({ useLastActiveGame: () => ({ clearLastActiveGame: jest.fn(), setLastActiveGame: jest.fn(), consumeResumeGame: () => null }) }))
// Shared values that live as long as the component (the repo-wide mock hands back a new one every render), and a
// withTiming that records where it was sent.
const mockTimings: { to: unknown; duration?: number }[] = []
jest.mock('react-native-reanimated', () => {
  const { useRef } = require('react')
  const base = jest.requireActual('../../__mocks__/react-native-reanimated')
  return {
    ...base,
    useSharedValue: (initial: unknown) => useRef({ value: initial }).current,
    withTiming: (to: unknown, config?: { duration?: number }) => {
      mockTimings.push({ to, duration: config?.duration })
      return to
    }
  }
})

let mockWide = false
jest.mock('@/components/gameLayout', () => {
  const actual = jest.requireActual('@/components/gameLayout')
  return {
    ...actual,
    useGameLayout: () => {
      const live = actual.useGameLayout()
      return mockWide ? actual.computeGameLayout(874, 402, { top: 0, right: 0, bottom: 0, left: 0 }) : live
    }
  }
})

beforeEach(() => {
  jest.useFakeTimers()
  mockTimings.length = 0
  mockWide = false
})
afterEach(() => jest.useRealTimers())

interface Props {
  won: boolean
  winRevealed: boolean
  elapsed?: number
  movesCount?: number
  onUndo?: () => void
  onNewGame?: () => void
  onHint?: () => void
}
function chrome({ won, winRevealed, elapsed = 75, movesCount = 40, onUndo = jest.fn(), onNewGame = jest.fn(), onHint = jest.fn() }: Props) {
  return (
    <PaperProvider>
      <GameChrome title='Klondike' onNewGame={onNewGame} onUndo={onUndo} undoDisabled={false} onHint={onHint} autoHintKey={null} hintShowing={false} hintDisabled={won} won={won} winRevealed={winRevealed} hasProgress getElapsedSeconds={() => elapsed} pauseClock={jest.fn()} par={{ moves: 100, seconds: 200, score: 300 }} clockRunning={false} movesCount={movesCount} rules={[]}>
        <View />
      </GameChrome>
    </PaperProvider>
  )
}

const DIMMED_OPACITY = 0.38
function dimmedCount() {
  let count = 0
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    const n = node as { props?: { style?: unknown }; children?: unknown[] }
    if ((StyleSheet.flatten(n.props?.style as never) as { opacity?: number } | undefined)?.opacity === DIMMED_OPACITY) count += 1
    ;(n.children ?? []).forEach(walk)
  }
  walk(screen.toJSON())
  return count
}
const opacityOf = (label: string) => {
  // The labelled button sits inside the animated wrapper whose opacity fades; walk up to the nearest one that has it.
  let node = screen.getByLabelText(label).parent
  while (node) {
    const opacity = (StyleSheet.flatten(node.props.style) as { opacity?: number } | undefined)?.opacity
    if (opacity !== undefined) return opacity
    node = node.parent
  }
  return undefined
}

it('the scoreboard and the controls stay, as they were and taking no presses, while the winning card lands', async () => {
  const onUndo = jest.fn()
  const onNewGame = jest.fn()
  const onHint = jest.fn()
  const r = await render(chrome({ won: false, winRevealed: false, onUndo, onNewGame, onHint }))
  await r.rerender(chrome({ won: true, winRevealed: false, onUndo, onNewGame, onHint }))

  // The final numbers are still up (40 moves + 75 seconds = 115, at 1:15).
  expect(screen.getByText('40')).toBeTruthy()
  expect(screen.getByText('115')).toBeTruthy()
  expect(screen.getByText('1:15')).toBeTruthy()
  for (const label of ['New Game', 'Undo', 'Hint', 'Hide controls']) await fireEvent.press(screen.getByLabelText(label))
  expect([onNewGame, onUndo, onHint].map((f) => f.mock.calls.length)).toEqual([0, 0, 0])
  // The scoreboard didn't tuck the footer away either, and nothing dimmed (Hint used to dim to 38% as the deal was won).
  expect(screen.getByLabelText('Hide controls')).toBeTruthy()
  expect(dimmedCount()).toBe(0)
  expect(opacityOf('Undo')).toBe(1)
  expect(mockTimings.some((t) => t.to === 0 && t.duration === 300)).toBe(false)

  // However long the board takes to settle: only the dialog takes them away.
  await act(async () => jest.advanceTimersByTime(5000))
  expect(screen.getByText('115')).toBeTruthy()
})

it('they fade out under the win dialog, then unmount', async () => {
  const r = await render(chrome({ won: true, winRevealed: false }))
  await r.rerender(chrome({ won: true, winRevealed: true }))
  expect(mockTimings).toContainEqual({ to: 0, duration: 300 })
  // Re-render so the animated styles read the faded value (the mock has no UI thread to apply it).
  await r.rerender(chrome({ won: true, winRevealed: true }))
  expect(opacityOf('Undo')).toBe(0)
  expect(opacityOf('Hide controls')).toBe(0)

  await act(async () => jest.advanceTimersByTime(299))
  expect(screen.queryByLabelText('Undo')).not.toBeNull()
  await act(async () => jest.advanceTimersByTime(1))
  for (const label of ['New Game', 'Undo', 'Hint', 'Hide controls']) expect(screen.queryByLabelText(label)).toBeNull()
  expect(screen.queryByText('115')).toBeNull()
})

it('the wide layout keeps and fades its columns the same way', async () => {
  mockWide = true
  const r = await render(chrome({ won: true, winRevealed: false }))
  expect(screen.getByText('115')).toBeTruthy()
  expect(screen.getByLabelText('Rules')).toBeTruthy()
  await r.rerender(chrome({ won: true, winRevealed: true }))
  await r.rerender(chrome({ won: true, winRevealed: true }))
  expect(opacityOf('Rules')).toBe(0)
  await act(async () => jest.advanceTimersByTime(300))
  expect(screen.queryByLabelText('Rules')).toBeNull()
  expect(screen.queryByText('115')).toBeNull()
})

it("a New Game brings them back with the new deal's clock, even one pressed mid-fade", async () => {
  const r = await render(chrome({ won: true, winRevealed: false }))
  await r.rerender(chrome({ won: true, winRevealed: true }))
  await act(async () => jest.advanceTimersByTime(100))
  await r.rerender(chrome({ won: false, winRevealed: false, elapsed: 0, movesCount: 0 }))
  expect(screen.getByText('0:00')).toBeTruthy()
  expect(opacityOf('Undo')).toBe(1)
  // The fade's timer is gone with it.
  await act(async () => jest.advanceTimersByTime(1000))
  expect(screen.getByLabelText('Undo')).toBeTruthy()

  // And after a fade that finished.
  await r.rerender(chrome({ won: true, winRevealed: true, elapsed: 30, movesCount: 12 }))
  await act(async () => jest.advanceTimersByTime(300))
  expect(screen.queryByLabelText('Undo')).toBeNull()
  await r.rerender(chrome({ won: false, winRevealed: false, elapsed: 0, movesCount: 0 }))
  expect(screen.getByText('0:00')).toBeTruthy()
  expect(opacityOf('Undo')).toBe(1)
})
