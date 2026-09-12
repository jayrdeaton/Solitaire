import { SegmentedButtons } from '@rific/feedback-press'

import { SettingsSection } from '@/components/SettingsSection'
import { useSettings } from '@/stores/settings'

export function FortyThievesSettingsSection() {
  const { settings, updateSettings } = useSettings()
  return (
    <SettingsSection label='FORTY THIEVES'>
      <SegmentedButtons
        value={settings.fortyThievesRunMoves ? 'runs' : 'single'}
        onValueChange={(v) => updateSettings({ fortyThievesRunMoves: v === 'runs' })}
        buttons={[
          { value: 'single', label: 'Single Card' },
          { value: 'runs', label: 'Allow Runs' }
        ]}
      />
    </SettingsSection>
  )
}
