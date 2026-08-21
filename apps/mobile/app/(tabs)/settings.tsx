import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { Share, StyleSheet, Text, View } from "react-native";
import { AppButton } from "../../src/components/AppButton";
import { AppCard } from "../../src/components/AppCard";
import { AppField } from "../../src/components/AppField";
import { Screen } from "../../src/components/Screen";
import { api } from "../../src/lib/api";
import { useAuth } from "../../src/providers/AuthProvider";
import { useHousehold } from "../../src/providers/HouseholdProvider";
import { colors, spacing, typography } from "../../src/theme";

export default function SettingsScreen() {
  const { user, signOut } = useAuth();
  const { activeHousehold } = useHousehold();
  const [error, setError] = useState<string | null>(null);
  const [showDelete, setShowDelete] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [supportActorId, setSupportActorId] = useState("");
  const [diagnosticConsent, setDiagnosticConsent] = useState(false);
  const queryClient = useQueryClient();
  const supportGrants = useQuery({
    queryKey: ["support-grants", activeHousehold?.id],
    enabled: Boolean(activeHousehold),
    queryFn: () => api.listSupportGrants(activeHousehold!.id),
  });
  const createSupportGrant = useMutation({
    mutationFn: () =>
      api.createSupportGrant(activeHousehold!.id, {
        supportActorId: supportActorId.trim(),
        reasonCode: "user_requested_troubleshooting",
        scope: diagnosticConsent
          ? ["job_metadata", "device_health", "diagnostic_artifacts"]
          : ["job_metadata", "device_health"],
        durationMinutes: 30,
        diagnosticConsentConfirmation: diagnosticConsent
          ? "I CONSENT TO REDACTED DIAGNOSTICS"
          : null,
      }),
    onSuccess: async () => {
      setSupportActorId("");
      setDiagnosticConsent(false);
      await queryClient.invalidateQueries({
        queryKey: ["support-grants", activeHousehold?.id],
      });
    },
  });
  const revokeSupportGrant = useMutation({
    mutationFn: (grantId: string) =>
      api.revokeSupportGrant(activeHousehold!.id, grantId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["support-grants", activeHousehold?.id],
      });
    },
  });
  const exportAccount = useMutation({
    mutationFn: () => api.exportAccount(),
    onSuccess: async (payload) => {
      await Share.share({
        title: "LocalClear account export",
        message: JSON.stringify(payload.export, null, 2),
      });
    },
  });
  const deleteAccount = useMutation({ mutationFn: () => api.deleteAccount() });

  if (deleteAccount.data) {
    return (
      <Screen title="Account deleted" eyebrow="Deletion receipt">
        <AppCard
          title="Cloud deletion is complete"
          subtitle={`Receipt ${deleteAccount.data.receipt.receiptId}`}
        >
          <Text style={styles.body}>
            {deleteAccount.data.deletedMediaCount} private media object(s)
            deleted, {deleteAccount.data.revokedDeviceCount} Seller Hub key(s)
            revoked, and {deleteAccount.data.cancelledJobCount} active job(s)
            cancelled.
          </Text>
          <Text style={styles.body}>
            {deleteAccount.data.localInstructions}
          </Text>
          <AppButton
            label="Clear this app and finish"
            onPress={() =>
              void signOut().finally(() => {
                queryClient.clear();
                router.replace("/");
              })
            }
          />
        </AppCard>
      </Screen>
    );
  }

  return (
    <Screen title="Settings">
      <AppCard
        title={activeHousehold?.name ?? "Household"}
        {...(user?.email ? { subtitle: user.email } : {})}
      >
        {activeHousehold ? (
          <View style={styles.details}>
            <Text style={styles.detail}>ZIP {activeHousehold.zipCode}</Text>
            <Text style={styles.detail}>
              {activeHousehold.sellingRadiusMiles}-mile radius
            </Text>
            <Text style={styles.detail}>
              Minimum offers:{" "}
              {activeHousehold.priceRules.defaultMinimumOfferPercent}%
            </Text>
          </View>
        ) : null}
      </AppCard>

      <AppCard title="Connections">
        <AppButton
          label="Seller Hub and platforms"
          variant="secondary"
          onPress={() => router.push("/connections")}
        />
        <AppButton
          label="Meetup and availability"
          variant="secondary"
          onPress={() => router.push("/meetup")}
        />
      </AppCard>

      <AppCard
        title="Privacy and control"
        subtitle="Marketplace sessions stay on your Seller Hub."
      >
        <Text style={styles.body}>
          LocalClear stores connection health—not marketplace passwords,
          cookies, or payment accounts.
        </Text>
        <AppButton
          label="Export my data"
          variant="quiet"
          loading={exportAccount.isPending}
          onPress={() => exportAccount.mutate()}
        />
        {exportAccount.error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {exportAccount.error.message}
          </Text>
        ) : null}
        {!showDelete ? (
          <AppButton
            label="Delete my account"
            variant="danger"
            onPress={() => setShowDelete(true)}
          />
        ) : (
          <View style={styles.deletePanel}>
            <Text style={styles.body}>
              This revokes Seller Hubs, cancels jobs, deletes private cloud
              media and data, and removes your LocalClear sign-in. Marketplace
              app accounts are not deleted.
            </Text>
            <AppField
              label='Type "DELETE MY ACCOUNT"'
              value={confirmation}
              autoCapitalize="characters"
              onChangeText={setConfirmation}
            />
            {deleteAccount.error ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {deleteAccount.error.message}
              </Text>
            ) : null}
            <AppButton
              label="Permanently delete account"
              variant="danger"
              loading={deleteAccount.isPending}
              disabled={confirmation !== "DELETE MY ACCOUNT"}
              onPress={() => deleteAccount.mutate()}
            />
            <AppButton
              label="Cancel"
              variant="quiet"
              onPress={() => {
                setShowDelete(false);
                setConfirmation("");
              }}
            />
          </View>
        )}
      </AppCard>

      <AppCard
        title="Temporary support access"
        subtitle="There is no standing employee access. A grant expires after 30 minutes and can be revoked now."
      >
        {(supportGrants.data?.grants ?? [])
          .filter(
            (grant) =>
              grant.revokedAt === null &&
              new Date(grant.expiresAt).getTime() > Date.now(),
          )
          .map((grant) => (
            <View key={grant.id} style={styles.grantRow}>
              <View style={styles.flex}>
                <Text style={styles.detail}>{grant.supportActorId}</Text>
                <Text style={styles.body}>
                  {grant.scope.join(", ")} · expires{" "}
                  {new Date(grant.expiresAt).toLocaleTimeString()}
                </Text>
              </View>
              <AppButton
                label="Revoke"
                variant="danger"
                disabled={revokeSupportGrant.isPending}
                onPress={() => revokeSupportGrant.mutate(grant.id)}
              />
            </View>
          ))}
        <AppField
          label="Support agent ID"
          placeholder="Provided by your support agent"
          value={supportActorId}
          autoCapitalize="none"
          onChangeText={setSupportActorId}
        />
        <Text style={styles.body}>
          Basic access includes only device health and redacted job metadata—no
          passwords, sessions, exact locations, or buyer messages.
        </Text>
        <AppButton
          label={
            diagnosticConsent
              ? "Redacted diagnostics: consented"
              : "Allow redacted diagnostics too"
          }
          variant={diagnosticConsent ? "secondary" : "quiet"}
          onPress={() => setDiagnosticConsent((value) => !value)}
        />
        {diagnosticConsent ? (
          <Text style={styles.warning}>
            You consent to this assigned support agent viewing only diagnostic
            images you separately privacy-scan, redact, and choose to upload.
          </Text>
        ) : null}
        <AppButton
          label="Grant access for 30 minutes"
          loading={createSupportGrant.isPending}
          disabled={!activeHousehold || !supportActorId.trim()}
          onPress={() => createSupportGrant.mutate()}
        />
        {supportGrants.error ||
        createSupportGrant.error ||
        revokeSupportGrant.error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {
              (
                supportGrants.error ??
                createSupportGrant.error ??
                revokeSupportGrant.error
              )?.message
            }
          </Text>
        ) : null}
      </AppCard>

      <AppButton
        label="Sign out"
        variant="secondary"
        onPress={() =>
          void signOut().catch((caught: unknown) => {
            setError(
              caught instanceof Error ? caught.message : "Could not sign out",
            );
          })
        }
      />
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  details: { gap: spacing.xs },
  detail: { ...typography.body, color: colors.ink },
  body: { ...typography.body, color: colors.muted },
  deletePanel: { gap: spacing.sm },
  grantRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  flex: { flex: 1 },
  warning: { ...typography.caption, color: colors.danger, fontWeight: "700" },
  error: { ...typography.caption, color: colors.danger },
});
