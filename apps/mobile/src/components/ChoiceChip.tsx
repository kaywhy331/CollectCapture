import { Pressable, StyleSheet, Text } from "react-native";
import { colors, radius, spacing, typography } from "../theme";

interface ChoiceChipProps {
  label: string;
  selected: boolean;
  onPress(): void;
  accessibilityHint?: string;
}

export function ChoiceChip({
  label,
  selected,
  onPress,
  accessibilityHint,
}: ChoiceChipProps) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.selected,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.label, selected && styles.selectedLabel]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    minHeight: 48,
    justifyContent: "center",
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  selected: {
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  pressed: { opacity: 0.75 },
  label: { ...typography.caption, color: colors.ink, fontWeight: "700" },
  selectedLabel: { color: colors.primary },
});
