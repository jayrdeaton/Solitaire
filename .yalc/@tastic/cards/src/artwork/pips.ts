// Club, heart, and spade paths are AUTO-GENERATED from SVG-cards
// (https://github.com/htdebeer/SVG-cards), (c) 2005 David Bellot, (c) 2016-2017 Huub de
// Beer, LGPL-2.1. See src/components/cards/artwork/LICENSE for the full license text.
// Do not hand-edit those three; regenerate with the extraction script if the source
// deck changes. The diamond is a hand-authored replacement (plain rhombus) - the
// original SVG-cards diamond has softly convex (bulging) edges that read fine as a
// small corner pip but look puffy/odd blown up to a big center pip.

import type { Suit } from '../types'
import type { OutlineArt } from './types'

export const suitPipArt: Record<Suit, OutlineArt> = {
  clubs: {
    viewBox: [-7.71, -7.94, 15.42, 15.88],
    paths: ['M3.35,4.66c0-1.81-1.51-3.28-3.38-3.28s-3.38,1.47-3.38,3.28c0,1.81,1.51,3.28,3.38,3.28S3.35,6.47,3.35,4.66z', 'M7.71-1.55c0-1.81-1.51-3.28-3.38-3.28S0.95-3.36,0.95-1.55c0,1.81,1.51,3.28,3.38,3.28S7.71,0.26,7.71-1.55z', 'M-0.95-1.57c0-0.66-0.2-1.28-0.55-1.8c-0.6-0.89-1.65-1.48-2.83-1.48c-1.87,0-3.38,1.47-3.38,3.28 c0,1.81,1.51,3.28,3.38,3.28S-0.95,0.24-0.95-1.57z', 'M3.94-7.94c-1.67,0-2.55,1.36-3.01,2.72C0.47-3.86,0.43-2.5,0.43-2.5h-0.86c0,0-0.16-5.43-3.5-5.44H3.94z', 'M-2.32,2.25c1.9-1.9,1.9-4.75,1.9-4.75l0.85-0.01c0,0,0,2.91,1.85,4.76', 'M-1.94-3.85c1.9,1.9,4.75,1.9,4.75,1.9v0.85c0,0-2.91,0-4.76,1.85', 'M1.87-3.86c-1.9,1.9-4.75,1.9-4.75,1.9v0.85c0,0,2.91,0,4.76,1.85']
  },
  diamonds: {
    // Taller than it is wide on purpose (unlike the other three suits, which are all
    // close to square) - a diamond this close to 1:1 reads as a rotated square rather
    // than a classic elongated diamond.
    viewBox: [-7.68, -9.5, 15.36, 19],
    paths: ['M0,-9.5 L7.68,0 L0,9.5 L-7.68,0 Z']
  },
  hearts: {
    viewBox: [-7.67, -7.94, 15.34, 15.88],
    paths: ['M-7.67,3.93c0.01-4.71,5.91-8.14,7.64-11.87c1.75,3.72,7.66,7.12,7.7,11.83c0.01,2.22-1.71,4.03-3.82,4.03C1.73,7.92,0,6.13,0,3.91c0,2.23-1.71,4.03-3.82,4.03C-5.94,7.95-7.66,6.15-7.67,3.93z']
  },
  spades: {
    viewBox: [-6.75, -7.93, 13.5, 15.86],
    paths: ['M3.92-7.93c-1.67,0-2.55,1.78-3.01,3.56c-0.46,1.78-0.5,3.56-0.5,3.56L-0.44-0.8c0,0-0.16-7.13-3.5-7.13H3.92z', 'M6.75-0.8C6.74,2.67,1.53,5.19,0,7.93C-1.53,5.18-6.74,2.66-6.75-0.8c0-1.64,1.51-2.97,3.38-2.97C-1.51-3.77,0-2.44,0-0.8c0-1.64,1.51-2.97,3.38-2.97S6.75-2.44,6.75-0.8z']
  }
}
