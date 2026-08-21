import * as Crypto from "expo-crypto";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { supabase } from "./supabase";

export interface LocalPhoto {
  uri: string;
  width: number;
  height: number;
  source: "camera" | "library";
}

export interface UploadedPhoto {
  storagePath: string;
  contentSha256: string;
  mediaType: "image/jpeg";
  source: LocalPhoto["source"];
  qualityIssues: Array<"incomplete_framing">;
  redactionState: "not_needed";
  exifLocationStripped: true;
}

export async function sanitizeAndUploadPhotos(
  householdId: string,
  photos: readonly LocalPhoto[],
): Promise<UploadedPhoto[]> {
  if (photos.length < 1 || photos.length > 12) {
    throw new Error("Choose between 1 and 12 photos for this item.");
  }
  const itemUploadId = Crypto.randomUUID();
  const uploaded: string[] = [];
  try {
    const results: UploadedPhoto[] = [];
    for (const [index, photo] of photos.entries()) {
      const actions = photo.width > 2_048 ? [{ resize: { width: 2_048 } }] : [];
      const sanitized = await manipulateAsync(photo.uri, actions, {
        compress: 0.9,
        format: SaveFormat.JPEG,
      });
      const bytes = await fetch(sanitized.uri).then(async (response) =>
        response.arrayBuffer(),
      );
      const digest = await Crypto.digest(
        Crypto.CryptoDigestAlgorithm.SHA256,
        bytes,
      );
      const contentSha256 = [...new Uint8Array(digest)]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
      const storagePath = `${householdId}/${itemUploadId}/${index}-${Crypto.randomUUID()}.jpg`;
      const { error } = await supabase.storage
        .from("item-media")
        .upload(storagePath, bytes, {
          contentType: "image/jpeg",
          upsert: false,
          cacheControl: "3600",
        });
      if (error) throw error;
      uploaded.push(storagePath);
      results.push({
        storagePath,
        contentSha256,
        mediaType: "image/jpeg",
        source: photo.source,
        qualityIssues:
          sanitized.width < 720 || sanitized.height < 720
            ? ["incomplete_framing"]
            : [],
        redactionState: "not_needed",
        exifLocationStripped: true,
      });
    }
    return results;
  } catch (error) {
    if (uploaded.length > 0)
      await supabase.storage.from("item-media").remove(uploaded);
    throw error;
  }
}

export async function removeUploadedPhotos(
  paths: readonly string[],
): Promise<void> {
  if (paths.length === 0) return;
  await supabase.storage.from("item-media").remove([...paths]);
}

export async function createMediaReadUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from("item-media")
    .createSignedUrl(storagePath, 10 * 60);
  if (error || !data.signedUrl) {
    throw new Error("Could not load the item photo");
  }
  return data.signedUrl;
}
