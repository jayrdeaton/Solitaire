export interface TableColors {
  tableFelt: string
  tableFeltDark: string
  cardFace: string
  /** cardFace's counterpart for "invert dark mode colors" - a near-black face, real only on
   * darkColors; lightColors' copy just mirrors cardFace. */
  cardFaceInverted: string
  cardBack: string
  cardBackPattern: string
  /** cardBackPattern's counterpart for "invert dark mode colors" - the same profile-tinted accent,
   * pulled toward black instead of white, so a card back's pattern reads as darkened rather than
   * unchanged next to its now-near-black frame (see CardBack.tsx/DecoratedCardBack.tsx). Unlike
   * this file's other *Inverted tokens, this one is never rendered directly (same as cardBackPattern
   * itself) - it's always computed fresh in derivePlayerTableColors, gated on `dark` there (not via
   * a light/dark anchor difference), since it depends on the live profile-blended accent rather than
   * a fixed palette constant. The anchor value here is a placeholder only. */
  cardBackPatternInverted: string
  cardBorder: string
  selectedGlow: string
  textRed: string
  textBlack: string
  /** textBlack's counterpart for the "invert dark mode colors" setting (see stores/settings.tsx) -
   * a near-white ink, real only on darkColors; lightColors' copy just mirrors textBlack, so this is
   * always safe to read regardless of the setting or current appearance. Also doubles as the
   * inverted card-frame border color (compact/tarot, Decorated's #base stroke). Red suits never
   * get an inverted counterpart - the setting only ever touches black ink. */
  textBlackInverted: string
  emptySlot: string
  hintGreen: string
  /** Scrim drawn over a not-yet-playable card (e.g. a buried Pyramid card) - a translucent
   * overlay on top of the full-opacity face, rather than fading the card itself, so its rank/suit
   * stay crisp and legible instead of washing out toward the felt color. */
  dimOverlay: string
  /** dimOverlay's counterpart for "invert dark mode colors" - a translucent *black* dimOverlay
   * barely darkens an already near-black inverted face, silently erasing the dimmed/full-strength
   * distinction in exactly the mode where it matters most, so this is a translucent white wash
   * instead. Real only on darkColors; lightColors' copy mirrors dimOverlay. */
  dimOverlayInverted: string
}
