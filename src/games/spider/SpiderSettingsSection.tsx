import { SegmentedButtons } from '@rific/feedback-press'

import { SettingsSection } from '@/components/SettingsSection'
import { useSettings } from '@/hooks/useSettings'

export function SpiderSettingsSection() {
  const { settings, setSettings } = useSettings()
  return (
    <SettingsSection label='SPIDER'>
      <SegmentedButtons value={String(settings.spiderSuits)} onValueChange={(v) => setSettings({ spiderSuits: Number(v) as 1 | 2 | 4 })} buttons={[1, 2, 4].map((n) => ({ value: String(n), label: `${n} suit${n > 1 ? 's' : ''}` }))} />
    </SettingsSection>
  )
}
