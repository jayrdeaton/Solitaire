import { createGate } from '@rific/splash-gate';

export const { markReady: markSplashReady, useReady: useSplashReady, pendingGates: pendingSplashGates, Gate: SplashGate } =
  createGate(['theme', 'appSettings', 'profiles', 'haptics', 'sound', 'fonts', 'lastActiveGame'] as const);
