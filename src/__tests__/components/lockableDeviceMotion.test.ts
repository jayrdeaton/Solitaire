import type { DeviceMotionListener, DeviceMotionMeasurement, DeviceMotionModule } from '@tastic/core'

import { createLockableDeviceMotion } from '@/components/lockableDeviceMotion'

function fakeSource() {
  let listener: ((m: DeviceMotionMeasurement) => void) | null = null
  const remove = jest.fn()
  const source: DeviceMotionModule = {
    setUpdateInterval: jest.fn(),
    addListener: (l): DeviceMotionListener => {
      listener = l
      return { remove }
    }
  }
  return { source, emit: (m: DeviceMotionMeasurement) => listener?.(m), remove }
}

const SAMPLE: DeviceMotionMeasurement = { accelerationIncludingGravity: { x: -9.8, y: 0 } }

describe('createLockableDeviceMotion', () => {
  it('forwards samples while unlocked', () => {
    const { source, emit } = fakeSource()
    const received: DeviceMotionMeasurement[] = []
    createLockableDeviceMotion(source).deviceMotion.addListener((m) => received.push(m))
    emit(SAMPLE)
    expect(received).toEqual([SAMPLE])
  })

  it('drops samples while locked and resumes when unlocked, without resubscribing', () => {
    const { source, emit } = fakeSource()
    const received: DeviceMotionMeasurement[] = []
    const { deviceMotion, setLocked } = createLockableDeviceMotion(source)
    deviceMotion.addListener((m) => received.push(m))
    emit(SAMPLE)
    setLocked(true)
    emit({ accelerationIncludingGravity: { x: 0, y: -9.8 } })
    emit({ accelerationIncludingGravity: { x: 9.8, y: 0 } })
    expect(received).toEqual([SAMPLE])
    setLocked(false)
    emit({ accelerationIncludingGravity: { x: 0, y: -9.8 } })
    expect(received).toHaveLength(2)
  })

  it('starts locked when constructed locked (a persisted lock survives relaunch)', () => {
    const { source, emit } = fakeSource()
    const received: DeviceMotionMeasurement[] = []
    createLockableDeviceMotion(source, true).deviceMotion.addListener((m) => received.push(m))
    emit(SAMPLE)
    expect(received).toEqual([])
  })

  it('passes setUpdateInterval and subscription removal straight through', () => {
    const { source, remove } = fakeSource()
    const wrapped = createLockableDeviceMotion(source).deviceMotion
    wrapped.setUpdateInterval(100)
    expect(source.setUpdateInterval).toHaveBeenCalledWith(100)
    wrapped.addListener(() => {}).remove()
    expect(remove).toHaveBeenCalledTimes(1)
  })
})
