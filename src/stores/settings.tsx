import AsyncStorage from '@react-native-async-storage/async-storage'
import { createContext, ReactNode, useContext, useState } from 'react'

export interface Settings {
  klondikeDraw: 1 | 3
  spiderSuits: 1 | 2 | 4
  cardStyle: 'compact' | 'decorated'
  // 'geometric' is CardBack.tsx's own original design; 'ornate'/'plain' are SVG-cards-derived (see
  // artwork/NOTICE.md), rendered via DecoratedCardBack. Independent of cardStyle above - a face
  // style choice, not a back style choice.
  cardBackStyle: 'geometric' | 'ornate' | 'plain'
}

export const DEFAULT_SETTINGS: Settings = {
  klondikeDraw: 1,
  spiderSuits: 1,
  cardStyle: 'compact',
  cardBackStyle: 'geometric'
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
