import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  restrictedScreenFromSignals,
  type Item,
  type PriceStrategy,
} from "@localclear/domain";
import * as ImagePicker from "expo-image-picker";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Image, StyleSheet, Text, View } from "react-native";
import { AppButton } from "../../src/components/AppButton";
import { AppCard } from "../../src/components/AppCard";
import { AppField } from "../../src/components/AppField";
import { ChoiceChip } from "../../src/components/ChoiceChip";
import { Screen } from "../../src/components/Screen";
import { StatusBadge } from "../../src/components/StatusBadge";
import { api } from "../../src/lib/api";
import {
  createMediaReadUrl,
  removeUploadedPhotos,
  sanitizeAndUploadPhotos,
} from "../../src/lib/media";
import { useHousehold } from "../../src/providers/HouseholdProvider";
import { colors, spacing, typography } from "../../src/theme";

const conditions: Array<{ value: Item["condition"]; label: string }> = [
  { value: "new", label: "New" },
  { value: "like_new", label: "Like new" },
  { value: "good", label: "Good" },
  { value: "fair", label: "Fair" },
  { value: "poor", label: "Poor" },
  { value: "for_parts", label: "For parts" },
];

const strategies: Array<{ value: PriceStrategy; label: string }> = [
  { value: "sell_fast", label: "Sell fast" },
  { value: "balanced", label: "Balanced" },
  { value: "maximize_value", label: "Maximize value" },
];

export default function ReviewItemScreen() {
  const { itemId } = useLocalSearchParams<{ itemId: string }>();
  const { activeHousehold } = useHousehold();
  const queryClient = useQueryClient();
  const [initialized, setInitialized] = useState(false);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [conditionSummary, setConditionSummary] = useState("");
  const [condition, setCondition] = useState<Item["condition"]>("unknown");
  const [strategy, setStrategy] = useState<PriceStrategy>("balanced");
  const [askingPrice, setAskingPrice] = useState("");
  const [minimumPrice, setMinimumPrice] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [privacyBusyId, setPrivacyBusyId] = useState<string | null>(null);
  const [privacyError, setPrivacyError] = useState<string | null>(null);

  const itemQuery = useQuery({
    queryKey: ["item", activeHousehold?.id, itemId],
    enabled: Boolean(activeHousehold && itemId),
    queryFn: () => api.getItem(activeHousehold!.id, itemId!),
  });
  const bundleSuggestions = useQuery({
    queryKey: ["bundle-suggestions", activeHousehold?.id, itemId],
    enabled: Boolean(activeHousehold && itemId),
    queryFn: () => api.getBundleSuggestions(activeHousehold!.id, itemId!),
  });
  const enrichment = useMutation({
    mutationFn: () => api.enrichItem(activeHousehold!.id, itemId!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["item", activeHousehold?.id, itemId],
      });
    },
  });
  const confirmNotPrivate = useMutation({
    mutationFn: (mediaAssetId: string) =>
      api.confirmMediaNotPrivate(activeHousehold!.id, itemId!, mediaAssetId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["item", activeHousehold?.id, itemId],
      });
    },
  });
  const pricing = useMutation({
    mutationFn: () =>
      api.recommendPrices(activeHousehold!.id, itemId!, {
        factors: {
          conditionMultiplier: conditionMultiplier(condition),
          localDemandMultiplier: 1,
          seasonalityMultiplier: 1,
        },
      }),
    onSuccess: ({ recommendations }) => {
      const recommendation =
        recommendations.find((value) => value.strategy === strategy) ??
        recommendations[0];
      if (!recommendation) return;
      setAskingPrice((recommendation.price.amountCents / 100).toFixed(0));
      setMinimumPrice(
        Math.floor(
          (recommendation.price.amountCents *
            activeHousehold!.priceRules.defaultMinimumOfferPercent) /
            10000,
        ).toString(),
      );
    },
  });

  useEffect(() => {
    if (activeHousehold && itemId && itemQuery.data && enrichment.isIdle) {
      enrichment.mutate();
    }
  }, [activeHousehold, enrichment.isIdle, itemId, itemQuery.data]);

  const suggestion = enrichment.data?.enrichment.output;
  useEffect(() => {
    if (!suggestion || initialized) return;
    setTitle(suggestion.listingDraft.title);
    setCategory(suggestion.category.value);
    setDescription(suggestion.listingDraft.description);
    setConditionSummary(suggestion.listingDraft.conditionSummary);
    setCondition(suggestion.condition.value);
    setInitialized(true);
  }, [initialized, suggestion]);

  const restrictedScreen = useMemo(
    () => restrictedScreenFromSignals(suggestion?.restrictedSignals ?? []),
    [suggestion],
  );
  const omittedFacts = useMemo(
    () =>
      [...(suggestion?.dimensions ?? []), ...(suggestion?.specifications ?? [])]
        .filter(
          (fact) => fact.provenance === "inferred" || fact.confidence < 0.85,
        )
        .map((fact) => fact.name),
    [suggestion],
  );
  const pendingPrivacyReview =
    itemQuery.data?.item.media.filter((asset) =>
      ["suggested", "approved"].includes(asset.redactionState),
    ) ?? [];

  const createListing = useMutation({
    mutationFn: async () => {
      if (!activeHousehold || !itemId || !suggestion) {
        throw new Error("Item analysis is not ready");
      }
      const askingPriceCents = dollarsToCents(askingPrice);
      const minimumPriceCents = dollarsToCents(minimumPrice);
      if (askingPriceCents === null || askingPriceCents < 100) {
        throw new Error("Enter an asking price of at least $1");
      }
      if (minimumPriceCents === null || minimumPriceCents > askingPriceCents) {
        throw new Error(
          "Minimum price must be a valid amount at or below asking",
        );
      }
      if (restrictedScreen.status !== "clear") {
        throw new Error("Resolve the restricted-item review before listing");
      }
      const dimensions = approvedFactRecord(suggestion.dimensions);
      const specifications = approvedFactRecord(suggestion.specifications);
      const approvedBrand =
        suggestion.brand.provenance === "image_derived" &&
        suggestion.brand.confidence >= 0.85
          ? suggestion.brand.value
          : null;
      const approvedModel =
        suggestion.model.provenance === "image_derived" &&
        suggestion.model.confidence >= 0.85
          ? suggestion.model.value
          : null;
      return api.createListing(activeHousehold.id, itemId, {
        title,
        description,
        conditionSummary,
        specifications,
        priceStrategy: strategy,
        askingPrice: { amountCents: askingPriceCents, currency: "USD" },
        minimumPrice: { amountCents: minimumPriceCents, currency: "USD" },
        location: {
          zipCode: activeHousehold.zipCode,
          displayArea: `Near ${activeHousehold.zipCode}`,
          radiusMiles: activeHousehold.sellingRadiusMiles,
        },
        exchangeOptions: activeHousehold.exchangePreferences,
        paymentWording: activeHousehold.paymentWording,
        negotiationRules: activeHousehold.priceRules,
        restrictedItemStatus: restrictedScreen.status,
        restrictedItemReasons: restrictedScreen.reasons,
        itemReview: {
          identification: suggestion.identification,
          category,
          brand: approvedBrand,
          model: approvedModel,
          condition,
          dimensions,
          specifications,
          accessories: suggestion.accessories.map((fact) => fact.value),
          defects: suggestion.defects.map((fact) => fact.value),
          clearingRecommendation: suggestion.clearingRecommendation.value,
        },
        approve: true,
      });
    },
    onSuccess: async ({ listing }) => {
      await queryClient.invalidateQueries({
        queryKey: ["items", activeHousehold?.id],
      });
      router.replace({
        pathname: "/publish/[itemId]",
        params: { itemId: itemId!, listingVersion: String(listing.version) },
      });
    },
    onError: (error) => {
      setSubmitError(
        error instanceof Error ? error.message : "Could not save this listing",
      );
    },
  });

  const replaceForPrivacy = async (mediaAssetId: string) => {
    if (!activeHousehold || !itemId || privacyBusyId) return;
    setPrivacyError(null);
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      allowsMultipleSelection: false,
      quality: 1,
      exif: false,
    });
    if (picked.canceled || !picked.assets[0]) return;
    setPrivacyBusyId(mediaAssetId);
    let uploaded: Awaited<ReturnType<typeof sanitizeAndUploadPhotos>> = [];
    try {
      const asset = picked.assets[0];
      uploaded = await sanitizeAndUploadPhotos(activeHousehold.id, [
        {
          uri: asset.uri,
          width: asset.width,
          height: asset.height,
          source: "library",
        },
      ]);
      const replacement = uploaded[0];
      if (!replacement) throw new Error("Edited photo was not created");
      await api.replaceMediaAsset(
        activeHousehold.id,
        itemId,
        mediaAssetId,
        replacement,
      );
      await queryClient.invalidateQueries({
        queryKey: ["item", activeHousehold.id, itemId],
      });
      enrichment.reset();
      enrichment.mutate();
    } catch (caught) {
      if (uploaded.length > 0) {
        await removeUploadedPhotos(uploaded.map((asset) => asset.storagePath));
      }
      setPrivacyError(
        caught instanceof Error ? caught.message : "Could not replace photo",
      );
    } finally {
      setPrivacyBusyId(null);
    }
  };

  if (!activeHousehold || !itemId) {
    return (
      <Screen title="Review item">
        <Text style={styles.error}>This item is not available.</Text>
      </Screen>
    );
  }

  if (itemQuery.isLoading || enrichment.isPending) {
    return (
      <Screen title="Looking closely…" eyebrow="Photo review">
        <AppCard subtitle="Checking identity, visible condition, privacy details, and listing copy.">
          <ActivityIndicator color={colors.primary} size="large" />
          <Text style={styles.body}>This usually takes a few moments.</Text>
        </AppCard>
      </Screen>
    );
  }

  const loadError = itemQuery.error ?? enrichment.error;
  if (loadError || !suggestion) {
    return (
      <Screen title="Review item">
        <AppCard title="Photo review needs another try">
          <Text accessibilityRole="alert" style={styles.error}>
            {loadError instanceof Error
              ? loadError.message
              : "No analysis was returned."}
          </Text>
          <AppButton
            label="Try photo review again"
            onPress={() => enrichment.mutate()}
          />
          <AppButton
            label="Back to inventory"
            variant="secondary"
            onPress={() => router.replace("/(tabs)/inventory")}
          />
        </AppCard>
      </Screen>
    );
  }

  return (
    <Screen title="Three quick decisions" eyebrow="Review before listing">
      <AppCard
        title="Photo quality and privacy"
        subtitle="Lead order is suggested from sharpness, lighting, framing, and item visibility. Nothing private is published until you review it."
      >
        <View style={styles.mediaGrid}>
          {(itemQuery.data?.item.media ?? []).map((asset) => {
            const assessment = suggestion.mediaAssessments.find(
              (value) => value.mediaAssetId === asset.id,
            );
            return (
              <View key={asset.id} style={styles.mediaReview}>
                <MediaPreview storagePath={asset.storagePath} />
                <Text style={styles.identity}>
                  {asset.isLead ? "Lead photo" : `Photo ${asset.order + 1}`}
                  {assessment
                    ? ` · ${Math.round(assessment.leadPhotoScore * 100)}% lead score`
                    : ""}
                </Text>
                {assessment?.leadPhotoReasons.map((reason) => (
                  <Text key={reason} style={styles.note}>
                    {reason}
                  </Text>
                ))}
                {asset.qualityIssues.map((issue) => (
                  <Text key={issue} style={styles.warning}>
                    Check {issue.replaceAll("_", " ")}
                  </Text>
                ))}
                {asset.redactionState === "suggested" ? (
                  <>
                    <Text style={styles.warning}>
                      Privacy review:{" "}
                      {assessment?.redactionReasons.join(", ") ||
                        "possible private detail"}
                    </Text>
                    <AppButton
                      label="Crop or replace with redacted photo"
                      variant="secondary"
                      loading={privacyBusyId === asset.id}
                      disabled={privacyBusyId !== null}
                      onPress={() => void replaceForPrivacy(asset.id)}
                    />
                    <AppButton
                      label="I checked—this is not private"
                      variant="quiet"
                      disabled={confirmNotPrivate.isPending}
                      onPress={() => confirmNotPrivate.mutate(asset.id)}
                    />
                  </>
                ) : null}
                {asset.redactionState === "applied" ? (
                  <Text style={styles.success}>
                    Redacted replacement applied
                  </Text>
                ) : null}
                {asset.redactionState === "reviewed_not_needed" ? (
                  <Text style={styles.success}>Privacy review complete</Text>
                ) : null}
              </View>
            );
          })}
        </View>
        {suggestion.suggestedAdditionalPhotos.map((photo) => (
          <Text key={`${photo.kind}-${photo.rationale}`} style={styles.note}>
            Helpful {photo.kind.replaceAll("_", " ")} photo: {photo.rationale}
          </Text>
        ))}
        {privacyError || confirmNotPrivate.error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {privacyError ?? confirmNotPrivate.error?.message}
          </Text>
        ) : null}
      </AppCard>

      <AppCard
        title="1. Is this the right item?"
        subtitle={`${Math.round(suggestion.identification.confidence * 100)}% identification confidence`}
      >
        <Text style={styles.identity}>
          {suggestion.identification.itemType} ·{" "}
          {suggestion.identification.category}
        </Text>
        {suggestion.identification.alternatives.length > 0 ? (
          <Text style={styles.note}>
            Other possibility:{" "}
            {suggestion.identification.alternatives[0]?.label}
          </Text>
        ) : null}
        <AppField
          label="Listing title"
          value={title}
          maxLength={240}
          onChangeText={setTitle}
        />
        <AppField
          label="Category"
          value={category}
          maxLength={160}
          onChangeText={setCategory}
        />
        <AppField
          label="Description"
          value={description}
          multiline
          maxLength={10_000}
          onChangeText={setDescription}
        />
      </AppCard>

      <AppCard
        title="2. Confirm the condition"
        subtitle={`Photo suggestion: ${suggestion.condition.value.replaceAll("_", " ")} (${Math.round(suggestion.condition.confidence * 100)}%)`}
      >
        <View style={styles.chips}>
          {conditions.map((choice) => (
            <ChoiceChip
              key={choice.value}
              label={choice.label}
              selected={condition === choice.value}
              onPress={() => setCondition(choice.value)}
            />
          ))}
        </View>
        <AppField
          label="Condition summary"
          value={conditionSummary}
          multiline
          maxLength={2_000}
          onChangeText={setConditionSummary}
        />
        {suggestion.defects.map((defect) => (
          <Text key={defect.value} style={styles.note}>
            Visible issue: {defect.value} ({Math.round(defect.confidence * 100)}
            %)
          </Text>
        ))}
      </AppCard>

      <AppCard
        title="3. Choose your price goal"
        subtitle={
          pricing.data
            ? "Based only on approved comparable outcomes. You can override every amount."
            : "LocalClear only recommends prices when approved comparable data exists; it will not invent a market price."
        }
      >
        <View style={styles.chips}>
          {strategies.map((choice) => (
            <ChoiceChip
              key={choice.value}
              label={choice.label}
              selected={strategy === choice.value}
              onPress={() => {
                setStrategy(choice.value);
                const recommendation = pricing.data?.recommendations.find(
                  (value) => value.strategy === choice.value,
                );
                if (recommendation) {
                  setAskingPrice(
                    (recommendation.price.amountCents / 100).toFixed(0),
                  );
                  setMinimumPrice(
                    Math.floor(
                      (recommendation.price.amountCents *
                        activeHousehold.priceRules.defaultMinimumOfferPercent) /
                        10000,
                    ).toString(),
                  );
                }
              }}
            />
          ))}
        </View>
        <AppButton
          label="Check approved comparable prices"
          variant="secondary"
          loading={pricing.isPending}
          onPress={() => pricing.mutate()}
        />
        {pricing.data ? (
          <View style={styles.pricingEvidence}>
            {pricing.data.recommendations.map((recommendation) => (
              <Text key={recommendation.strategy} style={styles.note}>
                {recommendation.strategy.replaceAll("_", " ")}: $
                {(recommendation.price.amountCents / 100).toFixed(0)} ·{" "}
                {Math.round(recommendation.confidence * 100)}% confidence ·{" "}
                {recommendation.comparableCount} comparables
              </Text>
            ))}
            <Text style={styles.note}>
              {pricing.data.recommendations[0]?.disclaimer}
            </Text>
            <Text style={styles.identity}>
              Clearing suggestion:{" "}
              {pricing.data.clearingAdvice.recommendation.replaceAll("_", " ")}
            </Text>
            <Text style={styles.note}>
              {pricing.data.clearingAdvice.rationale}
            </Text>
          </View>
        ) : null}
        {pricing.error ? (
          <Text accessibilityRole="alert" style={styles.note}>
            {pricing.error.message} You can enter a manual price below.
          </Text>
        ) : null}
        <AppField
          label="Asking price (USD)"
          value={askingPrice}
          keyboardType="decimal-pad"
          placeholder="45"
          onChangeText={setAskingPrice}
        />
        <AppField
          label="Minimum price (USD)"
          value={minimumPrice}
          keyboardType="decimal-pad"
          placeholder="30"
          onChangeText={setMinimumPrice}
        />
      </AppCard>

      {suggestion.unresolvedQuestions.length > 0 ? (
        <AppCard
          title="Worth checking"
          subtitle="These details may affect accuracy or value; they are not added as facts."
        >
          {suggestion.unresolvedQuestions.map((question) => (
            <Text key={question} style={styles.note}>
              • {question}
            </Text>
          ))}
        </AppCard>
      ) : null}

      {(bundleSuggestions.data?.suggestions.length ?? 0) > 0 ? (
        <AppCard
          title="Bundle opportunity"
          subtitle="Related active inventory may clear faster as one listing. You decide whether to combine it."
        >
          {bundleSuggestions.data!.suggestions.map((bundle) => (
            <View key={bundle.itemIds.join("-")} style={styles.pricingEvidence}>
              <Text style={styles.identity}>{bundle.suggestedTitle}</Text>
              <Text style={styles.note}>
                {bundle.itemIds.length} items ·{" "}
                {Math.round(bundle.confidence * 100)}% match ·{" "}
                {bundle.rationale.join(", ")}
              </Text>
            </View>
          ))}
        </AppCard>
      ) : null}

      {omittedFacts.length > 0 ? (
        <AppCard title="Held back from the listing">
          <Text style={styles.note}>
            Unconfirmed or low-confidence details: {omittedFacts.join(", ")}.
          </Text>
        </AppCard>
      ) : null}

      <AppCard
        title="Restricted-item screen"
        trailing={
          <StatusBadge
            label={restrictedScreen.status}
            tone={restrictedScreen.status === "clear" ? "success" : "danger"}
          />
        }
      >
        {restrictedScreen.reasons.length === 0 ? (
          <Text style={styles.note}>
            No visual warning signal was found. You remain responsible for
            platform rules and applicable law.
          </Text>
        ) : (
          restrictedScreen.reasons.map((reason) => (
            <Text key={reason} style={styles.error}>
              {reason}
            </Text>
          ))
        )}
      </AppCard>

      {submitError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {submitError}
        </Text>
      ) : null}
      <AppButton
        label="Approve listing and choose platforms"
        loading={createListing.isPending}
        disabled={
          !title.trim() ||
          !category.trim() ||
          !description.trim() ||
          !conditionSummary.trim() ||
          restrictedScreen.status !== "clear" ||
          pendingPrivacyReview.length > 0
        }
        onPress={() => {
          setSubmitError(null);
          createListing.mutate();
        }}
      />
      <Text style={styles.disclaimer}>
        Photo analysis is a suggestion. Your approval creates a new canonical
        listing version.
      </Text>
    </Screen>
  );
}

function dollarsToCents(value: string): number | null {
  if (!/^\d+(?:\.\d{0,2})?$/.test(value.trim())) return null;
  const dollars = Number(value);
  if (!Number.isFinite(dollars)) return null;
  return Math.round(dollars * 100);
}

function MediaPreview({ storagePath }: { storagePath: string }) {
  const readUrl = useQuery({
    queryKey: ["media-url", storagePath],
    queryFn: () => createMediaReadUrl(storagePath),
    staleTime: 8 * 60_000,
  });
  if (!readUrl.data) {
    return (
      <View style={styles.mediaPlaceholder}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  return (
    <Image
      source={{ uri: readUrl.data }}
      style={styles.mediaImage}
      accessibilityLabel="Item photo under review"
    />
  );
}

function approvedFactRecord(
  facts: Array<{
    name: string;
    value: string;
    provenance: "image_derived" | "inferred";
    confidence: number;
  }>,
) {
  return Object.fromEntries(
    facts
      .filter(
        (fact) =>
          fact.provenance === "image_derived" && fact.confidence >= 0.85,
      )
      .map((fact) => [
        fact.name,
        {
          value: fact.value,
          provenance: "image_derived" as const,
          confidence: fact.confidence,
          sourceLabel: "Visible in item photos",
        },
      ]),
  );
}

function conditionMultiplier(condition: Item["condition"]): number {
  return {
    new: 1.15,
    like_new: 1.05,
    good: 1,
    fair: 0.8,
    poor: 0.55,
    for_parts: 0.35,
    unknown: 0.85,
  }[condition];
}

const styles = StyleSheet.create({
  body: { ...typography.body, color: colors.muted, textAlign: "center" },
  identity: { ...typography.body, color: colors.ink, fontWeight: "700" },
  note: { ...typography.caption, color: colors.muted },
  error: { ...typography.body, color: colors.danger },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  pricingEvidence: { gap: spacing.xs },
  mediaGrid: { gap: spacing.md },
  mediaReview: {
    gap: spacing.xs,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: spacing.md,
  },
  mediaImage: {
    width: "100%",
    aspectRatio: 4 / 3,
    borderRadius: 12,
    backgroundColor: colors.border,
  },
  mediaPlaceholder: {
    width: "100%",
    aspectRatio: 4 / 3,
    borderRadius: 12,
    backgroundColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  warning: { ...typography.caption, color: colors.danger, fontWeight: "700" },
  success: { ...typography.caption, color: colors.primary, fontWeight: "700" },
  disclaimer: {
    ...typography.caption,
    color: colors.muted,
    textAlign: "center",
  },
});
