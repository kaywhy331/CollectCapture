import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { AppButton } from "../src/components/AppButton";
import { AppCard } from "../src/components/AppCard";
import { AppField } from "../src/components/AppField";
import { Screen } from "../src/components/Screen";
import { useAuth } from "../src/providers/AuthProvider";
import { useHousehold } from "../src/providers/HouseholdProvider";
import { colors, spacing, typography } from "../src/theme";

export default function EntryScreen() {
  const {
    user,
    loading: authLoading,
    sendEmailLink,
    signInWithProvider,
  } = useAuth();
  const {
    activeHousehold,
    loading: householdLoading,
    households,
  } = useHousehold();
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (authLoading || !user || householdLoading) return;
    if (activeHousehold) router.replace("/(tabs)/home");
    else if (households.length === 0) router.replace("/onboarding");
  }, [activeHousehold, authLoading, householdLoading, households.length, user]);

  if (authLoading || (user && householdLoading)) {
    return (
      <View accessibilityLabel="Loading LocalClear" style={styles.loading}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (user) {
    return (
      <View accessibilityLabel="Opening your household" style={styles.loading}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  const run = async (action: () => Promise<void>, success?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      if (success) setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll>
      <View style={styles.hero}>
        <View style={styles.mark} accessibilityElementsHidden>
          <Text style={styles.markText}>LC</Text>
        </View>
        <Text accessibilityRole="header" style={styles.display}>
          Take pictures. Approve once. Clear it locally.
        </Text>
        <Text style={styles.lead}>
          Turn household clutter into accurate local listings—without shipping,
          payment setup, or repetitive forms.
        </Text>
      </View>

      <AppCard
        title="Get started"
        subtitle="Your marketplace logins stay on your own device."
      >
        <AppButton
          label="Continue with Apple"
          variant="secondary"
          disabled={busy}
          onPress={() => void run(() => signInWithProvider("apple"))}
        />
        <AppButton
          label="Continue with Google"
          variant="secondary"
          disabled={busy}
          onPress={() => void run(() => signInWithProvider("google"))}
        />
        <View style={styles.divider}>
          <View style={styles.line} />
          <Text style={styles.or}>or use email</Text>
          <View style={styles.line} />
        </View>
        <AppField
          label="Email address"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          placeholder="you@example.com"
        />
        <AppButton
          label="Email me a sign-in link"
          loading={busy}
          disabled={!email.includes("@")}
          onPress={() =>
            void run(
              () => sendEmailLink(email.trim()),
              "Check your email for a secure sign-in link.",
            )
          }
        />
        {message ? (
          <Text accessibilityRole="alert" style={styles.message}>
            {message}
          </Text>
        ) : null}
      </AppCard>

      <Text style={styles.privacy}>
        LocalClear never asks for marketplace passwords and never processes
        buyer payments.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.canvas,
  },
  hero: { paddingVertical: spacing.xl, gap: spacing.md },
  mark: {
    width: 56,
    height: 56,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
  },
  markText: { ...typography.heading, color: colors.white, fontWeight: "900" },
  display: { ...typography.display, color: colors.ink },
  lead: { ...typography.body, color: colors.muted },
  divider: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  line: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    flex: 1,
  },
  or: { ...typography.caption, color: colors.muted },
  message: { ...typography.caption, color: colors.primary },
  privacy: { ...typography.caption, color: colors.muted, textAlign: "center" },
});
