import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PublishingJob } from "@localclear/domain";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Share, StyleSheet, Text, View } from "react-native";
import { AppButton } from "../../src/components/AppButton";
import { AppCard } from "../../src/components/AppCard";
import { AppField } from "../../src/components/AppField";
import { ChoiceChip } from "../../src/components/ChoiceChip";
import { Screen } from "../../src/components/Screen";
import { StatusBadge } from "../../src/components/StatusBadge";
import { api } from "../../src/lib/api";
import { supabase } from "../../src/lib/supabase";
import { useHousehold } from "../../src/providers/HouseholdProvider";
import { colors, spacing, typography } from "../../src/theme";

const terminalStates = new Set(["PUBLISHED", "FAILED_FINAL", "CANCELLED"]);

export default function PublishItemScreen() {
  const { itemId, listingVersion } = useLocalSearchParams<{
    itemId: string;
    listingVersion?: string;
  }>();
  const { activeHousehold } = useHousehold();
  const version = Number(listingVersion);
  const [selected, setSelected] = useState<string[]>([]);
  const [jobs, setJobs] = useState<PublishingJob[]>([]);

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
  const available = useMemo(
    () =>
      (connectors.data?.connectors ?? []).filter(
        (connector) =>
          connector.enabled &&
          connector.capabilities.publish &&
          connector.policyStatus !== "disabled",
      ),
    [connectors.data],
  );
  const unavailable = useMemo(
    () =>
      (connectors.data?.connectors ?? []).filter(
        (connector) => !available.some((value) => value.id === connector.id),
      ),
    [available, connectors.data],
  );

  const publish = useMutation({
    mutationFn: async () => {
      if (!activeHousehold || !itemId || !Number.isInteger(version)) {
        throw new Error("The approved listing version is missing");
      }
      const needsDevice = available.some(
        (connector) =>
          selected.includes(connector.platform) && connector.kind === "android",
      );
      if (needsDevice && !activeDevice) {
        throw new Error("Pair a Seller Hub before choosing that platform");
      }
      return api.publish(activeHousehold.id, itemId, {
        platforms: selected,
        listingVersion: version,
        sellerDeviceId: needsDevice ? (activeDevice?.id ?? null) : null,
      });
    },
    onSuccess: ({ jobs: publishedJobs }) => {
      setJobs(publishedJobs.map(({ job }) => job));
    },
  });

  if (!activeHousehold || !itemId || !Number.isInteger(version)) {
    return (
      <Screen title="Choose platforms">
        <Text style={styles.error}>The approved listing is not available.</Text>
      </Screen>
    );
  }

  if (jobs.length > 0) {
    return (
      <Screen title="Publishing progress" eyebrow="Listing approved">
        {jobs.map((job) => (
          <PublishingProgress
            key={job.id}
            householdId={activeHousehold.id}
            initialJob={job}
          />
        ))}
        <AppButton
          label="View item"
          variant="secondary"
          onPress={() =>
            router.replace({
              pathname: "/item/[itemId]",
              params: { itemId },
            })
          }
        />
      </Screen>
    );
  }

  return (
    <Screen title="Where should it go?" eyebrow="Choose platforms">
      <AppCard subtitle="One approved listing becomes a separate, trackable publishing job for each selected destination.">
        {connectors.isLoading ? (
          <ActivityIndicator color={colors.primary} />
        ) : null}
        <View style={styles.chips}>
          {available.map((connector) => {
            const requiresMissingHub =
              connector.kind === "android" && !activeDevice;
            return (
              <ChoiceChip
                key={connector.id}
                label={`${connector.platform}${requiresMissingHub ? " · needs Seller Hub" : ""}`}
                selected={selected.includes(connector.platform)}
                accessibilityHint={
                  requiresMissingHub
                    ? "Pair a Seller Hub before publishing"
                    : "Toggle this publishing destination"
                }
                onPress={() => {
                  if (requiresMissingHub) {
                    router.push("/connections");
                    return;
                  }
                  setSelected((current) =>
                    current.includes(connector.platform)
                      ? current.filter((value) => value !== connector.platform)
                      : [...current, connector.platform],
                  );
                }}
              />
            );
          })}
        </View>
        {available.length === 0 && !connectors.isLoading ? (
          <Text style={styles.error}>
            No policy-approved publishing route is currently enabled.
          </Text>
        ) : null}
      </AppCard>

      {unavailable.length > 0 ? (
        <AppCard
          title="Unavailable destinations"
          subtitle="These stay off until a permitted method and approval evidence are configured."
        >
          {unavailable.map((connector) => (
            <View key={connector.id} style={styles.unavailableRow}>
              <Text style={styles.unavailableName}>{connector.platform}</Text>
              <Text style={styles.unavailableReason}>
                {connector.killSwitchReason ?? "Connector disabled"}
              </Text>
            </View>
          ))}
        </AppCard>
      ) : null}

      {publish.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {publish.error.message}
        </Text>
      ) : null}
      <AppButton
        label={`Publish to ${selected.length || "selected"} destination${selected.length === 1 ? "" : "s"}`}
        loading={publish.isPending}
        disabled={selected.length === 0}
        onPress={() => publish.mutate()}
      />
      <Text style={styles.note}>
        A queued job may pause for login, MFA, CAPTCHA, a required field, or
        final confirmation. LocalClear will show that state instead of bypassing
        it.
      </Text>
    </Screen>
  );
}

function PublishingProgress({
  householdId,
  initialJob,
}: {
  householdId: string;
  initialJob: PublishingJob;
}) {
  const [externalId, setExternalId] = useState("");
  const [externalUrl, setExternalUrl] = useState("");
  const queryClient = useQueryClient();
  const job = useQuery({
    queryKey: ["publishing-job", householdId, initialJob.id],
    queryFn: () => api.getJob(householdId, initialJob.id),
    initialData: { job: initialJob, transitions: [] },
    refetchInterval: (query) =>
      terminalStates.has(query.state.data?.job.currentState ?? "")
        ? false
        : 2_000,
  });
  useEffect(() => {
    const channel = supabase
      .channel(`publishing-job:${initialJob.id}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "publishing_jobs",
          filter: `id=eq.${initialJob.id}`,
        },
        () => {
          void queryClient.invalidateQueries({
            queryKey: ["publishing-job", householdId, initialJob.id],
          });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [householdId, initialJob.id, queryClient]);
  const state = job.data.job.currentState;
  const listingExport = useMutation({
    mutationFn: () => api.getListingExport(householdId, initialJob.id),
    onSuccess: async ({ artifact }) => {
      await Share.share({
        title: `${artifact.platform} listing package`,
        message: JSON.stringify(artifact.payload, null, 2),
      });
    },
  });
  const completeImport = useMutation({
    mutationFn: () =>
      api.completeListingImport(householdId, initialJob.id, {
        externalListingId: externalId.trim() || null,
        externalUrl: externalUrl.trim() || null,
      }),
    onSuccess: async () => {
      await job.refetch();
    },
  });
  const tone =
    state === "PUBLISHED"
      ? "success"
      : state.startsWith("NEEDS_") || state.startsWith("FAILED")
        ? "danger"
        : "neutral";

  return (
    <AppCard
      title={initialJob.platform}
      subtitle={`Listing version ${initialJob.listingVersion}`}
      trailing={<StatusBadge label={state.replaceAll("_", " ")} tone={tone} />}
    >
      <Text style={styles.note}>
        Last verified step:{" "}
        {job.data.job.lastVerifiedState.replaceAll("_", " ")}
      </Text>
      {job.data.job.errorDetail ? (
        <Text style={styles.error}>{job.data.job.errorDetail}</Text>
      ) : null}
      {state === "NEEDS_USER_CONFIRMATION" &&
      job.data.job.errorCode === "IMPORT_PACKAGE_READY" ? (
        <View style={styles.importPanel}>
          <AppButton
            label="Share prepared listing package"
            variant="secondary"
            loading={listingExport.isPending}
            onPress={() => listingExport.mutate()}
          />
          <AppField
            label="Live listing ID (or enter URL below)"
            value={externalId}
            onChangeText={setExternalId}
          />
          <AppField
            label="Live listing URL"
            value={externalUrl}
            autoCapitalize="none"
            keyboardType="url"
            onChangeText={setExternalUrl}
          />
          {listingExport.error || completeImport.error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {(listingExport.error ?? completeImport.error)?.message}
            </Text>
          ) : null}
          <AppButton
            label="I confirm this listing is live"
            loading={completeImport.isPending}
            disabled={!externalId.trim() && !externalUrl.trim()}
            onPress={() => completeImport.mutate()}
          />
        </View>
      ) : null}
    </AppCard>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  note: { ...typography.caption, color: colors.muted },
  error: { ...typography.body, color: colors.danger },
  unavailableRow: { gap: spacing.xs },
  unavailableName: { ...typography.body, color: colors.ink, fontWeight: "700" },
  unavailableReason: { ...typography.caption, color: colors.muted },
  importPanel: { gap: spacing.sm },
});
