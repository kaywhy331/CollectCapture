import { PublishingCommandActionSchema } from "@localclear/domain";
import { z } from "zod";

const IdSchema = z.string().trim().min(1).max(128);
const TimestampSchema = z.string().datetime({ offset: true });

const BaseCommandShape = {
  version: z.literal(1),
  jobId: IdSchema,
  userId: IdSchema,
  householdId: IdSchema,
  deviceId: IdSchema,
  itemId: IdSchema,
  platform: z.string().trim().min(1).max(80),
  listingVersion: z.number().int().min(1),
  connectorVersion: z.string().trim().min(1).max(64),
  platformAppVersion: z.string().trim().min(1).max(64),
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  nonce: z.string().trim().min(22).max(128),
} as const;

export const CommandMediaSchema = z
  .object({
    assetId: IdSchema,
    downloadUrl: z.url(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: TimestampSchema,
    order: z.number().int().min(0).max(11),
  })
  .strict();

const PublishParametersSchema = z
  .object({
    canonicalListingId: IdSchema,
    canonicalListingDigest: z.string().regex(/^[a-f0-9]{64}$/),
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().min(1).max(10_000),
    priceCents: z.number().int().min(0),
    currency: z.string().length(3),
    category: z.string().trim().min(1).max(240),
    condition: z.string().trim().min(1).max(240),
    approximateLocation: z.string().trim().min(1).max(240),
    platformFields: z.record(
      z.string().trim().min(1).max(120),
      z.union([z.string(), z.number(), z.boolean()]),
    ),
    media: z.array(CommandMediaSchema).min(1).max(12),
  })
  .strict();

const UpdateParametersSchema = z
  .object({
    externalListingId: z.string().trim().min(1).max(240),
    fields: z
      .object({
        title: z.string().trim().min(1).max(500).optional(),
        description: z.string().trim().min(1).max(10_000).optional(),
        priceCents: z.number().int().min(0).optional(),
        category: z.string().trim().min(1).max(240).optional(),
        condition: z.string().trim().min(1).max(240).optional(),
        approximateLocation: z.string().trim().min(1).max(240).optional(),
      })
      .strict(),
  })
  .strict();

const ExternalListingParametersSchema = z
  .object({ externalListingId: z.string().trim().min(1).max(240) })
  .strict();
const EmptyParametersSchema = z.object({}).strict();
const PauseParametersSchema = z
  .object({ reasonCode: z.string().trim().min(1).max(120) })
  .strict();

export const DeviceCommandPayloadSchema = z
  .discriminatedUnion("action", [
    z
      .object({
        ...BaseCommandShape,
        action: z.literal("publish"),
        parameters: PublishParametersSchema,
      })
      .strict(),
    z
      .object({
        ...BaseCommandShape,
        action: z.literal("update_fields"),
        parameters: UpdateParametersSchema,
      })
      .strict(),
    z
      .object({
        ...BaseCommandShape,
        action: z.literal("mark_sold"),
        parameters: ExternalListingParametersSchema,
      })
      .strict(),
    z
      .object({
        ...BaseCommandShape,
        action: z.literal("delist"),
        parameters: ExternalListingParametersSchema,
      })
      .strict(),
    z
      .object({
        ...BaseCommandShape,
        action: z.literal("check_connection"),
        parameters: EmptyParametersSchema,
      })
      .strict(),
    z
      .object({
        ...BaseCommandShape,
        action: z.literal("pause"),
        parameters: PauseParametersSchema,
      })
      .strict(),
    z
      .object({
        ...BaseCommandShape,
        action: z.literal("resume"),
        parameters: EmptyParametersSchema,
      })
      .strict(),
  ])
  .superRefine((command, context) => {
    const issued = new Date(command.issuedAt).getTime();
    const expires = new Date(command.expiresAt).getTime();
    if (expires <= issued) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Command must expire after issue",
      });
    }
    if (expires - issued > 15 * 60_000) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Command lifetime cannot exceed 15 minutes",
      });
    }
  });
export type DeviceCommandPayload = z.infer<typeof DeviceCommandPayloadSchema>;

export const SignedDeviceCommandSchema = z
  .object({
    keyId: z.string().trim().min(1).max(128),
    payload: DeviceCommandPayloadSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
export type SignedDeviceCommand = z.infer<typeof SignedDeviceCommandSchema>;

export const PairingQrPayloadSchema = z
  .object({
    version: z.literal(1),
    challengeId: IdSchema,
    householdId: IdSchema,
    apiBaseUrl: z.url(),
    secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expiresAt: TimestampSchema,
  })
  .strict();
export type PairingQrPayload = z.infer<typeof PairingQrPayloadSchema>;

export const PairingDeviceInfoSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    publicKey: z.string().trim().min(32),
    androidVersion: z.number().int().min(11),
    appVersion: z.string().trim().min(1).max(64),
  })
  .strict();
export type PairingDeviceInfo = z.infer<typeof PairingDeviceInfoSchema>;

export const PairingResponseSchema = z
  .object({
    challengeId: IdSchema,
    householdId: IdSchema,
    device: PairingDeviceInfoSchema,
    proof: z.string().regex(/^[A-Za-z0-9_-]+$/),
    keyProof: z.string().regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
export type PairingResponse = z.infer<typeof PairingResponseSchema>;

const DevicePausedStateSchema = z.enum([
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

export const DevicePublishingEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("advance") }).strict(),
  z
    .object({
      type: z.literal("pause"),
      state: DevicePausedStateSchema,
      reasonCode: z.string().trim().min(1).max(120),
      detail: z.string().trim().max(1_000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("retryable_failure"),
      reasonCode: z.string().trim().min(1).max(120),
      detail: z.string().trim().max(1_000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("fatal_failure"),
      reasonCode: z.string().trim().min(1).max(120),
      detail: z.string().trim().max(1_000).optional(),
    })
    .strict(),
  z.object({ type: z.literal("resume") }).strict(),
  z.object({ type: z.literal("retry") }).strict(),
  z
    .object({
      type: z.literal("cancel"),
      reasonCode: z.string().trim().min(1).max(120).optional(),
    })
    .strict(),
]);

export const DeviceReceiptPayloadSchema = z
  .object({
    version: z.literal(1),
    deviceId: IdSchema,
    householdId: IdSchema,
    jobId: IdSchema,
    commandNonce: z.string().trim().min(22).max(128),
    receiptNonce: z.string().trim().min(22).max(128),
    sequence: z.number().int().min(1).max(10_000),
    occurredAt: TimestampSchema,
    event: DevicePublishingEventSchema,
    result: z
      .object({
        externalListingId: z.string().trim().max(240).nullable(),
        externalUrl: z.url().nullable(),
        platformTitle: z.string().trim().min(1).max(500).optional(),
        platformPrice: z
          .object({
            amountCents: z.number().int().min(0),
            currency: z.string().length(3),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type DeviceReceiptPayload = z.infer<typeof DeviceReceiptPayloadSchema>;

export const SignedDeviceReceiptSchema = z
  .object({
    payload: DeviceReceiptPayloadSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
export type SignedDeviceReceipt = z.infer<typeof SignedDeviceReceiptSchema>;

export const ALLOWED_DEVICE_ACTIONS = PublishingCommandActionSchema.options;
