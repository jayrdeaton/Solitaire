// Hand-authored outline glyphs for the tarot card style (src/stores/settings.tsx's `cardStyle`,
// value 'tarot'), mapping each engine suit onto its traditional tarot Minor Arcana counterpart: hearts->cups,
// diamonds->coins (pentacles), clubs->wands, spades->swords. Original artwork - not derived from
// the SVG-cards source pips.ts's other three entries use.
//
// Like every entry in pips.ts, these paths are authored upside-down: SuitPip renders every suit
// (this table's and pips.ts's alike) through the same unconditional `rotate(180)`, so a path here
// traces the mirror image of the glyph's actual on-screen appearance.

import type { Suit } from '../types'
import type { OutlineArt } from './types'

export const tarotPipArt: Record<Suit, OutlineArt> = {
  // Cups (replaces hearts): a goblet - wide bowl, narrow stem, flared foot.
  hearts: {
    viewBox: [-7.15, -7.9, 14.3, 15.8],
    paths: ['M7.15,7.9 L-7.15,7.9 C-7.15,3.5 -1.54,1.5 -1.54,-1.0 L-1.54,-4.6 L-4.73,-6.5 L-4.73,-7.9 L4.73,-7.9 L4.73,-6.5 L1.54,-4.6 L1.54,-1.0 C1.54,1.5 7.15,3.5 7.15,7.9 Z']
  },
  // Coins/pentacles (replaces diamonds): a disc with a 5-point star punched out of its center. One
  // path, two subpaths (circle then star) wound in opposite directions - the default nonzero fill
  // rule then renders their overlap as a hole (showing the card face behind it) rather than a
  // second solid shape, without needing a fillRule prop on SuitPip's <Path>.
  diamonds: {
    viewBox: [-7.7, -7.7, 15.4, 15.4],
    paths: ['M7.7,0 A7.7,7.7 0 1,1 -7.7,0 A7.7,7.7 0 1,1 7.7,0 Z M0,4 L0.940,1.294 L3.804,1.236 L1.522,-0.494 L2.351,-3.236 L0,-1.6 L-2.351,-3.236 L-1.522,-0.494 L-3.804,1.236 L-0.940,1.294 Z']
  },
  // Wands (replaces clubs): a slender diagonal wedge, tapering gradually from a small rounded
  // grip to a blunted (not razor-sharp) tip - reads as a slim wooden branch/staff.
  clubs: {
    viewBox: [-6.7, -6.7, 13.4, 13.4],
    paths: ['M-6.578,6.152 L4.242,-5.656 L5.656,-4.242 L-6.152,6.578 Z', 'M6.249,-4.949 A1.3,1.3 0 1,1 3.649,-4.949 A1.3,1.3 0 1,1 6.249,-4.949 Z']
  },
  // Swords (replaces spades): a slender diagonal blade, crossguard and pommel, with the
  // crossguard set well down the blade (a long blade, short hilt) - also the pip whose reskin is
  // truest to its own root: the spade glyph's name comes from "spada", Italian for sword.
  // Diagonal (rather than upright) so the blade reads as longer within the same box; kept thin
  // so it reads as a rapier-like blade rather than a thick dagger.
  spades: {
    viewBox: [-7.5, -7.5, 15, 15],
    paths: ['M-7.261,7.261 L2.849,-4.504 L0.919,-6.434 L1.655,-7.169 L3.768,-5.055 L5.607,-6.893 L5.790,-7.445 L7.261,-7.261 L7.445,-5.790 L6.893,-5.607 L5.055,-3.768 L7.169,-1.655 L6.434,-0.919 L4.504,-2.849 Z']
  }
}

// Each tarot suit gets its own ink instead of the standard deck's shared red/black pair (the two
// suits that share a Color in cardColor() - hearts/diamonds are still 'red', clubs/spades still
// 'black' - keep doing so for Klondike/FreeCell's alternating-color placement rule; only the ink
// shown to the player changes, the same way a 4-color deck re-tints suits without touching which
// pairs count as "alternating"). Chosen for roughly the same lightness/saturation as pips.ts's
// CARD_INK_RED so no suit reads lighter/weaker than the others against the card face.
export const tarotInk: Record<Suit, string> = {
  hearts: '#1B5FA8', // cups: blue
  diamonds: '#C68A00', // coins: gold
  clubs: '#7B4E2E', // wands: brown
  spades: '#5A6570' // swords: silver (steel-grey - swords correspond to Air, not Earth, in the
  // traditional tarot elemental correspondences, so green was the odd one out of the four)
}
