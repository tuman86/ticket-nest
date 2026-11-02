# TicketNest — Product Requirements Document

**Status:** Draft for review
**Date:** 2026-11-01
**Author:** Som (with Claude)
**Type:** Solo learning project, built to industry standards

Items marked **[Assumption]** were not explicitly decided in the interview. They are collected in section 14 for confirmation.

---

## 1. Overview

TicketNest is a demo booking platform for **movies, buses and trains**. Customers search inventory, pick specific seats or berths, pay online, and receive e-tickets with QR codes. Operators (cinemas, bus companies, railways) manage their own inventory and schedules. Admins and support agents oversee the platform.

The project doubles as a vehicle for learning microservices, event-driven design, concurrency control and Kubernetes. Architectural quality matters as much as feature breadth.

### 1.1 Goals

1. End-to-end booking for all three verticals with **no double-booking, ever**.
2. A realistic payment and refund lifecycle on Stripe (test mode).
3. Multi-tenant operators who manage their own inventory and cancellation policies.
4. A separate, reusable notification service (email, SMS, web push, reminders).
5. A production-style engineering setup: observability, CI, containers, Kubernetes, automated tests including load tests.

### 1.2 Non-goals (later phases)

Promo codes and coupons; wallet and loyalty; dynamic pricing; food and beverage add-ons; reviews and ratings; multi-currency and i18n; native mobile app; operator reporting dashboards; seat-tier pricing; booking rescheduling or modification; train waitlist and RAC; GDPR-style account deletion and data export; government ID capture.

### 1.3 Tech stack

Next.js (App Router), Express 5, TypeScript (strict), PostgreSQL + Prisma, Redis, RabbitMQ, pnpm + Turborepo monorepo, Docker Compose locally, Kubernetes on AWS.

---

## 2. Users and roles

| Role | Description |
|---|---|
| **Guest** | Unauthenticated customer who books with email and phone. |
| **Customer** | Registered user (email and password). |
| **Operator** | Staff of a provider (cinema, bus company, railway). Scoped to their own tenant. |
| **Support Agent** | Platform staff who look up bookings and issue refunds. Cannot edit inventory. |
| **Admin** | Platform staff with full control, including users, operators and policies. |

### 2.1 Authorization model

**Permission-based RBAC.** Roles are named bundles of fine-grained permissions (e.g. `inventory:create`, `booking:read:any`, `refund:issue`, `refund:approve`, `policy:manage`). The admin can edit which permissions a role holds. A user holds one role; operator users additionally belong to exactly one **tenant (provider)** and every operator query is tenant-scoped.

Indicative permission matrix (the final list is the [permission catalogue](./permissions.md)):

| Capability | Guest | Customer | Operator | Support | Admin |
|---|:-:|:-:|:-:|:-:|:-:|
| Search and book | ✓ | ✓ | | | |
| View/cancel own bookings | via OTP | ✓ | | | |
| Manage own tenant inventory and schedules | | | ✓ | | ✓ |
| View bookings for own tenant | | | ✓ | | ✓ |
| Cancel a show or trip (triggers refunds) | | | ✓ (own) | | ✓ |
| View any booking | | | | ✓ | ✓ |
| Issue goodwill refund (up to cap) | | | | ✓ | ✓ |
| Approve refund above cap | | | | | ✓ |
| Manage operators, users, roles, policies | | | | | ✓ |

---

## 3. Scope

### 3.1 MVP (all three verticals, both portals)

- Customer web app: search, browse, seat selection, checkout, my bookings, tickets.
- Admin and operator web app.
- Guest and registered checkout.
- Stripe test-mode payments and refunds.
- Notification service: email, SMS, web push, reminders.
- Movies, buses and trains, including train segment booking.
- Multi-tenant operators with per-operator cancellation policy override.
- Postgres-based search and filters.

### 3.2 Later

See section 1.2.

---

## 4. Core user journeys

### 4.1 Discovery

- **Movies:** city → movie → cinema and show time → seat map.
- **Buses:** from / to / date → list of trips → seat map (with boarding and dropping point).
- **Trains:** from / to / date → list of trains → class → berth map.
- A **cross-vertical search box** plus a filtered listing per vertical (date, price, operator, class, etc.). Implemented with Postgres filters. A dedicated search engine is a later phase.

### 4.2 Booking (customer or guest)

1. Select seats or berths (up to 6).
2. System places a **10-minute hold**; a countdown is shown.
3. Enter passenger or contact details. Guests provide email and phone.
4. Pay with Stripe Elements (card data never touches TicketNest servers).
5. Booking is confirmed; e-ticket with QR code is available and emailed. SMS and push notifications are sent.
6. Reminders are sent before the show or departure.

### 4.3 Guest booking management

A guest finds a booking by **booking reference + email OTP**, then can view, download the ticket and cancel. If the guest later registers with the same email and **verifies it**, past bookings attach to the new account.

### 4.4 Cancellation

Customer (or guest via OTP) cancels from "My bookings"; the refund amount is shown before confirming; the refund is issued via Stripe and tracked. Support agents can cancel and refund on a customer's behalf.

### 4.5 Operator journeys

- Create venues, screens (with seat layouts), bus layouts, routes, stations.
- Publish schedules (shows, bus trips, train runs) and set prices.
- View bookings for their tenant.
- Cancel a show or trip, which triggers automatic full refunds and notifications to every affected customer.
- Optionally override the cancellation policy for their tenant **[Assumption: the admin sets this; operators request]**.

### 4.6 Admin and support journeys

- Admin: onboard operators, manage users and roles, manage platform policies and fees, view all bookings, approve over-cap refunds.
- Support: look up bookings by reference, email or phone; cancel on behalf; issue goodwill refunds.

---

## 5. Functional requirements

### 5.1 Identity and access

- Email + password registration and login. Email verification **[Assumption: required for conversion of guest bookings, optional otherwise]**.
- Short-lived JWT access tokens with refresh token rotation.
- OTP via email for guest booking lookup, rate limited.
- Permission-based RBAC (section 2.1).

### 5.2 Catalog and inventory

- **Movies:** Movie, Cinema (venue), Screen (each with its own seat layout), Show (movie × screen × start time × price).
- **Buses:** Bus layout (seater and sleeper, lower and upper deck, seats flagged **women-reserved**), Route with ordered stops, Trip (route × departure × bus), boarding and dropping points per trip.
- **Trains:** Train, ordered Stations, Classes (e.g. Sleeper, 3AC), berth layout per coach and class, Run (train × date).
- Pricing: one price per show, per bus trip (per seat type), and per train class and segment. **No seat-tier pricing in MVP.**
- All timestamps stored in UTC, displayed in the venue or station's local timezone.

### 5.3 Seat selection and holds

| Rule | Value |
|---|---|
| Hold duration | 10 minutes from seat selection, fixed (no extension) |
| Max seats per booking | 6 (movies, buses, trains) |
| Hold storage | Redis with TTL; released on expiry or abandonment |
| Guest holds | Tied to a session id |
| Sales cutoff | Movies: 15 min before start. Buses: 1 h before departure. Trains: 4 h before departure |

**Hard guarantee:** a seat cannot be sold twice. Redis holds provide fast contention handling; the final confirmation is enforced in PostgreSQL with a uniqueness constraint (or equivalent) so correctness never depends on Redis alone.

**Per vertical:**

- **Movies:** multiple screens per cinema, each with its own layout. No accessible-seat tagging or orphan-seat rule in MVP.
- **Buses:** seater and sleeper layouts across lower and upper decks. Women-reserved seats can only be booked with a female passenger. Passengers choose boarding and dropping points.
- **Trains:** customer picks a specific berth. **Segment booking**: a berth is tracked per segment between consecutive stations, so it is available again once a passenger alights at an intermediate stop. A booking from A to D blocks the berth for segments A–B, B–C, C–D only. No waitlist or RAC.

**Passenger details:** name, age and gender per seat for buses and trains. Movies need only contact details.

### 5.4 Booking and payment

- Booking states: `HELD → PENDING_PAYMENT → CONFIRMED → CANCELLED / EXPIRED / REFUND_PENDING / REFUNDED` **[state set to be finalized in design]**.
- Stripe test mode, PaymentIntents, webhook-driven confirmation, idempotency keys on all payment and refund calls.
- Currency **USD**.
- **Convenience fee:** 3% of ticket subtotal, configurable by admin **[Assumption]**.
- **Payment edge cases:**
  - Payment succeeds but the hold already expired and the seats are gone → automatic full refund.
  - Payment fails → the hold is released at expiry.
- Duplicate webhook delivery and retries must be harmless.

### 5.5 Cancellation and refunds

**Default refund policy** (platform-wide; an operator may have an override set by an admin) **[Assumption: values proposed in the interview, not yet confirmed]**:

| Vertical | Time before start | Refund |
|---|---|---|
| Movies | 4 h or more | 100% |
| Movies | 1 h to 4 h | 50% |
| Movies | under 1 h | 0% |
| Buses | 24 h or more | 90% |
| Buses | 12 h to 24 h | 75% |
| Buses | 4 h to 12 h | 50% |
| Buses | under 4 h | 0% |
| Trains | 48 h or more | 100% minus flat fee per passenger |
| Trains | 12 h to 48 h | 75% |
| Trains | 4 h to 12 h | 50% |
| Trains | under 4 h | 0% |

Rules:

- **Convenience fee is non-refundable** on a customer cancellation, and **fully refunded** on operator cancellation or payment edge cases **[Assumption]**.
- **Partial cancellation:** allowed for buses and trains (per passenger); movies are all-or-nothing.
- **Operator-initiated cancellation:** 100% refund including fees, automatic, with notifications to all affected customers.
- **No-show:** no refund.
- **Support agents** may issue goodwill refunds that override the policy, up to a per-booking cap (default $25). Above the cap requires admin approval. Every refund is audit-logged **[Assumption: cap value]**.
- **Refund mechanics:** back to the original payment method via Stripe, asynchronous, with status `PENDING → SUCCEEDED / FAILED`. The UI and emails show an expected timeline (e.g. "5–7 business days").
- No rescheduling; customers cancel and rebook.

### 5.6 Notifications (separate service)

Channels: **email, SMS, web push**. Triggered by domain events from RabbitMQ.

| Event | Notification |
|---|---|
| Booking confirmed | Email (with ticket), SMS, push |
| Booking cancelled / refund issued / refund failed | Email, SMS, push |
| Show or trip cancelled by operator | Email, SMS, push |
| Reminder | Scheduled before event or departure **[Assumption: 24 h and 2 h before]** |
| Guest OTP | Email |

Requirements: templates, per-user channel preferences **[Assumption]**, delivery status tracking, retries with dead-letter queue, idempotent delivery. SMS provider is TBD (e.g. Twilio, MSG91). "Push" means **web push** since there is no mobile app.

### 5.7 Tickets

- E-ticket per booking with QR code, downloadable (PDF) and emailed.
- QR encodes a signed booking token. A validation endpoint for operators to scan tickets is a later item **[Assumption]**.

### 5.8 Admin and operator portal

One Next.js app with route groups. Operator views are tenant-scoped; admin sees everything. Screens: inventory management, schedules, bookings, cancel show/trip, user and role management, policy and fee configuration, refund approval queue.

---

## 6. Non-functional requirements

| Area | Requirement |
|---|---|
| **Scale** | Designed for 500 concurrent users and ~20 bookings/s peak with heavy same-seat contention; verified with k6. |
| **Performance** | p95 under 300 ms for reads, under 500 ms for seat hold. |
| **Availability** | 99.5% target (no formal SLA). |
| **Consistency** | No double-booking (hard guarantee). Idempotent payments and refunds. Eventual consistency between services via RabbitMQ (outbox pattern recommended). |
| **Security** | Short-lived JWT + refresh rotation; Argon2 password hashing; rate limiting with extra OTP throttling; Stripe Elements (no card data on our servers); audit logs for admin and refund actions; OWASP Top 10 practices. |
| **Privacy** | Account deletion and data export are out of scope. |
| **Observability** | Standard: structured logs, correlation IDs across services, Prometheus/Grafana metrics, health and readiness endpoints. |
| **Testing** | Vitest (unit); Testcontainers integration tests with Postgres, Redis, RabbitMQ; Playwright end-to-end tests of booking flows; k6 seat-contention load test. |
| **Delivery** | Docker Compose for local; GitHub Actions CI; deployed on **AWS / Kubernetes**. |
| **Timezones** | Store UTC; display in venue or station local time. |
| **Accessibility** | WCAG 2.1 AA. |
| **Browsers** | Latest two versions of major browsers; responsive mobile web. |

---

## 7. Proposed architecture (for review)

**[Proposed — not decided in the interview.]** Each service owns its database; services communicate via REST for queries and RabbitMQ events for state changes.

| Service | Responsibility |
|---|---|
| **API gateway / BFF** | Single entry point, auth verification, rate limiting. |
| **Identity service** | Users, roles, permissions, tokens, OTP. |
| **Catalog service** | Operators/tenants, venues, routes, schedules, layouts, pricing, search. |
| **Inventory/Booking service** | Seat availability, Redis holds, bookings, segment logic, cancellation policy evaluation. |
| **Payment service** | Stripe PaymentIntents, webhooks, refunds. |
| **Notification service** | Email, SMS, web push, reminders, templates. |
| **Apps** | `web` (customers) and `console` (admin and operator), both Next.js. |

Booking saga: `hold → payment → confirm`, with compensation (release seats, refund) on failure. Events carry idempotency keys. A transactional outbox publishes events reliably.

Monorepo layout (pnpm + Turborepo): `apps/web`, `apps/console`, `services/*`, `packages/*` (shared types, event contracts, config, UI).

---

## 8. Core data entities (indicative)

User, Role, Permission, Operator (tenant), Cinema, Screen, Movie, Show, BusLayout, Route, Stop, Trip, Train, Station, Class, Coach, Run, Seat/Berth, SegmentAvailability, Hold, Booking, BookingItem (passenger), Payment, Refund, CancellationPolicy, Fee, Notification, NotificationPreference, AuditLog.

---

## 9. Milestones (suggested)

1. **Foundations:** monorepo, CI, Docker Compose, shared packages, auth and RBAC.
2. **Catalog and operator console:** tenants, inventory, schedules.
3. **Movies end-to-end:** seat map, holds, booking, Stripe, ticket.
4. **Notification service:** email, SMS, web push, reminders.
5. **Cancellation and refunds:** policies, partial cancel, operator cancel, support flows.
6. **Buses:** layouts, women-reserved seats, boarding points.
7. **Trains:** classes, berths, segment booking.
8. **Hardening:** observability, load testing, security review.
9. **Kubernetes on AWS:** deployment, config, secrets.

All three verticals are in the MVP, so ordering the build movies → buses → trains is a build sequence only, not a scope cut.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Scope is large for a solo developer. | Build vertically in the order above; keep services thin initially. |
| Train segment booking is complex. | Build it last on top of a proven hold/booking core; spike the data model early. |
| Distributed consistency bugs. | Outbox, idempotency keys, saga tests with Testcontainers. |
| Stripe account region and USD support for test accounts. | Confirm account region early (see open questions). |
| Kubernetes on AWS adds cost and time. | Containerize and Compose first; deploy last; use a small cluster. |

---

## 11. Success criteria

- Zero double-bookings in the k6 contention test at target load.
- Every state of the booking, payment and refund lifecycle covered by an automated test.
- A full booking and cancellation flow works for each vertical, as a guest and as a registered user.
- Operator cancellation refunds every affected booking and notifies every customer.
- Deployed to AWS/Kubernetes with dashboards for the standard metrics.

---

## 12. Out of scope

See section 1.2.

---

## 13. Glossary

**Hold:** temporary reservation of seats during checkout. **Segment:** the stretch between two consecutive stations. **Tenant:** an operator's isolated data scope. **Outbox:** pattern for reliably publishing events with DB writes.

---

## 14. Assumptions and open questions

**Assumptions to confirm**

1. Currency is USD (confirmed by the owner).
2. Convenience fee is 3% of the ticket subtotal, non-refundable on customer cancellation.
3. The refund tier table in section 5.5 is accepted as proposed (including the flat train per-passenger fee amount, which is not yet set).
4. Refund policies are platform defaults with an admin-set per-operator override.
5. Support agent goodwill refund cap is $25 per booking; above it needs admin approval.
6. Reminders go out 24 h and 2 h before the event or departure.
7. "Push" means web push.
8. Per-user notification channel preferences exist.
9. Guest bookings convert to an account only after email verification.
10. Women-reserved bus seats require a female passenger, enforced at booking.
11. QR scanning/validation by operators is a later item.
12. Operators are onboarded by an admin, not by self-signup.

**Open questions**

1. Which SMS provider (Twilio, MSG91, other)?
2. Does your Stripe account support USD charges (it does in test mode)? Confirm the account region early.
3. Is GST or tax display needed?
4. How should operators build seat layouts: a visual editor, or JSON/template upload?
5. How are train stations ordered and priced per segment (fare table vs. distance-based)?
6. Should stale `HELD` seats be cleaned up by TTL events or a sweeper job?
