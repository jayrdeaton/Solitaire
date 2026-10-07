import { SegmentedButtons } from '@rific/feedback-press'

import { SettingsSection } from '@/components/SettingsSection'
import { useSettings } from '@/hooks/useSettings'

export function CanfieldSettingsSection() {
  const { settings, setSettings } = useSettings()
  return (
    <SettingsSection label='CANFIELD'>
      <SegmentedButtons
        value={String(settings.canfieldDraw)}
        onValueChange={(v) => setSettings({ canfieldDraw: Number(v) as 1 | 3 })}
        buttons={[
          { value: '1', label: 'Draw 1' },
          { value: '3', label: 'Draw 3' }
        ]}
      />
    </SettingsSection>
  )
}
