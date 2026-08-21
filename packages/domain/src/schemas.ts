import { z } from "zod";

export const EntityIdSchema = z.string().trim().min(1).max(128);
export type EntityId = z.infer<typeof EntityIdSchema>;

export const TimestampSchema = z.string().datetime({ offset: true });

export const TimezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, "Timezone must be a valid IANA timezone");

export const ConfidenceSchema = z.number().min(0).max(1);

export const AuthMethodSchema = z.enum(["apple", "google", "email"]);
export type AuthMethod = z.infer<typeof AuthMethodSchema>;

export const ExchangeOptionSchema = z.enum([
  "public_meetup",
  "porch_pickup",
  "buyer_pickup",
  "local_delivery",
  "decide_per_item",
]);
export type ExchangeOption = z.infer<typeof ExchangeOptionSchema>;

export const PaymentWordingSchema = z.enum([
  "cash_preferred",
  "external_apps_accepted",
  "decide_at_meetup",
]);
export type PaymentWording = z.infer<typeof PaymentWordingSchema>;

export const HouseholdGoalSchema = z.enum(["sell_few_items", "clear_a_space"]);
export type HouseholdGoal = z.infer<typeof HouseholdGoalSchema>;

export const AvailabilityWindowSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    startMinutes: z.number().int().min(0).max(1439),
    endMinutes: z.number().int().min(1).max(1440),
  })
  .refine((window) => window.endMinutes > window.startMinutes, {
    message: "Availability must end after it starts",
  });

export const MeetupLocationSchema = z.object({
  id: EntityIdSchema,
  name: z.string().trim().min(1).max(120),
  publicDescription: z.string().trim().min(1).max(240),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

export const PriceRuleSchema = z
  .object({
    defaultMinimumOfferPercent: z.number().min(0).max(100).default(70),
    defaultHoldMinutes: z.number().int().min(0).max(10_080).default(120),
    acceptsTrades: z.boolean().default(false),
  })
  .strict();

export const HouseholdSchema = z
  .object({
    id: EntityIdSchema,
    ownerId: EntityIdSchema,
    name: z.string().trim().min(1).max(120),
    goal: HouseholdGoalSchema,
    zipCode: z.string().regex(/^\d{5}(?:-\d{4})?$/),
    sellingRadiusMiles: z.number().int().min(1).max(250),
    exchangePreferences: z.array(ExchangeOptionSchema).min(1),
    paymentWording: PaymentWordingSchema,
    availability: z.array(AvailabilityWindowSchema).max(28),
    preferredMeetupLocations: z.array(MeetupLocationSchema).max(20),
    priceRules: PriceRuleSchema,
    timezone: TimezoneSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type Household = z.infer<typeof HouseholdSchema>;

export const DeviceConnectionStatusSchema = z.enum([
  "pairing",
  "online",
  "offline",
  "revoked",
]);

export const SellerDeviceSchema = z
  .object({
    id: EntityIdSchema,
    householdId: EntityIdSchema,
    displayName: z.string().trim().min(1).max(120),
    publicKey: z.string().min(32),
    androidVersion: z.number().int().min(11),
    appVersion: z.string().trim().min(1).max(64),
    isPrimary: z.boolean(),
    connectionStatus: DeviceConnectionStatusSchema,
    batteryPercent: z.number().int().min(0).max(100).nullable(),
    isCharging: z.boolean().nullable(),
    networkType: z.enum(["wifi", "cellular", "ethernet", "offline", "unknown"]),
    lastCheckInAt: TimestampSchema.nullable(),
    capabilities: z.array(z.string().trim().min(1)).max(50),
    revokedAt: TimestampSchema.nullable(),
  })
  .strict();
export type SellerDevice = z.infer<typeof SellerDeviceSchema>;

export const ConnectorCapabilitySchema = z.enum([
  "publish",
  "edit",
  "delist",
  "mark_sold",
  "message_read",
  "message_send",
  "import",
]);
export type ConnectorCapability = z.infer<typeof ConnectorCapabilitySchema>;

export const ConnectorPolicyStatusSchema = z.enum([
  "approved",
  "review",
  "internal_only",
  "disabled",
]);
export type ConnectorPolicyStatus = z.infer<typeof ConnectorPolicyStatusSchema>;

export const ConnectorKindSchema = z.enum([
  "api",
  "android",
  "browser",
  "import",
]);
export type ConnectorKind = z.infer<typeof ConnectorKindSchema>;

export const PlatformConnectionSchema = z
  .object({
    id: EntityIdSchema,
    sellerDeviceId: EntityIdSchema.nullable(),
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
    lastVerifiedAt: TimestampSchema.nullable(),
    supportedCapabilities: z.array(ConnectorCapabilitySchema),
    policyStatus: ConnectorPolicyStatusSchema,
  })
  .strict();
export type PlatformConnection = z.infer<typeof PlatformConnectionSchema>;

export const ItemStatusSchema = z.enum([
  "captured",
  "draft",
  "ready",
  "publishing",
  "partially_live",
  "live",
  "reserved",
  "sold",
  "given_away",
  "donated",
  "recycled",
  "discarded",
  "archived",
]);
export type ItemStatus = z.infer<typeof ItemStatusSchema>;

export const ClearingRecommendationSchema = z.enum([
  "sell",
  "bundle",
  "give_away",
  "donate",
  "recycle",
  "discard",
]);
export type ClearingRecommendation = z.infer<
  typeof ClearingRecommendationSchema
>;

export const SpecificationProvenanceSchema = z.enum([
  "image_derived",
  "catalog_derived",
  "user_confirmed",
  "inferred",
]);
export type SpecificationProvenance = z.infer<
  typeof SpecificationProvenanceSchema
>;

export const SpecificationValueSchema = z
  .object({
    value: z.union([z.string(), z.number(), z.boolean()]),
    provenance: SpecificationProvenanceSchema,
    confidence: ConfidenceSchema,
    sourceLabel: z.string().trim().max(200).optional(),
  })
  .strict();
export type SpecificationValue = z.infer<typeof SpecificationValueSchema>;

export const IdentificationSchema = z
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
  .strict();
export type Identification = z.infer<typeof IdentificationSchema>;

export const MediaQualityIssueSchema = z.enum([
  "blur",
  "poor_lighting",
  "glare",
  "incomplete_framing",
  "possible_face",
  "possible_document",
  "possible_address",
  "possible_license_plate",
]);

export const MediaAssetSchema = z
  .object({
    id: EntityIdSchema,
    itemId: EntityIdSchema,
    storagePath: z.string().trim().min(1).max(1_024),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    order: z.number().int().min(0).max(11),
    isLead: z.boolean(),
    qualityIssues: z.array(MediaQualityIssueSchema),
    redactionState: z.enum([
      "not_needed",
      "suggested",
      "reviewed_not_needed",
      "approved",
      "applied",
    ]),
    source: z.enum(["camera", "library", "import"]),
    exifLocationStripped: z.boolean(),
    retentionState: z.enum([
      "permanent",
      "temporary",
      "deletion_scheduled",
      "deleted",
    ]),
    createdAt: TimestampSchema,
  })
  .strict();
export type MediaAsset = z.infer<typeof MediaAssetSchema>;

export const ItemSchema = z
  .object({
    id: EntityIdSchema,
    householdId: EntityIdSchema,
    title: z.string().trim().min(1).max(240),
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
    storageLocation: z.string().trim().max(240).nullable(),
    identification: IdentificationSchema,
    clearingRecommendation: ClearingRecommendationSchema,
    status: ItemStatusSchema,
    media: z.array(MediaAssetSchema).min(1).max(12),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type Item = z.infer<typeof ItemSchema>;

export const PriceStrategySchema = z.enum([
  "sell_fast",
  "balanced",
  "maximize_value",
]);
export type PriceStrategy = z.infer<typeof PriceStrategySchema>;

export const MoneySchema = z
  .object({
    amountCents: z.number().int().min(0),
    currency: z.string().length(3).default("USD"),
  })
  .strict();
export type Money = z.infer<typeof MoneySchema>;

export const PriceRecommendationSchema = z
  .object({
    strategy: PriceStrategySchema,
    price: MoneySchema,
    confidence: ConfidenceSchema,
    comparableCount: z.number().int().min(0),
    soldComparableCount: z.number().int().min(0),
    askingComparableCount: z.number().int().min(0),
    adjustmentFactors: z.array(z.string().trim().min(1).max(240)),
    disclaimer: z.string().trim().min(1).max(500),
  })
  .strict();
export type PriceRecommendation = z.infer<typeof PriceRecommendationSchema>;

export const ListingLocationSchema = z
  .object({
    zipCode: z.string().regex(/^\d{5}(?:-\d{4})?$/),
    displayArea: z.string().trim().min(1).max(160),
    radiusMiles: z.number().int().min(1).max(250),
  })
  .strict();

export const CanonicalListingSchema = z
  .object({
    id: EntityIdSchema,
    itemId: EntityIdSchema,
    version: z.number().int().min(1),
    title: z.string().trim().min(1).max(240),
    description: z.string().trim().min(1).max(10_000),
    conditionSummary: z.string().trim().min(1).max(2_000),
    specifications: z.record(z.string(), SpecificationValueSchema),
    priceStrategy: PriceStrategySchema,
    askingPrice: MoneySchema,
    minimumPrice: MoneySchema,
    location: ListingLocationSchema,
    exchangeOptions: z.array(ExchangeOptionSchema).min(1),
    paymentWording: PaymentWordingSchema,
    negotiationRules: PriceRuleSchema,
    restrictedItemStatus: z.enum(["clear", "review", "blocked"]),
    restrictedItemReasons: z.array(z.string().trim().min(1).max(500)),
    approvedAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema,
  })
  .strict()
  .refine(
    (listing) =>
      listing.minimumPrice.amountCents <= listing.askingPrice.amountCents,
    {
      message: "Minimum price cannot exceed asking price",
      path: ["minimumPrice"],
    },
  );
export type CanonicalListing = z.infer<typeof CanonicalListingSchema>;

export const PlatformListingStatusSchema = z.enum([
  "not_published",
  "publishing",
  "live",
  "reserved",
  "sold",
  "delisted",
  "needs_action",
  "failed",
]);

export const PlatformListingSchema = z
  .object({
    id: EntityIdSchema,
    itemId: EntityIdSchema,
    platform: z.string().trim().min(1).max(80),
    externalListingId: z.string().trim().max(240).nullable(),
    externalUrl: z.url().nullable(),
    platformTitle: z.string().trim().min(1).max(500),
    platformPrice: MoneySchema,
    status: PlatformListingStatusSchema,
    publishedAt: TimestampSchema.nullable(),
    lastSynchronizedAt: TimestampSchema.nullable(),
    connectorVersion: z.string().trim().min(1).max(64),
  })
  .strict();
export type PlatformListing = z.infer<typeof PlatformListingSchema>;

export const PublishingJobStateSchema = z.enum([
  "DRAFT",
  "READY",
  "QUEUED",
  "DEVICE_WAKE",
  "OPEN_PLATFORM",
  "VERIFY_SESSION",
  "PRECHECK",
  "UPLOAD_MEDIA",
  "FILL_FIELDS",
  "VALIDATE",
  "SUBMIT",
  "VERIFY_PUBLISHED",
  "SYNC_RESULT",
  "PUBLISHED",
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
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
  "CANCELLED",
]);
export type PublishingJobState = z.infer<typeof PublishingJobStateSchema>;

export const PublishingCommandActionSchema = z.enum([
  "publish",
  "update_fields",
  "mark_sold",
  "delist",
  "check_connection",
  "pause",
  "resume",
]);
export type PublishingCommandAction = z.infer<
  typeof PublishingCommandActionSchema
>;

export const PublishingJobSchema = z
  .object({
    id: EntityIdSchema,
    householdId: EntityIdSchema,
    itemId: EntityIdSchema,
    platform: z.string().trim().min(1).max(80),
    listingVersion: z.number().int().min(1),
    commandAction: PublishingCommandActionSchema,
    idempotencyKey: z.string().trim().min(1).max(512),
    currentState: PublishingJobStateSchema,
    lastVerifiedState: PublishingJobStateSchema,
    resumeState: PublishingJobStateSchema.nullable(),
    retryCount: z.number().int().min(0),
    maxRetries: z.number().int().min(0).max(10),
    nextRetryAt: TimestampSchema.nullable(),
    deviceId: EntityIdSchema.nullable(),
    connectorVersion: z.string().trim().min(1).max(64),
    platformAppVersion: z.string().trim().min(1).max(64).nullable(),
    errorCode: z.string().trim().max(120).nullable(),
    errorDetail: z.string().trim().max(1_000).nullable(),
    commandExpiresAt: TimestampSchema,
    createdAt: TimestampSchema,
    startedAt: TimestampSchema.nullable(),
    completedAt: TimestampSchema.nullable(),
    updatedAt: TimestampSchema,
  })
  .strict();
export type PublishingJob = z.infer<typeof PublishingJobSchema>;

export const BuyerIntentSchema = z.enum([
  "availability",
  "price_offer",
  "product_question",
  "dimensions_or_compatibility",
  "pickup_availability",
  "delivery_request",
  "trade_request",
  "suspected_scam",
  "no_show_follow_up",
  "other",
]);
export type BuyerIntent = z.infer<typeof BuyerIntentSchema>;

export const BuyerTaskSchema = z
  .object({
    id: EntityIdSchema,
    platformListingId: EntityIdSchema,
    participantAlias: z.string().trim().min(1).max(120),
    intent: BuyerIntentSchema,
    redactedMessageExcerpt: z.string().trim().max(1_000),
    suggestedResponse: z.string().trim().min(1).max(2_000),
    approvalState: z.enum(["pending", "approved", "rejected", "sent"]),
    priceOffer: MoneySchema.nullable(),
    schedulingState: z.enum(["none", "proposed", "confirmed", "cancelled"]),
    requiresAddressApproval: z.boolean(),
    scamSignals: z.array(z.string().trim().min(1).max(240)),
    createdAt: TimestampSchema,
  })
  .strict();
export type BuyerTask = z.infer<typeof BuyerTaskSchema>;

export const NotificationTypeSchema = z.enum([
  "publishing_paused",
  "publishing_failed",
  "publishing_published",
  "device_attention",
  "buyer_task",
  "inventory_exception",
]);

export const UserNotificationSchema = z
  .object({
    id: EntityIdSchema,
    householdId: EntityIdSchema,
    userId: EntityIdSchema,
    type: NotificationTypeSchema,
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().min(1).max(500),
    actionPath: z.string().trim().min(1).max(500).nullable(),
    deliveryState: z.enum(["queued", "sent", "failed", "no_subscription"]),
    deliveryAttempts: z.number().int().min(0).max(10),
    nextDeliveryAt: TimestampSchema,
    providerTicketIds: z.array(z.string().trim().min(1).max(240)).max(20),
    readAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema,
  })
  .strict();
export type UserNotification = z.infer<typeof UserNotificationSchema>;

export const PushSubscriptionSchema = z
  .object({
    id: EntityIdSchema,
    userId: EntityIdSchema,
    expoPushToken: z
      .string()
      .regex(/^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]+\]$/),
    platform: z.enum(["android", "ios"]),
    enabled: z.boolean(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type PushSubscription = z.infer<typeof PushSubscriptionSchema>;

export const MeetupSchema = z
  .object({
    id: EntityIdSchema,
    itemId: EntityIdSchema,
    platformListingId: EntityIdSchema,
    buyerAlias: z.string().trim().min(1).max(120),
    scheduledAt: TimestampSchema,
    locationType: ExchangeOptionSchema.exclude(["decide_per_item"]),
    approvedLocation: z.string().trim().min(1).max(500),
    exactAddressApprovedAt: TimestampSchema.nullable(),
    status: z.enum([
      "proposed",
      "confirmed",
      "completed",
      "cancelled",
      "no_show",
    ]),
  })
  .strict();
export type Meetup = z.infer<typeof MeetupSchema>;

export const BackupBuyerEntrySchema = z
  .object({
    id: EntityIdSchema,
    householdId: EntityIdSchema,
    itemId: EntityIdSchema,
    platformListingId: EntityIdSchema,
    buyerTaskId: EntityIdSchema,
    participantAlias: z.string().trim().min(1).max(120),
    position: z.number().int().positive(),
    status: z.enum(["waiting", "promoted", "removed"]),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type BackupBuyerEntry = z.infer<typeof BackupBuyerEntrySchema>;

export const FeatureFlagChangeSchema = z
  .object({
    version: z.number().int().positive(),
    changedAt: TimestampSchema,
    changedBy: EntityIdSchema,
    summary: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const FeatureFlagSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{2,79}$/),
    description: z.string().trim().min(1).max(500),
    enabled: z.boolean(),
    killSwitchReason: z.string().trim().min(1).max(500).nullable(),
    owner: z.string().trim().min(1).max(160),
    version: z.number().int().positive(),
    updatedAt: TimestampSchema,
    changeLog: z.array(FeatureFlagChangeSchema).max(1_000),
  })
  .strict()
  .refine((value) => value.enabled === (value.killSwitchReason === null), {
    message: "Disabled feature flags require a kill-switch reason",
    path: ["killSwitchReason"],
  });
export type FeatureFlag = z.infer<typeof FeatureFlagSchema>;

export const SupportAccessScopeSchema = z.enum([
  "job_metadata",
  "device_health",
  "diagnostic_artifacts",
]);
export type SupportAccessScope = z.infer<typeof SupportAccessScopeSchema>;

export const SupportAccessGrantSchema = z
  .object({
    id: EntityIdSchema,
    householdId: EntityIdSchema,
    grantedBy: EntityIdSchema,
    supportActorId: EntityIdSchema,
    reasonCode: z.enum([
      "user_requested_troubleshooting",
      "publishing_failure_review",
      "device_pairing_help",
    ]),
    scope: z.array(SupportAccessScopeSchema).min(1).max(3),
    diagnosticConsent: z.boolean(),
    expiresAt: TimestampSchema,
    revokedAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema,
  })
  .strict()
  .refine(
    (value) =>
      !value.scope.includes("diagnostic_artifacts") || value.diagnosticConsent,
    {
      message: "Diagnostic access requires explicit consent",
      path: ["diagnosticConsent"],
    },
  );
export type SupportAccessGrant = z.infer<typeof SupportAccessGrantSchema>;

export const DiagnosticArtifactSchema = z
  .object({
    id: EntityIdSchema,
    householdId: EntityIdSchema,
    grantId: EntityIdSchema,
    submittedBy: EntityIdSchema,
    kind: z.enum(["publishing_screen", "device_health", "error_context"]),
    storagePath: z.string().trim().min(1).max(1_024),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    redacted: z.literal(true),
    privacyScanPassed: z.literal(true),
    consentedAt: TimestampSchema,
    createdAt: TimestampSchema,
  })
  .strict();
export type DiagnosticArtifact = z.infer<typeof DiagnosticArtifactSchema>;

export const ReleaseEvidenceKindSchema = z.enum([
  "threat_model",
  "security_architecture_review",
  "mobile_penetration_test",
  "api_penetration_test",
  "dependency_scan",
  "secret_scan",
  "sbom",
  "incident_response_plan",
  "data_retention_policy",
  "privacy_policy",
  "terms_of_use",
]);
export type ReleaseEvidenceKind = z.infer<typeof ReleaseEvidenceKindSchema>;

export const ReleaseEvidenceSchema = z
  .object({
    kind: ReleaseEvidenceKindSchema,
    status: z.enum(["passed", "approved"]),
    evidenceUrl: z.url(),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    verifiedAt: TimestampSchema,
  })
  .strict();
export type ReleaseEvidence = z.infer<typeof ReleaseEvidenceSchema>;

export const ProductionReleaseSchema = z
  .object({
    id: EntityIdSchema,
    version: z.string().regex(/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    target: z.enum(["public_beta", "v1_public"]),
    summary: z.string().trim().min(1).max(2_000),
    connectorIds: z.array(EntityIdSchema).min(2).max(100),
    evidence: z.array(ReleaseEvidenceSchema).max(50),
    status: z.enum([
      "draft",
      "pending_approval",
      "approved",
      "deployed",
      "rejected",
      "rolled_back",
    ]),
    createdBy: EntityIdSchema,
    approvalActorIds: z.array(EntityIdSchema).max(2),
    rejectionReason: z.string().trim().min(1).max(1_000).nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    approvedAt: TimestampSchema.nullable(),
    deployedAt: TimestampSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.connectorIds).size !== value.connectorIds.length) {
      context.addIssue({
        code: "custom",
        path: ["connectorIds"],
        message: "Release connector IDs must be unique",
      });
    }
    if (
      new Set(value.approvalActorIds).size !== value.approvalActorIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["approvalActorIds"],
        message: "Release approvers must be distinct",
      });
    }
    if (value.approvalActorIds.includes(value.createdBy)) {
      context.addIssue({
        code: "custom",
        path: ["approvalActorIds"],
        message: "A release author cannot approve their own release",
      });
    }
    if (
      ["approved", "deployed", "rolled_back"].includes(value.status) &&
      (value.approvalActorIds.length !== 2 || value.approvedAt === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["approvalActorIds"],
        message: "Approved releases require two distinct approvers",
      });
    }
    if (value.status === "deployed" && value.deployedAt === null) {
      context.addIssue({
        code: "custom",
        path: ["deployedAt"],
        message: "A deployed release requires a deployment time",
      });
    }
    if (value.status === "rejected" && value.rejectionReason === null) {
      context.addIssue({
        code: "custom",
        path: ["rejectionReason"],
        message: "A rejected release requires a reason",
      });
    }
  });
export type ProductionRelease = z.infer<typeof ProductionReleaseSchema>;

export const AuditEventSchema = z
  .object({
    id: EntityIdSchema,
    actorId: EntityIdSchema,
    actorType: z.enum(["user", "device", "service", "admin"]),
    action: z.string().trim().min(1).max(160),
    objectType: z.string().trim().min(1).max(80),
    objectId: EntityIdSchema,
    timestamp: TimestampSchema,
    deviceId: EntityIdSchema.nullable(),
    redactedMetadata: z.record(z.string(), z.unknown()),
  })
  .strict();
export type AuditEvent = z.infer<typeof AuditEventSchema>;
