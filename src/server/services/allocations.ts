import { Prisma } from '@prisma/client'
import type { Allocation } from '@/domain/allocation'

/**
 * The allocation engine deliberately lives outside `payments.ts`.
 *
 * `payments.ts` pulls in `@/server/session`, which imports `next/navigation`
 * and `@/server/auth` — and `@/server/auth` calls `NextAuth({...})` at module
 * top level. `prisma/seed.ts` needs the exact same write-then-recompute logic
 * the service uses, but `npm run db:seed` runs in a bare `tsx` process where
 * booting the whole auth stack is both pointless and fragile. Keeping these
 * two functions in a module whose only imports are `@prisma/client` and pure
 * domain types means the seed depends on the money rules and nothing else.
 *
 * Nothing in here reads a session or an actor: authorization and org scoping
 * are the caller's job, and `payments.ts` does them before it ever gets here.
 */

/**
 * The minimum an entry has to expose for its total to be recomputed. Callers
 * already hold `amountDueMinor` (it comes back with the entries they fetched
 * to compute the allocation in the first place), so it is passed in rather
 * than re-read per entry.
 */
export interface EntryDue {
  id: string
  amountDueMinor: bigint
}

/**
 * The parameter stays `Prisma.TransactionClient` only — never widened to
 * accept the plain client — so these functions' contract is unconditionally
 * "runs inside a transaction". The seed satisfies that by opening its own
 * `prisma.$transaction` around each call rather than these helpers loosening
 * their guarantee to suit a caller that doesn't itself need one.
 */
type Tx = Prisma.TransactionClient

/**
 * Recomputes each listed entry's `amountPaidMinor` from its surviving
 * allocation rows — recomputed, never incremented, so a retry, a void, or a
 * concurrent write cannot leave the cached total disagreeing with the audit
 * trail. Returns the ids of the entries that are fully settled afterwards.
 *
 * `paidAtWhenSettled` is the only thing that differs between the two callers:
 *
 *   - `recordPayment` passes the payment's `receivedAt`, stamping the entries
 *     this payment just settled.
 *   - `voidPayment` passes `undefined`, which means "leave paidAt unchanged".
 *     That is intentional, not a typo: an entry that is STILL fully covered
 *     after a void (some other payment already covered it) keeps its original
 *     settlement date rather than being restamped by a void it wasn't even
 *     part of settling. Only an entry that drops below fully-paid has its
 *     paidAt cleared — and that clearing happens for both callers alike.
 *
 * Query cost is constant — four statements at most, regardless of how many
 * entries are being recomputed. That matters: a single payment can cascade
 * across every installment of a 36-month schedule, and a per-entry round trip
 * would blow through Prisma's 5s interactive-transaction default long before
 * the platform's own function timeout could even be reached.
 */
export async function recomputeEntries(
  tx: Tx,
  entries: readonly EntryDue[],
  paidAtWhenSettled: Date | undefined
): Promise<string[]> {
  if (entries.length === 0) return []

  const entryIds = entries.map((entry) => entry.id)

  // One read for every entry at once. `payment: { voidedAt: null }` is the
  // whole point of recomputing: voided payments keep their rows for audit but
  // must not count toward any balance.
  const rows = await tx.paymentAllocation.findMany({
    where: { scheduleEntryId: { in: entryIds }, payment: { voidedAt: null } },
    select: { scheduleEntryId: true, amountMinor: true }
  })

  const totals = new Map<string, bigint>()
  for (const row of rows) {
    totals.set(row.scheduleEntryId, (totals.get(row.scheduleEntryId) ?? 0n) + row.amountMinor)
  }

  const settled: string[] = []
  const unsettled: string[] = []
  const tuples: Prisma.Sql[] = []

  for (const entry of entries) {
    const total = totals.get(entry.id) ?? 0n
    // Amounts travel as text and are cast back to bigint in SQL. Postgres
    // bigint is exact and so is JS BigInt; the string in between is just a
    // lossless transport, which no float-based binding could promise.
    tuples.push(Prisma.sql`(${entry.id}::text, ${total.toString()}::text)`)
    if (total >= entry.amountDueMinor) settled.push(entry.id)
    else unsettled.push(entry.id)
  }

  // A per-row value cannot be expressed with `updateMany`, and one `update`
  // per entry is the N+1 this module exists to avoid — so the totals go in as
  // a single UPDATE ... FROM (VALUES ...) statement.
  await tx.$executeRaw`
    UPDATE "ScheduleEntry" AS e
    SET "amountPaidMinor" = v.paid::bigint
    FROM (VALUES ${Prisma.join(tuples)}) AS v(id, paid)
    WHERE e.id = v.id
  `

  // paidAt is a single shared value per bucket, so it batches natively and
  // stays in Prisma's hands rather than being hand-serialised into SQL.
  if (settled.length > 0 && paidAtWhenSettled !== undefined) {
    await tx.scheduleEntry.updateMany({
      where: { id: { in: settled } },
      data: { paidAt: paidAtWhenSettled }
    })
  }
  if (unsettled.length > 0) {
    await tx.scheduleEntry.updateMany({
      where: { id: { in: unsettled } },
      data: { paidAt: null }
    })
  }

  return settled
}

/**
 * Writes a payment's allocations and recomputes every entry it touched.
 *
 * `entries` is the schedule the allocation was computed against — the caller
 * already fetched it, so the due amounts come along for free instead of
 * costing a `findUniqueOrThrow` per allocation.
 *
 * Total cost is five statements at most, whether the payment lands on one
 * entry or on all thirty-six.
 */
export async function applyAllocations(
  tx: Tx,
  paymentId: string,
  allocations: readonly Allocation[],
  receivedAt: Date,
  entries: readonly EntryDue[]
): Promise<string[]> {
  if (allocations.length === 0) return []

  await tx.paymentAllocation.createMany({
    data: allocations.map((allocation) => ({
      paymentId,
      scheduleEntryId: allocation.entryId,
      amountMinor: allocation.amountMinor
    }))
  })

  const dueByEntryId = new Map(entries.map((entry) => [entry.id, entry.amountDueMinor]))
  const touched = allocations.map((allocation) => {
    const amountDueMinor = dueByEntryId.get(allocation.entryId)
    if (amountDueMinor === undefined) {
      // Allocating to an entry the caller never loaded means the allocation
      // was computed against a different schedule than the one being written.
      // Failing loudly beats silently recomputing against a guessed due.
      throw new Error(
        `applyAllocations: no amountDueMinor supplied for schedule entry ${allocation.entryId}`
      )
    }
    return { id: allocation.entryId, amountDueMinor }
  })

  return recomputeEntries(tx, touched, receivedAt)
}
