import type {
  BuyerTask,
  BuyerActionDraft,
  BackupBuyerEntry,
  BundleSuggestion,
  CanonicalListing,
  ClearingAdvice,
  ConnectorManifest,
  DiagnosticArtifact,
  Household,
  Item,
  ItemEnrichment,
  Meetup,
  PlatformListing,
  PlatformConnection,
  PublishingJob,
  PublishingTransition,
  PriceRecommendation,
  SellerDevice,
  SupportAccessGrant,
  UserNotification,
} from "@localclear/domain";
import { environment } from "./environment";
import { supabase } from "./supabase";

export interface MobileItem extends Item {
  barcode: string | null;
  imageFingerprint: string | null;
}

export interface ApiErrorPayload {
  error: string;
  message: string;
  details?: unknown;
  issues?: Array<{ path: string; message: string }>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface CaptureInput {
  title?: string;
  category?: string;
  brand?: string | null;
  model?: string | null;
  condition?: Item["condition"];
  dimensions?: Item["dimensions"];
  specifications?: Item["specifications"];
  accessories?: string[];
  defects?: string[];
  storageLocation?: string | null;
  clearingRecommendation?: Item["clearingRecommendation"];
  photos: Array<{
    storagePath: string;
    contentSha256: string;
    mediaType: "image/jpeg" | "image/png" | "image/webp";
    source: "camera" | "library" | "import";
    qualityIssues: string[];
  }>;
  barcode?: string | null;
  imageFingerprint?: string | null;
}
export type CapturePhotoInput = CaptureInput["photos"][number];

export interface HomeSummary {
  clearedThisMonth: number;
  recoveredCents: number;
  readyToList: number;
  buyerTasks: number;
  removalTasks: number;
}

export interface CreateHouseholdInput {
  name: string;
  goal: Household["goal"];
  zipCode: string;
  sellingRadiusMiles: number;
  exchangePreferences: Household["exchangePreferences"];
  paymentWording: Household["paymentWording"];
  availability: Household["availability"];
  preferredMeetupLocations: Array<
    Omit<Household["preferredMeetupLocations"][number], "id">
  >;
  priceRules: Household["priceRules"];
  timezone: string;
}

export interface JobDetails {
  job: PublishingJob;
  transitions: PublishingTransition[];
}

class LocalClearApi {
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new ApiError(401, "unauthorized", "Sign in to continue");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(new URL(path, environment.apiUrl), {
        ...init,
        signal: controller.signal,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      });
      const payload = (await response.json()) as unknown;
      if (!response.ok) {
        const error = payload as ApiErrorPayload;
        throw new ApiError(
          response.status,
          error.error ?? "request_failed",
          error.message ?? "The request could not be completed",
          error.details ?? error.issues,
        );
      }
      return payload as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new ApiError(
          408,
          "timeout",
          "LocalClear is taking too long. Try again.",
        );
      }
      throw new ApiError(
        0,
        "network_error",
        "Check your connection and try again.",
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  listHouseholds() {
    return this.request<{ households: Household[] }>("/v1/households");
  }

  exportAccount() {
    return this.request<{ export: Record<string, unknown> }>(
      "/v1/account/export",
    );
  }

  deleteAccount() {
    return this.request<{
      receipt: {
        receiptId: string;
        requestId: string;
        subjectHash: string;
        completedAt: string;
      };
      revokedDeviceCount: number;
      cancelledJobCount: number;
      deletedMediaCount: number;
      localInstructions: string;
    }>("/v1/account", {
      method: "DELETE",
      body: JSON.stringify({ confirmation: "DELETE MY ACCOUNT" }),
    });
  }

  registerPushSubscription(input: {
    expoPushToken: string;
    platform: "android" | "ios";
    enabled?: boolean;
  }) {
    return this.request<Record<string, unknown>>("/v1/push-subscriptions", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  listNotifications(householdId: string) {
    return this.request<{ notifications: UserNotification[] }>(
      `/v1/households/${householdId}/notifications`,
    );
  }

  markNotificationRead(householdId: string, notificationId: string) {
    return this.request<{ notification: UserNotification }>(
      `/v1/households/${householdId}/notifications/${notificationId}/read`,
      { method: "POST" },
    );
  }

  createHousehold(input: CreateHouseholdInput) {
    return this.request<{ household: Household }>("/v1/households", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  updateHousehold(householdId: string, input: CreateHouseholdInput) {
    return this.request<{ household: Household }>(
      `/v1/households/${householdId}`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
  }

  getHomeSummary(householdId: string) {
    return this.request<HomeSummary>(`/v1/households/${householdId}/progress`);
  }

  listItems(householdId: string) {
    return this.request<{ items: MobileItem[] }>(
      `/v1/households/${householdId}/items`,
    );
  }

  listPublishCandidates(householdId: string) {
    return this.request<{
      candidates: Array<{ item: MobileItem; listing: CanonicalListing }>;
    }>(`/v1/households/${householdId}/items/publish-candidates`);
  }

  getItem(householdId: string, itemId: string) {
    return this.request<{ item: MobileItem }>(
      `/v1/households/${householdId}/items/${itemId}`,
    );
  }

  getItemDetails(householdId: string, itemId: string) {
    return this.request<{
      item: MobileItem;
      latestListing: CanonicalListing | null;
      platformListings: PlatformListing[];
      enrichment: ItemEnrichment | null;
    }>(`/v1/households/${householdId}/items/${itemId}/details`);
  }

  captureItem(householdId: string, input: CaptureInput) {
    return this.request<{ item: MobileItem; duplicateMatches: unknown[] }>(
      `/v1/households/${householdId}/items`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  enrichItem(householdId: string, itemId: string) {
    return this.request<{ enrichment: ItemEnrichment; reused: boolean }>(
      `/v1/households/${householdId}/items/${itemId}/enrich`,
      { method: "POST" },
    );
  }

  getItemEnrichment(householdId: string, itemId: string) {
    return this.request<{ enrichment: ItemEnrichment }>(
      `/v1/households/${householdId}/items/${itemId}/enrichment`,
    );
  }

  getBundleSuggestions(householdId: string, itemId: string) {
    return this.request<{ suggestions: BundleSuggestion[] }>(
      `/v1/households/${householdId}/items/${itemId}/bundle-suggestions`,
    );
  }

  replaceMediaAsset(
    householdId: string,
    itemId: string,
    mediaAssetId: string,
    replacement: CapturePhotoInput,
  ) {
    return this.request<{ item: MobileItem }>(
      `/v1/households/${householdId}/items/${itemId}/media/${mediaAssetId}`,
      {
        method: "PUT",
        body: JSON.stringify({
          replacement,
          confirmPrivateDetailsRemoved: true,
        }),
      },
    );
  }

  confirmMediaNotPrivate(
    householdId: string,
    itemId: string,
    mediaAssetId: string,
  ) {
    return this.request<{ item: MobileItem }>(
      `/v1/households/${householdId}/items/${itemId}/media/${mediaAssetId}/privacy-review`,
      {
        method: "POST",
        body: JSON.stringify({ action: "confirm_not_private" }),
      },
    );
  }

  createListing(
    householdId: string,
    itemId: string,
    input: Record<string, unknown>,
  ) {
    return this.request<{ listing: CanonicalListing }>(
      `/v1/households/${householdId}/items/${itemId}/listings`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  publish(
    householdId: string,
    itemId: string,
    input: {
      platforms: string[];
      listingVersion: number;
      sellerDeviceId: string | null;
      duplicateOverride?: boolean;
    },
  ) {
    return this.request<{
      jobs: Array<{ job: PublishingJob; reused: boolean }>;
    }>(`/v1/households/${householdId}/items/${itemId}/publish`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  publishBatch(
    householdId: string,
    items: Array<{
      itemId: string;
      platforms: string[];
      listingVersion: number;
      sellerDeviceId: string | null;
      duplicateOverride?: boolean;
    }>,
  ) {
    return this.request<{
      results: Array<{
        itemId: string;
        jobs: Array<{ job: PublishingJob; reused: boolean }>;
      }>;
    }>(`/v1/households/${householdId}/items/batch-publish`, {
      method: "POST",
      body: JSON.stringify({ items }),
    });
  }

  recommendPrices(
    householdId: string,
    itemId: string,
    input: {
      factors: {
        conditionMultiplier: number;
        localDemandMultiplier: number;
        seasonalityMultiplier: number;
      };
      estimatedEffortMinutes?: number;
      minimumWorthwhileHourlyCents?: number;
    },
  ) {
    return this.request<{
      recommendations: PriceRecommendation[];
      clearingAdvice: ClearingAdvice;
    }>(`/v1/households/${householdId}/items/${itemId}/pricing`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  changeItemLifecycle(
    householdId: string,
    itemId: string,
    action: "reserve" | "relist" | "archive",
  ) {
    return this.request<{ item: MobileItem }>(
      `/v1/households/${householdId}/items/${itemId}/actions`,
      { method: "POST", body: JSON.stringify({ action }) },
    );
  }

  deleteItem(householdId: string, itemId: string, confirmTitle: string) {
    return this.request<{
      deleted: true;
      itemId: string;
      deletedMediaCount: number;
    }>(`/v1/households/${householdId}/items/${itemId}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmTitle }),
    });
  }

  propagateListing(
    householdId: string,
    itemId: string,
    listingVersion: number,
  ) {
    return this.request<{
      jobs: PublishingJob[];
      exceptionTask: Record<string, unknown> | null;
    }>(`/v1/households/${householdId}/items/${itemId}/propagate`, {
      method: "POST",
      body: JSON.stringify({ listingVersion }),
    });
  }

  getJob(householdId: string, jobId: string) {
    return this.request<JobDetails>(
      `/v1/households/${householdId}/publishing-jobs/${jobId}`,
    );
  }

  getListingExport(householdId: string, jobId: string) {
    return this.request<{
      artifact: {
        id: string;
        publishingJobId: string;
        platform: string;
        payload: Record<string, unknown>;
        expiresAt: string;
      };
    }>(`/v1/households/${householdId}/publishing-jobs/${jobId}/export`);
  }

  completeListingImport(
    householdId: string,
    jobId: string,
    input: { externalListingId: string | null; externalUrl: string | null },
  ) {
    return this.request<JobDetails>(
      `/v1/households/${householdId}/publishing-jobs/${jobId}/complete-import`,
      {
        method: "POST",
        body: JSON.stringify({
          confirmation: "I CONFIRM THIS LISTING IS LIVE",
          ...input,
        }),
      },
    );
  }

  closeItem(
    householdId: string,
    itemId: string,
    input: Record<string, unknown>,
  ) {
    return this.request<Record<string, unknown>>(
      `/v1/households/${householdId}/items/${itemId}/close`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  listConnectors() {
    return this.request<{ connectors: ConnectorManifest[] }>("/v1/connectors");
  }

  listDevices(householdId: string) {
    return this.request<{ devices: SellerDevice[] }>(
      `/v1/households/${householdId}/seller-devices`,
    );
  }

  listPlatformConnections(householdId: string) {
    return this.request<{ connections: PlatformConnection[] }>(
      `/v1/households/${householdId}/platform-connections`,
    );
  }

  beginPairing(householdId: string) {
    return this.request<{ qr: Record<string, unknown> }>(
      `/v1/households/${householdId}/seller-devices/pairing`,
      { method: "POST" },
    );
  }

  unpairDevice(householdId: string, deviceId: string) {
    return this.request<{ device: SellerDevice; localInstructions: string }>(
      `/v1/households/${householdId}/seller-devices/${deviceId}/unpair`,
      { method: "POST" },
    );
  }

  listBuyerTasks(householdId: string) {
    return this.request<{ tasks: BuyerTask[] }>(
      `/v1/households/${householdId}/buyer-tasks`,
    );
  }

  decideBuyerTask(
    householdId: string,
    taskId: string,
    input: {
      decision: "approve" | "approve_and_send" | "reject";
      responseText?: string;
      shareExactAddress?: boolean;
    },
  ) {
    return this.request<{ task: BuyerTask }>(
      `/v1/households/${householdId}/buyer-tasks/${taskId}/decision`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  draftBuyerTaskAction(
    householdId: string,
    taskId: string,
    input: {
      action: "accept" | "counter" | "decline" | "schedule";
      counterPriceCents?: number;
    },
  ) {
    return this.request<{ draft: BuyerActionDraft }>(
      `/v1/households/${householdId}/buyer-tasks/${taskId}/actions`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  createMeetup(
    householdId: string,
    taskId: string,
    input: {
      scheduledAt?: string;
      locationType:
        "public_meetup" | "porch_pickup" | "buyer_pickup" | "local_delivery";
      preferredMeetupLocationId?: string | null;
      approvedLocation?: string | null;
      exactAddressApproved?: boolean;
    },
  ) {
    return this.request<{ meetup: Meetup }>(
      `/v1/households/${householdId}/buyer-tasks/${taskId}/meetups`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  listMeetups(householdId: string) {
    return this.request<{ meetups: Meetup[] }>(
      `/v1/households/${householdId}/meetups`,
    );
  }

  updateMeetup(
    householdId: string,
    meetupId: string,
    status: "confirmed" | "completed" | "cancelled" | "no_show",
  ) {
    return this.request<{ meetup: Meetup }>(
      `/v1/households/${householdId}/meetups/${meetupId}`,
      { method: "PATCH", body: JSON.stringify({ status }) },
    );
  }

  enqueueBackupBuyer(householdId: string, taskId: string) {
    return this.request<{ entry: BackupBuyerEntry }>(
      `/v1/households/${householdId}/buyer-tasks/${taskId}/backup`,
      { method: "POST" },
    );
  }

  listBackupBuyers(householdId: string, itemId: string) {
    return this.request<{ entries: BackupBuyerEntry[] }>(
      `/v1/households/${householdId}/items/${itemId}/backup-buyers`,
    );
  }

  updateBackupBuyer(
    householdId: string,
    itemId: string,
    entryId: string,
    action: "promote" | "remove",
  ) {
    return this.request<{ entry: BackupBuyerEntry }>(
      `/v1/households/${householdId}/items/${itemId}/backup-buyers/${entryId}`,
      { method: "PATCH", body: JSON.stringify({ action }) },
    );
  }

  listSupportGrants(householdId: string) {
    return this.request<{ grants: SupportAccessGrant[] }>(
      `/v1/households/${householdId}/support-grants`,
    );
  }

  createSupportGrant(
    householdId: string,
    input: {
      supportActorId: string;
      reasonCode:
        | "user_requested_troubleshooting"
        | "publishing_failure_review"
        | "device_pairing_help";
      scope: Array<"job_metadata" | "device_health" | "diagnostic_artifacts">;
      durationMinutes: number;
      diagnosticConsentConfirmation?:
        "I CONSENT TO REDACTED DIAGNOSTICS" | null;
    },
  ) {
    return this.request<{ grant: SupportAccessGrant }>(
      `/v1/households/${householdId}/support-grants`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  revokeSupportGrant(householdId: string, grantId: string) {
    return this.request<{ grant: SupportAccessGrant }>(
      `/v1/households/${householdId}/support-grants/${grantId}`,
      { method: "DELETE" },
    );
  }

  submitDiagnosticArtifact(
    householdId: string,
    input: {
      grantId: string;
      kind: "publishing_screen" | "device_health" | "error_context";
      storagePath: string;
      contentSha256: string;
      redacted: true;
      privacyScanPassed: true;
      consentConfirmation: "I CONSENT TO UPLOAD THIS REDACTED DIAGNOSTIC";
    },
  ) {
    return this.request<{ artifact: DiagnosticArtifact }>(
      `/v1/households/${householdId}/diagnostic-artifacts`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }
}

export const api = new LocalClearApi();
