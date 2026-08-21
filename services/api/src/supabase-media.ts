import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { MediaReadUrlProvider } from "./intelligence.js";

export class SupabaseMediaReadUrlProvider implements MediaReadUrlProvider {
  readonly #client: SupabaseClient;
  readonly #bucket: string;

  constructor(options: {
    url?: string;
    serviceRoleKey?: string;
    bucket?: string;
    client?: SupabaseClient;
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
}
