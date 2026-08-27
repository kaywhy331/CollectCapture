import { createHash } from "node:crypto";

export type SupportedMediaType = "image/jpeg" | "image/png" | "image/webp";

export interface MediaVerificationRequest {
  storagePath: string;
  expectedSha256: string;
  declaredMediaType: SupportedMediaType;
}

export interface VerifiedMedia {
  contentSha256: string;
  mediaType: SupportedMediaType;
  exifLocationStripped: boolean;
  sizeBytes: number;
}

export interface MediaVerificationProvider {
  verify(request: MediaVerificationRequest): Promise<VerifiedMedia>;
}

export class MediaVerificationError extends Error {
  constructor(
    readonly code:
      | "media_unavailable"
      | "media_too_large"
      | "media_type_mismatch"
      | "media_hash_mismatch"
      | "media_metadata_invalid"
      | "media_location_present"
      | "media_resolution_too_low",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MediaVerificationError";
  }
}

export class UnavailableMediaVerificationProvider implements MediaVerificationProvider {
  async verify(): Promise<VerifiedMedia> {
    throw new MediaVerificationError(
      "media_unavailable",
      "Server-side media verification is not configured",
    );
  }
}

export function verifyMediaBytes(
  bytes: Uint8Array,
  request: Omit<MediaVerificationRequest, "storagePath">,
  maxBytes = 20 * 1024 * 1024,
  /** Shortest-side pixel minimum (G22). `0` (the default) disables the
   * check entirely -- dimensions are not even parsed -- so this stays a
   * strict no-op addition for every existing caller. */
  minDimension = 0,
): VerifiedMedia {
  if (bytes.byteLength > maxBytes) {
    throw new MediaVerificationError(
      "media_too_large",
      `Uploaded media exceeds the ${maxBytes}-byte verification limit`,
    );
  }
  const mediaType = sniffMediaType(bytes);
  if (!mediaType || mediaType !== request.declaredMediaType) {
    throw new MediaVerificationError(
      "media_type_mismatch",
      "Uploaded media bytes do not match the declared media type",
    );
  }
  const contentSha256 = createHash("sha256").update(bytes).digest("hex");
  if (contentSha256 !== request.expectedSha256) {
    throw new MediaVerificationError(
      "media_hash_mismatch",
      "Uploaded media bytes do not match the declared SHA-256 digest",
    );
  }
  if (containsGpsMetadata(bytes, mediaType)) {
    throw new MediaVerificationError(
      "media_location_present",
      "Uploaded media still contains GPS location metadata",
    );
  }
  if (minDimension > 0) {
    const { width, height } = imageDimensions(bytes, mediaType);
    const shortestSide = Math.min(width, height);
    if (shortestSide < minDimension) {
      throw new MediaVerificationError(
        "media_resolution_too_low",
        `The photo is too small to search accurately (shortest side ${shortestSide}px, minimum ${minDimension}px). Please retake it larger or move closer to the card.`,
      );
    }
  }
  return {
    contentSha256,
    mediaType,
    exifLocationStripped: true,
    sizeBytes: bytes.byteLength,
  };
}

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Parses pixel dimensions from container headers only (G22) -- PNG's IHDR
 * chunk, a JPEG baseline/progressive SOFn segment, or a WebP VP8/VP8L/VP8X
 * chunk header. Never decodes pixel data. A malformed or truncated
 * container where dimensions should be throws `media_metadata_invalid`,
 * matching the GPS scanner's existing strict-parser conventions.
 */
export function imageDimensions(
  bytes: Uint8Array,
  mediaType: SupportedMediaType,
): ImageDimensions {
  if (mediaType === "image/png") return pngDimensions(bytes);
  if (mediaType === "image/jpeg") return jpegDimensions(bytes);
  return webpDimensions(bytes);
}

function pngDimensions(bytes: Uint8Array): ImageDimensions {
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== "IHDR") {
    throw invalidMetadata("PNG is missing its leading IHDR chunk");
  }
  return {
    width: readUint32(bytes, 16, false),
    height: readUint32(bytes, 20, false),
  };
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions {
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      throw invalidMetadata("Malformed JPEG marker stream");
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined) {
      throw invalidMetadata("Truncated JPEG marker stream");
    }
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length)
      throw invalidMetadata("Truncated JPEG segment");
    const segmentLength = readUint16(bytes, offset, false);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      throw invalidMetadata("Invalid JPEG segment length");
    }
    const dataOffset = offset + 2;
    const dataLength = segmentLength - 2;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (dataLength < 5) throw invalidMetadata("Truncated JPEG SOF segment");
      return {
        height: readUint16(bytes, dataOffset + 1, false),
        width: readUint16(bytes, dataOffset + 3, false),
      };
    }
    offset += segmentLength;
  }
  throw invalidMetadata("JPEG is missing a SOF0/SOF1/SOF2 segment");
}

function webpDimensions(bytes: Uint8Array): ImageDimensions {
  const declaredSize = readUint32(bytes, 4, true) + 8;
  if (declaredSize < 20 || declaredSize > bytes.length) {
    throw invalidMetadata("Invalid WebP container length");
  }
  const fourCc = ascii(bytes, 12, 4);
  const dataOffset = 20;
  if (fourCc === "VP8X") {
    if (bytes.length < dataOffset + 10) {
      throw invalidMetadata("Truncated WebP VP8X chunk");
    }
    return {
      width: readUint24(bytes, dataOffset + 4, true) + 1,
      height: readUint24(bytes, dataOffset + 7, true) + 1,
    };
  }
  if (fourCc === "VP8L") {
    if (
      bytes.length < dataOffset + 5 ||
      bytes[dataOffset] !== 0x2f // VP8L signature byte
    ) {
      throw invalidMetadata("Invalid WebP VP8L bitstream header");
    }
    const bits = readUint32(bytes, dataOffset + 1, true);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  if (fourCc === "VP8 ") {
    if (
      bytes.length < dataOffset + 10 ||
      bytes[dataOffset + 3] !== 0x9d || // VP8 keyframe start code
      bytes[dataOffset + 4] !== 0x01 ||
      bytes[dataOffset + 5] !== 0x2a
    ) {
      throw invalidMetadata("Invalid WebP VP8 bitstream header");
    }
    return {
      width: readUint16(bytes, dataOffset + 6, true) & 0x3fff,
      height: readUint16(bytes, dataOffset + 8, true) & 0x3fff,
    };
  }
  throw invalidMetadata("WebP is missing a leading VP8/VP8L/VP8X chunk");
}

function sniffMediaType(bytes: Uint8Array): SupportedMediaType | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function containsGpsMetadata(
  bytes: Uint8Array,
  mediaType: SupportedMediaType,
): boolean {
  // XMP can carry the same coordinates outside the TIFF GPS IFD.
  const metadataText = Buffer.from(bytes).toString("latin1").toLowerCase();
  if (
    metadataText.includes("gpslatitude") ||
    metadataText.includes("gpslongitude") ||
    metadataText.includes("gpsposition") ||
    metadataText.includes("exif:gps")
  ) {
    return true;
  }
  if (mediaType === "image/jpeg") return jpegContainsGps(bytes);
  if (mediaType === "image/png") return pngContainsGps(bytes);
  return webpContainsGps(bytes);
}

function jpegContainsGps(bytes: Uint8Array): boolean {
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      throw invalidMetadata("Malformed JPEG marker stream");
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined) {
      throw invalidMetadata("Truncated JPEG marker stream");
    }
    if (marker === 0xd9 || marker === 0xda) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length)
      throw invalidMetadata("Truncated JPEG segment");
    const segmentLength = readUint16(bytes, offset, false);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      throw invalidMetadata("Invalid JPEG segment length");
    }
    const dataOffset = offset + 2;
    const dataLength = segmentLength - 2;
    if (
      marker === 0xe1 &&
      dataLength >= 6 &&
      ascii(bytes, dataOffset, 6) === "Exif\0\0" &&
      tiffContainsGps(bytes.subarray(dataOffset + 6, dataOffset + dataLength))
    ) {
      return true;
    }
    offset += segmentLength;
  }
  throw invalidMetadata("JPEG is missing an end-of-image or scan marker");
}

function pngContainsGps(bytes: Uint8Array): boolean {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset, false);
    const type = ascii(bytes, offset + 4, 4);
    const dataOffset = offset + 8;
    const next = dataOffset + length + 4;
    if (next > bytes.length) throw invalidMetadata("Invalid PNG chunk length");
    if (
      type === "eXIf" &&
      tiffContainsGps(bytes.subarray(dataOffset, dataOffset + length))
    ) {
      return true;
    }
    if (type === "IEND") return false;
    offset = next;
  }
  throw invalidMetadata("PNG is missing a complete IEND chunk");
}

function webpContainsGps(bytes: Uint8Array): boolean {
  const declaredSize = readUint32(bytes, 4, true) + 8;
  if (declaredSize < 12 || declaredSize !== bytes.length) {
    throw invalidMetadata("Invalid WebP container length");
  }
  let offset = 12;
  while (offset + 8 <= declaredSize) {
    const type = ascii(bytes, offset, 4);
    const length = readUint32(bytes, offset + 4, true);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + length;
    if (dataEnd > declaredSize)
      throw invalidMetadata("Invalid WebP chunk length");
    if (type === "EXIF") {
      const data = bytes.subarray(dataOffset, dataEnd);
      const tiff = ascii(data, 0, 6) === "Exif\0\0" ? data.subarray(6) : data;
      if (tiffContainsGps(tiff)) return true;
    }
    offset = dataEnd + (length % 2);
  }
  if (offset !== declaredSize) {
    throw invalidMetadata("Invalid WebP chunk alignment");
  }
  return false;
}

function tiffContainsGps(bytes: Uint8Array): boolean {
  if (bytes.length < 8) throw invalidMetadata("Truncated EXIF TIFF header");
  const byteOrder = ascii(bytes, 0, 2);
  const littleEndian = byteOrder === "II";
  if (!littleEndian && byteOrder !== "MM") {
    throw invalidMetadata("Invalid EXIF byte order");
  }
  if (readUint16(bytes, 2, littleEndian) !== 42) {
    throw invalidMetadata("Invalid EXIF TIFF marker");
  }
  const queue = [readUint32(bytes, 4, littleEndian)];
  const visited = new Set<number>();
  while (queue.length > 0) {
    const ifdOffset = queue.shift()!;
    if (ifdOffset === 0 || visited.has(ifdOffset)) continue;
    visited.add(ifdOffset);
    if (visited.size > 32 || ifdOffset + 2 > bytes.length) {
      throw invalidMetadata("Invalid EXIF directory offset");
    }
    const entryCount = readUint16(bytes, ifdOffset, littleEndian);
    const entriesEnd = ifdOffset + 2 + entryCount * 12;
    if (entriesEnd + 4 > bytes.length) {
      throw invalidMetadata("Truncated EXIF directory");
    }
    for (let index = 0; index < entryCount; index += 1) {
      const entryOffset = ifdOffset + 2 + index * 12;
      const tag = readUint16(bytes, entryOffset, littleEndian);
      if (tag === 0x8825) return true;
      // Follow EXIF and interoperability subdirectories so malformed nesting
      // cannot hide a GPS directory from the verifier.
      if (tag === 0x8769 || tag === 0xa005) {
        queue.push(readUint32(bytes, entryOffset + 8, littleEndian));
      }
    }
    queue.push(readUint32(bytes, entriesEnd, littleEndian));
  }
  return false;
}

function readUint16(
  bytes: Uint8Array,
  offset: number,
  littleEndian: boolean,
): number {
  if (offset < 0 || offset + 2 > bytes.length) {
    throw invalidMetadata("Metadata read exceeded file bounds");
  }
  return littleEndian
    ? bytes[offset]! | (bytes[offset + 1]! << 8)
    : (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readUint32(
  bytes: Uint8Array,
  offset: number,
  littleEndian: boolean,
): number {
  if (offset < 0 || offset + 4 > bytes.length) {
    throw invalidMetadata("Metadata read exceeded file bounds");
  }
  const value = littleEndian
    ? bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)
    : (bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!;
  return value >>> 0;
}

function readUint24(
  bytes: Uint8Array,
  offset: number,
  littleEndian: boolean,
): number {
  if (offset < 0 || offset + 3 > bytes.length) {
    throw invalidMetadata("Metadata read exceeded file bounds");
  }
  return littleEndian
    ? bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
    : (bytes[offset]! << 16) | (bytes[offset + 1]! << 8) | bytes[offset + 2]!;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.length) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function invalidMetadata(message: string): MediaVerificationError {
  return new MediaVerificationError("media_metadata_invalid", message);
}
