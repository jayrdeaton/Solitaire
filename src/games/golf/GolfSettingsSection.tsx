import { SegmentedButtons } from '@rific/feedback-press'

import { SettingsSection } from '@/components/SettingsSection'
import { useSettings } from '@/stores/settings'

export function GolfSettingsSection() {
  const { settings, updateSettings } = useSettings()
  return (
    <SettingsSection label='GOLF'>
      <SegmentedButtons
        value={settings.golfRankWrap ? 'wrap' : 'nowrap'}
        onValueChange={(v) => updateSettings({ golfRankWrap: v === 'wrap' })}
        buttons={[
          { value: 'nowrap', label: 'No Wrap' },
          { value: 'wrap', label: 'K-A Wrap' }
        ]}
      />
    </SettingsSection>
  )
}
