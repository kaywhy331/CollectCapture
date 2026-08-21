import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "../src/providers/AuthProvider";
import { NotificationBridge } from "../src/components/NotificationBridge";
import { HouseholdProvider } from "../src/providers/HouseholdProvider";
import { colors } from "../src/theme";

export default function RootLayout() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 15_000, retry: 1 },
          mutations: { retry: 0 },
        },
      }),
  );

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <NotificationBridge />
          <HouseholdProvider>
            <StatusBar style="dark" />
            <Stack
              screenOptions={{
                headerStyle: { backgroundColor: colors.canvas },
                headerTintColor: colors.ink,
                headerShadowVisible: false,
                contentStyle: { backgroundColor: colors.canvas },
                headerBackTitle: "Back",
              }}
            >
              <Stack.Screen name="index" options={{ headerShown: false }} />
              <Stack.Screen
                name="onboarding"
                options={{ title: "Set up LocalClear" }}
              />
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen
                name="review/[itemId]"
                options={{ title: "Review item" }}
              />
              <Stack.Screen
                name="publish/[itemId]"
                options={{ title: "List locally" }}
              />
              <Stack.Screen
                name="item/[itemId]"
                options={{ title: "Item details" }}
              />
              <Stack.Screen
                name="connections"
                options={{ title: "Seller Hub" }}
              />
              <Stack.Screen
                name="meetup"
                options={{ title: "Meetup preferences" }}
              />
              <Stack.Screen
                name="batch-publish"
                options={{ title: "Batch publish" }}
              />
            </Stack>
          </HouseholdProvider>
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
