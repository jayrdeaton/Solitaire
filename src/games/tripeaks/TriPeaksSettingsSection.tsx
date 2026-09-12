import { SegmentedButtons } from '@rific/feedback-press'

import { SettingsSection } from '@/components/SettingsSection'
import { useSettings } from '@/stores/settings'

export function TriPeaksSettingsSection() {
  const { settings, updateSettings } = useSettings()
  return (
    <SettingsSection label='TRIPEAKS'>
      <SegmentedButtons
        value={settings.tripeaksRankWrap ? 'wrap' : 'nowrap'}
        onValueChange={(v) => updateSettings({ tripeaksRankWrap: v === 'wrap' })}
        buttons={[
          { value: 'nowrap', label: 'No Wrap' },
          { value: 'wrap', label: 'K-A Wrap' }
        ]}
      />
    </SettingsSection>
  )
}
