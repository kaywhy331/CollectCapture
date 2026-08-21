import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { AppButton } from "../../src/components/AppButton";
import { AppCard } from "../../src/components/AppCard";
import { Screen } from "../../src/components/Screen";
import { api } from "../../src/lib/api";
import { useHousehold } from "../../src/providers/HouseholdProvider";
import { colors, radius, spacing, typography } from "../../src/theme";

export default function HomeScreen() {
  const { activeHousehold } = useHousehold();
  const progress = useQuery({
    queryKey: ["home-progress", activeHousehold?.id],
    enabled: Boolean(activeHousehold),
    queryFn: () => api.getHomeSummary(activeHousehold!.id),
  });
  const notifications = useQuery({
    queryKey: ["notifications", activeHousehold?.id],
    enabled: Boolean(activeHousehold),
    queryFn: () => api.listNotifications(activeHousehold!.id),
    refetchInterval: 15_000,
  });
  return (
    <Screen
      eyebrow="Your clear-out"
      title={activeHousehold?.name ?? "LocalClear"}
    >
      <View style={styles.progressCard}>
        <View style={styles.metric}>
          <Text style={styles.metricValue}>
            {progress.data?.clearedThisMonth ?? "—"}
          </Text>
          <Text style={styles.metricLabel}>cleared this month</Text>
        </View>
        <View style={styles.metric}>
          <Text style={styles.metricValue}>
            {progress.data
              ? `$${(progress.data.recoveredCents / 100).toLocaleString(
                  undefined,
                  {
                    maximumFractionDigits: 0,
                  },
                )}`
              : "—"}
          </Text>
          <Text style={styles.metricLabel}>recovered</Text>
        </View>
        <View style={styles.metric}>
          <Text style={styles.metricValue}>
            {progress.data?.readyToList ?? "—"}
          </Text>
          <Text style={styles.metricLabel}>ready to list</Text>
        </View>
        <View style={styles.metric}>
          <Text style={styles.metricValue}>
            {progress.data?.buyerTasks ?? "—"}
          </Text>
          <Text style={styles.metricLabel}>buyers need replies</Text>
        </View>
        <View style={styles.metric}>
          <Text style={styles.metricValue}>
            {progress.data?.removalTasks ?? "—"}
          </Text>
          <Text style={styles.metricLabel}>removal tasks</Text>
        </View>
      </View>

      <AppCard
        title="Start with a photo"
        subtitle="We’ll ask for a label or damage photo only when it helps."
      >
        <AppButton
          label="Photograph something to clear"
          onPress={() =>
            router.push({
              pathname: "/(tabs)/capture",
              params: { mode: "single" },
            })
          }
        />
        <AppButton
          label="Clear a whole space"
          variant="secondary"
          onPress={() =>
            router.push({
              pathname: "/(tabs)/capture",
              params: { mode: "batch" },
            })
          }
        />
      </AppCard>

      {(notifications.data?.notifications ?? []).some(
        (notification) => !notification.readAt,
      ) ? (
        <AppCard title="Needs your attention">
          {(notifications.data?.notifications ?? [])
            .filter((notification) => !notification.readAt)
            .slice(0, 5)
            .map((notification) => (
              <View key={notification.id} style={styles.notice}>
                <View style={styles.noticeText}>
                  <Text style={styles.noticeTitle}>{notification.title}</Text>
                  <Text style={styles.noticeBody}>{notification.body}</Text>
                </View>
                <AppButton
                  label="Review"
                  variant="quiet"
                  onPress={() => {
                    void api.markNotificationRead(
                      activeHousehold!.id,
                      notification.id,
                    );
                    if (notification.actionPath) {
                      router.push(notification.actionPath as never);
                    }
                  }}
                />
              </View>
            ))}
        </AppCard>
      ) : null}

      {progress.error ? (
        <AppCard title="Couldn’t refresh progress">
          <Text accessibilityRole="alert" style={styles.error}>
            {progress.error.message}
          </Text>
          <AppButton
            label="Try again"
            variant="secondary"
            onPress={() => void progress.refetch()}
          />
        </AppCard>
      ) : null}

      <Text style={styles.promise}>
        Local sales only. No shipping, checkout, or payment-account setup.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  progressCard: {
    flexDirection: "row",
    flexWrap: "wrap",
    backgroundColor: colors.ink,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  metric: { flexGrow: 1, flexBasis: "28%", gap: spacing.xs },
  metricValue: { ...typography.title, color: colors.white },
  metricLabel: { ...typography.caption, color: "#DDE6E0" },
  error: { ...typography.body, color: colors.danger },
  promise: { ...typography.caption, color: colors.muted, textAlign: "center" },
  notice: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  noticeText: { flex: 1, gap: spacing.xs },
  noticeTitle: { ...typography.body, color: colors.ink, fontWeight: "700" },
  noticeBody: { ...typography.caption, color: colors.muted },
});
