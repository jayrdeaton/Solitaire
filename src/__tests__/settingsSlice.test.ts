import reducer, { DEFAULT_SETTINGS, settingsActions } from '@/redux/settingsSlice'

const REHYDRATE = 'persist/REHYDRATE'

describe('settingsSlice', () => {
  it('starts from the defaults', () => {
    expect(reducer(undefined, { type: '@@INIT' })).toEqual(DEFAULT_SETTINGS)
  })

  it('merges a partial patch over the current settings', () => {
    const next = reducer(DEFAULT_SETTINGS, settingsActions.initialize({ lockOrientation: true, lockedRotation: -90 }))
    expect(next).toEqual({ ...DEFAULT_SETTINGS, lockOrientation: true, lockedRotation: -90 })
  })

  it('clears lockedRotation when unlocking', () => {
    const locked = reducer(DEFAULT_SETTINGS, settingsActions.initialize({ lockOrientation: true, lockedRotation: 180 }))
    expect(reducer(locked, settingsActions.initialize({ lockOrientation: false, lockedRotation: undefined })).lockedRotation).toBeUndefined()
  })

  // Settings saved by an older build have no value for a field added since; rehydrating must fill it
  // from the defaults rather than leave it undefined.
  it('fills fields missing from saved settings with the defaults on rehydrate', () => {
    const key = (Object.keys(DEFAULT_SETTINGS) as (keyof typeof DEFAULT_SETTINGS)[]).find((k) => k !== 'lockOrientation')!
    const saved: Partial<typeof DEFAULT_SETTINGS> = { ...DEFAULT_SETTINGS, lockOrientation: true }
    delete saved[key]
    const next = reducer(undefined, { type: REHYDRATE, payload: { settings: saved } } as { type: string })
    expect(next).toEqual({ ...DEFAULT_SETTINGS, lockOrientation: true })
  })

  it('keeps the defaults when nothing was saved', () => {
    expect(reducer(undefined, { type: REHYDRATE, payload: {} } as { type: string })).toEqual(DEFAULT_SETTINGS)
  })
})
