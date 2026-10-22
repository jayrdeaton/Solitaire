import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, ScrollView } from 'react-native'

/* ---------------------------------------------------------------------------------------------
 * GameChrome's board scrolls ONLY when it doesn't fit the screen.
 *
 * Every board is laid out to fit exactly (useTableauMaxHeight, the wide layout's card fit), and a long
 * column compresses into its share - but never below PileView's its tightest (columnTops' MIN_FACE_UP_FAN_SCALE), where a covered card's
 * rank stops being readable and its strip stops being tappable. A column that needs more runs past the
 * bottom, and that is the one case the board scrolls, so the player can reach its last card.
 *
 * Otherwise the scroll view must stay still: React Native's vertical ScrollView lets you drag it even
 * when nothing overflows (iOS's alwaysBounceVertical defaults to true), which rubber-banded the whole
 * board under every vertical swipe on the felt. So it is only scroll-enabled while the content really
 * is taller than the viewport (by more than a point, so a sub-point rounding difference between a board
 * that fits exactly and its viewport never switches it on), and never bounces a board that fits.
 *
 * And the content never shrinks out from under a scrolled board. When the long column loses cards (a
 * move, an auto-play stream the player scrolled down to watch), the board would be left scrolled past
 * its new end: iOS doesn't pull the offset back in (React Native's own TODO T190695447 in
 * RCTScrollViewComponentView), and Android and the web clamp it at once, which jumps the board under
 * any card still in flight, whose landing spot was measured before the jump. So the content keeps a
 * least height (`holdHeight`): while the board is moving, everything it had when the movement began;
 * once it rests, what shows what is on screen (offset + viewport). The player scrolls back up
 * themselves, and once the board rests at the top the hold lets go and the board stops scrolling if it
 * fits. A new deal (the move count drops back) and a new footprint (a rotation) are laid out from
 * scratch, so they start back at the top: a new deal remounts the scroll view (`boardKey`), so it is at
 * the top in the same commit that mounts the new board - before the deal measures where its cards go,
 * which a scrollTo could not guarantee (the native offset reaches the shadow tree a commit or more later).
 * ------------------------------------------------------------------------------------------- */

/** How much taller than the viewport the content must be before the board scrolls. */
export const BOARD_SCROLL_TOLERANCE = 1
/** How long after the last scroll event the board counts as resting (and its hold is updated). */
export const BOARD_SCROLL_REST_MS = 120

/** Whether a board whose content is `contentHeight` tall needs to scroll in a `viewportHeight` viewport. */
export function boardOverflows(contentHeight: number, viewportHeight: number): boolean {
  return contentHeight - viewportHeight > BOARD_SCROLL_TOLERANCE
}

/** The least height the content keeps while the board rests scrolled to `offset`: everything on screen. */
export function boardHoldHeight(offset: number, viewportHeight: number): number {
  return offset > 0.5 ? offset + viewportHeight : 0
}

/** `movesCount` is the deal's move count (GameChrome's own prop): it only ever drops when a new deal starts. */
export function useBoardScroll(movesCount: number) {
  const scrollRef = useRef<ScrollView>(null)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [contentHeight, setContentHeight] = useState(0)
  const [holdHeight, setHoldHeight] = useState(0)
  const [boardKey, setBoardKey] = useState(0)
  const viewportRef = useRef(0)
  const contentRef = useRef(0)
  const offsetRef = useRef(0)
  // The largest scroll range reported since the board last rested: a resting offset is clamped to it, because iOS
  // reports a rubber-band past the end as an offset past it, and a hold sized from that would grow the content to keep
  // the board there.
  const rangeRef = useRef(0)
  const draggingRef = useRef(false)
  // The board is moving (a drag, a fling, a bounce) and has not rested since.
  const movingRef = useRef(false)
  const restTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // A new deal while the board rests scrolled down: the new board opens at the top (see the header).
  const [prevMoves, setPrevMoves] = useState(movesCount)
  if (movesCount !== prevMoves) {
    setPrevMoves(movesCount)
    if (movesCount < prevMoves && holdHeight > 0) {
      setHoldHeight(0)
      setBoardKey((key) => key + 1)
    }
  }
  // The remounted scroll view starts at the top, with nothing in motion (a layout effect: before any timer can fire).
  useLayoutEffect(() => {
    if (restTimerRef.current) clearTimeout(restTimerRef.current)
    restTimerRef.current = null
    offsetRef.current = 0
    rangeRef.current = 0
    draggingRef.current = false
    movingRef.current = false
  }, [boardKey])
  useEffect(
    () => () => {
      if (restTimerRef.current) clearTimeout(restTimerRef.current)
    },
    []
  )

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const height = e.nativeEvent.layout.height
    const previous = viewportRef.current
    viewportRef.current = height
    setViewportHeight(height)
    if (previous > 0 && Math.abs(height - previous) > 0.5 && offsetRef.current > 0) {
      if (restTimerRef.current) clearTimeout(restTimerRef.current)
      restTimerRef.current = null
      offsetRef.current = 0
      rangeRef.current = 0
      draggingRef.current = false
      movingRef.current = false
      setHoldHeight(0)
      scrollRef.current?.scrollTo({ y: 0, animated: false })
    }
  }, [])

  const onContentSizeChange = useCallback((_width: number, height: number) => {
    contentRef.current = height
    setContentHeight(height)
  }, [])

  // As the board starts moving, it keeps everything it has until it rests.
  const startMoving = useCallback(() => {
    if (movingRef.current) return
    movingRef.current = true
    setHoldHeight((hold) => Math.max(hold, contentRef.current))
  }, [])

  // Every scroll event reports where the board is; the hold follows once it has rested (never while a finger is down).
  const record = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
      // The first event of a movement starts it too: the web reports no drag or fling starts.
      if (contentOffset.y > 0.5) startMoving()
      rangeRef.current = Math.max(rangeRef.current, contentSize && layoutMeasurement ? contentSize.height - layoutMeasurement.height : Infinity)
      offsetRef.current = Math.max(0, Math.min(contentOffset.y, rangeRef.current))
      if (restTimerRef.current) clearTimeout(restTimerRef.current)
      restTimerRef.current = null
      if (draggingRef.current) return
      restTimerRef.current = setTimeout(() => {
        restTimerRef.current = null
        rangeRef.current = 0
        movingRef.current = false
        setHoldHeight(boardHoldHeight(offsetRef.current, viewportRef.current))
      }, BOARD_SCROLL_REST_MS)
    },
    [startMoving]
  )

  const onScrollBeginDrag = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      draggingRef.current = true
      startMoving()
      record(e)
    },
    [record, startMoving]
  )

  const onScrollEndDrag = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      draggingRef.current = false
      record(e)
    },
    [record]
  )

  return {
    scrollProps: {
      ref: scrollRef,
      scrollEnabled: boardOverflows(contentHeight, viewportHeight),
      alwaysBounceVertical: false,
      scrollEventThrottle: 16,
      onLayout,
      onContentSizeChange,
      onScroll: record,
      onScrollBeginDrag,
      onScrollEndDrag,
      onMomentumScrollBegin: startMoving,
      onMomentumScrollEnd: record
    },
    holdHeight,
    boardKey
  }
}
