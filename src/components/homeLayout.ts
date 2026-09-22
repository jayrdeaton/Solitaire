import { clamp, rotateInsets, useRotatedWindowDimensions, useRotation } from '@tastic/core'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { type LayoutInsets, WIDE_FOOTER_SIDE_WIDTH } from './gameLayout'

/* ---------------------------------------------------------------------------------------------
 * The Home (game select) screen's geometry, both orientations - the counterpart of gameLayout.ts.
 *
 * Portrait is what it always was: one scrolling column (hero, title, profile, then the game rows).
 * Held sideways the same screen is only ~402pt tall, and that column would spend the whole height on
 * the hero and title before showing a single game - so a "wide" layout (any window whose ROTATED
 * footprint is landscape: a phone held sideways, an iPad, a desktop browser) splits it into two panes:
 * a left pane with the player chip, hero cards and title, and a right pane that scrolls a grid of
 * game tiles. The trophy (top-left) and cog (top-right) corner buttons stay where they are; the right
 * pane stops short of the cog so tiles never scroll underneath it.
 *
 * Everything here works in the ROTATED frame's own coordinates (see RotatedGameView): `width`/`height`
 * are the rotated footprint and `insets` are the safe-area insets already remapped onto the frame's
 * edges (rotateInsets). Note the rotated top/bottom insets are ~0 under a portrait-locked OS - a phone
 * held sideways only has left/right insets - so nothing here leans on them for breathing room.
 * ------------------------------------------------------------------------------------------- */

/** Wide layout: gap between the safe edge and the left pane. */
export const HOME_WIDE_EDGE_PADDING = 16
/** Wide layout: gap between the two panes. */
export const HOME_WIDE_PANE_GAP = 16
/** Wide layout: width reserved on the trailing side for the cog corner button (8pt margin, a 40pt
 * IconButton, 8pt of air) ON TOP of the trailing safe-area inset - the same column the game screens'
 * footer controls use, so the cog sits in the same place on both. */
export const HOME_WIDE_RIGHT_GUTTER = WIDE_FOOTER_SIDE_WIDTH
/** Cap on the two panes' combined width on a very wide window; past it the leftover is split into equal
 * empty margins on both sides (same idea as GAME_CONTENT_MAX_WIDTH). */
export const HOME_WIDE_MAX_CONTENT_WIDTH = 1100
export const HOME_LEFT_PANE_FRACTION = 0.38
export const HOME_LEFT_PANE_MIN = 260
export const HOME_LEFT_PANE_MAX = 340
/** Gap between grid tiles (both axes). */
export const HOME_GRID_GAP = 12
/** Narrowest a wide-layout tile may get before the grid drops a column, and the most columns it uses. */
export const HOME_MIN_TILE_WIDTH = 140
export const HOME_MAX_COLUMNS = 3
/** Padding inside a wide-layout tile around its preview and text. */
export const HOME_TILE_PADDING = 10
/** Vertical band the corner buttons occupy at the top of a pane (8pt margin + 40pt button + 8pt air). */
export const HOME_TOP_BAND = 56
/** GamePreview's own width / height (see PREVIEW_CANVAS_WIDTH/HEIGHT there). */
export const HOME_PREVIEW_ASPECT = 360 / 200

/** Portrait's hero and title, and how far the wide layout may shrink them. */
export const HOME_TITLE_FONT_SIZE = 32
export const HOME_WIDE_TITLE_FONT_SIZE = 28
export const HOME_HERO_MIN_SCALE = 0.55
/** Cap on Dynamic Type for the wide left pane's title and subtitle: the pane is a fixed-height, non-scrolling
 * stack budgeted at scale 1 (HOME_LEFT_PANE_FIXED_HEIGHT), and a landscape phone has no room to grow it. */
export const HOME_WIDE_MAX_FONT_SCALE = 1.3
// Landscape phones are short; even when there is room the hero stays a little smaller than portrait's
// so the game tiles (the point of the screen) get the height.
const HOME_HERO_SHORT_WINDOW_MAX_SCALE = 0.8
const HOME_SHORT_WINDOW_HEIGHT = 500
// The hero's visual span at scale 1 (five 64pt cards fanned, plus the rotation overhang) and the height
// its row reserves (a 93pt card + 20pt margin) - HeroCards.tsx's own constants.
const HOME_HERO_SPAN = 250
const HOME_HERO_HEIGHT = 113
// Everything else the left pane stacks under the trophy band besides the hero: the profile chip (60), a
// gap, the title (33) and the subtitle (2 lines, 37).
const HOME_LEFT_PANE_FIXED_HEIGHT = 142
const HOME_LEFT_PANE_BOTTOM_PADDING = 16

export interface HomeLayout {
  /** The rotated footprint is landscape - the two-pane layout is in effect. */
  isWide: boolean
  /** The window's footprint AFTER rotation. */
  windowWidth: number
  windowHeight: number
  /** Safe-area insets remapped onto the rotated frame's own edges (see @tastic/core's rotateInsets). */
  insets: LayoutInsets
  /** Wide layout: padding on the two panes' row - each side hugs ITS OWN inset (a phone held sideways has
   * a large inset only on the island side), the trailing one also reserves the cog's gutter, and both carry
   * the equal margin left over once the content hits its cap. 0 in portrait. */
  paddingLeft: number
  paddingRight: number
  leftPaneWidth: number
  rightPaneWidth: number
  columns: number
  /** Outer width of one wide-layout tile, and of the preview inside it. */
  tileWidth: number
  previewWidth: number
  /** HeroCards' scale (1 = its natural size) and the title's font size. */
  heroScale: number
  titleFontSize: number
}

/** Pure form of useHomeLayout, for tests and non-React callers. */
export function computeHomeLayout(windowWidth: number, windowHeight: number, insets: LayoutInsets): HomeLayout {
  const isWide = windowWidth > windowHeight
  if (!isWide) {
    return { isWide, windowWidth, windowHeight, insets, paddingLeft: 0, paddingRight: 0, leftPaneWidth: 0, rightPaneWidth: 0, columns: 1, tileWidth: 0, previewWidth: 0, heroScale: 1, titleFontSize: HOME_TITLE_FONT_SIZE }
  }

  const usable = windowWidth - insets.left - insets.right
  const inner = Math.max(0, usable - HOME_WIDE_EDGE_PADDING - HOME_WIDE_RIGHT_GUTTER)
  const content = Math.min(inner, HOME_WIDE_MAX_CONTENT_WIDTH)
  const slack = (inner - content) / 2

  // The left pane is a fraction of the content (within its own floor/ceiling), but never so wide that the
  // grid is left without room for at least one tile - a tiny window degrades to one narrow column, never
  // a negative width.
  const leftPaneWidth = Math.min(clamp(Math.round(HOME_LEFT_PANE_FRACTION * content), HOME_LEFT_PANE_MIN, HOME_LEFT_PANE_MAX), Math.max(0, content - HOME_WIDE_PANE_GAP - HOME_MIN_TILE_WIDTH))
  const rightPaneWidth = Math.max(0, content - HOME_WIDE_PANE_GAP - leftPaneWidth)
  const columns = clamp(Math.floor((rightPaneWidth + HOME_GRID_GAP) / (HOME_MIN_TILE_WIDTH + HOME_GRID_GAP)), 1, HOME_MAX_COLUMNS)
  const tileWidth = Math.max(0, Math.floor((rightPaneWidth - (columns - 1) * HOME_GRID_GAP) / columns))
  const previewWidth = Math.max(0, tileWidth - 2 * HOME_TILE_PADDING)

  const maxHeroScale = windowHeight < HOME_SHORT_WINDOW_HEIGHT ? HOME_HERO_SHORT_WINDOW_MAX_SCALE : 1
  const heightForHero = windowHeight - insets.top - insets.bottom - HOME_TOP_BAND - HOME_LEFT_PANE_BOTTOM_PADDING - HOME_LEFT_PANE_FIXED_HEIGHT
  const heroScale = clamp(Math.min(maxHeroScale, (leftPaneWidth - 16) / HOME_HERO_SPAN, heightForHero / HOME_HERO_HEIGHT), HOME_HERO_MIN_SCALE, 1)

  return {
    isWide,
    windowWidth,
    windowHeight,
    insets,
    paddingLeft: insets.left + HOME_WIDE_EDGE_PADDING + slack,
    paddingRight: insets.right + HOME_WIDE_RIGHT_GUTTER + slack,
    leftPaneWidth,
    rightPaneWidth,
    columns,
    tileWidth,
    previewWidth,
    heroScale,
    titleFontSize: HOME_WIDE_TITLE_FONT_SIZE
  }
}

/** The live layout for the current window + rotation. Reads useRotatedWindowDimensions()/rotateInsets()
 * rather than raw useWindowDimensions()/useSafeAreaInsets(), so it describes the footprint a rotated Home
 * actually renders into (both are exact identities at 0deg / with no OrientationProvider). */
export function useHomeLayout(): HomeLayout {
  const { width, height } = useRotatedWindowDimensions()
  const rotation = useRotation()
  const insets = rotateInsets(useSafeAreaInsets(), rotation)
  return computeHomeLayout(width, height, insets)
}
