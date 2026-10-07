import { SegmentedButtons } from '@rific/feedback-press'

import { SettingsSection } from '@/components/SettingsSection'
import { useSettings } from '@/hooks/useSettings'

export function TriPeaksSettingsSection() {
  const { settings, setSettings } = useSettings()
  return (
    <SettingsSection label='TRIPEAKS'>
      <SegmentedButtons
        value={settings.tripeaksRankWrap ? 'wrap' : 'nowrap'}
        onValueChange={(v) => setSettings({ tripeaksRankWrap: v === 'wrap' })}
        buttons={[
          { value: 'nowrap', label: 'No Wrap' },
          { value: 'wrap', label: 'K-A Wrap' }
        ]}
      />
    </SettingsSection>
  )
}
