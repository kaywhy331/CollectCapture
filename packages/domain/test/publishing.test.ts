import { describe, expect, it } from "vitest";
import {
  InvalidPublishingTransitionError,
  PUBLISHING_FLOW,
  publishingIdempotencyKey,
  retryDelayMs,
  transitionPublishingJob,
  type PublishingJob,
} from "../src/index.js";

const now = "2026-08-20T12:00:00.000Z";

function job(overrides: Partial<PublishingJob> = {}): PublishingJob {
  return {
    id: "job-1",
    householdId: "household-1",
    itemId: "item-1",
    platform: "test-market",
    listingVersion: 1,
    commandAction: "publish",
    idempotencyKey: "household-1:item-1:test-market:1:publish",
    currentState: "DRAFT",
    lastVerifiedState: "DRAFT",
    resumeState: null,
    retryCount: 0,
    maxRetries: 3,
    nextRetryAt: null,
    deviceId: "device-1",
    connectorVersion: "1.0.0",
    platformAppVersion: "10.4.0",
    errorCode: null,
    errorDetail: null,
    commandExpiresAt: "2026-08-20T13:00:00.000Z",
    createdAt: now,
    startedAt: null,
    completedAt: null,
    updatedAt: now,
    ...overrides,
  };
}

describe("publishing state machine", () => {
  it("advances through every required state and records visible transitions", () => {
    let current = job();
    const transitions = [];

    for (let index = 1; index < PUBLISHING_FLOW.length; index += 1) {
      const result = transitionPublishingJob(current, { type: "advance" }, now);
      current = result.job;
      transitions.push(result.transition);
    }

    expect(current.currentState).toBe("PUBLISHED");
    expect(current.completedAt).toBe(now);
    expect(transitions).toHaveLength(PUBLISHING_FLOW.length - 1);
    expect(transitions.at(-1)).toMatchObject({
      from: "SYNC_RESULT",
      to: "PUBLISHED",
      event: "advance",
    });
  });

  it("pauses for a CAPTCHA and resumes at the interrupted state", () => {
    const active = job({
      currentState: "FILL_FIELDS",
      lastVerifiedState: "UPLOAD_MEDIA",
    });
    const paused = transitionPublishingJob(active, {
      type: "pause",
      state: "NEEDS_CAPTCHA",
      reasonCode: "CAPTCHA_VISIBLE",
    });

    expect(paused.job.currentState).toBe("NEEDS_CAPTCHA");
    expect(paused.job.resumeState).toBe("FILL_FIELDS");

    const resumed = transitionPublishingJob(
      paused.job,
      { type: "resume" },
      now,
    );
    expect(resumed.job.currentState).toBe("FILL_FIELDS");
    expect(resumed.job.resumeState).toBeNull();
  });

  it("uses bounded exponential backoff and resumes a retryable step", () => {
    const active = job({
      currentState: "UPLOAD_MEDIA",
      lastVerifiedState: "PRECHECK",
    });
    const failed = transitionPublishingJob(
      active,
      { type: "retryable_failure", reasonCode: "NETWORK_TIMEOUT" },
      now,
    );

    expect(failed.job).toMatchObject({
      currentState: "FAILED_RETRYABLE",
      retryCount: 1,
      resumeState: "UPLOAD_MEDIA",
      nextRetryAt: "2026-08-20T12:00:02.000Z",
    });
    expect(() =>
      transitionPublishingJob(failed.job, { type: "retry" }, now),
    ).toThrow("Retry backoff has not elapsed");
    const retried = transitionPublishingJob(
      failed.job,
      { type: "retry" },
      "2026-08-20T12:00:02.000Z",
    );
    expect(retried.job.currentState).toBe("UPLOAD_MEDIA");
    expect(retryDelayMs(20)).toBe(300_000);
  });

  it("ends visibly when the retry budget is exhausted", () => {
    const failed = transitionPublishingJob(
      job({ currentState: "SUBMIT", retryCount: 3, maxRetries: 3 }),
      { type: "retryable_failure", reasonCode: "PLATFORM_TIMEOUT" },
      now,
    );
    expect(failed.job.currentState).toBe("FAILED_FINAL");
    expect(failed.job.completedAt).toBe(now);
  });

  it("rejects transitions out of terminal states", () => {
    expect(() =>
      transitionPublishingJob(job({ currentState: "PUBLISHED" }), {
        type: "advance",
      }),
    ).toThrow(InvalidPublishingTransitionError);
  });
});

describe("publishing idempotency", () => {
  it("normalizes platform names and scopes each listing version", () => {
    const first = publishingIdempotencyKey({
      householdId: "h1",
      itemId: "i1",
      platform: " Test-Market ",
      listingVersion: 1,
    });
    const second = publishingIdempotencyKey({
      householdId: "h1",
      itemId: "i1",
      platform: "test-market",
      listingVersion: 2,
    });
    expect(first).toBe("h1:i1:test-market:1:publish");
    expect(second).not.toBe(first);
  });
});
