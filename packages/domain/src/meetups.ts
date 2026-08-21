import { z } from "zod";
import {
  ExchangeOptionSchema,
  MoneySchema,
  TimestampSchema,
  type AvailabilityWindowSchema,
} from "./schemas.js";

type AvailabilityWindow = z.infer<typeof AvailabilityWindowSchema>;

export const BuyerActionDraftSchema = z
  .object({
    action: z.enum(["accept", "counter", "decline", "schedule"]),
    response: z.string().trim().min(1).max(2_000),
    proposedPrice: MoneySchema.nullable(),
    proposedMeetup: z
      .object({
        scheduledAt: TimestampSchema,
        locationType: ExchangeOptionSchema.exclude(["decide_per_item"]),
        publicLocation: z.string().trim().min(1).max(500),
      })
      .strict()
      .nullable(),
    requiresApproval: z.literal(true),
  })
  .strict();
export type BuyerActionDraft = z.infer<typeof BuyerActionDraftSchema>;

export function generateBuyerActionDraft(input: {
  action: BuyerActionDraft["action"];
  askingPriceCents: number;
  minimumPriceCents: number;
  offeredPriceCents: number | null;
  counterPriceCents?: number;
  currency: string;
  acceptsTrades: boolean;
  allowsDelivery: boolean;
  availability: readonly AvailabilityWindow[];
  timezone: string;
  publicLocation: string | null;
  now: Date;
}): BuyerActionDraft {
  if (input.action === "accept") {
    const accepted = input.offeredPriceCents ?? input.askingPriceCents;
    if (accepted < input.minimumPriceCents) {
      throw new Error("An offer below the item price floor cannot be accepted");
    }
    return BuyerActionDraftSchema.parse({
      action: "accept",
      response: `Thanks—${formatMoney(accepted, input.currency)} works for me. Let’s confirm a local exchange time.`,
      proposedPrice: { amountCents: accepted, currency: input.currency },
      proposedMeetup: null,
      requiresApproval: true,
    });
  }
  if (input.action === "counter") {
    const amount = input.counterPriceCents ?? input.minimumPriceCents;
    if (amount < input.minimumPriceCents) {
      throw new Error("A counteroffer cannot be below the item price floor");
    }
    return BuyerActionDraftSchema.parse({
      action: "counter",
      response: `Thanks for the offer. I can do ${formatMoney(amount, input.currency)} for a local exchange.`,
      proposedPrice: { amountCents: amount, currency: input.currency },
      proposedMeetup: null,
      requiresApproval: true,
    });
  }
  if (input.action === "decline") {
    return BuyerActionDraftSchema.parse({
      action: "decline",
      response:
        "Thanks for checking. I’m going to pass on that offer, but I appreciate your interest.",
      proposedPrice: null,
      proposedMeetup: null,
      requiresApproval: true,
    });
  }

  if (!input.publicLocation) {
    throw new Error("Save a public meetup location before scheduling");
  }
  const slot = nextAvailabilitySlots({
    availability: input.availability,
    timezone: input.timezone,
    from: input.now,
    count: 1,
  })[0];
  if (!slot) throw new Error("Save an availability window before scheduling");
  return BuyerActionDraftSchema.parse({
    action: "schedule",
    response: `I can meet at ${input.publicLocation} on ${formatLocalSlot(slot, input.timezone)}. Does that work for you?`,
    proposedPrice: null,
    proposedMeetup: {
      scheduledAt: slot.toISOString(),
      locationType: "public_meetup",
      publicLocation: input.publicLocation,
    },
    requiresApproval: true,
  });
}

export function nextAvailabilitySlots(input: {
  availability: readonly AvailabilityWindow[];
  timezone: string;
  from: Date;
  count?: number;
}): Date[] {
  const wanted = Math.max(1, Math.min(input.count ?? 3, 10));
  const windows = input.availability.map((value) => ({ ...value }));
  if (windows.length === 0) return [];
  // Searching UTC instants and comparing their local wall-clock representation
  // avoids guessing the household's daylight-saving offset.
  const cursor = new Date(input.from.getTime() + 15 * 60_000);
  cursor.setUTCMinutes(Math.ceil(cursor.getUTCMinutes() / 15) * 15, 0, 0);
  const results: Date[] = [];
  const maximum = cursor.getTime() + 21 * 24 * 60 * 60_000;
  for (
    let instant = cursor.getTime();
    instant <= maximum && results.length < wanted;
    instant += 15 * 60_000
  ) {
    const candidate = new Date(instant);
    const local = localParts(candidate, input.timezone);
    const matching = windows.find(
      (window) =>
        window.dayOfWeek === local.dayOfWeek &&
        local.minutes >= window.startMinutes &&
        local.minutes < window.endMinutes,
    );
    if (!matching) continue;
    const prior = results.at(-1);
    if (prior && instant - prior.getTime() < 60 * 60_000) continue;
    results.push(candidate);
  }
  return results;
}

function localParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const dayOfWeek = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    get("weekday"),
  );
  return {
    dayOfWeek,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function formatMoney(amountCents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(amountCents / 100);
}

function formatLocalSlot(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
