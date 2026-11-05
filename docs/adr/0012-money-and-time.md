# ADR-0012: Money and time handling (minor units, UTC, IANA zones)

- **Status:** Proposed (a **[Rec]** decision from [`architecture.md`](../architecture.md) §10 and §14, not yet ratified)
- **Date:** 2026-11-05
- **Deciders:** Project owner
- **Related:** [`architecture.md`](../architecture.md) §5.1, §5.2, §10 and §14, [`prd.md`](../prd.md) §5.2 to §5.5, [`common.yaml`](../api/common.yaml), [`catalog-service.openapi.yaml`](../api/catalog-service.openapi.yaml), ADR-0011, the planned ADR-0017 (Stripe) and ADR-0018 (cancellation policy)

## Context and problem

Three services touch money and time: catalog **stores** prices, the convenience fee, cancellation tiers and schedule times; booking and payment will **compute** with them (fees, refund amounts, cutoffs, refund windows). The documents already agree on the basics (integer cents, UTC, an IANA zone on venues and stations) but leave gaps that two services could fill differently: how an uneven amount is rounded, what a booking snapshot keeps, where "now" comes from, what happens exactly on a tier boundary, which zone a boarding point uses, how daylight saving time is handled, and where the sales cutoffs live.

This ADR fixes those rules once. It does **not** decide how a fee or a refund is computed from them; that belongs to ADR-0017 and ADR-0018.

## Decision

### Already decided elsewhere (restated, not changed)

- Money is an integer in minor units (cents), currency USD only: `Money { amountMinor, currency }` (`common.yaml`, `packages/contracts/src/common/money.ts`). Never a float.
- Fees and refund shares are **basis points** (10000 = 100%): the convenience fee is 0 to 2000 (`FeeConfig`, default 300 = 3%), a refund tier share is 0 to 10000 (`PolicyTier.refundBasisPoints`), and `flatFeeMinor` is a per-passenger amount in cents.
- Timestamps are RFC 3339 UTC and end in `Z` (`Timestamp`, ADR-0011 for `occurredAt`). Venues and stations carry an IANA `timezone`, used for display and for cutoff and refund-window calculations (`architecture.md` §10).
- Catalog freezes the effective cancellation policy and the fee onto a schedule at publish time. Booking snapshots both at hold time (`architecture.md` §5.1).

### 1. Rounding

- An amount derived from basis points is rounded **half up** to a whole cent, using integer arithmetic only: `floor((amountMinor * basisPoints + 5000) / 10000)`. No float, no `Math.round` on a division.
- The rule is applied **once per computed amount** (the fee, a refund), from the exact integers. A rounded result is never fed into another percentage inside the same computation.
- The rule is a single shared function. Where it lives (a `packages/*` module) is settled when ADR-0017 or ADR-0018 first needs it; neither service may write its own copy.
- Splitting one total across several passengers, so the parts add up to the total, is **not** decided here (ADR-0018).

### 2. What the booking snapshot keeps for the fee

- Catalog keeps the fee as basis points only (`FeeConfig`, and `convenienceFeeBasisPoints` frozen on the schedule).
- Booking's snapshot at hold time stores **both** the basis points it saw and the fee in cents it computed with rule 1. The two must agree when written (`feeMinor` equals the rule applied to the ticket subtotal).
- The charge is a stored fact: refunds and receipts read `feeMinor`, and the amount sent to Stripe is subtotal plus `feeMinor`. A later change to the rounding code cannot alter what a customer was charged. The basis points remain for audit and for recomputing per-passenger amounts.

### 3. Clock

- Every service takes a `Clock` through its constructor, as `packages/messaging` already does. Cutoff and refund-window rules are pure functions of `(now, startsAt)`; the caller passes `clock.now()`.
- Tests use a fixed clock and need no database. The database clock is not used to decide a cutoff or a refund window. Row timestamps written by the database (`createdAt` defaults) are not rule inputs.
- Replicas can differ by a few seconds of NTP drift. That is accepted: the shortest cutoff is 15 minutes. A skew tolerance between services is not defined here.

### 4. Refund tier boundary

- A tier applies when the time remaining is **greater than or equal to** its `minHoursBeforeStart`. The spec wording ("less than or equal to the hours remaining") and the PRD ("4 h or more") agree.
- The remaining time is exact to the millisecond: `startsAt - clock.now()`, with no rounding. Thresholds are whole hours, so flooring the remainder would give the same tier, and no choice is needed.
- Example, movie tiers 4 h / 1 h / 0 h: at exactly 4 h 0 min 0 s the share is 100%; at 3 h 59 min 59 s it is 50%.
- "Now" is the instant the cancel request is **processed**, using rule 3. If the screen showed a refund and a boundary passed before the customer confirmed, the amount applied is the one for the processing instant. Honouring the quote that was shown is not decided here (ADR-0018).
- `startsAt` is the value in the booking's schedule snapshot (origin departure for buses and trains). Whether a passenger boarding mid-route is measured from their own boarding time is not decided here (ADR-0018).

### 5. Timezone of a bus boarding point

- A boarding or dropping point has no timezone of its own. Its instant is the schedule's `startsAt` plus the offsets of its `RouteStop` and its `StopPoint`, and it is shown in the **timezone of that stop's `Station`**.
- The booking snapshot stores that UTC instant together with the station's IANA zone, so showing a ticket needs no call to catalog.
- `schedule.timezone` stays the origin zone. It is what the search `date` parameter and the schedule's own display use.
- Editing a station's timezone changes only snapshots taken afterwards. Existing bookings keep what they stored.

### 6. Daylight saving time and recurrence

- The API accepts and returns UTC instants only. There is no local date-time input.
- The console converts an operator's local wall time to UTC using the venue or station zone. A local time that does **not exist** (spring-forward gap) or is **ambiguous** (fall-back overlap) is refused with a message asking the operator to pick; the console never guesses.
- Recurring schedules are **out of the MVP**. If they are added, each occurrence is resolved from its local wall time and zone, never by adding 24 hours to a UTC instant, and that needs its own ADR.
- The sample data in the catalog spec (`Asia/Kolkata`, no DST) hides this. Tests for the console conversion must use a zone with DST (for example `America/New_York`), because the platform is USD-only.

### 7. Sales cutoffs

- The cutoff is a platform constant per vertical, defined once in `packages/contracts`: `MOVIE` 15 minutes, `BUS` 60 minutes, `TRAIN` 240 minutes before `startsAt` (`prd.md` §5.3). The name is `SALES_CUTOFF_MINUTES`.
- Catalog uses it to refuse a publish whose start is before the cutoff (`schedule-in-past`); booking uses it to refuse a hold. Both import the same constant.
- A change is a code change and a deploy of both services. There is no admin-editable or per-operator cutoff. If one is wanted later, catalog can freeze a value onto the schedule at publish, the way it does for the fee; the constant then becomes the default.

## Still open (not decided here)

- How the fee and a refund are computed from these inputs: ADR-0017 and ADR-0018. This includes the order of fee, percentage and flat fee on trains, the flat-fee amount (`prd.md` §14 item 3), per-passenger splits, partial cancellation and the quote question in rule 4.
- Whether a cutoff is inclusive at exactly the cutoff instant. Rule 4 covers refund tiers only.
- Whether a `StopPoint.offsetMinutes` is relative to the stop's arrival or departure offset (the spec says only "the stop's scheduled time").
- A tolerance for clock skew between services.
- Train fare structure (fare table or distance, `prd.md` §14 item 5), tax display (item 3), zero-priced schedules, a minimum fee and the Stripe minimum charge.
- Date-only fields such as `releaseDate`, and arrivals on a different local date than the departure.
- The module that holds the rounding function and the tier-selection helper.

## Consequences

- Booking and payment cannot disagree on rounding or on a tier boundary, because both use one function and one comparison.
- A charged fee never changes after the fact; the cost is one extra column in the snapshot and a check that it matches the basis points on write.
- Cutoff and refund rules are cheap to test (a fixed clock, no Docker), including the boundary cases above.
- A cross-zone bus route shows each boarding point in its own local time, at the price of stations needing a correct timezone. A wrong station zone shows a wrong time but never a wrong instant.
- Operators cannot create a schedule for a gap or ambiguous local time; the console must implement the check, and a script calling the API converts for itself.
- Cutoffs cannot be tuned without a deploy.

## Follow-ups

- `catalog-service.openapi.yaml`: say in `schedule-in-past` that the cutoff is `SALES_CUTOFF_MINUTES`; add one sentence on the boarding-point zone to `StopPoint` and `RouteStop`; say that `timezone` on a schedule is the origin zone.
- `common.yaml` and `packages/contracts`: `Money.currency` has `default: USD` in the spec but is required in Zod. Align them (not decided here).
- Add `SALES_CUTOFF_MINUTES` to `packages/contracts` when catalog or booking is built, with a test.
- Update `architecture.md` §10 to point at this ADR, and §14 to mark ADR-0012 as written.
