import {
  BuyerTaskSchema,
  type BuyerIntent,
  type BuyerTask,
} from "./schemas.js";

export interface BuyerMessageContext {
  id: string;
  platformListingId: string;
  participantAlias: string;
  rawMessage: string;
  askingPriceCents: number;
  minimumPriceCents: number;
  currency: string;
  publicMeetupDescription: string | null;
  createdAt: string;
}

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE =
  /(?<!\d)(?:\+?1[ .-]?)?(?:\(?\d{3}\)?[ .-]?)\d{3}[ .-]?\d{4}(?!\d)/g;
const STREET_ADDRESS =
  /\b\d{1,6}\s+[A-Za-z0-9.' -]{2,60}\s(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|court|ct|way|place|pl)\b/gi;

export function redactBuyerMessage(message: string): string {
  return message
    .replace(EMAIL, "[email redacted]")
    .replace(PHONE, "[phone redacted]")
    .replace(STREET_ADDRESS, "[address redacted]")
    .trim()
    .slice(0, 1_000);
}

export function detectScamSignals(message: string): string[] {
  const normalized = message.toLowerCase();
  const patterns: Array<[RegExp, string]> = [
    [/\b(gift ?card|steam card|itunes card)\b/, "Requests gift-card payment"],
    [
      /\b(verification code|security code|send me the code)\b/,
      "Requests an account verification code",
    ],
    [
      /\b(overpay|extra money|refund the difference)\b/,
      "Mentions overpayment or refunding a difference",
    ],
    [
      /\b(courier|shipping agent|mover will pick)\b/,
      "Uses a courier or shipping-agent pattern",
    ],
    [/\b(deposit|advance payment)\b/, "Requests an advance deposit"],
    [/\b(whatsapp|telegram)\b/, "Attempts to move conversation off-platform"],
  ];
  return patterns
    .filter(([pattern]) => pattern.test(normalized))
    .map(([, label]) => label);
}

export function extractPriceOfferCents(message: string): number | null {
  const match = /(?:\$|usd\s*)(\d{1,7})(?:\.(\d{1,2}))?\b/i.exec(message);
  if (!match?.[1]) return null;
  const dollars = Number(match[1]);
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  const value = dollars * 100 + cents;
  return Number.isSafeInteger(value) ? value : null;
}

export function classifyBuyerIntent(
  message: string,
  scamSignals = detectScamSignals(message),
): BuyerIntent {
  const value = message.toLowerCase();
  if (scamSignals.length > 0) return "suspected_scam";
  if (/\b(trade|swap)\b/.test(value)) return "trade_request";
  if (/\b(deliver|delivery|drop off)\b/.test(value)) return "delivery_request";
  if (/\b(address|where.*pick|porch|pickup location)\b/.test(value)) {
    return "pickup_availability";
  }
  if (
    /\b(when|what time|available today|available tomorrow|weekend)\b/.test(
      value,
    )
  ) {
    return "availability";
  }
  if (/\b(dimension|measure|size|fit|compatible)\b/.test(value)) {
    return "dimensions_or_compatibility";
  }
  if (
    extractPriceOfferCents(message) !== null ||
    /\b(offer|lowest|take)\b/.test(value)
  ) {
    return "price_offer";
  }
  if (/\?/.test(value)) return "product_question";
  return "other";
}

export function createBuyerTaskDraft(context: BuyerMessageContext): BuyerTask {
  const scamSignals = detectScamSignals(context.rawMessage);
  const intent = classifyBuyerIntent(context.rawMessage, scamSignals);
  const offer = extractPriceOfferCents(context.rawMessage);
  const priceOffer =
    offer === null
      ? null
      : { amountCents: offer, currency: context.currency.toUpperCase() };
  const meetup =
    context.publicMeetupDescription ?? "a public meetup location we agree on";

  let suggestedResponse: string;
  if (intent === "suspected_scam") {
    suggestedResponse =
      "For safety, I’ll keep communication and arrangements here. I won’t share verification codes, pay fees, or accept overpayments.";
  } else if (intent === "price_offer" && offer !== null) {
    suggestedResponse =
      offer >= context.minimumPriceCents
        ? `Thanks for the offer. ${formatMoney(offer, context.currency)} works for me, subject to confirming a meetup time.`
        : `Thanks for the offer. The lowest I can accept is ${formatMoney(context.minimumPriceCents, context.currency)}.`;
  } else if (intent === "pickup_availability" || intent === "availability") {
    suggestedResponse = `It’s still available. I can meet at ${meetup}; what day and time work for you?`;
  } else if (intent === "delivery_request") {
    suggestedResponse =
      "Thanks for asking. I’ll confirm whether local delivery works for this item and propose a time before sharing any private location details.";
  } else if (intent === "trade_request") {
    suggestedResponse =
      "Thanks for the offer. I’m focusing on the listed local-sale terms rather than a trade.";
  } else {
    suggestedResponse =
      "Thanks for your message. I’ll verify that detail and reply here shortly.";
  }

  return BuyerTaskSchema.parse({
    id: context.id,
    platformListingId: context.platformListingId,
    participantAlias: context.participantAlias,
    intent,
    redactedMessageExcerpt: redactBuyerMessage(context.rawMessage),
    suggestedResponse,
    approvalState: "pending",
    priceOffer,
    schedulingState: "none",
    requiresAddressApproval: /\b(address|porch|home|house)\b/i.test(
      context.rawMessage,
    ),
    scamSignals,
    createdAt: context.createdAt,
  });
}

function formatMoney(amountCents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(amountCents / 100);
}
