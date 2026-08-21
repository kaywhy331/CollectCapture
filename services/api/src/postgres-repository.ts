import {
  CanonicalListingSchema,
  ConnectorManifestSchema,
  DiagnosticArtifactSchema,
  FeatureFlagSchema,
  HouseholdSchema,
  ItemEnrichmentSchema,
  ItemSchema,
  PlatformListingSchema,
  PlatformConnectionSchema,
  PlatformListingVariantSchema,
  ProductionReleaseSchema,
  PublishingJobSchema,
  PushSubscriptionSchema,
  SellerDeviceSchema,
  UserNotificationSchema,
  type AuditEvent,
  type BackupBuyerEntry,
  type BuyerTask,
  type Comparable,
  type CanonicalListing,
  type ConnectorManifest,
  type DiagnosticArtifact,
  type FeatureFlag,
  type Household,
  type ItemEnrichment,
  type ItemStatus,
  type Meetup,
  type PlatformConnection,
  type PlatformListing,
  type PlatformListingVariant,
  type ProductionRelease,
  type PublishingJob,
  type PublishingTransition,
  type PushSubscription,
  type SellerDevice,
  type SupportAccessGrant,
  type UserNotification,
} from "@localclear/domain";
import postgres from "postgres";
import type {
  ExceptionTask,
  AccountDeletionPreparation,
  AccountDeletionReceipt,
  AccountExportPayload,
  ListingExportArtifact,
  EphemeralPurgeResult,
  ConnectorHealthRow,
  IssuedDeviceCommand,
  HouseholdProgressSummary,
  ItemOutcome,
  JobWithTransitions,
  Repository,
  RedactedSupportSnapshot,
  StoredPairingChallenge,
  StoredItem,
} from "./repository.js";

type Row = Record<string, any>;

export class PostgresRepository implements Repository {
  readonly #sql: postgres.Sql;

  constructor(
    connectionString: string,
    options: postgres.Options<Record<string, never>> = {},
  ) {
    this.#sql = postgres(connectionString, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      ...options,
    });
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 });
  }

  async createHousehold(
    household: Household,
    ownerId: string,
  ): Promise<Household> {
    await this.#sql.begin(async (sql) => {
      await sql`
        insert into public.households (
          id, owner_id, name, goal, zip_code, selling_radius_miles, exchange_preferences,
          payment_wording, availability, preferred_meetup_locations, price_rules,
          timezone, created_at, updated_at
        ) values (
          ${household.id}::uuid, ${ownerId}::uuid, ${household.name}, ${household.goal},
          ${household.zipCode},
          ${household.sellingRadiusMiles}, ${sql.array(household.exchangePreferences)},
          ${household.paymentWording}, ${sql.json(household.availability)},
          ${sql.json(household.preferredMeetupLocations)},
          ${sql.json(household.priceRules)}, ${household.timezone},
          ${household.createdAt}, ${household.updatedAt}
        )
      `;
      await sql`
        insert into public.household_members (household_id, user_id, role)
        values (${household.id}::uuid, ${ownerId}::uuid, 'owner')
      `;
    });
    return household;
  }

  async saveHousehold(household: Household): Promise<Household> {
    const rows = await this.#sql<Row[]>`
      update public.households set
        name = ${household.name}, goal = ${household.goal},
        zip_code = ${household.zipCode},
        selling_radius_miles = ${household.sellingRadiusMiles},
        exchange_preferences = ${this.#sql.array(household.exchangePreferences)},
        payment_wording = ${household.paymentWording},
        availability = ${this.#sql.json(household.availability)},
        preferred_meetup_locations = ${this.#sql.json(household.preferredMeetupLocations)},
        price_rules = ${this.#sql.json(household.priceRules)},
        timezone = ${household.timezone}, updated_at = ${household.updatedAt}
      where id = ${household.id}::uuid
      returning *
    `;
    const row = rows[0];
    if (!row) throw new Error("Household not found");
    return mapHousehold(row);
  }

  async listHouseholds(userId: string): Promise<Household[]> {
    const rows = await this.#sql<Row[]>`
      select household.*
      from public.households household
      join public.household_members member on member.household_id = household.id
      where member.user_id = ${userId}::uuid
      order by household.updated_at desc
    `;
    return rows.map(mapHousehold);
  }

  async getHousehold(householdId: string): Promise<Household | null> {
    const [row] = await this.#sql<Row[]>`
      select * from public.households where id = ${householdId}::uuid
    `;
    return row ? mapHousehold(row) : null;
  }

  async isHouseholdMember(
    householdId: string,
    userId: string,
  ): Promise<boolean> {
    const [row] = await this.#sql<Row[]>`
      select exists (
        select 1 from public.household_members
        where household_id = ${householdId}::uuid and user_id = ${userId}::uuid
      ) as is_member
    `;
    return Boolean(row?.is_member);
  }

  async getHouseholdProgressSummary(
    householdId: string,
    monthStartedAt: string,
  ): Promise<HouseholdProgressSummary> {
    const [row] = await this.#sql<Row[]>`
      select
        (select count(*)::int from public.item_outcomes
          where household_id = ${householdId}::uuid
            and cleared_at >= ${monthStartedAt}) as cleared_this_month,
        (select coalesce(sum(sale_price_cents), 0)::int
          from public.item_outcomes
          where household_id = ${householdId}::uuid
            and cleared_at >= ${monthStartedAt}) as recovered_cents,
        (select count(*)::int from public.items
          where household_id = ${householdId}::uuid
            and status = 'ready') as ready_to_list,
        (select count(*)::int from public.buyer_tasks
          where household_id = ${householdId}::uuid
            and approval_state in ('pending', 'approved')) as buyer_tasks,
        (select count(*)::int from public.exception_tasks
          where household_id = ${householdId}::uuid and status = 'open'
            and kind in ('inventory_closure', 'inventory_archive')) as removal_tasks
    `;
    return {
      clearedThisMonth: Number(row?.cleared_this_month ?? 0),
      recoveredCents: Number(row?.recovered_cents ?? 0),
      readyToList: Number(row?.ready_to_list ?? 0),
      buyerTasks: Number(row?.buyer_tasks ?? 0),
      removalTasks: Number(row?.removal_tasks ?? 0),
    };
  }

  async exportAccountData(
    userId: string,
    generatedAt: string,
  ): Promise<AccountExportPayload> {
    const [profile] = await this.#sql<Row[]>`
      select id, name, timezone, locale, notification_preferences,
        privacy_settings, created_at, updated_at
      from public.profiles where id = ${userId}::uuid
    `;
    const households = await this.#sql<Row[]>`
      select household.* from public.households household
      join public.household_members member on member.household_id = household.id
      where member.user_id = ${userId}::uuid order by household.created_at
    `;
    const householdIds = households.map((row) => String(row.id));
    if (householdIds.length === 0) {
      return {
        schemaVersion: 1,
        generatedAt,
        profile: profile ?? null,
        households: [],
        sellerDevices: [],
        platformConnections: [],
        items: [],
        mediaAssets: [],
        enrichments: [],
        canonicalListings: [],
        platformVariants: [],
        platformListings: [],
        publishingJobs: [],
        publishingTransitions: [],
        buyerTasks: [],
        meetups: [],
        backupBuyers: [],
        notifications: [],
        supportGrants: [],
        diagnosticArtifacts: [],
        listingExportArtifacts: [],
        outcomes: [],
        exceptionTasks: [],
        auditEvents: [],
      };
    }
    const [
      sellerDevices,
      platformConnections,
      items,
      mediaAssets,
      enrichments,
      canonicalListings,
      platformVariants,
      platformListings,
      publishingJobs,
      publishingTransitions,
      buyerTasks,
      meetups,
      backupBuyers,
      notifications,
      supportGrants,
      diagnosticArtifacts,
      listingExportArtifacts,
      outcomes,
      exceptionTasks,
      auditEvents,
    ] = await Promise.all([
      this.#sql<
        Row[]
      >`select * from public.seller_devices where household_id in ${this.#sql(householdIds)} order by created_at`,
      this.#sql<
        Row[]
      >`select * from public.platform_connections where household_id in ${this.#sql(householdIds)} order by created_at`,
      this.#sql<
        Row[]
      >`select * from public.items where household_id in ${this.#sql(householdIds)} order by created_at`,
      this.#sql<
        Row[]
      >`select * from public.media_assets where household_id in ${this.#sql(householdIds)} order by created_at`,
      this.#sql<
        Row[]
      >`select * from public.item_enrichments where household_id in ${this.#sql(householdIds)} order by created_at`,
      this.#sql<
        Row[]
      >`select * from public.canonical_listings where household_id in ${this.#sql(householdIds)} order by item_id, version`,
      this.#sql<
        Row[]
      >`select * from public.platform_listing_variants where household_id in ${this.#sql(householdIds)} order by generated_at`,
      this.#sql<
        Row[]
      >`select * from public.platform_listings where household_id in ${this.#sql(householdIds)} order by created_at`,
      this.#sql<
        Row[]
      >`select * from public.publishing_jobs where household_id in ${this.#sql(householdIds)} order by created_at`,
      this.#sql<
        Row[]
      >`select * from public.publishing_job_transitions where household_id in ${this.#sql(householdIds)} order by occurred_at`,
      this.#sql<
        Row[]
      >`select * from public.buyer_tasks where household_id in ${this.#sql(householdIds)} order by created_at`,
      this.#sql<
        Row[]
      >`select * from public.meetups where household_id in ${this.#sql(householdIds)} order by created_at`,
      this.#sql<
        Row[]
      >`select * from public.buyer_backup_queue where household_id in ${this.#sql(householdIds)} order by created_at`,
      this.#sql<
        Row[]
      >`select * from public.user_notifications where user_id = ${userId}::uuid and household_id in ${this.#sql(householdIds)} order by created_at`,
      this.#sql<
        Row[]
      >`select * from public.support_access_grants where granted_by = ${userId}::uuid and household_id in ${this.#sql(householdIds)} order by created_at`,
      this.#sql<
        Row[]
      >`select * from public.diagnostic_artifacts where submitted_by = ${userId}::uuid and household_id in ${this.#sql(householdIds)} order by created_at`,
      this.#sql<
        Row[]
      >`select * from public.listing_export_artifacts where household_id in ${this.#sql(householdIds)} order by created_at`,
      this.#sql<
        Row[]
      >`select * from public.item_outcomes where household_id in ${this.#sql(householdIds)} order by cleared_at`,
      this.#sql<
        Row[]
      >`select * from public.exception_tasks where household_id in ${this.#sql(householdIds)} order by created_at`,
      this.#sql<
        Row[]
      >`select * from public.audit_events where household_id in ${this.#sql(householdIds)} order by created_at`,
    ]);
    return {
      schemaVersion: 1,
      generatedAt,
      profile: profile ?? null,
      households,
      sellerDevices,
      platformConnections,
      items,
      mediaAssets,
      enrichments,
      canonicalListings,
      platformVariants,
      platformListings,
      publishingJobs,
      publishingTransitions,
      buyerTasks,
      meetups,
      backupBuyers,
      notifications,
      supportGrants,
      diagnosticArtifacts,
      listingExportArtifacts,
      outcomes,
      exceptionTasks,
      auditEvents,
    };
  }

  async beginAccountDeletion(input: {
    requestId: string;
    userId: string;
    subjectHash: string;
    requestedAt: string;
  }): Promise<AccountDeletionPreparation> {
    return this.#sql.begin(async (sql) => {
      const [existingRequest] = await sql<Row[]>`
        select id from public.account_deletion_requests
        where user_id = ${input.userId}::uuid and status <> 'failed'
        order by requested_at desc limit 1
      `;
      const requestId = existingRequest
        ? String(existingRequest.id)
        : input.requestId;
      const households = await sql<Row[]>`
        select id from public.households where owner_id = ${input.userId}::uuid
      `;
      const householdIds = households.map((row) => String(row.id));
      if (!existingRequest) {
        await sql`
          insert into public.account_deletion_requests (
            id, user_id, subject_hash, status, requested_at
          ) values (
            ${requestId}::uuid, ${input.userId}::uuid, ${input.subjectHash},
            'revoking', ${input.requestedAt}
          )
        `;
      }
      if (householdIds.length === 0) {
        return {
          requestId,
          mediaPaths: [],
          revokedDeviceCount: 0,
          cancelledJobCount: 0,
        };
      }
      const media = await sql<Row[]>`
        select storage_path from public.media_assets
        where household_id in ${sql(householdIds)}
        union
        select storage_path from public.diagnostic_artifacts
        where household_id in ${sql(householdIds)}
      `;
      const revoked = await sql<Row[]>`
        update public.seller_devices set
          is_primary = false, connection_status = 'revoked',
          revoked_at = ${input.requestedAt}
        where household_id in ${sql(householdIds)} and revoked_at is null
        returning id
      `;
      if (revoked.length > 0) {
        await sql`
          update public.seller_device_credentials set revoked_at = ${input.requestedAt}
          where device_id in ${sql(revoked.map((row) => String(row.id)))}
            and revoked_at is null
        `;
      }
      const activeJobs = await sql<Row[]>`
        select id, household_id, current_state from public.publishing_jobs
        where household_id in ${sql(householdIds)}
          and current_state not in ('PUBLISHED', 'FAILED_FINAL', 'CANCELLED')
        for update
      `;
      for (const job of activeJobs) {
        await sql`
          insert into public.publishing_job_transitions (
            publishing_job_id, household_id, from_state, to_state,
            event, reason_code, occurred_at
          ) values (
            ${String(job.id)}::uuid, ${String(job.household_id)}::uuid,
            ${job.current_state}, 'CANCELLED', 'cancel', 'ACCOUNT_DELETION',
            ${input.requestedAt}
          )
        `;
      }
      if (activeJobs.length > 0) {
        await sql`
          update public.publishing_jobs set
            current_state = 'CANCELLED', error_code = 'ACCOUNT_DELETION',
            completed_at = ${input.requestedAt}, updated_at = ${input.requestedAt}
          where id in ${sql(activeJobs.map((row) => String(row.id)))}
        `;
      }
      return {
        requestId,
        mediaPaths: media.map((row) => row.storage_path as string),
        revokedDeviceCount: revoked.length,
        cancelledJobCount: activeJobs.length,
      };
    });
  }

  async purgeAccountData(userId: string): Promise<void> {
    await this.#sql`
      delete from public.profiles where id = ${userId}::uuid
    `;
  }

  async completeAccountDeletion(
    receipt: AccountDeletionReceipt,
  ): Promise<void> {
    await this.#sql.begin(async (sql) => {
      await sql`
        update public.account_deletion_requests set
          user_id = null, status = 'complete', completed_at = ${receipt.completedAt},
          failure_reason = null
        where id = ${receipt.requestId}::uuid
      `;
      await sql`
        insert into public.account_deletion_receipts (
          id, request_id, subject_hash, completed_at
        ) values (
          ${receipt.receiptId}::uuid, ${receipt.requestId}::uuid,
          ${receipt.subjectHash}, ${receipt.completedAt}
        ) on conflict (request_id) do nothing
      `;
    });
  }

  async createSellerDevice(device: SellerDevice): Promise<SellerDevice> {
    await this.#sql`
      insert into public.seller_devices (
        id, household_id, display_name, public_key, android_version, app_version,
        is_primary, connection_status, battery_percent, is_charging, network_type,
        last_check_in_at, capabilities, revoked_at
      ) values (
        ${device.id}::uuid, ${device.householdId}::uuid, ${device.displayName}, ${device.publicKey},
        ${device.androidVersion}, ${device.appVersion}, ${device.isPrimary}, ${device.connectionStatus},
        ${device.batteryPercent}, ${device.isCharging}, ${device.networkType}, ${device.lastCheckInAt},
        ${this.#sql.array(device.capabilities)}, ${device.revokedAt}
      )
    `;
    return device;
  }

  async getSellerDevice(
    householdId: string,
    deviceId: string,
  ): Promise<SellerDevice | null> {
    const [row] = await this.#sql<Row[]>`
      select * from public.seller_devices
      where household_id = ${householdId}::uuid and id = ${deviceId}::uuid
    `;
    return row ? mapSellerDevice(row) : null;
  }

  async listSellerDevices(householdId: string): Promise<SellerDevice[]> {
    const rows = await this.#sql<Row[]>`
      select * from public.seller_devices
      where household_id = ${householdId}::uuid
      order by is_primary desc, created_at
    `;
    return rows.map(mapSellerDevice);
  }

  async saveSellerDevice(device: SellerDevice): Promise<SellerDevice> {
    const rows = await this.#sql<Row[]>`
      update public.seller_devices set
        display_name = ${device.displayName}, public_key = ${device.publicKey},
        android_version = ${device.androidVersion}, app_version = ${device.appVersion},
        is_primary = ${device.isPrimary}, connection_status = ${device.connectionStatus},
        battery_percent = ${device.batteryPercent}, is_charging = ${device.isCharging},
        network_type = ${device.networkType}, last_check_in_at = ${device.lastCheckInAt},
        capabilities = ${this.#sql.array(device.capabilities)}, revoked_at = ${device.revokedAt}
      where id = ${device.id}::uuid and household_id = ${device.householdId}::uuid
      returning *
    `;
    const row = rows[0];
    if (!row) throw new Error("Seller device not found");
    return mapSellerDevice(row);
  }

  async upsertPlatformConnection(
    connection: PlatformConnection,
    householdId: string,
  ): Promise<PlatformConnection> {
    const [row] = await this.#sql<Row[]>`
      insert into public.platform_connections (
        id, household_id, seller_device_id, platform, app_version, display_alias,
        connection_status, last_verified_at, supported_capabilities, policy_status
      ) values (
        ${connection.id}::uuid, ${householdId}::uuid,
        ${connection.sellerDeviceId}::uuid, ${connection.platform},
        ${connection.appVersion}, ${connection.displayAlias}, ${connection.connectionStatus},
        ${connection.lastVerifiedAt},
        ${this.#sql.array(connection.supportedCapabilities)},
        ${connection.policyStatus}
      ) on conflict (household_id, platform) do update set
        seller_device_id = excluded.seller_device_id,
        app_version = excluded.app_version,
        display_alias = excluded.display_alias,
        connection_status = excluded.connection_status,
        last_verified_at = excluded.last_verified_at,
        supported_capabilities = excluded.supported_capabilities,
        policy_status = excluded.policy_status,
        updated_at = now()
      returning *
    `;
    if (!row) throw new Error("Platform connection upsert failed");
    return mapPlatformConnection(row);
  }

  async listPlatformConnections(
    householdId: string,
  ): Promise<PlatformConnection[]> {
    const rows = await this.#sql<Row[]>`
      select * from public.platform_connections
      where household_id = ${householdId}::uuid order by platform
    `;
    return rows.map(mapPlatformConnection);
  }

  async createSellerDeviceCredential(
    deviceId: string,
    tokenHash: string,
    createdAt: string,
  ): Promise<void> {
    await this.#sql`
      insert into public.seller_device_credentials (
        device_id, token_hash, created_at, last_used_at, revoked_at
      ) values (${deviceId}::uuid, ${tokenHash}, ${createdAt}, null, null)
      on conflict (device_id) do update set
        token_hash = excluded.token_hash, created_at = excluded.created_at,
        last_used_at = null, revoked_at = null
    `;
  }

  async authenticateSellerDeviceToken(
    deviceId: string,
    tokenHash: string,
    lastUsedAt: string,
  ): Promise<SellerDevice | null> {
    const rows = await this.#sql<Row[]>`
      update public.seller_device_credentials credential set
        last_used_at = ${lastUsedAt}
      from public.seller_devices device
      where credential.device_id = ${deviceId}::uuid
        and credential.token_hash = ${tokenHash}
        and credential.revoked_at is null
        and device.id = credential.device_id
        and device.revoked_at is null
      returning device.*
    `;
    const row = rows[0];
    return row ? mapSellerDevice(row) : null;
  }

  async revokeSellerDeviceCredential(
    deviceId: string,
    revokedAt: string,
  ): Promise<void> {
    await this.#sql`
      update public.seller_device_credentials set revoked_at = ${revokedAt}
      where device_id = ${deviceId}::uuid and revoked_at is null
    `;
  }

  async consumeDeviceNonce(
    deviceId: string,
    nonce: string,
    expiresAt: string,
    consumedAt: string,
  ): Promise<boolean> {
    const rows = await this.#sql<Row[]>`
      insert into public.device_command_nonces (
        device_id, nonce, expires_at, consumed_at
      ) values (${deviceId}::uuid, ${nonce}, ${expiresAt}, ${consumedAt})
      on conflict (device_id, nonce) do nothing
      returning nonce
    `;
    return rows.length === 1;
  }

  async listPendingDeviceJobs(
    deviceId: string,
    limit: number,
  ): Promise<PublishingJob[]> {
    const rows = await this.#sql<Row[]>`
      select * from public.publishing_jobs
      where device_id = ${deviceId}::uuid
        and current_state not in ('PUBLISHED', 'FAILED_FINAL', 'CANCELLED')
      order by created_at
      limit ${limit}
    `;
    return rows.map(mapJob);
  }

  async getActiveIssuedDeviceCommand(
    deviceId: string,
    jobId: string,
    now: string,
  ): Promise<IssuedDeviceCommand | null> {
    const [row] = await this.#sql<Row[]>`
      select * from public.issued_device_commands
      where device_id = ${deviceId}::uuid and job_id = ${jobId}::uuid
        and expires_at > ${now}
      order by issued_at desc limit 1
    `;
    return row ? mapIssuedDeviceCommand(row) : null;
  }

  async createIssuedDeviceCommand(command: IssuedDeviceCommand): Promise<void> {
    await this.#sql`
      insert into public.issued_device_commands (
        device_id, job_id, command_nonce, expires_at, signed_command
      ) values (
        ${command.deviceId}::uuid, ${command.jobId}::uuid, ${command.commandNonce},
        ${command.expiresAt}, ${this.#sql.json(command.signedCommand)}
      )
    `;
  }

  async isIssuedDeviceCommandActive(
    deviceId: string,
    jobId: string,
    commandNonce: string,
    now: string,
  ): Promise<boolean> {
    const [row] = await this.#sql<Row[]>`
      select exists (
        select 1 from public.issued_device_commands
        where device_id = ${deviceId}::uuid and job_id = ${jobId}::uuid
          and command_nonce = ${commandNonce} and expires_at > ${now}
      ) as is_active
    `;
    return Boolean(row?.is_active);
  }

  async createPairingChallenge(
    challenge: StoredPairingChallenge,
  ): Promise<void> {
    await this.#sql`
      insert into public.device_pairing_challenges (
        id, household_id, challenge_hash, expires_at, consumed_at
      ) values (
        ${challenge.id}::uuid, ${challenge.householdId}::uuid, ${challenge.secretHash},
        ${challenge.expiresAt}, ${challenge.consumedAt}
      )
    `;
  }

  async getPairingChallenge(
    challengeId: string,
  ): Promise<StoredPairingChallenge | null> {
    const [row] = await this.#sql<Row[]>`
      select * from public.device_pairing_challenges where id = ${challengeId}::uuid
    `;
    return row
      ? {
          id: String(row.id),
          householdId: String(row.household_id),
          secretHash: row.challenge_hash,
          expiresAt: iso(row.expires_at),
          consumedAt: nullableIso(row.consumed_at),
        }
      : null;
  }

  async consumePairingChallenge(
    challengeId: string,
    consumedAt: string,
  ): Promise<boolean> {
    const rows = await this.#sql<Row[]>`
      update public.device_pairing_challenges set consumed_at = ${consumedAt}
      where id = ${challengeId}::uuid
        and consumed_at is null
        and expires_at > ${consumedAt}
      returning id
    `;
    return rows.length === 1;
  }

  async createItem(item: StoredItem): Promise<StoredItem> {
    const [created] = await this.createItems([item]);
    if (!created) throw new Error("Item insert failed");
    return created;
  }

  async createItems(items: readonly StoredItem[]): Promise<StoredItem[]> {
    await this.#sql.begin(async (sql) => {
      for (const item of items) {
        await insertItem(sql, item);
      }
    });
    return items.map((item) => structuredClone(item));
  }

  async saveItem(item: StoredItem): Promise<StoredItem> {
    const rows = await this.#sql<Row[]>`
      update public.items set
        title = ${item.title}, category = ${item.category}, brand = ${item.brand},
        model = ${item.model}, condition = ${item.condition},
        dimensions = ${this.#sql.json(item.dimensions)},
        specifications = ${this.#sql.json(item.specifications)},
        accessories = ${this.#sql.array(item.accessories)},
        defects = ${this.#sql.array(item.defects)},
        storage_location = ${item.storageLocation},
        identification = ${this.#sql.json(item.identification)},
        identification_confidence = ${item.identification.confidence},
        clearing_recommendation = ${item.clearingRecommendation},
        status = ${item.status}, image_fingerprint = ${item.imageFingerprint},
        barcode = ${item.barcode}, updated_at = ${item.updatedAt}
      where household_id = ${item.householdId}::uuid and id = ${item.id}::uuid
      returning id
    `;
    if (rows.length !== 1) throw new Error("Item not found");
    return item;
  }

  async getItem(
    householdId: string,
    itemId: string,
  ): Promise<StoredItem | null> {
    const [row] = await this.#sql<Row[]>`
      select * from public.items
      where household_id = ${householdId}::uuid and id = ${itemId}::uuid
    `;
    if (!row) return null;
    const media = await this.#sql<Row[]>`
      select * from public.media_assets where item_id = ${itemId}::uuid order by display_order
    `;
    return mapItem(row, media);
  }

  async listItems(householdId: string): Promise<StoredItem[]> {
    const rows = await this.#sql<Row[]>`
      select * from public.items
      where household_id = ${householdId}::uuid
      order by updated_at desc
    `;
    if (rows.length === 0) return [];
    const ids = rows.map((row) => String(row.id));
    const mediaRows = await this.#sql<Row[]>`
      select * from public.media_assets
      where item_id in ${this.#sql(ids)}
      order by item_id, display_order
    `;
    return rows.map((row) =>
      mapItem(
        row,
        mediaRows.filter((media) => String(media.item_id) === String(row.id)),
      ),
    );
  }

  async updateItemStatus(
    householdId: string,
    itemId: string,
    status: ItemStatus,
    now: string,
  ): Promise<StoredItem> {
    await this.#sql`
      update public.items set status = ${status}, updated_at = ${now}
      where household_id = ${householdId}::uuid and id = ${itemId}::uuid
    `;
    const item = await this.getItem(householdId, itemId);
    if (!item) throw new Error("Item not found");
    return item;
  }

  async deleteItem(householdId: string, itemId: string): Promise<boolean> {
    const rows = await this.#sql<Row[]>`
      delete from public.items
      where household_id = ${householdId}::uuid and id = ${itemId}::uuid
      returning id
    `;
    return rows.length === 1;
  }

  async createItemEnrichment(
    enrichment: ItemEnrichment,
  ): Promise<ItemEnrichment> {
    const rows = await this.#sql<Row[]>`
      insert into public.item_enrichments (
        id, household_id, item_id, input_fingerprint, provider, model,
        output, created_at
      ) values (
        ${enrichment.id}::uuid, ${enrichment.householdId}::uuid,
        ${enrichment.itemId}::uuid, ${enrichment.inputFingerprint},
        ${enrichment.provider}, ${enrichment.model},
        ${this.#sql.json(enrichment.output)}, ${enrichment.createdAt}
      ) on conflict (item_id, input_fingerprint, provider, model)
        do nothing returning *
    `;
    const created = rows[0];
    if (created) return mapItemEnrichment(created);
    const existing = await this.getItemEnrichmentByFingerprint(
      enrichment.householdId,
      enrichment.itemId,
      enrichment.inputFingerprint,
      enrichment.provider,
      enrichment.model,
    );
    if (!existing) throw new Error("Idempotent enrichment lookup failed");
    return existing;
  }

  async getItemEnrichmentByFingerprint(
    householdId: string,
    itemId: string,
    inputFingerprint: string,
    provider: string,
    model: string,
  ): Promise<ItemEnrichment | null> {
    const [row] = await this.#sql<Row[]>`
      select * from public.item_enrichments
      where household_id = ${householdId}::uuid
        and item_id = ${itemId}::uuid
        and input_fingerprint = ${inputFingerprint}
        and provider = ${provider}
        and model = ${model}
      limit 1
    `;
    return row ? mapItemEnrichment(row) : null;
  }

  async getLatestItemEnrichment(
    householdId: string,
    itemId: string,
  ): Promise<ItemEnrichment | null> {
    const [row] = await this.#sql<Row[]>`
      select * from public.item_enrichments
      where household_id = ${householdId}::uuid and item_id = ${itemId}::uuid
      order by created_at desc limit 1
    `;
    return row ? mapItemEnrichment(row) : null;
  }

  async createListing(
    listing: CanonicalListing,
    householdId: string,
  ): Promise<CanonicalListing> {
    await this.#sql`
      insert into public.canonical_listings (
        id, household_id, item_id, version, title, description, condition_summary,
        specifications, price_strategy, asking_price_cents, minimum_price_cents,
        currency, approximate_location, exchange_options, payment_wording,
        negotiation_rules, listing_provenance, restricted_item_status,
        restricted_item_reasons, approved_at, created_at
      ) values (
        ${listing.id}::uuid, ${householdId}::uuid, ${listing.itemId}::uuid, ${listing.version},
        ${listing.title}, ${listing.description}, ${listing.conditionSummary},
        ${this.#sql.json(listing.specifications)}, ${listing.priceStrategy},
        ${listing.askingPrice.amountCents}, ${listing.minimumPrice.amountCents},
        ${listing.askingPrice.currency}, ${this.#sql.json(listing.location)},
        ${this.#sql.array(listing.exchangeOptions)}, ${listing.paymentWording},
        ${this.#sql.json(listing.negotiationRules)},
        ${this.#sql.json(listing.specifications)}, ${listing.restrictedItemStatus},
        ${this.#sql.array(listing.restrictedItemReasons)}, ${listing.approvedAt}, ${listing.createdAt}
      )
    `;
    return listing;
  }

  async getListing(
    itemId: string,
    version: number,
  ): Promise<CanonicalListing | null> {
    const [row] = await this.#sql<Row[]>`
      select * from public.canonical_listings
      where item_id = ${itemId}::uuid and version = ${version}
    `;
    return row ? mapListing(row) : null;
  }

  async getLatestListing(itemId: string): Promise<CanonicalListing | null> {
    const [row] = await this.#sql<Row[]>`
      select * from public.canonical_listings
      where item_id = ${itemId}::uuid order by version desc limit 1
    `;
    return row ? mapListing(row) : null;
  }

  async listOutcomeComparables(input: {
    category: string;
    brand: string | null;
    model: string | null;
    limit: number;
  }): Promise<Comparable[]> {
    const rows = await this.#sql<Row[]>`
      select outcome.id, outcome.sale_price_cents, outcome.currency,
        outcome.cleared_at
      from public.item_outcomes outcome
      join public.items item on item.id = outcome.item_id
      where outcome.outcome = 'sold' and outcome.sale_price_cents is not null
        and outcome.currency is not null
        and lower(item.category) = lower(${input.category})
        and (${input.brand}::text is null or item.brand is null or lower(item.brand) = lower(${input.brand}))
        and (${input.model}::text is null or item.model is null or lower(item.model) = lower(${input.model}))
      order by outcome.cleared_at desc
      limit ${input.limit}
    `;
    return rows.map((row) => ({
      id: `outcome-${String(row.id)}`,
      amount: {
        amountCents: Number(row.sale_price_cents),
        currency: row.currency,
      },
      outcomeType: "verified_sold" as const,
      sourceName: "LocalClear verified outcome",
      sourceApproval: "approved" as const,
      observedAt: iso(row.cleared_at),
    }));
  }

  async upsertPlatformListingVariant(
    variant: PlatformListingVariant,
  ): Promise<PlatformListingVariant> {
    const [row] = await this.#sql<Row[]>`
      insert into public.platform_listing_variants (
        id, household_id, item_id, listing_version, connector_id,
        connector_version, platform, title, description, category,
        price_cents, currency, fields, generated_at
      ) values (
        ${variant.id}::uuid, ${variant.householdId}::uuid, ${variant.itemId}::uuid,
        ${variant.listingVersion}, ${variant.connectorId}, ${variant.connectorVersion},
        ${variant.platform}, ${variant.title}, ${variant.description}, ${variant.category},
        ${variant.price.amountCents}, ${variant.price.currency},
        ${this.#sql.json(variant.fields as postgres.JSONValue)}, ${variant.generatedAt}
      ) on conflict (item_id, listing_version, platform) do update set
        connector_id = excluded.connector_id,
        connector_version = excluded.connector_version,
        title = excluded.title, description = excluded.description,
        category = excluded.category, price_cents = excluded.price_cents,
        currency = excluded.currency, fields = excluded.fields,
        generated_at = excluded.generated_at
      returning *
    `;
    if (!row) throw new Error("Platform listing variant upsert failed");
    return mapPlatformListingVariant(row);
  }

  async getPlatformListingVariant(
    itemId: string,
    listingVersion: number,
    platform: string,
  ): Promise<PlatformListingVariant | null> {
    const [row] = await this.#sql<Row[]>`
      select * from public.platform_listing_variants
      where item_id = ${itemId}::uuid and listing_version = ${listingVersion}
        and lower(platform) = lower(${platform})
    `;
    return row ? mapPlatformListingVariant(row) : null;
  }

  async upsertConnector(
    manifest: ConnectorManifest,
  ): Promise<ConnectorManifest> {
    await this.#sql.begin(async (sql) => {
      await sql`
        insert into public.connector_definitions (
          id, platform, kind, version, definition_version, enabled, kill_switch_reason,
          policy_status, production_method, approval_evidence_url, policy_reviewed_at,
          owner, capabilities, supported_app_versions, required_fields, category_mappings,
          field_mappings, title_max_length, description_max_length,
          rate_limit_per_minute, daily_listing_cap, canary_test_id
        ) values (
          ${manifest.id}, ${manifest.platform}, ${manifest.kind}, ${manifest.version},
          ${manifest.definitionVersion}, ${manifest.enabled}, ${manifest.killSwitchReason},
          ${manifest.policyStatus}, ${manifest.productionMethod}, ${manifest.approvalEvidenceUrl},
          ${manifest.policyReviewedAt}, ${manifest.owner}, ${sql.json(manifest.capabilities)},
          ${sql.array(manifest.supportedAppVersions)}, ${sql.array(manifest.requiredFields)},
          ${sql.json(manifest.categoryMappings)},
          ${sql.json(manifest.fieldMappings)}, ${manifest.titleMaxLength},
          ${manifest.descriptionMaxLength}, ${manifest.rateLimitPerMinute},
          ${manifest.dailyListingCap}, ${manifest.canaryTestId}
        )
        on conflict (id) do update set
          platform = excluded.platform, kind = excluded.kind, version = excluded.version,
          definition_version = excluded.definition_version, enabled = excluded.enabled,
          kill_switch_reason = excluded.kill_switch_reason, policy_status = excluded.policy_status,
          production_method = excluded.production_method,
          approval_evidence_url = excluded.approval_evidence_url,
          policy_reviewed_at = excluded.policy_reviewed_at, owner = excluded.owner,
          capabilities = excluded.capabilities,
          supported_app_versions = excluded.supported_app_versions,
          required_fields = excluded.required_fields, category_mappings = excluded.category_mappings,
          field_mappings = excluded.field_mappings,
          title_max_length = excluded.title_max_length,
          description_max_length = excluded.description_max_length,
          rate_limit_per_minute = excluded.rate_limit_per_minute,
          daily_listing_cap = excluded.daily_listing_cap, canary_test_id = excluded.canary_test_id
      `;
      for (const change of manifest.changeLog) {
        await sql`
          insert into public.connector_changes (
            connector_id, version, changed_by, summary, changed_at
          ) values (
            ${manifest.id}, ${change.version}, ${change.changedBy}, ${change.summary}, ${change.changedAt}
          ) on conflict (connector_id, version) do nothing
        `;
      }
    });
    return manifest;
  }

  async getConnector(platform: string): Promise<ConnectorManifest | null> {
    const [row] = await this.#sql<Row[]>`
      select * from public.connector_definitions where lower(platform) = lower(${platform})
    `;
    if (!row) return null;
    const changes = await this.#connectorChanges(String(row.id));
    return mapConnector(row, changes);
  }

  async getConnectorById(
    connectorId: string,
  ): Promise<ConnectorManifest | null> {
    const [row] = await this.#sql<Row[]>`
      select * from public.connector_definitions where id = ${connectorId}
    `;
    if (!row) return null;
    return mapConnector(row, await this.#connectorChanges(String(row.id)));
  }

  async listConnectors(): Promise<ConnectorManifest[]> {
    const rows = await this.#sql<Row[]>`
      select * from public.connector_definitions order by platform
    `;
    return Promise.all(
      rows.map(async (row) =>
        mapConnector(row, await this.#connectorChanges(String(row.id))),
      ),
    );
  }

  async listConnectorHealthRows(since: string): Promise<ConnectorHealthRow[]> {
    const rows = await this.#sql<Row[]>`
      select job.platform, job.connector_version,
        coalesce(job.platform_app_version, 'server') as app_version,
        job.current_state, job.error_code, count(*)::integer as count
      from public.publishing_jobs job
      where job.created_at >= ${since}
      group by job.platform, job.connector_version, job.platform_app_version,
        job.current_state, job.error_code
      order by job.platform, app_version, job.current_state
    `;
    return rows.map((row) => ({
      platform: row.platform,
      connectorVersion: row.connector_version,
      appVersion: row.app_version,
      currentState: row.current_state,
      errorCode: row.error_code,
      count: Number(row.count),
    })) as ConnectorHealthRow[];
  }

  async countRecentAuditEvents(action: string, since: string): Promise<number> {
    const [row] = await this.#sql<Row[]>`
      select count(*)::integer as count from public.audit_events
      where action = ${action} and created_at >= ${since}
    `;
    return Number(row?.count ?? 0);
  }

  async upsertFeatureFlag(flag: FeatureFlag): Promise<FeatureFlag> {
    await this.#sql.begin(async (sql) => {
      await sql`
        insert into public.feature_flags (
          key, description, enabled, kill_switch_reason, owner, version, updated_at
        ) values (
          ${flag.key}, ${flag.description}, ${flag.enabled},
          ${flag.killSwitchReason}, ${flag.owner}, ${flag.version}, ${flag.updatedAt}
        ) on conflict (key) do update set
          description = excluded.description,
          enabled = excluded.enabled,
          kill_switch_reason = excluded.kill_switch_reason,
          owner = excluded.owner,
          version = excluded.version,
          updated_at = excluded.updated_at
      `;
      const latest = flag.changeLog.at(-1);
      if (latest) {
        await sql`
          insert into public.feature_flag_changes (
            flag_key, version, changed_at, changed_by, summary
          ) values (
            ${flag.key}, ${latest.version}, ${latest.changedAt},
            ${latest.changedBy}, ${latest.summary}
          ) on conflict (flag_key, version) do nothing
        `;
      }
    });
    return flag;
  }

  async getFeatureFlag(key: string): Promise<FeatureFlag | null> {
    const [row] = await this.#sql<Row[]>`
      select * from public.feature_flags where key = ${key}
    `;
    if (!row) return null;
    const changes = await this.#sql<Row[]>`
      select * from public.feature_flag_changes
      where flag_key = ${key} order by version
    `;
    return mapFeatureFlag(row, changes);
  }

  async listFeatureFlags(): Promise<FeatureFlag[]> {
    const [flags, changes] = await Promise.all([
      this.#sql<Row[]>`select * from public.feature_flags order by key`,
      this.#sql<
        Row[]
      >`select * from public.feature_flag_changes order by flag_key, version`,
    ]);
    return flags.map((flag) =>
      mapFeatureFlag(
        flag,
        changes.filter((change) => change.flag_key === flag.key),
      ),
    );
  }

  async createProductionRelease(
    release: ProductionRelease,
  ): Promise<ProductionRelease> {
    const [row] = await this.#sql<Row[]>`
      insert into public.production_releases (
        id, version, target, summary, connector_ids, evidence, status,
        created_by, approval_actor_ids, rejection_reason, created_at,
        updated_at, approved_at, deployed_at
      ) values (
        ${release.id}::uuid, ${release.version}, ${release.target}, ${release.summary},
        ${this.#sql.array(release.connectorIds)}, ${this.#sql.json(release.evidence)},
        ${release.status}, ${release.createdBy},
        ${this.#sql.array(release.approvalActorIds)}, ${release.rejectionReason},
        ${release.createdAt}, ${release.updatedAt}, ${release.approvedAt},
        ${release.deployedAt}
      ) returning *
    `;
    if (!row) throw new Error("Production release insert failed");
    return mapProductionRelease(row);
  }

  async getProductionRelease(
    releaseId: string,
  ): Promise<ProductionRelease | null> {
    const [row] = await this.#sql<Row[]>`
      select * from public.production_releases where id = ${releaseId}::uuid
    `;
    return row ? mapProductionRelease(row) : null;
  }

  async listProductionReleases(limit: number): Promise<ProductionRelease[]> {
    const rows = await this.#sql<Row[]>`
      select * from public.production_releases
      order by updated_at desc limit ${limit}
    `;
    return rows.map(mapProductionRelease);
  }

  async saveProductionRelease(
    release: ProductionRelease,
  ): Promise<ProductionRelease> {
    const [row] = await this.#sql<Row[]>`
      update public.production_releases set
        version = ${release.version}, target = ${release.target},
        summary = ${release.summary},
        connector_ids = ${this.#sql.array(release.connectorIds)},
        evidence = ${this.#sql.json(release.evidence)},
        status = ${release.status},
        approval_actor_ids = ${this.#sql.array(release.approvalActorIds)},
        rejection_reason = ${release.rejectionReason},
        updated_at = ${release.updatedAt}, approved_at = ${release.approvedAt},
        deployed_at = ${release.deployedAt}
      where id = ${release.id}::uuid returning *
    `;
    if (!row) throw new Error("Production release not found");
    return mapProductionRelease(row);
  }

  async createPublishingJob(
    job: PublishingJob,
  ): Promise<{ job: PublishingJob; created: boolean }> {
    const rows = await this.#sql<Row[]>`
      insert into public.publishing_jobs (
        id, household_id, item_id, platform, listing_version, idempotency_key,
        current_state, last_verified_state, resume_state, retry_count, max_retries,
        next_retry_at, device_id, connector_version, platform_app_version,
        command_action, command_expires_at,
        error_code, error_detail, created_at, started_at, completed_at, updated_at
      ) values (
        ${job.id}::uuid, ${job.householdId}::uuid, ${job.itemId}::uuid, ${job.platform},
        ${job.listingVersion}, ${job.idempotencyKey}, ${job.currentState}, ${job.lastVerifiedState},
        ${job.resumeState}, ${job.retryCount}, ${job.maxRetries}, ${job.nextRetryAt},
        ${job.deviceId}::uuid, ${job.connectorVersion}, ${job.platformAppVersion},
        ${job.commandAction}, ${job.commandExpiresAt},
        ${job.errorCode}, ${job.errorDetail}, ${job.createdAt}, ${job.startedAt},
        ${job.completedAt}, ${job.updatedAt}
      ) on conflict (idempotency_key) do nothing returning *
    `;
    const created = rows[0];
    if (created) return { job: mapJob(created), created: true };
    const [existing] = await this.#sql<Row[]>`
      select * from public.publishing_jobs where idempotency_key = ${job.idempotencyKey}
    `;
    if (!existing) throw new Error("Idempotent job lookup failed");
    return { job: mapJob(existing), created: false };
  }

  async getPublishingJobByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<PublishingJob | null> {
    const [row] = await this.#sql<Row[]>`
      select * from public.publishing_jobs where idempotency_key = ${idempotencyKey}
    `;
    return row ? mapJob(row) : null;
  }

  async countPublishingJobs(
    householdId: string,
    platform: string,
    since: string,
    commandAction?: PublishingJob["commandAction"],
  ): Promise<number> {
    const [row] = commandAction
      ? await this.#sql<Row[]>`
          select count(*)::integer as count from public.publishing_jobs
          where household_id = ${householdId}::uuid
            and lower(platform) = lower(${platform}) and created_at >= ${since}
            and command_action = ${commandAction}
        `
      : await this.#sql<Row[]>`
          select count(*)::integer as count from public.publishing_jobs
          where household_id = ${householdId}::uuid
            and lower(platform) = lower(${platform}) and created_at >= ${since}
        `;
    return Number(row?.count ?? 0);
  }

  async claimRunnableServerJobs(input: {
    workerId: string;
    now: string;
    leaseExpiresAt: string;
    limit: number;
  }): Promise<PublishingJob[]> {
    const rows = await this.#sql<Row[]>`
      with candidates as (
        select id from public.publishing_jobs
        where device_id is null
          and (
            current_state = 'QUEUED'
            or (
              current_state = 'FAILED_RETRYABLE'
              and next_retry_at is not null and next_retry_at <= ${input.now}
            )
          )
          and (lease_expires_at is null or lease_expires_at <= ${input.now})
        order by created_at
        for update skip locked
        limit ${input.limit}
      )
      update public.publishing_jobs job set
        lease_owner = ${input.workerId}, lease_expires_at = ${input.leaseExpiresAt}
      from candidates where job.id = candidates.id
      returning job.*
    `;
    return rows.map(mapJob);
  }

  async releasePublishingJobLease(
    jobId: string,
    workerId: string,
  ): Promise<void> {
    await this.#sql`
      update public.publishing_jobs set lease_owner = null, lease_expires_at = null
      where id = ${jobId}::uuid and lease_owner = ${workerId}
    `;
  }

  async getPublishingJob(
    householdId: string,
    jobId: string,
  ): Promise<JobWithTransitions | null> {
    const [row] = await this.#sql<Row[]>`
      select * from public.publishing_jobs
      where household_id = ${householdId}::uuid and id = ${jobId}::uuid
    `;
    if (!row) return null;
    const transitions = await this.#sql<Row[]>`
      select * from public.publishing_job_transitions
      where publishing_job_id = ${jobId}::uuid order by id
    `;
    return { job: mapJob(row), transitions: transitions.map(mapTransition) };
  }

  async savePublishingTransition(
    job: PublishingJob,
    transition: PublishingTransition,
  ): Promise<void> {
    await this.#sql.begin(async (sql) => {
      const updated = await sql<Row[]>`
        update public.publishing_jobs set
          current_state = ${job.currentState}, last_verified_state = ${job.lastVerifiedState},
          resume_state = ${job.resumeState}, retry_count = ${job.retryCount},
          next_retry_at = ${job.nextRetryAt}, error_code = ${job.errorCode},
          error_detail = ${job.errorDetail}, started_at = ${job.startedAt},
          completed_at = ${job.completedAt}, updated_at = ${job.updatedAt}
        where id = ${job.id}::uuid and current_state = ${transition.from}
        returning id
      `;
      if (updated.length !== 1)
        throw new Error("Publishing job changed concurrently");
      await sql`
        insert into public.publishing_job_transitions (
          publishing_job_id, household_id, from_state, to_state, event, reason_code, occurred_at
        ) values (
          ${job.id}::uuid, ${job.householdId}::uuid, ${transition.from}, ${transition.to},
          ${transition.event}, ${transition.reasonCode}, ${transition.occurredAt}
        )
      `;
    });
  }

  async upsertListingExportArtifact(
    artifact: ListingExportArtifact,
  ): Promise<ListingExportArtifact> {
    const [row] = await this.#sql<Row[]>`
      insert into public.listing_export_artifacts (
        id, household_id, item_id, publishing_job_id, platform, format,
        payload, created_at, expires_at, consumed_at
      ) values (
        ${artifact.id}::uuid, ${artifact.householdId}::uuid,
        ${artifact.itemId}::uuid, ${artifact.publishingJobId}::uuid,
        ${artifact.platform}, ${artifact.format},
        ${this.#sql.json(artifact.payload as postgres.JSONValue)}, ${artifact.createdAt},
        ${artifact.expiresAt}, ${artifact.consumedAt}
      ) on conflict (publishing_job_id) do update set
        payload = excluded.payload, expires_at = excluded.expires_at
      returning *
    `;
    if (!row) throw new Error("Listing export artifact upsert failed");
    return mapListingExportArtifact(row);
  }

  async getListingExportArtifact(
    householdId: string,
    publishingJobId: string,
  ): Promise<ListingExportArtifact | null> {
    const [row] = await this.#sql<Row[]>`
      select * from public.listing_export_artifacts
      where household_id = ${householdId}::uuid
        and publishing_job_id = ${publishingJobId}::uuid
    `;
    return row ? mapListingExportArtifact(row) : null;
  }

  async consumeListingExportArtifact(
    householdId: string,
    publishingJobId: string,
    consumedAt: string,
  ): Promise<boolean> {
    const rows = await this.#sql<Row[]>`
      update public.listing_export_artifacts set consumed_at = ${consumedAt}
      where household_id = ${householdId}::uuid
        and publishing_job_id = ${publishingJobId}::uuid
        and consumed_at is null and expires_at > ${consumedAt}
      returning id
    `;
    return rows.length === 1;
  }

  async listPlatformListings(itemId: string): Promise<PlatformListing[]> {
    const rows = await this.#sql<Row[]>`
      select * from public.platform_listings where item_id = ${itemId}::uuid order by platform
    `;
    return rows.map(mapPlatformListing);
  }

  async getPlatformListing(
    householdId: string,
    platformListingId: string,
  ): Promise<PlatformListing | null> {
    const [row] = await this.#sql<Row[]>`
      select * from public.platform_listings
      where household_id = ${householdId}::uuid and id = ${platformListingId}::uuid
    `;
    return row ? mapPlatformListing(row) : null;
  }

  async upsertPlatformListing(
    listing: PlatformListing,
    householdId: string,
  ): Promise<PlatformListing> {
    const [row] = await this.#sql<Row[]>`
      insert into public.platform_listings (
        id, household_id, item_id, platform, external_listing_id, external_url,
        platform_title, platform_price_cents, currency, status, published_at,
        last_synchronized_at, connector_version
      ) values (
        ${listing.id}::uuid, ${householdId}::uuid, ${listing.itemId}::uuid, ${listing.platform},
        ${listing.externalListingId}, ${listing.externalUrl}, ${listing.platformTitle},
        ${listing.platformPrice.amountCents}, ${listing.platformPrice.currency}, ${listing.status},
        ${listing.publishedAt}, ${listing.lastSynchronizedAt}, ${listing.connectorVersion}
      ) on conflict (id) do update set
        external_listing_id = excluded.external_listing_id, external_url = excluded.external_url,
        platform_title = excluded.platform_title, platform_price_cents = excluded.platform_price_cents,
        currency = excluded.currency, status = excluded.status,
        published_at = excluded.published_at,
        last_synchronized_at = excluded.last_synchronized_at,
        connector_version = excluded.connector_version
      returning *
    `;
    if (!row) throw new Error("Platform listing upsert failed");
    return mapPlatformListing(row);
  }

  async createOutcome(outcome: ItemOutcome): Promise<ItemOutcome> {
    await this.#sql`
      insert into public.item_outcomes (
        id, household_id, item_id, outcome, sale_price_cents, currency,
        destination_platform, days_to_clear, notes, cleared_at
      ) values (
        ${outcome.id}::uuid, ${outcome.householdId}::uuid, ${outcome.itemId}::uuid,
        ${outcome.outcome}, ${outcome.salePriceCents}, ${outcome.currency},
        ${outcome.destinationPlatform}, ${outcome.daysToClear}, ${outcome.notes}, ${outcome.clearedAt}
      )
    `;
    return outcome;
  }

  async createExceptionTask(task: ExceptionTask): Promise<ExceptionTask> {
    await this.#sql`
      insert into public.exception_tasks (
        id, household_id, item_id, kind, title, details, status, created_at, resolved_at
      ) values (
        ${task.id}::uuid, ${task.householdId}::uuid, ${task.itemId}::uuid, ${task.kind},
        ${task.title}, ${this.#sql.json(task.details as postgres.JSONValue)}, ${task.status},
        ${task.createdAt}, ${task.resolvedAt}
      )
    `;
    return task;
  }

  async listExceptionTasks(householdId: string): Promise<ExceptionTask[]> {
    const rows = await this.#sql<Row[]>`
      select * from public.exception_tasks
      where household_id = ${householdId}::uuid order by created_at desc
    `;
    return rows.map(mapExceptionTask);
  }

  async createBuyerTask(
    task: BuyerTask,
    householdId: string,
  ): Promise<BuyerTask> {
    await this.#sql`
      insert into public.buyer_tasks (
        id, household_id, platform_listing_id, participant_alias, intent,
        redacted_message_excerpt, suggested_response, approval_state,
        price_offer_cents, currency, scheduling_state, requires_address_approval,
        scam_signals, created_at
      ) values (
        ${task.id}::uuid, ${householdId}::uuid, ${task.platformListingId}::uuid,
        ${task.participantAlias}, ${task.intent}, ${task.redactedMessageExcerpt},
        ${task.suggestedResponse}, ${task.approvalState}, ${task.priceOffer?.amountCents ?? null},
        ${task.priceOffer?.currency ?? null}, ${task.schedulingState},
        ${task.requiresAddressApproval}, ${this.#sql.array(task.scamSignals)}, ${task.createdAt}
      )
    `;
    return task;
  }

  async getBuyerTask(
    householdId: string,
    taskId: string,
  ): Promise<BuyerTask | null> {
    const [row] = await this.#sql<Row[]>`
      select * from public.buyer_tasks
      where household_id = ${householdId}::uuid and id = ${taskId}::uuid
    `;
    return row ? mapBuyerTask(row) : null;
  }

  async saveBuyerTask(
    task: BuyerTask,
    householdId: string,
  ): Promise<BuyerTask> {
    const rows = await this.#sql<Row[]>`
      update public.buyer_tasks set
        suggested_response = ${task.suggestedResponse},
        approval_state = ${task.approvalState},
        scheduling_state = ${task.schedulingState},
        requires_address_approval = ${task.requiresAddressApproval},
        updated_at = now()
      where household_id = ${householdId}::uuid and id = ${task.id}::uuid
      returning *
    `;
    const row = rows[0];
    if (!row) throw new Error("Buyer task not found");
    return mapBuyerTask(row);
  }

  async listBuyerTasks(householdId: string): Promise<BuyerTask[]> {
    const rows = await this.#sql<Row[]>`
      select task.*
      from public.buyer_tasks task
      join public.platform_listings listing on listing.id = task.platform_listing_id
      where task.household_id = ${householdId}::uuid
      order by task.created_at desc
    `;
    return rows.map(mapBuyerTask);
  }

  async createMeetup(meetup: Meetup, householdId: string): Promise<Meetup> {
    const [row] = await this.#sql<Row[]>`
      insert into public.meetups (
        id, household_id, item_id, platform_listing_id, buyer_alias,
        scheduled_at, location_type, approved_location,
        exact_address_approved_at, status
      ) values (
        ${meetup.id}::uuid, ${householdId}::uuid, ${meetup.itemId}::uuid,
        ${meetup.platformListingId}::uuid, ${meetup.buyerAlias},
        ${meetup.scheduledAt}, ${meetup.locationType}, ${meetup.approvedLocation},
        ${meetup.exactAddressApprovedAt}, ${meetup.status}
      ) returning *
    `;
    if (!row) throw new Error("Meetup insert failed");
    return mapMeetup(row);
  }

  async listMeetups(householdId: string): Promise<Meetup[]> {
    const rows = await this.#sql<Row[]>`
      select * from public.meetups
      where household_id = ${householdId}::uuid
      order by scheduled_at, created_at
    `;
    return rows.map(mapMeetup);
  }

  async saveMeetup(meetup: Meetup, householdId: string): Promise<Meetup> {
    const [row] = await this.#sql<Row[]>`
      update public.meetups set
        scheduled_at = ${meetup.scheduledAt},
        location_type = ${meetup.locationType},
        approved_location = ${meetup.approvedLocation},
        exact_address_approved_at = ${meetup.exactAddressApprovedAt},
        status = ${meetup.status}, updated_at = now()
      where id = ${meetup.id}::uuid and household_id = ${householdId}::uuid
      returning *
    `;
    if (!row) throw new Error("Meetup not found");
    return mapMeetup(row);
  }

  async enqueueBackupBuyer(entry: BackupBuyerEntry): Promise<BackupBuyerEntry> {
    const [row] = await this.#sql<Row[]>`
      insert into public.buyer_backup_queue (
        id, household_id, item_id, platform_listing_id, buyer_task_id,
        participant_alias, position, status, created_at, updated_at
      ) values (
        ${entry.id}::uuid, ${entry.householdId}::uuid, ${entry.itemId}::uuid,
        ${entry.platformListingId}::uuid, ${entry.buyerTaskId}::uuid,
        ${entry.participantAlias}, ${entry.position}, ${entry.status},
        ${entry.createdAt}, ${entry.updatedAt}
      ) on conflict (item_id, buyer_task_id) do update set
        status = case
          when public.buyer_backup_queue.status = 'removed'
            then excluded.status
          else public.buyer_backup_queue.status
        end,
        updated_at = excluded.updated_at
      returning *
    `;
    if (!row) throw new Error("Backup buyer insert failed");
    return mapBackupBuyer(row);
  }

  async listBackupBuyers(
    householdId: string,
    itemId: string,
  ): Promise<BackupBuyerEntry[]> {
    const rows = await this.#sql<Row[]>`
      select * from public.buyer_backup_queue
      where household_id = ${householdId}::uuid
        and item_id = ${itemId}::uuid and status <> 'removed'
      order by position, created_at
    `;
    return rows.map(mapBackupBuyer);
  }

  async saveBackupBuyer(entry: BackupBuyerEntry): Promise<BackupBuyerEntry> {
    const [row] = await this.#sql<Row[]>`
      update public.buyer_backup_queue set
        position = ${entry.position}, status = ${entry.status},
        updated_at = ${entry.updatedAt}
      where id = ${entry.id}::uuid and household_id = ${entry.householdId}::uuid
      returning *
    `;
    if (!row) throw new Error("Backup buyer not found");
    return mapBackupBuyer(row);
  }

  async createNotification(
    notification: UserNotification,
  ): Promise<UserNotification> {
    const [row] = await this.#sql<Row[]>`
      insert into public.user_notifications (
        id, household_id, user_id, type, title, body, action_path,
        delivery_state, delivery_attempts, next_delivery_at,
        provider_ticket_ids, read_at, created_at
      ) values (
        ${notification.id}::uuid, ${notification.householdId}::uuid,
        ${notification.userId}::uuid, ${notification.type}, ${notification.title},
        ${notification.body}, ${notification.actionPath}, ${notification.deliveryState},
        ${notification.deliveryAttempts}, ${notification.nextDeliveryAt},
        ${this.#sql.array(notification.providerTicketIds)}, ${notification.readAt},
        ${notification.createdAt}
      ) returning *
    `;
    if (!row) throw new Error("Notification insert failed");
    return mapNotification(row);
  }

  async listNotifications(
    userId: string,
    householdId: string,
  ): Promise<UserNotification[]> {
    const rows = await this.#sql<Row[]>`
      select * from public.user_notifications
      where user_id = ${userId}::uuid and household_id = ${householdId}::uuid
      order by created_at desc limit 100
    `;
    return rows.map(mapNotification);
  }

  async markNotificationRead(
    userId: string,
    notificationId: string,
    readAt: string,
  ): Promise<UserNotification | null> {
    const [row] = await this.#sql<Row[]>`
      update public.user_notifications set read_at = ${readAt}
      where id = ${notificationId}::uuid and user_id = ${userId}::uuid
      returning *
    `;
    return row ? mapNotification(row) : null;
  }

  async upsertPushSubscription(
    subscription: PushSubscription,
  ): Promise<PushSubscription> {
    const [row] = await this.#sql<Row[]>`
      insert into public.push_subscriptions (
        id, user_id, expo_push_token, platform, enabled, created_at, updated_at
      ) values (
        ${subscription.id}::uuid, ${subscription.userId}::uuid,
        ${subscription.expoPushToken}, ${subscription.platform},
        ${subscription.enabled}, ${subscription.createdAt}, ${subscription.updatedAt}
      ) on conflict (expo_push_token) do update set
        user_id = excluded.user_id, platform = excluded.platform,
        enabled = excluded.enabled, updated_at = excluded.updated_at
      returning *
    `;
    if (!row) throw new Error("Push subscription upsert failed");
    return mapPushSubscription(row);
  }

  async listPushSubscriptions(userId: string): Promise<PushSubscription[]> {
    const rows = await this.#sql<Row[]>`
      select * from public.push_subscriptions
      where user_id = ${userId}::uuid and enabled
      order by updated_at desc
    `;
    return rows.map(mapPushSubscription);
  }

  async claimQueuedNotifications(input: {
    workerId: string;
    now: string;
    leaseExpiresAt: string;
    limit: number;
  }): Promise<UserNotification[]> {
    const rows = await this.#sql<Row[]>`
      with candidates as (
        select id from public.user_notifications
        where delivery_state = 'queued' and next_delivery_at <= ${input.now}
          and (lease_expires_at is null or lease_expires_at <= ${input.now})
        order by created_at
        for update skip locked
        limit ${input.limit}
      )
      update public.user_notifications notification set
        lease_owner = ${input.workerId}, lease_expires_at = ${input.leaseExpiresAt}
      from candidates where notification.id = candidates.id
      returning notification.*
    `;
    return rows.map(mapNotification);
  }

  async completeNotificationDelivery(input: {
    notificationId: string;
    workerId: string;
    state: UserNotification["deliveryState"];
    providerTicketIds: string[];
    nextDeliveryAt: string;
  }): Promise<void> {
    await this.#sql`
      update public.user_notifications set
        delivery_state = ${input.state},
        delivery_attempts = delivery_attempts + 1,
        provider_ticket_ids = ${this.#sql.array(input.providerTicketIds)},
        next_delivery_at = ${input.nextDeliveryAt},
        lease_owner = null, lease_expires_at = null
      where id = ${input.notificationId}::uuid and lease_owner = ${input.workerId}
    `;
  }

  async createSupportGrant(
    grant: SupportAccessGrant,
  ): Promise<SupportAccessGrant> {
    const [row] = await this.#sql<Row[]>`
      insert into public.support_access_grants (
        id, household_id, granted_by, support_actor_id, reason_code, scope,
        diagnostic_consent, expires_at, revoked_at, created_at
      ) values (
        ${grant.id}::uuid, ${grant.householdId}::uuid, ${grant.grantedBy}::uuid,
        ${grant.supportActorId}, ${grant.reasonCode}, ${this.#sql.array(grant.scope)},
        ${grant.diagnosticConsent}, ${grant.expiresAt}, ${grant.revokedAt},
        ${grant.createdAt}
      ) returning *
    `;
    if (!row) throw new Error("Support grant insert failed");
    return mapSupportGrant(row);
  }

  async getSupportGrant(grantId: string): Promise<SupportAccessGrant | null> {
    const [row] = await this.#sql<Row[]>`
      select * from public.support_access_grants where id = ${grantId}::uuid
    `;
    return row ? mapSupportGrant(row) : null;
  }

  async listSupportGrants(householdId: string): Promise<SupportAccessGrant[]> {
    const rows = await this.#sql<Row[]>`
      select * from public.support_access_grants
      where household_id = ${householdId}::uuid order by created_at desc
    `;
    return rows.map(mapSupportGrant);
  }

  async listActiveSupportGrantsForActor(
    actorId: string,
    now: string,
  ): Promise<SupportAccessGrant[]> {
    const rows = await this.#sql<Row[]>`
      select * from public.support_access_grants
      where support_actor_id = ${actorId} and revoked_at is null
        and expires_at > ${now}
      order by expires_at
    `;
    return rows.map(mapSupportGrant);
  }

  async revokeSupportGrant(
    householdId: string,
    grantId: string,
    revokedAt: string,
  ): Promise<SupportAccessGrant | null> {
    const [row] = await this.#sql<Row[]>`
      update public.support_access_grants set revoked_at = ${revokedAt}
      where id = ${grantId}::uuid and household_id = ${householdId}::uuid
        and revoked_at is null
      returning *
    `;
    return row ? mapSupportGrant(row) : null;
  }

  async createDiagnosticArtifact(
    artifact: DiagnosticArtifact,
  ): Promise<DiagnosticArtifact> {
    const [row] = await this.#sql<Row[]>`
      insert into public.diagnostic_artifacts (
        id, household_id, grant_id, submitted_by, kind, storage_path,
        content_sha256, redacted, privacy_scan_passed, consented_at, created_at
      ) values (
        ${artifact.id}::uuid, ${artifact.householdId}::uuid,
        ${artifact.grantId}::uuid, ${artifact.submittedBy}::uuid,
        ${artifact.kind}, ${artifact.storagePath}, ${artifact.contentSha256},
        ${artifact.redacted}, ${artifact.privacyScanPassed},
        ${artifact.consentedAt}, ${artifact.createdAt}
      ) returning *
    `;
    if (!row) throw new Error("Diagnostic artifact insert failed");
    return mapDiagnosticArtifact(row);
  }

  async listDiagnosticArtifacts(
    grantId: string,
  ): Promise<DiagnosticArtifact[]> {
    const rows = await this.#sql<Row[]>`
      select * from public.diagnostic_artifacts
      where grant_id = ${grantId}::uuid order by created_at desc
    `;
    return rows.map(mapDiagnosticArtifact);
  }

  async listExpiredDiagnosticArtifacts(
    now: string,
  ): Promise<DiagnosticArtifact[]> {
    const rows = await this.#sql<Row[]>`
      select artifact.* from public.diagnostic_artifacts artifact
      join public.support_access_grants grant_row on grant_row.id = artifact.grant_id
      where grant_row.expires_at <= ${now}
        or (grant_row.revoked_at is not null and grant_row.revoked_at <= ${now})
      order by artifact.created_at
    `;
    return rows.map(mapDiagnosticArtifact);
  }

  async purgeExpiredEphemeralData(
    now: string,
    diagnosticArtifactIds: readonly string[],
  ): Promise<EphemeralPurgeResult> {
    return this.#sql.begin(async (sql) => {
      const diagnostics =
        diagnosticArtifactIds.length === 0
          ? []
          : await sql<Row[]>`
              delete from public.diagnostic_artifacts
              where id in ${sql(diagnosticArtifactIds)} returning id
            `;
      const exports = await sql<Row[]>`
        delete from public.listing_export_artifacts
        where expires_at <= ${now} or consumed_at is not null returning id
      `;
      const commands = await sql<Row[]>`
        delete from public.issued_device_commands
        where expires_at <= ${now} returning job_id
      `;
      const challenges = await sql<Row[]>`
        delete from public.device_pairing_challenges
        where expires_at <= ${now} or consumed_at is not null returning id
      `;
      const nonces = await sql<Row[]>`
        delete from public.device_command_nonces
        where expires_at <= ${now} returning device_id
      `;
      return {
        diagnosticArtifacts: diagnostics.length,
        listingExportArtifacts: exports.length,
        issuedDeviceCommands: commands.length,
        pairingChallenges: challenges.length,
        deviceNonces: nonces.length,
      };
    });
  }

  async getRedactedSupportSnapshot(
    householdId: string,
  ): Promise<RedactedSupportSnapshot> {
    const [devices, jobs] = await Promise.all([
      this.#sql<Row[]>`
        select id, display_name, connection_status, app_version,
          android_version, battery_percent, network_type, last_check_in_at
        from public.seller_devices where household_id = ${householdId}::uuid
        order by created_at
      `,
      this.#sql<Row[]>`
        select id, item_id, platform, current_state, error_code,
          connector_version, retry_count, updated_at
        from public.publishing_jobs where household_id = ${householdId}::uuid
        order by updated_at desc limit 100
      `,
    ]);
    return {
      devices: devices.map((row) => ({
        id: String(row.id),
        displayName: row.display_name,
        connectionStatus: row.connection_status,
        appVersion: row.app_version,
        androidVersion: row.android_version,
        batteryPercent: row.battery_percent,
        networkType: row.network_type,
        lastCheckInAt: nullableIso(row.last_check_in_at),
      })),
      jobs: jobs.map((row) => ({
        id: String(row.id),
        itemId: String(row.item_id),
        platform: row.platform,
        currentState: row.current_state,
        errorCode: row.error_code,
        connectorVersion: row.connector_version,
        retryCount: row.retry_count,
        updatedAt: iso(row.updated_at),
      })),
    } as RedactedSupportSnapshot;
  }

  async createAuditEvent(
    event: AuditEvent,
    householdId: string | null,
  ): Promise<void> {
    await this.#sql`
      insert into public.audit_events (
        id, household_id, actor_id, actor_type, action, object_type,
        object_id, device_id, redacted_metadata, created_at
      ) values (
        ${event.id}::uuid, ${householdId}::uuid, ${event.actorId}, ${event.actorType},
        ${event.action}, ${event.objectType}, ${event.objectId}, ${event.deviceId}::uuid,
        ${this.#sql.json(event.redactedMetadata as postgres.JSONValue)}, ${event.timestamp}
      )
    `;
  }

  async #connectorChanges(connectorId: string): Promise<Row[]> {
    return this.#sql<Row[]>`
      select * from public.connector_changes
      where connector_id = ${connectorId} order by changed_at
    `;
  }
}

async function insertItem(
  sql: postgres.TransactionSql,
  item: StoredItem,
): Promise<void> {
  await sql`
    insert into public.items (
      id, household_id, title, category, brand, model, condition, dimensions,
      specifications, accessories, defects, storage_location, identification,
      identification_confidence, clearing_recommendation, status,
      image_fingerprint, barcode, created_at, updated_at
    ) values (
      ${item.id}::uuid, ${item.householdId}::uuid, ${item.title}, ${item.category},
      ${item.brand}, ${item.model}, ${item.condition}, ${sql.json(item.dimensions)},
      ${sql.json(item.specifications)}, ${sql.array(item.accessories)},
      ${sql.array(item.defects)}, ${item.storageLocation}, ${sql.json(item.identification)},
      ${item.identification.confidence}, ${item.clearingRecommendation}, ${item.status},
      ${item.imageFingerprint}, ${item.barcode}, ${item.createdAt}, ${item.updatedAt}
    )
  `;
  for (const asset of item.media) {
    await sql`
      insert into public.media_assets (
        id, household_id, item_id, storage_path, content_sha256, media_type, display_order,
        is_lead, quality_issues, redaction_state, source, exif_location_stripped,
        retention_state, created_at
      ) values (
        ${asset.id}::uuid, ${item.householdId}::uuid, ${item.id}::uuid,
        ${asset.storagePath}, ${asset.contentSha256}, ${asset.mediaType}, ${asset.order}, ${asset.isLead},
        ${sql.array(asset.qualityIssues)}, ${asset.redactionState}, ${asset.source},
        ${asset.exifLocationStripped}, ${asset.retentionState}, ${asset.createdAt}
      )
    `;
  }
}

function mapHousehold(row: Row): Household {
  return HouseholdSchema.parse({
    id: String(row.id),
    ownerId: String(row.owner_id),
    name: row.name,
    goal: row.goal,
    zipCode: row.zip_code,
    sellingRadiusMiles: row.selling_radius_miles,
    exchangePreferences: row.exchange_preferences,
    paymentWording: row.payment_wording,
    availability: row.availability,
    preferredMeetupLocations: row.preferred_meetup_locations,
    priceRules: row.price_rules,
    timezone: row.timezone ?? "UTC",
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function mapSellerDevice(row: Row): SellerDevice {
  return SellerDeviceSchema.parse({
    id: String(row.id),
    householdId: String(row.household_id),
    displayName: row.display_name,
    publicKey: row.public_key,
    androidVersion: row.android_version,
    appVersion: row.app_version,
    isPrimary: row.is_primary,
    connectionStatus: row.connection_status,
    batteryPercent: row.battery_percent,
    isCharging: row.is_charging,
    networkType: row.network_type,
    lastCheckInAt: nullableIso(row.last_check_in_at),
    capabilities: row.capabilities,
    revokedAt: nullableIso(row.revoked_at),
  });
}

function mapPlatformConnection(row: Row): PlatformConnection {
  return PlatformConnectionSchema.parse({
    id: String(row.id),
    sellerDeviceId: row.seller_device_id ? String(row.seller_device_id) : null,
    platform: row.platform,
    appVersion: row.app_version,
    displayAlias: row.display_alias,
    connectionStatus: row.connection_status,
    lastVerifiedAt: nullableIso(row.last_verified_at),
    supportedCapabilities: row.supported_capabilities,
    policyStatus: row.policy_status,
  });
}

function mapItem(row: Row, mediaRows: readonly Row[]): StoredItem {
  const item = ItemSchema.parse({
    id: String(row.id),
    householdId: String(row.household_id),
    title: row.title,
    category: row.category,
    brand: row.brand,
    model: row.model,
    condition: row.condition,
    dimensions: row.dimensions,
    specifications: row.specifications,
    accessories: row.accessories,
    defects: row.defects,
    storageLocation: row.storage_location,
    identification: row.identification,
    clearingRecommendation: row.clearing_recommendation,
    status: row.status,
    media: mediaRows.map((media) => ({
      id: String(media.id),
      itemId: String(media.item_id),
      storagePath: media.storage_path,
      contentSha256: media.content_sha256,
      mediaType: media.media_type,
      order: media.display_order,
      isLead: media.is_lead,
      qualityIssues: media.quality_issues,
      redactionState: media.redaction_state,
      source: media.source,
      exifLocationStripped: media.exif_location_stripped,
      retentionState: media.retention_state,
      createdAt: iso(media.created_at),
    })),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
  return {
    ...item,
    barcode: row.barcode,
    imageFingerprint: row.image_fingerprint,
  };
}

function mapListing(row: Row): CanonicalListing {
  return CanonicalListingSchema.parse({
    id: String(row.id),
    itemId: String(row.item_id),
    version: row.version,
    title: row.title,
    description: row.description,
    conditionSummary: row.condition_summary,
    specifications: row.specifications,
    priceStrategy: row.price_strategy,
    askingPrice: {
      amountCents: row.asking_price_cents,
      currency: row.currency,
    },
    minimumPrice: {
      amountCents: row.minimum_price_cents,
      currency: row.currency,
    },
    location: row.approximate_location,
    exchangeOptions: row.exchange_options,
    paymentWording: row.payment_wording,
    negotiationRules: row.negotiation_rules,
    restrictedItemStatus: row.restricted_item_status,
    restrictedItemReasons: row.restricted_item_reasons,
    approvedAt: nullableIso(row.approved_at),
    createdAt: iso(row.created_at),
  });
}

function mapConnector(row: Row, changes: readonly Row[]): ConnectorManifest {
  return ConnectorManifestSchema.parse({
    id: row.id,
    platform: row.platform,
    kind: row.kind,
    version: row.version,
    definitionVersion: row.definition_version,
    enabled: row.enabled,
    killSwitchReason: row.kill_switch_reason,
    policyStatus: row.policy_status,
    productionMethod: row.production_method,
    approvalEvidenceUrl: row.approval_evidence_url,
    policyReviewedAt: nullableIso(row.policy_reviewed_at),
    owner: row.owner,
    capabilities: row.capabilities,
    supportedAppVersions: row.supported_app_versions,
    requiredFields: row.required_fields,
    categoryMappings: row.category_mappings,
    fieldMappings: row.field_mappings ?? {},
    titleMaxLength: row.title_max_length ?? 100,
    descriptionMaxLength: row.description_max_length ?? 5_000,
    rateLimitPerMinute: row.rate_limit_per_minute,
    dailyListingCap: row.daily_listing_cap,
    canaryTestId: row.canary_test_id,
    changeLog: changes.map((change) => ({
      version: change.version,
      changedAt: iso(change.changed_at),
      changedBy: change.changed_by,
      summary: change.summary,
    })),
  });
}

function mapFeatureFlag(row: Row, changes: readonly Row[]): FeatureFlag {
  return FeatureFlagSchema.parse({
    key: row.key,
    description: row.description,
    enabled: row.enabled,
    killSwitchReason: row.kill_switch_reason,
    owner: row.owner,
    version: row.version,
    updatedAt: iso(row.updated_at),
    changeLog: changes.map((change) => ({
      version: change.version,
      changedAt: iso(change.changed_at),
      changedBy: change.changed_by,
      summary: change.summary,
    })),
  });
}

function mapProductionRelease(row: Row): ProductionRelease {
  return ProductionReleaseSchema.parse({
    id: String(row.id),
    version: row.version,
    target: row.target,
    summary: row.summary,
    connectorIds: row.connector_ids,
    evidence: row.evidence,
    status: row.status,
    createdBy: row.created_by,
    approvalActorIds: row.approval_actor_ids,
    rejectionReason: row.rejection_reason,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    approvedAt: nullableIso(row.approved_at),
    deployedAt: nullableIso(row.deployed_at),
  });
}

function mapIssuedDeviceCommand(row: Row): IssuedDeviceCommand {
  return {
    deviceId: String(row.device_id),
    jobId: String(row.job_id),
    commandNonce: row.command_nonce,
    expiresAt: iso(row.expires_at),
    signedCommand: row.signed_command,
  } as IssuedDeviceCommand;
}

function mapItemEnrichment(row: Row): ItemEnrichment {
  return ItemEnrichmentSchema.parse({
    id: String(row.id),
    householdId: String(row.household_id),
    itemId: String(row.item_id),
    inputFingerprint: row.input_fingerprint,
    provider: row.provider,
    model: row.model,
    output: row.output,
    createdAt: iso(row.created_at),
  });
}

function mapJob(row: Row): PublishingJob {
  return PublishingJobSchema.parse({
    id: String(row.id),
    householdId: String(row.household_id),
    itemId: String(row.item_id),
    platform: row.platform,
    listingVersion: row.listing_version,
    commandAction: row.command_action,
    idempotencyKey: row.idempotency_key,
    currentState: row.current_state,
    lastVerifiedState: row.last_verified_state,
    resumeState: row.resume_state,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    nextRetryAt: nullableIso(row.next_retry_at),
    deviceId: row.device_id ? String(row.device_id) : null,
    connectorVersion: row.connector_version,
    platformAppVersion: row.platform_app_version,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    commandExpiresAt: iso(row.command_expires_at),
    createdAt: iso(row.created_at),
    startedAt: nullableIso(row.started_at),
    completedAt: nullableIso(row.completed_at),
    updatedAt: iso(row.updated_at),
  });
}

function mapTransition(row: Row): PublishingTransition {
  return {
    from: row.from_state,
    to: row.to_state,
    event: row.event,
    occurredAt: iso(row.occurred_at),
    reasonCode: row.reason_code,
  } as PublishingTransition;
}

function mapPlatformListing(row: Row): PlatformListing {
  return PlatformListingSchema.parse({
    id: String(row.id),
    itemId: String(row.item_id),
    platform: row.platform,
    externalListingId: row.external_listing_id,
    externalUrl: row.external_url,
    platformTitle: row.platform_title,
    platformPrice: {
      amountCents: row.platform_price_cents,
      currency: row.currency,
    },
    status: row.status,
    publishedAt: nullableIso(row.published_at),
    lastSynchronizedAt: nullableIso(row.last_synchronized_at),
    connectorVersion: row.connector_version,
  });
}

function mapPlatformListingVariant(row: Row): PlatformListingVariant {
  return PlatformListingVariantSchema.parse({
    id: String(row.id),
    householdId: String(row.household_id),
    itemId: String(row.item_id),
    listingVersion: row.listing_version,
    connectorId: row.connector_id,
    connectorVersion: row.connector_version,
    platform: row.platform,
    title: row.title,
    description: row.description,
    category: row.category,
    price: { amountCents: row.price_cents, currency: row.currency },
    fields: row.fields,
    generatedAt: iso(row.generated_at),
  });
}

function mapExceptionTask(row: Row): ExceptionTask {
  return {
    id: String(row.id),
    householdId: String(row.household_id),
    itemId: row.item_id ? String(row.item_id) : null,
    kind: row.kind,
    title: row.title,
    details: row.details,
    status: row.status,
    createdAt: iso(row.created_at),
    resolvedAt: nullableIso(row.resolved_at),
  } as ExceptionTask;
}

function mapBuyerTask(row: Row): BuyerTask {
  return {
    id: String(row.id),
    platformListingId: String(row.platform_listing_id),
    participantAlias: row.participant_alias,
    intent: row.intent,
    redactedMessageExcerpt: row.redacted_message_excerpt,
    suggestedResponse: row.suggested_response,
    approvalState: row.approval_state,
    priceOffer:
      row.price_offer_cents === null
        ? null
        : { amountCents: row.price_offer_cents, currency: row.currency },
    schedulingState: row.scheduling_state,
    requiresAddressApproval: row.requires_address_approval,
    scamSignals: row.scam_signals,
    createdAt: iso(row.created_at),
  } as BuyerTask;
}

function mapMeetup(row: Row): Meetup {
  return {
    id: String(row.id),
    itemId: String(row.item_id),
    platformListingId: String(row.platform_listing_id),
    buyerAlias: row.buyer_alias,
    scheduledAt: iso(row.scheduled_at),
    locationType: row.location_type,
    approvedLocation: row.approved_location,
    exactAddressApprovedAt: nullableIso(row.exact_address_approved_at),
    status: row.status,
  } as Meetup;
}

function mapBackupBuyer(row: Row): BackupBuyerEntry {
  return {
    id: String(row.id),
    householdId: String(row.household_id),
    itemId: String(row.item_id),
    platformListingId: String(row.platform_listing_id),
    buyerTaskId: String(row.buyer_task_id),
    participantAlias: row.participant_alias,
    position: row.position,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  } as BackupBuyerEntry;
}

function mapNotification(row: Row): UserNotification {
  return UserNotificationSchema.parse({
    id: String(row.id),
    householdId: String(row.household_id),
    userId: String(row.user_id),
    type: row.type,
    title: row.title,
    body: row.body,
    actionPath: row.action_path,
    deliveryState: row.delivery_state,
    deliveryAttempts: row.delivery_attempts,
    nextDeliveryAt: iso(row.next_delivery_at),
    providerTicketIds: row.provider_ticket_ids,
    readAt: nullableIso(row.read_at),
    createdAt: iso(row.created_at),
  });
}

function mapPushSubscription(row: Row): PushSubscription {
  return PushSubscriptionSchema.parse({
    id: String(row.id),
    userId: String(row.user_id),
    expoPushToken: row.expo_push_token,
    platform: row.platform,
    enabled: row.enabled,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function mapSupportGrant(row: Row): SupportAccessGrant {
  return {
    id: String(row.id),
    householdId: String(row.household_id),
    grantedBy: String(row.granted_by),
    supportActorId: row.support_actor_id,
    reasonCode: row.reason_code,
    scope: row.scope,
    diagnosticConsent: row.diagnostic_consent,
    expiresAt: iso(row.expires_at),
    revokedAt: nullableIso(row.revoked_at),
    createdAt: iso(row.created_at),
  } as SupportAccessGrant;
}

function mapDiagnosticArtifact(row: Row): DiagnosticArtifact {
  return DiagnosticArtifactSchema.parse({
    id: String(row.id),
    householdId: String(row.household_id),
    grantId: String(row.grant_id),
    submittedBy: String(row.submitted_by),
    kind: row.kind,
    storagePath: row.storage_path,
    contentSha256: row.content_sha256,
    redacted: row.redacted,
    privacyScanPassed: row.privacy_scan_passed,
    consentedAt: iso(row.consented_at),
    createdAt: iso(row.created_at),
  });
}

function mapListingExportArtifact(row: Row): ListingExportArtifact {
  return {
    id: String(row.id),
    householdId: String(row.household_id),
    itemId: String(row.item_id),
    publishingJobId: String(row.publishing_job_id),
    platform: row.platform,
    format: row.format,
    payload: row.payload,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    consumedAt: nullableIso(row.consumed_at),
  } as ListingExportArtifact;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new Error("Database timestamp is missing");
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}
