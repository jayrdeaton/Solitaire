import AsyncStorage from '@react-native-async-storage/async-storage'
import { createContext, ReactNode, useContext, useState } from 'react'

export interface Settings {
  klondikeDraw: 1 | 3
  spiderSuits: 1 | 2 | 4
  // 'decorated' renders the full-colour illustrated deck instead of the compact corner-index +
  // big-pip layout. 'tarot' is a peer option, not a sub-mode of 'compact': the same corner-index +
  // big-pip layout, but with cups/coins/wands/swords in place of hearts/diamonds/clubs/spades -
  // hearts/diamonds/clubs/spades' historical tarot counterparts.
  cardStyle: 'compact' | 'decorated' | 'tarot'
  // 'geometric' is CardBack.tsx's own original design; 'ornate'/'plain' are SVG-cards-derived (see
  // artwork/NOTICE.md), rendered via DecoratedCardBack. Independent of cardStyle above - a face
  // style choice, not a back style choice.
  cardBackStyle: 'geometric' | 'ornate' | 'plain'
  // Dark mode only: flips black suit ink (spades/clubs) to white and the card face to near-black.
  // Red suits are never touched. A no-op in light mode (see theme.ts's textBlackInverted/
  // cardFaceInverted/dimOverlayInverted, which mirror their normal counterparts on lightColors) -
  // safe to leave on regardless of current appearance. Defaults false: today's dark mode (same
  // red/black ink as light mode) stays the default look; this is an opt-in alternative, not a
  // replacement.
  invertDarkModeColors: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  klondikeDraw: 1,
  spiderSuits: 1,
  cardStyle: 'compact',
  cardBackStyle: 'geometric',
  invertDarkModeColors: false
}

const KEY = 'solitaire.settings.v1'

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await AsyncStorage.getItem(KEY)
    if (!raw) return DEFAULT_SETTINGS
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(settings))
}

interface SettingsContextValue {
  settings: Settings
  updateSettings: (patch: Partial<Settings>) => void
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

/** Live app-wide settings, seeded from a pre-loaded `initialValue` (see _layout.tsx's splash-gate
 * loader) so every mounted screen sees a change - e.g. the card style toggle - immediately,
 * without needing to navigate away and back to pick up a fresh loadSettings() read. */
export function SettingsProvider({ initialValue, children }: { initialValue: Settings; children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(initialValue)

  const updateSettings = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    saveSettings(next)
  }

  return <SettingsContext.Provider value={{ settings, updateSettings }}>{children}</SettingsContext.Provider>
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used within a SettingsProvider')
  return ctx
}
