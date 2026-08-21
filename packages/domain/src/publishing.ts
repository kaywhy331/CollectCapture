import type {
  PublishingCommandAction,
  PublishingJob,
  PublishingJobState,
} from "./schemas.js";

export const PUBLISHING_FLOW = [
  "DRAFT",
  "READY",
  "QUEUED",
  "DEVICE_WAKE",
  "OPEN_PLATFORM",
  "VERIFY_SESSION",
  "PRECHECK",
  "UPLOAD_MEDIA",
  "FILL_FIELDS",
  "VALIDATE",
  "SUBMIT",
  "VERIFY_PUBLISHED",
  "SYNC_RESULT",
  "PUBLISHED",
] as const satisfies readonly PublishingJobState[];

export const PAUSED_PUBLISHING_STATES = [
  "NEEDS_LOGIN",
  "NEEDS_MFA",
  "NEEDS_CAPTCHA",
  "NEEDS_USER_CONFIRMATION",
  "NEEDS_REQUIRED_FIELD",
  "APP_VERSION_UNSUPPORTED",
  "PLATFORM_UI_CHANGED",
  "ITEM_BLOCKED",
  "LISTING_LIMIT_REACHED",
  "NETWORK_UNAVAILABLE",
  "DEVICE_OFFLINE",
] as const satisfies readonly PublishingJobState[];

export const TERMINAL_PUBLISHING_STATES = [
  "PUBLISHED",
  "FAILED_FINAL",
  "CANCELLED",
] as const satisfies readonly PublishingJobState[];

export type PausedPublishingState = (typeof PAUSED_PUBLISHING_STATES)[number];

export type PublishingEvent =
  | { type: "advance" }
  | {
      type: "pause";
      state: PausedPublishingState;
      reasonCode: string;
      detail?: string;
    }
  | { type: "retryable_failure"; reasonCode: string; detail?: string }
  | { type: "fatal_failure"; reasonCode: string; detail?: string }
  | { type: "resume" }
  | { type: "retry" }
  | { type: "cancel"; reasonCode?: string };

export interface PublishingTransition {
  from: PublishingJobState;
  to: PublishingJobState;
  event: PublishingEvent["type"];
  occurredAt: string;
  reasonCode: string | null;
}

export interface PublishingTransitionResult {
  job: PublishingJob;
  transition: PublishingTransition;
}

export class InvalidPublishingTransitionError extends Error {
  constructor(
    readonly state: PublishingJobState,
    readonly event: PublishingEvent["type"],
    message: string,
  ) {
    super(message);
    this.name = "InvalidPublishingTransitionError";
  }
}

const flowIndex = new Map<PublishingJobState, number>(
  PUBLISHING_FLOW.map((state, index) => [state, index]),
);
const pausedStates = new Set<PublishingJobState>(PAUSED_PUBLISHING_STATES);
const terminalStates = new Set<PublishingJobState>(TERMINAL_PUBLISHING_STATES);

export function isPublishingFlowState(
  state: PublishingJobState,
): state is (typeof PUBLISHING_FLOW)[number] {
  return flowIndex.has(state);
}

export function isPausedPublishingState(
  state: PublishingJobState,
): state is PausedPublishingState {
  return pausedStates.has(state);
}

export function isTerminalPublishingState(state: PublishingJobState): boolean {
  return terminalStates.has(state);
}

export function publishingIdempotencyKey(input: {
  householdId: string;
  itemId: string;
  platform: string;
  listingVersion: number;
  commandAction?: PublishingCommandAction;
}): string {
  const platform = input.platform.trim().toLowerCase();
  if (!platform) {
    throw new Error("Platform is required for an idempotency key");
  }
  if (!Number.isSafeInteger(input.listingVersion) || input.listingVersion < 1) {
    throw new Error("Listing version must be a positive integer");
  }
  return [
    input.householdId,
    input.itemId,
    platform,
    input.listingVersion,
    input.commandAction ?? "publish",
  ].join(":");
}

export function retryDelayMs(
  retryCount: number,
  options: { baseMs?: number; maximumMs?: number } = {},
): number {
  if (!Number.isSafeInteger(retryCount) || retryCount < 1) {
    throw new Error("Retry count must be a positive integer");
  }
  const baseMs = options.baseMs ?? 2_000;
  const maximumMs = options.maximumMs ?? 5 * 60_000;
  return Math.min(maximumMs, baseMs * 2 ** (retryCount - 1));
}

function nextFlowState(state: PublishingJobState): PublishingJobState {
  const index = flowIndex.get(state);
  if (index === undefined || index === PUBLISHING_FLOW.length - 1) {
    throw new InvalidPublishingTransitionError(
      state,
      "advance",
      `Cannot advance from ${state}`,
    );
  }
  return PUBLISHING_FLOW[index + 1] as PublishingJobState;
}

function transitionRecord(
  from: PublishingJobState,
  to: PublishingJobState,
  event: PublishingEvent,
  now: string,
  reasonCode: string | null,
): PublishingTransition {
  return { from, to, event: event.type, occurredAt: now, reasonCode };
}

function requireResumableSource(
  job: PublishingJob,
  event: PublishingEvent["type"],
): PublishingJobState {
  if (!job.resumeState || !isPublishingFlowState(job.resumeState)) {
    throw new InvalidPublishingTransitionError(
      job.currentState,
      event,
      `Job ${job.id} has no verified resumable state`,
    );
  }
  return job.resumeState;
}

export function transitionPublishingJob(
  job: PublishingJob,
  event: PublishingEvent,
  now = new Date().toISOString(),
): PublishingTransitionResult {
  const from = job.currentState;

  if (isTerminalPublishingState(from)) {
    throw new InvalidPublishingTransitionError(
      from,
      event.type,
      `Job is already terminal: ${from}`,
    );
  }

  if (event.type === "cancel") {
    const to = "CANCELLED" as const;
    return {
      job: {
        ...job,
        currentState: to,
        completedAt: now,
        updatedAt: now,
        nextRetryAt: null,
        errorCode: event.reasonCode ?? "USER_CANCELLED",
      },
      transition: transitionRecord(
        from,
        to,
        event,
        now,
        event.reasonCode ?? "USER_CANCELLED",
      ),
    };
  }

  if (event.type === "advance") {
    if (!isPublishingFlowState(from)) {
      throw new InvalidPublishingTransitionError(
        from,
        event.type,
        `Cannot advance a paused job`,
      );
    }
    const to = nextFlowState(from);
    return {
      job: {
        ...job,
        currentState: to,
        lastVerifiedState: from,
        resumeState: null,
        startedAt: job.startedAt ?? (to === "DEVICE_WAKE" ? now : null),
        completedAt: to === "PUBLISHED" ? now : null,
        nextRetryAt: null,
        errorCode: null,
        errorDetail: null,
        updatedAt: now,
      },
      transition: transitionRecord(from, to, event, now, null),
    };
  }

  if (event.type === "pause") {
    if (
      !isPublishingFlowState(from) ||
      from === "DRAFT" ||
      from === "PUBLISHED"
    ) {
      throw new InvalidPublishingTransitionError(
        from,
        event.type,
        `Cannot pause from ${from}`,
      );
    }
    return {
      job: {
        ...job,
        currentState: event.state,
        resumeState: from,
        nextRetryAt: null,
        errorCode: event.reasonCode,
        errorDetail: event.detail ?? null,
        updatedAt: now,
      },
      transition: transitionRecord(
        from,
        event.state,
        event,
        now,
        event.reasonCode,
      ),
    };
  }

  if (event.type === "resume") {
    if (!isPausedPublishingState(from)) {
      throw new InvalidPublishingTransitionError(
        from,
        event.type,
        `Only a paused job can resume`,
      );
    }
    const to = requireResumableSource(job, event.type);
    return {
      job: {
        ...job,
        currentState: to,
        resumeState: null,
        nextRetryAt: null,
        errorCode: null,
        errorDetail: null,
        updatedAt: now,
      },
      transition: transitionRecord(from, to, event, now, null),
    };
  }

  if (event.type === "retryable_failure") {
    if (
      !isPublishingFlowState(from) ||
      from === "DRAFT" ||
      from === "PUBLISHED"
    ) {
      throw new InvalidPublishingTransitionError(
        from,
        event.type,
        `Cannot fail from ${from}`,
      );
    }
    const retryCount = job.retryCount + 1;
    if (retryCount > job.maxRetries) {
      const to = "FAILED_FINAL" as const;
      return {
        job: {
          ...job,
          currentState: to,
          retryCount,
          resumeState: from,
          nextRetryAt: null,
          errorCode: event.reasonCode,
          errorDetail: event.detail ?? null,
          completedAt: now,
          updatedAt: now,
        },
        transition: transitionRecord(from, to, event, now, event.reasonCode),
      };
    }

    const to = "FAILED_RETRYABLE" as const;
    const nextRetryAt = new Date(
      new Date(now).getTime() + retryDelayMs(retryCount),
    ).toISOString();
    return {
      job: {
        ...job,
        currentState: to,
        retryCount,
        resumeState: from,
        nextRetryAt,
        errorCode: event.reasonCode,
        errorDetail: event.detail ?? null,
        updatedAt: now,
      },
      transition: transitionRecord(from, to, event, now, event.reasonCode),
    };
  }

  if (event.type === "retry") {
    if (from !== "FAILED_RETRYABLE") {
      throw new InvalidPublishingTransitionError(
        from,
        event.type,
        `Only retryable jobs can retry`,
      );
    }
    if (
      job.nextRetryAt &&
      new Date(now).getTime() < new Date(job.nextRetryAt).getTime()
    ) {
      throw new InvalidPublishingTransitionError(
        from,
        event.type,
        `Retry backoff has not elapsed`,
      );
    }
    const to = requireResumableSource(job, event.type);
    return {
      job: {
        ...job,
        currentState: to,
        resumeState: null,
        nextRetryAt: null,
        errorCode: null,
        errorDetail: null,
        updatedAt: now,
      },
      transition: transitionRecord(from, to, event, now, null),
    };
  }

  if (event.type === "fatal_failure") {
    if (!isPublishingFlowState(from) && !isPausedPublishingState(from)) {
      throw new InvalidPublishingTransitionError(
        from,
        event.type,
        `Cannot fail from ${from}`,
      );
    }
    const to = "FAILED_FINAL" as const;
    return {
      job: {
        ...job,
        currentState: to,
        nextRetryAt: null,
        errorCode: event.reasonCode,
        errorDetail: event.detail ?? null,
        completedAt: now,
        updatedAt: now,
      },
      transition: transitionRecord(from, to, event, now, event.reasonCode),
    };
  }

  return assertNever(event);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled publishing event: ${JSON.stringify(value)}`);
}
