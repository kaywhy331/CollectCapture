import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BuyerTask } from "@localclear/domain";
import { useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { AppButton } from "../../src/components/AppButton";
import { AppCard } from "../../src/components/AppCard";
import { AppField } from "../../src/components/AppField";
import { Screen } from "../../src/components/Screen";
import { StatusBadge } from "../../src/components/StatusBadge";
import { api } from "../../src/lib/api";
import { useHousehold } from "../../src/providers/HouseholdProvider";
import { colors, spacing, typography } from "../../src/theme";

export default function BuyerTasksScreen() {
  const { activeHousehold } = useHousehold();
  const tasks = useQuery({
    queryKey: ["buyer-tasks", activeHousehold?.id],
    enabled: Boolean(activeHousehold),
    queryFn: () => api.listBuyerTasks(activeHousehold!.id),
    refetchInterval: 15_000,
  });
  const pending = (tasks.data?.tasks ?? []).filter(
    (task) =>
      task.approvalState === "pending" || task.approvalState === "approved",
  );
  const completed = (tasks.data?.tasks ?? []).filter(
    (task) =>
      task.approvalState === "sent" || task.approvalState === "rejected",
  );

  return (
    <Screen eyebrow="You stay in control" title="Buyer tasks">
      {tasks.isLoading ? (
        <ActivityIndicator color={colors.primary} size="large" />
      ) : null}
      {tasks.error ? (
        <AppCard title="Couldn’t load buyer messages">
          <Text accessibilityRole="alert" style={styles.error}>
            {tasks.error.message}
          </Text>
          <AppButton
            label="Try again"
            variant="secondary"
            onPress={() => void tasks.refetch()}
          />
        </AppCard>
      ) : null}
      {!tasks.isLoading && !tasks.error && pending.length === 0 ? (
        <AppCard
          title="No replies waiting"
          subtitle="Suggested replies always wait for your approval."
        >
          <View style={styles.empty}>
            <Text style={styles.icon} aria-hidden>
              ✓
            </Text>
            <Text style={styles.body}>
              Availability questions, offers, pickup requests, and scam warnings
              will appear here.
            </Text>
          </View>
        </AppCard>
      ) : null}
      {pending.map((task) => (
        <BuyerTaskCard
          key={task.id}
          householdId={activeHousehold!.id}
          task={task}
        />
      ))}
      {completed.length > 0 ? (
        <AppCard title="Recently handled">
          {completed.slice(0, 10).map((task) => (
            <View key={task.id} style={styles.completedRow}>
              <View style={styles.flex}>
                <Text style={styles.participant}>{task.participantAlias}</Text>
                <Text numberOfLines={1} style={styles.note}>
                  {task.intent.replaceAll("_", " ")}
                </Text>
              </View>
              <StatusBadge
                label={task.approvalState}
                tone={task.approvalState === "sent" ? "success" : "neutral"}
              />
            </View>
          ))}
        </AppCard>
      ) : null}
      <Text style={styles.note}>
        Your exact address is never shared automatically.
      </Text>
    </Screen>
  );
}

function BuyerTaskCard({
  householdId,
  task,
}: {
  householdId: string;
  task: BuyerTask;
}) {
  const queryClient = useQueryClient();
  const [response, setResponse] = useState(task.suggestedResponse);
  const decision = useMutation({
    mutationFn: (value: "approve" | "approve_and_send" | "reject") =>
      api.decideBuyerTask(householdId, task.id, {
        decision: value,
        ...(value === "reject" ? {} : { responseText: response }),
        shareExactAddress: false,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["buyer-tasks", householdId],
      });
    },
  });
  const actionDraft = useMutation({
    mutationFn: (action: "accept" | "counter" | "decline" | "schedule") =>
      api.draftBuyerTaskAction(householdId, task.id, { action }),
    onSuccess: ({ draft }) => setResponse(draft.response),
  });
  const meetup = useMutation({
    mutationFn: () =>
      api.createMeetup(householdId, task.id, {
        locationType: "public_meetup",
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["buyer-tasks", householdId],
        }),
        queryClient.invalidateQueries({ queryKey: ["meetups", householdId] }),
      ]);
    },
  });
  const backup = useMutation({
    mutationFn: () => api.enqueueBackupBuyer(householdId, task.id),
  });

  return (
    <AppCard
      title={task.participantAlias}
      subtitle={task.intent.replaceAll("_", " ")}
      trailing={
        <StatusBadge
          label={task.approvalState}
          tone={task.scamSignals.length > 0 ? "danger" : "neutral"}
        />
      }
    >
      <Text style={styles.excerpt}>{task.redactedMessageExcerpt}</Text>
      {task.priceOffer ? (
        <Text style={styles.offer}>
          Offer: ${(task.priceOffer.amountCents / 100).toFixed(2)}{" "}
          {task.priceOffer.currency}
        </Text>
      ) : null}
      {task.scamSignals.map((signal) => (
        <Text key={signal} style={styles.warning}>
          ⚠ {signal}
        </Text>
      ))}
      <AppField
        label="Suggested reply"
        value={response}
        multiline
        maxLength={2_000}
        onChangeText={setResponse}
      />
      <View style={styles.actionRow}>
        <AppButton
          label="Accept"
          variant="secondary"
          disabled={actionDraft.isPending}
          onPress={() => actionDraft.mutate("accept")}
        />
        <AppButton
          label="Counter"
          variant="secondary"
          disabled={actionDraft.isPending}
          onPress={() => actionDraft.mutate("counter")}
        />
        <AppButton
          label="Decline"
          variant="secondary"
          disabled={actionDraft.isPending}
          onPress={() => actionDraft.mutate("decline")}
        />
        <AppButton
          label="Schedule"
          variant="secondary"
          disabled={actionDraft.isPending}
          onPress={() => actionDraft.mutate("schedule")}
        />
      </View>
      {actionDraft.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {actionDraft.error.message}
        </Text>
      ) : null}
      <View style={styles.actionRow}>
        <AppButton
          label={meetup.isSuccess ? "Meetup proposed" : "Propose saved meetup"}
          variant="secondary"
          loading={meetup.isPending}
          disabled={task.scamSignals.length > 0 || meetup.isSuccess}
          onPress={() => meetup.mutate()}
        />
        <AppButton
          label={backup.isSuccess ? "Added to backups" : "Keep as backup buyer"}
          variant="quiet"
          loading={backup.isPending}
          disabled={task.scamSignals.length > 0 || backup.isSuccess}
          onPress={() => backup.mutate()}
        />
      </View>
      {meetup.error || backup.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {(meetup.error ?? backup.error)?.message}
        </Text>
      ) : null}
      {task.requiresAddressApproval ? (
        <Text style={styles.warning}>
          The buyer asked about a private location. This reply does not share an
          exact address; sharing one requires a separate explicit approval.
        </Text>
      ) : null}
      {decision.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {decision.error.message}
        </Text>
      ) : null}
      <AppButton
        label="Approve and send"
        loading={decision.isPending}
        disabled={!response.trim()}
        onPress={() => decision.mutate("approve_and_send")}
      />
      <AppButton
        label="Approve draft only"
        variant="secondary"
        disabled={!response.trim() || decision.isPending}
        onPress={() => decision.mutate("approve")}
      />
      <AppButton
        label="Reject suggestion"
        variant="quiet"
        disabled={decision.isPending}
        onPress={() => decision.mutate("reject")}
      />
    </AppCard>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: "center", gap: spacing.md, paddingVertical: spacing.lg },
  icon: { ...typography.title, color: colors.primary },
  body: { ...typography.body, color: colors.muted, textAlign: "center" },
  note: { ...typography.caption, color: colors.muted },
  error: { ...typography.body, color: colors.danger },
  warning: { ...typography.caption, color: colors.danger, fontWeight: "700" },
  excerpt: { ...typography.body, color: colors.ink },
  offer: { ...typography.body, color: colors.primary, fontWeight: "800" },
  participant: { ...typography.body, color: colors.ink, fontWeight: "700" },
  completedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  flex: { flex: 1 },
});
