import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ItemStatus } from "@localclear/domain";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { AppButton } from "../../src/components/AppButton";
import { AppCard } from "../../src/components/AppCard";
import { AppField } from "../../src/components/AppField";
import { ChoiceChip } from "../../src/components/ChoiceChip";
import { Screen } from "../../src/components/Screen";
import { StatusBadge } from "../../src/components/StatusBadge";
import { api } from "../../src/lib/api";
import { createMediaReadUrl } from "../../src/lib/media";
import { useHousehold } from "../../src/providers/HouseholdProvider";
import { colors, radius, spacing, typography } from "../../src/theme";

type ClearOutcome = Extract<
  ItemStatus,
  "sold" | "given_away" | "donated" | "recycled" | "discarded"
>;

const clearedStates = new Set<ItemStatus>([
  "sold",
  "given_away",
  "donated",
  "recycled",
  "discarded",
]);

export default function ItemDetailsScreen() {
  const { itemId } = useLocalSearchParams<{ itemId: string }>();
  const { activeHousehold } = useHousehold();
  const queryClient = useQueryClient();
  const [showClosure, setShowClosure] = useState(false);
  const [outcome, setOutcome] = useState<ClearOutcome>("sold");
  const [salePrice, setSalePrice] = useState("");
  const [destination, setDestination] = useState("");
  const [notes, setNotes] = useState("");
  const [showDelete, setShowDelete] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");

  const details = useQuery({
    queryKey: ["item-details", activeHousehold?.id, itemId],
    enabled: Boolean(activeHousehold && itemId),
    queryFn: () => api.getItemDetails(activeHousehold!.id, itemId!),
  });
  const leadPath = details.data?.item.media.find(
    (media) => media.isLead,
  )?.storagePath;
  const photo = useQuery({
    queryKey: ["media-url", leadPath],
    enabled: Boolean(leadPath),
    queryFn: () => createMediaReadUrl(leadPath!),
    staleTime: 8 * 60_000,
  });
  const closeItem = useMutation({
    mutationFn: async () => {
      if (!activeHousehold || !itemId) throw new Error("Item is unavailable");
      const cents = outcome === "sold" ? dollarsToCents(salePrice) : null;
      if (outcome === "sold" && cents === null) {
        throw new Error("Enter the final sale price");
      }
      return api.closeItem(activeHousehold.id, itemId, {
        outcome,
        salePriceCents: cents,
        currency: outcome === "sold" ? "USD" : null,
        destinationPlatform: destination.trim() || null,
        notes: notes.trim() || null,
      });
    },
    onSuccess: async () => {
      setShowClosure(false);
      await Promise.all([
        details.refetch(),
        queryClient.invalidateQueries({
          queryKey: ["items", activeHousehold?.id],
        }),
      ]);
    },
  });
  const lifecycle = useMutation({
    mutationFn: (action: "reserve" | "relist" | "archive") =>
      api.changeItemLifecycle(activeHousehold!.id, itemId!, action),
    onSuccess: async () => {
      await Promise.all([
        details.refetch(),
        queryClient.invalidateQueries({
          queryKey: ["items", activeHousehold?.id],
        }),
      ]);
    },
  });
  const propagate = useMutation({
    mutationFn: () => {
      const version = details.data?.latestListing?.version;
      if (!version) throw new Error("Save an approved listing first");
      return api.propagateListing(activeHousehold!.id, itemId!, version);
    },
    onSuccess: async () => {
      await details.refetch();
    },
  });
  const deleteItem = useMutation({
    mutationFn: () =>
      api.deleteItem(activeHousehold!.id, itemId!, deleteConfirmation.trim()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["items", activeHousehold?.id],
      });
      router.replace("/(tabs)/inventory");
    },
  });

  if (!activeHousehold || !itemId) {
    return (
      <Screen title="Item details">
        <Text style={styles.error}>This item is not available.</Text>
      </Screen>
    );
  }
  if (details.isLoading) {
    return (
      <Screen title="Item details">
        <ActivityIndicator color={colors.primary} size="large" />
      </Screen>
    );
  }
  if (details.error || !details.data) {
    return (
      <Screen title="Item details">
        <Text accessibilityRole="alert" style={styles.error}>
          {details.error?.message ?? "Could not load this item"}
        </Text>
        <AppButton
          label="Try again"
          variant="secondary"
          onPress={() => void details.refetch()}
        />
      </Screen>
    );
  }

  const { item, latestListing, platformListings, enrichment } = details.data;
  const isCleared = clearedStates.has(item.status);
  const canMarkSold = [
    "publishing",
    "partially_live",
    "live",
    "reserved",
  ].includes(item.status);

  return (
    <Screen title={item.title} eyebrow={item.category}>
      {photo.data ? (
        <Image
          source={{ uri: photo.data }}
          resizeMode="cover"
          accessibilityLabel={`Photo of ${item.title}`}
          style={styles.photo}
        />
      ) : null}

      <AppCard
        title="Inventory status"
        trailing={
          <StatusBadge
            label={item.status.replaceAll("_", " ")}
            tone={isCleared ? "success" : "neutral"}
          />
        }
      >
        <Text style={styles.body}>
          {item.condition.replaceAll("_", " ")} condition
          {item.storageLocation ? ` · ${item.storageLocation}` : ""}
        </Text>
        {item.defects.map((defect) => (
          <Text key={defect} style={styles.note}>
            • {defect}
          </Text>
        ))}
      </AppCard>

      {platformListings.length > 0 ? (
        <AppCard title="Platform listings">
          {platformListings.map((listing) => (
            <View key={listing.id} style={styles.listingRow}>
              <View style={styles.flex}>
                <Text style={styles.listingName}>{listing.platform}</Text>
                <Text style={styles.note}>
                  ${(listing.platformPrice.amountCents / 100).toFixed(2)} ·{" "}
                  {listing.status.replaceAll("_", " ")}
                </Text>
              </View>
              {listing.externalUrl ? (
                <AppButton
                  label="Open"
                  variant="quiet"
                  onPress={() => void Linking.openURL(listing.externalUrl!)}
                />
              ) : null}
            </View>
          ))}
        </AppCard>
      ) : null}

      {!isCleared ? (
        <AppCard
          title="Inventory actions"
          subtitle="Changes remain tied to this one canonical item. Connector updates are separate auditable jobs."
        >
          {item.status === "live" || item.status === "partially_live" ? (
            <AppButton
              label="Mark reserved"
              variant="secondary"
              loading={lifecycle.isPending}
              onPress={() => lifecycle.mutate("reserve")}
            />
          ) : null}
          {item.status === "reserved" || item.status === "archived" ? (
            <AppButton
              label="Relist item"
              variant="secondary"
              loading={lifecycle.isPending}
              onPress={() => lifecycle.mutate("relist")}
            />
          ) : null}
          {latestListing ? (
            <AppButton
              label="Edit canonical listing"
              variant="secondary"
              onPress={() =>
                router.push({
                  pathname: "/review/[itemId]",
                  params: { itemId },
                })
              }
            />
          ) : null}
          {latestListing &&
          platformListings.some((value) =>
            ["live", "reserved"].includes(value.status),
          ) ? (
            <AppButton
              label="Update live platforms from latest version"
              variant="secondary"
              loading={propagate.isPending}
              onPress={() => propagate.mutate()}
            />
          ) : null}
          {item.status !== "archived" ? (
            <AppButton
              label="Archive and remove listings"
              variant="quiet"
              loading={lifecycle.isPending}
              onPress={() => lifecycle.mutate("archive")}
            />
          ) : null}
          {["captured", "draft", "ready", "archived"].includes(item.status) ? (
            !showDelete ? (
              <AppButton
                label="Delete item and private photos"
                variant="danger"
                onPress={() => setShowDelete(true)}
              />
            ) : (
              <View style={styles.deletePanel}>
                <AppField
                  label={`Type “${item.title}” to confirm`}
                  value={deleteConfirmation}
                  onChangeText={setDeleteConfirmation}
                />
                <AppButton
                  label="Permanently delete item"
                  variant="danger"
                  loading={deleteItem.isPending}
                  disabled={deleteConfirmation.trim() !== item.title}
                  onPress={() => deleteItem.mutate()}
                />
                <AppButton
                  label="Cancel deletion"
                  variant="quiet"
                  onPress={() => {
                    setShowDelete(false);
                    setDeleteConfirmation("");
                  }}
                />
              </View>
            )
          ) : null}
          {lifecycle.error || propagate.error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {(lifecycle.error ?? propagate.error)?.message}
            </Text>
          ) : null}
          {deleteItem.error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {deleteItem.error.message}
            </Text>
          ) : null}
          {propagate.data ? (
            <Text accessibilityLiveRegion="polite" style={styles.note}>
              {propagate.data.jobs.length} platform update job
              {propagate.data.jobs.length === 1 ? "" : "s"} queued
              {propagate.data.exceptionTask
                ? "; one manual exception task was created"
                : ""}
              .
            </Text>
          ) : null}
        </AppCard>
      ) : null}

      {!latestListing ? (
        <AppButton
          label={enrichment ? "Continue review" : "Analyze and review"}
          onPress={() =>
            router.push({
              pathname: "/review/[itemId]",
              params: { itemId },
            })
          }
        />
      ) : !isCleared ? (
        <AppButton
          label="Choose publishing destinations"
          onPress={() =>
            router.push({
              pathname: "/publish/[itemId]",
              params: {
                itemId,
                listingVersion: String(latestListing.version),
              },
            })
          }
        />
      ) : null}

      {!isCleared && !showClosure ? (
        <AppButton
          label="Record how this item cleared"
          variant="secondary"
          onPress={() => {
            if (!canMarkSold && outcome === "sold") setOutcome("given_away");
            setShowClosure(true);
          }}
        />
      ) : null}

      {showClosure ? (
        <AppCard
          title="Close this item everywhere"
          subtitle="LocalClear will mark sold or delist where a permitted connector supports it, then make one task for anything left."
        >
          <View style={styles.chips}>
            {(
              [
                ...(canMarkSold ? (["sold"] as const) : []),
                "given_away",
                "donated",
                "recycled",
                "discarded",
              ] as const
            ).map((value) => (
              <ChoiceChip
                key={value}
                label={value.replaceAll("_", " ")}
                selected={outcome === value}
                onPress={() => setOutcome(value)}
              />
            ))}
          </View>
          {outcome === "sold" ? (
            <AppField
              label="Final sale price (USD)"
              value={salePrice}
              keyboardType="decimal-pad"
              onChangeText={setSalePrice}
            />
          ) : null}
          <AppField
            label="Destination or platform (optional)"
            value={destination}
            maxLength={80}
            onChangeText={setDestination}
          />
          <AppField
            label="Notes (optional)"
            value={notes}
            multiline
            maxLength={2_000}
            onChangeText={setNotes}
          />
          {closeItem.error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {closeItem.error.message}
            </Text>
          ) : null}
          <AppButton
            label={`Confirm ${outcome.replaceAll("_", " ")}`}
            loading={closeItem.isPending}
            onPress={() => closeItem.mutate()}
          />
          <AppButton
            label="Cancel"
            variant="quiet"
            onPress={() => setShowClosure(false)}
          />
        </AppCard>
      ) : null}
    </Screen>
  );
}

function dollarsToCents(value: string): number | null {
  if (!/^\d+(?:\.\d{0,2})?$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}

const styles = StyleSheet.create({
  photo: { width: "100%", aspectRatio: 4 / 3, borderRadius: radius.lg },
  body: { ...typography.body, color: colors.ink },
  note: { ...typography.caption, color: colors.muted },
  error: { ...typography.body, color: colors.danger },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  listingRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  listingName: { ...typography.body, color: colors.ink, fontWeight: "700" },
  flex: { flex: 1 },
  deletePanel: { gap: spacing.sm },
});
