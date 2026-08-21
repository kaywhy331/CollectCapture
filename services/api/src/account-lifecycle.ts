import { createClient } from "@supabase/supabase-js";

export interface AccountIdentityProvider {
  deleteUser(userId: string): Promise<void>;
}

export interface MediaLifecycleProvider {
  deleteObjects(storagePaths: readonly string[]): Promise<void>;
}

export class AccountLifecycleUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountLifecycleUnavailableError";
  }
}

export class UnavailableAccountIdentityProvider implements AccountIdentityProvider {
  async deleteUser(): Promise<void> {
    throw new AccountLifecycleUnavailableError(
      "Account identity deletion is not configured",
    );
  }
}

export class UnavailableMediaLifecycleProvider implements MediaLifecycleProvider {
  async deleteObjects(): Promise<void> {
    throw new AccountLifecycleUnavailableError(
      "Private media deletion is not configured",
    );
  }
}

export class SupabaseAccountLifecycleProvider
  implements AccountIdentityProvider, MediaLifecycleProvider
{
  readonly #client;
  readonly #bucket: string;

  constructor(options: {
    url: string;
    serviceRoleKey: string;
    bucket: string;
  }) {
    this.#client = createClient(options.url, options.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    this.#bucket = options.bucket;
  }

  async deleteUser(userId: string): Promise<void> {
    const { error } = await this.#client.auth.admin.deleteUser(userId, false);
    if (error)
      throw new Error(`Supabase identity deletion failed: ${error.message}`);
  }

  async deleteObjects(storagePaths: readonly string[]): Promise<void> {
    for (let index = 0; index < storagePaths.length; index += 100) {
      const batch = storagePaths.slice(index, index + 100);
      if (batch.length === 0) continue;
      const { error } = await this.#client.storage
        .from(this.#bucket)
        .remove(batch);
      if (error)
        throw new Error(`Private media deletion failed: ${error.message}`);
    }
  }
}
