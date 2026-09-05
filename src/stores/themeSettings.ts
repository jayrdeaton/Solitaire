import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ThemeSettings } from '@rific/auto-paper';

const KEY = 'solitaire.theme-settings.v1';

export async function loadThemeSettings(): Promise<Partial<ThemeSettings> | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Partial<ThemeSettings>) : null;
  } catch {
    return null;
  }
}

export async function saveThemeSettings(settings: ThemeSettings): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(settings));
}
