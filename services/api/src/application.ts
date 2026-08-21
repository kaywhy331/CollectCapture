import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  createPairingChallenge,
  verifyPairingResponse,
  type PairingQrPayload,
  type SignedDeviceCommand,
} from "@localclear/device-protocol";
import {
  AuditEventSchema,
  CanonicalListingSchema,
  CONNECTOR_CAPABILITIES,
  ConnectorManifestSchema,
  DiagnosticArtifactSchema,
  FeatureFlagSchema,
  HouseholdSchema,
  ItemEnrichmentSchema,
  ItemSchema,
  MeetupSchema,
  MissingConnectorFieldsError,
  PlatformListingSchema,
  PlatformConnectionSchema,
  ProductionReleaseSchema,
  PublishingJobSchema,
  PushSubscriptionSchema,
  SellerDeviceSchema,
  SupportAccessGrantSchema,
  UserNotificationSchema,
  assertEnrichmentEvidenceBelongsToItem,
  assertSpecificationsPublishable,
  createBuyerTaskDraft,
  createPlatformListingVariant,
  combineRestrictedScreens,
  approveProductionRelease,
  deployProductionRelease,
  deriveItemStatus,
  evaluateConnectorGate,
  findLikelyDuplicates,
  generateBuyerActionDraft,
  generatePriceRecommendations,
  isPausedPublishingState,
  isPublishingFlowState,
  nextAvailabilitySlots,
  planInventoryClosure,
  publishingIdempotencyKey,
  recommendClearingLane,
  restrictedScreenFromSignals,
  restrictedScreenFromText,
  rejectProductionRelease,
  ReleaseGateError,
  rollbackProductionRelease,
  submitProductionRelease,
  suggestRelatedItemBundles,
  transitionItemStatus,
  transitionPublishingJob,
  type ConnectorEnvironment,
  type BackupBuyerEntry,
  type ConnectorManifest,
  type DiagnosticArtifact,
  type FeatureFlag,
  type CanonicalListing,
  type Household,
  type ItemEnrichment,
  type ItemEnrichmentOutput,
  type Meetup,
  type PlatformListing,
  type PlatformConnection,
  type ProductionRelease,
  type PublishingCommandAction,
  type PublishingEvent,
  type PublishingJob,
  type SellerDevice,
  type SupportAccessGrant,
  type BuyerTask,
  type BundleSuggestion,
  type UserNotification,
} from "@localclear/domain";
import {
  BatchPublishRequestSchema,
  CapturedItemInputSchema,
  CloseItemRequestSchema,
  CompletePairingRequestSchema,
  CreateHouseholdRequestSchema,
  CreateListingRequestSchema,
  ItemLifecycleActionRequestSchema,
  PublishRequestSchema,
  PriceRecommendationRequestSchema,
  type CapturedItemInput,
  type BatchPublishRequest,
  type BuyerTaskDecisionRequest,
  type BuyerTaskActionRequest,
  type CreateMeetupRequest,
  type AdminConnectorUpdateRequest,
  type AdminFeatureFlagUpdateRequest,
  type CreateProductionReleaseRequest,
  type CloseItemRequest,
  type CompletePairingRequest,
  type CompleteImportRequest,
  type CreateHouseholdRequest,
  type CreateDiagnosticArtifactRequest,
  type CreateSupportGrantRequest,
  type UpdateHouseholdRequest,
  type CreateListingRequest,
  type DeviceCheckInRequest,
  type IngestBuyerMessageRequest,
  type PublishRequest,
  type PriceRecommendationRequest,
  type ItemLifecycleActionRequest,
  type RegisterPushSubscriptionRequest,
  type ReplaceMediaAssetRequest,
  type ReviewMediaPrivacyRequest,
  type ReviewProductionReleaseRequest,
  type UpdateBackupBuyerRequest,
  type UpdateMeetupRequest,
  type TransitionPublishingJobRequest,
  type UserPublishingJobControlRequest,
} from "./contracts.js";
import { ApplicationError, forbidden, notFound } from "./errors.js";
import {
  AccountLifecycleUnavailableError,
  UnavailableAccountIdentityProvider,
  UnavailableMediaLifecycleProvider,
  type AccountIdentityProvider,
  type MediaLifecycleProvider,
} from "./account-lifecycle.js";
import {
  DeviceCommandUnavailableError,
  UnavailableDeviceCommandFactory,
  type DeviceCommandFactory,
} from "./device-commands.js";
import {
  IntelligenceProviderError,
  IntelligenceUnavailableError,
  UnavailableIntelligenceProvider,
  type IntelligenceProvider,
  type MediaReadUrlProvider,
} from "./intelligence.js";
import {
  MediaVerificationError,
  UnavailableMediaVerificationProvider,
  type MediaVerificationProvider,
  type VerifiedMedia,
} from "./media-verification.js";
import {
  recordDuplicateBlock,
  recordPublishConfirmation,
  recordPublishingJobQueued,
  recordPublishingTransition,
} from "./observability.js";
import type {
  ExceptionTask,
  ItemOutcome,
  JobWithTransitions,
  Repository,
  StoredItem,
} from "./repository.js";
import type {
  ServerConnectorExecutor,
  ServerConnectorResult,
} from "./server-connectors.js";

export interface ApplicationOptions {
  environment?: ConnectorEnvironment;
  apiBaseUrl?: string;
  now?: () => Date;
  createId?: () => string;
  intelligenceProvider?: IntelligenceProvider;
  mediaReadUrlProvider?: MediaReadUrlProvider;
  mediaVerificationProvider?: MediaVerificationProvider;
  deviceCommandFactory?: DeviceCommandFactory;
  accountIdentityProvider?: AccountIdentityProvider;
  mediaLifecycleProvider?: MediaLifecycleProvider;
  accountDeletionHashKey?: string;
}

export interface CaptureResult {
  item: StoredItem;
  duplicateMatches: ReturnType<typeof findLikelyDuplicates>;
}

export interface PublishResult {
  jobs: Array<{ job: PublishingJob; reused: boolean }>;
}

export interface CloseResult {
  item: StoredItem;
  outcome: ItemOutcome;
  jobs: PublishingJob[];
  exceptionTask: ExceptionTask | null;
}

export interface EnrichItemResult {
  enrichment: ItemEnrichment;
  reused: boolean;
}

export interface CompletePairingResult {
  device: SellerDevice;
  deviceToken: string;
}

export class LocalClearApplication {
  readonly #repository: Repository;
  readonly #environment: ConnectorEnvironment;
  readonly #apiBaseUrl: string;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #intelligenceProvider: IntelligenceProvider;
  readonly #mediaReadUrlProvider: MediaReadUrlProvider | null;
  readonly #mediaVerificationProvider: MediaVerificationProvider;
  readonly #deviceCommandFactory: DeviceCommandFactory;
  readonly #accountIdentityProvider: AccountIdentityProvider;
  readonly #mediaLifecycleProvider: MediaLifecycleProvider;
  readonly #accountDeletionHashKey: string;

  constructor(repository: Repository, options: ApplicationOptions = {}) {
    this.#repository = repository;
    this.#environment = options.environment ?? "internal";
    this.#apiBaseUrl = options.apiBaseUrl ?? "http://localhost:4100";
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#intelligenceProvider =
      options.intelligenceProvider ?? new UnavailableIntelligenceProvider();
    this.#mediaReadUrlProvider = options.mediaReadUrlProvider ?? null;
    this.#mediaVerificationProvider =
      options.mediaVerificationProvider ??
      new UnavailableMediaVerificationProvider();
    this.#deviceCommandFactory =
      options.deviceCommandFactory ?? new UnavailableDeviceCommandFactory();
    this.#accountIdentityProvider =
      options.accountIdentityProvider ??
      new UnavailableAccountIdentityProvider();
    this.#mediaLifecycleProvider =
      options.mediaLifecycleProvider ?? new UnavailableMediaLifecycleProvider();
    this.#accountDeletionHashKey =
      options.accountDeletionHashKey ??
      "localclear-development-only-deletion-key";
  }

  async exportAccount(userId: string) {
    if (!userId) throw forbidden();
    return this.#repository.exportAccountData(
      userId,
      this.#now().toISOString(),
    );
  }

  async deleteAccount(userId: string) {
    if (!userId) throw forbidden();
    const requestedAt = this.#now().toISOString();
    const subjectHash = createHmac("sha256", this.#accountDeletionHashKey)
      .update(userId)
      .digest("hex");
    const preparation = await this.#repository.beginAccountDeletion({
      requestId: this.#createId(),
      userId,
      subjectHash,
      requestedAt,
    });
    try {
      if (preparation.mediaPaths.length > 0) {
        await this.#mediaLifecycleProvider.deleteObjects(
          preparation.mediaPaths,
        );
      }
      await this.#repository.purgeAccountData(userId);
      await this.#accountIdentityProvider.deleteUser(userId);
    } catch (error) {
      if (error instanceof AccountLifecycleUnavailableError) {
        throw new ApplicationError(
          503,
          "account_deletion_unavailable",
          "Account deletion is not fully configured",
        );
      }
      throw error;
    }
    const receipt = {
      receiptId: this.#createId(),
      requestId: preparation.requestId,
      subjectHash,
      completedAt: this.#now().toISOString(),
    };
    await this.#repository.completeAccountDeletion(receipt);
    return {
      receipt,
      revokedDeviceCount: preparation.revokedDeviceCount,
      cancelledJobCount: preparation.cancelledJobCount,
      deletedMediaCount: preparation.mediaPaths.length,
      localInstructions:
        "LocalClear cloud data and sign-in were deleted. Clear local data in Seller Hub and log out of marketplace apps directly if desired.",
    };
  }

  async registerPushSubscription(
    userId: string,
    request: RegisterPushSubscriptionRequest,
  ) {
    if (!userId) throw forbidden();
    const now = this.#now().toISOString();
    const subscription = PushSubscriptionSchema.parse({
      id: this.#createId(),
      userId,
      expoPushToken: request.expoPushToken,
      platform: request.platform,
      enabled: request.enabled,
      createdAt: now,
      updatedAt: now,
    });
    return {
      subscription: await this.#repository.upsertPushSubscription(subscription),
    };
  }

  async listNotifications(userId: string, householdId: string) {
    await this.#requireMembership(userId, householdId);
    return {
      notifications: await this.#repository.listNotifications(
        userId,
        householdId,
      ),
    };
  }

  async markNotificationRead(
    userId: string,
    householdId: string,
    notificationId: string,
  ) {
    await this.#requireMembership(userId, householdId);
    const notification = await this.#repository.markNotificationRead(
      userId,
      notificationId,
      this.#now().toISOString(),
    );
    if (!notification || notification.householdId !== householdId) {
      throw notFound("Notification");
    }
    return { notification };
  }

  async createHousehold(
    userId: string,
    request: CreateHouseholdRequest,
  ): Promise<Household> {
    const input = CreateHouseholdRequestSchema.parse(request);
    const now = this.#now().toISOString();
    const household = HouseholdSchema.parse({
      id: this.#createId(),
      ownerId: userId,
      name: input.name,
      goal: input.goal,
      zipCode: input.zipCode,
      sellingRadiusMiles: input.sellingRadiusMiles,
      exchangePreferences: input.exchangePreferences,
      paymentWording: input.paymentWording,
      availability: input.availability,
      preferredMeetupLocations: input.preferredMeetupLocations.map(
        (location) => ({
          id: this.#createId(),
          name: location.name,
          publicDescription: location.publicDescription,
          ...(location.latitude === undefined
            ? {}
            : { latitude: location.latitude }),
          ...(location.longitude === undefined
            ? {}
            : { longitude: location.longitude }),
        }),
      ),
      priceRules: input.priceRules,
      timezone: input.timezone,
      createdAt: now,
      updatedAt: now,
    });
    const saved = await this.#repository.createHousehold(household, userId);
    await this.#audit(
      userId,
      saved.id,
      "household.created",
      "household",
      saved.id,
    );
    return saved;
  }

  async listHouseholds(userId: string): Promise<Household[]> {
    return this.#repository.listHouseholds(userId);
  }

  async getHouseholdProgress(userId: string, householdId: string) {
    await this.#requireMembership(userId, householdId);
    const household = await this.#repository.getHousehold(householdId);
    if (!household) throw notFound("Household");
    return this.#repository.getHouseholdProgressSummary(
      householdId,
      startOfMonthInTimezone(this.#now(), household.timezone),
    );
  }

  async updateHousehold(
    userId: string,
    householdId: string,
    request: UpdateHouseholdRequest,
  ): Promise<Household> {
    await this.#requireMembership(userId, householdId);
    const existing = await this.#repository.getHousehold(householdId);
    if (!existing) throw notFound("Household");
    const input = CreateHouseholdRequestSchema.parse(request);
    const now = this.#now().toISOString();
    const household = HouseholdSchema.parse({
      ...existing,
      ...input,
      preferredMeetupLocations: input.preferredMeetupLocations.map(
        (location) => ({
          id:
            existing.preferredMeetupLocations.find(
              (value) => value.name === location.name,
            )?.id ?? this.#createId(),
          ...location,
        }),
      ),
      updatedAt: now,
    });
    const saved = await this.#repository.saveHousehold(household);
    await this.#audit(
      userId,
      householdId,
      "household.updated",
      "household",
      householdId,
    );
    return saved;
  }

  async getHousehold(userId: string, householdId: string): Promise<Household> {
    await this.#requireMembership(userId, householdId);
    const household = await this.#repository.getHousehold(householdId);
    if (!household) throw notFound("Household");
    return household;
  }

  async beginSellerHubPairing(
    userId: string,
    householdId: string,
  ): Promise<PairingQrPayload> {
    await this.#requireMembership(userId, householdId);
    const challenge = createPairingChallenge({
      challengeId: this.#createId(),
      householdId,
      apiBaseUrl: this.#apiBaseUrl,
      now: this.#now(),
    });
    await this.#repository.createPairingChallenge({
      id: challenge.record.id,
      householdId: challenge.record.householdId,
      secretHash: challenge.record.secretHash,
      expiresAt: challenge.record.expiresAt,
      consumedAt: null,
    });
    await this.#audit(
      userId,
      householdId,
      "seller_device.pairing_started",
      "pairing_challenge",
      challenge.record.id,
    );
    return challenge.qr;
  }

  async completeSellerHubPairing(
    request: CompletePairingRequest,
  ): Promise<CompletePairingResult> {
    const input = CompletePairingRequestSchema.parse(request);
    const challenge = await this.#repository.getPairingChallenge(
      input.response.challengeId,
    );
    if (!challenge || challenge.consumedAt) {
      throw new ApplicationError(
        409,
        "pairing_unavailable",
        "Pairing challenge is invalid or used",
      );
    }
    let pairedDevice;
    try {
      pairedDevice = verifyPairingResponse({
        qrSecret: input.secret,
        record: challenge,
        response: input.response,
        now: this.#now(),
      });
    } catch {
      throw new ApplicationError(
        401,
        "pairing_rejected",
        "Pairing proof is invalid or expired",
      );
    }
    const now = this.#now().toISOString();
    if (!(await this.#repository.consumePairingChallenge(challenge.id, now))) {
      throw new ApplicationError(
        409,
        "pairing_unavailable",
        "Pairing challenge was already used",
      );
    }
    const existingDevices = await this.#repository.listSellerDevices(
      challenge.householdId,
    );
    const device = SellerDeviceSchema.parse({
      id: this.#createId(),
      householdId: challenge.householdId,
      displayName: pairedDevice.displayName,
      publicKey: pairedDevice.publicKey,
      androidVersion: pairedDevice.androidVersion,
      appVersion: pairedDevice.appVersion,
      isPrimary: !existingDevices.some(
        (value) => value.isPrimary && !value.revokedAt,
      ),
      connectionStatus: "offline",
      batteryPercent: null,
      isCharging: null,
      networkType: "unknown",
      lastCheckInAt: null,
      capabilities: ["signed_commands"],
      revokedAt: null,
    });
    const saved = await this.#repository.createSellerDevice(device);
    const deviceSecret = randomBytes(32).toString("base64url");
    await this.#repository.createSellerDeviceCredential(
      saved.id,
      createHash("sha256").update(deviceSecret).digest("hex"),
      now,
    );
    await this.#audit(
      saved.id,
      saved.householdId,
      "seller_device.paired",
      "seller_device",
      saved.id,
      { androidVersion: saved.androidVersion, appVersion: saved.appVersion },
      "device",
    );
    return { device: saved, deviceToken: `${saved.id}.${deviceSecret}` };
  }

  async listSellerDevices(
    userId: string,
    householdId: string,
  ): Promise<SellerDevice[]> {
    await this.#requireMembership(userId, householdId);
    return this.#repository.listSellerDevices(householdId);
  }

  async listPlatformConnections(
    userId: string,
    householdId: string,
  ): Promise<PlatformConnection[]> {
    await this.#requireMembership(userId, householdId);
    return this.#repository.listPlatformConnections(householdId);
  }

  async unpairSellerDevice(
    userId: string,
    householdId: string,
    deviceId: string,
  ): Promise<SellerDevice> {
    await this.#requireMembership(userId, householdId);
    const device = await this.#repository.getSellerDevice(
      householdId,
      deviceId,
    );
    if (!device) throw notFound("Seller device");
    const revoked = SellerDeviceSchema.parse({
      ...device,
      isPrimary: false,
      connectionStatus: "revoked",
      revokedAt: this.#now().toISOString(),
    });
    const saved = await this.#repository.saveSellerDevice(revoked);
    await this.#repository.revokeSellerDeviceCredential(
      deviceId,
      revoked.revokedAt!,
    );
    for (const connection of await this.#repository.listPlatformConnections(
      householdId,
    )) {
      if (connection.sellerDeviceId !== deviceId) continue;
      await this.#repository.upsertPlatformConnection(
        {
          ...connection,
          connectionStatus: "disabled",
          lastVerifiedAt: revoked.revokedAt,
        },
        householdId,
      );
    }
    let cancelledJobCount = 0;
    for (;;) {
      const pendingJobs = await this.#repository.listPendingDeviceJobs(
        deviceId,
        100,
      );
      if (pendingJobs.length === 0) break;
      for (const job of pendingJobs) {
        await this.transitionPublishingJob(userId, householdId, job.id, {
          event: { type: "cancel", reasonCode: "DEVICE_UNPAIRED" },
        });
        cancelledJobCount += 1;
      }
    }
    await this.#audit(
      userId,
      householdId,
      "seller_device.unpaired",
      "seller_device",
      deviceId,
      { cancelledJobCount },
    );
    return saved;
  }

  async checkInSellerDevice(
    device: SellerDevice,
    request: DeviceCheckInRequest,
  ): Promise<SellerDevice> {
    const now = this.#now().toISOString();
    const updated = SellerDeviceSchema.parse({
      ...device,
      appVersion: request.appVersion,
      androidVersion: request.androidVersion,
      batteryPercent: request.batteryPercent,
      isCharging: request.isCharging,
      networkType: request.networkType,
      capabilities: request.capabilities,
      connectionStatus:
        request.networkType === "offline" ? "offline" : "online",
      lastCheckInAt: now,
    });
    const saved = await this.#repository.saveSellerDevice(updated);
    const existingConnections = await this.#repository.listPlatformConnections(
      device.householdId,
    );
    for (const reported of request.platformConnections) {
      const connector = await this.#repository.getConnector(reported.platform);
      if (!connector || connector.kind !== "android") {
        throw new ApplicationError(
          409,
          "platform_connection_unrecognized",
          "Seller Hub reported an unreviewed platform connector",
        );
      }
      const supportedCapabilities = reported.supportedCapabilities.filter(
        (capability) => connector.capabilities[capability],
      );
      const connectionStatus = !connector.enabled
        ? "disabled"
        : connector.supportedAppVersions.length > 0 &&
            !connector.supportedAppVersions.includes(reported.appVersion)
          ? "unsupported_version"
          : reported.connectionStatus;
      const existing = existingConnections.find(
        (value) =>
          value.platform.toLowerCase() === reported.platform.toLowerCase(),
      );
      await this.#repository.upsertPlatformConnection(
        PlatformConnectionSchema.parse({
          id: existing?.id ?? this.#createId(),
          sellerDeviceId: device.id,
          platform: connector.platform,
          appVersion: reported.appVersion,
          displayAlias: reported.displayAlias,
          connectionStatus,
          lastVerifiedAt: now,
          supportedCapabilities,
          policyStatus: connector.policyStatus,
        }),
        device.householdId,
      );
    }
    await this.#audit(
      device.id,
      device.householdId,
      "seller_device.checked_in",
      "seller_device",
      device.id,
      {
        appVersion: saved.appVersion,
        networkType: saved.networkType,
        batteryPercent: saved.batteryPercent,
        platformAppVersions: request.platformConnections.map((connection) => ({
          platform: connection.platform,
          appVersion: connection.appVersion,
        })),
        platformConnectionCount: request.platformConnections.length,
      },
      "device",
    );
    return saved;
  }

  async listSellerDeviceCommands(device: SellerDevice): Promise<{
    commands: SignedDeviceCommand[];
    errors: Array<{ jobId: string; code: string }>;
  }> {
    const jobs = await this.#repository.listPendingDeviceJobs(device.id, 20);
    const connections = await this.#repository.listPlatformConnections(
      device.householdId,
    );
    if (!(await this.#isFeatureEnabled("publishing_enabled"))) {
      return {
        commands: [],
        errors: jobs.map((job) => ({
          jobId: job.id,
          code: "PUBLISHING_KILL_SWITCH_ACTIVE",
        })),
      };
    }
    const commands: SignedDeviceCommand[] = [];
    const errors: Array<{ jobId: string; code: string }> = [];
    for (const job of jobs) {
      const existing = await this.#repository.getActiveIssuedDeviceCommand(
        device.id,
        job.id,
        this.#now().toISOString(),
      );
      if (existing) {
        commands.push(existing.signedCommand);
        continue;
      }
      try {
        const [item, household, listing, variant, platformListings, connector] =
          await Promise.all([
            this.#repository.getItem(device.householdId, job.itemId),
            this.#repository.getHousehold(device.householdId),
            this.#repository.getListing(job.itemId, job.listingVersion),
            this.#repository.getPlatformListingVariant(
              job.itemId,
              job.listingVersion,
              job.platform,
            ),
            this.#repository.listPlatformListings(job.itemId),
            this.#repository.getConnector(job.platform),
          ]);
        if (!item || !household || !listing || !variant || !connector) {
          errors.push({ jobId: job.id, code: "COMMAND_CONTEXT_MISSING" });
          continue;
        }
        const capability =
          job.commandAction === "update_fields"
            ? "edit"
            : job.commandAction === "check_connection" ||
                job.commandAction === "pause" ||
                job.commandAction === "resume"
              ? "publish"
              : job.commandAction;
        const connection = connections.find(
          (value) =>
            value.sellerDeviceId === device.id &&
            value.platform.toLowerCase() === job.platform.toLowerCase(),
        );
        if (
          !connection ||
          !["connected", "needs_login"].includes(connection.connectionStatus) ||
          connection.appVersion !== job.platformAppVersion
        ) {
          errors.push({ jobId: job.id, code: "APP_VERSION_UNSUPPORTED" });
          continue;
        }
        const gate = evaluateConnectorGate({
          manifest: connector,
          capability,
          environment: this.#environment,
          appVersion: connection.appVersion,
        });
        if (!gate.allowed || connector.kind !== "android") {
          errors.push({ jobId: job.id, code: "CONNECTOR_BLOCKED" });
          continue;
        }
        const command = await this.#deviceCommandFactory.create({
          job,
          item,
          household,
          listing,
          variant,
          platformListing:
            platformListings.find(
              (value) =>
                value.platform.toLowerCase() === job.platform.toLowerCase(),
            ) ?? null,
        });
        await this.#repository.createIssuedDeviceCommand({
          deviceId: device.id,
          jobId: job.id,
          commandNonce: command.payload.nonce,
          expiresAt: command.payload.expiresAt,
          signedCommand: command,
        });
        commands.push(command);
      } catch (error) {
        if (error instanceof DeviceCommandUnavailableError) {
          throw new ApplicationError(
            503,
            "device_commands_unavailable",
            "Seller Hub command signing is not configured",
          );
        }
        errors.push({ jobId: job.id, code: "COMMAND_BUILD_FAILED" });
      }
    }
    return { commands, errors };
  }

  async captureItem(
    userId: string,
    householdId: string,
    request: CapturedItemInput,
  ): Promise<CaptureResult> {
    await this.#requireMembership(userId, householdId);
    const item = await this.#buildCapturedItem(
      householdId,
      CapturedItemInputSchema.parse(request),
    );
    const existing = await this.#repository.listItems(householdId);
    const duplicateMatches = this.#duplicatesFor(item, existing);
    const saved = await this.#repository.createItem(item);
    await this.#audit(userId, householdId, "item.captured", "item", saved.id, {
      photoCount: saved.media.length,
      duplicateCount: duplicateMatches.length,
    });
    return { item: saved, duplicateMatches };
  }

  async captureBatch(
    userId: string,
    householdId: string,
    requests: readonly CapturedItemInput[],
  ): Promise<CaptureResult[]> {
    await this.#requireMembership(userId, householdId);
    if (requests.length < 1 || requests.length > 100) {
      throw new ApplicationError(
        400,
        "invalid_batch_size",
        "A batch must contain 1–100 items",
      );
    }
    const existing = await this.#repository.listItems(householdId);
    const built: StoredItem[] = [];
    const results: CaptureResult[] = [];
    for (const request of requests) {
      const item = await this.#buildCapturedItem(
        householdId,
        CapturedItemInputSchema.parse(request),
      );
      results.push({
        item,
        duplicateMatches: this.#duplicatesFor(item, [...existing, ...built]),
      });
      built.push(item);
    }
    const saved = await this.#repository.createItems(built);
    await this.#audit(
      userId,
      householdId,
      "capture.batch_created",
      "household",
      householdId,
      {
        itemCount: saved.length,
        photoCount: saved.reduce((total, item) => total + item.media.length, 0),
      },
    );
    return results.map((result, index) => ({
      item: saved[index] ?? result.item,
      duplicateMatches: result.duplicateMatches,
    }));
  }

  async listItems(userId: string, householdId: string): Promise<StoredItem[]> {
    await this.#requireMembership(userId, householdId);
    return this.#repository.listItems(householdId);
  }

  async listPublishCandidates(userId: string, householdId: string) {
    await this.#requireMembership(userId, householdId);
    const items = await this.#repository.listItems(householdId);
    const candidates = await Promise.all(
      items.map(async (item) => ({
        item,
        listing: await this.#repository.getLatestListing(item.id),
      })),
    );
    return candidates.filter(
      (value) =>
        value.listing?.approvedAt &&
        value.listing.restrictedItemStatus === "clear" &&
        ![
          "sold",
          "given_away",
          "donated",
          "recycled",
          "discarded",
          "archived",
        ].includes(value.item.status),
    );
  }

  async getItem(
    userId: string,
    householdId: string,
    itemId: string,
  ): Promise<StoredItem> {
    await this.#requireMembership(userId, householdId);
    const item = await this.#repository.getItem(householdId, itemId);
    if (!item) throw notFound("Item");
    return item;
  }

  async getItemDetails(userId: string, householdId: string, itemId: string) {
    await this.#requireMembership(userId, householdId);
    const item = await this.#repository.getItem(householdId, itemId);
    if (!item) throw notFound("Item");
    const [latestListing, platformListings, enrichment] = await Promise.all([
      this.#repository.getLatestListing(itemId),
      this.#repository.listPlatformListings(itemId),
      this.#repository.getLatestItemEnrichment(
        householdId,
        itemId,
        itemMediaFingerprint(item),
      ),
    ]);
    return { item, latestListing, platformListings, enrichment };
  }

  async recommendPrices(
    userId: string,
    householdId: string,
    itemId: string,
    request: PriceRecommendationRequest,
  ) {
    await this.#requireMembership(userId, householdId);
    const input = PriceRecommendationRequestSchema.parse(request);
    const item = await this.#repository.getItem(householdId, itemId);
    if (!item) throw notFound("Item");
    const comparables = await this.#repository.listOutcomeComparables({
      category: item.category,
      brand: item.brand,
      model: item.model,
      limit: 50,
    });
    if (comparables.length === 0) {
      throw new ApplicationError(
        409,
        "pricing_data_insufficient",
        "No approved comparable outcomes are available yet. Set a manual price instead of using an unverified estimate.",
      );
    }
    const recommendations = generatePriceRecommendations({
      comparables,
      factors: input.factors,
    });
    const balanced = recommendations.find(
      (value) => value.strategy === "balanced",
    );
    if (!balanced)
      throw new Error("Balanced pricing recommendation is missing");
    const clearingAdvice = recommendClearingLane({
      title: item.title,
      category: item.category,
      condition: item.condition,
      expectedSaleValueCents: balanced.price.amountCents,
      estimatedEffortMinutes: input.estimatedEffortMinutes,
      minimumWorthwhileHourlyCents: input.minimumWorthwhileHourlyCents,
      restrictedOrUnsafe: false,
    });
    await this.#audit(
      userId,
      householdId,
      "pricing.recommended",
      "item",
      itemId,
      {
        comparableCount: comparables.length,
        soldComparableCount: comparables.filter(
          (value) => value.outcomeType === "verified_sold",
        ).length,
        sources: [...new Set(comparables.map((value) => value.sourceName))],
      },
    );
    return { recommendations, clearingAdvice };
  }

  async enrichItem(
    userId: string,
    householdId: string,
    itemId: string,
  ): Promise<EnrichItemResult> {
    await this.#requireMembership(userId, householdId);
    await this.#requireFeature("ai_enrichment_enabled");
    const item = await this.#repository.getItem(householdId, itemId);
    if (!item) throw notFound("Item");
    if (!this.#mediaReadUrlProvider) {
      throw new ApplicationError(
        503,
        "intelligence_unavailable",
        "Photo analysis is not configured",
      );
    }
    if (item.media.some((media) => !media.exifLocationStripped)) {
      throw new ApplicationError(
        409,
        "media_not_sanitized",
        "Remove photo location metadata before analysis",
      );
    }

    const inputFingerprint = enrichmentInputFingerprint(item);
    const mediaFingerprint = itemMediaFingerprint(item);
    const cached = await this.#repository.getItemEnrichmentByFingerprint(
      householdId,
      itemId,
      inputFingerprint,
      this.#intelligenceProvider.providerName,
      this.#intelligenceProvider.model,
    );
    if (cached) {
      await this.#applyMediaAssessments(item, cached.output);
      return { enrichment: cached, reused: true };
    }

    try {
      const media = await Promise.all(
        item.media.map(async (asset) => ({
          mediaAssetId: asset.id,
          readUrl: await this.#mediaReadUrlProvider!.createReadUrl(
            asset.storagePath,
            5 * 60,
          ),
        })),
      );
      const output = await this.#intelligenceProvider.enrich({
        item: {
          title: item.title,
          category: item.category,
          brand: item.brand,
          model: item.model,
          condition: item.condition,
          accessories: item.accessories,
          defects: item.defects,
          barcode: item.barcode,
        },
        media,
      });
      assertEnrichmentEvidenceBelongsToItem(
        output,
        new Set(item.media.map((asset) => asset.id)),
      );
      await this.#applyMediaAssessments(item, output);
      const enrichment = ItemEnrichmentSchema.parse({
        id: this.#createId(),
        householdId,
        itemId,
        inputFingerprint,
        mediaFingerprint,
        provider: this.#intelligenceProvider.providerName,
        model: this.#intelligenceProvider.model,
        output,
        createdAt: this.#now().toISOString(),
      });
      const saved = await this.#repository.createItemEnrichment(enrichment);
      await this.#audit(
        userId,
        householdId,
        "item.enriched",
        "item_enrichment",
        saved.id,
        {
          provider: saved.provider,
          model: saved.model,
          unresolvedQuestionCount: saved.output.unresolvedQuestions.length,
          qualityIssueCount: saved.output.mediaAssessments.reduce(
            (count, assessment) => count + assessment.qualityIssues.length,
            0,
          ),
          redactionSuggestionCount: saved.output.mediaAssessments.filter(
            (assessment) => assessment.redactionSuggested,
          ).length,
        },
      );
      return { enrichment: saved, reused: false };
    } catch (error) {
      if (error instanceof IntelligenceUnavailableError) {
        throw new ApplicationError(
          503,
          "intelligence_unavailable",
          "Photo analysis is not configured",
        );
      }
      if (
        error instanceof IntelligenceProviderError ||
        error instanceof Error
      ) {
        throw new ApplicationError(
          502,
          "intelligence_failed",
          "Photo analysis could not be completed. Try again.",
        );
      }
      throw error;
    }
  }

  async getLatestItemEnrichment(
    userId: string,
    householdId: string,
    itemId: string,
  ): Promise<ItemEnrichment> {
    await this.#requireMembership(userId, householdId);
    const item = await this.#repository.getItem(householdId, itemId);
    if (!item) throw notFound("Item");
    const enrichment = await this.#repository.getLatestItemEnrichment(
      householdId,
      itemId,
      itemMediaFingerprint(item),
    );
    if (!enrichment) throw notFound("Item enrichment");
    return enrichment;
  }

  async getBundleSuggestions(
    userId: string,
    householdId: string,
    itemId: string,
  ): Promise<BundleSuggestion[]> {
    await this.#requireMembership(userId, householdId);
    const items = await this.#repository.listItems(householdId);
    if (!items.some((item) => item.id === itemId)) throw notFound("Item");
    return suggestRelatedItemBundles({ targetItemId: itemId, items });
  }

  async replaceMediaAsset(
    userId: string,
    householdId: string,
    itemId: string,
    mediaAssetId: string,
    request: ReplaceMediaAssetRequest,
  ): Promise<StoredItem> {
    await this.#requireMembership(userId, householdId);
    const item = await this.#repository.getItem(householdId, itemId);
    if (!item) throw notFound("Item");
    const existing = item.media.find((asset) => asset.id === mediaAssetId);
    if (!existing) throw notFound("Media asset");
    if (
      !request.replacement.storagePath.startsWith(`${householdId}/`) ||
      request.replacement.storagePath.includes("..") ||
      request.replacement.storagePath.includes("\\")
    ) {
      throw new ApplicationError(
        400,
        "media_path_invalid",
        "Replacement media must use this household's private storage prefix",
      );
    }
    if (
      request.replacement.storagePath === existing.storagePath ||
      request.replacement.contentSha256 === existing.contentSha256
    ) {
      throw new ApplicationError(
        409,
        "media_replacement_unchanged",
        "The replacement must be a newly edited image",
      );
    }
    let verifiedReplacement: VerifiedMedia;
    try {
      verifiedReplacement = await this.#mediaVerificationProvider.verify({
        storagePath: request.replacement.storagePath,
        expectedSha256: request.replacement.contentSha256,
        declaredMediaType: request.replacement.mediaType,
      });
    } catch (error) {
      if (error instanceof MediaVerificationError) {
        const statusCode =
          error.code === "media_unavailable"
            ? 503
            : error.code === "media_too_large"
              ? 413
              : 422;
        throw new ApplicationError(statusCode, error.code, error.message);
      }
      throw new ApplicationError(
        502,
        "media_verification_failed",
        "Replacement media could not be verified",
      );
    }
    try {
      await this.#mediaLifecycleProvider.deleteObjects([existing.storagePath]);
    } catch (error) {
      if (error instanceof AccountLifecycleUnavailableError) {
        throw new ApplicationError(
          503,
          "media_replacement_unavailable",
          "Private media replacement is not configured",
        );
      }
      throw error;
    }
    const now = this.#now().toISOString();
    const updated = await this.#repository.saveItem({
      ...item,
      media: item.media.map((asset) =>
        asset.id === mediaAssetId
          ? {
              ...asset,
              storagePath: request.replacement.storagePath,
              id: this.#createId(),
              contentSha256: verifiedReplacement.contentSha256,
              mediaType: verifiedReplacement.mediaType,
              qualityIssues: request.replacement.qualityIssues,
              redactionState: "pending_scan",
              source: request.replacement.source,
              exifLocationStripped: verifiedReplacement.exifLocationStripped,
              createdAt: now,
            }
          : asset,
      ),
      updatedAt: now,
    });
    await this.#audit(
      userId,
      householdId,
      "media.redaction_applied",
      "media_asset",
      mediaAssetId,
      {
        oldObjectDeleted: true,
        replacementHashChanged: true,
        serverVerified: true,
        privacyRescanRequired: true,
        storagePathsInAudit: false,
      },
    );
    return updated;
  }

  async reviewMediaPrivacy(
    userId: string,
    householdId: string,
    itemId: string,
    mediaAssetId: string,
    _request: ReviewMediaPrivacyRequest,
  ): Promise<StoredItem> {
    await this.#requireMembership(userId, householdId);
    const item = await this.#repository.getItem(householdId, itemId);
    if (!item) throw notFound("Item");
    const existing = item.media.find((asset) => asset.id === mediaAssetId);
    if (!existing) throw notFound("Media asset");
    if (existing.redactionState !== "suggested") {
      throw new ApplicationError(
        409,
        "media_review_not_required",
        "This photo does not have a pending privacy suggestion",
      );
    }
    const updated = await this.#repository.saveItem({
      ...item,
      media: item.media.map((asset) =>
        asset.id === mediaAssetId
          ? { ...asset, redactionState: "reviewed_not_needed" }
          : asset,
      ),
      updatedAt: this.#now().toISOString(),
    });
    await this.#audit(
      userId,
      householdId,
      "media.redaction_false_positive_confirmed",
      "media_asset",
      mediaAssetId,
      { userReviewed: true },
    );
    return updated;
  }

  async createListing(
    userId: string,
    householdId: string,
    itemId: string,
    request: CreateListingRequest,
  ) {
    await this.#requireMembership(userId, householdId);
    const item = await this.#repository.getItem(householdId, itemId);
    if (!item) throw notFound("Item");
    const input = CreateListingRequestSchema.parse(request);
    const mediaFingerprint = itemMediaFingerprint(item);
    const enrichment = await this.#repository.getLatestItemEnrichment(
      householdId,
      itemId,
      mediaFingerprint,
    );
    if (!enrichment || enrichment.mediaFingerprint !== mediaFingerprint) {
      throw new ApplicationError(
        409,
        "item_screening_required",
        "Run photo analysis on the current media before creating a listing",
      );
    }
    const restrictedScreen = screenRestrictedListing(enrichment, [
      item.title,
      item.category,
      item.brand,
      item.model,
      ...item.accessories,
      ...item.defects,
      input.title,
      input.description,
      input.conditionSummary,
      JSON.stringify(input.specifications),
      input.itemReview?.category,
      input.itemReview?.brand,
      input.itemReview?.model,
      ...(input.itemReview?.accessories ?? []),
      ...(input.itemReview?.defects ?? []),
    ]);
    const previous = await this.#repository.getLatestListing(itemId);
    const now = this.#now().toISOString();
    const listing = CanonicalListingSchema.parse({
      id: this.#createId(),
      itemId,
      version: (previous?.version ?? 0) + 1,
      title: input.title,
      description: input.description,
      conditionSummary: input.conditionSummary,
      specifications: input.specifications,
      priceStrategy: input.priceStrategy,
      askingPrice: input.askingPrice,
      minimumPrice: input.minimumPrice,
      location: input.location,
      exchangeOptions: input.exchangeOptions,
      paymentWording: input.paymentWording,
      negotiationRules: input.negotiationRules,
      restrictedItemStatus: restrictedScreen.status,
      restrictedItemReasons: restrictedScreen.reasons,
      approvedAt: input.approve ? now : null,
      createdAt: now,
    });
    const saved = await this.#repository.createListing(listing, householdId);
    if (input.itemReview) {
      const reviewed = ItemSchema.parse({
        id: item.id,
        householdId: item.householdId,
        title: input.title,
        category: input.itemReview.category,
        brand: input.itemReview.brand,
        model: input.itemReview.model,
        condition: input.itemReview.condition,
        dimensions: input.itemReview.dimensions,
        specifications: input.itemReview.specifications,
        accessories: input.itemReview.accessories,
        defects: input.itemReview.defects,
        storageLocation: item.storageLocation,
        identification: input.itemReview.identification,
        clearingRecommendation: input.itemReview.clearingRecommendation,
        status: item.status,
        media: item.media,
        createdAt: item.createdAt,
        updatedAt: now,
      });
      await this.#repository.saveItem({
        ...reviewed,
        barcode: item.barcode,
        imageFingerprint: item.imageFingerprint,
      });
    }
    if (item.status === "captured") {
      transitionItemStatus(item.status, "draft");
      await this.#repository.updateItemStatus(
        householdId,
        itemId,
        "draft",
        now,
      );
    }
    if (
      input.approve &&
      (item.status === "captured" || item.status === "draft")
    ) {
      await this.#repository.updateItemStatus(
        householdId,
        itemId,
        "ready",
        now,
      );
    }
    await this.#audit(
      userId,
      householdId,
      "listing.version_created",
      "listing",
      saved.id,
      {
        version: saved.version,
        approved: input.approve,
        itemReviewed: Boolean(input.itemReview),
        restrictedItemStatus: saved.restrictedItemStatus,
      },
    );
    return saved;
  }

  async publish(
    userId: string,
    householdId: string,
    itemId: string,
    request: PublishRequest,
  ): Promise<PublishResult> {
    await this.#requireMembership(userId, householdId);
    await this.#requireFeature("publishing_enabled");
    const input = PublishRequestSchema.parse(request);
    const item = await this.#repository.getItem(householdId, itemId);
    if (!item) throw notFound("Item");
    const household = await this.#repository.getHousehold(householdId);
    if (!household) throw notFound("Household");
    const listing = await this.#repository.getListing(
      itemId,
      input.listingVersion,
    );
    if (!listing) throw notFound("Listing version");
    const mediaFingerprint = itemMediaFingerprint(item);
    const enrichment = await this.#repository.getLatestItemEnrichment(
      householdId,
      itemId,
      mediaFingerprint,
    );
    if (!enrichment || enrichment.mediaFingerprint !== mediaFingerprint) {
      throw new ApplicationError(
        409,
        "item_screening_required",
        "Run photo analysis on the current media before publishing",
      );
    }
    const currentRestrictedScreen = screenRestrictedListing(enrichment, [
      item.title,
      item.category,
      item.brand,
      item.model,
      ...item.accessories,
      ...item.defects,
      listing.title,
      listing.description,
      listing.conditionSummary,
      JSON.stringify(listing.specifications),
    ]);
    if (!listing.approvedAt) {
      throw new ApplicationError(
        409,
        "listing_not_approved",
        "Approve the listing before publishing",
      );
    }
    if (
      listing.restrictedItemStatus !== "clear" ||
      currentRestrictedScreen.status !== "clear"
    ) {
      throw new ApplicationError(
        409,
        "item_blocked",
        "Restricted-item screening must be clear before publishing",
        {
          reasons: [
            ...new Set([
              ...listing.restrictedItemReasons,
              ...currentRestrictedScreen.reasons,
            ]),
          ],
        },
      );
    }
    if (item.media.some((asset) => !asset.exifLocationStripped)) {
      throw new ApplicationError(
        409,
        "media_not_sanitized",
        "Remove photo location metadata before publishing",
      );
    }
    const pendingPrivacyReview = item.media.filter((asset) =>
      ["pending_scan", "suggested", "approved"].includes(asset.redactionState),
    );
    if (pendingPrivacyReview.length > 0) {
      throw new ApplicationError(
        409,
        "media_privacy_review_required",
        "Review or redact every flagged photo before publishing",
        { mediaAssetIds: pendingPrivacyReview.map((asset) => asset.id) },
      );
    }
    try {
      assertSpecificationsPublishable(listing.specifications);
    } catch (error) {
      throw new ApplicationError(
        409,
        "unverified_specifications",
        error instanceof Error
          ? error.message
          : "Listing specifications are not verified",
      );
    }

    const duplicateMatches = this.#duplicatesFor(
      item,
      await this.#repository.listItems(householdId),
    );
    if (duplicateMatches.length > 0 && !input.duplicateOverride) {
      await this.#audit(
        userId,
        householdId,
        "publishing.duplicate_blocked",
        "item",
        itemId,
        { matchCount: duplicateMatches.length },
      );
      recordDuplicateBlock(duplicateMatches.length);
      throw new ApplicationError(
        409,
        "possible_duplicate",
        "Review likely duplicate items before publishing",
        { matches: duplicateMatches },
      );
    }

    const platforms = [
      ...new Set(input.platforms.map((platform) => platform.trim())),
    ];
    const platformConnections =
      await this.#repository.listPlatformConnections(householdId);
    const validated: Array<{
      manifest: ConnectorManifest;
      device: SellerDevice | null;
      platformAppVersion: string | null;
    }> = [];
    for (const platform of platforms) {
      const manifest = await this.#repository.getConnector(platform);
      if (!manifest) {
        throw new ApplicationError(
          409,
          "connector_unavailable",
          `${platform} has no connector`,
        );
      }
      let device: SellerDevice | null = null;
      let platformAppVersion: string | null = null;
      if (manifest.kind === "android") {
        if (!input.sellerDeviceId) {
          throw new ApplicationError(
            409,
            "seller_hub_required",
            `${platform} requires a paired Seller Hub`,
          );
        }
        device = await this.#repository.getSellerDevice(
          householdId,
          input.sellerDeviceId,
        );
        if (
          !device ||
          device.revokedAt ||
          device.connectionStatus === "revoked"
        ) {
          throw new ApplicationError(
            409,
            "seller_hub_unavailable",
            "Seller Hub is not paired",
          );
        }
        const pairedDeviceId = device.id;
        const connection = platformConnections.find(
          (value) =>
            value.sellerDeviceId === pairedDeviceId &&
            value.platform.toLowerCase() === manifest.platform.toLowerCase(),
        );
        if (
          !connection ||
          !["connected", "needs_login"].includes(connection.connectionStatus)
        ) {
          throw new ApplicationError(
            409,
            "platform_connection_unavailable",
            `${platform} is not connected on this Seller Hub`,
          );
        }
        platformAppVersion = connection.appVersion;
      }
      const gate = evaluateConnectorGate({
        manifest,
        capability: "publish",
        environment: this.#environment,
        ...(platformAppVersion ? { appVersion: platformAppVersion } : {}),
      });
      if (!gate.allowed) {
        throw new ApplicationError(
          409,
          "connector_blocked",
          `${platform} is not available`,
          {
            blockers: gate.blockers,
          },
        );
      }
      validated.push({ manifest, device, platformAppVersion });
    }

    const jobs: Array<{ job: PublishingJob; reused: boolean }> = [];
    for (const { manifest, device, platformAppVersion } of validated) {
      try {
        await this.#repository.upsertPlatformListingVariant(
          createPlatformListingVariant({
            id: this.#createId(),
            item,
            listing,
            household,
            connector: manifest,
            generatedAt: this.#now().toISOString(),
          }),
        );
      } catch (error) {
        if (error instanceof MissingConnectorFieldsError) {
          throw new ApplicationError(
            409,
            "connector_required_fields_missing",
            `${manifest.platform} needs more listing information`,
            { fields: error.fields },
          );
        }
        throw error;
      }
      const queued = await this.#queueJob({
        householdId,
        itemId,
        platform: manifest.platform,
        listingVersion: listing.version,
        commandAction: "publish",
        manifest,
        deviceId: device?.id ?? null,
        platformAppVersion,
      });
      jobs.push({ job: queued.job, reused: !queued.created });
    }
    if (!["publishing", "partially_live", "live"].includes(item.status)) {
      transitionItemStatus(item.status, "publishing");
      await this.#repository.updateItemStatus(
        householdId,
        itemId,
        "publishing",
        this.#now().toISOString(),
      );
    }
    await this.#audit(
      userId,
      householdId,
      "publishing.requested",
      "item",
      itemId,
      {
        platforms,
        listingVersion: listing.version,
        duplicateOverride: input.duplicateOverride,
      },
    );
    return { jobs };
  }

  async publishBatch(
    userId: string,
    householdId: string,
    request: BatchPublishRequest,
  ) {
    const input = BatchPublishRequestSchema.parse(request);
    await this.#requireMembership(userId, householdId);
    await this.#requireFeature("publishing_enabled");
    const results: Array<{ itemId: string; jobs: PublishResult["jobs"] }> = [];
    for (const item of input.items) {
      const result = await this.publish(userId, householdId, item.itemId, {
        platforms: item.platforms,
        listingVersion: item.listingVersion,
        sellerDeviceId: item.sellerDeviceId,
        duplicateOverride: item.duplicateOverride,
      });
      results.push({ itemId: item.itemId, jobs: result.jobs });
    }
    await this.#audit(
      userId,
      householdId,
      "publishing.batch_requested",
      "household",
      householdId,
      {
        itemCount: results.length,
        jobCount: results.reduce((sum, result) => sum + result.jobs.length, 0),
      },
    );
    return { results };
  }

  async getPublishingJob(
    userId: string,
    householdId: string,
    jobId: string,
  ): Promise<JobWithTransitions> {
    await this.#requireMembership(userId, householdId);
    const result = await this.#repository.getPublishingJob(householdId, jobId);
    if (!result) throw notFound("Publishing job");
    return result;
  }

  async getListingExport(userId: string, householdId: string, jobId: string) {
    await this.#requireMembership(userId, householdId);
    const artifact = await this.#repository.getListingExportArtifact(
      householdId,
      jobId,
    );
    if (!artifact) throw notFound("Listing export");
    if (artifact.expiresAt <= this.#now().toISOString()) {
      throw new ApplicationError(
        410,
        "listing_export_expired",
        "This listing export expired; retry the publishing job to create a new one",
      );
    }
    return { artifact };
  }

  async completeListingImport(
    userId: string,
    householdId: string,
    jobId: string,
    request: CompleteImportRequest,
  ) {
    await this.#requireMembership(userId, householdId);
    let current = await this.#repository.getPublishingJob(householdId, jobId);
    if (!current) throw notFound("Publishing job");
    const [connector, artifact] = await Promise.all([
      this.#repository.getConnector(current.job.platform),
      this.#repository.getListingExportArtifact(householdId, jobId),
    ]);
    if (!connector || !["browser", "import"].includes(connector.kind)) {
      throw new ApplicationError(
        409,
        "import_confirmation_not_allowed",
        "This job is not a browser or import publishing flow",
      );
    }
    if (
      current.job.currentState !== "NEEDS_USER_CONFIRMATION" ||
      current.job.errorCode !== "IMPORT_PACKAGE_READY"
    ) {
      throw new ApplicationError(
        409,
        "import_confirmation_not_ready",
        "This listing is not waiting for import confirmation",
      );
    }
    if (!artifact || artifact.expiresAt <= this.#now().toISOString()) {
      throw new ApplicationError(
        410,
        "listing_export_expired",
        "This listing export is missing or expired",
      );
    }
    if (
      !(await this.#repository.consumeListingExportArtifact(
        householdId,
        jobId,
        this.#now().toISOString(),
      ))
    ) {
      throw new ApplicationError(
        409,
        "listing_export_already_used",
        "This listing export was already confirmed",
      );
    }
    current = await this.#transitionPublishingJobAsService(current, {
      type: "resume",
    });
    const result = {
      externalListingId: request.externalListingId,
      externalUrl: request.externalUrl,
      ...(request.platformTitle === undefined
        ? {}
        : { platformTitle: request.platformTitle }),
      ...(request.platformPrice === undefined
        ? {}
        : { platformPrice: request.platformPrice }),
    };
    for (let count = 0; count < 3; count += 1) {
      current = await this.#transitionPublishingJobAsService(
        current,
        { type: "advance" },
        count === 2 ? result : undefined,
      );
    }
    await this.#audit(
      userId,
      householdId,
      "publishing.import_confirmed",
      "publishing_job",
      jobId,
      { confirmationMethod: "explicit_user_live_listing_confirmation" },
    );
    recordPublishConfirmation({
      platform: current.job.platform,
      connectorVersion: current.job.connectorVersion,
      method: "explicit_import_confirmation",
    });
    return current;
  }

  async processServerPublishingJob(
    claimedJob: PublishingJob,
    executor: ServerConnectorExecutor,
  ): Promise<JobWithTransitions> {
    let current = await this.#repository.getPublishingJob(
      claimedJob.householdId,
      claimedJob.id,
    );
    if (!current) throw notFound("Publishing job");
    if (current.job.deviceId) {
      throw new ApplicationError(
        409,
        "server_job_scope_invalid",
        "A Seller Hub job cannot run in the server dispatcher",
      );
    }
    if (current.job.currentState === "FAILED_RETRYABLE") {
      if (
        !current.job.nextRetryAt ||
        current.job.nextRetryAt > this.#now().toISOString()
      ) {
        return current;
      }
      current = await this.#transitionPublishingJobAsService(current, {
        type: "retry",
      });
    }
    if (current.job.currentState !== "QUEUED") return current;
    if (!(await this.#isFeatureEnabled("publishing_enabled"))) {
      return this.#transitionPublishingJobAsService(current, {
        type: "pause",
        state: "ITEM_BLOCKED",
        reasonCode: "PUBLISHING_KILL_SWITCH_ACTIVE",
        detail:
          "Publishing is temporarily disabled by an audited feature flag.",
      });
    }

    const [item, household, listing, variant, platformListings, connector] =
      await Promise.all([
        this.#repository.getItem(current.job.householdId, current.job.itemId),
        this.#repository.getHousehold(current.job.householdId),
        this.#repository.getListing(
          current.job.itemId,
          current.job.listingVersion,
        ),
        this.#repository.getPlatformListingVariant(
          current.job.itemId,
          current.job.listingVersion,
          current.job.platform,
        ),
        this.#repository.listPlatformListings(current.job.itemId),
        this.#repository.getConnector(current.job.platform),
      ]);
    if (!item || !household || !listing || !variant || !connector) {
      return this.#transitionPublishingJobAsService(current, {
        type: "fatal_failure",
        reasonCode: "JOB_CONTEXT_MISSING",
        detail: "The canonical job context is incomplete.",
      });
    }
    if (connector.kind === "android") {
      return this.#transitionPublishingJobAsService(current, {
        type: "fatal_failure",
        reasonCode: "SERVER_EXECUTOR_SCOPE_REJECTED",
        detail: "Android jobs must execute only on the paired Seller Hub.",
      });
    }
    const capability =
      current.job.commandAction === "update_fields"
        ? "edit"
        : current.job.commandAction === "check_connection" ||
            current.job.commandAction === "pause" ||
            current.job.commandAction === "resume"
          ? "publish"
          : current.job.commandAction;
    const gate = evaluateConnectorGate({
      manifest: connector,
      capability,
      environment: this.#environment,
    });
    if (!gate.allowed) {
      return this.#transitionPublishingJobAsService(current, {
        type: "pause",
        state: "ITEM_BLOCKED",
        reasonCode: "CONNECTOR_BLOCKED",
        detail: gate.blockers.join("; "),
      });
    }
    while (current.job.currentState !== "SUBMIT") {
      if (!isPublishingFlowState(current.job.currentState)) return current;
      current = await this.#transitionPublishingJobAsService(current, {
        type: "advance",
      });
    }

    let execution: ServerConnectorResult;
    try {
      execution = await executor.execute({
        job: current.job,
        connector,
        household,
        item,
        listing,
        variant,
        platformListing:
          platformListings.find(
            (value) =>
              value.platform.toLowerCase() ===
              current!.job.platform.toLowerCase(),
          ) ?? null,
      });
    } catch (error) {
      execution = {
        status: "retryable_failure",
        reasonCode: "CONNECTOR_REQUEST_FAILED",
        detail:
          error instanceof Error ? error.message : "Connector request failed",
      };
    }
    if (execution.status === "retryable_failure") {
      return this.#transitionPublishingJobAsService(current, {
        type: "retryable_failure",
        reasonCode: execution.reasonCode,
        detail: execution.detail,
      });
    }
    if (execution.status === "fatal_failure") {
      return this.#transitionPublishingJobAsService(current, {
        type: "fatal_failure",
        reasonCode: execution.reasonCode,
        detail: execution.detail,
      });
    }
    if (execution.status === "user_confirmation") {
      const createdAt = this.#now();
      await this.#repository.upsertListingExportArtifact({
        id: this.#createId(),
        householdId: current.job.householdId,
        itemId: current.job.itemId,
        publishingJobId: current.job.id,
        platform: current.job.platform,
        format: "json",
        payload: execution.exportPayload,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(
          createdAt.getTime() + 24 * 60 * 60_000,
        ).toISOString(),
        consumedAt: null,
      });
      return this.#transitionPublishingJobAsService(current, {
        type: "pause",
        state: "NEEDS_USER_CONFIRMATION",
        reasonCode: execution.reasonCode,
        detail: execution.detail,
      });
    }

    for (let count = 0; count < 3; count += 1) {
      current = await this.#transitionPublishingJobAsService(
        current,
        { type: "advance" },
        count === 2 ? execution.result : undefined,
      );
    }
    recordPublishConfirmation({
      platform: current.job.platform,
      connectorVersion: current.job.connectorVersion,
      method: "official_api_response",
    });
    return current;
  }

  async transitionPublishingJob(
    actorId: string,
    householdId: string,
    jobId: string,
    request: UserPublishingJobControlRequest,
  ): Promise<JobWithTransitions> {
    await this.#requireMembership(actorId, householdId);
    const current = await this.#repository.getPublishingJob(householdId, jobId);
    if (!current) throw notFound("Publishing job");
    const result = transitionPublishingJob(
      current.job,
      request.event as PublishingEvent,
      this.#now().toISOString(),
    );
    await this.#repository.savePublishingTransition(
      result.job,
      result.transition,
    );
    recordPublishingTransition({
      before: current.job,
      after: result.job,
      transition: result.transition,
      appVersion: current.job.platformAppVersion ?? "server",
    });

    await this.#notifyPublishingState(result.job);
    await this.#audit(
      actorId,
      householdId,
      "publishing.transitioned",
      "publishing_job",
      jobId,
      {
        from: result.transition.from,
        to: result.transition.to,
        reasonCode: result.transition.reasonCode,
      },
    );
    return (
      (await this.#repository.getPublishingJob(householdId, jobId)) ?? {
        job: result.job,
        transitions: [...current.transitions, result.transition],
      }
    );
  }

  async transitionPublishingJobFromDevice(
    device: SellerDevice,
    jobId: string,
    request: TransitionPublishingJobRequest,
  ): Promise<JobWithTransitions> {
    const current = await this.#repository.getPublishingJob(
      device.householdId,
      jobId,
    );
    if (!current || current.job.deviceId !== device.id) {
      throw notFound("Publishing job");
    }
    const result = transitionPublishingJob(
      current.job,
      request.event as PublishingEvent,
      this.#now().toISOString(),
    );
    await this.#repository.savePublishingTransition(
      result.job,
      result.transition,
    );
    recordPublishingTransition({
      before: current.job,
      after: result.job,
      transition: result.transition,
      appVersion: current.job.platformAppVersion ?? "unknown",
    });
    if (result.job.currentState === "PUBLISHED") {
      await this.#applySuccessfulJob(
        device.householdId,
        result.job,
        request.result,
      );
      recordPublishConfirmation({
        platform: result.job.platform,
        connectorVersion: result.job.connectorVersion,
        method: "seller_hub_receipt",
      });
    }
    await this.#notifyPublishingState(result.job);
    await this.#audit(
      device.id,
      device.householdId,
      "publishing.device_transitioned",
      "publishing_job",
      jobId,
      {
        from: result.transition.from,
        to: result.transition.to,
        reasonCode: result.transition.reasonCode,
      },
      "device",
    );
    return (
      (await this.#repository.getPublishingJob(device.householdId, jobId)) ?? {
        job: result.job,
        transitions: [...current.transitions, result.transition],
      }
    );
  }

  async changeItemLifecycle(
    userId: string,
    householdId: string,
    itemId: string,
    request: ItemLifecycleActionRequest,
  ) {
    await this.#requireMembership(userId, householdId);
    await this.#requireFeature("publishing_enabled");
    const input = ItemLifecycleActionRequestSchema.parse(request);
    const item = await this.#repository.getItem(householdId, itemId);
    if (!item) throw notFound("Item");
    const now = this.#now().toISOString();
    const platformListings =
      await this.#repository.listPlatformListings(itemId);
    const jobs: PublishingJob[] = [];
    let exceptionTask: ExceptionTask | null = null;

    if (input.action === "reserve") {
      transitionItemStatus(item.status, "reserved");
      for (const listing of platformListings) {
        if (listing.status === "live") {
          await this.#repository.upsertPlatformListing(
            { ...listing, status: "reserved", lastSynchronizedAt: now },
            householdId,
          );
        }
      }
      const updated = await this.#repository.updateItemStatus(
        householdId,
        itemId,
        "reserved",
        now,
      );
      await this.#audit(userId, householdId, "item.reserved", "item", itemId);
      return { item: updated, jobs, exceptionTask };
    }

    if (input.action === "relist") {
      const target = item.status === "reserved" ? "live" : "draft";
      transitionItemStatus(item.status, target);
      if (item.status === "reserved") {
        for (const listing of platformListings) {
          if (listing.status === "reserved") {
            await this.#repository.upsertPlatformListing(
              { ...listing, status: "live", lastSynchronizedAt: now },
              householdId,
            );
          }
        }
      }
      const updated = await this.#repository.updateItemStatus(
        householdId,
        itemId,
        target,
        now,
      );
      await this.#audit(userId, householdId, "item.relisted", "item", itemId, {
        target,
      });
      return { item: updated, jobs, exceptionTask };
    }

    transitionItemStatus(item.status, "archived");
    const [listing, household, devices, connections] = await Promise.all([
      this.#repository.getLatestListing(itemId),
      this.#repository.getHousehold(householdId),
      this.#repository.listSellerDevices(householdId),
      this.#repository.listPlatformConnections(householdId),
    ]);
    const exceptions: Array<{ platform: string; reason: string }> = [];
    for (const platformListing of platformListings.filter((value) =>
      ["live", "reserved", "publishing", "needs_action"].includes(value.status),
    )) {
      const connector = await this.#repository.getConnector(
        platformListing.platform,
      );
      const device =
        connector?.kind === "android"
          ? (devices.find(
              (value) =>
                value.isPrimary &&
                !value.revokedAt &&
                value.connectionStatus !== "revoked",
            ) ?? null)
          : null;
      const connection = device
        ? (connections.find(
            (value) =>
              value.sellerDeviceId === device.id &&
              value.platform.toLowerCase() ===
                platformListing.platform.toLowerCase(),
          ) ?? null)
        : null;
      const gate = connector
        ? evaluateConnectorGate({
            manifest: connector,
            capability: "delist",
            environment: this.#environment,
            ...(connection ? { appVersion: connection.appVersion } : {}),
          })
        : { allowed: false, blockers: ["Connector is missing"] };
      if (!connector || !listing || !household || !gate.allowed) {
        exceptions.push({
          platform: platformListing.platform,
          reason: gate.blockers.join("; ") || "Manual removal is required",
        });
        continue;
      }
      if (
        connector.kind === "android" &&
        (!device ||
          !connection ||
          !["connected", "needs_login"].includes(connection.connectionStatus))
      ) {
        exceptions.push({
          platform: platformListing.platform,
          reason: "Seller Hub is unavailable",
        });
        continue;
      }
      await this.#ensurePlatformVariant(item, listing, household, connector);
      const queued = await this.#queueJob({
        householdId,
        itemId,
        platform: connector.platform,
        listingVersion: listing.version,
        commandAction: "delist",
        manifest: connector,
        deviceId: device?.id ?? null,
        platformAppVersion: connection?.appVersion ?? null,
      });
      jobs.push(queued.job);
    }
    if (exceptions.length > 0) {
      exceptionTask = {
        id: this.#createId(),
        householdId,
        itemId,
        kind: "inventory_archive",
        title: "Finish removing archived listings",
        details: { exceptions },
        status: "open",
        createdAt: now,
        resolvedAt: null,
      };
      await this.#repository.createExceptionTask(exceptionTask);
    }
    const updated = await this.#repository.updateItemStatus(
      householdId,
      itemId,
      "archived",
      now,
    );
    await this.#audit(userId, householdId, "item.archived", "item", itemId, {
      automaticJobs: jobs.length,
      manualExceptions: exceptions.length,
    });
    return { item: updated, jobs, exceptionTask };
  }

  async propagateListingEdits(
    userId: string,
    householdId: string,
    itemId: string,
    listingVersion: number,
  ) {
    await this.#requireMembership(userId, householdId);
    await this.#requireFeature("publishing_enabled");
    const [item, listing, household, platformListings, devices, connections] =
      await Promise.all([
        this.#repository.getItem(householdId, itemId),
        this.#repository.getListing(itemId, listingVersion),
        this.#repository.getHousehold(householdId),
        this.#repository.listPlatformListings(itemId),
        this.#repository.listSellerDevices(householdId),
        this.#repository.listPlatformConnections(householdId),
      ]);
    if (!item) throw notFound("Item");
    if (!listing) throw notFound("Listing version");
    if (!household) throw notFound("Household");
    const mediaFingerprint = itemMediaFingerprint(item);
    const enrichment = await this.#repository.getLatestItemEnrichment(
      householdId,
      itemId,
      mediaFingerprint,
    );
    const currentRestrictedScreen = enrichment
      ? screenRestrictedListing(enrichment, [
          item.title,
          item.category,
          item.brand,
          item.model,
          ...item.accessories,
          ...item.defects,
          listing.title,
          listing.description,
          listing.conditionSummary,
          JSON.stringify(listing.specifications),
        ])
      : null;
    if (
      !listing.approvedAt ||
      listing.restrictedItemStatus !== "clear" ||
      !enrichment ||
      enrichment.mediaFingerprint !== mediaFingerprint ||
      currentRestrictedScreen?.status !== "clear"
    ) {
      throw new ApplicationError(
        409,
        "listing_not_publishable",
        "Approve, rescan, and clear the edited listing before updating platforms",
      );
    }
    const jobs: PublishingJob[] = [];
    const exceptions: Array<{ platform: string; reason: string }> = [];
    for (const platformListing of platformListings.filter((value) =>
      ["live", "reserved"].includes(value.status),
    )) {
      const connector = await this.#repository.getConnector(
        platformListing.platform,
      );
      const device =
        connector?.kind === "android"
          ? (devices.find(
              (value) =>
                value.isPrimary &&
                !value.revokedAt &&
                value.connectionStatus !== "revoked",
            ) ?? null)
          : null;
      const connection = device
        ? (connections.find(
            (value) =>
              value.sellerDeviceId === device.id &&
              value.platform.toLowerCase() ===
                platformListing.platform.toLowerCase(),
          ) ?? null)
        : null;
      const gate = connector
        ? evaluateConnectorGate({
            manifest: connector,
            capability: "edit",
            environment: this.#environment,
            ...(connection ? { appVersion: connection.appVersion } : {}),
          })
        : { allowed: false, blockers: ["Connector is missing"] };
      if (
        !connector ||
        !gate.allowed ||
        (connector.kind === "android" &&
          (!device ||
            !connection ||
            !["connected", "needs_login"].includes(
              connection.connectionStatus,
            )))
      ) {
        exceptions.push({
          platform: platformListing.platform,
          reason:
            connector?.kind === "android" &&
            (!device ||
              !connection ||
              !["connected", "needs_login"].includes(
                connection.connectionStatus,
              ))
              ? "Seller Hub is unavailable"
              : gate.blockers.join("; ") || "Manual edit is required",
        });
        continue;
      }
      await this.#ensurePlatformVariant(item, listing, household, connector);
      const queued = await this.#queueJob({
        householdId,
        itemId,
        platform: connector.platform,
        listingVersion,
        commandAction: "update_fields",
        manifest: connector,
        deviceId: device?.id ?? null,
        platformAppVersion: connection?.appVersion ?? null,
      });
      jobs.push(queued.job);
    }
    let exceptionTask: ExceptionTask | null = null;
    if (exceptions.length > 0) {
      const now = this.#now().toISOString();
      exceptionTask = {
        id: this.#createId(),
        householdId,
        itemId,
        kind: "listing_update",
        title: "Finish updating listings that need manual action",
        details: { exceptions },
        status: "open",
        createdAt: now,
        resolvedAt: null,
      };
      await this.#repository.createExceptionTask(exceptionTask);
    }
    await this.#audit(
      userId,
      householdId,
      "listing.propagation_requested",
      "item",
      itemId,
      {
        listingVersion,
        automaticJobs: jobs.length,
        manualExceptions: exceptions.length,
      },
    );
    return { jobs, exceptionTask };
  }

  async deleteItem(
    userId: string,
    householdId: string,
    itemId: string,
    confirmTitle: string,
  ) {
    await this.#requireMembership(userId, householdId);
    const item = await this.#repository.getItem(householdId, itemId);
    if (!item) throw notFound("Item");
    if (confirmTitle !== item.title) {
      throw new ApplicationError(
        409,
        "delete_confirmation_mismatch",
        "Type the item title exactly to confirm deletion",
      );
    }
    if (!["captured", "draft", "ready", "archived"].includes(item.status)) {
      throw new ApplicationError(
        409,
        "item_delete_blocked",
        "Close or archive this item before deleting it",
      );
    }
    const platformListings =
      await this.#repository.listPlatformListings(itemId);
    if (
      platformListings.some((listing) =>
        ["publishing", "live", "reserved", "needs_action"].includes(
          listing.status,
        ),
      )
    ) {
      throw new ApplicationError(
        409,
        "item_delete_blocked",
        "Finish removing active platform listings before deleting this item",
      );
    }
    try {
      await this.#mediaLifecycleProvider.deleteObjects(
        item.media.map((asset) => asset.storagePath),
      );
    } catch (error) {
      if (error instanceof AccountLifecycleUnavailableError) {
        throw new ApplicationError(
          503,
          "media_deletion_unavailable",
          "Private media deletion is not configured",
        );
      }
      throw error;
    }
    await this.#audit(userId, householdId, "item.deleted", "item", itemId, {
      mediaCount: item.media.length,
    });
    if (!(await this.#repository.deleteItem(householdId, itemId))) {
      throw notFound("Item");
    }
    return { deleted: true, itemId, deletedMediaCount: item.media.length };
  }

  async closeItem(
    userId: string,
    householdId: string,
    itemId: string,
    request: CloseItemRequest,
  ): Promise<CloseResult> {
    await this.#requireMembership(userId, householdId);
    await this.#requireFeature("publishing_enabled");
    const input = CloseItemRequestSchema.parse(request);
    const item = await this.#repository.getItem(householdId, itemId);
    if (!item) throw notFound("Item");
    transitionItemStatus(item.status, input.outcome);
    const now = this.#now();
    const [listings, devices, connections] = await Promise.all([
      this.#repository.listPlatformListings(itemId),
      this.#repository.listSellerDevices(householdId),
      this.#repository.listPlatformConnections(householdId),
    ]);
    const closureListings = await Promise.all(
      listings.map(async (listing) => {
        const connector = await this.#repository.getConnector(listing.platform);
        const capabilities = connector
          ? CONNECTOR_CAPABILITIES.filter(
              (capability) => connector.capabilities[capability],
            )
          : [];
        const desiredCapability =
          input.outcome === "sold" && capabilities.includes("mark_sold")
            ? "mark_sold"
            : "delist";
        const device =
          connector?.kind === "android"
            ? (devices.find(
                (candidate) =>
                  candidate.isPrimary &&
                  !candidate.revokedAt &&
                  candidate.connectionStatus !== "revoked",
              ) ?? null)
            : null;
        const connection = device
          ? (connections.find(
              (value) =>
                value.sellerDeviceId === device.id &&
                value.platform.toLowerCase() === listing.platform.toLowerCase(),
            ) ?? null)
          : null;
        const deviceReady =
          connector?.kind !== "android" ||
          (device !== null &&
            connection !== null &&
            ["connected", "needs_login"].includes(connection.connectionStatus));
        const connectorAllowed = connector
          ? evaluateConnectorGate({
              manifest: connector,
              capability: desiredCapability,
              environment: this.#environment,
              ...(connection ? { appVersion: connection.appVersion } : {}),
            }).allowed && deviceReady
          : false;
        return {
          platformListingId: listing.id,
          platform: listing.platform,
          status: listing.status,
          capabilities,
          connectorAllowed,
        };
      }),
    );
    const plan = planInventoryClosure(closureListings, input.outcome);
    const latestListing = await this.#repository.getLatestListing(itemId);
    const jobs: PublishingJob[] = [];
    for (const operation of plan.operations) {
      const connector = await this.#repository.getConnector(operation.platform);
      if (!connector) continue;
      const primaryDevice =
        connector.kind === "android"
          ? (devices.find(
              (device) =>
                device.isPrimary &&
                !device.revokedAt &&
                device.connectionStatus !== "revoked",
            ) ?? null)
          : null;
      const connection = primaryDevice
        ? (connections.find(
            (value) =>
              value.sellerDeviceId === primaryDevice.id &&
              value.platform.toLowerCase() === operation.platform.toLowerCase(),
          ) ?? null)
        : null;
      const queued = await this.#queueJob({
        householdId,
        itemId,
        platform: operation.platform,
        listingVersion: latestListing?.version ?? 1,
        commandAction: operation.action,
        manifest: connector,
        deviceId: primaryDevice?.id ?? null,
        platformAppVersion: connection?.appVersion ?? null,
      });
      jobs.push(queued.job);
    }

    const clearedAt = now.toISOString();
    const updated = await this.#repository.updateItemStatus(
      householdId,
      itemId,
      input.outcome,
      clearedAt,
    );
    const outcome: ItemOutcome = {
      id: this.#createId(),
      householdId,
      itemId,
      outcome: input.outcome,
      salePriceCents: input.salePriceCents,
      currency: input.currency,
      destinationPlatform: input.destinationPlatform,
      daysToClear: Math.max(
        0,
        (now.getTime() - new Date(item.createdAt).getTime()) / 86_400_000,
      ),
      notes: input.notes,
      clearedAt,
    };
    await this.#repository.createOutcome(outcome);
    let exceptionTask: ExceptionTask | null = null;
    if (plan.exceptionTask) {
      exceptionTask = {
        id: this.#createId(),
        householdId,
        itemId,
        kind: "inventory_closure",
        title: plan.exceptionTask.title,
        details: { exceptions: plan.exceptionTask.exceptions },
        status: "open",
        createdAt: clearedAt,
        resolvedAt: null,
      };
      await this.#repository.createExceptionTask(exceptionTask);
    }
    await this.#audit(userId, householdId, "item.cleared", "item", itemId, {
      outcome: input.outcome,
      automaticClosureJobs: jobs.length,
      manualExceptions: plan.exceptionTask?.exceptions.length ?? 0,
    });
    return { item: updated, outcome, jobs, exceptionTask };
  }

  async listExceptionTasks(
    userId: string,
    householdId: string,
  ): Promise<ExceptionTask[]> {
    await this.#requireMembership(userId, householdId);
    return this.#repository.listExceptionTasks(householdId);
  }

  async listBuyerTasks(
    userId: string,
    householdId: string,
  ): Promise<BuyerTask[]> {
    await this.#requireMembership(userId, householdId);
    return this.#repository.listBuyerTasks(householdId);
  }

  async ingestBuyerMessage(
    userId: string,
    householdId: string,
    request: IngestBuyerMessageRequest,
  ): Promise<BuyerTask> {
    await this.#requireMembership(userId, householdId);
    await this.#requireFeature("buyer_assistance_enabled");
    const platformListing = await this.#repository.getPlatformListing(
      householdId,
      request.platformListingId,
    );
    if (!platformListing) throw notFound("Platform listing");
    const [canonical, household] = await Promise.all([
      this.#repository.getLatestListing(platformListing.itemId),
      this.#repository.getHousehold(householdId),
    ]);
    if (!canonical) throw notFound("Canonical listing");
    if (!household) throw notFound("Household");
    const task = createBuyerTaskDraft({
      id: this.#createId(),
      platformListingId: platformListing.id,
      participantAlias: request.participantAlias,
      rawMessage: request.rawMessage,
      askingPriceCents: canonical.askingPrice.amountCents,
      minimumPriceCents: canonical.minimumPrice.amountCents,
      currency: canonical.askingPrice.currency,
      publicMeetupDescription:
        household.preferredMeetupLocations[0]?.publicDescription ?? null,
      createdAt: this.#now().toISOString(),
    });
    const saved = await this.#repository.createBuyerTask(task, householdId);
    await this.#createNotification(householdId, {
      type: "buyer_task",
      title: "A buyer needs your reply",
      body: `${saved.participantAlias}: ${saved.intent.replaceAll("_", " ")}`,
      actionPath: "/(tabs)/tasks",
    });
    await this.#audit(
      userId,
      householdId,
      "buyer_task.created",
      "buyer_task",
      saved.id,
      {
        intent: saved.intent,
        scamSignalCount: saved.scamSignals.length,
        rawMessagePersisted: false,
      },
    );
    return saved;
  }

  async decideBuyerTask(
    userId: string,
    householdId: string,
    taskId: string,
    request: BuyerTaskDecisionRequest,
  ): Promise<BuyerTask> {
    await this.#requireMembership(userId, householdId);
    await this.#requireFeature("buyer_assistance_enabled");
    const task = await this.#repository.getBuyerTask(householdId, taskId);
    if (!task) throw notFound("Buyer task");
    if (task.approvalState === "sent") {
      throw new ApplicationError(
        409,
        "reply_already_sent",
        "This reply was already sent",
      );
    }
    if (request.shareExactAddress && !task.requiresAddressApproval) {
      throw new ApplicationError(
        409,
        "address_sharing_not_expected",
        "This conversation does not require an exact address",
      );
    }
    let approvalState: BuyerTask["approvalState"] =
      request.decision === "reject" ? "rejected" : "approved";
    if (request.decision === "approve_and_send") {
      const listing = await this.#repository.getPlatformListing(
        householdId,
        task.platformListingId,
      );
      if (!listing) throw notFound("Platform listing");
      const connector = await this.#repository.getConnector(listing.platform);
      if (!connector) throw notFound("Connector");
      const gate = evaluateConnectorGate({
        manifest: connector,
        capability: "message_send",
        environment: this.#environment,
      });
      if (!gate.allowed) {
        throw new ApplicationError(
          409,
          "message_send_unavailable",
          "This platform does not have an approved reply connector",
          { blockers: gate.blockers },
        );
      }
      approvalState = "sent";
    }
    const saved = await this.#repository.saveBuyerTask(
      {
        ...task,
        suggestedResponse: request.responseText ?? task.suggestedResponse,
        approvalState,
      },
      householdId,
    );
    await this.#audit(
      userId,
      householdId,
      `buyer_task.${approvalState}`,
      "buyer_task",
      taskId,
      {
        responseEdited: request.responseText !== undefined,
        exactAddressApproved: request.shareExactAddress,
      },
    );
    return saved;
  }

  async draftBuyerTaskAction(
    userId: string,
    householdId: string,
    taskId: string,
    request: BuyerTaskActionRequest,
  ) {
    await this.#requireMembership(userId, householdId);
    await this.#requireFeature("buyer_assistance_enabled");
    const task = await this.#repository.getBuyerTask(householdId, taskId);
    if (!task) throw notFound("Buyer task");
    const platformListing = await this.#repository.getPlatformListing(
      householdId,
      task.platformListingId,
    );
    if (!platformListing) throw notFound("Platform listing");
    const [listing, household] = await Promise.all([
      this.#repository.getLatestListing(platformListing.itemId),
      this.#repository.getHousehold(householdId),
    ]);
    if (!listing) throw notFound("Canonical listing");
    if (!household) throw notFound("Household");
    let draft;
    try {
      draft = generateBuyerActionDraft({
        action: request.action,
        askingPriceCents: listing.askingPrice.amountCents,
        minimumPriceCents: listing.minimumPrice.amountCents,
        offeredPriceCents: task.priceOffer?.amountCents ?? null,
        ...(request.counterPriceCents === undefined
          ? {}
          : { counterPriceCents: request.counterPriceCents }),
        currency: listing.askingPrice.currency,
        acceptsTrades: listing.negotiationRules.acceptsTrades,
        allowsDelivery: listing.exchangeOptions.includes("local_delivery"),
        availability: household.availability,
        timezone: household.timezone,
        publicLocation:
          household.preferredMeetupLocations[0]?.publicDescription ?? null,
        now: this.#now(),
      });
    } catch (error) {
      throw new ApplicationError(
        409,
        "buyer_action_blocked",
        error instanceof Error ? error.message : "This action is not allowed",
      );
    }
    await this.#audit(
      userId,
      householdId,
      "buyer_task.action_drafted",
      "buyer_task",
      taskId,
      { action: draft.action, requiresApproval: true },
    );
    return { draft };
  }

  async listMeetups(userId: string, householdId: string): Promise<Meetup[]> {
    await this.#requireMembership(userId, householdId);
    return this.#repository.listMeetups(householdId);
  }

  async createMeetup(
    userId: string,
    householdId: string,
    taskId: string,
    request: CreateMeetupRequest,
  ): Promise<Meetup> {
    await this.#requireMembership(userId, householdId);
    await this.#requireFeature("buyer_assistance_enabled");
    const task = await this.#repository.getBuyerTask(householdId, taskId);
    if (!task) throw notFound("Buyer task");
    if (task.scamSignals.length > 0) {
      throw new ApplicationError(
        409,
        "unsafe_buyer_task",
        "A meetup cannot be scheduled for a conversation with scam signals",
      );
    }
    const [platformListing, household] = await Promise.all([
      this.#repository.getPlatformListing(householdId, task.platformListingId),
      this.#repository.getHousehold(householdId),
    ]);
    if (!platformListing) throw notFound("Platform listing");
    if (!household) throw notFound("Household");
    const listing = await this.#repository.getLatestListing(
      platformListing.itemId,
    );
    if (!listing) throw notFound("Canonical listing");
    if (!listing.exchangeOptions.includes(request.locationType)) {
      throw new ApplicationError(
        409,
        "exchange_option_unavailable",
        "That exchange method is not approved for this listing",
      );
    }

    const now = this.#now();
    const scheduledAt = request.scheduledAt
      ? new Date(request.scheduledAt)
      : nextAvailabilitySlots({
          availability: household.availability,
          timezone: household.timezone,
          from: now,
          count: 1,
        })[0];
    if (!scheduledAt) {
      throw new ApplicationError(
        409,
        "availability_required",
        "Choose a time or save an availability window before scheduling",
      );
    }
    if (scheduledAt.getTime() <= now.getTime()) {
      throw new ApplicationError(
        409,
        "meetup_time_in_past",
        "Meetup time must be in the future",
      );
    }

    let approvedLocation: string;
    let exactAddressApprovedAt: string | null = null;
    if (request.locationType === "public_meetup") {
      const publicLocation = request.preferredMeetupLocationId
        ? household.preferredMeetupLocations.find(
            (value) => value.id === request.preferredMeetupLocationId,
          )
        : household.preferredMeetupLocations[0];
      if (!publicLocation) {
        throw new ApplicationError(
          409,
          "public_location_required",
          "Save a public meetup location before scheduling",
        );
      }
      approvedLocation = publicLocation.publicDescription;
    } else {
      if (!request.exactAddressApproved || !request.approvedLocation) {
        throw new ApplicationError(
          409,
          "exact_address_approval_required",
          "Explicit approval is required before saving a private location",
        );
      }
      approvedLocation = request.approvedLocation;
      exactAddressApprovedAt = now.toISOString();
    }

    const meetup = MeetupSchema.parse({
      id: this.#createId(),
      itemId: platformListing.itemId,
      platformListingId: platformListing.id,
      buyerAlias: task.participantAlias,
      scheduledAt: scheduledAt.toISOString(),
      locationType: request.locationType,
      approvedLocation,
      exactAddressApprovedAt,
      status: "proposed",
    });
    const saved = await this.#repository.createMeetup(meetup, householdId);
    await this.#repository.saveBuyerTask(
      { ...task, schedulingState: "proposed" },
      householdId,
    );
    await this.#audit(
      userId,
      householdId,
      "meetup.proposed",
      "meetup",
      saved.id,
      {
        locationType: saved.locationType,
        exactAddressApproved: saved.exactAddressApprovedAt !== null,
        locationRedacted: true,
      },
    );
    return saved;
  }

  async updateMeetup(
    userId: string,
    householdId: string,
    meetupId: string,
    request: UpdateMeetupRequest,
  ): Promise<Meetup> {
    await this.#requireMembership(userId, householdId);
    const meetup = (await this.#repository.listMeetups(householdId)).find(
      (value) => value.id === meetupId,
    );
    if (!meetup) throw notFound("Meetup");
    const allowed: Record<Meetup["status"], readonly Meetup["status"][]> = {
      proposed: ["confirmed", "cancelled"],
      confirmed: ["completed", "cancelled", "no_show"],
      completed: [],
      cancelled: [],
      no_show: [],
    };
    if (!allowed[meetup.status].includes(request.status)) {
      throw new ApplicationError(
        409,
        "invalid_meetup_transition",
        `A ${meetup.status} meetup cannot become ${request.status}`,
      );
    }
    const saved = await this.#repository.saveMeetup(
      { ...meetup, status: request.status },
      householdId,
    );
    const buyerTask = (await this.#repository.listBuyerTasks(householdId)).find(
      (task) =>
        task.platformListingId === meetup.platformListingId &&
        task.participantAlias === meetup.buyerAlias,
    );
    if (buyerTask) {
      await this.#repository.saveBuyerTask(
        {
          ...buyerTask,
          schedulingState:
            request.status === "confirmed"
              ? "confirmed"
              : request.status === "cancelled" || request.status === "no_show"
                ? "cancelled"
                : buyerTask.schedulingState,
        },
        householdId,
      );
    }
    await this.#audit(
      userId,
      householdId,
      `meetup.${request.status}`,
      "meetup",
      saved.id,
      { previousStatus: meetup.status, locationRedacted: true },
    );
    return saved;
  }

  async enqueueBackupBuyer(
    userId: string,
    householdId: string,
    taskId: string,
  ): Promise<BackupBuyerEntry> {
    await this.#requireMembership(userId, householdId);
    await this.#requireFeature("buyer_assistance_enabled");
    const task = await this.#repository.getBuyerTask(householdId, taskId);
    if (!task) throw notFound("Buyer task");
    if (task.scamSignals.length > 0) {
      throw new ApplicationError(
        409,
        "unsafe_buyer_task",
        "A conversation with scam signals cannot join the backup queue",
      );
    }
    const listing = await this.#repository.getPlatformListing(
      householdId,
      task.platformListingId,
    );
    if (!listing) throw notFound("Platform listing");
    const existing = await this.#repository.listBackupBuyers(
      householdId,
      listing.itemId,
    );
    const now = this.#now().toISOString();
    const entry = await this.#repository.enqueueBackupBuyer({
      id: this.#createId(),
      householdId,
      itemId: listing.itemId,
      platformListingId: listing.id,
      buyerTaskId: task.id,
      participantAlias: task.participantAlias,
      position:
        existing.reduce(
          (highest, value) => Math.max(highest, value.position),
          0,
        ) + 1,
      status: "waiting",
      createdAt: now,
      updatedAt: now,
    });
    await this.#audit(
      userId,
      householdId,
      "buyer_backup.enqueued",
      "buyer_backup",
      entry.id,
      { itemId: entry.itemId, position: entry.position },
    );
    return entry;
  }

  async listBackupBuyers(
    userId: string,
    householdId: string,
    itemId: string,
  ): Promise<BackupBuyerEntry[]> {
    await this.#requireMembership(userId, householdId);
    if (!(await this.#repository.getItem(householdId, itemId))) {
      throw notFound("Item");
    }
    return this.#repository.listBackupBuyers(householdId, itemId);
  }

  async updateBackupBuyer(
    userId: string,
    householdId: string,
    itemId: string,
    entryId: string,
    request: UpdateBackupBuyerRequest,
  ): Promise<BackupBuyerEntry> {
    await this.#requireMembership(userId, householdId);
    const entries = await this.#repository.listBackupBuyers(
      householdId,
      itemId,
    );
    const entry = entries.find((value) => value.id === entryId);
    if (!entry) throw notFound("Backup buyer");
    if (entry.status !== "waiting") {
      throw new ApplicationError(
        409,
        "backup_buyer_already_handled",
        "This backup buyer has already been handled",
      );
    }
    if (request.action === "promote") {
      const firstWaiting = entries.find((value) => value.status === "waiting");
      if (firstWaiting?.id !== entry.id) {
        throw new ApplicationError(
          409,
          "backup_queue_order",
          "Promote the first waiting buyer before later entries",
        );
      }
    }
    const now = this.#now().toISOString();
    const saved = await this.#repository.saveBackupBuyer({
      ...entry,
      status: request.action === "promote" ? "promoted" : "removed",
      updatedAt: now,
    });
    if (request.action === "promote") {
      const source = await this.#repository.getBuyerTask(
        householdId,
        entry.buyerTaskId,
      );
      if (source) {
        const followUp = await this.#repository.createBuyerTask(
          {
            ...source,
            id: this.#createId(),
            intent: "availability",
            redactedMessageExcerpt: "Backup buyer ready for follow-up",
            suggestedResponse:
              "The item is available again. Are you still interested? I can confirm a meetup after you reply.",
            approvalState: "pending",
            schedulingState: "none",
            requiresAddressApproval: false,
            scamSignals: [],
            createdAt: now,
          },
          householdId,
        );
        await this.#createNotification(householdId, {
          type: "buyer_task",
          title: "Backup buyer ready",
          body: `${followUp.participantAlias} is next in line`,
          actionPath: "/(tabs)/tasks",
        });
      }
    }
    await this.#audit(
      userId,
      householdId,
      `buyer_backup.${saved.status}`,
      "buyer_backup",
      saved.id,
      { itemId, position: saved.position },
    );
    return saved;
  }

  async listConnectors(userId: string): Promise<ConnectorManifest[]> {
    if (!userId) throw forbidden();
    return this.#repository.listConnectors();
  }

  async getOperationsDashboard() {
    const now = this.#now();
    const since = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
    const [connectors, featureFlags, releases, rows, duplicateBlocks] =
      await Promise.all([
        this.#repository.listConnectors(),
        this.#repository.listFeatureFlags(),
        this.#repository.listProductionReleases(20),
        this.#repository.listConnectorHealthRows(since),
        this.#repository.countRecentAuditEvents(
          "publishing.duplicate_blocked",
          since,
        ),
      ]);
    const groups = new Map<
      string,
      {
        platform: string;
        connectorVersion: string;
        appVersion: string;
        total: number;
        published: number;
        failed: number;
        paused: number;
        active: number;
        failureTypes: Record<string, number>;
      }
    >();
    for (const row of rows) {
      const key = `${row.platform}|${row.connectorVersion}|${row.appVersion}`;
      const group = groups.get(key) ?? {
        platform: row.platform,
        connectorVersion: row.connectorVersion,
        appVersion: row.appVersion,
        total: 0,
        published: 0,
        failed: 0,
        paused: 0,
        active: 0,
        failureTypes: {},
      };
      group.total += row.count;
      if (row.currentState === "PUBLISHED") group.published += row.count;
      else if (row.currentState.startsWith("FAILED")) group.failed += row.count;
      else if (isPausedPublishingState(row.currentState)) {
        group.paused += row.count;
      } else group.active += row.count;
      if (row.errorCode) {
        group.failureTypes[row.errorCode] =
          (group.failureTypes[row.errorCode] ?? 0) + row.count;
      }
      groups.set(key, group);
    }
    const health = [...groups.values()].map((group) => {
      const terminal = group.published + group.failed;
      return {
        ...group,
        successRate: terminal === 0 ? null : group.published / terminal,
      };
    });
    const alerts: Array<{
      severity: "warning" | "critical";
      code: string;
      message: string;
      platform: string | null;
    }> = [];
    for (const metric of health) {
      const terminal = metric.published + metric.failed;
      if (terminal >= 5 && metric.failed / terminal >= 0.2) {
        alerts.push({
          severity: metric.failed / terminal >= 0.5 ? "critical" : "warning",
          code: "FAILURE_SPIKE",
          message: `${metric.failed} of ${terminal} terminal jobs failed on ${metric.appVersion}`,
          platform: metric.platform,
        });
      }
      const challengeCount = Object.entries(metric.failureTypes)
        .filter(([code]) => /LOGIN|MFA|CAPTCHA|ACCOUNT/i.test(code))
        .reduce((sum, [, count]) => sum + count, 0);
      if (challengeCount >= 3) {
        alerts.push({
          severity: "warning",
          code: "ACCOUNT_CHALLENGE_SPIKE",
          message: `${challengeCount} account challenges in the last 24 hours`,
          platform: metric.platform,
        });
      }
    }
    if (duplicateBlocks >= 5) {
      alerts.push({
        severity: "warning",
        code: "DUPLICATE_RATE_ALERT",
        message: `${duplicateBlocks} likely duplicate publish attempts were blocked in 24 hours`,
        platform: null,
      });
    }
    return {
      generatedAt: now.toISOString(),
      windowStartedAt: since,
      connectors,
      featureFlags,
      releases,
      health,
      alerts,
      duplicateBlocks,
    };
  }

  async updateConnectorDefinition(
    actorId: string,
    connectorId: string,
    request: AdminConnectorUpdateRequest,
  ): Promise<ConnectorManifest> {
    const existing = await this.#repository.getConnectorById(connectorId);
    if (!existing) throw notFound("Connector");
    if (request.enabled && request.policyStatus === "disabled") {
      throw new ApplicationError(
        409,
        "connector_governance_invalid",
        "A disabled-policy connector cannot be enabled",
      );
    }
    if (request.enabled && request.killSwitchReason) {
      throw new ApplicationError(
        409,
        "connector_governance_invalid",
        "An enabled connector cannot retain a kill-switch reason",
      );
    }
    if (!request.enabled && !request.killSwitchReason) {
      throw new ApplicationError(
        409,
        "kill_switch_reason_required",
        "Disabling a connector requires a reason",
      );
    }
    if (
      request.policyStatus === "approved" &&
      (!request.productionMethod ||
        !request.approvalEvidenceUrl ||
        !request.canaryTestId)
    ) {
      throw new ApplicationError(
        409,
        "approval_evidence_required",
        "Approved production connectors require a permitted method, approval evidence, and canary test",
      );
    }
    const changedAt = this.#now().toISOString();
    const definitionVersion = existing.definitionVersion + 1;
    const { changeSummary, ...definition } = request;
    const updated = ConnectorManifestSchema.parse({
      ...existing,
      ...definition,
      definitionVersion,
      policyReviewedAt:
        request.policyStatus === "approved"
          ? changedAt
          : existing.policyReviewedAt,
      changeLog: [
        ...existing.changeLog,
        {
          version: `${existing.version}-definition.${definitionVersion}`,
          changedAt,
          changedBy: actorId,
          summary: changeSummary,
        },
      ],
    });
    const saved = await this.#repository.upsertConnector(updated);
    await this.#audit(
      actorId,
      null,
      "connector.definition_updated",
      "connector",
      connectorId,
      {
        definitionVersion,
        enabled: saved.enabled,
        policyStatus: saved.policyStatus,
      },
      "admin",
    );
    return saved;
  }

  async updateFeatureFlag(
    actorId: string,
    key: string,
    request: AdminFeatureFlagUpdateRequest,
  ): Promise<FeatureFlag> {
    const existing = await this.#repository.getFeatureFlag(key);
    if (!existing) throw notFound("Feature flag");
    if (request.enabled && request.killSwitchReason) {
      throw new ApplicationError(
        409,
        "feature_governance_invalid",
        "An enabled feature cannot retain a kill-switch reason",
      );
    }
    if (!request.enabled && !request.killSwitchReason) {
      throw new ApplicationError(
        409,
        "kill_switch_reason_required",
        "Disabling a feature requires a reason",
      );
    }
    const updatedAt = this.#now().toISOString();
    const version = existing.version + 1;
    const saved = await this.#repository.upsertFeatureFlag(
      FeatureFlagSchema.parse({
        ...existing,
        enabled: request.enabled,
        killSwitchReason: request.killSwitchReason,
        owner: request.owner,
        version,
        updatedAt,
        changeLog: [
          ...existing.changeLog,
          {
            version,
            changedAt: updatedAt,
            changedBy: actorId,
            summary: request.changeSummary,
          },
        ],
      }),
    );
    await this.#audit(
      actorId,
      null,
      "feature_flag.updated",
      "feature_flag",
      key,
      { version, enabled: saved.enabled },
      "admin",
    );
    return saved;
  }

  async createProductionRelease(
    actorId: string,
    request: CreateProductionReleaseRequest,
  ): Promise<ProductionRelease> {
    const connectors = await this.#repository.listConnectors();
    const missing = request.connectorIds.filter(
      (id) => !connectors.some((connector) => connector.id === id),
    );
    if (missing.length > 0) {
      throw new ApplicationError(
        400,
        "release_connector_missing",
        "Every release connector must exist",
        { connectorIds: missing },
      );
    }
    const existing = await this.#repository.listProductionReleases(100);
    if (existing.some((release) => release.version === request.version)) {
      throw new ApplicationError(
        409,
        "release_version_exists",
        "That release version already exists",
      );
    }
    const now = this.#now().toISOString();
    const saved = await this.#repository.createProductionRelease(
      ProductionReleaseSchema.parse({
        id: this.#createId(),
        ...request,
        status: "draft",
        createdBy: actorId,
        approvalActorIds: [],
        rejectionReason: null,
        createdAt: now,
        updatedAt: now,
        approvedAt: null,
        deployedAt: null,
      }),
    );
    await this.#audit(
      actorId,
      null,
      "production_release.created",
      "production_release",
      saved.id,
      {
        version: saved.version,
        target: saved.target,
        connectorCount: saved.connectorIds.length,
        evidenceKinds: saved.evidence.map((entry) => entry.kind),
      },
      "admin",
    );
    return saved;
  }

  async submitProductionRelease(
    actorId: string,
    releaseId: string,
  ): Promise<ProductionRelease> {
    const release = await this.#repository.getProductionRelease(releaseId);
    if (!release) throw notFound("Production release");
    if (release.createdBy !== actorId) {
      throw new ApplicationError(
        403,
        "release_author_required",
        "Only the release author can submit this draft",
      );
    }
    const connectors = await this.#repository.listConnectors();
    let submitted: ProductionRelease;
    try {
      submitted = submitProductionRelease(
        release,
        connectors,
        this.#now().toISOString(),
      );
    } catch (error) {
      this.#throwReleaseGate(error);
    }
    const saved = await this.#repository.saveProductionRelease(submitted!);
    await this.#audit(
      actorId,
      null,
      "production_release.submitted",
      "production_release",
      saved.id,
      { version: saved.version, target: saved.target },
      "admin",
    );
    return saved;
  }

  async reviewProductionRelease(
    actorId: string,
    releaseId: string,
    request: ReviewProductionReleaseRequest,
  ): Promise<ProductionRelease> {
    const release = await this.#repository.getProductionRelease(releaseId);
    if (!release) throw notFound("Production release");
    const now = this.#now().toISOString();
    let reviewed: ProductionRelease;
    try {
      if (request.action === "approve") {
        reviewed = approveProductionRelease(release, actorId, now);
      } else if (request.action === "reject") {
        reviewed = rejectProductionRelease(
          release,
          actorId,
          request.reason ?? "Release rejected",
          now,
        );
      } else if (request.action === "deploy") {
        reviewed = deployProductionRelease(release, actorId, now);
      } else {
        reviewed = rollbackProductionRelease(release, actorId, now);
      }
    } catch (error) {
      this.#throwReleaseGate(error);
    }
    const saved = await this.#repository.saveProductionRelease(reviewed!);
    await this.#audit(
      actorId,
      null,
      `production_release.${
        request.action === "approve"
          ? "approved"
          : request.action === "reject"
            ? "rejected"
            : request.action === "deploy"
              ? "deployed"
              : "rolled_back"
      }`,
      "production_release",
      saved.id,
      {
        version: saved.version,
        status: saved.status,
        approvalCount: saved.approvalActorIds.length,
        reasonRecorded: Boolean(request.reason),
      },
      "admin",
    );
    return saved;
  }

  async createSupportGrant(
    userId: string,
    householdId: string,
    request: CreateSupportGrantRequest,
  ): Promise<SupportAccessGrant> {
    await this.#requireMembership(userId, householdId);
    const now = this.#now();
    const scope = [...new Set(request.scope)];
    const grant = SupportAccessGrantSchema.parse({
      id: this.#createId(),
      householdId,
      grantedBy: userId,
      supportActorId: request.supportActorId,
      reasonCode: request.reasonCode,
      scope,
      diagnosticConsent:
        request.diagnosticConsentConfirmation ===
        "I CONSENT TO REDACTED DIAGNOSTICS",
      expiresAt: new Date(
        now.getTime() + request.durationMinutes * 60_000,
      ).toISOString(),
      revokedAt: null,
      createdAt: now.toISOString(),
    });
    const saved = await this.#repository.createSupportGrant(grant);
    await this.#audit(
      userId,
      householdId,
      "support_access.granted",
      "support_grant",
      saved.id,
      {
        supportActorId: saved.supportActorId,
        reasonCode: saved.reasonCode,
        scope: saved.scope,
        durationMinutes: request.durationMinutes,
        diagnosticConsent: saved.diagnosticConsent,
      },
    );
    return saved;
  }

  async listSupportGrants(
    userId: string,
    householdId: string,
  ): Promise<SupportAccessGrant[]> {
    await this.#requireMembership(userId, householdId);
    return this.#repository.listSupportGrants(householdId);
  }

  async revokeSupportGrant(
    userId: string,
    householdId: string,
    grantId: string,
  ): Promise<SupportAccessGrant> {
    await this.#requireMembership(userId, householdId);
    const grant = await this.#repository.revokeSupportGrant(
      householdId,
      grantId,
      this.#now().toISOString(),
    );
    if (!grant) throw notFound("Active support grant");
    await this.#audit(
      userId,
      householdId,
      "support_access.revoked",
      "support_grant",
      grant.id,
      { supportActorId: grant.supportActorId },
    );
    return grant;
  }

  async createDiagnosticArtifact(
    userId: string,
    householdId: string,
    request: CreateDiagnosticArtifactRequest,
  ): Promise<DiagnosticArtifact> {
    await this.#requireMembership(userId, householdId);
    await this.#requireFeature("diagnostic_uploads_enabled");
    const grant = await this.#repository.getSupportGrant(request.grantId);
    if (
      !grant ||
      grant.householdId !== householdId ||
      grant.grantedBy !== userId ||
      grant.revokedAt !== null ||
      grant.expiresAt <= this.#now().toISOString() ||
      !grant.diagnosticConsent ||
      !grant.scope.includes("diagnostic_artifacts")
    ) {
      throw new ApplicationError(
        403,
        "diagnostic_consent_required",
        "An active diagnostic grant created by this user is required",
      );
    }
    const prefix = `${householdId}/diagnostics/`;
    if (
      !request.storagePath.startsWith(prefix) ||
      request.storagePath.includes("..") ||
      request.storagePath.includes("\\")
    ) {
      throw new ApplicationError(
        400,
        "diagnostic_path_invalid",
        "Diagnostic files must use the household diagnostic storage prefix",
      );
    }
    const now = this.#now().toISOString();
    const artifact = await this.#repository.createDiagnosticArtifact(
      DiagnosticArtifactSchema.parse({
        id: this.#createId(),
        householdId,
        grantId: grant.id,
        submittedBy: userId,
        kind: request.kind,
        storagePath: request.storagePath,
        contentSha256: request.contentSha256,
        redacted: request.redacted,
        privacyScanPassed: request.privacyScanPassed,
        consentedAt: now,
        createdAt: now,
      }),
    );
    await this.#audit(
      userId,
      householdId,
      "diagnostic.submitted",
      "diagnostic_artifact",
      artifact.id,
      {
        grantId: grant.id,
        kind: artifact.kind,
        redacted: true,
        privacyScanPassed: true,
        storagePathPersistedInAudit: false,
      },
    );
    return artifact;
  }

  async listMyActiveSupportGrants(
    actorId: string,
  ): Promise<SupportAccessGrant[]> {
    return this.#repository.listActiveSupportGrantsForActor(
      actorId,
      this.#now().toISOString(),
    );
  }

  async getSupportSession(actorId: string, grantId: string) {
    const grant = await this.#repository.getSupportGrant(grantId);
    if (
      !grant ||
      grant.supportActorId !== actorId ||
      grant.revokedAt !== null ||
      grant.expiresAt <= this.#now().toISOString()
    ) {
      throw new ApplicationError(
        403,
        "support_grant_inactive",
        "An active support grant assigned to this operator is required",
      );
    }
    const snapshot = await this.#repository.getRedactedSupportSnapshot(
      grant.householdId,
    );
    const diagnostics = grant.scope.includes("diagnostic_artifacts")
      ? await this.#repository.listDiagnosticArtifacts(grant.id)
      : [];
    const artifacts = await Promise.all(
      diagnostics.map(async (artifact) => ({
        ...artifact,
        readUrl: this.#mediaReadUrlProvider
          ? await this.#mediaReadUrlProvider.createReadUrl(
              artifact.storagePath,
              60,
            )
          : null,
      })),
    );
    await this.#audit(
      actorId,
      grant.householdId,
      "support_access.session_viewed",
      "support_grant",
      grant.id,
      {
        scope: grant.scope,
        diagnosticCount: artifacts.length,
        exactLocationsIncluded: false,
        messageBodiesIncluded: false,
        credentialsIncluded: false,
      },
      "admin",
    );
    return {
      grant,
      devices: grant.scope.includes("device_health") ? snapshot.devices : [],
      jobs: grant.scope.includes("job_metadata") ? snapshot.jobs : [],
      diagnostics: artifacts,
    };
  }

  async createSellerDeviceForTesting(
    userId: string,
    householdId: string,
    input: Omit<SellerDevice, "id" | "householdId">,
  ): Promise<SellerDevice> {
    await this.#requireMembership(userId, householdId);
    const device = SellerDeviceSchema.parse({
      ...input,
      id: this.#createId(),
      householdId,
    });
    return this.#repository.createSellerDevice(device);
  }

  async #buildCapturedItem(
    householdId: string,
    input: CapturedItemInput,
  ): Promise<StoredItem> {
    for (const photo of input.photos) {
      if (
        !photo.storagePath.startsWith(`${householdId}/`) ||
        photo.storagePath.includes("..") ||
        photo.storagePath.includes("\\")
      ) {
        throw new ApplicationError(
          400,
          "invalid_media_path",
          "Every media path must be scoped to the household",
        );
      }
    }
    const verifiedPhotos = [] as VerifiedMedia[];
    for (const photo of input.photos) {
      try {
        verifiedPhotos.push(
          await this.#mediaVerificationProvider.verify({
            storagePath: photo.storagePath,
            expectedSha256: photo.contentSha256,
            declaredMediaType: photo.mediaType,
          }),
        );
      } catch (error) {
        if (error instanceof MediaVerificationError) {
          const statusCode =
            error.code === "media_unavailable"
              ? 503
              : error.code === "media_too_large"
                ? 413
                : 422;
          throw new ApplicationError(statusCode, error.code, error.message);
        }
        throw new ApplicationError(
          502,
          "media_verification_failed",
          "Uploaded media could not be verified",
        );
      }
    }
    const now = this.#now().toISOString();
    const itemId = this.#createId();
    const identification = input.identification ?? {
      itemType: input.title ?? "Unidentified item",
      category: input.category ?? "Uncategorized",
      brand: input.brand,
      model: input.model,
      confidence: 0,
      alternatives: [],
      extractedText: [],
      barcodes: input.barcode ? [input.barcode] : [],
    };
    const item = ItemSchema.parse({
      id: itemId,
      householdId,
      title: input.title ?? "Item awaiting identification",
      category: input.category ?? "Uncategorized",
      brand: input.brand,
      model: input.model,
      condition: input.condition,
      dimensions: input.dimensions,
      specifications: input.specifications,
      accessories: input.accessories,
      defects: input.defects,
      storageLocation: input.storageLocation,
      identification,
      clearingRecommendation: input.clearingRecommendation,
      status: "captured",
      media: input.photos.map((photo, index) => ({
        id: this.#createId(),
        itemId,
        storagePath: photo.storagePath,
        contentSha256: verifiedPhotos[index]!.contentSha256,
        mediaType: verifiedPhotos[index]!.mediaType,
        order: index,
        isLead: index === 0,
        qualityIssues: photo.qualityIssues,
        redactionState: "pending_scan",
        source: photo.source,
        exifLocationStripped: verifiedPhotos[index]!.exifLocationStripped,
        retentionState: "permanent",
        createdAt: now,
      })),
      createdAt: now,
      updatedAt: now,
    });
    return {
      ...item,
      barcode: input.barcode ?? identification.barcodes[0] ?? null,
      imageFingerprint: input.imageFingerprint,
    };
  }

  #duplicatesFor(item: StoredItem, inventory: readonly StoredItem[]) {
    return findLikelyDuplicates(
      {
        id: item.id,
        normalizedTitle: normalizeTitle(item.title),
        barcode: item.barcode,
        imageFingerprint: item.imageFingerprint,
        brand: item.brand,
        model: item.model,
      },
      inventory.map((value) => ({
        id: value.id,
        normalizedTitle: normalizeTitle(value.title),
        barcode: value.barcode,
        imageFingerprint: value.imageFingerprint,
        brand: value.brand,
        model: value.model,
      })),
    );
  }

  async #ensurePlatformVariant(
    item: StoredItem,
    listing: CanonicalListing,
    household: Household,
    manifest: ConnectorManifest,
  ) {
    const existing = await this.#repository.getPlatformListingVariant(
      item.id,
      listing.version,
      manifest.platform,
    );
    if (existing && existing.connectorVersion === manifest.version) {
      return existing;
    }
    try {
      return await this.#repository.upsertPlatformListingVariant(
        createPlatformListingVariant({
          id: this.#createId(),
          item,
          listing,
          household,
          connector: manifest,
          generatedAt: this.#now().toISOString(),
        }),
      );
    } catch (error) {
      if (error instanceof MissingConnectorFieldsError) {
        throw new ApplicationError(
          409,
          "connector_required_fields_missing",
          `${manifest.platform} needs more listing information`,
          { fields: error.fields },
        );
      }
      throw error;
    }
  }

  async #transitionPublishingJobAsService(
    current: JobWithTransitions,
    event: PublishingEvent,
    result?: TransitionPublishingJobRequest["result"],
  ): Promise<JobWithTransitions> {
    const transitioned = transitionPublishingJob(
      current.job,
      event,
      this.#now().toISOString(),
    );
    await this.#repository.savePublishingTransition(
      transitioned.job,
      transitioned.transition,
    );
    recordPublishingTransition({
      before: current.job,
      after: transitioned.job,
      transition: transitioned.transition,
      appVersion: current.job.platformAppVersion ?? "server",
    });
    if (transitioned.job.currentState === "PUBLISHED") {
      await this.#applySuccessfulJob(
        transitioned.job.householdId,
        transitioned.job,
        result,
      );
    }
    await this.#notifyPublishingState(transitioned.job);
    await this.#audit(
      "publishing-dispatcher",
      transitioned.job.householdId,
      "publishing.service_transitioned",
      "publishing_job",
      transitioned.job.id,
      {
        from: transitioned.transition.from,
        to: transitioned.transition.to,
        reasonCode: transitioned.transition.reasonCode,
      },
      "service",
    );
    return (
      (await this.#repository.getPublishingJob(
        transitioned.job.householdId,
        transitioned.job.id,
      )) ?? {
        job: transitioned.job,
        transitions: [...current.transitions, transitioned.transition],
      }
    );
  }

  async #notifyPublishingState(job: PublishingJob): Promise<void> {
    if (job.currentState === "PUBLISHED") {
      await this.#createNotification(job.householdId, {
        type: "publishing_published",
        title: `${job.platform} listing is live`,
        body: "The platform confirmed the listing and inventory was synchronized.",
        actionPath: `/item/${job.itemId}`,
      });
      return;
    }
    if (isPausedPublishingState(job.currentState)) {
      await this.#createNotification(job.householdId, {
        type: "publishing_paused",
        title: `${job.platform} needs your attention`,
        body: publishingAttentionMessage(job.currentState),
        actionPath: `/publish/${job.itemId}?listingVersion=${job.listingVersion}`,
      });
      return;
    }
    if (job.currentState === "FAILED_FINAL") {
      await this.#createNotification(job.householdId, {
        type: "publishing_failed",
        title: `${job.platform} publishing stopped`,
        body: "The job ended visibly after bounded retries. Review it before trying again.",
        actionPath: `/publish/${job.itemId}?listingVersion=${job.listingVersion}`,
      });
    }
  }

  async #createNotification(
    householdId: string,
    input: {
      type: UserNotification["type"];
      title: string;
      body: string;
      actionPath: string | null;
    },
  ): Promise<void> {
    const household = await this.#repository.getHousehold(householdId);
    if (!household) return;
    const now = this.#now().toISOString();
    await this.#repository.createNotification(
      UserNotificationSchema.parse({
        id: this.#createId(),
        householdId,
        userId: household.ownerId,
        type: input.type,
        title: input.title,
        body: input.body,
        actionPath: input.actionPath,
        deliveryState: "queued",
        deliveryAttempts: 0,
        nextDeliveryAt: now,
        providerTicketIds: [],
        readAt: null,
        createdAt: now,
      }),
    );
  }

  async #queueJob(input: {
    householdId: string;
    itemId: string;
    platform: string;
    listingVersion: number;
    commandAction: PublishingCommandAction;
    manifest: ConnectorManifest;
    deviceId: string | null;
    platformAppVersion: string | null;
  }): Promise<{ job: PublishingJob; created: boolean }> {
    const now = this.#now();
    const idempotencyKey = publishingIdempotencyKey(input);
    const existing =
      await this.#repository.getPublishingJobByIdempotencyKey(idempotencyKey);
    if (existing) return { job: existing, created: false };
    const [minuteCount, dailyPublishCount] = await Promise.all([
      this.#repository.countPublishingJobs(
        input.householdId,
        input.platform,
        new Date(now.getTime() - 60_000).toISOString(),
      ),
      input.commandAction === "publish"
        ? this.#repository.countPublishingJobs(
            input.householdId,
            input.platform,
            new Date(now.getTime() - 24 * 60 * 60_000).toISOString(),
            "publish",
          )
        : Promise.resolve(0),
    ]);
    if (minuteCount >= input.manifest.rateLimitPerMinute) {
      throw new ApplicationError(
        429,
        "connector_rate_limited",
        `${input.platform} is at its safe per-minute publishing limit`,
      );
    }
    if (
      input.commandAction === "publish" &&
      dailyPublishCount >= input.manifest.dailyListingCap
    ) {
      throw new ApplicationError(
        409,
        "listing_limit_reached",
        `${input.platform} has reached its configured daily listing cap`,
      );
    }
    const job = PublishingJobSchema.parse({
      id: this.#createId(),
      householdId: input.householdId,
      itemId: input.itemId,
      platform: input.platform,
      listingVersion: input.listingVersion,
      commandAction: input.commandAction,
      idempotencyKey,
      currentState: "DRAFT",
      lastVerifiedState: "DRAFT",
      resumeState: null,
      retryCount: 0,
      maxRetries: 3,
      nextRetryAt: null,
      deviceId: input.deviceId,
      connectorVersion: input.manifest.version,
      platformAppVersion: input.platformAppVersion,
      errorCode: null,
      errorDetail: null,
      commandExpiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
      createdAt: now.toISOString(),
      startedAt: null,
      completedAt: null,
      updatedAt: now.toISOString(),
    });
    const stored = await this.#repository.createPublishingJob(job);
    if (!stored.created) return stored;
    recordPublishingJobQueued(input.manifest, input.commandAction);

    let queued = stored.job;
    for (let count = 0; count < 2; count += 1) {
      const result = transitionPublishingJob(
        queued,
        { type: "advance" },
        now.toISOString(),
      );
      await this.#repository.savePublishingTransition(
        result.job,
        result.transition,
      );
      recordPublishingTransition({
        before: queued,
        after: result.job,
        transition: result.transition,
        appVersion: input.platformAppVersion ?? "server",
      });
      queued = result.job;
    }
    return { job: queued, created: true };
  }

  async #applySuccessfulJob(
    householdId: string,
    job: PublishingJob,
    result: TransitionPublishingJobRequest["result"],
  ): Promise<void> {
    const item = await this.#repository.getItem(householdId, job.itemId);
    if (!item) throw notFound("Item");
    const canonical = await this.#repository.getListing(
      job.itemId,
      job.listingVersion,
    );
    if (!canonical) throw notFound("Listing version");
    const variant = await this.#repository.getPlatformListingVariant(
      job.itemId,
      job.listingVersion,
      job.platform,
    );
    const existing = (
      await this.#repository.listPlatformListings(job.itemId)
    ).find(
      (listing) =>
        listing.platform.toLowerCase() === job.platform.toLowerCase(),
    );
    const now = this.#now().toISOString();
    let status: PlatformListing["status"] = "live";
    if (job.commandAction === "mark_sold") status = "sold";
    if (job.commandAction === "delist") status = "delisted";
    const listing = PlatformListingSchema.parse({
      id: existing?.id ?? this.#createId(),
      itemId: job.itemId,
      platform: job.platform,
      externalListingId:
        result?.externalListingId ?? existing?.externalListingId ?? null,
      externalUrl: result?.externalUrl ?? existing?.externalUrl ?? null,
      platformTitle:
        result?.platformTitle ??
        existing?.platformTitle ??
        variant?.title ??
        canonical.title,
      platformPrice:
        result?.platformPrice ??
        existing?.platformPrice ??
        variant?.price ??
        canonical.askingPrice,
      status,
      publishedAt: existing?.publishedAt ?? now,
      lastSynchronizedAt: now,
      connectorVersion: job.connectorVersion,
    });
    await this.#repository.upsertPlatformListing(listing, householdId);
    if (job.commandAction === "publish") {
      const allListings = await this.#repository.listPlatformListings(
        job.itemId,
      );
      const derived = deriveItemStatus(allListings, item.status);
      if (derived !== item.status) {
        await this.#repository.updateItemStatus(
          householdId,
          job.itemId,
          derived,
          now,
        );
      }
    }
  }

  async #applyMediaAssessments(
    item: StoredItem,
    output: ItemEnrichmentOutput,
  ): Promise<StoredItem> {
    const assessments = new Map(
      output.mediaAssessments.map((assessment) => [
        assessment.mediaAssetId,
        assessment,
      ]),
    );
    const rankedIds = [...item.media]
      .sort((left, right) => {
        const scoreDifference =
          (assessments.get(right.id)?.leadPhotoScore ?? 0) -
          (assessments.get(left.id)?.leadPhotoScore ?? 0);
        return scoreDifference || left.order - right.order;
      })
      .map((asset) => asset.id);
    const orderById = new Map(
      rankedIds.map((assetId, order) => [assetId, order]),
    );
    const media = item.media
      .map((asset) => {
        const assessment = assessments.get(asset.id);
        const preservePrivacyDecision =
          asset.redactionState === "applied" ||
          asset.redactionState === "reviewed_not_needed";
        return {
          ...asset,
          order: orderById.get(asset.id) ?? asset.order,
          isLead: rankedIds[0] === asset.id,
          qualityIssues: assessment
            ? [
                ...new Set([
                  ...asset.qualityIssues,
                  ...assessment.qualityIssues,
                ]),
              ]
            : asset.qualityIssues,
          redactionState:
            assessment?.redactionSuggested && !preservePrivacyDecision
              ? ("suggested" as const)
              : assessment && asset.redactionState === "pending_scan"
                ? ("not_needed" as const)
                : asset.redactionState,
        };
      })
      .sort((left, right) => left.order - right.order);
    const materiallyChanged = media.some((asset, index) => {
      const prior = item.media[index];
      return !prior || JSON.stringify(asset) !== JSON.stringify(prior);
    });
    if (!materiallyChanged) return item;
    return this.#repository.saveItem({
      ...item,
      media,
      updatedAt: this.#now().toISOString(),
    });
  }

  async #isFeatureEnabled(key: string): Promise<boolean> {
    return (await this.#repository.getFeatureFlag(key))?.enabled === true;
  }

  #throwReleaseGate(error: unknown): never {
    if (error instanceof ReleaseGateError) {
      throw new ApplicationError(409, "release_gate_blocked", error.message, {
        blockers: error.blockers,
      });
    }
    throw error;
  }

  async #requireFeature(key: string): Promise<void> {
    const flag = await this.#repository.getFeatureFlag(key);
    if (!flag?.enabled) {
      throw new ApplicationError(
        503,
        "feature_temporarily_disabled",
        "This feature is temporarily unavailable",
        {
          feature: key,
          reason: flag?.killSwitchReason ?? "Feature configuration is missing",
        },
      );
    }
  }

  async #requireMembership(userId: string, householdId: string): Promise<void> {
    if (!(await this.#repository.isHouseholdMember(householdId, userId))) {
      throw forbidden();
    }
  }

  async #audit(
    actorId: string,
    householdId: string | null,
    action: string,
    objectType: string,
    objectId: string,
    redactedMetadata: Record<string, unknown> = {},
    actorType: "user" | "device" | "service" | "admin" = "user",
  ): Promise<void> {
    const event = AuditEventSchema.parse({
      id: this.#createId(),
      actorId,
      actorType,
      action,
      objectType,
      objectId,
      timestamp: this.#now().toISOString(),
      deviceId: null,
      redactedMetadata,
    });
    await this.#repository.createAuditEvent(event, householdId);
  }
}

function itemMediaFingerprint(item: StoredItem): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        item.media
          .map((media) => ({
            id: media.id,
            sha256: media.contentSha256,
            mediaType: media.mediaType,
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      ),
    )
    .digest("hex");
}

function enrichmentInputFingerprint(item: StoredItem): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        item: {
          title: item.title,
          category: item.category,
          brand: item.brand,
          model: item.model,
          condition: item.condition,
          accessories: item.accessories,
          defects: item.defects,
          barcode: item.barcode,
        },
        mediaFingerprint: itemMediaFingerprint(item),
      }),
    )
    .digest("hex");
}

function screenRestrictedListing(
  enrichment: ItemEnrichment,
  textValues: readonly (string | null | undefined)[],
) {
  return combineRestrictedScreens(
    restrictedScreenFromSignals(enrichment.output.restrictedSignals),
    restrictedScreenFromText(textValues),
  );
}

function startOfMonthInTimezone(now: Date, timezone: string): string {
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(local.find((part) => part.type === type)?.value);
  const wallClockUtc = Date.UTC(value("year"), value("month") - 1, 1);
  let instant = wallClockUtc;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const candidate = new Date(instant);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(candidate);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((entry) => entry.type === type)?.value);
    const representedAsUtc = Date.UTC(
      part("year"),
      part("month") - 1,
      part("day"),
      part("hour"),
      part("minute"),
      part("second"),
    );
    instant = wallClockUtc - (representedAsUtc - candidate.getTime());
  }
  return new Date(instant).toISOString();
}

function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function publishingAttentionMessage(
  state: PublishingJob["currentState"],
): string {
  const messages: Partial<Record<PublishingJob["currentState"], string>> = {
    NEEDS_LOGIN:
      "Open the official marketplace app and sign in on your Seller Hub.",
    NEEDS_MFA: "Complete the marketplace security check on your Seller Hub.",
    NEEDS_CAPTCHA:
      "A marketplace challenge is waiting for you; LocalClear will not bypass it.",
    NEEDS_USER_CONFIRMATION:
      "Review the prepared step and explicitly confirm before publishing continues.",
    NEEDS_REQUIRED_FIELD: "The marketplace requires one more listing detail.",
    APP_VERSION_UNSUPPORTED:
      "The marketplace app version is not supported by this connector.",
    PLATFORM_UI_CHANGED:
      "The connector paused because the marketplace screen changed.",
    ITEM_BLOCKED: "A connector or item-policy check blocked this job.",
    LISTING_LIMIT_REACHED:
      "The platform listing limit was reached; try again later.",
    NETWORK_UNAVAILABLE:
      "The publishing connection is offline and will resume safely.",
    DEVICE_OFFLINE:
      "Connect the Seller Hub to power and a network to continue.",
  };
  return messages[state] ?? "Publishing paused and needs your attention.";
}
