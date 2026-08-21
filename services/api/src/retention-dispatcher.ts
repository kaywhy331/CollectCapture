import type { MediaLifecycleProvider } from "./account-lifecycle.js";
import type { EphemeralPurgeResult, Repository } from "./repository.js";

export class RetentionDispatcher {
  readonly #repository: Repository;
  readonly #mediaLifecycleProvider: MediaLifecycleProvider;
  readonly #now: () => Date;

  constructor(options: {
    repository: Repository;
    mediaLifecycleProvider: MediaLifecycleProvider;
    now?: () => Date;
  }) {
    this.#repository = options.repository;
    this.#mediaLifecycleProvider = options.mediaLifecycleProvider;
    this.#now = options.now ?? (() => new Date());
  }

  async runOnce(): Promise<EphemeralPurgeResult> {
    const now = this.#now().toISOString();
    const expiredDiagnostics =
      await this.#repository.listExpiredDiagnosticArtifacts(now);
    if (expiredDiagnostics.length > 0) {
      await this.#mediaLifecycleProvider.deleteObjects(
        expiredDiagnostics.map((artifact) => artifact.storagePath),
      );
    }
    return this.#repository.purgeExpiredEphemeralData(
      now,
      expiredDiagnostics.map((artifact) => artifact.id),
    );
  }
}
