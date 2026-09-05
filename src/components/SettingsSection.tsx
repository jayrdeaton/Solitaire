import { useAutoPaperTheme } from '@rific/auto-paper';
import { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

interface SettingsSectionProps {
  // Omit when the section's own content is self-explanatory without one (e.g. a labeled row of
  // card previews) - not every group needs a caption repeating what's already legible below it.
  label?: string;
  children: ReactNode;
}

// Renders inside BaseSettingsDialog's own MD3 card (see SettingsDialog.tsx), so this uses
// useAutoPaperTheme's colors.* tokens - the same ones that dialog's own built-in rows use - rather
// than Solitaire's felt-table useTableColors().
export function SettingsSection({ label, children }: SettingsSectionProps) {
  const { colors } = useAutoPaperTheme();
  return (
    <View style={styles.section}>
      {label && (
        <Text variant="labelMedium" style={[styles.label, { color: colors.onSurfaceVariant }]}>
          {label}
        </Text>
      )}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    letterSpacing: 2,
  },
  section: {
    gap: 12,
  },
});
