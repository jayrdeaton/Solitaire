import { SegmentedButtons } from '@rific/feedback-press'

import { SettingsSection } from '@/components/SettingsSection'
import { useSettings } from '@/hooks/useSettings'

export function FortyThievesSettingsSection() {
  const { settings, setSettings } = useSettings()
  return (
    <SettingsSection label='FORTY THIEVES'>
      <SegmentedButtons
        value={settings.fortyThievesRunMoves ? 'runs' : 'single'}
        onValueChange={(v) => setSettings({ fortyThievesRunMoves: v === 'runs' })}
        buttons={[
          { value: 'single', label: 'Single Card' },
          { value: 'runs', label: 'Allow Runs' }
        ]}
      />
    </SettingsSection>
  )
}
