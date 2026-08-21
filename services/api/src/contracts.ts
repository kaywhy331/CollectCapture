import {
  ConfidenceSchema,
  ConnectorCapabilitySchema,
  ClearingRecommendationSchema,
  ExchangeOptionSchema,
  HouseholdGoalSchema,
  IdentificationSchema,
  ItemStatusSchema,
  MediaQualityIssueSchema,
  MoneySchema,
  PaymentWordingSchema,
  PriceRuleSchema,
  PriceStrategySchema,
  PricingFactorsSchema,
  ReleaseEvidenceSchema,
  SpecificationValueSchema,
  TimestampSchema,
  TimezoneSchema,
  SupportAccessScopeSchema,
} from "@localclear/domain";
import { PairingResponseSchema } from "@localclear/device-protocol";
import { z } from "zod";

export const CreateHouseholdRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    goal: HouseholdGoalSchema.default("sell_few_items"),
    zipCode: z.string().regex(/^\d{5}(?:-\d{4})?$/),
    sellingRadiusMiles: z.number().int().min(1).max(250),
    exchangePreferences: z.array(ExchangeOptionSchema).min(1),
    paymentWording: PaymentWordingSchema,
    availability: z
      .array(
        z
          .object({
            dayOfWeek: z.number().int().min(0).max(6),
            startMinutes: z.number().int().min(0).max(1439),
            endMinutes: z.number().int().min(1).max(1440),
          })
          .refine((window) => window.endMinutes > window.startMinutes),
      )
      .max(28)
      .default([]),
    preferredMeetupLocations: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(120),
          publicDescription: z.string().trim().min(1).max(240),
          latitude: z.number().min(-90).max(90).optional(),
          longitude: z.number().min(-180).max(180).optional(),
        }),
      )
      .max(20)
      .default([]),
    priceRules: PriceRuleSchema.default({
      defaultMinimumOfferPercent: 70,
      defaultHoldMinutes: 120,
      acceptsTrades: false,
    }),
    timezone: TimezoneSchema,
  })
  .strict();
export type CreateHouseholdRequest = z.infer<
  typeof CreateHouseholdRequestSchema
>;
export const UpdateHouseholdRequestSchema = CreateHouseholdRequestSchema;
export type UpdateHouseholdRequest = CreateHouseholdRequest;

export const CapturedPhotoInputSchema = z
  .object({
    storagePath: z.string().trim().min(1).max(1_024),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    source: z.enum(["camera", "library", "import"]),
    qualityIssues: z.array(MediaQualityIssueSchema).default([]),
    redactionState: z
      .enum([
        "not_needed",
        "suggested",
        "reviewed_not_needed",
        "approved",
        "applied",
      ])
      .default("not_needed"),
    exifLocationStripped: z.boolean().default(false),
  })
  .strict();

export const CapturedItemInputSchema = z
  .object({
    title: z.string().trim().min(1).max(240).optional(),
    category: z.string().trim().min(1).max(160).optional(),
    brand: z.string().trim().max(160).nullable().default(null),
    model: z.string().trim().max(160).nullable().default(null),
    condition: z
      .enum(["new", "like_new", "good", "fair", "poor", "for_parts", "unknown"])
      .default("unknown"),
    dimensions: z.record(z.string(), SpecificationValueSchema).default({}),
    specifications: z.record(z.string(), SpecificationValueSchema).default({}),
    accessories: z
      .array(z.string().trim().min(1).max(240))
      .max(100)
      .default([]),
    defects: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
    storageLocation: z.string().trim().max(240).nullable().default(null),
    identification: z
      .object({
        itemType: z.string().trim().min(1).max(160),
        category: z.string().trim().min(1).max(160),
        brand: z.string().trim().max(160).nullable(),
        model: z.string().trim().max(160).nullable(),
        confidence: ConfidenceSchema,
        alternatives: z
          .array(
            z.object({
              label: z.string().trim().min(1).max(240),
              confidence: ConfidenceSchema,
            }),
          )
          .max(3),
        extractedText: z.array(z.string().trim().min(1).max(500)).max(100),
        barcodes: z.array(z.string().trim().min(4).max(32)).max(20),
      })
      .optional(),
    clearingRecommendation: z
      .enum(["sell", "bundle", "give_away", "donate", "recycle", "discard"])
      .default("sell"),
    photos: z.array(CapturedPhotoInputSchema).min(1).max(12),
    barcode: z.string().trim().min(4).max(32).nullable().default(null),
    imageFingerprint: z
      .string()
      .trim()
      .min(8)
      .max(512)
      .nullable()
      .default(null),
  })
  .strict();
export type CapturedItemInput = z.infer<typeof CapturedItemInputSchema>;

export const ReplaceMediaAssetRequestSchema = z
  .object({
    replacement: CapturedPhotoInputSchema,
    confirmPrivateDetailsRemoved: z.literal(true),
  })
  .strict();
export type ReplaceMediaAssetRequest = z.infer<
  typeof ReplaceMediaAssetRequestSchema
>;

export const ReviewMediaPrivacyRequestSchema = z
  .object({ action: z.literal("confirm_not_private") })
  .strict();
export type ReviewMediaPrivacyRequest = z.infer<
  typeof ReviewMediaPrivacyRequestSchema
>;

export const BatchCaptureRequestSchema = z
  .object({
    items: z.array(CapturedItemInputSchema).min(1).max(100),
  })
  .strict();

export const CreateListingRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    description: z.string().trim().min(1).max(10_000),
    conditionSummary: z.string().trim().min(1).max(2_000),
    specifications: z.record(z.string(), SpecificationValueSchema),
    priceStrategy: PriceStrategySchema,
    askingPrice: MoneySchema,
    minimumPrice: MoneySchema,
    location: z.object({
      zipCode: z.string().regex(/^\d{5}(?:-\d{4})?$/),
      displayArea: z.string().trim().min(1).max(160),
      radiusMiles: z.number().int().min(1).max(250),
    }),
    exchangeOptions: z.array(ExchangeOptionSchema).min(1),
    paymentWording: PaymentWordingSchema,
    negotiationRules: PriceRuleSchema,
    restrictedItemStatus: z.enum(["clear", "review", "blocked"]),
    restrictedItemReasons: z.array(z.string().trim().min(1).max(500)),
    itemReview: z
      .object({
        identification: IdentificationSchema,
        category: z.string().trim().min(1).max(160),
        brand: z.string().trim().max(160).nullable(),
        model: z.string().trim().max(160).nullable(),
        condition: z.enum([
          "new",
          "like_new",
          "good",
          "fair",
          "poor",
          "for_parts",
          "unknown",
        ]),
        dimensions: z.record(z.string(), SpecificationValueSchema),
        specifications: z.record(z.string(), SpecificationValueSchema),
        accessories: z.array(z.string().trim().min(1).max(240)).max(100),
        defects: z.array(z.string().trim().min(1).max(500)).max(100),
        clearingRecommendation: ClearingRecommendationSchema,
      })
      .strict()
      .optional(),
    approve: z.boolean().default(false),
  })
  .strict();
export type CreateListingRequest = z.infer<typeof CreateListingRequestSchema>;

export const PublishRequestSchema = z
  .object({
    platforms: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
    listingVersion: z.number().int().min(1),
    sellerDeviceId: z.string().trim().min(1).max(128).nullable().default(null),
    duplicateOverride: z.boolean().default(false),
  })
  .strict();
export type PublishRequest = z.infer<typeof PublishRequestSchema>;

export const BatchPublishRequestSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            itemId: z.string().trim().min(1).max(128),
            platforms: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
            listingVersion: z.number().int().min(1),
            sellerDeviceId: z
              .string()
              .trim()
              .min(1)
              .max(128)
              .nullable()
              .default(null),
            duplicateOverride: z.boolean().default(false),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type BatchPublishRequest = z.infer<typeof BatchPublishRequestSchema>;

export const ItemLifecycleActionRequestSchema = z
  .object({ action: z.enum(["reserve", "relist", "archive"]) })
  .strict();
export type ItemLifecycleActionRequest = z.infer<
  typeof ItemLifecycleActionRequestSchema
>;

export const PropagateListingRequestSchema = z
  .object({ listingVersion: z.number().int().min(1) })
  .strict();

export const PriceRecommendationRequestSchema = z
  .object({
    factors: PricingFactorsSchema.default({
      conditionMultiplier: 1,
      localDemandMultiplier: 1,
      seasonalityMultiplier: 1,
    }),
    estimatedEffortMinutes: z.number().int().min(1).max(1_440).default(30),
    minimumWorthwhileHourlyCents: z
      .number()
      .int()
      .min(100)
      .max(100_000)
      .default(1_500),
  })
  .strict();
export type PriceRecommendationRequest = z.infer<
  typeof PriceRecommendationRequestSchema
>;

const PausedStateSchema = z.enum([
  "NEEDS_LOGIN",
  "NEEDS_MFA",
  "NEEDS_CAPTCHA",
  "NEEDS_USER_CONFIRMATION",
  "NEEDS_REQUIRED_FIELD",
  "APP_VERSION_UNSUPPORTED",
  "PLATFORM_UI_CHANGED",
  "ITEM_BLOCKED",
  "LISTING_LIMIT_REACHED",
  "NETWORK_UNAVAILABLE",
  "DEVICE_OFFLINE",
]);

export const PublishingEventRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("advance") }),
  z.object({
    type: z.literal("pause"),
    state: PausedStateSchema,
    reasonCode: z.string().trim().min(1).max(120),
    detail: z.string().trim().max(1_000).optional(),
  }),
  z.object({
    type: z.literal("retryable_failure"),
    reasonCode: z.string().trim().min(1).max(120),
    detail: z.string().trim().max(1_000).optional(),
  }),
  z.object({
    type: z.literal("fatal_failure"),
    reasonCode: z.string().trim().min(1).max(120),
    detail: z.string().trim().max(1_000).optional(),
  }),
  z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("retry") }),
  z.object({
    type: z.literal("cancel"),
    reasonCode: z.string().trim().min(1).max(120).optional(),
  }),
]);

export const TransitionPublishingJobRequestSchema = z
  .object({
    event: PublishingEventRequestSchema,
    result: z
      .object({
        externalListingId: z.string().trim().max(240).nullable().default(null),
        externalUrl: z.url().nullable().default(null),
        platformTitle: z.string().trim().min(1).max(500).optional(),
        platformPrice: MoneySchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TransitionPublishingJobRequest = z.infer<
  typeof TransitionPublishingJobRequestSchema
>;

export const UserPublishingJobControlRequestSchema = z
  .object({
    event: z.discriminatedUnion("type", [
      z.object({ type: z.literal("resume") }),
      z.object({
        type: z.literal("cancel"),
        reasonCode: z.string().trim().min(1).max(120).optional(),
      }),
    ]),
  })
  .strict();
export type UserPublishingJobControlRequest = z.infer<
  typeof UserPublishingJobControlRequestSchema
>;

export const CompleteImportRequestSchema = z
  .object({
    confirmation: z.literal("I CONFIRM THIS LISTING IS LIVE"),
    externalListingId: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .nullable()
      .default(null),
    externalUrl: z.url().nullable().default(null),
    platformTitle: z.string().trim().min(1).max(500).optional(),
    platformPrice: MoneySchema.optional(),
  })
  .strict()
  .refine((value) => value.externalListingId || value.externalUrl, {
    message: "A live listing ID or URL is required",
  });
export type CompleteImportRequest = z.infer<typeof CompleteImportRequestSchema>;

export const CloseItemRequestSchema = z
  .object({
    outcome: z.enum(["sold", "given_away", "donated", "recycled", "discarded"]),
    salePriceCents: z.number().int().min(0).nullable().default(null),
    currency: z.string().length(3).nullable().default(null),
    destinationPlatform: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .nullable()
      .default(null),
    notes: z.string().trim().max(2_000).nullable().default(null),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.outcome === "sold" && value.salePriceCents === null) {
      context.addIssue({
        code: "custom",
        message: "Sale price is required when marking an item sold",
        path: ["salePriceCents"],
      });
    }
  });
export type CloseItemRequest = z.infer<typeof CloseItemRequestSchema>;

export const UpdateItemStatusRequestSchema = z
  .object({ status: ItemStatusSchema })
  .strict();

export const DeleteItemRequestSchema = z
  .object({ confirmTitle: z.string().trim().min(1).max(240) })
  .strict();

export const DeleteAccountRequestSchema = z
  .object({ confirmation: z.literal("DELETE MY ACCOUNT") })
  .strict();

export const CompletePairingRequestSchema = z
  .object({
    secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    response: PairingResponseSchema,
  })
  .strict();
export type CompletePairingRequest = z.infer<
  typeof CompletePairingRequestSchema
>;

export const IngestBuyerMessageRequestSchema = z
  .object({
    platformListingId: z.string().trim().min(1).max(128),
    participantAlias: z.string().trim().min(1).max(120),
    rawMessage: z.string().trim().min(1).max(4_000),
  })
  .strict();
export type IngestBuyerMessageRequest = z.infer<
  typeof IngestBuyerMessageRequestSchema
>;

export const BuyerTaskDecisionRequestSchema = z
  .object({
    decision: z.enum(["approve", "approve_and_send", "reject"]),
    responseText: z.string().trim().min(1).max(2_000).optional(),
    shareExactAddress: z.boolean().default(false),
  })
  .strict();
export type BuyerTaskDecisionRequest = z.infer<
  typeof BuyerTaskDecisionRequestSchema
>;

export const BuyerTaskActionRequestSchema = z
  .object({
    action: z.enum(["accept", "counter", "decline", "schedule"]),
    counterPriceCents: z.number().int().min(0).optional(),
  })
  .strict();
export type BuyerTaskActionRequest = z.infer<
  typeof BuyerTaskActionRequestSchema
>;

export const CreateMeetupRequestSchema = z
  .object({
    scheduledAt: TimestampSchema.optional(),
    locationType: ExchangeOptionSchema.exclude(["decide_per_item"]),
    preferredMeetupLocationId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .nullable()
      .default(null),
    approvedLocation: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .nullable()
      .default(null),
    exactAddressApproved: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.locationType !== "public_meetup" &&
      (!value.exactAddressApproved || !value.approvedLocation)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Private pickup or delivery requires an explicitly approved location",
        path: ["approvedLocation"],
      });
    }
    if (
      value.locationType === "public_meetup" &&
      value.approvedLocation !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "Public meetups must use a saved public meetup location",
        path: ["approvedLocation"],
      });
    }
  });
export type CreateMeetupRequest = z.infer<typeof CreateMeetupRequestSchema>;

export const UpdateMeetupRequestSchema = z
  .object({
    status: z.enum(["confirmed", "completed", "cancelled", "no_show"]),
  })
  .strict();
export type UpdateMeetupRequest = z.infer<typeof UpdateMeetupRequestSchema>;

export const UpdateBackupBuyerRequestSchema = z
  .object({ action: z.enum(["promote", "remove"]) })
  .strict();
export type UpdateBackupBuyerRequest = z.infer<
  typeof UpdateBackupBuyerRequestSchema
>;

export const DeviceCheckInRequestSchema = z
  .object({
    appVersion: z.string().trim().min(1).max(64),
    androidVersion: z.number().int().min(11),
    batteryPercent: z.number().int().min(0).max(100).nullable(),
    isCharging: z.boolean().nullable(),
    networkType: z.enum(["wifi", "cellular", "ethernet", "offline", "unknown"]),
    capabilities: z.array(z.string().trim().min(1).max(120)).max(50),
    platformConnections: z
      .array(
        z
          .object({
            platform: z.string().trim().min(1).max(80),
            appVersion: z.string().trim().min(1).max(64),
            displayAlias: z.string().trim().min(1).max(120),
            connectionStatus: z.enum([
              "not_connected",
              "connected",
              "needs_login",
              "unsupported_version",
              "disabled",
            ]),
            supportedCapabilities: z.array(ConnectorCapabilitySchema).max(7),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict();
export type DeviceCheckInRequest = z.infer<typeof DeviceCheckInRequestSchema>;

export const AdminConnectorUpdateRequestSchema = z
  .object({
    enabled: z.boolean(),
    killSwitchReason: z.string().trim().min(1).max(500).nullable(),
    policyStatus: z.enum(["approved", "review", "internal_only", "disabled"]),
    productionMethod: z.string().trim().min(1).max(500).nullable(),
    approvalEvidenceUrl: z.url().nullable(),
    owner: z.string().trim().min(1).max(160),
    supportedAppVersions: z.array(z.string().trim().min(1).max(64)).max(100),
    canaryTestId: z.string().trim().min(1).max(160).nullable(),
    changeSummary: z.string().trim().min(1).max(1_000),
  })
  .strict();
export type AdminConnectorUpdateRequest = z.infer<
  typeof AdminConnectorUpdateRequestSchema
>;

export const AdminFeatureFlagUpdateRequestSchema = z
  .object({
    enabled: z.boolean(),
    killSwitchReason: z.string().trim().min(1).max(500).nullable(),
    owner: z.string().trim().min(1).max(160),
    changeSummary: z.string().trim().min(1).max(1_000),
  })
  .strict();
export type AdminFeatureFlagUpdateRequest = z.infer<
  typeof AdminFeatureFlagUpdateRequestSchema
>;

export const CreateProductionReleaseRequestSchema = z
  .object({
    version: z.string().regex(/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    target: z.enum(["public_beta", "v1_public"]),
    summary: z.string().trim().min(1).max(2_000),
    connectorIds: z.array(z.string().trim().min(1).max(128)).min(2).max(100),
    evidence: z.array(ReleaseEvidenceSchema).max(50),
  })
  .strict();
export type CreateProductionReleaseRequest = z.infer<
  typeof CreateProductionReleaseRequestSchema
>;

export const ReviewProductionReleaseRequestSchema = z
  .object({
    action: z.enum(["approve", "reject", "deploy", "rollback"]),
    reason: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "reject" && !value.reason) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "A rejection reason is required",
      });
    }
  });
export type ReviewProductionReleaseRequest = z.infer<
  typeof ReviewProductionReleaseRequestSchema
>;

export const CreateSupportGrantRequestSchema = z
  .object({
    supportActorId: z.string().trim().min(1).max(128),
    reasonCode: z.enum([
      "user_requested_troubleshooting",
      "publishing_failure_review",
      "device_pairing_help",
    ]),
    scope: z.array(SupportAccessScopeSchema).min(1).max(3),
    durationMinutes: z.number().int().min(5).max(60),
    diagnosticConsentConfirmation: z
      .literal("I CONSENT TO REDACTED DIAGNOSTICS")
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.scope.includes("diagnostic_artifacts") &&
      value.diagnosticConsentConfirmation === null
    ) {
      context.addIssue({
        code: "custom",
        message: "Diagnostic access requires the exact consent confirmation",
        path: ["diagnosticConsentConfirmation"],
      });
    }
  });
export type CreateSupportGrantRequest = z.infer<
  typeof CreateSupportGrantRequestSchema
>;

export const CreateDiagnosticArtifactRequestSchema = z
  .object({
    grantId: z.string().trim().min(1).max(128),
    kind: z.enum(["publishing_screen", "device_health", "error_context"]),
    storagePath: z.string().trim().min(1).max(1_024),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    redacted: z.literal(true),
    privacyScanPassed: z.literal(true),
    consentConfirmation: z.literal(
      "I CONSENT TO UPLOAD THIS REDACTED DIAGNOSTIC",
    ),
  })
  .strict();
export type CreateDiagnosticArtifactRequest = z.infer<
  typeof CreateDiagnosticArtifactRequestSchema
>;

export const RegisterPushSubscriptionRequestSchema = z
  .object({
    expoPushToken: z
      .string()
      .regex(/^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]+\]$/),
    platform: z.enum(["android", "ios"]),
    enabled: z.boolean().default(true),
  })
  .strict();
export type RegisterPushSubscriptionRequest = z.infer<
  typeof RegisterPushSubscriptionRequestSchema
>;
