import { StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing, typography } from "../theme";

interface StatusBadgeProps {
  label: string;
  tone?: "neutral" | "success" | "warning" | "danger";
}

export function StatusBadge({ label, tone = "neutral" }: StatusBadgeProps) {
  return (
    <View
      accessibilityLabel={`Status: ${label}`}
      style={[styles.badge, styles[tone]]}
    >
      <Text style={[styles.label, styles[`${tone}Label`]]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: "flex-start",
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  neutral: { backgroundColor: colors.canvas },
  success: { backgroundColor: colors.primarySoft },
  warning: { backgroundColor: colors.accentSoft },
  danger: { backgroundColor: colors.dangerSoft },
  label: { ...typography.caption, fontWeight: "700" },
  neutralLabel: { color: colors.muted },
  successLabel: { color: colors.primary },
  warningLabel: { color: "#725015" },
  dangerLabel: { color: colors.danger },
});
