import { useMutation, useQuery } from "@tanstack/react-query";
import type { PublishingJob } from "@localclear/domain";
import { useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { AppButton } from "../src/components/AppButton";
import { AppCard } from "../src/components/AppCard";
import { ChoiceChip } from "../src/components/ChoiceChip";
import { Screen } from "../src/components/Screen";
import { StatusBadge } from "../src/components/StatusBadge";
import { api } from "../src/lib/api";
import { useHousehold } from "../src/providers/HouseholdProvider";
import { colors, spacing, typography } from "../src/theme";

export default function BatchPublishScreen() {
  const { activeHousehold } = useHousehold();
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);
  const [jobs, setJobs] = useState<PublishingJob[]>([]);
  const candidates = useQuery({
    queryKey: ["publish-candidates", activeHousehold?.id],
    enabled: Boolean(activeHousehold),
    queryFn: () => api.listPublishCandidates(activeHousehold!.id),
  });
  const connectors = useQuery({
    queryKey: ["connectors"],
    enabled: Boolean(activeHousehold),
    queryFn: () => api.listConnectors(),
  });
  const devices = useQuery({
    queryKey: ["devices", activeHousehold?.id],
    enabled: Boolean(activeHousehold),
    queryFn: () => api.listDevices(activeHousehold!.id),
  });
  const activeDevice = devices.data?.devices.find(
    (device) => device.isPrimary && !device.revokedAt,
  );
  const availableConnectors = useMemo(
    () =>
      (connectors.data?.connectors ?? []).filter(
        (connector) =>
          connector.enabled &&
          connector.capabilities.publish &&
          connector.policyStatus !== "disabled" &&
          (connector.kind !== "android" || Boolean(activeDevice)),
      ),
    [activeDevice, connectors.data],
  );
  const publish = useMutation({
    mutationFn: async () => {
      if (!activeHousehold) throw new Error("Household is unavailable");
      const selected = (candidates.data?.candidates ?? []).filter((value) =>
        selectedItems.includes(value.item.id),
      );
      const needsDevice = availableConnectors.some(
        (connector) =>
          selectedPlatforms.includes(connector.platform) &&
          connector.kind === "android",
      );
      return api.publishBatch(
        activeHousehold.id,
        selected.map(({ item, listing }) => ({
          itemId: item.id,
          listingVersion: listing.version,
          platforms: selectedPlatforms,
          sellerDeviceId: needsDevice ? (activeDevice?.id ?? null) : null,
        })),
      );
    },
    onSuccess: ({ results }) => {
      setJobs(
        results.flatMap((result) => result.jobs.map((value) => value.job)),
      );
    },
  });

  if (!activeHousehold) {
    return (
      <Screen title="Batch publish">
        <Text style={styles.error}>Finish household setup first.</Text>
      </Screen>
    );
  }

  if (jobs.length > 0) {
    return (
      <Screen title="Batch queued" eyebrow="Visible, resumable jobs">
        <AppCard
          subtitle={`${jobs.length} item-platform jobs were created or safely reused.`}
        >
          {jobs.map((job) => (
            <View key={job.id} style={styles.jobRow}>
              <Text style={styles.body}>{job.platform}</Text>
              <StatusBadge
                label={job.currentState.replaceAll("_", " ")}
                tone="neutral"
              />
            </View>
          ))}
        </AppCard>
      </Screen>
    );
  }

  const ready = candidates.data?.candidates ?? [];
  return (
    <Screen title="Batch publish" eyebrow="Approve the set once">
      {candidates.isLoading || connectors.isLoading ? (
        <ActivityIndicator color={colors.primary} size="large" />
      ) : null}
      <AppCard
        title="Ready items"
        subtitle="Every item already has its own approved, versioned canonical listing."
      >
        {ready.map(({ item, listing }) => (
          <ChoiceChip
            key={item.id}
            label={`${item.title} · v${listing.version}`}
            selected={selectedItems.includes(item.id)}
            onPress={() =>
              setSelectedItems((current) =>
                current.includes(item.id)
                  ? current.filter((value) => value !== item.id)
                  : [...current, item.id],
              )
            }
          />
        ))}
        {ready.length === 0 && !candidates.isLoading ? (
          <Text style={styles.note}>No approved items are waiting.</Text>
        ) : null}
      </AppCard>
      <AppCard title="Destinations">
        <View style={styles.chips}>
          {availableConnectors.map((connector) => (
            <ChoiceChip
              key={connector.id}
              label={connector.platform}
              selected={selectedPlatforms.includes(connector.platform)}
              onPress={() =>
                setSelectedPlatforms((current) =>
                  current.includes(connector.platform)
                    ? current.filter((value) => value !== connector.platform)
                    : [...current, connector.platform],
                )
              }
            />
          ))}
        </View>
      </AppCard>
      {publish.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {publish.error.message}
        </Text>
      ) : null}
      <AppButton
        label={`Queue ${selectedItems.length} item${selectedItems.length === 1 ? "" : "s"}`}
        loading={publish.isPending}
        disabled={selectedItems.length === 0 || selectedPlatforms.length === 0}
        onPress={() => publish.mutate()}
      />
      <Text style={styles.note}>
        Duplicate prevention, connector policy gates, and rate caps are checked
        for every item and destination.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  jobRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  body: { ...typography.body, color: colors.ink, flex: 1 },
  note: { ...typography.caption, color: colors.muted },
  error: { ...typography.body, color: colors.danger },
});
