import type { DeviceMotionModule } from '@tastic/core'

/** Wraps a DeviceMotion module so it goes quiet while locked - the whole of what "Lock Orientation"
 * has to do here.
 *
 * @tastic/core's OrientationProvider commits ONE shared orientation reading for the whole app, from
 * the samples this feeds it, and every consumer (the game's rotated view, the status bar, the
 * overlays, the hud dialogs) reads that same value. Withholding samples while locked therefore
 * freezes that shared reading at whatever it last committed - for every consumer at once, including
 * a screen that mounts AFTER the lock was set (which the per-call-site `locked` argument on
 * useOrientationState/useRotation can't do: a call site that mounts while locked snapshots the LIVE
 * reading, not the locked one). Unlocking just resumes the feed, and the provider's own hold-steady
 * debounce takes it from there.
 *
 * Returns a stable `deviceMotion` (the provider's subscription effect depends on the module's
 * identity, so it must not change when the setting does) plus a `setLocked` to follow a setting that
 * changes at runtime without re-subscribing to the sensor. */
export function createLockableDeviceMotion(source: DeviceMotionModule, initiallyLocked = false): { deviceMotion: DeviceMotionModule; setLocked: (locked: boolean) => void } {
  let locked = initiallyLocked
  return {
    deviceMotion: {
      setUpdateInterval: (intervalMs) => source.setUpdateInterval(intervalMs),
      addListener: (listener) =>
        source.addListener((measurement) => {
          if (!locked) listener(measurement)
        })
    },
    setLocked: (next) => {
      locked = next
    }
  }
}
