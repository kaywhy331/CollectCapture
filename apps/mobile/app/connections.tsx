import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ConnectorManifest,
  PlatformConnection,
  SellerDevice,
} from "@localclear/domain";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { AppButton } from "../src/components/AppButton";
import { AppCard } from "../src/components/AppCard";
import { Screen } from "../src/components/Screen";
import { StatusBadge } from "../src/components/StatusBadge";
import { api } from "../src/lib/api";
import { useHousehold } from "../src/providers/HouseholdProvider";
import { colors, radius, spacing, typography } from "../src/theme";

interface PairingQr {
  version: number;
  challengeId: string;
  householdId: string;
  secret: string;
  apiBaseUrl: string;
  expiresAt: string;
}

export default function ConnectionsScreen() {
  const { activeHousehold } = useHousehold();
  const queryClient = useQueryClient();
  const [qr, setQr] = useState<PairingQr | null>(null);
  const [confirmUnpair, setConfirmUnpair] = useState<string | null>(null);

  const devices = useQuery({
    queryKey: ["devices", activeHousehold?.id],
    enabled: Boolean(activeHousehold),
    queryFn: () => api.listDevices(activeHousehold!.id),
    refetchInterval: qr ? 3_000 : false,
  });
  const connectors = useQuery({
    queryKey: ["connectors"],
    enabled: Boolean(activeHousehold),
    queryFn: () => api.listConnectors(),
  });
  const platformConnections = useQuery({
    queryKey: ["platform-connections", activeHousehold?.id],
    enabled: Boolean(activeHousehold),
    queryFn: () => api.listPlatformConnections(activeHousehold!.id),
    refetchInterval: 15_000,
  });
  const beginPairing = useMutation({
    mutationFn: () => api.beginPairing(activeHousehold!.id),
    onSuccess: ({ qr: payload }) => setQr(payload as unknown as PairingQr),
  });
  const unpair = useMutation({
    mutationFn: (deviceId: string) =>
      api.unpairDevice(activeHousehold!.id, deviceId),
    onSuccess: async () => {
      setConfirmUnpair(null);
      await queryClient.invalidateQueries({
        queryKey: ["devices", activeHousehold?.id],
      });
    },
  });

  if (!activeHousehold) {
    return (
      <Screen title="Seller Hub">
        <Text style={styles.error}>Finish household setup first.</Text>
      </Screen>
    );
  }

  const activeDevices = (devices.data?.devices ?? []).filter(
    (device) => !device.revokedAt,
  );

  return (
    <Screen title="Seller Hub" eyebrow="Optional companion device">
      <AppCard
        title="Marketplace sessions stay on the spare phone"
        subtitle="Pair a physical Android 11+ device that you control. LocalClear never asks for or stores marketplace passwords, cookies, or MFA secrets."
      >
        <Text style={styles.body}>
          Install Seller Hub on the spare phone, choose Pair device, and scan
          the single-use QR code shown here.
        </Text>
        {!qr ? (
          <AppButton
            label="Create pairing QR"
            loading={beginPairing.isPending}
            onPress={() => beginPairing.mutate()}
          />
        ) : (
          <View style={styles.qrPanel}>
            <View
              accessibilityLabel="Seller Hub pairing QR code"
              style={styles.qr}
            >
              <QRCode
                value={JSON.stringify(qr)}
                size={232}
                color={colors.ink}
                backgroundColor={colors.white}
              />
            </View>
            <Text style={styles.note}>
              Expires {new Date(qr.expiresAt).toLocaleTimeString()}. It can be
              used once.
            </Text>
            <AppButton
              label="Hide QR"
              variant="quiet"
              onPress={() => setQr(null)}
            />
          </View>
        )}
        {beginPairing.error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {beginPairing.error.message}
          </Text>
        ) : null}
      </AppCard>

      <AppCard title="Paired devices">
        {activeDevices.length === 0 ? (
          <Text style={styles.note}>No Seller Hub is paired.</Text>
        ) : (
          activeDevices.map((device) => (
            <DeviceCard
              key={device.id}
              device={device}
              confirming={confirmUnpair === device.id}
              busy={unpair.isPending}
              onStartUnpair={() => setConfirmUnpair(device.id)}
              onCancel={() => setConfirmUnpair(null)}
              onUnpair={() => unpair.mutate(device.id)}
            />
          ))
        )}
      </AppCard>

      <AppCard
        title="Platform availability"
        subtitle="Unavailable routes are visible but cannot be selected for production publishing."
      >
        {(connectors.data?.connectors ?? []).map((connector) => (
          <PlatformConnectionRow
            key={connector.id}
            connector={connector}
            connection={(platformConnections.data?.connections ?? []).find(
              (connection) =>
                connection.platform.toLowerCase() ===
                connector.platform.toLowerCase(),
            )}
          />
        ))}
      </AppCard>
    </Screen>
  );
}

function PlatformConnectionRow({
  connector,
  connection,
}: {
  connector: ConnectorManifest;
  connection: PlatformConnection | undefined;
}) {
  const status = connector.enabled
    ? (connection?.connectionStatus ?? "not_connected")
    : "disabled";
  return (
    <View style={styles.connectorRow}>
      <View style={styles.flex}>
        <Text style={styles.deviceName}>{connector.platform}</Text>
        <Text style={styles.note}>
          {connection?.displayAlias ??
            (connector.kind === "android"
              ? "Runs on Seller Hub"
              : connector.kind === "api"
                ? "API connector"
                : "Guided export")}
        </Text>
        {connection?.lastVerifiedAt ? (
          <Text style={styles.note}>
            Marketplace app {connection.appVersion} · verified{" "}
            {new Date(connection.lastVerifiedAt).toLocaleString()}
          </Text>
        ) : null}
      </View>
      <StatusBadge
        label={status.replaceAll("_", " ")}
        tone={
          status === "connected"
            ? "success"
            : status === "disabled"
              ? "danger"
              : "neutral"
        }
      />
    </View>
  );
}

function DeviceCard({
  device,
  confirming,
  busy,
  onStartUnpair,
  onCancel,
  onUnpair,
}: {
  device: SellerDevice;
  confirming: boolean;
  busy: boolean;
  onStartUnpair(): void;
  onCancel(): void;
  onUnpair(): void;
}) {
  return (
    <View style={styles.device}>
      <View style={styles.connectorRow}>
        <View style={styles.flex}>
          <Text style={styles.deviceName}>{device.displayName}</Text>
          <Text style={styles.note}>
            Android {device.androidVersion} · Seller Hub {device.appVersion}
          </Text>
          <Text style={styles.note}>
            {device.batteryPercent === null
              ? "Battery unknown"
              : `${device.batteryPercent}% battery${device.isCharging ? " · charging" : ""}`}
          </Text>
        </View>
        <StatusBadge
          label={device.connectionStatus}
          tone={device.connectionStatus === "online" ? "success" : "neutral"}
        />
      </View>
      {confirming ? (
        <View style={styles.confirmation}>
          <Text style={styles.error}>
            Unpairing revokes this device key immediately. Clear local Seller
            Hub data on the device afterward.
          </Text>
          <AppButton
            label="Revoke and unpair"
            variant="danger"
            loading={busy}
            onPress={onUnpair}
          />
          <AppButton label="Cancel" variant="quiet" onPress={onCancel} />
        </View>
      ) : (
        <AppButton label="Unpair" variant="quiet" onPress={onStartUnpair} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { ...typography.body, color: colors.ink },
  note: { ...typography.caption, color: colors.muted },
  error: { ...typography.body, color: colors.danger },
  qrPanel: { alignItems: "center", gap: spacing.md },
  qr: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.white,
  },
  device: {
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.md,
  },
  deviceName: { ...typography.body, color: colors.ink, fontWeight: "700" },
  connectorRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  confirmation: { gap: spacing.sm },
  flex: { flex: 1 },
});
