import { SegmentedButtons } from '@rific/feedback-press'

import { SettingsSection } from '@/components/SettingsSection'
import { useSettings } from '@/hooks/useSettings'

export function KlondikeSettingsSection() {
  const { settings, setSettings } = useSettings()
  return (
    <SettingsSection label='KLONDIKE'>
      <SegmentedButtons
        value={String(settings.klondikeDraw)}
        onValueChange={(v) => setSettings({ klondikeDraw: Number(v) as 1 | 3 })}
        buttons={[
          { value: '1', label: 'Draw 1' },
          { value: '3', label: 'Draw 3' }
        ]}
      />
    </SettingsSection>
  )
}
