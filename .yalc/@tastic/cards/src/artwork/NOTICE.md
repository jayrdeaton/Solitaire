# Card artwork attribution

The club, heart, and spade pips in this folder are derived from
[SVG-cards](https://github.com/htdebeer/SVG-cards) (the diamond pip is an original,
hand-authored replacement):

- Copyright (C) 2005 David Bellot
- Copyright (C) 2016, 2017 Huub de Beer
- Licensed under the GNU Lesser General Public License 2.1 (see `LICENSE`)

Per the original author: "the license is the LGPL so you can use this set of
cards even in a non-free software."

The full-colour "decorated" card style (`artwork/decorated/`) is generated
directly from the same SVG-cards source deck via
`scripts/generate-card-artwork.mjs` - every card face (Ace-King, all four
suits) and its illustrated court figures are derived from that project, not
just the pips.

The "compact" style's court figure silhouettes (`artwork/court.ts`) are also
derived from the same source deck, via `scripts/generate-court-silhouette.mjs`
- one suit's king/queen/jack illustration flattened to a single-colour
outline (see CourtFigure.tsx), not hand-drawn originals.

The "Ornate" and "Plain" card back styles (`artwork/backs.ts`, selectable in
Settings alongside the original "Geometric" design) are generated from the
same source deck's own `back`/`alternate-back` designs via
`scripts/generate-card-back.mjs` - see DecoratedCardBack.tsx.

This notice must be kept with any distributed copy of this artwork (e.g. an
in-app credits/about screen), per the LGPL-2.1's notice-preservation terms.

The decorated card style's numerals (Ace and 2-10) are set in the source
sheet's own referenced font, DejaVu Serif Bold, bundled via the
`dejavu-fonts-ttf` npm package and preloaded in `useFontsPreload.ts`:

- Fonts are (C) 2003 Bitstream, Inc. DejaVu's own changes are in the public
  domain. Bitstream Vera is a trademark of Bitstream, Inc.
- Licensed under the Bitstream Vera Fonts license (see
  `node_modules/dejavu-fonts-ttf/LICENSE`), which permits free use,
  modification and redistribution provided this copyright and trademark
  notice is kept with any distributed copy of the typeface.
