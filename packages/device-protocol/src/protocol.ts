import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import {
  DeviceCommandPayloadSchema,
  PairingDeviceInfoSchema,
  PairingQrPayloadSchema,
  PairingResponseSchema,
  DeviceReceiptPayloadSchema,
  SignedDeviceReceiptSchema,
  SignedDeviceCommandSchema,
  type DeviceCommandPayload,
  type PairingDeviceInfo,
  type PairingQrPayload,
  type PairingResponse,
  type DeviceReceiptPayload,
  type SignedDeviceReceipt,
  type SignedDeviceCommand,
} from "./schemas.js";

type VerificationCode =
  | "malformed"
  | "signature_invalid"
  | "expired"
  | "not_yet_valid"
  | "scope_mismatch"
  | "replayed";

export class DeviceCommandVerificationError extends Error {
  constructor(
    readonly code: VerificationCode,
    message: string,
  ) {
    super(message);
    this.name = "DeviceCommandVerificationError";
  }
}

export interface NonceStore {
  consume(deviceId: string, nonce: string, expiresAt: string): Promise<boolean>;
}

export class MemoryNonceStore implements NonceStore {
  readonly #consumed = new Map<string, number>();

  async consume(
    deviceId: string,
    nonce: string,
    expiresAt: string,
  ): Promise<boolean> {
    const now = Date.now();
    for (const [key, expiry] of this.#consumed) {
      if (expiry <= now) this.#consumed.delete(key);
    }
    const key = `${deviceId}:${nonce}`;
    if (this.#consumed.has(key)) return false;
    this.#consumed.set(key, new Date(expiresAt).getTime());
    return true;
  }
}

export function signDeviceCommand(
  payload: DeviceCommandPayload,
  input: { keyId: string; privateKey: string | KeyObject },
): SignedDeviceCommand {
  const parsed = DeviceCommandPayloadSchema.parse(payload);
  const signature = signWithP256Key(canonicalJson(parsed), input.privateKey);
  return SignedDeviceCommandSchema.parse({
    keyId: input.keyId,
    payload: parsed,
    signature,
  });
}

export async function verifyDeviceCommand(
  command: unknown,
  input: {
    publicKey: string | KeyObject;
    expectedKeyId: string;
    expectedUserId: string;
    expectedHouseholdId: string;
    expectedDeviceId: string;
    expectedPlatformAppVersion: string;
    nonceStore: NonceStore;
    now?: Date;
  },
): Promise<DeviceCommandPayload> {
  const result = SignedDeviceCommandSchema.safeParse(command);
  if (!result.success) {
    throw new DeviceCommandVerificationError(
      "malformed",
      "Command envelope is malformed",
    );
  }
  const signed = result.data;
  if (signed.keyId !== input.expectedKeyId) {
    throw new DeviceCommandVerificationError(
      "signature_invalid",
      "Signing key is not trusted",
    );
  }
  if (
    signed.payload.userId !== input.expectedUserId ||
    signed.payload.householdId !== input.expectedHouseholdId ||
    signed.payload.deviceId !== input.expectedDeviceId ||
    signed.payload.platformAppVersion !== input.expectedPlatformAppVersion
  ) {
    throw new DeviceCommandVerificationError(
      "scope_mismatch",
      "Command scope does not match this device",
    );
  }
  const now = (input.now ?? new Date()).getTime();
  if (now < new Date(signed.payload.issuedAt).getTime() - 30_000) {
    throw new DeviceCommandVerificationError(
      "not_yet_valid",
      "Command issue time is in the future",
    );
  }
  if (now >= new Date(signed.payload.expiresAt).getTime()) {
    throw new DeviceCommandVerificationError("expired", "Command has expired");
  }
  const valid = verifyWithP256Key(
    canonicalJson(signed.payload),
    signed.signature,
    input.publicKey,
  );
  if (!valid) {
    throw new DeviceCommandVerificationError(
      "signature_invalid",
      "Command signature is invalid",
    );
  }
  if (
    !(await input.nonceStore.consume(
      signed.payload.deviceId,
      signed.payload.nonce,
      signed.payload.expiresAt,
    ))
  ) {
    throw new DeviceCommandVerificationError(
      "replayed",
      "Command nonce has already been consumed",
    );
  }
  return signed.payload;
}

export interface PairingChallengeRecord {
  id: string;
  householdId: string;
  secretHash: string;
  expiresAt: string;
}

export function createPairingChallenge(input: {
  challengeId: string;
  householdId: string;
  apiBaseUrl: string;
  now?: Date;
  lifetimeMs?: number;
}): { qr: PairingQrPayload; record: PairingChallengeRecord } {
  const now = input.now ?? new Date();
  const secret = randomBytes(32).toString("base64url");
  const expiresAt = new Date(
    now.getTime() + (input.lifetimeMs ?? 5 * 60_000),
  ).toISOString();
  const qr = PairingQrPayloadSchema.parse({
    version: 1,
    challengeId: input.challengeId,
    householdId: input.householdId,
    apiBaseUrl: input.apiBaseUrl,
    secret,
    expiresAt,
  });
  return {
    qr,
    record: {
      id: input.challengeId,
      householdId: input.householdId,
      secretHash: pairingSecretHash(secret),
      expiresAt,
    },
  };
}

export function createPairingResponse(
  qrInput: PairingQrPayload,
  deviceInput: PairingDeviceInfo,
  privateKey: string | KeyObject,
): PairingResponse {
  const qr = PairingQrPayloadSchema.parse(qrInput);
  const device = PairingDeviceInfoSchema.parse(deviceInput);
  const proof = pairingProof(qr.secret, qr.challengeId, qr.householdId, device);
  return PairingResponseSchema.parse({
    challengeId: qr.challengeId,
    householdId: qr.householdId,
    device,
    proof,
    keyProof: signWithP256Key(
      canonicalJson(pairingBinding(qr.challengeId, qr.householdId, device)),
      privateKey,
    ),
  });
}

export function verifyPairingResponse(input: {
  qrSecret: string;
  record: PairingChallengeRecord;
  response: unknown;
  now?: Date;
}): PairingDeviceInfo {
  const response = PairingResponseSchema.parse(input.response);
  const now = input.now ?? new Date();
  if (
    response.challengeId !== input.record.id ||
    response.householdId !== input.record.householdId
  ) {
    throw new DeviceCommandVerificationError(
      "scope_mismatch",
      "Pairing challenge scope does not match",
    );
  }
  if (now.getTime() >= new Date(input.record.expiresAt).getTime()) {
    throw new DeviceCommandVerificationError(
      "expired",
      "Pairing challenge has expired",
    );
  }
  const suppliedHash = pairingSecretHash(input.qrSecret);
  if (!safeTextEqual(suppliedHash, input.record.secretHash)) {
    throw new DeviceCommandVerificationError(
      "signature_invalid",
      "Pairing secret is invalid",
    );
  }
  const expectedProof = pairingProof(
    input.qrSecret,
    input.record.id,
    input.record.householdId,
    response.device,
  );
  if (!safeTextEqual(expectedProof, response.proof)) {
    throw new DeviceCommandVerificationError(
      "signature_invalid",
      "Pairing proof is invalid",
    );
  }
  if (
    !verifyWithP256Key(
      canonicalJson(
        pairingBinding(
          response.challengeId,
          response.householdId,
          response.device,
        ),
      ),
      response.keyProof,
      response.device.publicKey,
    )
  ) {
    throw new DeviceCommandVerificationError(
      "signature_invalid",
      "Pairing key possession proof is invalid",
    );
  }
  return response.device;
}

export function signDeviceReceipt(
  payloadInput: DeviceReceiptPayload,
  privateKey: string | KeyObject,
): SignedDeviceReceipt {
  const payload = DeviceReceiptPayloadSchema.parse(payloadInput);
  return SignedDeviceReceiptSchema.parse({
    payload,
    signature: signWithP256Key(canonicalJson(payload), privateKey),
  });
}

export async function verifyDeviceReceipt(
  receiptInput: unknown,
  input: {
    publicKey: string | KeyObject;
    expectedDeviceId: string;
    expectedHouseholdId: string;
    nonceStore: NonceStore;
    now?: Date;
  },
): Promise<DeviceReceiptPayload> {
  const result = SignedDeviceReceiptSchema.safeParse(receiptInput);
  if (!result.success) {
    throw new DeviceCommandVerificationError(
      "malformed",
      "Device receipt is malformed",
    );
  }
  const receipt = result.data;
  if (
    receipt.payload.deviceId !== input.expectedDeviceId ||
    receipt.payload.householdId !== input.expectedHouseholdId
  ) {
    throw new DeviceCommandVerificationError(
      "scope_mismatch",
      "Device receipt scope does not match",
    );
  }
  const now = input.now ?? new Date();
  const occurredAt = new Date(receipt.payload.occurredAt).getTime();
  if (Math.abs(now.getTime() - occurredAt) > 5 * 60_000) {
    throw new DeviceCommandVerificationError(
      occurredAt > now.getTime() ? "not_yet_valid" : "expired",
      "Device receipt timestamp is outside the allowed window",
    );
  }
  if (
    !verifyWithP256Key(
      canonicalJson(receipt.payload),
      receipt.signature,
      input.publicKey,
    )
  ) {
    throw new DeviceCommandVerificationError(
      "signature_invalid",
      "Device receipt signature is invalid",
    );
  }
  if (
    !(await input.nonceStore.consume(
      receipt.payload.deviceId,
      receipt.payload.receiptNonce,
      new Date(now.getTime() + 5 * 60_000).toISOString(),
    ))
  ) {
    throw new DeviceCommandVerificationError(
      "replayed",
      "Device receipt nonce has already been consumed",
    );
  }
  return receipt.payload;
}

export function pairingSecretHash(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

function pairingProof(
  secret: string,
  challengeId: string,
  householdId: string,
  device: PairingDeviceInfo,
): string {
  return createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(canonicalJson(pairingBinding(challengeId, householdId, device)))
    .digest("base64url");
}

function pairingBinding(
  challengeId: string,
  householdId: string,
  device: PairingDeviceInfo,
) {
  return { challengeId, householdId, device };
}

function signWithP256Key(
  content: string,
  privateKeyInput: string | KeyObject,
): string {
  const privateKey =
    typeof privateKeyInput === "string"
      ? createPrivateKey(privateKeyInput)
      : privateKeyInput;
  if (!isP256Key(privateKey)) {
    throw new TypeError("Seller Hub signing keys must use P-256 ECDSA");
  }
  return sign("sha256", Buffer.from(content), privateKey).toString("base64url");
}

function verifyWithP256Key(
  content: string,
  signature: string,
  publicKeyInput: string | KeyObject,
): boolean {
  try {
    const publicKey =
      typeof publicKeyInput === "string"
        ? createPublicKey(publicKeyInput)
        : publicKeyInput;
    if (!isP256Key(publicKey)) return false;
    return verify(
      "sha256",
      Buffer.from(content),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

function isP256Key(key: KeyObject): boolean {
  if (key.asymmetricKeyType !== "ec") return false;
  const curve = key.asymmetricKeyDetails?.namedCurve;
  return curve === "prime256v1" || curve === "secp256r1" || curve === "P-256";
}

function safeTextEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
