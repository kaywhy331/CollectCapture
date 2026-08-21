import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";
import { api } from "../lib/api";
import { useAuth } from "../providers/AuthProvider";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export function NotificationBridge() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user || Platform.OS === "web") return;
    let active = true;
    void register().catch(() => {
      // Push is additive; the in-app notification outbox remains available.
    });
    async function register() {
      if (Platform.OS === "android") {
        await Notifications.setNotificationChannelAsync("publishing", {
          name: "Publishing and buyer tasks",
          importance: Notifications.AndroidImportance.HIGH,
        });
      }
      const current = await Notifications.getPermissionsAsync();
      const permission =
        current.status === "granted"
          ? current
          : await Notifications.requestPermissionsAsync();
      if (!active || permission.status !== "granted") return;
      const projectId =
        process.env.EXPO_PUBLIC_EAS_PROJECT_ID ??
        Constants.easConfig?.projectId ??
        (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)
          ?.projectId;
      if (!projectId) return;
      const token = await Notifications.getExpoPushTokenAsync({ projectId });
      if (!active || (Platform.OS !== "android" && Platform.OS !== "ios")) {
        return;
      }
      await api.registerPushSubscription({
        expoPushToken: token.data,
        platform: Platform.OS,
      });
    }
    return () => {
      active = false;
    };
  }, [user]);

  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const value = response.notification.request.content.data?.actionPath;
        if (typeof value === "string" && value.startsWith("/")) {
          router.push(value as never);
        }
      },
    );
    return () => subscription.remove();
  }, []);

  return null;
}
