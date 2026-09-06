module.exports = [
  // Auto-generated card art data (scripts/generate-card-artwork.mjs, and
  // generate-decorated-custom-pack.mjs's relabeled duplicate of it) - thousands of tiny object
  // literals, never hand-edited, not worth formatting/lint-checking. decoratedCustom/colors.ts is
  // deliberately NOT listed here - it's a real hand-written file, unlike its sibling data files.
  {
    ignores: [
      'src/components/cards/artwork/decorated/**',
      'src/components/cards/artwork/decoratedCustom/hearts.ts',
      'src/components/cards/artwork/decoratedCustom/diamonds.ts',
      'src/components/cards/artwork/decoratedCustom/clubs.ts',
      'src/components/cards/artwork/decoratedCustom/spades.ts',
      'src/components/cards/artwork/decoratedCustom/courtFigures.ts',
      'src/components/cards/artwork/decoratedCustom/index.ts'
    ]
  },
  ...require('@infinitetoken/eslint-config/expo')
]
