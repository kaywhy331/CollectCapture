import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MediaVerificationError,
  verifyMediaBytes,
  type SupportedMediaType,
} from "../src/media-verification.js";

describe("server-side media verification", () => {
  it("accepts bytes only when their type and SHA-256 digest match", () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    expect(verify(jpeg, "image/jpeg")).toEqual({
      contentSha256: sha256(jpeg),
      mediaType: "image/jpeg",
      exifLocationStripped: true,
      sizeBytes: jpeg.byteLength,
    });

    expectCode(() => verify(jpeg, "image/png"), "media_type_mismatch");
    expectCode(
      () =>
        verifyMediaBytes(jpeg, {
          expectedSha256: "0".repeat(64),
          declaredMediaType: "image/jpeg",
        }),
      "media_hash_mismatch",
    );
    expectCode(() => verify(jpeg, "image/jpeg", 3), "media_too_large");
  });

  it.each([
    ["JPEG", jpegWithExif(gpsTiff()), "image/jpeg"],
    ["PNG", pngWithExif(gpsTiff()), "image/png"],
    ["WebP", webpWithExif(gpsTiff()), "image/webp"],
  ] as const)("rejects GPS EXIF in %s media", (_label, bytes, mediaType) => {
    expectCode(() => verify(bytes, mediaType), "media_location_present");
  });

  it("rejects textual XMP location metadata", () => {
    const bytes = Uint8Array.from([
      0xff,
      0xd8,
      0xff,
      0xfe,
      0x00,
      0x12,
      ...Buffer.from("exif:GPSLatitude"),
      0xff,
      0xd9,
    ]);
    expectCode(() => verify(bytes, "image/jpeg"), "media_location_present");
  });

  it("fails closed on truncated JPEG and inconsistent WebP containers", () => {
    const truncatedJpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xff]);
    expectCode(
      () => verify(truncatedJpeg, "image/jpeg"),
      "media_metadata_invalid",
    );

    const malformedWebp = Uint8Array.from([
      ...Buffer.from("RIFF"),
      0x00,
      0x00,
      0x00,
      0x00,
      ...Buffer.from("WEBP"),
    ]);
    expectCode(
      () => verify(malformedWebp, "image/webp"),
      "media_metadata_invalid",
    );
  });
});

function verify(
  bytes: Uint8Array,
  declaredMediaType: SupportedMediaType,
  maxBytes?: number,
) {
  return verifyMediaBytes(
    bytes,
    { expectedSha256: sha256(bytes), declaredMediaType },
    maxBytes,
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectCode(
  operation: () => unknown,
  code: MediaVerificationError["code"],
): void {
  try {
    operation();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(MediaVerificationError);
    expect((error as MediaVerificationError).code).toBe(code);
  }
}

function gpsTiff(): Uint8Array {
  return Uint8Array.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x25, 0x88,
    0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x1a, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00,
  ]);
}

function jpegWithExif(tiff: Uint8Array): Uint8Array {
  const payload = Uint8Array.from([...Buffer.from("Exif\0\0"), ...tiff]);
  const segmentLength = payload.byteLength + 2;
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe1,
    segmentLength >> 8,
    segmentLength & 0xff,
    ...payload,
    0xff,
    0xd9,
  ]);
}

function pngWithExif(tiff: Uint8Array): Uint8Array {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...uint32(tiff.byteLength),
    ...Buffer.from("eXIf"),
    ...tiff,
    0,
    0,
    0,
    0,
    ...uint32(0),
    ...Buffer.from("IEND"),
    0,
    0,
    0,
    0,
  ]);
}

function webpWithExif(tiff: Uint8Array): Uint8Array {
  const padding = tiff.byteLength % 2;
  const riffSize = 4 + 8 + tiff.byteLength + padding;
  return Uint8Array.from([
    ...Buffer.from("RIFF"),
    ...uint32(riffSize, true),
    ...Buffer.from("WEBP"),
    ...Buffer.from("EXIF"),
    ...uint32(tiff.byteLength, true),
    ...tiff,
    ...(padding ? [0] : []),
  ]);
}

function uint32(value: number, littleEndian = false): number[] {
  const bytes = [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
  return littleEndian ? bytes.reverse() : bytes;
}
