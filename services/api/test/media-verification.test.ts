import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  imageDimensions,
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

function pngWithDimensions(width: number, height: number): Uint8Array {
  const ihdrData = Uint8Array.from([
    ...uint32(width),
    ...uint32(height),
    8, // bit depth
    6, // color type (RGBA)
    0, // compression method
    0, // filter method
    0, // interlace method
  ]);
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a, // signature
    ...uint32(ihdrData.byteLength),
    ...Buffer.from("IHDR"),
    ...ihdrData,
    0,
    0,
    0,
    0, // CRC (not validated by imageDimensions)
    ...uint32(0),
    ...Buffer.from("IEND"),
    0,
    0,
    0,
    0,
  ]);
}

function jpegWithDimensions(width: number, height: number): Uint8Array {
  const sofData = Uint8Array.from([
    8, // precision
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    1, // one component
    1,
    0x11,
    0,
  ]);
  const segmentLength = sofData.byteLength + 2;
  return Uint8Array.from([
    0xff,
    0xd8, // SOI
    0xff,
    0xc0, // SOF0
    (segmentLength >> 8) & 0xff,
    segmentLength & 0xff,
    ...sofData,
  ]);
}

function webpVp8xWithDimensions(width: number, height: number): Uint8Array {
  const widthMinus1 = width - 1;
  const heightMinus1 = height - 1;
  const chunkData = Uint8Array.from([
    0x10,
    0,
    0,
    0, // flags + reserved
    widthMinus1 & 0xff,
    (widthMinus1 >> 8) & 0xff,
    (widthMinus1 >> 16) & 0xff,
    heightMinus1 & 0xff,
    (heightMinus1 >> 8) & 0xff,
    (heightMinus1 >> 16) & 0xff,
  ]);
  return webpFile("VP8X", chunkData);
}

function webpVp8lWithDimensions(width: number, height: number): Uint8Array {
  const widthMinus1 = width - 1;
  const heightMinus1 = height - 1;
  const bits = (widthMinus1 & 0x3fff) | ((heightMinus1 & 0x3fff) << 14);
  const chunkData = Uint8Array.from([
    0x2f, // VP8L signature
    bits & 0xff,
    (bits >>> 8) & 0xff,
    (bits >>> 16) & 0xff,
    (bits >>> 24) & 0xff,
  ]);
  return webpFile("VP8L", chunkData);
}

function webpVp8WithDimensions(width: number, height: number): Uint8Array {
  const chunkData = Uint8Array.from([
    0,
    0,
    0, // frame tag
    0x9d,
    0x01,
    0x2a, // start code
    width & 0xff,
    (width >> 8) & 0xff,
    height & 0xff,
    (height >> 8) & 0xff,
  ]);
  return webpFile("VP8 ", chunkData);
}

function webpFile(fourCc: string, chunkData: Uint8Array): Uint8Array {
  const riffSize = 4 + 8 + chunkData.byteLength;
  return Uint8Array.from([
    ...Buffer.from("RIFF"),
    ...uint32(riffSize, true),
    ...Buffer.from("WEBP"),
    ...Buffer.from(fourCc),
    ...uint32(chunkData.byteLength, true),
    ...chunkData,
  ]);
}

describe("imageDimensions (G22a)", () => {
  it("parses PNG dimensions from the IHDR chunk", () => {
    expect(imageDimensions(pngWithDimensions(320, 240), "image/png")).toEqual({
      width: 320,
      height: 240,
    });
  });

  it("parses JPEG dimensions from a SOF0 segment", () => {
    expect(imageDimensions(jpegWithDimensions(640, 480), "image/jpeg")).toEqual(
      { width: 640, height: 480 },
    );
  });

  it("parses WebP dimensions from a VP8X (extended) chunk", () => {
    expect(
      imageDimensions(webpVp8xWithDimensions(500, 300), "image/webp"),
    ).toEqual({ width: 500, height: 300 });
  });

  it("parses WebP dimensions from a VP8L (lossless) chunk", () => {
    expect(
      imageDimensions(webpVp8lWithDimensions(100, 50), "image/webp"),
    ).toEqual({ width: 100, height: 50 });
  });

  it("parses WebP dimensions from a VP8 (lossy) chunk", () => {
    expect(
      imageDimensions(webpVp8WithDimensions(200, 150), "image/webp"),
    ).toEqual({ width: 200, height: 150 });
  });

  it("fails closed on a PNG without a leading IHDR chunk", () => {
    const bytes = Uint8Array.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...uint32(0),
      ...Buffer.from("IEND"),
    ]);
    expect(() => imageDimensions(bytes, "image/png")).toThrow(
      MediaVerificationError,
    );
  });

  it("fails closed on a JPEG with no SOF segment", () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    expect(() => imageDimensions(bytes, "image/jpeg")).toThrow(
      MediaVerificationError,
    );
  });

  it("fails closed on a WebP with no recognized VP8/VP8L/VP8X chunk", () => {
    const chunkData = Uint8Array.from([0, 0, 0, 0]);
    const bytes = webpFile("ANIM", chunkData);
    expect(() => imageDimensions(bytes, "image/webp")).toThrow(
      MediaVerificationError,
    );
  });
});

describe("minimum resolution gate (G22b)", () => {
  it("passes a 1x1 image when the gate is disabled (min=0, default)", () => {
    const bytes = pngWithDimensions(1, 1);
    expect(() =>
      verifyMediaBytes(
        bytes,
        { expectedSha256: sha256(bytes), declaredMediaType: "image/png" },
        undefined,
        0,
      ),
    ).not.toThrow();
  });

  it("rejects a 1x1 and a 199px image when min=200", () => {
    for (const bytes of [
      pngWithDimensions(1, 1),
      pngWithDimensions(199, 300),
    ]) {
      expectCode(
        () =>
          verifyMediaBytes(
            bytes,
            {
              expectedSha256: sha256(bytes),
              declaredMediaType: "image/png",
            },
            undefined,
            200,
          ),
        "media_resolution_too_low",
      );
    }
  });

  it("passes an exactly-200px image when min=200 (shortest side)", () => {
    const bytes = pngWithDimensions(200, 400);
    expect(() =>
      verifyMediaBytes(
        bytes,
        { expectedSha256: sha256(bytes), declaredMediaType: "image/png" },
        undefined,
        200,
      ),
    ).not.toThrow();
  });

  it("tells the user to retake a larger photo, not that the image is invalid", () => {
    const bytes = pngWithDimensions(1, 1);
    try {
      verifyMediaBytes(
        bytes,
        { expectedSha256: sha256(bytes), declaredMediaType: "image/png" },
        undefined,
        200,
      );
      throw new Error("expected verifyMediaBytes to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MediaVerificationError);
      const message = (error as MediaVerificationError).message.toLowerCase();
      expect(message).toContain("retake");
      expect(message).not.toContain("invalid");
    }
  });
});
