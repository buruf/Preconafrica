# Preconstruction Unit Sales Platform — Design

**Date:** 2026-08-09
**Status:** Approved for planning
**Amended:** 2026-08-10 — deposits are receivable, installment plans carry a
percentage charge, and staff sell rather than buyers self-serving. The affected
sections are amended in place rather than appended to, so this document keeps
describing the system that exists.

## Purpose

A multi-tenant web platform where African property developers sell preconstruction
units and manage installment payments. A developer defines a building and its
units, staff sell a unit to a buyer under either full payment or an installment
plan, and staff record payments as money arrives offline. The system generates the
full payment schedule upfront, issues PDF invoices, receipts and statements, and
emails reminders before and after each due date. Buyers sign in to watch their own
contract; they do not transact.

Buyers are assumed to be on phones with weak connections. That assumption drives
real decisions throughout this document, not just CSS.

## Scope

In scope: project and unit setup, buyer registration by staff, plan selection,
schedule generation, manual payment recording, PDF documents, email reminders via
cron, developer arrears reporting, multi-currency, three roles, and a schema that
accepts SMS reminders later without a migration.

Out of scope for this build: online payment gateways, native mobile apps, a
public marketing site, offline/PWA support, actual SMS delivery, and buyer
self-service purchasing.

## Decisions

These were settled during brainstorming and are not open questions.

| Decision | Choice |
|---|---|
| Delivery | One mobile-first responsive Next.js 14 website. No native app, no PWA. |
| Tenancy | Multi-tenant SaaS. `Organization` owns everything; all queries scoped by `orgId`. |
| Auth | Auth.js credentials provider, bcrypt passwords, JWT session. Same mechanism for all three roles. |
| Payments | Manual recording only. No gateway, no webhooks, no card data. |
| Buyer flow | Staff sell; buyers view. An agent or admin picks a unit from inventory, registers or selects the buyer, prices the plan and confirms — buyer self-service purchasing (the public `/buy` flow) was removed on 2026-08-10. Buyer dashboards are read-only. |
| Deposits | Receivable, not presumed paid. The deposit is schedule entry `sequence 0`, due on the signing day, and settles only when a `Payment` is allocated against it. |
| Installment charge | A percentage markup in basis points on the financed amount. `Project.installmentMarkupBps` is the default; `Sale.markupBps` snapshots what was agreed. Staff-only per-sale override at signing; never a field a buyer can submit. |
| Rounding | Monthly amount rounds down to the currency's minor unit; the final installment absorbs the remainder. |
| Due dates | Monthly anniversary of the signing date, clamped to the last valid day of short months. |
| Allocation | Oldest unpaid entry first; excess cascades forward automatically. |
| Installment status | Derived at read time, never stored. |

## Architecture

A layered monolith with a pure domain core.

```
src/domain/      pure functions, zero I/O, no Prisma import
src/server/      repositories, services, auth, mailer, pdf
src/app/         App Router pages, Server Components, Server Actions
src/app/api/     route handlers (cron, PDF streaming) only
```

The rule that matters: **`src/domain/` imports nothing from `src/server/` or
Prisma.** Amortization, schedule generation, payment allocation, status
derivation, date clamping, currency rounding and unit-name patterns are all
pure. This is what makes them testable in milliseconds without a database, and
it is the reason this layering was chosen over putting Prisma calls inline in
Server Actions.

Rendering is Server Components by default. Mutations are Server Actions. There
is no client-side data fetching on any primary view — a buyer on a weak
connection gets HTML on first paint rather than a JS bundle that then requests
JSON. Client components are permitted only where interaction genuinely requires
them (the schedule preview toggle, the payment form).

## Money and currency

All monetary amounts are stored as `BigInt` minor units in Postgres `int8`.

`Int32` is insufficient: a ₦250,000,000 unit is 25,000,000,000 kobo, well past
the 2,147,483,647 limit. Floating point is never used for money anywhere in the
system, including in the PDF layer.

`Project.currency` holds an ISO-4217 code. A static table in
`src/domain/currency.ts` maps code to exponent, because the two-decimal
assumption is wrong for several African currencies:

| Exponent 2 | NGN, KES, GHS, ZAR, EGP, MAD, TZS |
| Exponent 0 | RWF, UGX, XOF, XAF, DJF |

All rounding uses the project's exponent. Display goes through
`Intl.NumberFormat` with the project currency. USD appears only as one more row
in that table and is never a default, a fallback, or a hardcoded literal.

BigInt is not serializable across the RSC boundary, so amounts are formatted to
strings on the server before being passed to any client component.

## Data model

```
Organization
  └─ User            (ADMIN | AGENT | BUYER)
  └─ Project         name, location, currency, expectedCompletion,
                     floors, unitsPerFloor, namingPattern,
                     reminderDaysBefore, overdueNoticeDaysAfter,
                     reminderChannels[]
       └─ Unit       name, floor, bedrooms, sizeSqm, priceMinor, status
            └─ Sale  ── Buyer
                 ├─ ScheduleEntry
                 │     └─ PaymentAllocation ── Payment
                 └─ Document  (INVOICE | RECEIPT | STATEMENT)
  └─ NotificationLog
```

### Snapshotting

`Sale` copies `priceMinor` and `currency` from the unit at signing. If the
developer reprices a unit later, existing contracts must not change. The unit's
current price is for new sales only.

### Payments and allocation

`Payment` is an immutable record: amount, date received, method, reference
number, free-text note, and the user who recorded it. It is never edited.

A mistaken payment is **voided**, not deleted or amended: `voidedAt`,
`voidedByUserId` and `voidReason` are set, and its allocations are removed inside
the same transaction that recomputes the affected entries' `amountPaidMinor`. A
voided payment stays visible in history and its receipt is marked void. Only
ADMIN may void.

`PaymentAllocation` joins a payment to a schedule entry with an amount. This is
what makes cascading overflow auditable — one ₦900,000 payment settling three
₦300,000 installments produces three allocation rows, not an opaque balance
adjustment. `ScheduleEntry.amountPaidMinor` is the sum of its allocations and is
maintained transactionally.

### Derived status

`deriveStatus(entry, asOf)` returns PAID, PARTIAL, OVERDUE or PENDING. It is a
pure function and is never persisted.

Storing status would be wrong the moment a cron run is missed or delayed: an
entry becomes overdue because a day passed, not because a job ran. Deriving it
means the arrears report is a plain indexed query —
`WHERE dueDate < now AND amountPaidMinor < amountDueMinor` — and can never drift
from reality.

`paidAt` is stored, because "when did this become fully settled" is a fact about
the past rather than a function of today.

## Amortization and schedule generation

`generateSchedule({ planType, priceMinor, depositMinor, markupBps, months, signedAt })`
returns the complete array of entries. Pure, deterministic, no clock access —
`signedAt` is always passed in.

Rules:

1. Financed amount is `priceMinor − depositMinor`.
2. The installment charge is `floor(financed × markupBps / 10000)`, and the
   amount the months amortize is `charged = financed + markup`. The charge is
   levied on what is actually financed, so a bigger deposit genuinely costs the
   buyer less and a full-payment buyer pays no charge at all. `markupBps` is
   required, not defaulted: every caller lives in this repository, and a
   forgotten charge must be a compile error rather than a free plan.
3. A deposit becomes its own entry at `sequence 0`, due on the signing day, for
   `depositMinor`. It is never marked up. A zero deposit produces no entry 0, so
   a no-deposit plan is unchanged. Zero rather than one so the months keep the
   numbers the contract uses — the first month is still installment 1 of 36, not
   2 of 37.
4. Base monthly amount is `floor(charged / months)` in minor units.
5. Entries 1 through n−1 carry the base amount.
6. Entry n carries `charged − base × (months − 1)`, absorbing the remainder.
7. Entry k is due on the k-th monthly anniversary of `signedAt`.
8. Day-of-month clamps to the last valid day when the target month is shorter.
   Signing on Jan 31 yields Feb 28 (or Feb 29 in a leap year), then Mar 31 — the
   original day is preserved and reapplied each month rather than degrading.
9. A date never silently rolls forward into the following month.

Invariant, asserted in tests: the sum of every entry equals `priceMinor + markup`
exactly, for every currency exponent, term, deposit and rate. That is the whole
point of putting the deposit in the schedule — the schedule is now the complete
statement of what the buyer owes, so `summariseSale` reads total-owed, paid-to-date
and balance off the entries and nothing else. Neither `priceMinor` nor
`depositMinor` appears in that arithmetic: an installment buyer owes price plus
charge, so subtracting from the price alone would under-report the balance by the
entire fee.

Basis points, not a percentage float, and the whole calculation stays in `BigInt`:
10% is the integer `1000`, so no rounding error can enter through a binary
fraction that cannot represent 0.1. Staff type a percentage and `percentToBps`
converts it exactly, rejecting a third decimal place rather than silently rounding
it. Division floors, so the charge rounds in the buyer's favour by at most one
minor unit.

Rejected inputs: deposit greater than or equal to price, `months < 1`,
non-integer months, negative amounts, `markupBps` outside 0–10000 or non-integer,
and a full-payment plan carrying either a deposit or a markup.

### Deposits are receivable, not presumed

The first cut treated the deposit as money already in hand: it never appeared in
the schedule, and `summariseSale` added `depositMinor` straight into paid-to-date.
That is a hole, not a shortcut. `depositMinor` records an agreed term, and while
the buyer could name it themselves a buyer could declare a 90% deposit, pay
nothing, and read 90% paid on every dashboard, statement and receipt — with no
`Payment` row anywhere to justify it. The developer's own arrears report would
show them as current.

Making the deposit entry 0 closes it with no special cases. The deposit reaches
paid-to-date the way every other amount does, by being a schedule entry that a
`Payment` was allocated against. `allocatePayment` already orders by sequence, so
the first money in settles the deposit first. `deriveStatus` turns it OVERDUE the
day after signing like any other entry, so a buyer who signed and never paid is
in arrears tomorrow — which is exactly the truth. The reminder sweep sees one
more unsettled entry and chases it. The only code that needed to know is display:
`scheduleEntryLabel` renders sequence 0 as "Deposit", because "0." above the
signing-day amount reads like a bug.

### Full payment produces a schedule too

A full-payment sale generates **one** schedule entry: sequence 1, due on the
signing date, for the full snapshotted price. It does not produce an empty
schedule.

This matters because every payment allocates against a schedule entry. An empty
schedule would leave a full-payment buyer with nothing to allocate against, no
invoice to issue, and no path through the arrears report if they never pay. One
entry keeps a single code path for allocation, documents, reminders and arrears
across both plan types. Deposit is not applicable to full payment and is stored
as zero.

## Payment allocation

`allocatePayment(entries, amountMinor)` returns the allocation set. Pure.

Applies to the oldest entry that is not fully paid, fills it, then cascades any
remainder into the next entry, repeating until the payment is exhausted or every
entry is settled. A payment smaller than the outstanding amount on its target
leaves that entry PARTIAL. Any surplus beyond the final entry is returned as an
explicit overpayment figure rather than being silently discarded.

## Unit generation

`generateUnitNames({ floors, unitsPerFloor, pattern, startFloor })` is pure and
expands a token pattern:

- `{floor}{index:02}` → 401, 402, 403
- `{floor}{letter}` → 4A, 4B, 4C

Past 26 units on a floor, `{letter}` continues spreadsheet-style: Z, then AA, AB.
It does not wrap and silently produce a duplicate name.

Every generated name is editable per unit before and after creation. Names are
unique per project, enforced by a database constraint, so a manual override
cannot collide with a generated name.

## Reminders

One Vercel cron job hits `/api/cron/reminders` daily.

Authentication is **fail-closed**: a missing or mismatched `CRON_SECRET` returns
401. An absent secret must never be treated as an authorised local run.

Per project, it sends a pre-due reminder at `reminderDaysBefore` (default 7,
configurable per project) and an overdue notice at `overdueNoticeDaysAfter`
(default 3). Delivery is via Resend.

Idempotency is enforced by a unique index on
`NotificationLog(scheduleEntryId, templateKey, channel)`. A retried or
double-scheduled run cannot send a buyer the same notice twice.

## SMS readiness

The requirement is that adding SMS later requires no migration. Present from day
one:

- `ReminderChannel` enum containing **both** `EMAIL` and `SMS`.
- `Project.reminderChannels ReminderChannel[]`, seeded `[EMAIL]`.
- `Buyer.phone` stored E.164 and validated as such at registration.
- `Buyer.smsOptIn Boolean @default(true)`.
- `NotificationLog` with `channel`, `destination`, `templateKey`, `status`,
  `providerMessageId`, `error`, `sentAt`. `destination` holds an email address
  or an E.164 number depending on channel.

Adding Africa's Talking or Twilio is then one adapter implementing the sender
interface, plus a config flag. No schema change.

## Buyer flow

Staff sell; buyers view.

The sale is created from inventory: an agent or admin opens a project, picks an
available unit, and works through one form — the buyer (an existing buyer of the
organisation from a server-rendered select, or a new one registered inline), the
plan, the deposit, the term, and the installment charge prefilled from the project
default. A confirm step prices the whole schedule with the same pure
`previewSchedule` the write then persists, showing the deposit row, the charge on
its own line and the total owed, before anything is committed. Registration
therefore happens *through staff*: `registerBuyer` is called on the staff path
with a temporary password the buyer changes, and there is no public sign-up.

The buyer dashboard is read-only, and deliberately so. It shows their schedule,
paid to date, total owed, balance, next due date, payment history and their own
documents. Every query is scoped by the buyer id on the session. A buyer cannot
create a sale, cannot record a payment, and cannot set or waive the installment
charge — that last one is why `markupBps` is absent from the buyer-facing plan
schema entirely and is discarded rather than validated for a BUYER actor. The
public `/buy` flow that let a buyer commit themselves to a unit was removed on
2026-08-10; nothing about the read-only dashboard changed with it.

This matches how these sales actually close. The money arrives offline — bank
transfer, mobile money, cash at the office — and an agent is already in the loop
for every contract. A self-service purchase path added a surface where a buyer
could set their own terms, and the deposit hole above is what that looked like in
practice.

## Documents

`@react-pdf/renderer` on the Node runtime. Headless Chrome is explicitly
rejected — it is slow and fragile on Vercel for this workload.

Three document types: an invoice per due installment, a receipt per payment
received, and a statement of the full schedule at signing.

Invoices and statements are generated on demand when first requested — by the
buyer from their dashboard, by staff from the sale view, or by the reminder email
linking to one — and the `Document` row is created at that moment. Receipts are
created when the payment is recorded. Nothing is pre-generated in bulk.

Each document gets a stable sequential number per organisation, stored in a
`Document` row. The PDF bytes are regenerated on demand rather than stored: no
blob storage to configure, and re-downloads are byte-identical because payments
are immutable and schedules are frozen at signing.

Documents stay small — no large images beyond an optional org logo — because the
people downloading them are on weak connections.

## Concurrency

Two agents selling the same unit is the realistic race.

Reservation runs inside a transaction as a conditional update:
`updateMany({ where: { id, status: AVAILABLE }, data: { status: RESERVED } })`.
A zero row count means someone else took it and surfaces as a clean message, not
a double-sale. Payment recording similarly recomputes `amountPaidMinor` from
allocations inside the same transaction that writes them.

## Roles and authorisation

| Role | Capability |
|---|---|
| ADMIN | Full access within their organisation: project and unit setup, all sales, all payments, arrears report, agent management. |
| AGENT | Create sales, register buyers, record payments, view inventory. No project setup, no org settings. |
| BUYER | Own sale only: schedule, paid to date, balance, next due date, payment history, own documents. |

Every query is scoped by `orgId` derived from the session, never from a request
parameter. Buyer-scoped queries additionally filter by the session's buyer id —
authorisation is enforced in the data layer, not only in the UI, so a guessed URL
returns nothing.

## Testing

Vitest. The pure domain tests require no database and are the primary safety net.

Schedule generation and amortization:
- Even division across the term.
- Remainder landing entirely on the final installment.
- Zero-decimal currency (RWF) and two-decimal currency (NGN).
- Sum of installments equals financed amount exactly — asserted for many
  price/deposit/term combinations.
- Default 36-month term, and non-default terms.
- Full payment → exactly one entry, due at signing, for the full price.
- Deposit greater than or equal to price under an installment plan → rejected.
- `months < 1` → rejected.

Date clamping:
- Jan 31 signing → Feb 28 in a common year.
- Jan 31 signing → Feb 29 in a leap year.
- Feb clamp followed by Mar 31, confirming the original day is restored.
- A 36-month schedule crossing three year boundaries.

Allocation:
- Exact payment settles one entry.
- Partial payment leaves the entry PARTIAL.
- Overpayment cascades across three entries.
- Payment exceeding the total outstanding returns an explicit overpayment.

Status derivation:
- Each of PAID, PARTIAL, OVERDUE, PENDING at a fixed `asOf` date.
- An unpaid entry due today is not yet overdue.

Unit names:
- `401/402` numeric pattern.
- `4A/4B` letter pattern.
- More than 26 units on a floor under the letter pattern.

## Seed data

One organisation, "Sunrise Developments", with two projects in different
currencies to prove nothing is hardcoded to USD: a Lagos tower priced in NGN and
a Nairobi block priced in KES. Roughly four floors of six units each, using both
naming patterns. The Lagos project charges nothing for paying over time and the
Nairobi one charges 10%, so both configurations are exercised from the first page
load rather than only the interesting one.

Buyers seeded in meaningfully different states: one on a full-payment plan, one
on a 36-month plan fully current, one with a partial payment outstanding, and one
several months in arrears so the arrears report has real content on first run.

Every seeded deposit is a real recorded payment, dated at signing and allocated
through the same functions the service uses. Nothing in the seed is presumed paid:
a state that the running application could not produce has no business being the
first thing a reviewer sees.

Login accounts for all three roles.

## Environment

`DATABASE_URL` (Neon), `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `RESEND_API_KEY`,
`EMAIL_FROM`, `CRON_SECRET`. No secret has a development fallback value.

## Risks

The largest correctness risk is rounding drift across long terms in mixed
currencies; the sum-equals-financed-amount invariant test is the specific control
for it. The largest operational risk is duplicate reminder emails from cron
retries; the `NotificationLog` unique index is the specific control for that.
