import { SegmentedButtons } from '@rific/feedback-press'

import { SettingsSection } from '@/components/SettingsSection'
import { useSettings } from '@/hooks/useSettings'

export function ScorpionSettingsSection() {
  const { settings, setSettings } = useSettings()
  return (
    <SettingsSection label='SCORPION'>
      <SegmentedButtons
        value={settings.scorpionAssistedStock ? 'assisted' : 'classic'}
        onValueChange={(v) => setSettings({ scorpionAssistedStock: v === 'assisted' })}
        buttons={[
          { value: 'assisted', label: 'Assisted' },
          { value: 'classic', label: 'Classic' }
        ]}
      />
    </SettingsSection>
  )
}
