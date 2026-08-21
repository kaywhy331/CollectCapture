import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DeviceCommandVerificationError,
  MemoryNonceStore,
  canonicalJson,
  createPairingChallenge,
  createPairingResponse,
  signDeviceReceipt,
  signDeviceCommand,
  verifyDeviceCommand,
  verifyPairingResponse,
  verifyDeviceReceipt,
  type DeviceCommandPayload,
} from "../src/index.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});
const now = new Date();

function payload(
  overrides: Partial<DeviceCommandPayload> = {},
): DeviceCommandPayload {
  return {
    version: 1,
    action: "publish",
    jobId: "job-1",
    userId: "user-1",
    householdId: "household-1",
    deviceId: "device-1",
    itemId: "item-1",
    platform: "Sandbox Seller Hub",
    listingVersion: 1,
    connectorVersion: "1.0.0",
    platformAppVersion: "10.4.0",
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    nonce: "uNQJd5dM5rcB3N9GZ9QYwTjZJIb_r61J",
    parameters: {
      canonicalListingId: "listing-1",
      canonicalListingDigest: "a".repeat(64),
      title: "Solid oak side table",
      description: "Good used condition; small scratch is shown in the photos.",
      priceCents: 5_500,
      currency: "USD",
      category: "Furniture",
      condition: "Good",
      approximateLocation: "Potrero Hill",
      platformFields: { delivery: false },
      media: [
        {
          assetId: "asset-1",
          downloadUrl: "https://media.example.test/signed/asset-1",
          sha256: "b".repeat(64),
          expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
          order: 0,
        },
      ],
    },
    ...overrides,
  } as DeviceCommandPayload;
}

describe("canonical command signing", () => {
  it("canonicalizes object keys independently of insertion order", () => {
    expect(canonicalJson({ z: 1, a: { y: true, b: "two" } })).toBe(
      '{"a":{"b":"two","y":true},"z":1}',
    );
  });

  it("accepts one correctly signed, fresh, scoped command", async () => {
    const signed = signDeviceCommand(payload(), {
      keyId: "backend-2026-08",
      privateKey,
    });
    const verified = await verifyDeviceCommand(signed, {
      publicKey,
      expectedKeyId: "backend-2026-08",
      expectedUserId: "user-1",
      expectedHouseholdId: "household-1",
      expectedDeviceId: "device-1",
      expectedPlatformAppVersion: "10.4.0",
      nonceStore: new MemoryNonceStore(),
      now,
    });
    expect(verified.action).toBe("publish");
    expect(verified.parameters.title).toBe("Solid oak side table");
  });

  it("rejects a backend command key Android cannot verify", () => {
    const unsupported = generateKeyPairSync("ed25519");
    expect(() =>
      signDeviceCommand(payload(), {
        keyId: "unsupported-key",
        privateKey: unsupported.privateKey,
      }),
    ).toThrow("P-256 ECDSA");
  });

  it("rejects altered, cross-device, expired, and replayed commands", async () => {
    const signed = signDeviceCommand(payload(), {
      keyId: "backend-2026-08",
      privateKey,
    });
    const common = {
      publicKey,
      expectedKeyId: "backend-2026-08",
      expectedUserId: "user-1",
      expectedHouseholdId: "household-1",
      expectedDeviceId: "device-1",
      expectedPlatformAppVersion: "10.4.0",
      now,
    };

    const altered = structuredClone(signed);
    if (altered.payload.action === "publish")
      altered.payload.parameters.priceCents = 1;
    await expect(
      verifyDeviceCommand(altered, {
        ...common,
        nonceStore: new MemoryNonceStore(),
      }),
    ).rejects.toMatchObject({ code: "signature_invalid" });

    await expect(
      verifyDeviceCommand(signed, {
        ...common,
        expectedDeviceId: "device-2",
        nonceStore: new MemoryNonceStore(),
      }),
    ).rejects.toMatchObject({ code: "scope_mismatch" });

    await expect(
      verifyDeviceCommand(signed, {
        ...common,
        expectedPlatformAppVersion: "10.5.0",
        nonceStore: new MemoryNonceStore(),
      }),
    ).rejects.toMatchObject({ code: "scope_mismatch" });

    await expect(
      verifyDeviceCommand(signed, {
        ...common,
        now: new Date(now.getTime() + 11 * 60_000),
        nonceStore: new MemoryNonceStore(),
      }),
    ).rejects.toMatchObject({ code: "expired" });

    const nonceStore = new MemoryNonceStore();
    await verifyDeviceCommand(signed, { ...common, nonceStore });
    await expect(
      verifyDeviceCommand(signed, { ...common, nonceStore }),
    ).rejects.toMatchObject({
      code: "replayed",
    });
  });

  it("rejects arbitrary actions before signature verification", async () => {
    const signed = signDeviceCommand(payload(), {
      keyId: "backend-2026-08",
      privateKey,
    });
    const malformed = {
      ...signed,
      payload: { ...signed.payload, action: "run_shell" },
    };
    await expect(
      verifyDeviceCommand(malformed, {
        publicKey,
        expectedKeyId: "backend-2026-08",
        expectedUserId: "user-1",
        expectedHouseholdId: "household-1",
        expectedDeviceId: "device-1",
        expectedPlatformAppVersion: "10.4.0",
        nonceStore: new MemoryNonceStore(),
        now,
      }),
    ).rejects.toBeInstanceOf(DeviceCommandVerificationError);
  });
});

describe("QR pairing proof", () => {
  it("binds the QR secret to the household, challenge, and device public key", () => {
    const challenge = createPairingChallenge({
      challengeId: "challenge-1",
      householdId: "household-1",
      apiBaseUrl: "https://api.localclear.example",
      now,
    });
    const device = {
      displayName: "Spare Pixel",
      publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
      androidVersion: 14,
      appVersion: "1.0.0",
    };
    const response = createPairingResponse(challenge.qr, device, privateKey);
    expect(
      verifyPairingResponse({
        qrSecret: challenge.qr.secret,
        record: challenge.record,
        response,
        now,
      }),
    ).toEqual({ ...device, publicKey: device.publicKey.trim() });

    expect(() =>
      verifyPairingResponse({
        qrSecret: "x".repeat(43),
        record: challenge.record,
        response,
        now,
      }),
    ).toThrow(DeviceCommandVerificationError);
    expect(() =>
      verifyPairingResponse({
        qrSecret: challenge.qr.secret,
        record: challenge.record,
        response: {
          ...response,
          device: {
            ...response.device,
            publicKey: "different-public-key-material".repeat(2),
          },
        },
        now,
      }),
    ).toThrow(DeviceCommandVerificationError);
  });

  it("rejects expired pairing challenges", () => {
    const challenge = createPairingChallenge({
      challengeId: "challenge-2",
      householdId: "household-1",
      apiBaseUrl: "https://api.localclear.example",
      now,
      lifetimeMs: 1_000,
    });
    const response = createPairingResponse(
      challenge.qr,
      {
        displayName: "Spare Pixel",
        publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
        androidVersion: 14,
        appVersion: "1.0.0",
      },
      privateKey,
    );
    expect(() =>
      verifyPairingResponse({
        qrSecret: challenge.qr.secret,
        record: challenge.record,
        response,
        now: new Date(now.getTime() + 1_001),
      }),
    ).toThrow("expired");
  });
});

describe("device-signed receipts", () => {
  it("accepts an EC Android-style key once and rejects replay", async () => {
    const deviceKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const receipt = signDeviceReceipt(
      {
        version: 1,
        deviceId: "device-1",
        householdId: "household-1",
        jobId: "job-1",
        commandNonce: "command_nonce_long_enough_123",
        receiptNonce: "receipt_nonce_long_enough_123",
        sequence: 1,
        occurredAt: now.toISOString(),
        event: { type: "advance" },
      },
      deviceKeys.privateKey,
    );
    const nonceStore = new MemoryNonceStore();
    await expect(
      verifyDeviceReceipt(receipt, {
        publicKey: deviceKeys.publicKey,
        expectedDeviceId: "device-1",
        expectedHouseholdId: "household-1",
        nonceStore,
        now,
      }),
    ).resolves.toMatchObject({ jobId: "job-1", sequence: 1 });
    await expect(
      verifyDeviceReceipt(receipt, {
        publicKey: deviceKeys.publicKey,
        expectedDeviceId: "device-1",
        expectedHouseholdId: "household-1",
        nonceStore,
        now,
      }),
    ).rejects.toMatchObject({ code: "replayed" });
  });
});
