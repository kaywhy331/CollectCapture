# Product Requirements Document — LocalClear

**Working title:** LocalClear  
**Version:** 1.0  
**Date:** August 20, 2026  
**Status:** Proposed / Build-ready  
**Product type:** Mobile-first local-selling assistant with optional web dashboard and user-owned Android Seller Hub

---

## 1. Executive Summary

LocalClear helps ordinary people clear unwanted household items without learning multiple marketplaces or repeatedly creating the same listing.

The user photographs an item once. AI identifies it, extracts useful details, creates an accurate title and description, recommends a local price, and generates platform-specific listing variants. The user approves the item once and taps **List Locally**. A paired, user-owned Android device—either the user’s current phone or an optional spare “Seller Hub” phone—executes supported marketplace workflows using the accounts already logged in on that device.

The product is intentionally local-first:

- No shipping is required.
- No PayPal, Stripe, bank, payout, or payment-processing setup is required.
- Buyers and sellers arrange a local meetup, porch pickup, buyer pickup, or optional local delivery.
- Payment occurs directly between buyer and seller, normally in person.
- eBay may exist as an optional expansion channel but is not part of the default experience.

LocalClear uses official APIs wherever available. For approved platforms without APIs, it may use deterministic, user-initiated on-device workflows. Platforms that prohibit third-party posting remain disabled until written permission or an official partnership is obtained.

---

## 2. Overarching Goal

### Primary Goal

Make clearing unwanted items feel effortless by reducing the process from “photograph, research, write, post repeatedly, manage messages, and remove sold listings” to:

> **Photograph once → approve once → list locally → meet the buyer → mark sold everywhere.**

### User Promise

A nontechnical user should be able to turn an unwanted household item into accurate, ready-to-publish local listings with no shipping setup, no payment-account setup, and less than 60 seconds of active work after taking the photos.

### Business Outcome

Create the central operating layer for local household selling: item intelligence, listing creation, local cross-posting, inventory status, buyer-response assistance, meetup coordination, and cross-platform delisting.

### North-Star Metric

**Items cleared per active household per month**

An item is “cleared” when it is sold, given away, donated, recycled, or intentionally discarded.

---

## 3. Problem Statement

Selling locally is fragmented and mentally expensive. A user must repeatedly:

1. Identify the item and model.
2. Research a reasonable price.
3. Take and organize photos.
4. Write a title and description.
5. Select categories and condition.
6. Re-enter the same data on several platforms.
7. Respond to repetitive buyer questions.
8. Coordinate a meetup.
9. Mark the item sold and remove it everywhere.

This burden causes many people to leave valuable items unused, donate them prematurely, or avoid clearing clutter altogether.

Existing reseller tools are generally designed for high-volume commerce, shipping, inventory businesses, and professional sellers. LocalClear is designed first for ordinary households, moving projects, garage clear-outs, downsizing, and one-time bursts of local selling.

---

## 4. Product Principles

1. **Local first.** Default to face-to-face transactions and nearby buyers.
2. **Photo first.** The camera is the primary input, not a listing form.
3. **Approve once.** The user reviews one canonical item, not separate forms for every platform.
4. **Exceptions only.** Routine posting is automated; the user intervenes only for login, CAPTCHA, ambiguous fields, or policy issues.
5. **No payment layer.** LocalClear does not hold funds, process payments, issue refunds, or manage chargebacks.
6. **User-owned sessions.** Marketplace credentials and authenticated sessions remain on the user’s device whenever possible.
7. **Verified, not invented.** AI must not fabricate model numbers, specifications, condition, accessories, or defects.
8. **Clear the item, not merely list it.** The app may recommend selling, bundling, giving away, donating, recycling, or discarding.
9. **Platform-aware.** Every marketplace connector has explicit technical and policy capabilities.
10. **Lightweight UX.** Avoid reseller jargon, large forms, dense dashboards, and unnecessary configuration.
11. **Safety by default.** Exact home addresses, personal information, and meeting details are protected until the user approves sharing.
12. **No bypass architecture.** Do not defeat CAPTCHA, device-integrity checks, rate limits, listing fees, platform restrictions, or account controls.

---

## 5. Current Platform Constraints Shaping the Product

These are product-planning assumptions as of August 20, 2026 and must be revalidated before every public connector release.

| Platform | Product role | Recommended integration path | Public-release gate |
|---|---|---|---|
| Facebook Marketplace | Primary anchor | Official Meta path when available; otherwise user-owned-device connector for controlled testing | Platform/legal approval before broad public automation |
| Nextdoor For Sale & Free | Primary local channel | Official Publish API | Nextdoor API approval |
| OfferUp | High-priority local channel | Partnership or approved native connector | Written approval; do not use emulators or unapproved third-party posting |
| Craigslist | High-value secondary channel | Licensed connector only | Written Craigslist license or authorization |
| VarageSale | Local community candidate | Approved web or Android connector | Terms review and written permission where needed |
| Karrot | Hyperlocal candidate | Approved Android or web connector | Terms review and written permission where needed |
| 5miles | Local candidate | Approved native connector | Terms review and written permission where needed |
| Buy Nothing / Freecycle | Low-effort clearing path | Approved share, group, or partner workflow | Channel-specific policy review |
| eBay | Optional reach extension | Official API | User opt-in; disabled by default |

### Connector Policy Rule

A technically working connector is not automatically a production connector. Every connector must separately pass:

1. Technical compatibility review
2. Security review
3. Marketplace-policy review
4. Legal/commercial review
5. Production reliability testing

---

## 6. Target Users

### Persona A — Everyday Declutterer

Has a few unused items around the home but finds listing them tedious. Wants a simple, reassuring experience and is not familiar with reseller tools.

### Persona B — Moving or Downsizing Household

Needs to clear a room, garage, storage unit, or entire home quickly. Values batch capture, bundling, sell-fast pricing, and progress tracking.

### Persona C — Household Manager

Frequently sells children’s items, furniture, electronics, tools, and seasonal goods. Wants one inventory view and help managing buyer messages and pickups.

### Persona D — Professional Organizer or Estate-Clearance Operator

A later-stage user who needs multiple projects, team access, client inventory, reporting, and higher listing volume.

### Primary Exclusion

The MVP is not designed primarily for high-volume shipping businesses, dropshippers, retail arbitrage, or marketplace storefront operations.

---

## 7. Jobs to Be Done

1. **When I see something I no longer need,** help me photograph it and quickly decide whether to sell, bundle, give away, donate, or discard it.
2. **When I choose to sell it,** identify it, write the listing, recommend a price, and publish it to nearby buyers without repetitive work.
3. **When buyers respond,** help me answer quickly, negotiate within my rules, and coordinate a safe meetup.
4. **When the item is sold,** remove or mark it sold across every connected platform.
5. **When I am clearing a whole space,** help me process many items in one batch and show visible progress.

---

## 8. Scope

### MVP — In Scope

- Mobile account creation and onboarding
- Household selling preferences
- Camera capture and image upload
- Multi-photo item capture
- Batch “clear a space” capture
- AI item recognition
- OCR, barcode, label, and model-number extraction
- Canonical item and listing record
- AI-generated title, description, specifications, and condition prompts
- Platform-specific listing variants
- Fast, balanced, and maximize-value pricing suggestions
- Sell, bundle, give away, donate, recycle, or discard recommendation
- Prohibited/restricted-item screening
- User-owned Android Seller Hub pairing
- One-tap, user-initiated publishing jobs
- Connector state machine with resume and exception handling
- Central inventory and per-platform status
- Mark reserved, sold, given away, donated, or discarded
- Cross-platform delisting where supported
- Basic AI buyer-response drafts
- Saved pickup, meetup, and payment-preference wording
- Push notifications for required user intervention
- Admin connector health dashboard

### V1.1 / Near-Term

- Unified buyer task center
- User-approved one-tap replies on permitted channels
- Calendar availability and meetup scheduling
- Backup-buyer queue
- Automated price-reduction recommendations
- Listing renewal and stale-listing reminders
- Household sharing
- Facebook listing import where permitted
- Giveaway-channel automation
- Optional desktop companion

### Later

- Professional organizer and estate-sale workspaces
- Team roles and client accounts
- Optional cloud virtual phone as a paid fallback
- Optional shipping channels
- Optional eBay listing
- Advanced local demand forecasting
- Image-based item grouping and room-scale capture
- Partner analytics and marketplace reporting

### Explicitly Out of Scope for MVP

- Shipping-label creation
- Packaging workflows
- PayPal, Stripe, bank, card, escrow, or payout setup
- In-app checkout
- Refunds, disputes, or chargebacks
- Autonomous buyer negotiation without user rules
- Automatic disclosure of home address
- CAPTCHA solving or bypass
- Proxy rotation, emulator concealment, device fingerprint spoofing, or anti-detection measures
- Posting to platforms without an approved production method
- Cloud-hosted marketplace credentials as the default architecture

---

## 9. Core User Experience

### 9.1 Onboarding

The user completes a short, plain-language setup:

1. Choose a goal: **Sell a few items** or **Clear a space**.
2. Enter ZIP code and preferred selling radius.
3. Select exchange preferences:
   - Public meetup
   - Porch pickup
   - Buyer pickup for large items
   - Local delivery
   - Decide per item
4. Select payment wording:
   - Cash preferred
   - External payment apps accepted
   - Decide at meetup
5. Set default availability and preferred meetup locations.
6. Choose platforms.
7. Pair an Android Seller Hub when required.

No financial account is requested.

### 9.2 Seller Hub Setup

The user may use:

- Their current Android phone
- A spare Android phone kept at home
- A future approved desktop/Android bridge

Pairing flow:

1. Install the LocalClear Seller Hub app.
2. Scan a QR code from the main app.
3. Approve the device pairing.
4. Log into each marketplace directly inside its official app.
5. Run a connection test.
6. Leave the device connected to power and Wi-Fi if it will operate as a dedicated hub.

The main app stores connection state, not marketplace passwords.

### 9.3 Capture

The user taps **Photograph Something to Clear** or **Clear a Whole Space**.

For each item, the app requests only the useful evidence:

1. Main item photo
2. Brand, barcode, label, or model-number photo when available
3. Condition or damage photo when relevant

The app automatically evaluates blur, lighting, framing, and missing item coverage.

### 9.4 AI Review

The system presents:

- Likely item identity
- Brand and model
- Confidence level
- Condition question
- Included accessories
- Detected defects
- Estimated local value
- Recommended clearing path

The normal user should make no more than three decisions:

1. Is this the correct item?
2. What condition is it in?
3. Do you want fast sale, balanced value, or maximum value?

### 9.5 Publish

The user sees one consolidated preview and taps **List Locally**.

The publishing orchestrator sends the job to every selected, supported connector. The user sees live statuses:

- Queued
- Publishing
- Published
- Needs login
- Needs confirmation
- Platform changed
- Blocked by policy
- Failed; retry available

The user never needs to copy and paste listing fields.

### 9.6 Buyer Tasks

The app helps classify and respond to:

- Is this available?
- Price offers
- Product questions
- Dimensions or compatibility
- Pickup availability
- Delivery requests
- Trade requests
- Suspected scams
- No-show follow-ups

The MVP drafts replies. The user approves before sending unless an official integration explicitly permits a preconfigured automated reply.

### 9.7 Sale and Clearing

The user marks the item:

- Reserved
- Sold
- Given away
- Donated
- Recycled
- Discarded

For sold or unavailable items, the app automatically delists on supported connectors and creates a single exception task for any connector that requires user action.

---

## 10. Primary Screens

1. **Welcome / Goal Selection**
2. **Home / Clear-Out Progress**
3. **Camera / Batch Capture**
4. **AI Item Review**
5. **Price and Clearing Recommendation**
6. **Local Platform Selection**
7. **Publishing Progress**
8. **Inventory**
9. **Buyer Tasks**
10. **Item Detail / Listing Status**
11. **Meetup and Availability**
12. **Connections / Seller Hub Settings**

### Home Screen Requirements

The home screen should prioritize action and progress, not reseller analytics.

Example:

- 12 items cleared this month
- $486 recovered
- 4 items ready to list
- 2 buyers need replies
- 1 sold item needs removal

Primary action: **Photograph Something to Clear**  
Secondary action: **Clear a Whole Space**

---

## 11. Functional Requirements

### 11.1 Accounts and Household Preferences

| ID | Requirement | Priority |
|---|---|---|
| ACC-01 | Support Apple, Google, and email authentication | Must |
| ACC-02 | Support one household profile with optional future members | Must |
| ACC-03 | Store ZIP code, selling radius, exchange preferences, availability, and price rules | Must |
| ACC-04 | Store payment wording only; do not connect payment accounts | Must |
| ACC-05 | Allow users to set a default minimum offer percentage or item-specific price floor | Must |
| ACC-06 | Allow users to export and delete their account data | Must |

### 11.2 Seller Hub

| ID | Requirement | Priority |
|---|---|---|
| HUB-01 | Pair a physical Android device through a QR code and device-bound key pair | Must |
| HUB-02 | Support Android 11 or newer for the first production target | Must |
| HUB-03 | Display device online state, power state, network state, and last successful check-in | Must |
| HUB-04 | Marketplace login occurs only inside the marketplace’s official app | Must |
| HUB-05 | Marketplace passwords, cookies, and session tokens must not be uploaded to LocalClear servers | Must |
| HUB-06 | Accept only signed, allow-listed publishing commands | Must |
| HUB-07 | Reject expired, replayed, malformed, or unauthorized jobs | Must |
| HUB-08 | Pause automation when login, MFA, CAPTCHA, or an unexpected screen appears | Must |
| HUB-09 | Notify the user and resume from the paused state after intervention | Must |
| HUB-10 | Support remote disconnect, local logout instructions, and cryptographic device unpairing | Must |
| HUB-11 | Delete temporary listing media after configurable retention | Must |
| HUB-12 | Never expose ADB, a remote shell, or arbitrary device control over the public internet | Must |
| HUB-13 | Support an optional Windows bridge for internal testing and advanced users | Should |
| HUB-14 | Do not use emulators or device-obfuscation methods for restricted production connectors | Must |

### 11.3 Photo Capture and Media

| ID | Requirement | Priority |
|---|---|---|
| CAP-01 | Capture photos from camera or select existing images | Must |
| CAP-02 | Support 1–12 images per item | Must |
| CAP-03 | Support uninterrupted batch capture for at least 25 items | Must |
| CAP-04 | Detect blur, poor lighting, excessive glare, and incomplete framing | Must |
| CAP-05 | Suggest a label, model-number, damage, or scale photo when useful | Must |
| CAP-06 | Auto-crop, rotate, and lightly correct exposure without changing the item’s appearance | Must |
| CAP-07 | Strip EXIF location metadata before external publishing | Must |
| CAP-08 | Detect likely faces, documents, addresses, and license plates and offer redaction | Should |
| CAP-09 | Automatically choose and order the strongest lead photo | Should |

### 11.4 AI Identification and Listing Generation

| ID | Requirement | Priority |
|---|---|---|
| AI-01 | Identify general item type, category, brand, and likely model | Must |
| AI-02 | Run OCR on labels, serial/model text, dimensions, and packaging | Must |
| AI-03 | Read UPC/EAN/barcodes where visible | Must |
| AI-04 | Return confidence and top alternative matches | Must |
| AI-05 | Ask only the minimum unresolved questions | Must |
| AI-06 | Generate a canonical title, description, condition summary, details, and specifications | Must |
| AI-07 | Generate platform-specific title and description variants | Must |
| AI-08 | Mark every specification as image-derived, catalog-derived, user-confirmed, or inferred | Must |
| AI-09 | Never publish unverified model-specific facts above the confidence threshold | Must |
| AI-10 | Detect prohibited, restricted, recalled, unsafe, or age-restricted items before publishing | Must |
| AI-11 | Recommend sell individually, bundle, give away, donate, recycle, or discard | Must |
| AI-12 | Suggest related items that should be bundled | Should |

### 11.5 Pricing

| ID | Requirement | Priority |
|---|---|---|
| PRI-01 | Provide Sell Fast, Balanced, and Maximize Value prices | Must |
| PRI-02 | Allow a minimum acceptable price | Must |
| PRI-03 | Use only approved data sources and LocalClear’s own outcome data | Must |
| PRI-04 | Clearly distinguish active asking prices from verified sold outcomes | Must |
| PRI-05 | Show comparable count, confidence, and major adjustment factors | Must |
| PRI-06 | Apply condition, local demand, seasonality, and sale-speed factors | Should |
| PRI-07 | Allow the user to override every price recommendation | Must |
| PRI-08 | Never represent a suggested price as guaranteed | Must |

### 11.6 Canonical Listing

| ID | Requirement | Priority |
|---|---|---|
| LST-01 | Store one canonical item record independent of any marketplace | Must |
| LST-02 | Generate separate platform field mappings from the canonical record | Must |
| LST-03 | Store item condition, dimensions, accessories, defects, storage location, and availability | Must |
| LST-04 | Apply saved pickup, meetup, delivery, payment, negotiation, and hold rules | Must |
| LST-05 | Let the user preview and edit one consolidated listing before publishing | Must |
| LST-06 | Support batch approval and batch publishing | Must |
| LST-07 | Version listing content so edits and publishing jobs are auditable | Must |

### 11.7 Publishing Orchestrator

| ID | Requirement | Priority |
|---|---|---|
| PUB-01 | Create one publishing job per item, platform, and listing version | Must |
| PUB-02 | Enforce idempotency to prevent duplicate listings | Must |
| PUB-03 | Use a resumable state machine for every job | Must |
| PUB-04 | Retry transient failures with bounded backoff | Must |
| PUB-05 | Pause rather than restart when user intervention is required | Must |
| PUB-06 | Report real-time progress to the main app | Must |
| PUB-07 | Capture the platform listing ID, URL, price, and publish time when available | Must |
| PUB-08 | Store structured failure reasons and connector/app versions | Must |
| PUB-09 | Provide a remote connector kill switch | Must |
| PUB-10 | Allow per-platform rate limits and daily listing caps | Must |
| PUB-11 | Never bypass CAPTCHA, payment prompts, platform fees, or security challenges | Must |

### 11.8 Connector Framework

| ID | Requirement | Priority |
|---|---|---|
| CON-01 | Every connector declares publish, edit, delist, mark-sold, message-read, and message-send capabilities | Must |
| CON-02 | Every connector declares its policy status: approved, review, internal-only, or disabled | Must |
| CON-03 | Support connector-specific required fields and category mappings | Must |
| CON-04 | Use stable resource IDs, accessibility labels, text, and screen state before coordinate-based fallback | Must |
| CON-05 | Automation must be deterministic and initiated by an explicit user action | Must |
| CON-06 | AI may prepare listing data but must not freely plan arbitrary device actions | Must |
| CON-07 | Connector definitions must be versioned and remotely disableable | Must |
| CON-08 | Support canary testing against new marketplace app versions | Must |
| CON-09 | Block unsupported app versions rather than publishing unpredictably | Must |
| CON-10 | Maintain a connector-specific compliance and change log | Must |

### 11.9 Inventory and Delisting

| ID | Requirement | Priority |
|---|---|---|
| INV-01 | Track Captured, Draft, Ready, Publishing, Partially Live, Live, Reserved, Sold, and Cleared states | Must |
| INV-02 | Track a separate status for each platform listing | Must |
| INV-03 | Support item edits and propagate changes where supported | Must |
| INV-04 | Support Mark Reserved, Mark Sold, Relist, Archive, and Delete | Must |
| INV-05 | Delist or mark sold across all capable connectors from one action | Must |
| INV-06 | Create one consolidated exception task for remaining platforms | Must |
| INV-07 | Detect likely duplicate item records and duplicate external listings | Must |
| INV-08 | Store optional physical storage location such as “garage shelf A” | Should |
| INV-09 | Preserve sale price, destination, days-to-sale, and outcome for pricing intelligence | Must |

### 11.10 Messaging and Buyer Assistance

| ID | Requirement | Priority |
|---|---|---|
| MSG-01 | Read messages only through approved APIs, approved connectors, or explicit user-authorized device access | Must |
| MSG-02 | Classify buyer intent | Must |
| MSG-03 | Generate a concise suggested reply | Must |
| MSG-04 | Require user approval before sending in the MVP | Must |
| MSG-05 | Enforce item price floor, trade preference, hold duration, and delivery rules | Must |
| MSG-06 | Never disclose an exact address without explicit approval | Must |
| MSG-07 | Detect common scam signals and warn the user | Should |
| MSG-08 | Create Accept, Counter, Decline, and Schedule actions | Should |
| MSG-09 | Maintain a backup-buyer queue for reserved items | Should |

### 11.11 Meetup and Local Exchange

| ID | Requirement | Priority |
|---|---|---|
| MTP-01 | Store preferred public meetup locations | Must |
| MTP-02 | Store pickup availability windows | Must |
| MTP-03 | Generate proposed meetup responses from availability | Must |
| MTP-04 | Support porch pickup, buyer pickup, public meetup, and optional local delivery | Must |
| MTP-05 | Allow calendar integration later without making it mandatory | Should |
| MTP-06 | Keep payment outside LocalClear | Must |

### 11.12 Giveaway and Donation Lane

| ID | Requirement | Priority |
|---|---|---|
| GIV-01 | Recommend free/giveaway when expected sale value does not justify effort | Must |
| GIV-02 | Generate a giveaway-specific title and description | Must |
| GIV-03 | Track Given Away and Donated as successful outcomes | Must |
| GIV-04 | Suggest donation or recycling categories and notes | Should |

### 11.13 Admin and Operations

| ID | Requirement | Priority |
|---|---|---|
| OPS-01 | Connector health dashboard by platform, app version, and failure type | Must |
| OPS-02 | Remote connector and feature kill switches | Must |
| OPS-03 | Redacted diagnostic screenshots only after explicit user consent | Must |
| OPS-04 | Audit all connector-definition changes and production releases | Must |
| OPS-05 | Support policy status, approval evidence, and owner per connector | Must |
| OPS-06 | Alert on abnormal duplicate rates, account challenges, or failure spikes | Must |

---

## 12. Publishing State Machine

```text
DRAFT
  → READY
  → QUEUED
  → DEVICE_WAKE
  → OPEN_PLATFORM
  → VERIFY_SESSION
  → PRECHECK
  → UPLOAD_MEDIA
  → FILL_FIELDS
  → VALIDATE
  → SUBMIT
  → VERIFY_PUBLISHED
  → SYNC_RESULT
  → PUBLISHED
```

Exception states:

```text
NEEDS_LOGIN
NEEDS_MFA
NEEDS_CAPTCHA
NEEDS_USER_CONFIRMATION
NEEDS_REQUIRED_FIELD
APP_VERSION_UNSUPPORTED
PLATFORM_UI_CHANGED
ITEM_BLOCKED
LISTING_LIMIT_REACHED
NETWORK_UNAVAILABLE
DEVICE_OFFLINE
FAILED_RETRYABLE
FAILED_FINAL
CANCELLED
```

### State-Machine Rules

- Every transition is logged.
- A job may resume from the last verified state.
- The same idempotency key cannot create two active platform listings.
- The connector must confirm a successful post before reporting Published.
- A user challenge is surfaced; it is never bypassed.
- A connector can be disabled globally without releasing a new app version.

---

## 13. Platform Connector Strategy

### Technical MVP

Prove all three connector patterns:

1. One official API connector
2. One user-owned Android connector
3. One browser or import connector

The technical MVP may run only on internal/test accounts where required.

### Public Beta

At least two meaningful local platforms must be production-enabled through an official API, written approval, or a clearly permitted connector method.

### V1 Public Release

At least three production-enabled local platforms must be available without relying on eBay. Every platform must pass the connector definition-of-done checklist.

### Connector Definition of Done

A connector is complete only when:

- [ ] Platform policy and terms have been reviewed.
- [ ] The production method is documented as permitted or approved.
- [ ] Supported app/web versions are defined.
- [ ] Login and session persistence are tested.
- [ ] Required fields and category mappings are complete.
- [ ] Photo upload is reliable.
- [ ] Publish confirmation is reliable.
- [ ] Listing ID or URL is captured where possible.
- [ ] Edit, mark sold, and delist capabilities are declared accurately.
- [ ] Duplicate prevention is tested.
- [ ] User intervention and resume are tested.
- [ ] Connector kill switch is tested.
- [ ] Telemetry is redacted and reviewed.
- [ ] A maintenance owner is assigned.
- [ ] A canary test exists for marketplace app updates.

---

## 14. Core Data Model

### User

- id
- authentication method
- name
- timezone
- locale
- notification preferences
- privacy settings

### Household

- id
- owner
- ZIP code
- selling radius
- pickup preferences
- payment wording
- availability
- preferred meetup locations

### SellerDevice

- id
- household_id
- device public key
- Android version
- app version
- connection status
- power/network status
- last check-in
- capabilities
- revoked_at

### PlatformConnection

- id
- seller_device_id
- platform
- display alias
- connection status
- last verified time
- supported capabilities
- policy status

No marketplace password, cookie, or session token is stored in this record.

### Item

- id
- household_id
- title
- category
- brand
- model
- condition
- dimensions
- specifications
- accessories
- defects
- storage location
- identification confidence
- clearing recommendation
- status

### MediaAsset

- id
- item_id
- storage path
- media type
- order
- redaction state
- source
- retention state

### CanonicalListing

- id
- item_id
- version
- title
- description
- price strategy
- asking price
- minimum price
- location
- exchange options
- listing provenance

### PlatformListing

- id
- item_id
- platform
- external listing ID
- external URL
- platform title
- platform price
- status
- published at
- last synchronized at
- connector version

### PublishingJob

- id
- item_id
- platform
- listing version
- idempotency key
- current state
- retry count
- device ID
- connector version
- error code
- created/started/completed timestamps

### Conversation / BuyerTask

- id
- platform listing ID
- participant alias
- intent
- message excerpt or approved content
- suggested response
- approval state
- price offer
- scheduling state

### Meetup

- id
- item ID
- platform listing ID
- buyer alias
- date/time
- location type
- approved location
- status

### AuditEvent

- actor
- action
- object type/id
- timestamp
- device
- redacted metadata

---

## 15. Technical Architecture

```text
┌──────────────────────────────────────────────┐
│ Main Mobile App                              │
│ React Native / Expo                         │
│ Camera, review, inventory, buyer tasks       │
└──────────────────────┬───────────────────────┘
                       │
┌──────────────────────▼───────────────────────┐
│ Backend                                      │
│ Auth, Postgres, object storage, realtime     │
│ Canonical items, listings, jobs, audit       │
└───────────────┬──────────────────┬───────────┘
                │                  │
┌───────────────▼──────────┐  ┌────▼─────────────────────┐
│ AI Enrichment Service    │  │ Publishing Orchestrator │
│ Vision, OCR, catalog,    │  │ State machine, retries, │
│ copy, pricing, policy    │  │ idempotency, telemetry  │
└──────────────────────────┘  └────┬─────────────────────┘
                                   │ Signed job
                         ┌─────────▼──────────────────────┐
                         │ User-Owned Android Seller Hub │
                         │ Official marketplace apps     │
                         │ Device-local sessions         │
                         │ Deterministic connectors      │
                         └─────────┬──────────────────────┘
                                   │
                         ┌─────────▼──────────────────────┐
                         │ Local Marketplaces            │
                         └────────────────────────────────┘
```

### Recommended Stack

- **Main app:** React Native with Expo
- **Optional web dashboard/admin:** Next.js
- **Backend:** Supabase Auth, Postgres, Storage, Realtime
- **API/services:** TypeScript with Fastify or NestJS
- **Job queue:** Postgres-backed queue such as Graphile Worker or pg-boss for MVP
- **AI:** provider-abstracted vision-language model, OCR, barcode service, and catalog/comparable adapters
- **Seller Hub:** Kotlin and Jetpack Compose
- **Internal automation proof of concept:** Appium / UI Automator with a physical Android device and optional Windows bridge
- **Production deterministic automation:** platform-approved connector using the narrowest permitted Android capability
- **Push:** FCM and APNs
- **Observability:** OpenTelemetry and Sentry-compatible error monitoring
- **Remote configuration:** versioned connector definitions and feature flags stored in the backend

### Execution Model

The default production model is **cloud intelligence plus local account execution**.

Marketplace traffic leaves through the user’s physical Android device and normal Wi-Fi or mobile connection. Marketplace sessions remain inside the official marketplace apps. The backend receives only connection health, publishing status, listing identifiers, and approved diagnostic information.

A cloud virtual phone is not required for the MVP.

---

## 16. Security and Privacy Requirements

### Credential Boundary

- Marketplace credentials must never be requested by the main LocalClear app.
- Users authenticate directly inside each official marketplace app.
- Passwords, cookies, refresh tokens, and marketplace session databases must remain on the Seller Hub.
- LocalClear may store only connection state and nonsecret account display information.

### Device Trust

- Pair devices using a device-generated public/private key pair.
- Store the private key in Android Keystore where available.
- Bind every publishing job to a user, household, device, item, platform, and expiration time.
- Reject job replay and cross-device execution.

### Command Restrictions

The Seller Hub must not accept arbitrary scripts or shell commands from the backend. It accepts only versioned, allow-listed actions such as:

- publish approved listing
- update approved field set
- mark sold
- archive/delist
- check connection state
- pause/resume approved job

### Login Privacy Mode

When a user logs into a marketplace:

- Automation pauses.
- Screen recording and diagnostic capture are disabled.
- Password fields are not logged.
- Clipboard contents are not collected.
- Support staff cannot join the session without a separate user-authorized flow.

### Media Privacy

- Strip EXIF geolocation before publishing.
- Detect possible addresses, documents, people, and license plates.
- Store images in private object storage.
- Use short-lived signed download URLs for Seller Hub jobs.
- Delete temporary device copies after the configured retention period.

### Location Privacy

- Publish approximate location by default.
- Do not share exact address in a listing.
- Require explicit approval before disclosing a pickup address.

### Administrative Access

- No standing employee access to user devices or marketplace sessions.
- Use time-limited, audited support access.
- Require reason codes and user consent for sensitive diagnostic sessions.

### Account Deletion

A delete request must:

1. Revoke device keys
2. Cancel active jobs
3. Delete cloud data according to retention policy
4. Instruct or trigger local cache deletion
5. Confirm completion to the user

### Security Release Gate

Public release requires:

- Threat model
- Security architecture review
- Mobile and API penetration test
- Dependency and secret scanning
- Incident-response plan
- Data-retention policy
- Privacy policy and terms of use
- No unresolved critical or high-severity findings

---

## 17. Nonfunctional Requirements

### Performance

- AI draft median: 20 seconds or less
- AI draft p95: 45 seconds or less
- Publishing job start after device is online: 10 seconds or less
- Median supported-platform publish time: 90 seconds or less, excluding user challenges
- Buyer-response draft: 5 seconds or less
- Inventory status update: 3 seconds or less after device result

### Reliability

- Backend monthly availability target: 99.5% for beta, 99.9% after general release
- Crash-free mobile sessions: at least 99.5%
- Supported connector publish success: at least 90%, excluding login/MFA/CAPTCHA and platform outages
- Duplicate active-listing rate: below 0.5%
- Resume-after-intervention success: at least 95%
- No silent failure; every job ends in a visible success, pause, or failure state

### Accessibility and Ease of Use

- WCAG 2.2 AA for web surfaces
- Mobile controls meet platform tap-target guidance
- Support large text and screen readers
- Plain-language error messages
- No required copy/paste between applications
- No more than three routine decisions after item capture
- Progress is visible and resumable

### Scalability

- Every user may have multiple paired devices, but one primary Seller Hub
- Jobs are horizontally processable and idempotent
- Connectors are independently deployable and disableable
- AI providers and pricing sources are replaceable through adapters

### Observability

Track:

- connector/app version
- job state duration
- failure reason
- retry count
- intervention type
- duplicate prevention events
- publish confirmation method
- policy status

Logs must not contain passwords, session tokens, full private messages, or unnecessary personal information.

---

## 18. Metrics

### North Star

- Items cleared per active household per month

### Activation

- Percentage completing first item draft
- Percentage pairing a Seller Hub
- Percentage publishing to at least two local platforms
- Time to first published listing

### Efficiency

- Active user time per item
- AI draft acceptance rate
- Average edits per listing
- Items processed per batch session
- Exception rate per connector

### Marketplace Outcome

- Publish success rate
- Listing-to-inquiry rate
- Days to sale
- Accepted price versus recommendation
- Sell-through rate at 7, 14, and 30 days
- Percentage bundled, given away, or donated

### Retention and Satisfaction

- Households clearing another item within 30 days
- Items cleared per project
- User satisfaction after first successful sale
- Seller Hub disconnect rate
- Support contacts per 100 publishing jobs

---

## 19. Key Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Marketplace disallows third-party posting | Connector cannot launch publicly | Official API/partnership first; policy gate; kill switch |
| Marketplace UI changes | Publishing failures | Versioned connectors, canary tests, app-version gating, rapid disable |
| Android automation policy rejection | Seller Hub distribution blocked | Deterministic user-started design, clear disclosure, Play review; desktop bridge fallback |
| Account challenge or lockout | User trust damage | User IP/device, conservative rate limits, no bypass, visible challenge handling |
| AI misidentifies item | Misleading listing or price | Confidence thresholds, label capture, user confirmation, provenance |
| Price data is weak | Poor recommendations | Show confidence, multiple price modes, user override, own outcome dataset |
| Seller Hub offline | Jobs delayed | Queue, power/network warnings, automatic resume |
| iPhone user lacks Android device | Reduced platform coverage | Optional low-cost/spare Seller Hub; browser/API connectors; later paid cloud fallback |
| Credential/session compromise | Account takeover | Sessions stay local, device keys, signed jobs, no remote shell, security review |
| Listing sells on one platform but remains active elsewhere | Double sale | One-tap mark sold, automatic delist, urgent exception tasks |
| Prohibited item is posted | Account or legal risk | Platform-specific policy classifier and publish-time block |
| User perceives setup as technical | Activation failure | QR pairing, setup test, plain language, guided one-time onboarding only |

---

## 20. Delivery Phases

### Phase 0 — Compatibility and Policy Lab

- Build marketplace compatibility harness.
- Test install, login, session persistence, photo transfer, field entry, publish, edit, and delist.
- Record platform terms and approval requirements.
- Classify every platform Green, Yellow, or Red.

### Phase 1 — Core LocalClear App

- Authentication and household settings
- Camera and batch capture
- AI identification and listing generation
- Pricing and clearing recommendation
- Canonical inventory
- Manual status lifecycle

### Phase 2 — Seller Hub Foundation

- QR pairing
- Device keys and signed jobs
- Connectivity and power reporting
- Temporary photo transfer
- Deterministic automation engine
- User challenge and resume
- Internal Windows/physical-device test harness

### Phase 3 — Multi-Platform Publishing

- One official API connector
- One approved Android connector
- One approved web/import connector
- Publishing progress
- Idempotency and retries
- Listing ID/URL capture
- Connector health dashboard

### Phase 4 — Inventory Closure

- Mark reserved and sold
- Cross-platform delisting
- Relist and price update
- Sale-outcome capture
- Giveaway and donation outcomes

### Phase 5 — Buyer and Meetup Assistance

- Buyer task classification
- AI response drafts
- Price-floor enforcement
- Scheduling suggestions
- Backup-buyer queue
- Safe meetup defaults

### Phase 6 — Partnerships and Expansion

- Facebook/Meta integration path
- OfferUp partnership
- Nextdoor Search API or additional capabilities
- Craigslist licensing request
- VarageSale, Karrot, and 5miles approvals
- Professional organizer features

---

## 21. Completion Criteria

### A. Core Product and UX

- [ ] A user can create an item from 1–12 photos.
- [ ] A user can process at least 25 items in one batch-capture session.
- [ ] The routine post-capture flow requires no more than three user decisions.
- [ ] A user can publish without configuring shipping or a payment account.
- [ ] A user never needs to copy and paste title, description, price, or photos between apps.
- [ ] At least 80% of nontechnical usability-test participants complete the first item flow without assistance.
- [ ] Median active user time after photos is 60 seconds or less per item.
- [ ] p90 active user time after photos is 120 seconds or less per item.
- [ ] The app supports large text, screen readers, and clear error recovery.

### B. AI and Listing Quality

- [ ] A benchmark set of at least 500 supported household items is established.
- [ ] Top-1 item identification accuracy is at least 85% on the supported benchmark.
- [ ] Top-3 identification accuracy is at least 95%.
- [ ] OCR accuracy on clear model/label images is at least 95% for required fields.
- [ ] At least 80% of generated titles and descriptions are accepted without material edits.
- [ ] Every model-specific specification has a provenance state.
- [ ] Unsupported or low-confidence specifications are not auto-published.
- [ ] Every price recommendation shows strategy and confidence.
- [ ] At least 75% of supported-item Balanced prices fall within 20% of the approved benchmark median.
- [ ] Restricted-item screening runs before every publish job.

### C. Seller Hub

- [ ] A nontechnical user can pair a compatible Android device in 10 minutes or less.
- [ ] Pairing uses a device-bound key pair and QR code.
- [ ] Marketplace credentials never enter the LocalClear backend.
- [ ] Marketplace sessions remain inside official marketplace apps on the user’s device.
- [ ] Expired, replayed, altered, or unauthorized jobs are rejected.
- [ ] The Seller Hub reports connectivity, power, app version, and connection health.
- [ ] Jobs pause for login, MFA, CAPTCHA, and unexpected screens.
- [ ] A paused job resumes without re-entering completed fields whenever technically possible.
- [ ] The user can revoke and unpair the device.
- [ ] Temporary listing media is deleted according to the retention policy.
- [ ] No public ADB endpoint, arbitrary shell, or arbitrary script execution exists.

### D. Publishing

- [ ] The technical MVP proves one API, one Android, and one web/import connector pattern.
- [ ] The public beta includes at least two legally permitted local-platform connectors.
- [ ] V1 includes at least three legally permitted local-platform connectors and does not depend on eBay.
- [ ] Supported connector publish success is at least 90%, excluding user authentication challenges and platform outages.
- [ ] Duplicate active-listing rate is below 0.5%.
- [ ] Resume-after-intervention success is at least 95%.
- [ ] Every publishing job has a visible final or paused state.
- [ ] Successful jobs capture a listing ID or URL whenever the platform exposes one.
- [ ] Each connector has a working remote kill switch.
- [ ] Every production connector passes the connector definition-of-done checklist.

### E. Inventory and Clearing

- [ ] Every item has one canonical record and separate platform statuses.
- [ ] The user can mark an item reserved, sold, given away, donated, recycled, or discarded.
- [ ] One action initiates delisting or mark-sold across all capable connectors.
- [ ] Delisting succeeds at least 95% of the time on connectors that support it.
- [ ] Remaining manual or policy-blocked actions appear as one consolidated exception task.
- [ ] Sale price, platform, days to sale, and outcome are retained for analytics.
- [ ] Duplicate item detection is available before publishing.

### F. Buyer and Meetup Assistance

- [ ] The system classifies the primary buyer intents defined in the PRD.
- [ ] Suggested replies are generated in 5 seconds or less.
- [ ] MVP messages require user approval before sending.
- [ ] Price floors and trade/delivery rules are enforced in response suggestions.
- [ ] Exact home addresses are never disclosed automatically.
- [ ] The user can save public meetup locations and availability.
- [ ] The system can generate accept, counter, decline, and schedule responses.

### G. Security and Privacy

- [ ] A formal threat model is complete.
- [ ] All network traffic uses modern transport encryption.
- [ ] Sensitive cloud data is encrypted at rest.
- [ ] Device private keys use secure platform storage.
- [ ] Job signatures, expiration, replay prevention, and scope restrictions are tested.
- [ ] Logs contain no passwords, session tokens, or unnecessary private-message content.
- [ ] EXIF location is stripped from published photos.
- [ ] Account and device deletion flows are tested end to end.
- [ ] A third-party or independent penetration test reports no unresolved critical or high-severity issues.
- [ ] Incident-response, privacy, retention, and support-access policies are approved.

### H. Platform Compliance

- [ ] Every production connector has documented permission, official API access, or a reviewed permitted method.
- [ ] OfferUp public automation remains disabled until written approval is obtained.
- [ ] Craigslist automated posting remains disabled until licensed or authorized.
- [ ] No connector bypasses CAPTCHA, app integrity, rate limits, or listing fees.
- [ ] Android automation remains deterministic, narrow, and explicitly user initiated.
- [ ] Required disclosures and platform-store declarations are complete.
- [ ] Policy status can disable a connector immediately.

### I. Performance and Reliability

- [ ] AI draft median is 20 seconds or less and p95 is 45 seconds or less.
- [ ] Publishing begins within 10 seconds of an online Seller Hub receiving a job.
- [ ] Median platform publish time is 90 seconds or less, excluding user challenges.
- [ ] Inventory status updates within 3 seconds of a device result.
- [ ] Crash-free mobile sessions are at least 99.5%.
- [ ] Beta backend availability is at least 99.5%.
- [ ] Connector failure spikes generate automated alerts.
- [ ] No job fails silently.

### J. Beta Release Gate

- [ ] At least 25 nontechnical households complete the end-to-end flow.
- [ ] At least 1,000 item-platform publishing attempts are tested.
- [ ] No severe user-account security incident occurs during the pilot.
- [ ] No unresolved critical connector defect remains.
- [ ] User satisfaction averages at least 4.3 out of 5 after first successful listing.
- [ ] At least 50% of beta users publish a second item.
- [ ] The team can disable any connector without an app release.
- [ ] Support documentation covers pairing, login expiration, device offline, platform changes, and account deletion.

---

## 22. Final Product Definition

LocalClear is complete when an ordinary user can:

1. Photograph an unwanted item.
2. Receive an accurate AI-generated identity, listing, and price recommendation.
3. Approve the item once.
4. Tap **List Locally**.
5. Have the listing published through multiple permitted local-platform connectors using accounts already logged in on the user’s own device.
6. Receive buyer-response and meetup assistance.
7. Mark the item sold or otherwise cleared.
8. Remove it from every supported platform without shipping, payment processing, repetitive forms, or technical marketplace knowledge.

The core product promise is:

> **Take pictures. Approve once. Clear it locally.**
