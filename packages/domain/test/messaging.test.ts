import { describe, expect, it } from "vitest";
import { createBuyerTaskDraft, redactBuyerMessage } from "../src/index.js";

const context = {
  id: "task-1",
  platformListingId: "listing-1",
  participantAlias: "Buyer A",
  askingPriceCents: 5_000,
  minimumPriceCents: 3_500,
  currency: "USD",
  publicMeetupDescription: "the library entrance",
  createdAt: "2026-08-20T12:00:00.000Z",
};

describe("buyer message assistance", () => {
  it("redacts common contact and exact-address data before persistence", () => {
    const redacted = redactBuyerMessage(
      "Email me at buyer@example.com or 415-555-1212 at 123 Main Street",
    );
    expect(redacted).not.toContain("buyer@example.com");
    expect(redacted).not.toContain("415-555-1212");
    expect(redacted).not.toContain("123 Main Street");
    expect(redacted).toContain("[address redacted]");
  });

  it("drafts a bounded counteroffer but never sends it automatically", () => {
    const task = createBuyerTaskDraft({
      ...context,
      rawMessage: "Would you take $20?",
    });
    expect(task).toMatchObject({
      intent: "price_offer",
      approvalState: "pending",
      priceOffer: { amountCents: 2_000, currency: "USD" },
    });
    expect(task.suggestedResponse).toContain("$35.00");
  });

  it("flags scam patterns and refuses verification-code or overpayment flows", () => {
    const task = createBuyerTaskDraft({
      ...context,
      rawMessage:
        "I will overpay and my courier will collect it. Send me the verification code.",
    });
    expect(task.intent).toBe("suspected_scam");
    expect(task.scamSignals.length).toBeGreaterThanOrEqual(3);
    expect(task.suggestedResponse).toContain("won’t share verification codes");
  });

  it("uses only the saved public meetup description in pickup drafts", () => {
    const task = createBuyerTaskDraft({
      ...context,
      rawMessage: "What is your address for pickup?",
    });
    expect(task.requiresAddressApproval).toBe(true);
    expect(task.suggestedResponse).toContain("the library entrance");
    expect(task.suggestedResponse).not.toMatch(/\d+\s+Main/);
  });
});
