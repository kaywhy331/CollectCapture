import { randomUUID } from "node:crypto";
import type { LocalClearApplication } from "./application.js";
import type { Repository } from "./repository.js";
import type { ServerConnectorExecutor } from "./server-connectors.js";

export class PublishingDispatcher {
  readonly #repository: Repository;
  readonly #application: LocalClearApplication;
  readonly #executor: ServerConnectorExecutor;
  readonly #workerId: string;
  readonly #now: () => Date;

  constructor(options: {
    repository: Repository;
    application: LocalClearApplication;
    executor: ServerConnectorExecutor;
    workerId?: string;
    now?: () => Date;
  }) {
    this.#repository = options.repository;
    this.#application = options.application;
    this.#executor = options.executor;
    this.#workerId = options.workerId ?? `dispatcher-${randomUUID()}`;
    this.#now = options.now ?? (() => new Date());
  }

  async runOnce(limit = 10): Promise<{ claimed: number; processed: number }> {
    const now = this.#now();
    const jobs = await this.#repository.claimRunnableServerJobs({
      workerId: this.#workerId,
      now: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
      limit,
    });
    let processed = 0;
    for (const job of jobs) {
      try {
        await this.#application.processServerPublishingJob(job, this.#executor);
        processed += 1;
      } finally {
        await this.#repository.releasePublishingJobLease(
          job.id,
          this.#workerId,
        );
      }
    }
    return { claimed: jobs.length, processed };
  }
}
