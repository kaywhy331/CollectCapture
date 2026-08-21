import type {
  ExchangeOption,
  HouseholdGoal,
  PaymentWording,
} from "@localclear/domain";
import { router } from "expo-router";
import { useState } from "react";
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

export default function OnboardingScreen() {
  const { refresh } = useHousehold();
  const [goal, setGoal] = useState<HouseholdGoal>("sell_few_items");
  const [zipCode, setZipCode] = useState("");
  const [radius, setRadius] = useState("15");
  const [exchange, setExchange] = useState<ExchangeOption[]>(["public_meetup"]);
  const [payment, setPayment] = useState<PaymentWording>("cash_preferred");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleExchange = (value: ExchangeOption) => {
    setExchange((current) =>
      current.includes(value)
        ? current.filter((choice) => choice !== value)
        : [...current, value],
    );
  };

  const save = async () => {
    if (!/^\d{5}(?:-\d{4})?$/.test(zipCode)) {
      setError("Enter a valid 5-digit ZIP code.");
      return;
    }
    if (exchange.length === 0) {
      setError("Choose at least one way to exchange items.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createHousehold({
        name: "My household",
        goal,
        zipCode,
        sellingRadiusMiles: Number(radius),
        exchangePreferences: exchange,
        paymentWording: payment,
        availability: [],
        preferredMeetupLocations: [],
        priceRules: {
          defaultMinimumOfferPercent: 70,
          defaultHoldMinutes: 120,
          acceptsTrades: false,
        },
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      await refresh();
      router.replace("/(tabs)/home");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not save your setup",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      eyebrow="About one minute"
      title="How would you like to clear things?"
      footer={
        <AppButton
          label="Finish setup"
          loading={busy}
          onPress={() => void save()}
        />
      }
    >
      <AppCard title="Your goal">
        <ChoiceChip
          label="Sell a few items"
          selected={goal === "sell_few_items"}
          onPress={() => setGoal("sell_few_items")}
        />
        <ChoiceChip
          label="Clear a whole space"
          selected={goal === "clear_a_space"}
          onPress={() => setGoal("clear_a_space")}
        />
      </AppCard>

      <AppCard
        title="Your local area"
        subtitle="Listings use an approximate area, not your address."
      >
        <AppField
          label="ZIP code"
          value={zipCode}
          onChangeText={setZipCode}
          keyboardType="number-pad"
          maxLength={10}
          placeholder="94107"
        />
        <AppField
          label="Selling radius in miles"
          value={radius}
          onChangeText={setRadius}
          keyboardType="number-pad"
          maxLength={3}
        />
      </AppCard>

      <AppCard
        title="How can buyers get items?"
        subtitle="You can change this for each item."
      >
        <View style={styles.choices}>
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
        title="Payment wording"
        subtitle="Payment stays between you and the buyer."
      >
        <ChoiceChip
          label="Cash preferred"
          selected={payment === "cash_preferred"}
          onPress={() => setPayment("cash_preferred")}
        />
        <ChoiceChip
          label="External payment apps accepted"
          selected={payment === "external_apps_accepted"}
          onPress={() => setPayment("external_apps_accepted")}
        />
        <ChoiceChip
          label="Decide at meetup"
          selected={payment === "decide_at_meetup"}
          onPress={() => setPayment("decide_at_meetup")}
        />
      </AppCard>

      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      <Text style={styles.note}>
        No shipping or financial account is needed.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  choices: { gap: spacing.sm },
  error: { ...typography.caption, color: colors.danger },
  note: { ...typography.caption, color: colors.muted, textAlign: "center" },
});
