import type {
  AuditEvent,
  BackupBuyerEntry,
  BuyerTask,
  Comparable,
  CanonicalListing,
  ConnectorManifest,
  DiagnosticArtifact,
  FeatureFlag,
  Household,
  Item,
  ItemEnrichment,
  ItemStatus,
  Meetup,
  PlatformListing,
  PlatformConnection,
  PlatformListingVariant,
  ProductionRelease,
  PublishingJob,
  PublishingTransition,
  PushSubscription,
  SellerDevice,
  SupportAccessGrant,
  UserNotification,
} from "@localclear/domain";
import type { SignedDeviceCommand } from "@localclear/device-protocol";

export interface StoredItem extends Item {
  barcode: string | null;
  imageFingerprint: string | null;
}

export interface ItemOutcome {
  id: string;
  householdId: string;
  itemId: string;
  outcome: Extract<
    ItemStatus,
    "sold" | "given_away" | "donated" | "recycled" | "discarded"
  >;
  salePriceCents: number | null;
  currency: string | null;
  destinationPlatform: string | null;
  daysToClear: number;
  notes: string | null;
  clearedAt: string;
}

export interface ExceptionTask {
  id: string;
  householdId: string;
  itemId: string | null;
  kind: string;
  title: string;
  details: Record<string, unknown>;
  status: "open" | "resolved" | "dismissed";
  createdAt: string;
  resolvedAt: string | null;
}

export interface JobWithTransitions {
  job: PublishingJob;
  transitions: PublishingTransition[];
}

export interface StoredPairingChallenge {
  id: string;
  householdId: string;
  secretHash: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface IssuedDeviceCommand {
  deviceId: string;
  jobId: string;
  commandNonce: string;
  expiresAt: string;
  signedCommand: SignedDeviceCommand;
}

export interface ConnectorHealthRow {
  platform: string;
  connectorVersion: string;
  appVersion: string;
  currentState: PublishingJob["currentState"];
  errorCode: string | null;
  count: number;
}

export interface RedactedSupportSnapshot {
  devices: Array<{
    id: string;
    displayName: string;
    connectionStatus: SellerDevice["connectionStatus"];
    appVersion: string;
    androidVersion: number;
    batteryPercent: number | null;
    networkType: SellerDevice["networkType"];
    lastCheckInAt: string | null;
  }>;
  jobs: Array<{
    id: string;
    itemId: string;
    platform: string;
    currentState: PublishingJob["currentState"];
    errorCode: string | null;
    connectorVersion: string;
    retryCount: number;
    updatedAt: string;
  }>;
}

export interface HouseholdProgressSummary {
  clearedThisMonth: number;
  recoveredCents: number;
  readyToList: number;
  buyerTasks: number;
  removalTasks: number;
}

export interface AccountExportPayload {
  schemaVersion: 1;
  generatedAt: string;
  profile: Record<string, unknown> | null;
  households: readonly unknown[];
  sellerDevices: readonly unknown[];
  platformConnections: readonly unknown[];
  items: readonly unknown[];
  mediaAssets: readonly unknown[];
  enrichments: readonly unknown[];
  canonicalListings: readonly unknown[];
  platformVariants: readonly unknown[];
  platformListings: readonly unknown[];
  publishingJobs: readonly unknown[];
  publishingTransitions: readonly unknown[];
  buyerTasks: readonly unknown[];
  meetups: readonly unknown[];
  backupBuyers: readonly unknown[];
  notifications: readonly unknown[];
  supportGrants: readonly unknown[];
  diagnosticArtifacts: readonly unknown[];
  listingExportArtifacts: readonly unknown[];
  outcomes: readonly unknown[];
  exceptionTasks: readonly unknown[];
  auditEvents: readonly unknown[];
}

export interface AccountDeletionPreparation {
  requestId: string;
  mediaPaths: string[];
  revokedDeviceCount: number;
  cancelledJobCount: number;
}

export interface AccountDeletionReceipt {
  receiptId: string;
  requestId: string;
  subjectHash: string;
  completedAt: string;
}

export interface EphemeralPurgeResult {
  diagnosticArtifacts: number;
  listingExportArtifacts: number;
  issuedDeviceCommands: number;
  pairingChallenges: number;
  deviceNonces: number;
}

export interface ListingExportArtifact {
  id: string;
  householdId: string;
  itemId: string;
  publishingJobId: string;
  platform: string;
  format: "json";
  payload: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface Repository {
  close(): Promise<void>;

  createHousehold(household: Household, ownerId: string): Promise<Household>;
  saveHousehold(household: Household): Promise<Household>;
  listHouseholds(userId: string): Promise<Household[]>;
  getHousehold(householdId: string): Promise<Household | null>;
  isHouseholdMember(householdId: string, userId: string): Promise<boolean>;
  getHouseholdProgressSummary(
    householdId: string,
    monthStartedAt: string,
  ): Promise<HouseholdProgressSummary>;
  exportAccountData(
    userId: string,
    generatedAt: string,
  ): Promise<AccountExportPayload>;
  beginAccountDeletion(input: {
    requestId: string;
    userId: string;
    subjectHash: string;
    requestedAt: string;
  }): Promise<AccountDeletionPreparation>;
  purgeAccountData(userId: string): Promise<void>;
  completeAccountDeletion(receipt: AccountDeletionReceipt): Promise<void>;

  createSellerDevice(device: SellerDevice): Promise<SellerDevice>;
  getSellerDevice(
    householdId: string,
    deviceId: string,
  ): Promise<SellerDevice | null>;
  listSellerDevices(householdId: string): Promise<SellerDevice[]>;
  saveSellerDevice(device: SellerDevice): Promise<SellerDevice>;
  upsertPlatformConnection(
    connection: PlatformConnection,
    householdId: string,
  ): Promise<PlatformConnection>;
  listPlatformConnections(householdId: string): Promise<PlatformConnection[]>;
  createSellerDeviceCredential(
    deviceId: string,
    tokenHash: string,
    createdAt: string,
  ): Promise<void>;
  authenticateSellerDeviceToken(
    deviceId: string,
    tokenHash: string,
    lastUsedAt: string,
  ): Promise<SellerDevice | null>;
  revokeSellerDeviceCredential(
    deviceId: string,
    revokedAt: string,
  ): Promise<void>;
  consumeDeviceNonce(
    deviceId: string,
    nonce: string,
    expiresAt: string,
    consumedAt: string,
  ): Promise<boolean>;
  listPendingDeviceJobs(
    deviceId: string,
    limit: number,
  ): Promise<PublishingJob[]>;
  getActiveIssuedDeviceCommand(
    deviceId: string,
    jobId: string,
    now: string,
  ): Promise<IssuedDeviceCommand | null>;
  createIssuedDeviceCommand(command: IssuedDeviceCommand): Promise<void>;
  isIssuedDeviceCommandActive(
    deviceId: string,
    jobId: string,
    commandNonce: string,
    now: string,
  ): Promise<boolean>;
  createPairingChallenge(challenge: StoredPairingChallenge): Promise<void>;
  getPairingChallenge(
    challengeId: string,
  ): Promise<StoredPairingChallenge | null>;
  consumePairingChallenge(
    challengeId: string,
    consumedAt: string,
  ): Promise<boolean>;

  createItem(item: StoredItem): Promise<StoredItem>;
  createItems(items: readonly StoredItem[]): Promise<StoredItem[]>;
  saveItem(item: StoredItem): Promise<StoredItem>;
  getItem(householdId: string, itemId: string): Promise<StoredItem | null>;
  listItems(householdId: string): Promise<StoredItem[]>;
  updateItemStatus(
    householdId: string,
    itemId: string,
    status: ItemStatus,
    now: string,
  ): Promise<StoredItem>;
  deleteItem(householdId: string, itemId: string): Promise<boolean>;
  createItemEnrichment(enrichment: ItemEnrichment): Promise<ItemEnrichment>;
  getItemEnrichmentByFingerprint(
    householdId: string,
    itemId: string,
    inputFingerprint: string,
    provider: string,
    model: string,
  ): Promise<ItemEnrichment | null>;
  getLatestItemEnrichment(
    householdId: string,
    itemId: string,
    mediaFingerprint?: string,
  ): Promise<ItemEnrichment | null>;

  createListing(
    listing: CanonicalListing,
    householdId: string,
  ): Promise<CanonicalListing>;
  getListing(itemId: string, version: number): Promise<CanonicalListing | null>;
  getLatestListing(itemId: string): Promise<CanonicalListing | null>;
  listOutcomeComparables(input: {
    category: string;
    brand: string | null;
    model: string | null;
    limit: number;
  }): Promise<Comparable[]>;
  upsertPlatformListingVariant(
    variant: PlatformListingVariant,
  ): Promise<PlatformListingVariant>;
  getPlatformListingVariant(
    itemId: string,
    listingVersion: number,
    platform: string,
  ): Promise<PlatformListingVariant | null>;

  upsertConnector(manifest: ConnectorManifest): Promise<ConnectorManifest>;
  getConnectorById(connectorId: string): Promise<ConnectorManifest | null>;
  getConnector(platform: string): Promise<ConnectorManifest | null>;
  listConnectors(): Promise<ConnectorManifest[]>;
  listConnectorHealthRows(since: string): Promise<ConnectorHealthRow[]>;
  countRecentAuditEvents(action: string, since: string): Promise<number>;
  upsertFeatureFlag(flag: FeatureFlag): Promise<FeatureFlag>;
  getFeatureFlag(key: string): Promise<FeatureFlag | null>;
  listFeatureFlags(): Promise<FeatureFlag[]>;
  createProductionRelease(
    release: ProductionRelease,
  ): Promise<ProductionRelease>;
  getProductionRelease(releaseId: string): Promise<ProductionRelease | null>;
  listProductionReleases(limit: number): Promise<ProductionRelease[]>;
  saveProductionRelease(release: ProductionRelease): Promise<ProductionRelease>;

  createPublishingJob(
    job: PublishingJob,
  ): Promise<{ job: PublishingJob; created: boolean }>;
  getPublishingJobByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<PublishingJob | null>;
  countPublishingJobs(
    householdId: string,
    platform: string,
    since: string,
    commandAction?: PublishingJob["commandAction"],
  ): Promise<number>;
  claimRunnableServerJobs(input: {
    workerId: string;
    now: string;
    leaseExpiresAt: string;
    limit: number;
  }): Promise<PublishingJob[]>;
  releasePublishingJobLease(jobId: string, workerId: string): Promise<void>;
  getPublishingJob(
    householdId: string,
    jobId: string,
  ): Promise<JobWithTransitions | null>;
  savePublishingTransition(
    job: PublishingJob,
    transition: PublishingTransition,
  ): Promise<void>;
  upsertListingExportArtifact(
    artifact: ListingExportArtifact,
  ): Promise<ListingExportArtifact>;
  getListingExportArtifact(
    householdId: string,
    publishingJobId: string,
  ): Promise<ListingExportArtifact | null>;
  consumeListingExportArtifact(
    householdId: string,
    publishingJobId: string,
    consumedAt: string,
  ): Promise<boolean>;

  listPlatformListings(itemId: string): Promise<PlatformListing[]>;
  getPlatformListing(
    householdId: string,
    platformListingId: string,
  ): Promise<PlatformListing | null>;
  upsertPlatformListing(
    listing: PlatformListing,
    householdId: string,
  ): Promise<PlatformListing>;

  createOutcome(outcome: ItemOutcome): Promise<ItemOutcome>;
  createExceptionTask(task: ExceptionTask): Promise<ExceptionTask>;
  listExceptionTasks(householdId: string): Promise<ExceptionTask[]>;

  createBuyerTask(task: BuyerTask, householdId: string): Promise<BuyerTask>;
  getBuyerTask(householdId: string, taskId: string): Promise<BuyerTask | null>;
  saveBuyerTask(task: BuyerTask, householdId: string): Promise<BuyerTask>;
  listBuyerTasks(householdId: string): Promise<BuyerTask[]>;
  createMeetup(meetup: Meetup, householdId: string): Promise<Meetup>;
  listMeetups(householdId: string): Promise<Meetup[]>;
  saveMeetup(meetup: Meetup, householdId: string): Promise<Meetup>;
  enqueueBackupBuyer(entry: BackupBuyerEntry): Promise<BackupBuyerEntry>;
  listBackupBuyers(
    householdId: string,
    itemId: string,
  ): Promise<BackupBuyerEntry[]>;
  saveBackupBuyer(entry: BackupBuyerEntry): Promise<BackupBuyerEntry>;

  createNotification(notification: UserNotification): Promise<UserNotification>;
  listNotifications(
    userId: string,
    householdId: string,
  ): Promise<UserNotification[]>;
  markNotificationRead(
    userId: string,
    notificationId: string,
    readAt: string,
  ): Promise<UserNotification | null>;
  upsertPushSubscription(
    subscription: PushSubscription,
  ): Promise<PushSubscription>;
  listPushSubscriptions(userId: string): Promise<PushSubscription[]>;
  claimQueuedNotifications(input: {
    workerId: string;
    now: string;
    leaseExpiresAt: string;
    limit: number;
  }): Promise<UserNotification[]>;
  completeNotificationDelivery(input: {
    notificationId: string;
    workerId: string;
    state: UserNotification["deliveryState"];
    providerTicketIds: string[];
    nextDeliveryAt: string;
  }): Promise<void>;

  createSupportGrant(grant: SupportAccessGrant): Promise<SupportAccessGrant>;
  getSupportGrant(grantId: string): Promise<SupportAccessGrant | null>;
  listSupportGrants(householdId: string): Promise<SupportAccessGrant[]>;
  listActiveSupportGrantsForActor(
    actorId: string,
    now: string,
  ): Promise<SupportAccessGrant[]>;
  revokeSupportGrant(
    householdId: string,
    grantId: string,
    revokedAt: string,
  ): Promise<SupportAccessGrant | null>;
  createDiagnosticArtifact(
    artifact: DiagnosticArtifact,
  ): Promise<DiagnosticArtifact>;
  listDiagnosticArtifacts(grantId: string): Promise<DiagnosticArtifact[]>;
  listExpiredDiagnosticArtifacts(now: string): Promise<DiagnosticArtifact[]>;
  purgeExpiredEphemeralData(
    now: string,
    diagnosticArtifactIds: readonly string[],
  ): Promise<EphemeralPurgeResult>;
  getRedactedSupportSnapshot(
    householdId: string,
  ): Promise<RedactedSupportSnapshot>;

  createAuditEvent(
    event: AuditEvent,
    householdId: string | null,
  ): Promise<void>;
}
