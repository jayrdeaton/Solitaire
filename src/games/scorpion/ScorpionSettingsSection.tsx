import { SegmentedButtons } from '@rific/feedback-press'

import { SettingsSection } from '@/components/SettingsSection'
import { useSettings } from '@/stores/settings'

export function ScorpionSettingsSection() {
  const { settings, updateSettings } = useSettings()
  return (
    <SettingsSection label='SCORPION'>
      <SegmentedButtons
        value={settings.scorpionAssistedStock ? 'assisted' : 'classic'}
        onValueChange={(v) => updateSettings({ scorpionAssistedStock: v === 'assisted' })}
        buttons={[
          { value: 'assisted', label: 'Assisted' },
          { value: 'classic', label: 'Classic' }
        ]}
      />
    </SettingsSection>
  )
}
