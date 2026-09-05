// AUTO-GENERATED from SVG-cards (https://github.com/htdebeer/SVG-cards),
// (c) 2005 David Bellot, (c) 2016-2017 Huub de Beer, LGPL-2.1.
// See src/components/cards/artwork/NOTICE.md and LICENSE for attribution.
// Do not hand-edit; regenerate with the extraction script if the source deck changes.

/** A single-colour outline shape (suit pips, court figures), coloured by the caller at render time. */
export interface OutlineArt {
  viewBox: [number, number, number, number]
  paths: string[]
}

/** Shared fields every decorated-art shape carries (its own colour, unlike OutlineArt's paths). */
interface DecoratedShapeCommon {
  fill?: string
  stroke?: string
  strokeWidth?: number
  transform?: string
}

export type DecoratedShape =
  | (DecoratedShapeCommon & {
      tag: 'g'
      children: DecoratedShape[]
      /** Rectangular clip [x, y, width, height], in this group's own coordinate space. Used to
       * restrict a "second copy, for the overlap it contributes" group (see
       * scripts/generate-court-figures.mjs) to just the region that's relevant, without dropping
       * whole shapes that happen to extend slightly past that region - a real geometric clip
       * (unlike an all-or-nothing per-shape bounding-box filter) correctly keeps the part of a
       * shape that's inside even when the rest of it isn't. */
      clipRect?: [number, number, number, number]
    })
  | (DecoratedShapeCommon & { tag: 'path'; d: string })
  | (DecoratedShapeCommon & { tag: 'circle'; cx: number; cy: number; r: number })
  | (DecoratedShapeCommon & { tag: 'rect'; x: number; y: number; width: number; height: number })
  | (DecoratedShapeCommon & { tag: 'line'; x1: number; y1: number; x2: number; y2: number })
  | (DecoratedShapeCommon & { tag: 'polygon' | 'polyline'; points: string })
  | (DecoratedShapeCommon & {
      tag: 'text'
      content: string
      x?: number
      y?: number
      fontFamily?: string
      fontWeight?: string
      fontSize?: number
    })

/**
 * Full-colour illustrated card art (the "decorated" card style), pre-flattened so it renders as
 * plain react-native-svg elements - no <use>/xlink:href, no runtime XML parsing. Unlike
 * OutlineArt, colour is baked into each shape rather than supplied by the caller.
 */
export interface DecoratedArt {
  viewBox: [number, number, number, number]
  shapes: DecoratedShape[]
}

/**
 * A card back (see generate-card-back.mjs). Split into two pieces, not one flat `shapes` list like
 * DecoratedArt: `base` is the sheet's own #base card-frame at its natural size, and `body` is
 * everything else (the recolourable design), rendered inset within it - keeping them separate lets
 * the body get its own margin transform without also double-shrinking the frame it's meant to sit
 * inside, since #base already carries its own inset from the sheet's true edge.
 */
export interface BackArt {
  viewBox: [number, number, number, number]
  base: DecoratedShape
  body: DecoratedShape
}
