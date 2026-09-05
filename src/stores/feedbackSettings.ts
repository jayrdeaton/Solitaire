import AsyncStorage from '@react-native-async-storage/async-storage';

const VIBRATE_KEY = 'solitaire.vibrate.v1';
const SOUND_KEY = 'solitaire.sound.v1';

export async function loadVibrateEnabled(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(VIBRATE_KEY);
    return raw === null ? true : raw === 'true';
  } catch {
    return true;
  }
}

export async function saveVibrateEnabled(value: boolean): Promise<void> {
  await AsyncStorage.setItem(VIBRATE_KEY, String(value)).catch(() => {});
}

export async function loadSoundFxEnabled(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(SOUND_KEY);
    return raw === null ? true : raw === 'true';
  } catch {
    return true;
  }
}

export async function saveSoundFxEnabled(value: boolean): Promise<void> {
  await AsyncStorage.setItem(SOUND_KEY, String(value)).catch(() => {});
}
