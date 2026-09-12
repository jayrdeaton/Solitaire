import { MaterialCommunityIcons } from '@expo/vector-icons'
import { CARD_FONT_FAMILY } from '@tastic/cards'
import { useFonts } from 'expo-font'

import { useSplashReady } from '@/utils/splashGate'

// The card artwork's own font (see @tastic/cards' artwork/NOTICE.md) - re-exported from here since
// it's also used theme-wide (see _layout.tsx's ThemeProvider fontFamily prop) so the rest of the
// app's UI reads as the same "card" typeface instead of clashing with a plain system sans elsewhere.
export { CARD_FONT_FAMILY }

// Holds the splash screen up (see utils/splashGate.ts's 'fonts' gate) until every preloaded font
// has actually loaded - otherwise every react-native-paper IconButton on the very first screens
// (index.tsx's trophy/cog corner buttons, profiles.tsx's back button) would render blank for one
// visible frame before snapping in once the async load resolves, and CARD_FONT_FAMILY text - both
// decorated-mode card numerals (rendered via react-native-svg's own <Text>, see
// DecoratedShapeRenderer.tsx) and the theme-wide react-native-paper text it now also drives - would
// flash in whatever fallback serif the platform substitutes before swapping to the real face.
//
// Only the Bold weight is loaded - every generated decorated-mode text shape hard-codes
// fontWeight: "bold" (see generate-card-artwork.mjs), and there's no bundled regular weight for the
// theme-wide use to fall back to either, so every react-native-paper Text renders in this same bold
// face regardless of its own fontWeight - a deliberate one-weight-everywhere look, the same way the
// fleet's other apps apply a single MONO_FONT string with no separate regular file (see
// @tastic/hud's fonts.ts) rather than a mismatch worth revisiting if some screen ends up wanting an
// actual regular weight.
//
// Returns the loaded flag too (rather than being a pure side-effecting hook) so _layout.tsx's own
// `if (!allLoaded) return null` guard - the mechanism that blocks the JS-side tree, separate from
// the native splash screen useSplashReady hides - can fold this gate in the same way it folds in the
// other five.
export function useFontsPreload(): boolean {
  const [loaded] = useFonts({ ...MaterialCommunityIcons.font, [CARD_FONT_FAMILY]: require('dejavu-fonts-ttf/ttf/DejaVuSerif-Bold.ttf') })
  useSplashReady('fonts', loaded)
  return loaded
}
