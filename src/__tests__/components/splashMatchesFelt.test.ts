import { darkColors, lightColors } from '@/components/theme'

import appJson from '../../../app.json'

// The native splash screen is compiled into the binary and painted before any JS runs, so it cannot know which
// profile is active (or read anything from the app at all) - the only way the launch hands off to the app without
// a visible jump is for the felt to be the exact same green as the splash's `backgroundColor`, light and dark.
// The two live in different worlds (app.json vs theme.ts) with no shared source, so this pins them together.
function splashConfig(): { backgroundColor: string; dark: { backgroundColor: string } } {
  const plugin = appJson.expo.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-splash-screen') as [string, { backgroundColor: string; dark: { backgroundColor: string } }] | undefined
  if (!plugin) throw new Error('expo-splash-screen plugin config not found in app.json')
  return plugin[1]
}

describe('splash screen vs felt', () => {
  it('light splash background is the light felt', () => {
    expect(splashConfig().backgroundColor.toLowerCase()).toBe(lightColors.tableFelt.toLowerCase())
  })

  it('dark splash background is the dark felt', () => {
    expect(splashConfig().dark.backgroundColor.toLowerCase()).toBe(darkColors.tableFelt.toLowerCase())
  })
})
