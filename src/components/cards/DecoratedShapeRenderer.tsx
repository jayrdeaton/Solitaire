import React from 'react'
import { Circle, ClipPath, Defs, G, Line, Path, Polygon, Polyline, Rect, Text as SvgText, TextProps } from 'react-native-svg'

import { DecoratedShape } from './artwork/types'

// Shapes filled/stroked this close to white are the art's own card-frame background, not "ink" -
// `ink` below drops these to fully transparent rather than tinting them, so a monochrome render
// shows only the linework (border + illustration), not a solid card-shaped block sitting on top
// of whatever's behind it (e.g. an empty foundation slot's own felt-colored backdrop).
const WHITE_FILLS = new Set(['#ffffff', 'white'])

/** Resolves a shape's own fill/stroke. With `ink` set, this is a monochrome render: the white
 * card-frame background becomes transparent (`'none'`), and everything else (already-black ink,
 * or a suit's baked-in color) becomes `ink`. Without `ink`, `valueOverrides` (from
 * artwork/decoratedCustom/colors.ts's buildColorOverrideMap) substitutes a shape's own literal
 * color for a caller-supplied replacement - e.g. the "invert dark mode colors" setting swapping
 * baked-in black for white - falling through to the shape's own color unchanged for anything not
 * in the map. A shape with no color at all (`undefined`/`'none'`) stays that way in every case -
 * there's nothing to recolor. */
function resolveColor(value: string | undefined, ink: string | undefined, valueOverrides?: Record<string, string>): string | undefined {
  if (!value || value === 'none') return value
  if (ink) return WHITE_FILLS.has(value.toLowerCase()) ? 'none' : ink
  return valueOverrides?.[value] ?? value
}

/**
 * Renders a DecoratedShape tree (see artwork/types.ts) as plain react-native-svg elements - no
 * runtime XML parsing, no <use>. Shared by DecoratedCardFace (a whole decorated-style card) and
 * DecoratedCourtFigure (just a compact-style card's court figure) since both walk the same shape
 * shape produced by scripts/generate-card-artwork.mjs and scripts/generate-court-figures.mjs.
 *
 * `idPrefix` must be unique per rendered <Svg> tree (e.g. from React's useId()) - a `clipRect`'d
 * group renders a <ClipPath> with an id, and SVG ids are global to the page on web, so two card
 * instances on screen at once reusing the same id would clip whichever one the browser resolves
 * `url(#id)` against, not necessarily its own.
 *
 * `ink`, when passed, overrides every non-white fill/stroke in the tree with one flat color and
 * drops the white card-frame background to transparent (see resolveColor above) - producing a
 * linework-only, single-color "watermark" of the art rather than a solid muted card. Omit it to
 * render the art's own baked-in colors unchanged.
 *
 * `textFill`, when passed, overrides just 'text' shapes' own fill (ignored when `ink` is also set,
 * since that already recolors everything to one flat tone). Every 'text' shape in the generated
 * data - the rank-corner glyph, e.g. "A"/"10"/"K" - is hardcoded black regardless of suit: the
 * source sheet's glyphs carry no fill of their own, relying on inheriting it from a wrapping
 * <g>/<use>, and scripts/generate-card-artwork.mjs's flattening drops exactly that (only a
 * shape's own directly-set fill/stroke survives - see convert()'s 'g' case, which keeps only
 * `transform` from a wrapping group). Every other shape (the pips) sets its own fill directly, so
 * only 'text' needs this correction.
 *
 * `valueOverrides`, when passed (and `ink` is not), substitutes shape colors via
 * artwork/decoratedCustom/colors.ts's buildColorOverrideMap - e.g. the "invert dark mode colors"
 * setting swapping decoratedCustom's baked-in black for white while leaving red untouched. Ignored
 * for 'text' shapes whenever `textFill` is already set, so the red-suit numeral correction above
 * always wins over it - a red rank-corner digit is never touched by invert.
 */
export function renderDecoratedShape(shape: DecoratedShape, key: number, idPrefix: string, ink?: string, textFill?: string, valueOverrides?: Record<string, string>): React.ReactElement {
  switch (shape.tag) {
    case 'g': {
      const children = shape.children.map((child, i) => renderDecoratedShape(child, i, idPrefix, ink, textFill, valueOverrides))
      const fill = resolveColor(shape.fill, ink, valueOverrides)
      const stroke = resolveColor(shape.stroke, ink, valueOverrides)
      if (!shape.clipRect) {
        return (
          <G key={key} transform={shape.transform} fill={fill} stroke={stroke} strokeWidth={shape.strokeWidth}>
            {children}
          </G>
        )
      }
      const clipId = `${idPrefix}-clip-${key}`
      const [x, y, width, height] = shape.clipRect
      return (
        <G key={key} transform={shape.transform} fill={fill} stroke={stroke} strokeWidth={shape.strokeWidth}>
          <Defs>
            <ClipPath id={clipId}>
              <Rect x={x} y={y} width={width} height={height} />
            </ClipPath>
          </Defs>
          <G clipPath={`url(#${clipId})`}>{children}</G>
        </G>
      )
    }
    case 'path':
      return <Path key={key} d={shape.d} fill={resolveColor(shape.fill, ink, valueOverrides)} stroke={resolveColor(shape.stroke, ink, valueOverrides)} strokeWidth={shape.strokeWidth} transform={shape.transform} />
    case 'circle':
      return <Circle key={key} cx={shape.cx} cy={shape.cy} r={shape.r} fill={resolveColor(shape.fill, ink, valueOverrides)} stroke={resolveColor(shape.stroke, ink, valueOverrides)} strokeWidth={shape.strokeWidth} transform={shape.transform} />
    case 'rect':
      return <Rect key={key} x={shape.x} y={shape.y} width={shape.width} height={shape.height} fill={resolveColor(shape.fill, ink, valueOverrides)} stroke={resolveColor(shape.stroke, ink, valueOverrides)} strokeWidth={shape.strokeWidth} transform={shape.transform} />
    case 'line':
      return <Line key={key} x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} stroke={resolveColor(shape.stroke, ink, valueOverrides)} strokeWidth={shape.strokeWidth} transform={shape.transform} />
    case 'polygon':
      return <Polygon key={key} points={shape.points} fill={resolveColor(shape.fill, ink, valueOverrides)} stroke={resolveColor(shape.stroke, ink, valueOverrides)} strokeWidth={shape.strokeWidth} transform={shape.transform} />
    case 'polyline':
      return <Polyline key={key} points={shape.points} fill={resolveColor(shape.fill, ink, valueOverrides)} stroke={resolveColor(shape.stroke, ink, valueOverrides)} strokeWidth={shape.strokeWidth} transform={shape.transform} />
    case 'text':
      return (
        <SvgText key={key} x={shape.x} y={shape.y} fontFamily={shape.fontFamily} fontWeight={shape.fontWeight as TextProps['fontWeight']} fontSize={shape.fontSize} fill={ink ? resolveColor(shape.fill, ink) : (textFill ?? resolveColor(shape.fill, undefined, valueOverrides))} transform={shape.transform}>
          {shape.content}
        </SvgText>
      )
  }
}
