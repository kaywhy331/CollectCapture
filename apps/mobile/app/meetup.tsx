import type {
  ExchangeOption,
  Household,
  PaymentWording,
} from "@localclear/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { AppButton } from "../src/components/AppButton";
import { AppCard } from "../src/components/AppCard";
import { AppField } from "../src/components/AppField";
import { ChoiceChip } from "../src/components/ChoiceChip";
import { Screen } from "../src/components/Screen";
import { api } from "../src/lib/api";
import { useHousehold } from "../src/providers/HouseholdProvider";
import { colors, spacing, typography } from "../src/theme";

const exchangeChoices: Array<{ value: ExchangeOption; label: string }> = [
  { value: "public_meetup", label: "Public meetup" },
  { value: "porch_pickup", label: "Porch pickup" },
  { value: "buyer_pickup", label: "Buyer pickup for large items" },
  { value: "local_delivery", label: "Local delivery" },
  { value: "decide_per_item", label: "Decide per item" },
];
const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function MeetupPreferencesScreen() {
  const { activeHousehold, refresh } = useHousehold();
  const queryClient = useQueryClient();
  const [exchange, setExchange] = useState<ExchangeOption[]>([]);
  const [payment, setPayment] = useState<PaymentWording>("cash_preferred");
  const [availability, setAvailability] = useState<Household["availability"]>(
    [],
  );
  const [day, setDay] = useState(6);
  const [start, setStart] = useState("10:00");
  const [end, setEnd] = useState("14:00");
  const [locationName, setLocationName] = useState("");
  const [locationDescription, setLocationDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const meetups = useQuery({
    queryKey: ["meetups", activeHousehold?.id],
    enabled: Boolean(activeHousehold),
    queryFn: () => api.listMeetups(activeHousehold!.id),
    refetchInterval: 30_000,
  });
  const updateMeetup = useMutation({
    mutationFn: ({
      meetupId,
      status,
    }: {
      meetupId: string;
      status: "confirmed" | "completed" | "cancelled" | "no_show";
    }) => api.updateMeetup(activeHousehold!.id, meetupId, status),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["meetups", activeHousehold?.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["buyer-tasks", activeHousehold?.id],
        }),
      ]);
    },
  });

  useEffect(() => {
    if (!activeHousehold) return;
    setExchange(activeHousehold.exchangePreferences);
    setPayment(activeHousehold.paymentWording);
    setAvailability(activeHousehold.availability);
    const first = activeHousehold.preferredMeetupLocations[0];
    setLocationName(first?.name ?? "");
    setLocationDescription(first?.publicDescription ?? "");
  }, [activeHousehold]);

  if (!activeHousehold) {
    return (
      <Screen title="Meetup preferences">
        <Text style={styles.error}>Finish household setup first.</Text>
      </Screen>
    );
  }

  const toggleExchange = (value: ExchangeOption) => {
    setSaved(false);
    setExchange((current) =>
      current.includes(value)
        ? current.filter((choice) => choice !== value)
        : [...current, value],
    );
  };

  const addWindow = () => {
    const startMinutes = parseTime(start);
    const endMinutes = parseTime(end);
    if (
      startMinutes === null ||
      endMinutes === null ||
      endMinutes <= startMinutes
    ) {
      setError("Use 24-hour times such as 10:00 and make the end later.");
      return;
    }
    setError(null);
    setSaved(false);
    setAvailability((current) => [
      ...current.filter((window) => window.dayOfWeek !== day),
      { dayOfWeek: day, startMinutes, endMinutes },
    ]);
  };

  const save = async () => {
    if (exchange.length === 0) {
      setError("Choose at least one exchange option.");
      return;
    }
    if (Boolean(locationName.trim()) !== Boolean(locationDescription.trim())) {
      setError(
        "Add both a location name and public description, or leave both blank.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.updateHousehold(activeHousehold.id, {
        name: activeHousehold.name,
        goal: activeHousehold.goal,
        zipCode: activeHousehold.zipCode,
        sellingRadiusMiles: activeHousehold.sellingRadiusMiles,
        exchangePreferences: exchange,
        paymentWording: payment,
        availability,
        preferredMeetupLocations: locationName.trim()
          ? [
              {
                name: locationName.trim(),
                publicDescription: locationDescription.trim(),
              },
            ]
          : [],
        priceRules: activeHousehold.priceRules,
        timezone: activeHousehold.timezone,
      });
      await refresh();
      setSaved(true);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not save preferences",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Meetup preferences" eyebrow="Privacy by default">
      <AppCard
        title="Scheduled exchanges"
        subtitle="Confirm outcomes here. LocalClear never handles the payment."
      >
        {meetups.isLoading ? (
          <Text style={styles.note}>Loading meetups…</Text>
        ) : null}
        {meetups.error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {meetups.error.message}
          </Text>
        ) : null}
        {(meetups.data?.meetups ?? []).length === 0 && !meetups.isLoading ? (
          <Text style={styles.note}>No exchanges are scheduled yet.</Text>
        ) : null}
        {(meetups.data?.meetups ?? []).map((meetup) => (
          <View key={meetup.id} style={styles.meetupRow}>
            <Text style={styles.body}>
              {meetup.buyerAlias} ·{" "}
              {new Intl.DateTimeFormat(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(meetup.scheduledAt))}
            </Text>
            <Text style={styles.note}>
              {meetup.approvedLocation} · {meetup.status.replaceAll("_", " ")}
            </Text>
            <View style={styles.chips}>
              {meetup.status === "proposed" ? (
                <AppButton
                  label="Confirm"
                  variant="secondary"
                  disabled={updateMeetup.isPending}
                  onPress={() =>
                    updateMeetup.mutate({
                      meetupId: meetup.id,
                      status: "confirmed",
                    })
                  }
                />
              ) : null}
              {meetup.status === "confirmed" ? (
                <>
                  <AppButton
                    label="Completed"
                    variant="secondary"
                    disabled={updateMeetup.isPending}
                    onPress={() =>
                      updateMeetup.mutate({
                        meetupId: meetup.id,
                        status: "completed",
                      })
                    }
                  />
                  <AppButton
                    label="No-show"
                    variant="quiet"
                    disabled={updateMeetup.isPending}
                    onPress={() =>
                      updateMeetup.mutate({
                        meetupId: meetup.id,
                        status: "no_show",
                      })
                    }
                  />
                </>
              ) : null}
              {meetup.status === "proposed" || meetup.status === "confirmed" ? (
                <AppButton
                  label="Cancel"
                  variant="quiet"
                  disabled={updateMeetup.isPending}
                  onPress={() =>
                    updateMeetup.mutate({
                      meetupId: meetup.id,
                      status: "cancelled",
                    })
                  }
                />
              ) : null}
            </View>
          </View>
        ))}
        {updateMeetup.error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {updateMeetup.error.message}
          </Text>
        ) : null}
      </AppCard>

      <AppCard
        title="Exchange options"
        subtitle="These become the defaults for new listings. You can still decide per item."
      >
        <View style={styles.chips}>
          {exchangeChoices.map((choice) => (
            <ChoiceChip
              key={choice.value}
              label={choice.label}
              selected={exchange.includes(choice.value)}
              onPress={() => toggleExchange(choice.value)}
            />
          ))}
        </View>
      </AppCard>

      <AppCard
        title="Public meetup location"
        subtitle="Save a public description only. Never put a private home address here."
      >
        <AppField
          label="Location name"
          placeholder="Central police station"
          value={locationName}
          maxLength={120}
          onChangeText={(value) => {
            setLocationName(value);
            setSaved(false);
          }}
        />
        <AppField
          label="Public description"
          placeholder="Front public exchange area"
          value={locationDescription}
          maxLength={240}
          onChangeText={(value) => {
            setLocationDescription(value);
            setSaved(false);
          }}
        />
      </AppCard>

      <AppCard
        title="Typical availability"
        subtitle="Add or replace one window per day. Times use your household timezone."
      >
        <View style={styles.chips}>
          {days.map((label, index) => (
            <ChoiceChip
              key={label}
              label={label}
              selected={day === index}
              onPress={() => setDay(index)}
            />
          ))}
        </View>
        <View style={styles.timeRow}>
          <View style={styles.flex}>
            <AppField
              label="Start (24h)"
              value={start}
              onChangeText={setStart}
            />
          </View>
          <View style={styles.flex}>
            <AppField label="End (24h)" value={end} onChangeText={setEnd} />
          </View>
        </View>
        <AppButton
          label="Add time window"
          variant="secondary"
          onPress={addWindow}
        />
        {availability.map((window) => (
          <View key={window.dayOfWeek} style={styles.windowRow}>
            <Text style={styles.body}>
              {days[window.dayOfWeek]} · {formatMinutes(window.startMinutes)}–
              {formatMinutes(window.endMinutes)}
            </Text>
            <AppButton
              label="Remove"
              variant="quiet"
              onPress={() =>
                setAvailability((current) =>
                  current.filter((value) => value !== window),
                )
              }
            />
          </View>
        ))}
      </AppCard>

      <AppCard title="Payment wording">
        <View style={styles.chips}>
          <ChoiceChip
            label="Cash preferred"
            selected={payment === "cash_preferred"}
            onPress={() => setPayment("cash_preferred")}
          />
          <ChoiceChip
            label="External apps accepted"
            selected={payment === "external_apps_accepted"}
            onPress={() => setPayment("external_apps_accepted")}
          />
          <ChoiceChip
            label="Decide at meetup"
            selected={payment === "decide_at_meetup"}
            onPress={() => setPayment("decide_at_meetup")}
          />
        </View>
        <Text style={styles.note}>
          LocalClear does not process or escrow buyer payments.
        </Text>
      </AppCard>

      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {saved ? (
        <Text accessibilityLiveRegion="polite" style={styles.success}>
          Preferences saved.
        </Text>
      ) : null}
      <AppButton
        label="Save preferences"
        loading={busy}
        onPress={() => void save()}
      />
      <Text style={styles.note}>
        An exact pickup address should only be shared in a specific buyer
        conversation after you explicitly approve it.
      </Text>
    </Screen>
  );
}

function parseTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function formatMinutes(value: number): string {
  const hours = Math.floor(value / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (value % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  timeRow: { flexDirection: "row", gap: spacing.sm },
  windowRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  meetupRow: {
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  flex: { flex: 1 },
  body: { ...typography.body, color: colors.ink, flex: 1 },
  note: { ...typography.caption, color: colors.muted },
  error: { ...typography.body, color: colors.danger },
  success: { ...typography.body, color: colors.primary, fontWeight: "700" },
});
