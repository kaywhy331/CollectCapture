import { randomUUID } from "node:crypto";
import type { ItemEnrichmentOutput } from "@localclear/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { LocalClearApplication } from "../src/application.js";
import { StaticTokenVerifier } from "../src/auth.js";
import { PostgresRepository } from "../src/postgres-repository.js";
import { seedMissingConnectors } from "../src/seed-connectors.js";
import { seedMissingFeatureFlags } from "../src/seed-feature-flags.js";
import { GovernedServerConnectorExecutor } from "../src/server-connectors.js";

const databaseUrl = process.env.DATABASE_TEST_URL;
const integrationDescribe = databaseUrl ? describe : describe.skip;
// This suite verifies database behavior rather than latency. Cold PostgreSQL,
// Fastify, and connector initialization can exceed Vitest's short unit-test
// defaults on CI runners, so keep the allowance local to this integration file.
const integrationHookTimeoutMs = 60_000;
const integrationTestTimeoutMs = 120_000;

integrationDescribe.sequential("PostgresRepository integration", () => {
  let app: FastifyInstance;
  let application: LocalClearApplication;
  let adminSql: postgres.Sql;
  let userId: string;
  const token = "postgres-integration-token";
  const deletedObjects: string[] = [];
  const deletedUsers: string[] = [];

  beforeAll(async () => {
    if (!databaseUrl) return;
    userId = randomUUID();
    adminSql = postgres(databaseUrl, { max: 1 });
    await adminSql`
        insert into auth.users (id, email, raw_user_meta_data)
        values (
          ${userId}::uuid,
          ${`postgres-${userId}@example.test`},
          ${adminSql.json({ name: "Postgres integration" })}
        )
      `;
    const repository = new PostgresRepository(databaseUrl, { max: 2 });
    await seedMissingConnectors(repository);
    await seedMissingFeatureFlags(repository);
    application = new LocalClearApplication(repository, {
      environment: "internal",
      apiBaseUrl: "https://api.example.test",
      intelligenceProvider: {
        providerName: "postgres-test-provider",
        model: "deterministic-v1",
        async enrich(request) {
          const mediaAssetId = request.media[0]?.mediaAssetId;
          if (!mediaAssetId) throw new Error("Test item has no media");
          return enrichmentOutput(mediaAssetId);
        },
      },
      mediaReadUrlProvider: {
        async createReadUrl(storagePath) {
          return `https://media.example.test/${encodeURIComponent(storagePath)}`;
        },
      },
      mediaVerificationProvider: {
        async verify(request) {
          return {
            contentSha256: request.expectedSha256,
            mediaType: request.declaredMediaType,
            exifLocationStripped: true,
            sizeBytes: 1_024,
          };
        },
      },
      accountDeletionHashKey: "integration-test-hash-key-32-bytes-minimum",
      accountIdentityProvider: {
        async deleteUser(id) {
          deletedUsers.push(id);
        },
      },
      mediaLifecycleProvider: {
        async deleteObjects(paths) {
          deletedObjects.push(...paths);
        },
      },
    });
    app = await buildApp({
      repository,
      application,
      tokenVerifier: new StaticTokenVerifier(
        new Map([
          [
            token,
            {
              userId,
              email: `postgres-${userId}@example.test`,
              roles: [],
            },
          ],
        ]),
      ),
      environment: "internal",
    });
  }, integrationHookTimeoutMs);

  afterAll(async () => {
    if (!databaseUrl) return;
    await app.close();
    await adminSql`delete from auth.users where id = ${userId}::uuid`;
    await adminSql.end({ timeout: 5 });
  }, integrationHookTimeoutMs);

  it(
    "round-trips canonical data, publishing state, export, and deletion",
    async () => {
      const headers = { authorization: `Bearer ${token}` };
      const householdResponse = await app.inject({
        method: "POST",
        url: "/v1/households",
        headers,
        payload: {
          name: "Postgres household",
          zipCode: "94107",
          sellingRadiusMiles: 15,
          exchangePreferences: ["public_meetup", "porch_pickup"],
          paymentWording: "cash_preferred",
          availability: [{ dayOfWeek: 6, startMinutes: 600, endMinutes: 900 }],
          preferredMeetupLocations: [
            {
              name: "Central police station",
              publicDescription: "Front public exchange area",
            },
          ],
          priceRules: {
            defaultMinimumOfferPercent: 70,
            defaultHoldMinutes: 120,
            acceptsTrades: false,
          },
          timezone: "America/Los_Angeles",
        },
      });
      expect(householdResponse.statusCode).toBe(201);
      const householdId = householdResponse.json().household.id as string;
      const mediaPath = `${householdId}/uploads/postgres-item.jpg`;

      const capture = await app.inject({
        method: "POST",
        url: `/v1/households/${householdId}/items`,
        headers,
        payload: {
          title: "Oak side table",
          category: "Furniture",
          brand: null,
          model: null,
          condition: "good",
          dimensions: {},
          specifications: {},
          accessories: [],
          defects: ["Small scratch shown in photo"],
          storageLocation: "garage shelf A",
          clearingRecommendation: "sell",
          photos: [
            {
              storagePath: mediaPath,
              contentSha256: "a".repeat(64),
              mediaType: "image/jpeg",
              source: "camera",
              qualityIssues: [],
            },
          ],
          barcode: null,
          imageFingerprint: `postgres-${randomUUID()}`,
        },
      });
      expect(capture.statusCode).toBe(201);
      const itemId = capture.json().item.id as string;

      const enrichment = await app.inject({
        method: "POST",
        url: `/v1/households/${householdId}/items/${itemId}/enrich`,
        headers,
      });
      expect(enrichment.statusCode, JSON.stringify(enrichment.json())).toBe(
        201,
      );

      const scannedItem = await app.inject({
        method: "GET",
        url: `/v1/households/${householdId}/items/${itemId}`,
        headers,
      });
      expect(scannedItem.json().item.media[0]).toMatchObject({
        storagePath: mediaPath,
        redactionState: "not_needed",
        exifLocationStripped: true,
      });

      const listing = await app.inject({
        method: "POST",
        url: `/v1/households/${householdId}/items/${itemId}/listings`,
        headers,
        payload: {
          title: "Solid oak side table",
          description:
            "Solid oak side table with a small scratch shown clearly in the photos.",
          conditionSummary: "Good used condition with one cosmetic scratch.",
          specifications: {
            material: {
              value: "oak",
              provenance: "user_confirmed",
              confidence: 1,
            },
          },
          priceStrategy: "balanced",
          askingPrice: { amountCents: 5_500, currency: "USD" },
          minimumPrice: { amountCents: 4_000, currency: "USD" },
          location: {
            zipCode: "94107",
            displayArea: "Potrero Hill",
            radiusMiles: 15,
          },
          exchangeOptions: ["public_meetup"],
          paymentWording: "cash_preferred",
          negotiationRules: {
            defaultMinimumOfferPercent: 70,
            defaultHoldMinutes: 120,
            acceptsTrades: false,
          },
          approve: true,
        },
      });
      expect(listing.statusCode, JSON.stringify(listing.json())).toBe(201);
      const listingVersion = listing.json().listing.version as number;

      const queued = await app.inject({
        method: "POST",
        url: `/v1/households/${householdId}/items/${itemId}/publish`,
        headers,
        payload: {
          platforms: ["Sandbox Local API"],
          listingVersion,
        },
      });
      expect(queued.statusCode).toBe(202);
      const queuedJob = queued.json().jobs[0].job;
      const processed = await application.processServerPublishingJob(
        queuedJob,
        new GovernedServerConnectorExecutor(),
      );
      expect(processed.job.currentState).toBe("PUBLISHED");

      const details = await app.inject({
        method: "GET",
        url: `/v1/households/${householdId}/items/${itemId}/details`,
        headers,
      });
      expect(details.statusCode).toBe(200);
      expect(details.json()).toMatchObject({
        item: { id: itemId, status: "live" },
        latestListing: { version: listingVersion },
        platformListings: [
          {
            platform: "Sandbox Local API",
            status: "live",
          },
        ],
      });
      const platformListingId = details.json().platformListings[0].id as string;

      const buyerTask = await app.inject({
        method: "POST",
        url: `/v1/households/${householdId}/buyer-tasks/ingest`,
        headers,
        payload: {
          platformListingId,
          participantAlias: "Buyer P",
          rawMessage: "Would you take $45, and where can we meet?",
        },
      });
      expect(buyerTask.statusCode).toBe(201);
      expect(buyerTask.json().task).toMatchObject({
        intent: "price_offer",
        approvalState: "pending",
        priceOffer: { amountCents: 4_500, currency: "USD" },
      });
      const buyerTaskId = buyerTask.json().task.id as string;

      const meetup = await app.inject({
        method: "POST",
        url: `/v1/households/${householdId}/buyer-tasks/${buyerTaskId}/meetups`,
        headers,
        payload: { locationType: "public_meetup" },
      });
      expect(meetup.statusCode).toBe(201);
      expect(meetup.json().meetup).toMatchObject({
        platformListingId,
        buyerAlias: "Buyer P",
        status: "proposed",
      });

      const backup = await app.inject({
        method: "POST",
        url: `/v1/households/${householdId}/buyer-tasks/${buyerTaskId}/backup`,
        headers,
      });
      expect(backup.statusCode).toBe(201);
      expect(backup.json().entry).toMatchObject({
        itemId,
        buyerTaskId,
        position: 1,
        status: "waiting",
      });

      const exported = await app.inject({
        method: "GET",
        url: "/v1/account/export",
        headers,
      });
      expect(exported.statusCode).toBe(200);
      expect(exported.json().export).toMatchObject({
        profile: { id: userId },
        households: [expect.objectContaining({ id: householdId })],
        items: [expect.objectContaining({ id: itemId })],
        buyerTasks: [expect.objectContaining({ id: buyerTaskId })],
        meetups: [expect.objectContaining({ id: meetup.json().meetup.id })],
        backupBuyers: [expect.objectContaining({ id: backup.json().entry.id })],
      });

      const deletion = await app.inject({
        method: "DELETE",
        url: "/v1/account",
        headers,
        payload: { confirmation: "DELETE MY ACCOUNT" },
      });
      expect(deletion.statusCode).toBe(200);
      expect(deletedObjects).toContain(mediaPath);
      expect(deletedUsers).toEqual([userId]);
      expect(deletion.json()).toMatchObject({
        deletedMediaCount: 1,
        receipt: { subjectHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
      });
    },
    integrationTestTimeoutMs,
  );
});

function enrichmentOutput(mediaAssetId: string): ItemEnrichmentOutput {
  const evidence = [{ mediaAssetId, observation: "Visible item surface" }];
  return {
    identification: {
      itemType: "Side table",
      category: "Furniture",
      brand: null,
      model: null,
      confidence: 0.8,
      alternatives: [],
      extractedText: [],
      barcodes: [],
    },
    title: {
      value: "Oak side table",
      confidence: 0.8,
      provenance: "image_derived",
      evidence,
    },
    category: {
      value: "Furniture",
      confidence: 0.9,
      provenance: "image_derived",
      evidence,
    },
    brand: { value: null, confidence: 0, provenance: "inferred", evidence: [] },
    model: { value: null, confidence: 0, provenance: "inferred", evidence: [] },
    condition: { value: "good", confidence: 0.8, evidence },
    dimensions: [],
    specifications: [],
    accessories: [],
    defects: [],
    mediaAssessments: [
      {
        mediaAssetId,
        qualityIssues: [],
        redactionSuggested: false,
        redactionReasons: [],
        leadPhotoScore: 0.9,
        leadPhotoReasons: ["Complete item view"],
      },
    ],
    suggestedAdditionalPhotos: [],
    listingDraft: {
      title: "Oak side table",
      description: "Oak side table in good used condition.",
      conditionSummary: "Good used condition.",
    },
    clearingRecommendation: {
      value: "sell",
      confidence: 0.8,
      rationale: "The item appears usable and suitable for local sale.",
    },
    restrictedSignals: [],
    unresolvedQuestions: [],
  };
}
