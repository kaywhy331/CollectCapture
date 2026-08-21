import { describe, expect, it } from "vitest";
import {
  generateBuyerActionDraft,
  nextAvailabilitySlots,
  recommendClearingLane,
} from "../src/index.js";

describe("clearing advice", () => {
  it("creates giveaway-specific copy when sale effort exceeds value", () => {
    const advice = recommendClearingLane({
      title: "Box of drinking glasses",
      category: "Kitchen",
      condition: "good",
      expectedSaleValueCents: 800,
      estimatedEffortMinutes: 45,
    });
    expect(advice.recommendation).toBe("give_away");
    expect(advice.giveawayTitle).toBe("FREE: Box of drinking glasses");
  });

  it("routes unsafe electronics to responsible recycling", () => {
    const advice = recommendClearingLane({
      title: "Damaged laptop",
      category: "Electronics",
      condition: "poor",
      expectedSaleValueCents: 5_000,
      estimatedEffortMinutes: 10,
      restrictedOrUnsafe: true,
    });
    expect(advice.recommendation).toBe("recycle");
    expect(advice.destinationCategory).toBe("electronics recycling");
  });
});

describe("buyer actions and meetup availability", () => {
  const base = {
    askingPriceCents: 5_000,
    minimumPriceCents: 3_500,
    offeredPriceCents: 2_000,
    currency: "USD",
    acceptsTrades: false,
    allowsDelivery: false,
    availability: [{ dayOfWeek: 6, startMinutes: 600, endMinutes: 720 }],
    timezone: "America/Los_Angeles",
    publicLocation: "the library entrance",
    now: new Date("2026-08-21T12:00:00.000Z"),
  } as const;

  it("never accepts an offer below the price floor", () => {
    expect(() =>
      generateBuyerActionDraft({ ...base, action: "accept" }),
    ).toThrow("price floor");
    const counter = generateBuyerActionDraft({ ...base, action: "counter" });
    expect(counter.response).toContain("$35.00");
    expect(counter.requiresApproval).toBe(true);
  });

  it("generates a public-location schedule proposal from saved availability", () => {
    const draft = generateBuyerActionDraft({ ...base, action: "schedule" });
    expect(draft.proposedMeetup?.publicLocation).toBe("the library entrance");
    expect(draft.response).not.toMatch(/\d+ Main/);
    expect(
      nextAvailabilitySlots({
        availability: base.availability,
        timezone: base.timezone,
        from: base.now,
        count: 2,
      }),
    ).toHaveLength(2);
  });
});
