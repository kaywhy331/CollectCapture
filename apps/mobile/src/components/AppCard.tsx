import type { PropsWithChildren, ReactNode } from "react";
import { StyleSheet, Text, View, type ViewStyle } from "react-native";
import { colors, radius, shadows, spacing, typography } from "../theme";

interface AppCardProps extends PropsWithChildren {
  title?: string;
  subtitle?: string;
  trailing?: ReactNode;
  style?: ViewStyle;
}

export function AppCard({
  children,
  title,
  subtitle,
  trailing,
  style,
}: AppCardProps) {
  return (
    <View style={[styles.card, style]}>
      {title || subtitle || trailing ? (
        <View style={styles.header}>
          <View style={styles.headerText}>
            {title ? <Text style={styles.title}>{title}</Text> : null}
            {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          </View>
          {trailing}
        </View>
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.md,
    ...shadows.card,
  },
  header: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  headerText: { flex: 1, gap: spacing.xs },
  title: { ...typography.heading, color: colors.ink },
  subtitle: { ...typography.caption, color: colors.muted },
});
