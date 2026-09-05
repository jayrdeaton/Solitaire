import { SegmentedButtons } from '@rific/feedback-press'

import { SettingsSection } from '@/components/SettingsSection'
import { useSettings } from '@/stores/settings'

export function KlondikeSettingsSection() {
  const { settings, updateSettings } = useSettings()
  return (
    <SettingsSection label='KLONDIKE'>
      <SegmentedButtons
        value={String(settings.klondikeDraw)}
        onValueChange={(v) => updateSettings({ klondikeDraw: Number(v) as 1 | 3 })}
        buttons={[
          { value: '1', label: 'Draw 1' },
          { value: '3', label: 'Draw 3' }
        ]}
      />
    </SettingsSection>
  )
}
