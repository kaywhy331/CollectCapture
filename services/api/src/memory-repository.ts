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
  ItemEnrichment,
  ItemStatus,
  Meetup,
  PlatformConnection,
  PlatformListing,
  PlatformListingVariant,
  ProductionRelease,
  PublishingJob,
  PublishingTransition,
  PushSubscription,
  SellerDevice,
  SupportAccessGrant,
  UserNotification,
} from "@localclear/domain";
import type {
  ExceptionTask,
  AccountDeletionPreparation,
  AccountDeletionReceipt,
  AccountExportPayload,
  ListingExportArtifact,
  EphemeralPurgeResult,
  ConnectorHealthRow,
  ItemOutcome,
  JobWithTransitions,
  IssuedDeviceCommand,
  HouseholdProgressSummary,
  Repository,
  RedactedSupportSnapshot,
  StoredPairingChallenge,
  StoredItem,
} from "./repository.js";

export class MemoryRepository implements Repository {
  readonly #households = new Map<string, Household>();
  readonly #members = new Map<string, Set<string>>();
  readonly #devices = new Map<string, SellerDevice>();
  readonly #platformConnections = new Map<string, PlatformConnection>();
  readonly #deviceCredentials = new Map<
    string,
    { tokenHash: string; revokedAt: string | null }
  >();
  readonly #deviceNonces = new Map<string, string>();
  readonly #issuedDeviceCommands = new Map<string, IssuedDeviceCommand>();
  readonly #pairingChallenges = new Map<string, StoredPairingChallenge>();
  readonly #items = new Map<string, StoredItem>();
  readonly #itemEnrichments = new Map<string, ItemEnrichment>();
  readonly #listings = new Map<string, CanonicalListing[]>();
  readonly #platformVariants = new Map<string, PlatformListingVariant>();
  readonly #connectors = new Map<string, ConnectorManifest>();
  readonly #featureFlags = new Map<string, FeatureFlag>();
  readonly #productionReleases = new Map<string, ProductionRelease>();
  readonly #jobs = new Map<string, PublishingJob>();
  readonly #jobByIdempotencyKey = new Map<string, string>();
  readonly #transitions = new Map<string, PublishingTransition[]>();
  readonly #jobLeases = new Map<
    string,
    { workerId: string; expiresAt: string }
  >();
  readonly #exportArtifacts = new Map<string, ListingExportArtifact>();
  readonly #platformListings = new Map<string, PlatformListing>();
  readonly #outcomes = new Map<string, ItemOutcome>();
  readonly #exceptionTasks = new Map<string, ExceptionTask>();
  readonly #buyerTasks = new Map<string, BuyerTask>();
  readonly #meetups = new Map<string, Meetup>();
  readonly #backupBuyers = new Map<string, BackupBuyerEntry>();
  readonly #notifications = new Map<string, UserNotification>();
  readonly #pushSubscriptions = new Map<string, PushSubscription>();
  readonly #supportGrants = new Map<string, SupportAccessGrant>();
  readonly #diagnosticArtifacts = new Map<string, DiagnosticArtifact>();
  readonly #notificationLeases = new Map<
    string,
    { workerId: string; expiresAt: string }
  >();
  readonly #audits: Array<{ event: AuditEvent; householdId: string | null }> =
    [];
  readonly #deletionRequests = new Map<
    string,
    { userId: string | null; subjectHash: string; status: string }
  >();
  readonly #deletionReceipts = new Map<string, AccountDeletionReceipt>();

  async close(): Promise<void> {}

  async createHousehold(
    household: Household,
    ownerId: string,
  ): Promise<Household> {
    if (this.#households.has(household.id))
      throw new Error("Household already exists");
    this.#households.set(household.id, structuredClone(household));
    this.#members.set(household.id, new Set([ownerId]));
    return structuredClone(household);
  }

  async saveHousehold(household: Household): Promise<Household> {
    if (!this.#households.has(household.id)) {
      throw new Error("Household not found");
    }
    this.#households.set(household.id, structuredClone(household));
    return structuredClone(household);
  }

  async listHouseholds(userId: string): Promise<Household[]> {
    return [...this.#households.values()]
      .filter((household) => this.#members.get(household.id)?.has(userId))
      .map((household) => structuredClone(household));
  }

  async getHousehold(householdId: string): Promise<Household | null> {
    const household = this.#households.get(householdId);
    return household ? structuredClone(household) : null;
  }

  async isHouseholdMember(
    householdId: string,
    userId: string,
  ): Promise<boolean> {
    return this.#members.get(householdId)?.has(userId) ?? false;
  }

  async getHouseholdProgressSummary(
    householdId: string,
    monthStartedAt: string,
  ): Promise<HouseholdProgressSummary> {
    const items = await this.listItems(householdId);
    const itemIds = new Set(items.map((item) => item.id));
    const listingIds = new Set(
      [...this.#platformListings.values()]
        .filter((listing) => itemIds.has(listing.itemId))
        .map((listing) => listing.id),
    );
    const outcomes = [...this.#outcomes.values()].filter(
      (outcome) =>
        itemIds.has(outcome.itemId) && outcome.clearedAt >= monthStartedAt,
    );
    return {
      clearedThisMonth: outcomes.length,
      recoveredCents: outcomes.reduce(
        (sum, outcome) => sum + (outcome.salePriceCents ?? 0),
        0,
      ),
      readyToList: items.filter((item) => item.status === "ready").length,
      buyerTasks: [...this.#buyerTasks.values()].filter(
        (task) =>
          listingIds.has(task.platformListingId) &&
          ["pending", "approved"].includes(task.approvalState),
      ).length,
      removalTasks: [...this.#exceptionTasks.values()].filter(
        (task) =>
          task.householdId === householdId &&
          task.status === "open" &&
          ["inventory_closure", "inventory_archive"].includes(task.kind),
      ).length,
    };
  }

  async exportAccountData(
    userId: string,
    generatedAt: string,
  ): Promise<AccountExportPayload> {
    const householdIds = new Set(
      [...this.#households.values()]
        .filter((household) => this.#members.get(household.id)?.has(userId))
        .map((household) => household.id),
    );
    const items = [...this.#items.values()].filter((item) =>
      householdIds.has(item.householdId),
    );
    const itemIds = new Set(items.map((item) => item.id));
    const platformListings = [...this.#platformListings.values()].filter(
      (listing) => itemIds.has(listing.itemId),
    );
    const platformListingIds = new Set(
      platformListings.map((value) => value.id),
    );
    const jobs = [...this.#jobs.values()].filter((job) =>
      householdIds.has(job.householdId),
    );
    return structuredClone({
      schemaVersion: 1 as const,
      generatedAt,
      profile: { id: userId },
      households: [...this.#households.values()].filter((value) =>
        householdIds.has(value.id),
      ),
      sellerDevices: [...this.#devices.values()].filter((value) =>
        householdIds.has(value.householdId),
      ),
      platformConnections: [...this.#platformConnections.entries()]
        .filter(([key]) =>
          [...householdIds].some((id) => key.startsWith(`${id}:`)),
        )
        .map(([, value]) => value),
      items,
      mediaAssets: items.flatMap((item) => item.media),
      enrichments: [...this.#itemEnrichments.values()].filter((value) =>
        itemIds.has(value.itemId),
      ),
      canonicalListings: [...this.#listings.entries()]
        .filter(([itemId]) => itemIds.has(itemId))
        .flatMap(([, values]) => values),
      platformVariants: [...this.#platformVariants.values()].filter((value) =>
        itemIds.has(value.itemId),
      ),
      platformListings,
      publishingJobs: jobs,
      publishingTransitions: jobs.flatMap(
        (job) => this.#transitions.get(job.id) ?? [],
      ),
      buyerTasks: [...this.#buyerTasks.values()].filter((value) =>
        platformListingIds.has(value.platformListingId),
      ),
      meetups: [...this.#meetups.values()].filter((value) =>
        itemIds.has(value.itemId),
      ),
      backupBuyers: [...this.#backupBuyers.values()].filter((value) =>
        householdIds.has(value.householdId),
      ),
      notifications: [...this.#notifications.values()].filter(
        (value) =>
          value.userId === userId && householdIds.has(value.householdId),
      ),
      supportGrants: [...this.#supportGrants.values()].filter(
        (value) =>
          value.grantedBy === userId && householdIds.has(value.householdId),
      ),
      diagnosticArtifacts: [...this.#diagnosticArtifacts.values()].filter(
        (value) =>
          value.submittedBy === userId && householdIds.has(value.householdId),
      ),
      listingExportArtifacts: [...this.#exportArtifacts.values()].filter(
        (value) => householdIds.has(value.householdId),
      ),
      outcomes: [...this.#outcomes.values()].filter((value) =>
        itemIds.has(value.itemId),
      ),
      exceptionTasks: [...this.#exceptionTasks.values()].filter((value) =>
        householdIds.has(value.householdId),
      ),
      auditEvents: this.#audits
        .filter(
          (value) => value.householdId && householdIds.has(value.householdId),
        )
        .map((value) => value.event),
    });
  }

  async beginAccountDeletion(input: {
    requestId: string;
    userId: string;
    subjectHash: string;
    requestedAt: string;
  }): Promise<AccountDeletionPreparation> {
    const existing = [...this.#deletionRequests.entries()].find(
      ([, value]) => value.userId === input.userId && value.status !== "failed",
    );
    const requestId = existing?.[0] ?? input.requestId;
    const householdIds = new Set(
      [...this.#households.values()]
        .filter((value) => value.ownerId === input.userId)
        .map((value) => value.id),
    );
    const items = [...this.#items.values()].filter((value) =>
      householdIds.has(value.householdId),
    );
    const now = input.requestedAt;
    let revokedDeviceCount = 0;
    for (const [id, device] of this.#devices) {
      if (!householdIds.has(device.householdId) || device.revokedAt) continue;
      this.#devices.set(id, {
        ...device,
        isPrimary: false,
        connectionStatus: "revoked",
        revokedAt: now,
      });
      const credential = this.#deviceCredentials.get(id);
      if (credential) {
        this.#deviceCredentials.set(id, { ...credential, revokedAt: now });
      }
      revokedDeviceCount += 1;
    }
    let cancelledJobCount = 0;
    for (const [id, job] of this.#jobs) {
      if (
        !householdIds.has(job.householdId) ||
        ["PUBLISHED", "FAILED_FINAL", "CANCELLED"].includes(job.currentState)
      ) {
        continue;
      }
      this.#jobs.set(id, {
        ...job,
        currentState: "CANCELLED",
        errorCode: "ACCOUNT_DELETION",
        completedAt: now,
        updatedAt: now,
      });
      this.#transitions.set(id, [
        ...(this.#transitions.get(id) ?? []),
        {
          from: job.currentState,
          to: "CANCELLED",
          event: "cancel",
          occurredAt: now,
          reasonCode: "ACCOUNT_DELETION",
        },
      ]);
      cancelledJobCount += 1;
    }
    this.#deletionRequests.set(requestId, {
      userId: input.userId,
      subjectHash: input.subjectHash,
      status: "revoking",
    });
    return {
      requestId,
      mediaPaths: [
        ...items.flatMap((item) =>
          item.media.map((asset) => asset.storagePath),
        ),
        ...[...this.#diagnosticArtifacts.values()]
          .filter((value) => householdIds.has(value.householdId))
          .map((value) => value.storagePath),
      ],
      revokedDeviceCount,
      cancelledJobCount,
    };
  }

  async purgeAccountData(userId: string): Promise<void> {
    const owned = [...this.#households.values()]
      .filter((value) => value.ownerId === userId)
      .map((value) => value.id);
    for (const householdId of owned) await this.#purgeHousehold(householdId);
    for (const members of this.#members.values()) members.delete(userId);
    this.#pushSubscriptions.forEach((value, key) => {
      if (value.userId === userId) this.#pushSubscriptions.delete(key);
    });
    this.#notifications.forEach((value, key) => {
      if (value.userId === userId) this.#notifications.delete(key);
    });
  }

  async completeAccountDeletion(
    receipt: AccountDeletionReceipt,
  ): Promise<void> {
    const request = this.#deletionRequests.get(receipt.requestId);
    if (request) {
      this.#deletionRequests.set(receipt.requestId, {
        ...request,
        userId: null,
        status: "complete",
      });
    }
    this.#deletionReceipts.set(receipt.receiptId, structuredClone(receipt));
  }

  async createSellerDevice(device: SellerDevice): Promise<SellerDevice> {
    if (this.#devices.has(device.id))
      throw new Error("Seller device already exists");
    if (
      device.isPrimary &&
      [...this.#devices.values()].some(
        (value) =>
          value.householdId === device.householdId &&
          value.isPrimary &&
          !value.revokedAt,
      )
    ) {
      throw new Error("Household already has a primary Seller Hub");
    }
    this.#devices.set(device.id, structuredClone(device));
    return structuredClone(device);
  }

  async getSellerDevice(
    householdId: string,
    deviceId: string,
  ): Promise<SellerDevice | null> {
    const device = this.#devices.get(deviceId);
    return device?.householdId === householdId ? structuredClone(device) : null;
  }

  async listSellerDevices(householdId: string): Promise<SellerDevice[]> {
    return [...this.#devices.values()]
      .filter((device) => device.householdId === householdId)
      .map((device) => structuredClone(device));
  }

  async saveSellerDevice(device: SellerDevice): Promise<SellerDevice> {
    if (!this.#devices.has(device.id))
      throw new Error("Seller device not found");
    this.#devices.set(device.id, structuredClone(device));
    return structuredClone(device);
  }

  async upsertPlatformConnection(
    connection: PlatformConnection,
    householdId: string,
  ): Promise<PlatformConnection> {
    if (!this.#households.has(householdId))
      throw new Error("Household not found");
    const key = `${householdId}:${connection.platform.toLowerCase()}`;
    this.#platformConnections.set(key, structuredClone(connection));
    return structuredClone(connection);
  }

  async listPlatformConnections(
    householdId: string,
  ): Promise<PlatformConnection[]> {
    return [...this.#platformConnections.entries()]
      .filter(([key]) => key.startsWith(`${householdId}:`))
      .map(([, value]) => structuredClone(value));
  }

  async createSellerDeviceCredential(
    deviceId: string,
    tokenHash: string,
    _createdAt: string,
  ): Promise<void> {
    if (!this.#devices.has(deviceId))
      throw new Error("Seller device not found");
    this.#deviceCredentials.set(deviceId, { tokenHash, revokedAt: null });
  }

  async authenticateSellerDeviceToken(
    deviceId: string,
    tokenHash: string,
    _lastUsedAt: string,
  ): Promise<SellerDevice | null> {
    const credential = this.#deviceCredentials.get(deviceId);
    const device = this.#devices.get(deviceId);
    if (
      !credential ||
      credential.revokedAt ||
      credential.tokenHash !== tokenHash ||
      !device ||
      device.revokedAt
    ) {
      return null;
    }
    return structuredClone(device);
  }

  async revokeSellerDeviceCredential(
    deviceId: string,
    revokedAt: string,
  ): Promise<void> {
    const credential = this.#deviceCredentials.get(deviceId);
    if (credential) {
      this.#deviceCredentials.set(deviceId, { ...credential, revokedAt });
    }
  }

  async consumeDeviceNonce(
    deviceId: string,
    nonce: string,
    expiresAt: string,
    consumedAt: string,
  ): Promise<boolean> {
    for (const [key, expiry] of this.#deviceNonces) {
      if (expiry <= consumedAt) this.#deviceNonces.delete(key);
    }
    const key = `${deviceId}:${nonce}`;
    if (this.#deviceNonces.has(key)) return false;
    this.#deviceNonces.set(key, expiresAt);
    return true;
  }

  async listPendingDeviceJobs(
    deviceId: string,
    limit: number,
  ): Promise<PublishingJob[]> {
    return [...this.#jobs.values()]
      .filter(
        (job) =>
          job.deviceId === deviceId &&
          !["PUBLISHED", "FAILED_FINAL", "CANCELLED"].includes(
            job.currentState,
          ),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, limit)
      .map((job) => structuredClone(job));
  }

  async getActiveIssuedDeviceCommand(
    deviceId: string,
    jobId: string,
    now: string,
  ): Promise<IssuedDeviceCommand | null> {
    const value = this.#issuedDeviceCommands.get(`${deviceId}:${jobId}`);
    return value && value.expiresAt > now ? structuredClone(value) : null;
  }

  async createIssuedDeviceCommand(command: IssuedDeviceCommand): Promise<void> {
    this.#issuedDeviceCommands.set(
      `${command.deviceId}:${command.jobId}`,
      structuredClone(command),
    );
  }

  async isIssuedDeviceCommandActive(
    deviceId: string,
    jobId: string,
    commandNonce: string,
    now: string,
  ): Promise<boolean> {
    const value = await this.getActiveIssuedDeviceCommand(deviceId, jobId, now);
    return value?.commandNonce === commandNonce;
  }

  async createPairingChallenge(
    challenge: StoredPairingChallenge,
  ): Promise<void> {
    if (this.#pairingChallenges.has(challenge.id)) {
      throw new Error("Pairing challenge already exists");
    }
    this.#pairingChallenges.set(challenge.id, structuredClone(challenge));
  }

  async getPairingChallenge(
    challengeId: string,
  ): Promise<StoredPairingChallenge | null> {
    const challenge = this.#pairingChallenges.get(challengeId);
    return challenge ? structuredClone(challenge) : null;
  }

  async consumePairingChallenge(
    challengeId: string,
    consumedAt: string,
  ): Promise<boolean> {
    const challenge = this.#pairingChallenges.get(challengeId);
    if (!challenge || challenge.consumedAt) return false;
    this.#pairingChallenges.set(challengeId, { ...challenge, consumedAt });
    return true;
  }

  async createItem(item: StoredItem): Promise<StoredItem> {
    if (this.#items.has(item.id)) throw new Error("Item already exists");
    this.#items.set(item.id, structuredClone(item));
    return structuredClone(item);
  }

  async createItems(items: readonly StoredItem[]): Promise<StoredItem[]> {
    const ids = new Set(items.map((item) => item.id));
    if (
      ids.size !== items.length ||
      items.some((item) => this.#items.has(item.id))
    ) {
      throw new Error("Batch contains an existing or duplicate item ID");
    }
    for (const item of items) {
      this.#items.set(item.id, structuredClone(item));
    }
    return items.map((item) => structuredClone(item));
  }

  async saveItem(item: StoredItem): Promise<StoredItem> {
    if (!this.#items.has(item.id)) throw new Error("Item not found");
    this.#items.set(item.id, structuredClone(item));
    return structuredClone(item);
  }

  async getItem(
    householdId: string,
    itemId: string,
  ): Promise<StoredItem | null> {
    const item = this.#items.get(itemId);
    return item?.householdId === householdId ? structuredClone(item) : null;
  }

  async listItems(householdId: string): Promise<StoredItem[]> {
    return [...this.#items.values()]
      .filter((item) => item.householdId === householdId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((item) => structuredClone(item));
  }

  async updateItemStatus(
    householdId: string,
    itemId: string,
    status: ItemStatus,
    now: string,
  ): Promise<StoredItem> {
    const item = await this.getItem(householdId, itemId);
    if (!item) throw new Error("Item not found");
    const updated = { ...item, status, updatedAt: now };
    this.#items.set(itemId, structuredClone(updated));
    return updated;
  }

  async deleteItem(householdId: string, itemId: string): Promise<boolean> {
    const item = await this.getItem(householdId, itemId);
    if (!item) return false;
    this.#items.delete(itemId);
    this.#itemEnrichments.forEach((value, key) => {
      if (value.itemId === itemId) this.#itemEnrichments.delete(key);
    });
    this.#listings.delete(itemId);
    this.#platformVariants.forEach((value, key) => {
      if (value.itemId === itemId) this.#platformVariants.delete(key);
    });
    const platformIds = new Set<string>();
    this.#platformListings.forEach((value, key) => {
      if (value.itemId === itemId) {
        platformIds.add(value.id);
        this.#platformListings.delete(key);
      }
    });
    this.#buyerTasks.forEach((value, key) => {
      if (platformIds.has(value.platformListingId))
        this.#buyerTasks.delete(key);
    });
    this.#meetups.forEach((value, key) => {
      if (value.itemId === itemId) this.#meetups.delete(key);
    });
    this.#backupBuyers.forEach((value, key) => {
      if (value.itemId === itemId) this.#backupBuyers.delete(key);
    });
    this.#jobs.forEach((value, key) => {
      if (value.itemId === itemId) {
        this.#jobs.delete(key);
        this.#jobByIdempotencyKey.delete(value.idempotencyKey);
        this.#transitions.delete(key);
        this.#jobLeases.delete(key);
      }
    });
    this.#exportArtifacts.forEach((value, key) => {
      if (value.itemId === itemId) this.#exportArtifacts.delete(key);
    });
    this.#outcomes.delete(itemId);
    this.#exceptionTasks.forEach((value, key) => {
      if (value.itemId === itemId) this.#exceptionTasks.delete(key);
    });
    return true;
  }

  async createItemEnrichment(
    enrichment: ItemEnrichment,
  ): Promise<ItemEnrichment> {
    const existing = await this.getItemEnrichmentByFingerprint(
      enrichment.householdId,
      enrichment.itemId,
      enrichment.inputFingerprint,
      enrichment.provider,
      enrichment.model,
    );
    if (existing) return existing;
    this.#itemEnrichments.set(enrichment.id, structuredClone(enrichment));
    return structuredClone(enrichment);
  }

  async getItemEnrichmentByFingerprint(
    householdId: string,
    itemId: string,
    inputFingerprint: string,
    provider: string,
    model: string,
  ): Promise<ItemEnrichment | null> {
    const enrichment = [...this.#itemEnrichments.values()].find(
      (value) =>
        value.householdId === householdId &&
        value.itemId === itemId &&
        value.inputFingerprint === inputFingerprint &&
        value.provider === provider &&
        value.model === model,
    );
    return enrichment ? structuredClone(enrichment) : null;
  }

  async getLatestItemEnrichment(
    householdId: string,
    itemId: string,
  ): Promise<ItemEnrichment | null> {
    const enrichment = [...this.#itemEnrichments.values()]
      .filter(
        (value) => value.householdId === householdId && value.itemId === itemId,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    return enrichment ? structuredClone(enrichment) : null;
  }

  async createListing(
    listing: CanonicalListing,
    householdId: string,
  ): Promise<CanonicalListing> {
    const item = await this.getItem(householdId, listing.itemId);
    if (!item) throw new Error("Item not found");
    const versions = this.#listings.get(listing.itemId) ?? [];
    if (versions.some((value) => value.version === listing.version)) {
      throw new Error("Listing version already exists");
    }
    versions.push(structuredClone(listing));
    this.#listings.set(listing.itemId, versions);
    return structuredClone(listing);
  }

  async getListing(
    itemId: string,
    version: number,
  ): Promise<CanonicalListing | null> {
    const listing = this.#listings
      .get(itemId)
      ?.find((value) => value.version === version);
    return listing ? structuredClone(listing) : null;
  }

  async getLatestListing(itemId: string): Promise<CanonicalListing | null> {
    const versions = this.#listings.get(itemId) ?? [];
    const listing = [...versions].sort(
      (left, right) => right.version - left.version,
    )[0];
    return listing ? structuredClone(listing) : null;
  }

  async listOutcomeComparables(input: {
    category: string;
    brand: string | null;
    model: string | null;
    limit: number;
  }): Promise<Comparable[]> {
    return [...this.#outcomes.values()]
      .flatMap((outcome) => {
        const item = this.#items.get(outcome.itemId);
        if (
          !item ||
          outcome.outcome !== "sold" ||
          outcome.salePriceCents === null ||
          !outcome.currency ||
          item.category.toLowerCase() !== input.category.toLowerCase()
        ) {
          return [];
        }
        if (
          input.brand &&
          item.brand &&
          item.brand.toLowerCase() !== input.brand.toLowerCase()
        ) {
          return [];
        }
        if (
          input.model &&
          item.model &&
          item.model.toLowerCase() !== input.model.toLowerCase()
        ) {
          return [];
        }
        return [
          {
            id: `outcome-${outcome.id}`,
            amount: {
              amountCents: outcome.salePriceCents,
              currency: outcome.currency,
            },
            outcomeType: "verified_sold" as const,
            sourceName: "LocalClear verified outcome",
            sourceApproval: "approved" as const,
            observedAt: outcome.clearedAt,
          },
        ];
      })
      .slice(0, input.limit);
  }

  async upsertPlatformListingVariant(
    variant: PlatformListingVariant,
  ): Promise<PlatformListingVariant> {
    const key = `${variant.itemId}:${variant.listingVersion}:${variant.platform.toLowerCase()}`;
    this.#platformVariants.set(key, structuredClone(variant));
    return structuredClone(variant);
  }

  async getPlatformListingVariant(
    itemId: string,
    listingVersion: number,
    platform: string,
  ): Promise<PlatformListingVariant | null> {
    const value = this.#platformVariants.get(
      `${itemId}:${listingVersion}:${platform.toLowerCase()}`,
    );
    return value ? structuredClone(value) : null;
  }

  async upsertConnector(
    manifest: ConnectorManifest,
  ): Promise<ConnectorManifest> {
    this.#connectors.set(
      manifest.platform.toLowerCase(),
      structuredClone(manifest),
    );
    return structuredClone(manifest);
  }

  async getConnector(platform: string): Promise<ConnectorManifest | null> {
    const manifest = this.#connectors.get(platform.toLowerCase());
    return manifest ? structuredClone(manifest) : null;
  }

  async getConnectorById(
    connectorId: string,
  ): Promise<ConnectorManifest | null> {
    const manifest = [...this.#connectors.values()].find(
      (value) => value.id === connectorId,
    );
    return manifest ? structuredClone(manifest) : null;
  }

  async listConnectors(): Promise<ConnectorManifest[]> {
    return [...this.#connectors.values()].map((value) =>
      structuredClone(value),
    );
  }

  async listConnectorHealthRows(since: string): Promise<ConnectorHealthRow[]> {
    const groups = new Map<string, ConnectorHealthRow>();
    for (const job of this.#jobs.values()) {
      if (job.createdAt < since) continue;
      const appVersion = job.platformAppVersion ?? "server";
      const key = [
        job.platform,
        job.connectorVersion,
        appVersion,
        job.currentState,
        job.errorCode ?? "",
      ].join("|");
      const existing = groups.get(key);
      groups.set(key, {
        platform: job.platform,
        connectorVersion: job.connectorVersion,
        appVersion,
        currentState: job.currentState,
        errorCode: job.errorCode,
        count: (existing?.count ?? 0) + 1,
      });
    }
    return [...groups.values()].map((row) => structuredClone(row));
  }

  async countRecentAuditEvents(action: string, since: string): Promise<number> {
    return this.#audits.filter(
      ({ event }) => event.action === action && event.timestamp >= since,
    ).length;
  }

  async upsertFeatureFlag(flag: FeatureFlag): Promise<FeatureFlag> {
    this.#featureFlags.set(flag.key, structuredClone(flag));
    return structuredClone(flag);
  }

  async getFeatureFlag(key: string): Promise<FeatureFlag | null> {
    const value = this.#featureFlags.get(key);
    return value ? structuredClone(value) : null;
  }

  async listFeatureFlags(): Promise<FeatureFlag[]> {
    return [...this.#featureFlags.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((value) => structuredClone(value));
  }

  async createProductionRelease(
    release: ProductionRelease,
  ): Promise<ProductionRelease> {
    if (
      this.#productionReleases.has(release.id) ||
      [...this.#productionReleases.values()].some(
        (value) => value.version === release.version,
      )
    ) {
      throw new Error("Production release already exists");
    }
    this.#productionReleases.set(release.id, structuredClone(release));
    return structuredClone(release);
  }

  async getProductionRelease(
    releaseId: string,
  ): Promise<ProductionRelease | null> {
    const release = this.#productionReleases.get(releaseId);
    return release ? structuredClone(release) : null;
  }

  async listProductionReleases(limit: number): Promise<ProductionRelease[]> {
    return [...this.#productionReleases.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
      .map((release) => structuredClone(release));
  }

  async saveProductionRelease(
    release: ProductionRelease,
  ): Promise<ProductionRelease> {
    if (!this.#productionReleases.has(release.id)) {
      throw new Error("Production release not found");
    }
    this.#productionReleases.set(release.id, structuredClone(release));
    return structuredClone(release);
  }

  async createPublishingJob(
    job: PublishingJob,
  ): Promise<{ job: PublishingJob; created: boolean }> {
    const existingId = this.#jobByIdempotencyKey.get(job.idempotencyKey);
    if (existingId) {
      const existing = this.#jobs.get(existingId);
      if (!existing) throw new Error("Idempotency index is corrupt");
      return { job: structuredClone(existing), created: false };
    }
    this.#jobs.set(job.id, structuredClone(job));
    this.#jobByIdempotencyKey.set(job.idempotencyKey, job.id);
    this.#transitions.set(job.id, []);
    return { job: structuredClone(job), created: true };
  }

  async getPublishingJobByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<PublishingJob | null> {
    const id = this.#jobByIdempotencyKey.get(idempotencyKey);
    const job = id ? this.#jobs.get(id) : undefined;
    return job ? structuredClone(job) : null;
  }

  async countPublishingJobs(
    householdId: string,
    platform: string,
    since: string,
    commandAction?: PublishingJob["commandAction"],
  ): Promise<number> {
    return [...this.#jobs.values()].filter(
      (job) =>
        job.householdId === householdId &&
        job.platform.toLowerCase() === platform.toLowerCase() &&
        job.createdAt >= since &&
        (!commandAction || job.commandAction === commandAction),
    ).length;
  }

  async claimRunnableServerJobs(input: {
    workerId: string;
    now: string;
    leaseExpiresAt: string;
    limit: number;
  }): Promise<PublishingJob[]> {
    const jobs = [...this.#jobs.values()]
      .filter((job) => {
        const lease = this.#jobLeases.get(job.id);
        const availableLease = !lease || lease.expiresAt <= input.now;
        const runnableState =
          job.currentState === "QUEUED" ||
          (job.currentState === "FAILED_RETRYABLE" &&
            Boolean(job.nextRetryAt) &&
            job.nextRetryAt! <= input.now);
        return !job.deviceId && availableLease && runnableState;
      })
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, input.limit);
    for (const job of jobs) {
      this.#jobLeases.set(job.id, {
        workerId: input.workerId,
        expiresAt: input.leaseExpiresAt,
      });
    }
    return jobs.map((job) => structuredClone(job));
  }

  async releasePublishingJobLease(
    jobId: string,
    workerId: string,
  ): Promise<void> {
    if (this.#jobLeases.get(jobId)?.workerId === workerId) {
      this.#jobLeases.delete(jobId);
    }
  }

  async getPublishingJob(
    householdId: string,
    jobId: string,
  ): Promise<JobWithTransitions | null> {
    const job = this.#jobs.get(jobId);
    if (!job || job.householdId !== householdId) return null;
    return {
      job: structuredClone(job),
      transitions: structuredClone(this.#transitions.get(jobId) ?? []),
    };
  }

  async savePublishingTransition(
    job: PublishingJob,
    transition: PublishingTransition,
  ): Promise<void> {
    if (!this.#jobs.has(job.id)) throw new Error("Publishing job not found");
    this.#jobs.set(job.id, structuredClone(job));
    const transitions = this.#transitions.get(job.id) ?? [];
    transitions.push(structuredClone(transition));
    this.#transitions.set(job.id, transitions);
  }

  async upsertListingExportArtifact(
    artifact: ListingExportArtifact,
  ): Promise<ListingExportArtifact> {
    this.#exportArtifacts.set(
      artifact.publishingJobId,
      structuredClone(artifact),
    );
    return structuredClone(artifact);
  }

  async getListingExportArtifact(
    householdId: string,
    publishingJobId: string,
  ): Promise<ListingExportArtifact | null> {
    const artifact = this.#exportArtifacts.get(publishingJobId);
    return artifact?.householdId === householdId
      ? structuredClone(artifact)
      : null;
  }

  async consumeListingExportArtifact(
    householdId: string,
    publishingJobId: string,
    consumedAt: string,
  ): Promise<boolean> {
    const artifact = this.#exportArtifacts.get(publishingJobId);
    if (
      !artifact ||
      artifact.householdId !== householdId ||
      artifact.consumedAt
    ) {
      return false;
    }
    this.#exportArtifacts.set(publishingJobId, { ...artifact, consumedAt });
    return true;
  }

  async listPlatformListings(itemId: string): Promise<PlatformListing[]> {
    return [...this.#platformListings.values()]
      .filter((listing) => listing.itemId === itemId)
      .map((listing) => structuredClone(listing));
  }

  async getPlatformListing(
    householdId: string,
    platformListingId: string,
  ): Promise<PlatformListing | null> {
    const listing = this.#platformListings.get(platformListingId);
    if (!listing) return null;
    const item = await this.getItem(householdId, listing.itemId);
    return item ? structuredClone(listing) : null;
  }

  async upsertPlatformListing(
    listing: PlatformListing,
    householdId: string,
  ): Promise<PlatformListing> {
    const item = await this.getItem(householdId, listing.itemId);
    if (!item) throw new Error("Item not found");
    const duplicateActive = [...this.#platformListings.values()].find(
      (value) =>
        value.id !== listing.id &&
        value.itemId === listing.itemId &&
        value.platform.toLowerCase() === listing.platform.toLowerCase() &&
        ["publishing", "live", "reserved"].includes(value.status),
    );
    if (
      duplicateActive &&
      ["publishing", "live", "reserved"].includes(listing.status)
    ) {
      throw new Error("An active platform listing already exists");
    }
    this.#platformListings.set(listing.id, structuredClone(listing));
    return structuredClone(listing);
  }

  async createOutcome(outcome: ItemOutcome): Promise<ItemOutcome> {
    if (this.#outcomes.has(outcome.itemId))
      throw new Error("Item outcome already exists");
    this.#outcomes.set(outcome.itemId, structuredClone(outcome));
    return structuredClone(outcome);
  }

  async createExceptionTask(task: ExceptionTask): Promise<ExceptionTask> {
    this.#exceptionTasks.set(task.id, structuredClone(task));
    return structuredClone(task);
  }

  async listExceptionTasks(householdId: string): Promise<ExceptionTask[]> {
    return [...this.#exceptionTasks.values()]
      .filter((task) => task.householdId === householdId)
      .map((task) => structuredClone(task));
  }

  async createBuyerTask(
    task: BuyerTask,
    householdId: string,
  ): Promise<BuyerTask> {
    const platformListing = this.#platformListings.get(task.platformListingId);
    const item = platformListing
      ? await this.getItem(householdId, platformListing.itemId)
      : null;
    if (!item) throw new Error("Platform listing not found");
    this.#buyerTasks.set(task.id, structuredClone(task));
    return structuredClone(task);
  }

  async getBuyerTask(
    householdId: string,
    taskId: string,
  ): Promise<BuyerTask | null> {
    const task = this.#buyerTasks.get(taskId);
    if (!task) return null;
    const listing = await this.getPlatformListing(
      householdId,
      task.platformListingId,
    );
    return listing ? structuredClone(task) : null;
  }

  async saveBuyerTask(
    task: BuyerTask,
    householdId: string,
  ): Promise<BuyerTask> {
    if (!(await this.getBuyerTask(householdId, task.id))) {
      throw new Error("Buyer task not found");
    }
    this.#buyerTasks.set(task.id, structuredClone(task));
    return structuredClone(task);
  }

  async listBuyerTasks(householdId: string): Promise<BuyerTask[]> {
    const itemIds = new Set(
      (await this.listItems(householdId)).map((item) => item.id),
    );
    const listingIds = new Set(
      [...this.#platformListings.values()]
        .filter((listing) => itemIds.has(listing.itemId))
        .map((listing) => listing.id),
    );
    return [...this.#buyerTasks.values()]
      .filter((task) => listingIds.has(task.platformListingId))
      .map((task) => structuredClone(task));
  }

  async createMeetup(meetup: Meetup, householdId: string): Promise<Meetup> {
    const listing = await this.getPlatformListing(
      householdId,
      meetup.platformListingId,
    );
    if (!listing || listing.itemId !== meetup.itemId) {
      throw new Error("Meetup listing is unavailable");
    }
    this.#meetups.set(meetup.id, structuredClone(meetup));
    return structuredClone(meetup);
  }

  async listMeetups(householdId: string): Promise<Meetup[]> {
    const itemIds = new Set(
      (await this.listItems(householdId)).map((item) => item.id),
    );
    return [...this.#meetups.values()]
      .filter((value) => itemIds.has(value.itemId))
      .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt))
      .map((value) => structuredClone(value));
  }

  async saveMeetup(meetup: Meetup, householdId: string): Promise<Meetup> {
    if (!this.#meetups.has(meetup.id)) throw new Error("Meetup not found");
    const item = await this.getItem(householdId, meetup.itemId);
    if (!item) throw new Error("Meetup not found");
    this.#meetups.set(meetup.id, structuredClone(meetup));
    return structuredClone(meetup);
  }

  async enqueueBackupBuyer(entry: BackupBuyerEntry): Promise<BackupBuyerEntry> {
    const existing = [...this.#backupBuyers.values()].find(
      (value) =>
        value.itemId === entry.itemId &&
        value.buyerTaskId === entry.buyerTaskId &&
        value.status !== "removed",
    );
    if (existing) return structuredClone(existing);
    this.#backupBuyers.set(entry.id, structuredClone(entry));
    return structuredClone(entry);
  }

  async listBackupBuyers(
    householdId: string,
    itemId: string,
  ): Promise<BackupBuyerEntry[]> {
    if (!(await this.getItem(householdId, itemId))) return [];
    return [...this.#backupBuyers.values()]
      .filter((value) => value.itemId === itemId && value.status !== "removed")
      .sort((left, right) => left.position - right.position)
      .map((value) => structuredClone(value));
  }

  async saveBackupBuyer(entry: BackupBuyerEntry): Promise<BackupBuyerEntry> {
    if (!this.#backupBuyers.has(entry.id))
      throw new Error("Backup buyer not found");
    this.#backupBuyers.set(entry.id, structuredClone(entry));
    return structuredClone(entry);
  }

  async createNotification(
    notification: UserNotification,
  ): Promise<UserNotification> {
    this.#notifications.set(notification.id, structuredClone(notification));
    return structuredClone(notification);
  }

  async listNotifications(
    userId: string,
    householdId: string,
  ): Promise<UserNotification[]> {
    return [...this.#notifications.values()]
      .filter(
        (value) => value.userId === userId && value.householdId === householdId,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((value) => structuredClone(value));
  }

  async markNotificationRead(
    userId: string,
    notificationId: string,
    readAt: string,
  ): Promise<UserNotification | null> {
    const notification = this.#notifications.get(notificationId);
    if (!notification || notification.userId !== userId) return null;
    const updated = { ...notification, readAt };
    this.#notifications.set(notificationId, structuredClone(updated));
    return updated;
  }

  async upsertPushSubscription(
    subscription: PushSubscription,
  ): Promise<PushSubscription> {
    for (const [id, existing] of this.#pushSubscriptions) {
      if (existing.expoPushToken === subscription.expoPushToken) {
        this.#pushSubscriptions.delete(id);
      }
    }
    this.#pushSubscriptions.set(subscription.id, structuredClone(subscription));
    return structuredClone(subscription);
  }

  async listPushSubscriptions(userId: string): Promise<PushSubscription[]> {
    return [...this.#pushSubscriptions.values()]
      .filter((value) => value.userId === userId && value.enabled)
      .map((value) => structuredClone(value));
  }

  async claimQueuedNotifications(input: {
    workerId: string;
    now: string;
    leaseExpiresAt: string;
    limit: number;
  }): Promise<UserNotification[]> {
    const values = [...this.#notifications.values()]
      .filter((notification) => {
        const lease = this.#notificationLeases.get(notification.id);
        return (
          notification.deliveryState === "queued" &&
          notification.nextDeliveryAt <= input.now &&
          (!lease || lease.expiresAt <= input.now)
        );
      })
      .slice(0, input.limit);
    for (const notification of values) {
      this.#notificationLeases.set(notification.id, {
        workerId: input.workerId,
        expiresAt: input.leaseExpiresAt,
      });
    }
    return values.map((value) => structuredClone(value));
  }

  async completeNotificationDelivery(input: {
    notificationId: string;
    workerId: string;
    state: UserNotification["deliveryState"];
    providerTicketIds: string[];
    nextDeliveryAt: string;
  }): Promise<void> {
    const lease = this.#notificationLeases.get(input.notificationId);
    const notification = this.#notifications.get(input.notificationId);
    if (!notification || lease?.workerId !== input.workerId) return;
    this.#notifications.set(input.notificationId, {
      ...notification,
      deliveryState: input.state,
      deliveryAttempts: notification.deliveryAttempts + 1,
      providerTicketIds: input.providerTicketIds,
      nextDeliveryAt: input.nextDeliveryAt,
    });
    this.#notificationLeases.delete(input.notificationId);
  }

  async createSupportGrant(
    grant: SupportAccessGrant,
  ): Promise<SupportAccessGrant> {
    this.#supportGrants.set(grant.id, structuredClone(grant));
    return structuredClone(grant);
  }

  async getSupportGrant(grantId: string): Promise<SupportAccessGrant | null> {
    const value = this.#supportGrants.get(grantId);
    return value ? structuredClone(value) : null;
  }

  async listSupportGrants(householdId: string): Promise<SupportAccessGrant[]> {
    return [...this.#supportGrants.values()]
      .filter((value) => value.householdId === householdId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((value) => structuredClone(value));
  }

  async listActiveSupportGrantsForActor(
    actorId: string,
    now: string,
  ): Promise<SupportAccessGrant[]> {
    return [...this.#supportGrants.values()]
      .filter(
        (value) =>
          value.supportActorId === actorId &&
          value.revokedAt === null &&
          value.expiresAt > now,
      )
      .map((value) => structuredClone(value));
  }

  async revokeSupportGrant(
    householdId: string,
    grantId: string,
    revokedAt: string,
  ): Promise<SupportAccessGrant | null> {
    const value = this.#supportGrants.get(grantId);
    if (!value || value.householdId !== householdId) return null;
    const revoked = { ...value, revokedAt };
    this.#supportGrants.set(grantId, structuredClone(revoked));
    return structuredClone(revoked);
  }

  async createDiagnosticArtifact(
    artifact: DiagnosticArtifact,
  ): Promise<DiagnosticArtifact> {
    this.#diagnosticArtifacts.set(artifact.id, structuredClone(artifact));
    return structuredClone(artifact);
  }

  async listDiagnosticArtifacts(
    grantId: string,
  ): Promise<DiagnosticArtifact[]> {
    return [...this.#diagnosticArtifacts.values()]
      .filter((value) => value.grantId === grantId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((value) => structuredClone(value));
  }

  async listExpiredDiagnosticArtifacts(
    now: string,
  ): Promise<DiagnosticArtifact[]> {
    return [...this.#diagnosticArtifacts.values()]
      .filter((artifact) => {
        const grant = this.#supportGrants.get(artifact.grantId);
        return (
          !grant ||
          grant.expiresAt <= now ||
          (grant.revokedAt !== null && grant.revokedAt <= now)
        );
      })
      .map((artifact) => structuredClone(artifact));
  }

  async purgeExpiredEphemeralData(
    now: string,
    diagnosticArtifactIds: readonly string[],
  ): Promise<EphemeralPurgeResult> {
    let diagnosticArtifacts = 0;
    for (const id of diagnosticArtifactIds) {
      if (this.#diagnosticArtifacts.delete(id)) diagnosticArtifacts += 1;
    }
    let listingExportArtifacts = 0;
    this.#exportArtifacts.forEach((artifact, key) => {
      if (artifact.expiresAt <= now || artifact.consumedAt !== null) {
        this.#exportArtifacts.delete(key);
        listingExportArtifacts += 1;
      }
    });
    let issuedDeviceCommands = 0;
    this.#issuedDeviceCommands.forEach((command, key) => {
      if (command.expiresAt <= now) {
        this.#issuedDeviceCommands.delete(key);
        issuedDeviceCommands += 1;
      }
    });
    let pairingChallenges = 0;
    this.#pairingChallenges.forEach((challenge, key) => {
      if (challenge.expiresAt <= now || challenge.consumedAt !== null) {
        this.#pairingChallenges.delete(key);
        pairingChallenges += 1;
      }
    });
    let deviceNonces = 0;
    this.#deviceNonces.forEach((expiresAt, key) => {
      if (expiresAt <= now) {
        this.#deviceNonces.delete(key);
        deviceNonces += 1;
      }
    });
    return {
      diagnosticArtifacts,
      listingExportArtifacts,
      issuedDeviceCommands,
      pairingChallenges,
      deviceNonces,
    };
  }

  async getRedactedSupportSnapshot(
    householdId: string,
  ): Promise<RedactedSupportSnapshot> {
    return structuredClone({
      devices: [...this.#devices.values()]
        .filter((value) => value.householdId === householdId)
        .map((value) => ({
          id: value.id,
          displayName: value.displayName,
          connectionStatus: value.connectionStatus,
          appVersion: value.appVersion,
          androidVersion: value.androidVersion,
          batteryPercent: value.batteryPercent,
          networkType: value.networkType,
          lastCheckInAt: value.lastCheckInAt,
        })),
      jobs: [...this.#jobs.values()]
        .filter((value) => value.householdId === householdId)
        .map((value) => ({
          id: value.id,
          itemId: value.itemId,
          platform: value.platform,
          currentState: value.currentState,
          errorCode: value.errorCode,
          connectorVersion: value.connectorVersion,
          retryCount: value.retryCount,
          updatedAt: value.updatedAt,
        })),
    });
  }

  async createAuditEvent(
    event: AuditEvent,
    householdId: string | null,
  ): Promise<void> {
    this.#audits.push({ event: structuredClone(event), householdId });
  }

  async #purgeHousehold(householdId: string): Promise<void> {
    for (const item of await this.listItems(householdId)) {
      await this.deleteItem(householdId, item.id);
    }
    const deviceIds = [...this.#devices.values()]
      .filter((value) => value.householdId === householdId)
      .map((value) => value.id);
    for (const deviceId of deviceIds) {
      this.#devices.delete(deviceId);
      this.#deviceCredentials.delete(deviceId);
      this.#issuedDeviceCommands.forEach((value, key) => {
        if (value.deviceId === deviceId) this.#issuedDeviceCommands.delete(key);
      });
      for (const key of this.#deviceNonces.keys()) {
        if (key.startsWith(`${deviceId}:`)) this.#deviceNonces.delete(key);
      }
    }
    this.#pairingChallenges.forEach((value, key) => {
      if (value.householdId === householdId)
        this.#pairingChallenges.delete(key);
    });
    for (const key of this.#platformConnections.keys()) {
      if (key.startsWith(`${householdId}:`))
        this.#platformConnections.delete(key);
    }
    this.#exceptionTasks.forEach((value, key) => {
      if (value.householdId === householdId) this.#exceptionTasks.delete(key);
    });
    this.#notifications.forEach((value, key) => {
      if (value.householdId === householdId) this.#notifications.delete(key);
    });
    this.#supportGrants.forEach((value, key) => {
      if (value.householdId === householdId) this.#supportGrants.delete(key);
    });
    this.#diagnosticArtifacts.forEach((value, key) => {
      if (value.householdId === householdId) {
        this.#diagnosticArtifacts.delete(key);
      }
    });
    for (let index = this.#audits.length - 1; index >= 0; index -= 1) {
      if (this.#audits[index]?.householdId === householdId) {
        this.#audits.splice(index, 1);
      }
    }
    this.#members.delete(householdId);
    this.#households.delete(householdId);
  }
}
