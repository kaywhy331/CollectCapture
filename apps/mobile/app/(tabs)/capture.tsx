import { useQueryClient } from "@tanstack/react-query";
import {
  CameraView,
  useCameraPermissions,
  type BarcodeScanningResult,
} from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import { router, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { AppButton } from "../../src/components/AppButton";
import { AppCard } from "../../src/components/AppCard";
import { ChoiceChip } from "../../src/components/ChoiceChip";
import { Screen } from "../../src/components/Screen";
import { api } from "../../src/lib/api";
import {
  removeUploadedPhotos,
  sanitizeAndUploadPhotos,
  type LocalPhoto,
} from "../../src/lib/media";
import { useHousehold } from "../../src/providers/HouseholdProvider";
import { colors, radius, spacing, typography } from "../../src/theme";

export default function CaptureScreen() {
  const { activeHousehold } = useHousehold();
  const params = useLocalSearchParams<{ mode?: "single" | "batch" }>();
  const [mode, setMode] = useState<"single" | "batch">(
    params.mode === "batch" ? "batch" : "single",
  );
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const [barcode, setBarcode] = useState<string | null>(null);
  const [capturedCount, setCapturedCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const queryClient = useQueryClient();

  if (!activeHousehold) {
    return (
      <Screen title="Camera">
        <Text style={styles.body}>
          Finish household setup before capturing an item.
        </Text>
      </Screen>
    );
  }

  if (!permission) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <Screen title="Use your camera">
        <AppCard
          title="Photograph only what you choose"
          subtitle="A main photo is enough to begin. Add labels or damage only when useful."
        >
          <AppButton
            label="Allow camera"
            onPress={() => void requestPermission()}
          />
          <AppButton
            label="Choose existing photos"
            variant="secondary"
            onPress={() => void pick()}
          />
        </AppCard>
      </Screen>
    );
  }

  async function takePhoto() {
    if (!camera.current || photos.length >= 12) return;
    setMessage(null);
    const photo = await camera.current.takePictureAsync({
      quality: 0.92,
      skipProcessing: false,
    });
    if (photo) {
      setPhotos((current) => [
        ...current,
        {
          uri: photo.uri,
          width: photo.width,
          height: photo.height,
          source: "camera",
        },
      ]);
    }
  }

  async function pick() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: Math.max(1, 12 - photos.length),
      quality: 1,
      exif: false,
    });
    if (!result.canceled) {
      const selected = result.assets
        .slice(0, 12 - photos.length)
        .map((asset) => ({
          uri: asset.uri,
          width: asset.width,
          height: asset.height,
          source: "library" as const,
        }));
      setPhotos((current) => [...current, ...selected]);
    }
  }

  async function finishItem() {
    if (photos.length === 0 || busy) return;
    setBusy(true);
    setMessage("Cleaning location data and uploading photos…");
    let uploaded: Awaited<ReturnType<typeof sanitizeAndUploadPhotos>> = [];
    try {
      uploaded = await sanitizeAndUploadPhotos(activeHousehold!.id, photos);
      const result = await api.captureItem(activeHousehold!.id, {
        photos: uploaded,
        barcode,
        imageFingerprint: uploaded[0]?.contentSha256 ?? null,
        clearingRecommendation: "sell",
      });
      await queryClient.invalidateQueries({
        queryKey: ["items", activeHousehold!.id],
      });
      if (mode === "batch") {
        setCapturedCount((count) => count + 1);
        setPhotos([]);
        setBarcode(null);
        setMessage("Item saved. Keep going when you’re ready.");
      } else {
        setMessage(null);
        router.push({
          pathname: "/review/[itemId]",
          params: { itemId: result.item.id },
        });
      }
    } catch (error) {
      if (uploaded.length > 0) {
        await removeUploadedPhotos(uploaded.map((photo) => photo.storagePath));
      }
      setMessage(
        error instanceof Error ? error.message : "Could not save this item",
      );
    } finally {
      setBusy(false);
    }
  }

  const onBarcode = (result: BarcodeScanningResult) => {
    if (!barcode && result.data) setBarcode(result.data);
  };

  return (
    <Screen
      scroll={false}
      title={mode === "batch" ? "Clear a whole space" : "Photograph an item"}
    >
      <View style={styles.modeRow}>
        <ChoiceChip
          label="One item"
          selected={mode === "single"}
          onPress={() => setMode("single")}
        />
        <ChoiceChip
          label="Batch"
          selected={mode === "batch"}
          onPress={() => setMode("batch")}
        />
        {mode === "batch" ? (
          <Text accessibilityLiveRegion="polite" style={styles.count}>
            {capturedCount} saved
          </Text>
        ) : null}
      </View>

      <CameraView
        ref={camera}
        style={styles.camera}
        facing="back"
        barcodeScannerSettings={{
          barcodeTypes: ["ean13", "ean8", "upc_a", "upc_e"],
        }}
        onBarcodeScanned={onBarcode}
      >
        <View pointerEvents="none" style={styles.guide}>
          <Text style={styles.guideText}>Fill the frame with one item</Text>
        </View>
      </CameraView>

      <View style={styles.controls}>
        <AppButton
          label={photos.length === 0 ? "Take main photo" : "Add another photo"}
          disabled={photos.length >= 12 || busy}
          onPress={() => void takePhoto()}
        />
        <AppButton
          label="Choose photos"
          variant="secondary"
          disabled={photos.length >= 12 || busy}
          onPress={() => void pick()}
        />
      </View>

      {photos.length > 0 ? (
        <View style={styles.photoSection}>
          <Text style={styles.photoLabel}>{photos.length} of 12 photos</Text>
          <ScrollView horizontal contentContainerStyle={styles.thumbnails}>
            {photos.map((photo, index) => (
              <Pressable
                key={`${photo.uri}-${index}`}
                accessibilityRole="button"
                accessibilityLabel={`Remove photo ${index + 1}`}
                onPress={() =>
                  setPhotos((current) =>
                    current.filter((_, at) => at !== index),
                  )
                }
              >
                <Image source={{ uri: photo.uri }} style={styles.thumbnail} />
                <Text style={styles.remove}>Remove</Text>
              </Pressable>
            ))}
          </ScrollView>
          <Text style={styles.tip}>
            Helpful next photo: label or model number, then any damage or
            included accessories.
          </Text>
        </View>
      ) : null}

      {barcode ? (
        <Text style={styles.barcode}>Barcode detected: {barcode}</Text>
      ) : null}
      {message ? (
        <Text
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          style={styles.message}
        >
          {message}
        </Text>
      ) : null}
      <AppButton
        label={
          mode === "batch" ? "Save item and keep going" : "Use these photos"
        }
        loading={busy}
        disabled={photos.length === 0}
        onPress={() => void finishItem()}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.canvas,
  },
  body: { ...typography.body, color: colors.muted },
  modeRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  count: {
    ...typography.caption,
    color: colors.primary,
    fontWeight: "800",
    marginLeft: "auto",
  },
  camera: {
    minHeight: 280,
    flex: 1,
    maxHeight: 460,
    borderRadius: radius.lg,
    overflow: "hidden",
  },
  guide: {
    flex: 1,
    margin: spacing.xl,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.8)",
    borderRadius: radius.lg,
    justifyContent: "flex-end",
  },
  guideText: {
    ...typography.caption,
    color: colors.white,
    backgroundColor: "rgba(0,0,0,0.58)",
    padding: spacing.sm,
    textAlign: "center",
  },
  controls: { flexDirection: "row", gap: spacing.sm },
  photoSection: { gap: spacing.xs },
  photoLabel: { ...typography.caption, color: colors.ink, fontWeight: "700" },
  thumbnails: { gap: spacing.sm },
  thumbnail: {
    width: 76,
    height: 76,
    borderRadius: radius.sm,
    backgroundColor: colors.border,
  },
  remove: { ...typography.caption, color: colors.danger, textAlign: "center" },
  tip: { ...typography.caption, color: colors.muted },
  barcode: { ...typography.caption, color: colors.primary },
  message: { ...typography.caption, color: colors.ink },
});
