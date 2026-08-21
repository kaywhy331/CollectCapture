import { generateKeyPairSync } from "node:crypto";
import {
  createPairingResponse,
  signDeviceReceipt,
} from "@localclear/device-protocol";
import {
  REQUIRED_RELEASE_EVIDENCE,
  REQUIRED_RELEASE_EVIDENCE_STATUS,
  type ItemEnrichmentOutput,
} from "@localclear/domain";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { LocalClearApplication } from "../src/application.js";
import { StaticTokenVerifier } from "../src/auth.js";
import { SignedDeviceCommandFactory } from "../src/device-commands.js";
import type {
  IntelligenceProvider,
  MediaReadUrlProvider,
} from "../src/intelligence.js";
import { MemoryRepository } from "../src/memory-repository.js";
import { NotificationDispatcher } from "../src/notification-dispatcher.js";
import { PublishingDispatcher } from "../src/publishing-dispatcher.js";
import { GovernedServerConnectorExecutor } from "../src/server-connectors.js";
import { seedInitialConnectors } from "../src/seed-connectors.js";
import { seedInitialFeatureFlags } from "../src/seed-feature-flags.js";

const aliceHeaders = { authorization: "Bearer alice-token" };
const bobHeaders = { authorization: "Bearer bob-token" };
const adminHeaders = { authorization: "Bearer admin-token" };
const adminTwoHeaders = { authorization: "Bearer admin-two-token" };
const adminThreeHeaders = { authorization: "Bearer admin-three-token" };
const operatorHeaders = { authorization: "Bearer operator-token" };

describe("LocalClear API", () => {
  let app: FastifyInstance;
  let repository: MemoryRepository;
  let idCounter: number;
  let intelligenceCalls: number;
  let signedMediaPaths: string[];
  let deletedMediaPaths: string[];
  let deletedUsers: string[];

  beforeEach(async () => {
    repository = new MemoryRepository();
    await seedInitialConnectors((manifest) =>
      repository.upsertConnector(manifest),
    );
    await seedInitialFeatureFlags((flag) => repository.upsertFeatureFlag(flag));
    idCounter = 0;
    intelligenceCalls = 0;
    signedMediaPaths = [];
    deletedMediaPaths = [];
    deletedUsers = [];
    const intelligenceProvider: IntelligenceProvider = {
      providerName: "test-provider",
      model: "deterministic-v1",
      async enrich(request) {
        intelligenceCalls += 1;
        const mediaAssetId = request.media[0]?.mediaAssetId;
        if (!mediaAssetId) throw new Error("Test item has no media");
        return enrichmentOutput(mediaAssetId);
      },
    };
    const mediaReadUrlProvider: MediaReadUrlProvider = {
      async createReadUrl(storagePath) {
        signedMediaPaths.push(storagePath);
        return `https://media.example.test/signed/${encodeURIComponent(storagePath)}`;
      },
    };
    const serverSigningKeys = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    app = await buildApp({
      repository,
      tokenVerifier: new StaticTokenVerifier(
        new Map([
          [
            "alice-token",
            { userId: "alice", email: "alice@example.test", roles: [] },
          ],
          [
            "bob-token",
            { userId: "bob", email: "bob@example.test", roles: [] },
          ],
          [
            "admin-token",
            {
              userId: "admin-user",
              email: "admin@example.test",
              roles: ["admin"],
            },
          ],
          [
            "operator-token",
            {
              userId: "operator-user",
              email: "operator@example.test",
              roles: ["operator"],
            },
          ],
          [
            "admin-two-token",
            {
              userId: "admin-two",
              email: "admin-two@example.test",
              roles: ["admin"],
            },
          ],
          [
            "admin-three-token",
            {
              userId: "admin-three",
              email: "admin-three@example.test",
              roles: ["admin"],
            },
          ],
        ]),
      ),
      environment: "internal",
      applicationOptions: {
        now: () => new Date("2026-08-20T12:00:00.000Z"),
        createId: () => `id-${++idCounter}`,
        intelligenceProvider,
        mediaReadUrlProvider,
        deviceCommandFactory: new SignedDeviceCommandFactory({
          keyId: "backend-test-key",
          privateKey: serverSigningKeys.privateKey
            .export({ format: "pem", type: "pkcs8" })
            .toString(),
          mediaReadUrlProvider,
          now: () => new Date("2026-08-20T12:00:00.000Z"),
        }),
        mediaLifecycleProvider: {
          async deleteObjects(paths) {
            deletedMediaPaths.push(...paths);
          },
        },
        accountIdentityProvider: {
          async deleteUser(userId) {
            deletedUsers.push(userId);
          },
        },
        accountDeletionHashKey:
          "test-account-deletion-key-that-is-at-least-32-chars",
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("keeps health public and household data authenticated", async () => {
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok", service: "localclear-api" });

    const unauthorized = await app.inject({
      method: "GET",
      url: "/v1/households",
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toMatchObject({ error: "unauthorized" });
  });

  it("exports account data and completes revocation, media, data, and identity deletion", async () => {
    const householdId = await createHousehold(app);
    const capture = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/items`,
      headers: aliceHeaders,
      payload: capturePayload(householdId, 1),
    });
    expect(capture.statusCode).toBe(201);

    const exported = await app.inject({
      method: "GET",
      url: "/v1/account/export",
      headers: aliceHeaders,
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-disposition"]).toContain(
      "localclear-export-2026-08-20.json",
    );
    expect(exported.json().export.items).toHaveLength(1);
    expect(JSON.stringify(exported.json())).not.toContain("alice-token");

    const weakConfirmation = await app.inject({
      method: "DELETE",
      url: "/v1/account",
      headers: aliceHeaders,
      payload: { confirmation: "DELETE" },
    });
    expect(weakConfirmation.statusCode).toBe(400);

    const deletion = await app.inject({
      method: "DELETE",
      url: "/v1/account",
      headers: aliceHeaders,
      payload: { confirmation: "DELETE MY ACCOUNT" },
    });
    expect(deletion.statusCode).toBe(200);
    expect(deletion.json()).toMatchObject({
      deletedMediaCount: 1,
      receipt: { completedAt: "2026-08-20T12:00:00.000Z" },
    });
    expect(deletedMediaPaths).toEqual([`${householdId}/uploads/item-1.jpg`]);
    expect(deletedUsers).toEqual(["alice"]);

    const after = await app.inject({
      method: "GET",
      url: "/v1/households",
      headers: aliceHeaders,
    });
    expect(after.json().households).toEqual([]);
  });

  it("creates a household and processes 25 items in one batch", async () => {
    const householdId = await createHousehold(app);
    const items = Array.from({ length: 25 }, (_, index) =>
      capturePayload(householdId, index),
    );
    const response = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/items/batch`,
      headers: aliceHeaders,
      payload: { items },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().results).toHaveLength(25);
    expect(response.json().results[0].item.media).toHaveLength(1);

    const inventory = await app.inject({
      method: "GET",
      url: `/v1/households/${householdId}/items`,
      headers: aliceHeaders,
    });
    expect(inventory.json().items).toHaveLength(25);
  });

  it("pairs a device-bound key once and supports cryptographic unpairing", async () => {
    const householdId = await createHousehold(app);
    const begin = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/seller-devices/pairing`,
      headers: aliceHeaders,
    });
    expect(begin.statusCode).toBe(201);
    const qr = begin.json().qr;
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const pairingResponse = createPairingResponse(
      qr,
      {
        displayName: "Spare Pixel",
        publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
        androidVersion: 14,
        appVersion: "1.0.0",
      },
      privateKey,
    );

    const complete = await app.inject({
      method: "POST",
      url: "/v1/seller-devices/pairing/complete",
      payload: { secret: qr.secret, response: pairingResponse },
    });
    expect(complete.statusCode).toBe(201);
    expect(complete.json().device).toMatchObject({
      householdId,
      androidVersion: 14,
      isPrimary: true,
      connectionStatus: "offline",
    });
    const deviceId = complete.json().device.id as string;
    const deviceToken = complete.json().deviceToken as string;
    expect(deviceToken.startsWith(`${deviceId}.`)).toBe(true);

    const checkIn = await app.inject({
      method: "POST",
      url: "/v1/device/check-in",
      headers: { authorization: `Device ${deviceToken}` },
      payload: {
        appVersion: "1.0.0",
        androidVersion: 14,
        batteryPercent: 88,
        isCharging: true,
        networkType: "wifi",
        capabilities: ["signed_commands"],
        platformConnections: [
          {
            platform: "Sandbox Seller Hub",
            appVersion: "1.0.0",
            displayAlias: "Local deterministic sandbox",
            connectionStatus: "connected",
            supportedCapabilities: ["publish", "edit", "delist", "mark_sold"],
          },
        ],
      },
    });
    expect(checkIn.statusCode).toBe(200);
    expect(checkIn.json().device).toMatchObject({
      connectionStatus: "online",
      batteryPercent: 88,
    });
    const connections = await app.inject({
      method: "GET",
      url: `/v1/households/${householdId}/platform-connections`,
      headers: aliceHeaders,
    });
    expect(connections.statusCode).toBe(200);
    expect(connections.json().connections).toEqual([
      expect.objectContaining({
        sellerDeviceId: deviceId,
        platform: "Sandbox Seller Hub",
        appVersion: "1.0.0",
        connectionStatus: "connected",
        supportedCapabilities: ["publish", "edit", "delist", "mark_sold"],
      }),
    ]);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/seller-devices/pairing/complete",
      payload: { secret: qr.secret, response: pairingResponse },
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ error: "pairing_unavailable" });

    const captured = await captureItem(
      app,
      householdId,
      capturePayload(householdId, 6),
    );
    const listing = await createApprovedListing(app, householdId, captured.id);
    const publish = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/items/${captured.id}/publish`,
      headers: aliceHeaders,
      payload: {
        platforms: ["Sandbox Seller Hub"],
        listingVersion: listing.version,
        sellerDeviceId: deviceId,
      },
    });
    expect(publish.statusCode).toBe(202);
    const pendingJobId = publish.json().jobs[0].job.id as string;

    const unpair = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/seller-devices/${deviceId}/unpair`,
      headers: aliceHeaders,
    });
    expect(unpair.statusCode).toBe(200);
    const connectionsAfterUnpair = await app.inject({
      method: "GET",
      url: `/v1/households/${householdId}/platform-connections`,
      headers: aliceHeaders,
    });
    expect(connectionsAfterUnpair.json().connections[0].connectionStatus).toBe(
      "disabled",
    );
    expect(unpair.json().device).toMatchObject({
      id: deviceId,
      connectionStatus: "revoked",
      isPrimary: false,
    });
    expect(unpair.json().localInstructions).toContain("Clear local data");

    const cancelledJob = await app.inject({
      method: "GET",
      url: `/v1/households/${householdId}/publishing-jobs/${pendingJobId}`,
      headers: aliceHeaders,
    });
    expect(cancelledJob.json().job).toMatchObject({
      currentState: "CANCELLED",
      errorCode: "DEVICE_UNPAIRED",
    });

    const revokedCredential = await app.inject({
      method: "GET",
      url: "/v1/device/commands",
      headers: { authorization: `Device ${deviceToken}` },
    });
    expect(revokedCredential.statusCode).toBe(401);
  });

  it("delivers scoped signed Seller Hub commands and accepts signed receipts", async () => {
    const householdId = await createHousehold(app);
    const captured = await captureItem(
      app,
      householdId,
      capturePayload(householdId, 7),
    );
    const listing = await createApprovedListing(app, householdId, captured.id);
    const begin = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/seller-devices/pairing`,
      headers: aliceHeaders,
    });
    const qr = begin.json().qr;
    const deviceKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pairingResponse = createPairingResponse(
      qr,
      {
        displayName: "Spare Android",
        publicKey: deviceKeys.publicKey
          .export({ format: "pem", type: "spki" })
          .toString(),
        androidVersion: 14,
        appVersion: "1.0.0",
      },
      deviceKeys.privateKey,
    );
    const paired = await app.inject({
      method: "POST",
      url: "/v1/seller-devices/pairing/complete",
      payload: { secret: qr.secret, response: pairingResponse },
    });
    const deviceId = paired.json().device.id as string;
    const deviceToken = paired.json().deviceToken as string;

    const checkIn = await app.inject({
      method: "POST",
      url: "/v1/device/check-in",
      headers: { authorization: `Device ${deviceToken}` },
      payload: {
        appVersion: "1.0.0",
        androidVersion: 14,
        batteryPercent: 88,
        isCharging: true,
        networkType: "wifi",
        capabilities: ["signed_commands", "sandbox_connector_v1"],
        platformConnections: [
          {
            platform: "Sandbox Seller Hub",
            appVersion: "1.0.0",
            displayAlias: "Local deterministic sandbox",
            connectionStatus: "connected",
            supportedCapabilities: ["publish", "edit", "delist", "mark_sold"],
          },
        ],
      },
    });
    expect(checkIn.statusCode).toBe(200);

    const publish = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/items/${captured.id}/publish`,
      headers: aliceHeaders,
      payload: {
        platforms: ["Sandbox Seller Hub"],
        listingVersion: listing.version,
        sellerDeviceId: deviceId,
      },
    });
    expect(publish.statusCode).toBe(202);
    expect(publish.json().jobs[0].job.platformAppVersion).toBe("1.0.0");
    const jobId = publish.json().jobs[0].job.id as string;

    const commandResponse = await app.inject({
      method: "GET",
      url: "/v1/device/commands",
      headers: { authorization: `Device ${deviceToken}` },
    });
    expect(commandResponse.statusCode).toBe(200);
    const command = commandResponse.json().commands[0];
    expect(command).toMatchObject({
      keyId: "backend-test-key",
      payload: {
        jobId,
        householdId,
        deviceId,
        platformAppVersion: "1.0.0",
        action: "publish",
      },
    });
    expect(command.payload.parameters.media[0].downloadUrl).toContain(
      "media.example.test",
    );

    let firstReceipt: unknown;
    for (let sequence = 1; sequence <= 11; sequence += 1) {
      const receipt = signDeviceReceipt(
        {
          version: 1,
          deviceId,
          householdId,
          jobId,
          commandNonce: command.payload.nonce,
          receiptNonce: `receipt_nonce_${sequence.toString().padStart(3, "0")}_long_enough`,
          sequence,
          occurredAt: "2026-08-20T12:00:00.000Z",
          event: { type: "advance" },
          ...(sequence === 11
            ? {
                result: {
                  externalListingId: "hub-external-7",
                  externalUrl:
                    "https://sandbox-hub.example.test/listing/hub-external-7",
                  platformTitle: "Solid oak side table",
                  platformPrice: { amountCents: 5_500, currency: "USD" },
                },
              }
            : {}),
        },
        deviceKeys.privateKey,
      );
      if (sequence === 1) firstReceipt = receipt;
      const response = await app.inject({
        method: "POST",
        url: `/v1/device/jobs/${jobId}/receipts`,
        headers: { authorization: `Device ${deviceToken}` },
        payload: receipt,
      });
      expect(response.statusCode).toBe(200);
    }

    const replay = await app.inject({
      method: "POST",
      url: `/v1/device/jobs/${jobId}/receipts`,
      headers: { authorization: `Device ${deviceToken}` },
      payload: firstReceipt,
    });
    expect(replay.statusCode).toBe(401);

    const item = await app.inject({
      method: "GET",
      url: `/v1/households/${householdId}/items/${captured.id}`,
      headers: aliceHeaders,
    });
    expect(item.json().item.status).toBe("live");
  });

  it("dispatches the API pattern and creates a confirmation-bound import artifact", async () => {
    const householdId = await createHousehold(app);
    const captured = await captureItem(
      app,
      householdId,
      capturePayload(householdId, 31),
    );
    const listing = await createApprovedListing(app, householdId, captured.id);
    const dispatcher = new PublishingDispatcher({
      repository,
      application: new LocalClearApplication(repository, {
        environment: "internal",
        now: () => new Date("2026-08-20T12:00:00.000Z"),
        createId: () => `id-${++idCounter}`,
      }),
      executor: new GovernedServerConnectorExecutor(),
      workerId: "test-dispatcher",
      now: () => new Date("2026-08-20T12:00:00.000Z"),
    });

    const apiPublish = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/items/${captured.id}/publish`,
      headers: aliceHeaders,
      payload: {
        platforms: ["Sandbox Local API"],
        listingVersion: listing.version,
        sellerDeviceId: null,
      },
    });
    const apiJobId = apiPublish.json().jobs[0].job.id as string;
    expect(await dispatcher.runOnce()).toEqual({ claimed: 1, processed: 1 });
    const apiJob = await app.inject({
      method: "GET",
      url: `/v1/households/${householdId}/publishing-jobs/${apiJobId}`,
      headers: aliceHeaders,
    });
    expect(apiJob.json().job).toMatchObject({ currentState: "PUBLISHED" });
    const pushRegistration = await app.inject({
      method: "POST",
      url: "/v1/push-subscriptions",
      headers: aliceHeaders,
      payload: {
        expoPushToken: "ExponentPushToken[localclear_test_token_31]",
        platform: "android",
      },
    });
    expect(pushRegistration.statusCode).toBe(201);
    const deliveredTokens: string[] = [];
    const notificationDispatcher = new NotificationDispatcher({
      repository,
      workerId: "test-notifications",
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      provider: {
        async send(tokens) {
          deliveredTokens.push(...tokens);
          return ["ticket-31"];
        },
      },
    });
    expect(await notificationDispatcher.runOnce()).toEqual({
      claimed: 1,
      sent: 1,
    });
    expect(deliveredTokens).toEqual([
      "ExponentPushToken[localclear_test_token_31]",
    ]);
    const notifications = await app.inject({
      method: "GET",
      url: `/v1/households/${householdId}/notifications`,
      headers: aliceHeaders,
    });
    expect(notifications.json().notifications[0]).toMatchObject({
      type: "publishing_published",
      deliveryState: "sent",
      providerTicketIds: ["ticket-31"],
    });

    const importPublish = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/items/${captured.id}/publish`,
      headers: aliceHeaders,
      payload: {
        platforms: ["Sandbox Share Export"],
        listingVersion: listing.version,
        sellerDeviceId: null,
      },
    });
    const importJobId = importPublish.json().jobs[0].job.id as string;
    expect(await dispatcher.runOnce()).toEqual({ claimed: 1, processed: 1 });
    const exportResponse = await app.inject({
      method: "GET",
      url: `/v1/households/${householdId}/publishing-jobs/${importJobId}/export`,
      headers: aliceHeaders,
    });
    expect(exportResponse.statusCode).toBe(200);
    expect(exportResponse.json().artifact).toMatchObject({
      publishingJobId: importJobId,
      payload: { schemaVersion: 1, itemId: captured.id },
    });
    expect(JSON.stringify(exportResponse.json())).not.toContain("storagePath");

    const complete = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/publishing-jobs/${importJobId}/complete-import`,
      headers: aliceHeaders,
      payload: {
        confirmation: "I CONFIRM THIS LISTING IS LIVE",
        externalUrl: "https://import.example.test/listing/31",
        externalListingId: "import-31",
      },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().job.currentState).toBe("PUBLISHED");

    const replay = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/publishing-jobs/${importJobId}/complete-import`,
      headers: aliceHeaders,
      payload: {
        confirmation: "I CONFIRM THIS LISTING IS LIVE",
        externalListingId: "import-31",
      },
    });
    expect(replay.statusCode).toBe(409);
  });

  it("publishes idempotently, streams visible state through polling, and closes everywhere", async () => {
    const householdId = await createHousehold(app);
    const captured = await captureItem(
      app,
      householdId,
      capturePayload(householdId, 1),
    );
    const listing = await createApprovedListing(app, householdId, captured.id);

    const publishUrl = `/v1/households/${householdId}/items/${captured.id}/publish`;
    const firstPublish = await app.inject({
      method: "POST",
      url: publishUrl,
      headers: aliceHeaders,
      payload: {
        platforms: ["Sandbox Local API"],
        listingVersion: listing.version,
        sellerDeviceId: null,
      },
    });
    expect(firstPublish.statusCode).toBe(202);
    expect(firstPublish.json().jobs[0]).toMatchObject({
      reused: false,
      job: { currentState: "QUEUED", commandAction: "publish" },
    });
    const jobId = firstPublish.json().jobs[0].job.id as string;

    const repeatedPublish = await app.inject({
      method: "POST",
      url: publishUrl,
      headers: aliceHeaders,
      payload: {
        platforms: ["Sandbox Local API"],
        listingVersion: listing.version,
        sellerDeviceId: null,
      },
    });
    expect(repeatedPublish.statusCode).toBe(202);
    expect(repeatedPublish.json().jobs[0]).toMatchObject({
      reused: true,
      job: { id: jobId },
    });

    const unauthorizedAdvance = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/publishing-jobs/${jobId}/transitions`,
      headers: aliceHeaders,
      payload: { event: { type: "advance" } },
    });
    expect(unauthorizedAdvance.statusCode).toBe(400);

    const dispatcher = new PublishingDispatcher({
      repository,
      application: new LocalClearApplication(repository, {
        environment: "internal",
        now: () => new Date("2026-08-20T12:00:00.000Z"),
      }),
      executor: new GovernedServerConnectorExecutor(),
      workerId: "lifecycle-test-dispatcher",
      now: () => new Date("2026-08-20T12:00:00.000Z"),
    });
    expect(await dispatcher.runOnce()).toEqual({ claimed: 1, processed: 1 });
    const transitionResponse = await app.inject({
      method: "GET",
      url: `/v1/households/${householdId}/publishing-jobs/${jobId}`,
      headers: aliceHeaders,
    });
    expect(transitionResponse.json().job.currentState).toBe("PUBLISHED");
    expect(transitionResponse.json().transitions).toHaveLength(13);

    const itemAfterPublish = await app.inject({
      method: "GET",
      url: `/v1/households/${householdId}/items/${captured.id}`,
      headers: aliceHeaders,
    });
    expect(itemAfterPublish.json().item.status).toBe("live");

    const details = await app.inject({
      method: "GET",
      url: `/v1/households/${householdId}/items/${captured.id}/details`,
      headers: aliceHeaders,
    });
    const platformListingId = details.json().platformListings[0].id as string;
    const buyerMessage = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/buyer-tasks/ingest`,
      headers: aliceHeaders,
      payload: {
        platformListingId,
        participantAlias: "Buyer A",
        rawMessage:
          "Would you take $20? Text 415-555-1212 and send your address.",
      },
    });
    expect(buyerMessage.statusCode).toBe(201);
    expect(buyerMessage.json().task).toMatchObject({
      intent: "pickup_availability",
      approvalState: "pending",
      requiresAddressApproval: true,
    });
    expect(buyerMessage.json().task.redactedMessageExcerpt).not.toContain(
      "415-555-1212",
    );
    const buyerTaskId = buyerMessage.json().task.id as string;
    const sendReply = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/buyer-tasks/${buyerTaskId}/decision`,
      headers: aliceHeaders,
      payload: {
        decision: "approve_and_send",
        responseText:
          "Thanks. I can meet at the saved public exchange location.",
        shareExactAddress: false,
      },
    });
    expect(sendReply.statusCode).toBe(200);
    expect(sendReply.json().task.approvalState).toBe("sent");

    const privateWithoutConsent = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/buyer-tasks/${buyerTaskId}/meetups`,
      headers: aliceHeaders,
      payload: {
        locationType: "porch_pickup",
        approvedLocation: "123 Private Street",
        exactAddressApproved: false,
      },
    });
    expect(privateWithoutConsent.statusCode).toBe(400);

    const meetupResponse = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/buyer-tasks/${buyerTaskId}/meetups`,
      headers: aliceHeaders,
      payload: { locationType: "public_meetup" },
    });
    expect(meetupResponse.statusCode).toBe(201);
    expect(meetupResponse.json().meetup).toMatchObject({
      itemId: captured.id,
      buyerAlias: "Buyer A",
      approvedLocation: "Front public exchange area",
      exactAddressApprovedAt: null,
      status: "proposed",
    });
    const meetupId = meetupResponse.json().meetup.id as string;

    const isolatedMeetups = await app.inject({
      method: "GET",
      url: `/v1/households/${householdId}/meetups`,
      headers: bobHeaders,
    });
    expect(isolatedMeetups.statusCode).toBe(403);

    const confirmMeetup = await app.inject({
      method: "PATCH",
      url: `/v1/households/${householdId}/meetups/${meetupId}`,
      headers: aliceHeaders,
      payload: { status: "confirmed" },
    });
    expect(confirmMeetup.statusCode).toBe(200);
    expect(confirmMeetup.json().meetup.status).toBe("confirmed");

    const backupResponse = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/buyer-tasks/${buyerTaskId}/backup`,
      headers: aliceHeaders,
    });
    expect(backupResponse.statusCode).toBe(201);
    expect(backupResponse.json().entry).toMatchObject({
      itemId: captured.id,
      position: 1,
      status: "waiting",
    });
    const backupId = backupResponse.json().entry.id as string;

    const promoteBackup = await app.inject({
      method: "PATCH",
      url: `/v1/households/${householdId}/items/${captured.id}/backup-buyers/${backupId}`,
      headers: aliceHeaders,
      payload: { action: "promote" },
    });
    expect(promoteBackup.statusCode).toBe(200);
    expect(promoteBackup.json().entry.status).toBe("promoted");

    const noShow = await app.inject({
      method: "PATCH",
      url: `/v1/households/${householdId}/meetups/${meetupId}`,
      headers: aliceHeaders,
      payload: { status: "no_show" },
    });
    expect(noShow.statusCode).toBe(200);
    expect(noShow.json().meetup.status).toBe("no_show");

    const close = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/items/${captured.id}/close`,
      headers: aliceHeaders,
      payload: {
        outcome: "sold",
        salePriceCents: 4_800,
        currency: "USD",
        destinationPlatform: "Sandbox Local API",
        notes: "Met at saved public location",
      },
    });
    expect(close.statusCode).toBe(200);
    expect(close.json()).toMatchObject({
      item: { status: "sold" },
      outcome: { salePriceCents: 4_800, outcome: "sold" },
      jobs: [{ commandAction: "mark_sold", currentState: "QUEUED" }],
      exceptionTask: null,
    });
    const progress = await app.inject({
      method: "GET",
      url: `/v1/households/${householdId}/progress`,
      headers: aliceHeaders,
    });
    expect(progress.statusCode).toBe(200);
    expect(progress.json()).toMatchObject({
      clearedThisMonth: 1,
      recoveredCents: 4_800,
      buyerTasks: 1,
      removalTasks: 0,
    });
  });

  it("blocks restricted connectors even when a listing is otherwise ready", async () => {
    const householdId = await createHousehold(app);
    const captured = await captureItem(
      app,
      householdId,
      capturePayload(householdId, 1),
    );
    const listing = await createApprovedListing(app, householdId, captured.id);
    const response = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/items/${captured.id}/publish`,
      headers: aliceHeaders,
      payload: {
        platforms: ["OfferUp"],
        listingVersion: listing.version,
        sellerDeviceId: null,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "connector_blocked" });
  });

  it("blocks external publishing until EXIF location is stripped", async () => {
    const householdId = await createHousehold(app);
    const captured = await captureItem(app, householdId, {
      ...capturePayload(householdId, 1),
      photos: [
        {
          ...capturePayload(householdId, 1).photos[0],
          exifLocationStripped: false,
        },
      ],
    });
    const listing = await createApprovedListing(app, householdId, captured.id);
    const response = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/items/${captured.id}/publish`,
      headers: aliceHeaders,
      payload: {
        platforms: ["Sandbox Local API"],
        listingVersion: listing.version,
        sellerDeviceId: null,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "media_not_sanitized" });
  });

  it("isolates household records from another authenticated user", async () => {
    const householdId = await createHousehold(app);
    const response = await app.inject({
      method: "GET",
      url: `/v1/households/${householdId}/items`,
      headers: bobHeaders,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "forbidden" });
  });

  it("requires scoped, time-limited consent for redacted support diagnostics", async () => {
    const householdId = await createHousehold(app);
    const missingConsent = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/support-grants`,
      headers: aliceHeaders,
      payload: {
        supportActorId: "operator-user",
        reasonCode: "publishing_failure_review",
        scope: ["job_metadata", "diagnostic_artifacts"],
        durationMinutes: 30,
        diagnosticConsentConfirmation: null,
      },
    });
    expect(missingConsent.statusCode).toBe(400);

    const tooLong = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/support-grants`,
      headers: aliceHeaders,
      payload: {
        supportActorId: "operator-user",
        reasonCode: "publishing_failure_review",
        scope: ["job_metadata"],
        durationMinutes: 61,
      },
    });
    expect(tooLong.statusCode).toBe(400);

    const granted = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/support-grants`,
      headers: aliceHeaders,
      payload: {
        supportActorId: "operator-user",
        reasonCode: "publishing_failure_review",
        scope: ["job_metadata", "diagnostic_artifacts"],
        durationMinutes: 30,
        diagnosticConsentConfirmation: "I CONSENT TO REDACTED DIAGNOSTICS",
      },
    });
    expect(granted.statusCode).toBe(201);
    expect(granted.json().grant).toMatchObject({
      supportActorId: "operator-user",
      diagnosticConsent: true,
      revokedAt: null,
    });
    const grantId = granted.json().grant.id as string;

    const invalidPath = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/diagnostic-artifacts`,
      headers: aliceHeaders,
      payload: {
        grantId,
        kind: "publishing_screen",
        storagePath: "another-household/diagnostics/screen.jpg",
        contentSha256: "a".repeat(64),
        redacted: true,
        privacyScanPassed: true,
        consentConfirmation: "I CONSENT TO UPLOAD THIS REDACTED DIAGNOSTIC",
      },
    });
    expect(invalidPath.statusCode).toBe(400);

    const storagePath = `${householdId}/diagnostics/redacted-screen.jpg`;
    const uploaded = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/diagnostic-artifacts`,
      headers: aliceHeaders,
      payload: {
        grantId,
        kind: "publishing_screen",
        storagePath,
        contentSha256: "b".repeat(64),
        redacted: true,
        privacyScanPassed: true,
        consentConfirmation: "I CONSENT TO UPLOAD THIS REDACTED DIAGNOSTIC",
      },
    });
    expect(uploaded.statusCode).toBe(201);

    const wrongOperator = await app.inject({
      method: "GET",
      url: `/v1/admin/support-grants/${grantId}/session`,
      headers: adminHeaders,
    });
    expect(wrongOperator.statusCode).toBe(403);

    const supportSession = await app.inject({
      method: "GET",
      url: `/v1/admin/support-grants/${grantId}/session`,
      headers: operatorHeaders,
    });
    expect(supportSession.statusCode).toBe(200);
    expect(supportSession.json()).toMatchObject({
      grant: { id: grantId },
      devices: [],
      diagnostics: [
        {
          storagePath,
          redacted: true,
          privacyScanPassed: true,
        },
      ],
    });
    expect(supportSession.json().diagnostics[0].readUrl).toContain(
      encodeURIComponent(storagePath),
    );

    const revoked = await app.inject({
      method: "DELETE",
      url: `/v1/households/${householdId}/support-grants/${grantId}`,
      headers: aliceHeaders,
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().grant.revokedAt).toBe("2026-08-20T12:00:00.000Z");

    const afterRevocation = await app.inject({
      method: "GET",
      url: `/v1/admin/support-grants/${grantId}/session`,
      headers: operatorHeaders,
    });
    expect(afterRevocation.statusCode).toBe(403);
  });

  it("limits operations data by role and audits remote connector kill switches", async () => {
    const userAttempt = await app.inject({
      method: "GET",
      url: "/v1/admin/operations",
      headers: aliceHeaders,
    });
    expect(userAttempt.statusCode).toBe(403);

    const dashboard = await app.inject({
      method: "GET",
      url: "/v1/admin/operations",
      headers: operatorHeaders,
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().connectors.length).toBeGreaterThanOrEqual(8);

    const operatorUpdate = await app.inject({
      method: "PATCH",
      url: "/v1/admin/connectors/sandbox-local-api",
      headers: operatorHeaders,
      payload: {
        enabled: false,
        killSwitchReason: "Canary failure under investigation",
        policyStatus: "internal_only",
        productionMethod: null,
        approvalEvidenceUrl: null,
        owner: "engineering",
        supportedAppVersions: [],
        canaryTestId: "sandbox-api-canary",
        changeSummary: "Operator should not be able to mutate",
      },
    });
    expect(operatorUpdate.statusCode).toBe(403);

    const disabled = await app.inject({
      method: "PATCH",
      url: "/v1/admin/connectors/sandbox-local-api",
      headers: adminHeaders,
      payload: {
        enabled: false,
        killSwitchReason: "Canary failure under investigation",
        policyStatus: "internal_only",
        productionMethod: null,
        approvalEvidenceUrl: null,
        owner: "engineering",
        supportedAppVersions: [],
        canaryTestId: "sandbox-api-canary",
        changeSummary: "Disabled after deterministic canary failure",
      },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().connector).toMatchObject({
      enabled: false,
      definitionVersion: 2,
      killSwitchReason: "Canary failure under investigation",
    });
    expect(disabled.json().connector.changeLog.at(-1)).toMatchObject({
      changedBy: "admin-user",
      summary: "Disabled after deterministic canary failure",
    });

    const invalidFeatureDisable = await app.inject({
      method: "PATCH",
      url: "/v1/admin/feature-flags/ai_enrichment_enabled",
      headers: adminHeaders,
      payload: {
        enabled: false,
        killSwitchReason: null,
        owner: "applied-ai",
        changeSummary: "Invalid kill switch request",
      },
    });
    expect(invalidFeatureDisable.statusCode).toBe(409);

    const disabledFeature = await app.inject({
      method: "PATCH",
      url: "/v1/admin/feature-flags/ai_enrichment_enabled",
      headers: adminHeaders,
      payload: {
        enabled: false,
        killSwitchReason: "Provider output quality alert",
        owner: "applied-ai",
        changeSummary: "Paused enrichment after quality canary alert",
      },
    });
    expect(disabledFeature.statusCode).toBe(200);
    expect(disabledFeature.json().featureFlag).toMatchObject({
      enabled: false,
      version: 2,
      killSwitchReason: "Provider output quality alert",
    });

    const householdId = await createHousehold(app);
    const captured = await captureItem(
      app,
      householdId,
      capturePayload(householdId, 99),
    );
    const blockedEnrichment = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/items/${captured.id}/enrich`,
      headers: aliceHeaders,
    });
    expect(blockedEnrichment.statusCode).toBe(503);
    expect(blockedEnrichment.json()).toMatchObject({
      error: "feature_temporarily_disabled",
      details: { feature: "ai_enrichment_enabled" },
    });
  });

  it("gates production releases on evidence and two independent approvals", async () => {
    const selectedPlatforms = [
      "Sandbox Local API",
      "Sandbox Seller Hub",
      "Sandbox Share Export",
    ];
    const connectorIds: string[] = [];
    for (const [index, platform] of selectedPlatforms.entries()) {
      const existing = await repository.getConnector(platform);
      expect(existing).not.toBeNull();
      if (!existing) continue;
      connectorIds.push(existing.id);
      await repository.upsertConnector({
        ...existing,
        enabled: true,
        killSwitchReason: null,
        policyStatus: "approved",
        productionMethod: "Written production approval",
        approvalEvidenceUrl: `https://evidence.example.test/connector/${index}`,
        supportedAppVersions: ["1.0.0"],
        canaryTestId: `production-canary-${index}`,
      });
    }
    const evidence = REQUIRED_RELEASE_EVIDENCE.map((kind, index) => ({
      kind,
      status: REQUIRED_RELEASE_EVIDENCE_STATUS[kind],
      evidenceUrl: `https://evidence.example.test/release/${kind}`,
      contentSha256: index.toString(16).padStart(64, "0"),
      verifiedAt: "2026-08-20T12:00:00.000Z",
    }));

    const operatorCreate = await app.inject({
      method: "POST",
      url: "/v1/admin/releases",
      headers: operatorHeaders,
      payload: {
        version: "v1.0.0",
        target: "v1_public",
        summary: "Governed public launch",
        connectorIds,
        evidence,
      },
    });
    expect(operatorCreate.statusCode).toBe(403);

    const created = await app.inject({
      method: "POST",
      url: "/v1/admin/releases",
      headers: adminHeaders,
      payload: {
        version: "v1.0.0",
        target: "v1_public",
        summary: "Governed public launch",
        connectorIds,
        evidence,
      },
    });
    expect(created.statusCode).toBe(201);
    const releaseId = created.json().release.id as string;

    const submitted = await app.inject({
      method: "POST",
      url: `/v1/admin/releases/${releaseId}/submit`,
      headers: adminHeaders,
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().release.status).toBe("pending_approval");

    const selfApproval = await app.inject({
      method: "POST",
      url: `/v1/admin/releases/${releaseId}/review`,
      headers: adminHeaders,
      payload: { action: "approve" },
    });
    expect(selfApproval.statusCode).toBe(409);

    const firstApproval = await app.inject({
      method: "POST",
      url: `/v1/admin/releases/${releaseId}/review`,
      headers: adminTwoHeaders,
      payload: { action: "approve" },
    });
    expect(firstApproval.json().release).toMatchObject({
      status: "pending_approval",
      approvalActorIds: ["admin-two"],
    });
    const secondApproval = await app.inject({
      method: "POST",
      url: `/v1/admin/releases/${releaseId}/review`,
      headers: adminThreeHeaders,
      payload: { action: "approve" },
    });
    expect(secondApproval.json().release).toMatchObject({
      status: "approved",
      approvalActorIds: ["admin-two", "admin-three"],
    });

    const deployed = await app.inject({
      method: "POST",
      url: `/v1/admin/releases/${releaseId}/review`,
      headers: adminThreeHeaders,
      payload: { action: "deploy" },
    });
    expect(deployed.json().release).toMatchObject({
      status: "deployed",
      deployedAt: "2026-08-20T12:00:00.000Z",
    });
    const visible = await app.inject({
      method: "GET",
      url: "/v1/admin/releases",
      headers: operatorHeaders,
    });
    expect(visible.json().releases[0]).toMatchObject({
      id: releaseId,
      status: "deployed",
    });
    expect(
      await repository.countRecentAuditEvents(
        "production_release.deployed",
        "2026-08-20T00:00:00.000Z",
      ),
    ).toBe(1);
  });

  it("enriches sanitized photos once, validates evidence, and reuses the result", async () => {
    const householdId = await createHousehold(app);
    const captured = await captureItem(
      app,
      householdId,
      capturePayload(householdId, 4),
    );
    const url = `/v1/households/${householdId}/items/${captured.id}/enrich`;

    const first = await app.inject({
      method: "POST",
      url,
      headers: aliceHeaders,
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      reused: false,
      enrichment: {
        provider: "test-provider",
        model: "deterministic-v1",
        output: {
          identification: { itemType: "Side table", confidence: 0.82 },
          unresolvedQuestions: ["Is the top solid wood or veneer?"],
        },
      },
    });

    const second = await app.inject({
      method: "POST",
      url,
      headers: aliceHeaders,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ reused: true });
    expect(intelligenceCalls).toBe(1);
    expect(signedMediaPaths).toEqual([`${householdId}/uploads/item-4.jpg`]);

    const latest = await app.inject({
      method: "GET",
      url: `/v1/households/${householdId}/items/${captured.id}/enrichment`,
      headers: aliceHeaders,
    });
    expect(latest.statusCode).toBe(200);
    expect(latest.json().enrichment.id).toBe(first.json().enrichment.id);

    const reviewedItem = await app.inject({
      method: "GET",
      url: `/v1/households/${householdId}/items/${captured.id}`,
      headers: aliceHeaders,
    });
    expect(reviewedItem.json().item.media[0]).toMatchObject({
      isLead: true,
      qualityIssues: ["glare", "possible_address"],
      redactionState: "suggested",
    });
    const mediaAssetId = reviewedItem.json().item.media[0].id as string;
    const listing = await createApprovedListing(app, householdId, captured.id);
    const privacyBlocked = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/items/${captured.id}/publish`,
      headers: aliceHeaders,
      payload: {
        platforms: ["Sandbox Local API"],
        listingVersion: listing.version,
        sellerDeviceId: null,
      },
    });
    expect(privacyBlocked.statusCode).toBe(409);
    expect(privacyBlocked.json()).toMatchObject({
      error: "media_privacy_review_required",
    });

    const replacementPath = `${householdId}/uploads/redacted-item-4.jpg`;
    const replacement = await app.inject({
      method: "PUT",
      url: `/v1/households/${householdId}/items/${captured.id}/media/${mediaAssetId}`,
      headers: aliceHeaders,
      payload: {
        replacement: {
          storagePath: replacementPath,
          contentSha256: "f".repeat(64),
          mediaType: "image/jpeg",
          source: "library",
          qualityIssues: [],
          redactionState: "not_needed",
          exifLocationStripped: true,
        },
        confirmPrivateDetailsRemoved: true,
      },
    });
    expect(replacement.statusCode).toBe(200);
    expect(replacement.json().item.media[0]).toMatchObject({
      storagePath: replacementPath,
      redactionState: "applied",
      exifLocationStripped: true,
    });
    expect(deletedMediaPaths).toEqual([`${householdId}/uploads/item-4.jpg`]);

    const publishAfterRedaction = await app.inject({
      method: "POST",
      url: `/v1/households/${householdId}/items/${captured.id}/publish`,
      headers: aliceHeaders,
      payload: {
        platforms: ["Sandbox Local API"],
        listingVersion: listing.version,
        sellerDeviceId: null,
      },
    });
    expect(publishAfterRedaction.statusCode).toBe(202);

    const forbidden = await app.inject({
      method: "GET",
      url: `/v1/households/${householdId}/items/${captured.id}/enrichment`,
      headers: bobHeaders,
    });
    expect(forbidden.statusCode).toBe(403);
  });
});

async function createHousehold(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/households",
    headers: aliceHeaders,
    payload: {
      name: "Alice household",
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
  expect(response.statusCode).toBe(201);
  return response.json().household.id as string;
}

function capturePayload(householdId: string, index: number) {
  return {
    title: `Oak side table ${index}`,
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
        storagePath: `${householdId}/uploads/item-${index}.jpg`,
        contentSha256: index.toString(16).padStart(64, "0"),
        mediaType: "image/jpeg",
        source: "camera",
        qualityIssues: [],
        redactionState: "not_needed",
        exifLocationStripped: true,
      },
    ],
    barcode: null,
    imageFingerprint: `fingerprint-${index}`,
  };
}

async function captureItem(
  app: FastifyInstance,
  householdId: string,
  payload: unknown,
) {
  const response = await app.inject({
    method: "POST",
    url: `/v1/households/${householdId}/items`,
    headers: aliceHeaders,
    payload,
  });
  expect(response.statusCode).toBe(201);
  return response.json().item as { id: string };
}

async function createApprovedListing(
  app: FastifyInstance,
  householdId: string,
  itemId: string,
) {
  const response = await app.inject({
    method: "POST",
    url: `/v1/households/${householdId}/items/${itemId}/listings`,
    headers: aliceHeaders,
    payload: {
      title: "Solid oak side table",
      description:
        "Solid oak side table with a small scratch shown clearly in the photos.",
      conditionSummary: "Good used condition with one small cosmetic scratch.",
      specifications: {
        material: { value: "oak", provenance: "user_confirmed", confidence: 1 },
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
      restrictedItemStatus: "clear",
      restrictedItemReasons: [],
      approve: true,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().listing as { id: string; version: number };
}

function enrichmentOutput(mediaAssetId: string): ItemEnrichmentOutput {
  const evidence = [
    { mediaAssetId, observation: "A small wood table is visible" },
  ];
  return {
    identification: {
      itemType: "Side table",
      category: "Furniture",
      brand: null,
      model: null,
      confidence: 0.82,
      alternatives: [{ label: "End table", confidence: 0.68 }],
      extractedText: [],
      barcodes: [],
    },
    title: {
      value: "Wood side table",
      confidence: 0.82,
      provenance: "image_derived",
      evidence,
    },
    category: {
      value: "Furniture",
      confidence: 0.9,
      provenance: "image_derived",
      evidence,
    },
    brand: {
      value: null,
      confidence: 0,
      provenance: "inferred",
      evidence: [],
    },
    model: {
      value: null,
      confidence: 0,
      provenance: "inferred",
      evidence: [],
    },
    condition: { value: "good", confidence: 0.72, evidence },
    dimensions: [],
    specifications: [],
    accessories: [],
    defects: [
      {
        value: "Small scratch on top",
        confidence: 0.84,
        provenance: "image_derived",
        evidence: [
          {
            mediaAssetId,
            observation: "A small top-surface scratch is visible",
          },
        ],
      },
    ],
    mediaAssessments: [
      {
        mediaAssetId,
        qualityIssues: ["glare", "possible_address"],
        redactionSuggested: true,
        redactionReasons: ["A possible street address is visible"],
        leadPhotoScore: 0.9,
        leadPhotoReasons: ["Sharp complete view of the item"],
      },
    ],
    suggestedAdditionalPhotos: [
      {
        kind: "label",
        rationale: "A maker label could confirm the manufacturer.",
      },
    ],
    listingDraft: {
      title: "Wood side table",
      description: "Wood side table with a small scratch shown in the photo.",
      conditionSummary: "Good used condition with a visible scratch.",
    },
    clearingRecommendation: {
      value: "sell",
      confidence: 0.75,
      rationale: "The item appears usable and straightforward to list locally.",
    },
    restrictedSignals: [],
    unresolvedQuestions: ["Is the top solid wood or veneer?"],
  };
}
