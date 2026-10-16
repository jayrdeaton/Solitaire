import { type LayoutInsets, WIDE_FOOTER_SIDE_WIDTH } from '@/components/gameLayout'
import { HERO_FAN_HEIGHT, HERO_FAN_SPAN } from '@/components/heroFan'
import { computeHomeLayout, HOME_GRID_GAP, HOME_HERO_MIN_SCALE, HOME_LEFT_PANE_MAX, HOME_LEFT_PANE_MIN, HOME_MAX_COLUMNS, HOME_MIN_TILE_WIDTH, HOME_TILE_PADDING, HOME_TITLE_FONT_SIZE, HOME_WIDE_EDGE_PADDING, HOME_WIDE_MAX_CONTENT_WIDTH, HOME_WIDE_PANE_GAP, HOME_WIDE_RIGHT_GUTTER, HOME_WIDE_TITLE_FONT_SIZE } from '@/components/homeLayout'

const NO_INSETS: LayoutInsets = { top: 0, right: 0, bottom: 0, left: 0 }

// The hero's span at scale 1 (HERO_FAN_SPAN, 251) must fit in the left pane minus 16pt of breathing room; its
// height (HERO_FAN_HEIGHT, 123) is what the pane's height budget sets aside for it.
const HERO_PANE_BREATHING_ROOM = 16

// The two-pane row's padding is `edge/gutter + own inset + slack` on each side, so everything on the row
// adds back up to the window's width - as long as the window is wide enough for the row's own fixed parts
// (inner width >= the pane gap). Below that the panes collapse to 0 and only the paddings remain.
const rowWidth = (l: ReturnType<typeof computeHomeLayout>) => l.paddingLeft + l.leftPaneWidth + HOME_WIDE_PANE_GAP + l.rightPaneWidth + l.paddingRight

describe('constants', () => {
  it('reserves the cog gutter as wide as the game screens footer column', () => {
    expect(HOME_WIDE_RIGHT_GUTTER).toBe(WIDE_FOOTER_SIDE_WIDTH)
    expect(HOME_WIDE_RIGHT_GUTTER).toBe(56)
  })

  it('keeps the left pane floor below its ceiling and the wide title smaller than the portrait one', () => {
    expect(HOME_LEFT_PANE_MIN).toBeLessThan(HOME_LEFT_PANE_MAX)
    expect(HOME_TITLE_FONT_SIZE).toBe(32)
    expect(HOME_WIDE_TITLE_FONT_SIZE).toBeLessThan(HOME_TITLE_FONT_SIZE)
  })
})

describe('computeHomeLayout - orientation', () => {
  it('returns neutral portrait values: one column, the natural hero, no panes, no paddings', () => {
    const insets = { top: 59, right: 0, bottom: 34, left: 0 }
    const layout = computeHomeLayout(402, 874, insets)
    expect(layout.isWide).toBe(false)
    expect(layout.windowWidth).toBe(402)
    expect(layout.windowHeight).toBe(874)
    expect(layout.insets).toEqual(insets)
    expect(layout.columns).toBe(1)
    expect(layout.heroScale).toBe(1)
    expect(layout.titleFontSize).toBe(32)
    expect(layout.paddingLeft).toBe(0)
    expect(layout.paddingRight).toBe(0)
    expect(layout.leftPaneWidth).toBe(0)
    expect(layout.rightPaneWidth).toBe(0)
    expect(layout.tileWidth).toBe(0)
    expect(layout.previewWidth).toBe(0)
  })

  it('does not let portrait insets or a huge window change anything', () => {
    const layout = computeHomeLayout(1000, 1400, { top: 40, right: 30, bottom: 20, left: 10 })
    expect(layout.isWide).toBe(false)
    expect(layout.paddingLeft).toBe(0)
    expect(layout.paddingRight).toBe(0)
    expect(layout.columns).toBe(1)
    expect(layout.heroScale).toBe(1)
    expect(layout.titleFontSize).toBe(HOME_TITLE_FONT_SIZE)
  })

  it('treats a square window as portrait (wide needs width strictly greater than height)', () => {
    const layout = computeHomeLayout(600, 600, NO_INSETS)
    expect(layout.isWide).toBe(false)
    expect(layout.columns).toBe(1)
    expect(layout.heroScale).toBe(1)
    expect(layout.titleFontSize).toBe(HOME_TITLE_FONT_SIZE)
    expect(layout.leftPaneWidth).toBe(0)
    expect(layout.rightPaneWidth).toBe(0)
  })

  it('goes wide as soon as the width exceeds the height by a single point', () => {
    const layout = computeHomeLayout(601, 600, NO_INSETS)
    expect(layout.isWide).toBe(true)
    expect(layout.titleFontSize).toBe(HOME_WIDE_TITLE_FONT_SIZE)
    // usable 601, inner 601 - 72 = 529, content 529, left round(201.02) -> floor 260, right 529 - 16 - 260 = 253
    expect(layout.leftPaneWidth).toBe(260)
    expect(layout.rightPaneWidth).toBe(253)
    expect(layout.columns).toBe(1)
    expect(layout.tileWidth).toBe(253)
  })

  it('echoes the window and insets it was given, in both orientations', () => {
    const insets = { top: 1, right: 2, bottom: 3, left: 4 }
    const wide = computeHomeLayout(874, 402, insets)
    expect(wide.windowWidth).toBe(874)
    expect(wide.windowHeight).toBe(402)
    expect(wide.insets).toBe(insets)
  })
})

describe('computeHomeLayout - a phone held sideways (874x402)', () => {
  // +90: the island is on the leading (left) side, the home indicator on the trailing one.
  // usable = 874 - 62 - 34 = 778; inner = 778 - 16 (edge) - 56 (cog gutter) = 706; content = 706 (under the
  // 1100 cap) so slack = 0; left = round(0.38 * 706 = 268.28) = 268 (inside 260..340, room to spare for a
  // tile); right = 706 - 16 - 268 = 422; columns = floor((422 + 12) / (140 + 12) = 2.86) = 2;
  // tile = floor((422 - 12) / 2) = 205; preview = 205 - 20 = 185.
  it('+90: hugs each sides own inset and splits the panes 268 / 422 into two 205pt columns', () => {
    const layout = computeHomeLayout(874, 402, { top: 0, right: 34, bottom: 0, left: 62 })
    expect(layout.isWide).toBe(true)
    expect(layout.paddingLeft).toBe(62 + 16)
    expect(layout.paddingRight).toBe(34 + 56)
    expect(layout.leftPaneWidth).toBe(268)
    expect(layout.rightPaneWidth).toBe(422)
    expect(layout.columns).toBe(2)
    expect(layout.tileWidth).toBe(205)
    expect(layout.previewWidth).toBe(185)
    expect(layout.titleFontSize).toBe(28)
    expect(rowWidth(layout)).toBe(874)
  })

  it('-90: the sides swap - the pane widths are identical, only each side own padding moves', () => {
    const minus90 = computeHomeLayout(874, 402, { top: 0, right: 62, bottom: 0, left: 34 })
    expect(minus90.paddingLeft).toBe(34 + 16)
    expect(minus90.paddingRight).toBe(62 + 56)
    expect(minus90.leftPaneWidth).toBe(268)
    expect(minus90.rightPaneWidth).toBe(422)
    expect(minus90.columns).toBe(2)
    expect(minus90.tileWidth).toBe(205)
    expect(minus90.previewWidth).toBe(185)
    expect(rowWidth(minus90)).toBe(874)
  })

  it('a side with a small inset is not padded by the other sides larger one', () => {
    const plus90 = computeHomeLayout(874, 402, { top: 0, right: 34, bottom: 0, left: 62 })
    const minus90 = computeHomeLayout(874, 402, { top: 0, right: 62, bottom: 0, left: 34 })
    // the leading padding follows the LEFT inset only, the trailing one follows the RIGHT inset only
    expect(plus90.paddingLeft - minus90.paddingLeft).toBe(62 - 34)
    expect(minus90.paddingRight - plus90.paddingRight).toBe(62 - 34)
    // ... so the total horizontal padding is the same either way
    expect(plus90.paddingLeft + plus90.paddingRight).toBe(minus90.paddingLeft + minus90.paddingRight)
  })

  it('shrinks the hero to the short-window cap of 0.8', () => {
    // height for the hero = 402 - 0 - 0 - 56 - 16 - 126 = 204 (1.66 heroes), width allows (268 - 16) / 251 = 1.004
    expect(computeHomeLayout(874, 402, { top: 0, right: 34, bottom: 0, left: 62 }).heroScale).toBe(0.8)
    expect(computeHomeLayout(874, 402, { top: 0, right: 62, bottom: 0, left: 34 }).heroScale).toBe(0.8)
  })
})

describe('computeHomeLayout - exact pane math across devices', () => {
  interface Case {
    name: string
    width: number
    height: number
    insets: LayoutInsets
    paddingLeft: number
    paddingRight: number
    leftPaneWidth: number
    rightPaneWidth: number
    columns: number
    tileWidth: number
    previewWidth: number
    heroScale: number
  }

  const cases: Case[] = [
    {
      // usable 667, inner 595, content 595; left round(226.1) -> floor 260 (room: 595 - 156 = 439); right 595 - 16 - 260 = 319;
      // columns floor(331 / 152 = 2.18) = 2; tile floor(307 / 2 = 153.5) = 153; preview 133.
      // hero: short window -> 0.8 cap; height 161/123 = 1.31; width (260 - 16)/251 = 0.972 -> 0.8
      name: 'a small phone, 667x375, no insets',
      width: 667,
      height: 375,
      insets: NO_INSETS,
      paddingLeft: 16,
      paddingRight: 56,
      leftPaneWidth: 260,
      rightPaneWidth: 319,
      columns: 2,
      tileWidth: 153,
      previewWidth: 133,
      heroScale: 0.8
    },
    {
      // usable 812 - 88 = 724, inner 652, content 652; left round(247.76) -> floor 260; right 652 - 16 - 260 = 376;
      // columns floor(388 / 152 = 2.55) = 2; tile floor(364 / 2) = 182; preview 162.
      // hero: 0.8 cap (height for hero = 375 - 21 - 56 - 16 - 126 = 156 -> 1.27, width 0.972)
      name: 'an iPhone X-class phone, 812x375, insets 44/44/21',
      width: 812,
      height: 375,
      insets: { top: 0, right: 44, bottom: 21, left: 44 },
      paddingLeft: 44 + 16,
      paddingRight: 44 + 56,
      leftPaneWidth: 260,
      rightPaneWidth: 376,
      columns: 2,
      tileWidth: 182,
      previewWidth: 162,
      heroScale: 0.8
    },
    {
      // usable 1194, inner 1122, content min(1122, 1100) = 1100, slack 11; left round(418) -> ceiling 340; right 1100 - 16 - 340 = 744;
      // columns floor(756 / 152 = 4.97) -> capped 3; tile floor((744 - 24) / 3) = 240; preview 220.
      // hero: tall -> may reach 1 (height for hero 834 - 24 - 20 - 56 - 16 - 126 = 592 -> 4.81, width 324/251 = 1.29)
      name: 'an iPad, 1194x834',
      width: 1194,
      height: 834,
      insets: { top: 24, right: 0, bottom: 20, left: 0 },
      paddingLeft: 16 + 11,
      paddingRight: 56 + 11,
      leftPaneWidth: 340,
      rightPaneWidth: 744,
      columns: 3,
      tileWidth: 240,
      previewWidth: 220,
      heroScale: 1
    },
    {
      // usable 1440, inner 1368, content 1100 (capped), slack 134; panes as on the iPad
      name: 'a desktop browser, 1440x900',
      width: 1440,
      height: 900,
      insets: NO_INSETS,
      paddingLeft: 16 + 134,
      paddingRight: 56 + 134,
      leftPaneWidth: 340,
      rightPaneWidth: 744,
      columns: 3,
      tileWidth: 240,
      previewWidth: 220,
      heroScale: 1
    },
    {
      // usable 2560 - 96 = 2464, inner 2392, content 1100 (capped), slack (2392 - 1100) / 2 = 646; panes as above
      name: 'a huge window, 2560x1300, asymmetric insets',
      width: 2560,
      height: 1300,
      insets: { top: 0, right: 34, bottom: 0, left: 62 },
      paddingLeft: 62 + 16 + 646,
      paddingRight: 34 + 56 + 646,
      leftPaneWidth: 340,
      rightPaneWidth: 744,
      columns: 3,
      tileWidth: 240,
      previewWidth: 220,
      heroScale: 1
    }
  ]

  it.each(cases)('$name', ({ width, height, insets, paddingLeft, paddingRight, leftPaneWidth, rightPaneWidth, columns, tileWidth, previewWidth, heroScale }) => {
    const layout = computeHomeLayout(width, height, insets)
    expect(layout.isWide).toBe(true)
    expect(layout.paddingLeft).toBe(paddingLeft)
    expect(layout.paddingRight).toBe(paddingRight)
    expect(layout.leftPaneWidth).toBe(leftPaneWidth)
    expect(layout.rightPaneWidth).toBe(rightPaneWidth)
    expect(layout.columns).toBe(columns)
    expect(layout.tileWidth).toBe(tileWidth)
    expect(layout.previewWidth).toBe(previewWidth)
    expect(layout.heroScale).toBe(heroScale)
    expect(layout.titleFontSize).toBe(HOME_WIDE_TITLE_FONT_SIZE)
  })
})

describe('computeHomeLayout - content cap and centring', () => {
  it('leaves no slack when the inner width is exactly the cap', () => {
    // inner = 1172 - 72 = 1100
    const layout = computeHomeLayout(1172, 800, NO_INSETS)
    expect(layout.paddingLeft).toBe(HOME_WIDE_EDGE_PADDING)
    expect(layout.paddingRight).toBe(HOME_WIDE_RIGHT_GUTTER)
  })

  it('starts splitting the overflow into equal halves one point past the cap', () => {
    // inner = 1173 - 72 = 1101 -> slack 0.5 on each side
    const layout = computeHomeLayout(1173, 800, NO_INSETS)
    expect(layout.paddingLeft).toBe(HOME_WIDE_EDGE_PADDING + 0.5)
    expect(layout.paddingRight).toBe(HOME_WIDE_RIGHT_GUTTER + 0.5)
  })

  it.each([
    [1440, 900, NO_INSETS],
    [1920, 1080, NO_INSETS],
    [2560, 1300, { top: 0, right: 34, bottom: 0, left: 62 }],
    [2560, 1300, { top: 0, right: 62, bottom: 0, left: 34 }]
  ] as [number, number, LayoutInsets][])('%ix%i %j: the panes sit in the middle at exactly the cap with equal empty margins on both sides', (width, height, insets) => {
    const layout = computeHomeLayout(width, height, insets)
    // the two panes plus the gap fill the capped content width exactly
    expect(layout.leftPaneWidth + HOME_WIDE_PANE_GAP + layout.rightPaneWidth).toBe(HOME_WIDE_MAX_CONTENT_WIDTH)
    // strip each side own fixed part (edge / cog gutter + inset) and the margin left over is the same on both
    const leftMargin = layout.paddingLeft - insets.left - HOME_WIDE_EDGE_PADDING
    const rightMargin = layout.paddingRight - insets.right - HOME_WIDE_RIGHT_GUTTER
    expect(leftMargin).toBeGreaterThan(0)
    expect(leftMargin).toBe(rightMargin)
    expect(rowWidth(layout)).toBe(width)
  })

  it('does not grow the panes past the cap: a huge window lays out exactly like the cap-sized one', () => {
    const atCap = computeHomeLayout(1400, 900, NO_INSETS)
    const huge = computeHomeLayout(3000, 900, NO_INSETS)
    expect(huge.leftPaneWidth).toBe(atCap.leftPaneWidth)
    expect(huge.rightPaneWidth).toBe(atCap.rightPaneWidth)
    expect(huge.columns).toBe(atCap.columns)
    expect(huge.tileWidth).toBe(atCap.tileWidth)
  })
})

describe('computeHomeLayout - left pane and grid columns', () => {
  it('clamps the left pane to its floor on a narrow window and to its ceiling on a wide one', () => {
    expect(computeHomeLayout(667, 375, NO_INSETS).leftPaneWidth).toBe(HOME_LEFT_PANE_MIN)
    expect(computeHomeLayout(1194, 834, NO_INSETS).leftPaneWidth).toBe(HOME_LEFT_PANE_MAX)
  })

  // Right pane widths at which the column count steps: 2 columns need 2 * 140 + 12 = 292, 3 need 3 * 140 + 24 = 444.
  it.each([
    // no insets, height 400: inner = width - 72; the left pane sits at its 260 floor (420 wide is the exception: only
    // 348 - 16 - 140 = 192 is spare for it) -> right = inner - 16 - left
    { width: 420, columns: 1, rightPaneWidth: 140, tileWidth: 140 },
    { width: 639, columns: 1, rightPaneWidth: 291, tileWidth: 291 },
    { width: 640, columns: 2, rightPaneWidth: 292, tileWidth: 140 },
    // inner = 741: left round(281.58) = 282 -> right 443, a single point short of a third column
    { width: 813, columns: 2, rightPaneWidth: 443, tileWidth: 215 },
    // inner = 742: left round(281.96) = 282 -> right 444, exactly three tiles of the minimum width
    { width: 814, columns: 3, rightPaneWidth: 444, tileWidth: 140 }
  ])('$width wide: the grid steps to $columns column(s) at right pane $rightPaneWidth ($tileWidth per tile)', ({ width, columns, rightPaneWidth, tileWidth }) => {
    const layout = computeHomeLayout(width, 400, NO_INSETS)
    expect(layout.rightPaneWidth).toBe(rightPaneWidth)
    expect(layout.columns).toBe(columns)
    expect(layout.tileWidth).toBe(tileWidth)
  })

  it('never uses more than HOME_MAX_COLUMNS however wide the right pane gets', () => {
    expect(computeHomeLayout(2560, 1300, NO_INSETS).columns).toBe(HOME_MAX_COLUMNS)
  })
})

describe('computeHomeLayout - invariants across footprints', () => {
  const footprints: [string, number, number, LayoutInsets][] = [
    ['phone +90', 874, 402, { top: 0, right: 34, bottom: 0, left: 62 }],
    ['phone -90', 874, 402, { top: 0, right: 62, bottom: 0, left: 34 }],
    ['small phone', 667, 375, NO_INSETS],
    ['iPhone X-class', 812, 375, { top: 0, right: 44, bottom: 21, left: 44 }],
    ['iPad', 1194, 834, { top: 24, right: 0, bottom: 20, left: 0 }],
    ['desktop', 1440, 900, NO_INSETS],
    ['huge', 2560, 1300, { top: 0, right: 34, bottom: 0, left: 62 }],
    ['just wide', 601, 600, NO_INSETS],
    ['two-column threshold', 640, 400, NO_INSETS],
    ['three-column threshold', 814, 400, NO_INSETS],
    ['at the cap', 1172, 800, NO_INSETS],
    ['one past the cap', 1173, 800, NO_INSETS],
    ['tiny but workable', 420, 400, NO_INSETS],
    ['minimum with a left pane', 320, 300, NO_INSETS],
    ['barely wide enough for a row', 88, 50, NO_INSETS]
  ]

  // Whenever the inner width (window - insets - edge - gutter) is at least the pane gap, nothing is clamped
  // away and the row is EXACTLY the window: paddingLeft + left pane + gap + right pane + paddingRight === width.
  it.each(footprints)('%s (%ix%i): the row adds back up to exactly the window width', (_name, width, height, insets) => {
    const layout = computeHomeLayout(width, height, insets)
    expect(width - insets.left - insets.right - HOME_WIDE_EDGE_PADDING - HOME_WIDE_RIGHT_GUTTER).toBeGreaterThanOrEqual(HOME_WIDE_PANE_GAP)
    expect(rowWidth(layout)).toBe(width)
  })

  it.each(footprints)('%s (%ix%i): every measurement is non-negative and the grid is coherent', (_name, width, height, insets) => {
    const layout = computeHomeLayout(width, height, insets)
    for (const value of [layout.paddingLeft, layout.paddingRight, layout.leftPaneWidth, layout.rightPaneWidth, layout.tileWidth, layout.previewWidth]) {
      expect(value).toBeGreaterThanOrEqual(0)
    }
    expect(Number.isFinite(layout.heroScale)).toBe(true)
    expect(layout.columns).toBeGreaterThanOrEqual(1)
    expect(layout.columns).toBeLessThanOrEqual(HOME_MAX_COLUMNS)
    expect(Number.isInteger(layout.columns)).toBe(true)
    if (layout.columns >= 2) expect(layout.tileWidth).toBeGreaterThanOrEqual(HOME_MIN_TILE_WIDTH)
    // the tiles and their gaps never spill out of the right pane
    expect(layout.columns * layout.tileWidth + (layout.columns - 1) * HOME_GRID_GAP).toBeLessThanOrEqual(layout.rightPaneWidth)
    // the preview is the tile minus its padding on both sides
    expect(layout.previewWidth).toBe(Math.max(0, layout.tileWidth - 2 * HOME_TILE_PADDING))
  })

  it.each(footprints)('%s (%ix%i): the right pane always has room for a whole minimum-width tile', (_name, width, height, insets) => {
    const layout = computeHomeLayout(width, height, insets)
    const inner = width - insets.left - insets.right - HOME_WIDE_EDGE_PADDING - HOME_WIDE_RIGHT_GUTTER
    // the left pane gives way before the grid does, whenever the window can hold a left-pane-less row at all
    if (inner >= HOME_WIDE_PANE_GAP + HOME_MIN_TILE_WIDTH) expect(layout.rightPaneWidth).toBeGreaterThanOrEqual(HOME_MIN_TILE_WIDTH)
  })

  it('previewWidth is tileWidth minus 2 * HOME_TILE_PADDING for every real tile', () => {
    for (const [, width, height, insets] of footprints) {
      const layout = computeHomeLayout(width, height, insets)
      if (layout.tileWidth >= 2 * HOME_TILE_PADDING) expect(layout.previewWidth).toBe(layout.tileWidth - 2 * HOME_TILE_PADDING)
    }
    expect(computeHomeLayout(874, 402, { top: 0, right: 34, bottom: 0, left: 62 }).previewWidth).toBe(205 - 2 * HOME_TILE_PADDING)
  })

  it('keeps the left pane inside its floor..ceiling whenever there is room for both it and a tile', () => {
    for (const [, width, height, insets] of footprints) {
      const layout = computeHomeLayout(width, height, insets)
      const inner = width - insets.left - insets.right - HOME_WIDE_EDGE_PADDING - HOME_WIDE_RIGHT_GUTTER
      const content = Math.min(inner, HOME_WIDE_MAX_CONTENT_WIDTH)
      if (content >= HOME_LEFT_PANE_MIN + HOME_WIDE_PANE_GAP + HOME_MIN_TILE_WIDTH) {
        expect(layout.leftPaneWidth).toBeGreaterThanOrEqual(HOME_LEFT_PANE_MIN)
        expect(layout.leftPaneWidth).toBeLessThanOrEqual(HOME_LEFT_PANE_MAX)
      }
    }
  })
})

describe('computeHomeLayout - tiny and degenerate wide windows', () => {
  it('420x400 yields one exactly-minimum-width column and a shrunken left pane, with nothing negative', () => {
    // usable 420, inner 348, content 348; the left pane wants 260 but only 348 - 16 - 140 = 192 is spare
    // for it; right = 348 - 16 - 192 = 140; columns floor(152 / 152) = 1; tile 140; preview 120
    const layout = computeHomeLayout(420, 400, NO_INSETS)
    expect(layout.isWide).toBe(true)
    expect(layout.leftPaneWidth).toBe(192)
    expect(layout.rightPaneWidth).toBe(140)
    expect(layout.columns).toBe(1)
    expect(layout.tileWidth).toBe(140)
    expect(layout.previewWidth).toBe(120)
    expect(rowWidth(layout)).toBe(420)
  })

  it('drops the left pane entirely, keeping a narrower single tile, when even a minimum tile does not fit beside it', () => {
    // 140x100: inner 68, content 68 -> nothing spare for a left pane; right = 68 - 16 = 52
    const layout = computeHomeLayout(140, 100, NO_INSETS)
    expect(layout.leftPaneWidth).toBe(0)
    expect(layout.rightPaneWidth).toBe(52)
    expect(layout.columns).toBe(1)
    expect(layout.tileWidth).toBe(52)
    expect(layout.previewWidth).toBe(32)
    expect(rowWidth(layout)).toBe(140)
  })

  // Below the row's own fixed parts (edge + gutter + gap = 88pt with no insets) there is nothing to lay out:
  // the panes collapse to 0 and only the paddings remain, which is an unavoidable overflow of the row -
  // so the sum invariant is deliberately NOT asserted here. What must still hold: nothing negative, nothing NaN,
  // one column, and the panes never claim more than the window can give them.
  it.each([
    [80, 50, NO_INSETS],
    [60, 50, NO_INSETS],
    [40, 30, NO_INSETS],
    [120, 100, { top: 0, right: 40, bottom: 0, left: 40 }],
    [200, 150, { top: 20, right: 60, bottom: 20, left: 60 }]
  ] as [number, number, LayoutInsets][])('%ix%i %j: collapses gracefully - non-negative, one column, no NaN', (width, height, insets) => {
    const layout = computeHomeLayout(width, height, insets)
    expect(layout.isWide).toBe(true)
    for (const value of [layout.paddingLeft, layout.paddingRight, layout.leftPaneWidth, layout.rightPaneWidth, layout.tileWidth, layout.previewWidth, layout.heroScale, layout.columns]) {
      expect(Number.isFinite(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
    }
    expect(layout.columns).toBe(1)
    const inner = Math.max(0, width - insets.left - insets.right - HOME_WIDE_EDGE_PADDING - HOME_WIDE_RIGHT_GUTTER)
    expect(layout.leftPaneWidth + layout.rightPaneWidth).toBeLessThanOrEqual(Math.max(0, inner - HOME_WIDE_PANE_GAP))
    expect(layout.tileWidth).toBeLessThanOrEqual(layout.rightPaneWidth)
  })

  it('collapses every measurement it can to exactly 0 once the inner width is gone', () => {
    const layout = computeHomeLayout(60, 50, NO_INSETS)
    expect(layout.leftPaneWidth).toBe(0)
    expect(layout.rightPaneWidth).toBe(0)
    expect(layout.tileWidth).toBe(0)
    expect(layout.previewWidth).toBe(0)
    // only the paddings are left, and they never go negative
    expect(layout.paddingLeft).toBe(HOME_WIDE_EDGE_PADDING)
    expect(layout.paddingRight).toBe(HOME_WIDE_RIGHT_GUTTER)
  })
})

describe('computeHomeLayout - heroScale', () => {
  const shortWindows: [number, number, LayoutInsets][] = [
    [874, 402, { top: 0, right: 34, bottom: 0, left: 62 }],
    [667, 375, NO_INSETS],
    [812, 375, { top: 0, right: 44, bottom: 21, left: 44 }],
    [1194, 499, NO_INSETS],
    [2560, 499, NO_INSETS]
  ]

  it.each(shortWindows)('is capped at 0.8 on a window shorter than 500pt (%ix%i %j)', (width, height, insets) => {
    expect(computeHomeLayout(width, height, insets).heroScale).toBeLessThanOrEqual(0.8)
  })

  it('reaches the full size only from a 500pt-tall window up', () => {
    // 1194: the left pane is 340 wide -> (340 - 16) / 251 = 1.291, so only the height cap can hold it below 1
    expect(computeHomeLayout(1194, 499, NO_INSETS).heroScale).toBe(0.8)
    expect(computeHomeLayout(1194, 500, NO_INSETS).heroScale).toBe(1)
  })

  it.each([
    [1194, 834, { top: 24, right: 0, bottom: 20, left: 0 }],
    [1440, 900, NO_INSETS],
    [2560, 1300, NO_INSETS]
  ] as [number, number, LayoutInsets][])('is 1 (its natural size) on a tall wide window (%ix%i)', (width, height, insets) => {
    expect(computeHomeLayout(width, height, insets).heroScale).toBe(1)
  })

  it('is limited by the available height when that is the tightest bound', () => {
    // 874x280: 280 - 56 (trophy band) - 16 - 126 = 82 -> 82 / 123 = 0.667 (< the 0.8 cap and the width bound of 1.004)
    expect(computeHomeLayout(874, 280, { top: 0, right: 34, bottom: 0, left: 62 }).heroScale).toBeCloseTo(82 / HERO_FAN_HEIGHT, 10)
    // the top/bottom insets eat into that height too: 82 - 5 - 5 = 72 -> 72 / 123 = 0.585
    expect(computeHomeLayout(874, 280, { top: 5, right: 34, bottom: 5, left: 62 }).heroScale).toBeCloseTo(72 / HERO_FAN_HEIGHT, 10)
  })

  it('is limited by the left pane width when that is the tightest bound', () => {
    // 420x400: left pane 192 -> (192 - 16) / 251 = 0.701 (height allows 1.51, cap 0.8)
    expect(computeHomeLayout(420, 400, NO_INSETS).heroScale).toBeCloseTo(176 / HERO_FAN_SPAN, 10)
  })

  it.each([
    [874, 200, NO_INSETS],
    [874, 100, NO_INSETS],
    [874, 320, { top: 40, right: 34, bottom: 40, left: 62 }],
    [380, 370, NO_INSETS],
    [120, 100, NO_INSETS]
  ] as [number, number, LayoutInsets][])('never drops below HOME_HERO_MIN_SCALE, even when the height (or width) runs out (%ix%i %j)', (width, height, insets) => {
    const layout = computeHomeLayout(width, height, insets)
    expect(layout.heroScale).toBeGreaterThanOrEqual(HOME_HERO_MIN_SCALE)
    expect(layout.heroScale).toBe(HOME_HERO_MIN_SCALE)
  })

  it('never exceeds 1', () => {
    for (const [width, height] of [
      [1194, 834],
      [2560, 1300],
      [1000, 2000],
      [3000, 900]
    ]) {
      expect(computeHomeLayout(width, height, NO_INSETS).heroScale).toBeLessThanOrEqual(1)
    }
  })

  // The hero row must fit in the left pane: at any scale above the floor its span leaves the pane its 16pt
  // of breathing room; the floor itself is the one place it may crowd the pane (a window too small to help).
  it.each([
    [874, 402, { top: 0, right: 34, bottom: 0, left: 62 }],
    [667, 375, NO_INSETS],
    [420, 400, NO_INSETS],
    [1194, 834, NO_INSETS],
    [1440, 900, NO_INSETS],
    [500, 380, NO_INSETS],
    [380, 370, NO_INSETS]
  ] as [number, number, LayoutInsets][])('is never wider than the left pane allows (%ix%i %j)', (width, height, insets) => {
    const layout = computeHomeLayout(width, height, insets)
    if (layout.heroScale > HOME_HERO_MIN_SCALE) {
      expect(layout.heroScale * HERO_FAN_SPAN).toBeLessThanOrEqual(layout.leftPaneWidth - HERO_PANE_BREATHING_ROOM + 1e-9)
    } else {
      // at the floor: the pane may be too small for the hero's 16pt of breathing room, but still holds its span
      expect(layout.heroScale).toBe(HOME_HERO_MIN_SCALE)
      expect(layout.heroScale * HERO_FAN_SPAN).toBeLessThanOrEqual(layout.leftPaneWidth)
    }
  })
})
