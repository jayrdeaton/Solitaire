import { useCallback } from 'react'
import { useDispatch, useSelector } from 'react-redux'

import { settingsActions } from '@/redux/settingsSlice'
import type { RootState } from '@/redux/store'
import type { Settings } from '@/types'

// The one way screens read and write the persisted settings (redux/settingsSlice.ts). setSettings
// takes a partial patch, merged over the current settings.
export function useSettings(): { settings: Settings; setSettings: (patch: Partial<Settings>) => void } {
  const settings = useSelector((state: RootState) => state.settings)
  const dispatch = useDispatch()
  const setSettings = useCallback(
    (patch: Partial<Settings>) => {
      dispatch(settingsActions.initialize(patch))
    },
    [dispatch]
  )
  return { settings, setSettings }
}
