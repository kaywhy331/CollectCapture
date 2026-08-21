import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { AppButton } from "../../src/components/AppButton";
import { ChoiceChip } from "../../src/components/ChoiceChip";
import { Screen } from "../../src/components/Screen";
import { StatusBadge } from "../../src/components/StatusBadge";
import { api } from "../../src/lib/api";
import { useHousehold } from "../../src/providers/HouseholdProvider";
import { colors, radius, spacing, typography } from "../../src/theme";

type Filter = "active" | "cleared" | "all";
const clearedStates = new Set([
  "sold",
  "given_away",
  "donated",
  "recycled",
  "discarded",
]);

export default function InventoryScreen() {
  const { activeHousehold } = useHousehold();
  const [filter, setFilter] = useState<Filter>("active");
  const query = useQuery({
    queryKey: ["items", activeHousehold?.id],
    enabled: Boolean(activeHousehold),
    queryFn: () => api.listItems(activeHousehold!.id),
  });
  const items = (query.data?.items ?? []).filter((item) => {
    if (filter === "all") return true;
    return filter === "cleared"
      ? clearedStates.has(item.status)
      : !clearedStates.has(item.status);
  });

  return (
    <Screen title="Inventory" scroll={false}>
      <View style={styles.filters}>
        {(["active", "cleared", "all"] as const).map((value) => (
          <ChoiceChip
            key={value}
            label={value[0]!.toUpperCase() + value.slice(1)}
            selected={filter === value}
            onPress={() => setFilter(value)}
          />
        ))}
      </View>
      <AppButton
        label="Batch publish ready items"
        variant="secondary"
        onPress={() => router.push("/batch-publish")}
      />

      {query.isLoading ? (
        <ActivityIndicator color={colors.primary} size="large" />
      ) : null}
      {query.error ? (
        <View style={styles.center}>
          <Text accessibilityRole="alert" style={styles.error}>
            {query.error.message}
          </Text>
          <AppButton
            label="Try again"
            variant="secondary"
            onPress={() => void query.refetch()}
          />
        </View>
      ) : null}
      {!query.isLoading && !query.error && items.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Nothing here yet</Text>
          <Text style={styles.emptyText}>
            Photograph an item to start your clear-out.
          </Text>
          <AppButton
            label="Open camera"
            onPress={() => router.push("/(tabs)/capture")}
          />
        </View>
      ) : null}
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        refreshing={query.isRefetching}
        onRefresh={() => void query.refetch()}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.title}, ${item.status.replaceAll("_", " ")}`}
            onPress={() =>
              router.push({
                pathname: "/item/[itemId]",
                params: { itemId: item.id },
              })
            }
            style={({ pressed }) => [styles.item, pressed && styles.pressed]}
          >
            <View style={styles.thumbnail}>
              <Text aria-hidden style={styles.thumbnailText}>
                {item.title.slice(0, 1).toUpperCase()}
              </Text>
            </View>
            <View style={styles.itemText}>
              <Text numberOfLines={2} style={styles.itemTitle}>
                {item.title}
              </Text>
              <Text style={styles.category}>{item.category}</Text>
              <StatusBadge
                label={item.status.replaceAll("_", " ")}
                tone={clearedStates.has(item.status) ? "success" : "neutral"}
              />
            </View>
          </Pressable>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  filters: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  list: { gap: spacing.sm, paddingBottom: spacing.xxl },
  item: {
    flexDirection: "row",
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
  },
  pressed: { opacity: 0.72 },
  thumbnail: {
    width: 72,
    height: 72,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primarySoft,
  },
  thumbnailText: { ...typography.title, color: colors.primary },
  itemText: { flex: 1, gap: spacing.xs },
  itemTitle: { ...typography.body, color: colors.ink, fontWeight: "700" },
  category: { ...typography.caption, color: colors.muted },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
  },
  emptyTitle: { ...typography.heading, color: colors.ink },
  emptyText: { ...typography.body, color: colors.muted, textAlign: "center" },
  error: { ...typography.body, color: colors.danger, textAlign: "center" },
});
