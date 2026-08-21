import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { MediaReadUrlProvider } from "./intelligence.js";
import {
  MediaVerificationError,
  verifyMediaBytes,
  type MediaVerificationProvider,
  type MediaVerificationRequest,
  type VerifiedMedia,
} from "./media-verification.js";

export class SupabaseMediaReadUrlProvider
  implements MediaReadUrlProvider, MediaVerificationProvider
{
  readonly #client: SupabaseClient;
  readonly #bucket: string;
  readonly #maxVerificationBytes: number;

  constructor(options: {
    url?: string;
    serviceRoleKey?: string;
    bucket?: string;
    client?: SupabaseClient;
    maxVerificationBytes?: number;
  }) {
    if (options.client) {
      this.#client = options.client;
    } else {
      if (!options.url || !options.serviceRoleKey) {
        throw new Error("Supabase URL and service role key are required");
      }
      this.#client = createClient(options.url, options.serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
    }
    this.#bucket = options.bucket ?? "item-media";
    this.#maxVerificationBytes =
      options.maxVerificationBytes ?? 20 * 1024 * 1024;
  }

  async createReadUrl(
    storagePath: string,
    expiresInSeconds: number,
  ): Promise<string> {
    const { data, error } = await this.#client.storage
      .from(this.#bucket)
      .createSignedUrl(storagePath, expiresInSeconds);
    if (error || !data.signedUrl) {
      throw new Error("Could not create a short-lived media URL", {
        cause: error,
      });
    }
    return data.signedUrl;
  }

  async verify(request: MediaVerificationRequest): Promise<VerifiedMedia> {
    const { data, error } = await this.#client.storage
      .from(this.#bucket)
      .download(request.storagePath);
    if (error || !data) {
      throw new MediaVerificationError(
        "media_unavailable",
        "Could not download uploaded media for verification",
        { cause: error },
      );
    }
    try {
      const bytes = new Uint8Array(await data.arrayBuffer());
      return verifyMediaBytes(
        bytes,
        {
          expectedSha256: request.expectedSha256,
          declaredMediaType: request.declaredMediaType,
        },
        this.#maxVerificationBytes,
      );
    } catch (verificationError) {
      if (verificationError instanceof MediaVerificationError) {
        throw verificationError;
      }
      throw new MediaVerificationError(
        "media_unavailable",
        "Could not read uploaded media for verification",
        { cause: verificationError },
      );
    }
  }
}
