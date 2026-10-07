import { SegmentedButtons } from '@rific/feedback-press'

import { SettingsSection } from '@/components/SettingsSection'
import { useSettings } from '@/hooks/useSettings'

export function GolfSettingsSection() {
  const { settings, setSettings } = useSettings()
  return (
    <SettingsSection label='GOLF'>
      <SegmentedButtons
        value={settings.golfRankWrap ? 'wrap' : 'nowrap'}
        onValueChange={(v) => setSettings({ golfRankWrap: v === 'wrap' })}
        buttons={[
          { value: 'nowrap', label: 'No Wrap' },
          { value: 'wrap', label: 'K-A Wrap' }
        ]}
      />
    </SettingsSection>
  )
}
