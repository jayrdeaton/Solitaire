import { useRotation } from '@tastic/core'
import { StatusBar } from 'expo-status-bar'

/** The status bar for a game screen: always light (the felt is dark-toned in every appearance mode
 * - see theme.ts - so the default `auto` style flips to dark text in a light-mode system and reads
 * poorly against it), and hidden whenever the board is visually rotated.
 *
 * The OS status bar is glued to the device's physical top edge and can't rotate with the content,
 * so under RotatedGameView's +/-90deg or 180deg rotation a visible one renders sideways or
 * upside-down against a board that's otherwise correctly compensated. Same rule as @tastic/core's
 * RotationAwareStatusBar (which the rest of the fleet uses), reimplemented here only because the
 * installed release has no `style` prop to keep the bar light (the next @tastic/core release adds
 * one - swap to it then); reads the same useRotation() reading RotatedGameView itself does, so the two
 * can never disagree. Mounted from withGameProviders
 * rather than the root layout because only game screens rotate - the menu/achievements/profiles
 * never do, so hiding the bar there while the phone is merely held sideways would be wrong. */
export function GameStatusBar() {
  const rotation = useRotation()
  return <StatusBar style='light' hidden={rotation !== 0} />
}
