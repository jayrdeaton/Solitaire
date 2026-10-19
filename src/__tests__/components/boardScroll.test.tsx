import { FeedbackPressProvider } from '@rific/feedback-press'
import { act, fireEvent, render, screen, within } from '@testing-library/react-native'
import { useEffect } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import * as RNPaper from 'react-native-paper'
import { Provider as PaperProvider } from 'react-native-paper'

import { BOARD_SCROLL_REST_MS, boardHoldHeight, boardOverflows, useBoardScroll } from '@/components/boardScroll'
import { GameChrome } from '@/components/GameChrome'

// GameChrome's board scrolls ONLY when a column too long to compress any further runs past the bottom (boardScroll.ts):
// a board that fits never moves under a swipe on the felt (no iOS rubber band), the content never shrinks out from under
// a scrolled board (which would leave it stuck past its end on iOS, or jump it on Android and the web), and a new deal or
// a rotation starts back at the top.

jest.mock('@/components/SettingsDialog', () => ({ SettingsDialog: () => null }))
jest.mock('@/components/RulesDialog', () => ({ RulesDialog: () => null }))
jest.mock('@/hooks/useSettings', () => ({ useSettings: () => ({ settings: { ...jest.requireActual('@/redux/settingsSlice').DEFAULT_SETTINGS }, setSettings: jest.fn() }) }))
jest.mock('@/components/useFontsPreload', () => ({ CARD_FONT_FAMILY: 'TestSerif' }))
// The window GameChrome lays out for: portrait unless a test turns it sideways (the wide layout).
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
jest.mock('@/stores/lastActiveGame', () => ({ useLastActiveGame: () => ({ clearLastActiveGame: jest.fn(), setLastActiveGame: jest.fn(), consumeResumeGame: () => null }) }))

const VIEWPORT = 800

/** Counts how many times the board's content mounted (a remount of the scroll view mounts it again). */
const mounts = { count: 0 }
function Content() {
  useEffect(() => {
    mounts.count += 1
  }, [])
  return <View testID='content' />
}

/** The ScrollView mock's scrollTo: one jest.fn on its prototype, shared by every instance. */
const scrollToMock = () => (ScrollView.prototype as unknown as { scrollTo: jest.Mock }).scrollTo
function Harness({ movesCount = 0 }: { movesCount?: number }) {
  const { scrollProps, holdHeight, boardKey } = useBoardScroll(movesCount)
  return (
    <ScrollView key={boardKey} testID='board' {...scrollProps} contentContainerStyle={holdHeight > 0 ? { minHeight: holdHeight } : undefined}>
      <Content />
    </ScrollView>
  )
}

let testID = 'board'
const board = () => screen.getByTestId(testID)
const layout = async (height: number) => fireEvent(board(), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 400, height } } })
const contentSize = async (height: number) => fireEvent(board(), 'contentSizeChange', 400, height)
/** A scroll event at `y`, in content `content` tall (what iOS, Android and the web all report with every scroll event). */
const scrollEvent = (y: number, content = VIEWPORT + 180) => ({ nativeEvent: { contentOffset: { x: 0, y }, contentSize: { width: 400, height: content }, layoutMeasurement: { width: 400, height: VIEWPORT } } })
const scrollTo = async (y: number, content?: number) => fireEvent.scroll(board(), scrollEvent(y, content))
const rest = () => act(async () => jest.advanceTimersByTime(BOARD_SCROLL_REST_MS))
const minHeight = () => (StyleSheet.flatten(board().props.contentContainerStyle) as { minHeight?: number } | undefined)?.minHeight ?? 0

beforeEach(() => {
  testID = 'board'
  mounts.count = 0
})

describe('boardOverflows / boardHoldHeight', () => {
  it('scrolls only for content more than a point taller than the viewport', () => {
    expect(boardOverflows(VIEWPORT, VIEWPORT)).toBe(false)
    expect(boardOverflows(VIEWPORT + 0.6, VIEWPORT)).toBe(false) // sub-point rounding on a board that fits exactly
    expect(boardOverflows(VIEWPORT + 4, VIEWPORT)).toBe(true)
    expect(boardOverflows(0, 0)).toBe(false)
  })

  it('holds what is on screen while scrolled down, nothing at the top', () => {
    expect(boardHoldHeight(0, VIEWPORT)).toBe(0)
    expect(boardHoldHeight(180, VIEWPORT)).toBe(180 + VIEWPORT)
  })
})

describe('useBoardScroll', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('never bounces, and does not scroll a board that fits', async () => {
    await render(<Harness />)
    expect(board().props.alwaysBounceVertical).toBe(false)
    expect(board().props.scrollEnabled).toBe(false)
    await layout(VIEWPORT)
    await contentSize(VIEWPORT)
    expect(board().props.scrollEnabled).toBe(false)
  })

  it('scrolls once a column runs past the bottom, and stops again when it no longer does', async () => {
    await render(<Harness />)
    await layout(VIEWPORT)
    await contentSize(VIEWPORT + 180)
    expect(board().props.scrollEnabled).toBe(true)
    await contentSize(VIEWPORT)
    expect(board().props.scrollEnabled).toBe(false)
  })

  it('once a scrolled board rests, its content keeps what is on screen when the long column goes - until it rests back at the top', async () => {
    await render(<Harness />)
    await layout(VIEWPORT)
    await contentSize(VIEWPORT + 180)
    await scrollTo(180)
    await rest()
    expect(minHeight()).toBe(VIEWPORT + 180)
    // The long column goes: the board's own content would be just the viewport now, but the hold keeps it where the board is.
    await contentSize(VIEWPORT)
    expect(minHeight()).toBe(VIEWPORT + 180)
    // Scrolled back to the top, the hold lets go and the board (which fits now) stops scrolling.
    await scrollTo(0)
    await rest()
    expect(minHeight()).toBe(0)
    await contentSize(VIEWPORT)
    expect(board().props.scrollEnabled).toBe(false)
  })

  it('holds everything the content had from the moment the board starts moving, so a column shrinking mid-scroll never jumps it', async () => {
    await render(<Harness />)
    await layout(VIEWPORT)
    await contentSize(VIEWPORT + 180)
    await fireEvent(board(), 'scrollBeginDrag', scrollEvent(0))
    expect(minHeight()).toBe(VIEWPORT + 180)
    await scrollTo(150)
    // An auto-play card leaves the long column while the player is still scrolling: nothing lets the content shrink yet.
    await contentSize(VIEWPORT + 180)
    await fireEvent(board(), 'scrollEndDrag', scrollEvent(150))
    expect(minHeight()).toBe(VIEWPORT + 180)
    await rest()
    expect(minHeight()).toBe(VIEWPORT + 150)
  })

  it('a board flung past its end (an iOS rubber band) rests at its real end: the hold never grows the content', async () => {
    await render(<Harness />)
    await layout(VIEWPORT)
    await contentSize(VIEWPORT + 180)
    await scrollTo(220) // 40pt past the bottom
    await rest()
    expect(minHeight()).toBe(VIEWPORT + 180)
  })

  it('never updates the hold while a finger is down, even held still past the end', async () => {
    await render(<Harness />)
    await layout(VIEWPORT)
    await contentSize(VIEWPORT + 180)
    await fireEvent(board(), 'scrollBeginDrag', scrollEvent(150))
    await scrollTo(220)
    await rest()
    await rest()
    expect(minHeight()).toBe(VIEWPORT + 180) // still the hold taken when the drag began
    await fireEvent(board(), 'scrollEndDrag', scrollEvent(180))
    await rest()
    expect(minHeight()).toBe(VIEWPORT + 180)
  })

  it('takes the resting offset from the end of a drag or a fling too (a throttled last scroll event cannot leave it short)', async () => {
    await render(<Harness />)
    await layout(VIEWPORT)
    await contentSize(VIEWPORT + 180)
    await fireEvent(board(), 'scrollEndDrag', scrollEvent(120))
    await rest()
    expect(minHeight()).toBe(VIEWPORT + 120)
    await fireEvent(board(), 'momentumScrollEnd', scrollEvent(60))
    await rest()
    expect(minHeight()).toBe(VIEWPORT + 60)
  })

  it('starts a new footprint (a rotation) back at the top', async () => {
    await render(<Harness />)
    await layout(VIEWPORT)
    await contentSize(VIEWPORT + 180)
    await scrollTo(180)
    await rest()
    expect(minHeight()).toBe(VIEWPORT + 180)
    const scrollToSpy = scrollToMock()
    scrollToSpy.mockClear()
    await layout(400)
    expect(minHeight()).toBe(0)
    expect(scrollToSpy).toHaveBeenCalledWith({ y: 0, animated: false })
  })

  it('leaves a board at the top alone when its footprint changes', async () => {
    await render(<Harness />)
    await layout(VIEWPORT)
    const scrollToSpy = scrollToMock()
    scrollToSpy.mockClear()
    await layout(400)
    expect(scrollToSpy).not.toHaveBeenCalled()
  })

  it('opens a new deal at the top: the move count dropping back while the board rests scrolled down remounts the scroll view', async () => {
    const r = await render(<Harness movesCount={12} />)
    await layout(VIEWPORT)
    await contentSize(VIEWPORT + 180)
    await scrollTo(180)
    await rest()
    expect(mounts.count).toBe(1)
    await r.rerender(<Harness movesCount={0} />)
    expect(mounts.count).toBe(2)
    expect(minHeight()).toBe(0)
    // ... and a move made on the new board is just a move.
    await r.rerender(<Harness movesCount={1} />)
    expect(mounts.count).toBe(2)
  })

  it('leaves a board at the top alone when a new deal starts', async () => {
    const r = await render(<Harness movesCount={12} />)
    await layout(VIEWPORT)
    await contentSize(VIEWPORT)
    await r.rerender(<Harness movesCount={0} />)
    expect(mounts.count).toBe(1)
  })
})

describe('GameChrome', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  const chrome = (movesCount = 0) => (
    <PaperProvider>
      <GameChrome title='Yukon' onNewGame={jest.fn()} onUndo={jest.fn()} undoDisabled onHint={jest.fn()} autoHintKey={null} hintShowing={false} won={false} winRevealed={false} hasProgress={movesCount > 0} getElapsedSeconds={() => 0} pauseClock={jest.fn()} par={{ moves: 100, seconds: 200, score: 300 }} clockRunning={false} movesCount={movesCount} rules={[]}>
        <Content />
      </GameChrome>
    </PaperProvider>
  )
  /** The footer's pointerEvents: 'box-none' while it is up, 'none' once a felt tap has tucked it away. */
  const footerPointerEvents = () => {
    const hits: string[] = []
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(walk)
      const n = node as { props?: { pointerEvents?: string; style?: unknown }; children?: unknown[] }
      const style = StyleSheet.flatten(n.props?.style as never) as { bottom?: number; flexDirection?: string } | undefined
      if (style?.flexDirection === 'row' && style.bottom === 8 && n.props?.pointerEvents) hits.push(n.props.pointerEvents)
      ;(n.children ?? []).forEach(walk)
    }
    walk(screen.toJSON())
    expect(hits).toHaveLength(1)
    return hits[0]
  }
  const press = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    // On the felt itself (the board's content sits inside the tap catcher).
    await fireEvent(screen.getByTestId('content'), 'pressIn', { nativeEvent: { pageX: from.x, pageY: from.y } })
    await fireEvent(screen.getByTestId('content'), 'press', { nativeEvent: { pageX: to.x, pageY: to.y } })
  }

  it("hands its board's ScrollView the board-scroll behaviour, hold included", async () => {
    testID = 'game-board-scroll'
    await render(chrome())
    expect(board().props.alwaysBounceVertical).toBe(false)
    expect(board().props.scrollEnabled).toBe(false)
    await layout(VIEWPORT)
    await contentSize(VIEWPORT + 100)
    expect(board().props.scrollEnabled).toBe(true)
    expect(minHeight()).toBe(0)
    await scrollTo(100, VIEWPORT + 100)
    await rest()
    expect(minHeight()).toBe(VIEWPORT + 100)
  })

  it('opens a new deal at the top (its move count drops back while the board rests scrolled down)', async () => {
    testID = 'game-board-scroll'
    const r = await render(chrome(30))
    await layout(VIEWPORT)
    await contentSize(VIEWPORT + 100)
    await scrollTo(100, VIEWPORT + 100)
    await rest()
    expect(mounts.count).toBe(1)
    await r.rerender(chrome(0))
    expect(mounts.count).toBe(2)
    expect(minHeight()).toBe(0)
  })

  it('tapping the moves/score/time readout hides the footer and tapping it again brings it back', async () => {
    await render(chrome())
    expect(footerPointerEvents()).toBe('box-none')
    await fireEvent.press(screen.getByLabelText('Hide controls'))
    expect(footerPointerEvents()).toBe('none')
    await fireEvent.press(screen.getByLabelText('Show controls'))
    expect(footerPointerEvents()).toBe('box-none')
  })

  // 2026-10-17: the scoreboard brings the controls back as the finger lifts and is off that spot ~35ms later, so the
  // second tap of a double tap on the lowered scoreboard pressed whichever button had come up under it (Undo undid a move).
  it('a second tap right after the scoreboard brings the controls back presses none of them', async () => {
    const onUndo = jest.fn()
    const onNewGame = jest.fn()
    const onHint = jest.fn()
    await render(
      <PaperProvider>
        <GameChrome title='Yukon' onNewGame={onNewGame} onUndo={onUndo} undoDisabled={false} onHint={onHint} autoHintKey={null} hintShowing={false} won={false} winRevealed={false} hasProgress={false} getElapsedSeconds={() => 0} pauseClock={jest.fn()} par={{ moves: 100, seconds: 200, score: 300 }} clockRunning={false} movesCount={3} rules={[]}>
          <Content />
        </GameChrome>
      </PaperProvider>
    )
    await fireEvent.press(screen.getByLabelText('Hide controls'))
    await fireEvent.press(screen.getByLabelText('Show controls'))
    for (const label of ['New Game', 'Undo', 'Hint']) await fireEvent.press(screen.getByLabelText(label))
    await act(async () => jest.advanceTimersByTime(299))
    for (const label of ['New Game', 'Undo', 'Hint']) await fireEvent.press(screen.getByLabelText(label))
    expect([onNewGame, onUndo, onHint].map((f) => f.mock.calls.length)).toEqual([0, 0, 0])
    // Not dimmed meanwhile: they come up looking as live as they are a moment later.
    const dimmed: unknown[] = []
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(walk)
      const n = node as { props?: { style?: unknown }; children?: unknown[] }
      if ((StyleSheet.flatten(n.props?.style as never) as { opacity?: number } | undefined)?.opacity === 0.38) dimmed.push(n)
      ;(n.children ?? []).forEach(walk)
    }
    walk(screen.toJSON())
    expect(dimmed).toHaveLength(0)

    await act(async () => jest.advanceTimersByTime(1))
    for (const label of ['New Game', 'Undo', 'Hint']) await fireEvent.press(screen.getByLabelText(label))
    expect([onNewGame, onUndo, onHint].map((f) => f.mock.calls.length)).toEqual([1, 1, 1])
  })

  it('a tap on the felt leaves the footer alone (a tap that just missed a card used to hide it)', async () => {
    await render(chrome())
    await press({ x: 200, y: 500 }, { x: 200, y: 500 })
    expect(footerPointerEvents()).toBe('box-none')
  })

  it('the portrait footer is New Game, Undo, Hint, with no Rules button (the title opens the rules)', async () => {
    // With Paper injected (as the app does), so the buttons carry their labels.
    await render(<FeedbackPressProvider paper={RNPaper}>{chrome()}</FeedbackPressProvider>)
    const labels = screen.getAllByLabelText(/^(New Game|Undo|Hint|Rules)$/).map((b) => b.props.accessibilityLabel as string)
    expect(labels).toEqual(['New Game', 'Undo', 'Hint'])
  })

  // Jay, 2026-10-16: his kids had to ask where to start a new game (the icon alone is a fan of cards).
  it('every control shows its name under its icon, in both layouts', async () => {
    const onNewGame = jest.fn()
    const harness = () => (
      <PaperProvider>
        <GameChrome title='Yukon' onNewGame={onNewGame} onUndo={jest.fn()} undoDisabled onHint={jest.fn()} autoHintKey={null} hintShowing={false} won={false} winRevealed={false} hasProgress={false} getElapsedSeconds={() => 0} pauseClock={jest.fn()} par={{ moves: 100, seconds: 200, score: 300 }} clockRunning={false} movesCount={0} rules={[]}>
          <Content />
        </GameChrome>
      </PaperProvider>
    )
    const r = await render(harness())
    for (const label of ['New Game', 'Undo', 'Hint']) expect(within(screen.getByLabelText(label)).getByText(label)).toBeTruthy()
    expect(screen.getByLabelText('Undo').props.accessibilityState).toEqual({ disabled: true })
    await fireEvent.press(screen.getByText('New Game'))
    expect(onNewGame).toHaveBeenCalledTimes(1)

    // Each portrait button's touch area reaches 20pt above its pill, over the gap and the MOVES/SCORE/TIME line
    // (66 + 14 - 60): a Hint tap a little high used to tuck the controls away (Jay, 2026-10-16).
    for (const label of ['New Game', 'Undo', 'Hint']) expect(StyleSheet.flatten(screen.getByLabelText(label).props.style).paddingTop).toBe(20)

    mockWide = true
    try {
      await r.rerender(harness())
      for (const label of ['Undo', 'New Game', 'Hint', 'Rules']) expect(within(screen.getByLabelText(label)).getByText(label)).toBeTruthy()
    } finally {
      mockWide = false
    }
  })
})
