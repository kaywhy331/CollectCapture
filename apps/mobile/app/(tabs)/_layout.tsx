import { Tabs } from "expo-router";
import { Text } from "react-native";
import { colors, typography } from "../../src/theme";

const labels = {
  home: "Home",
  capture: "Camera",
  inventory: "Inventory",
  tasks: "Buyer tasks",
  settings: "Settings",
} as const;

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          minHeight: 64,
          paddingTop: 6,
          paddingBottom: 8,
        },
        tabBarLabelStyle: { ...typography.caption, fontSize: 12 },
        tabBarIcon: ({ color }) => (
          <Text aria-hidden style={{ color, fontSize: 18, fontWeight: "900" }}>
            {route.name in labels
              ? labels[route.name as keyof typeof labels].slice(0, 1)
              : "•"}
          </Text>
        ),
      })}
    >
      <Tabs.Screen name="home" options={{ title: labels.home }} />
      <Tabs.Screen name="capture" options={{ title: labels.capture }} />
      <Tabs.Screen name="inventory" options={{ title: labels.inventory }} />
      <Tabs.Screen name="tasks" options={{ title: labels.tasks }} />
      <Tabs.Screen name="settings" options={{ title: labels.settings }} />
    </Tabs>
  );
}
