/**
 * The `auditEntry` half of a fake transaction client, shared by every service
 * test that now writes one.
 *
 * Two reasons it is one helper rather than a stub per test file. First, every
 * one of those tests already builds a recording `tx`, and the audit write has
 * to be visible from *inside* the transaction — that is the property under test
 * (the entry commits with the money, not after it). Second, a stub per file
 * would drift: half of them would stop asserting the actor and nobody would
 * notice, which is exactly the failure mode the log itself exists to prevent.
 *
 * Not a `.test.ts` file, so vitest's `include` leaves it alone — the same
 * arrangement `pdf-fixtures.ts` uses next door.
 */

export interface RecordedAuditEntry {
  orgId: string
  actorUserId: string
  actorName: string
  actorRole: string
  action: string
  entityType: string
  entityId: string
  entityLabel: string | null
  changes: Array<{ field: string; from: unknown; to: unknown }>
  context: Record<string, unknown>
}

export interface AuditRecorder {
  /** Spread into a fake `tx` to give it an `auditEntry.create`. */
  auditEntry: { create: (args: { data: RecordedAuditEntry }) => Promise<RecordedAuditEntry> }
  /** Every entry written, in the order they were written. */
  entries: RecordedAuditEntry[]
  /** The entries for one action, which is how most assertions read. */
  of: (action: string) => RecordedAuditEntry[]
}

export function auditRecorder(onCreate?: (action: string) => void): AuditRecorder {
  const entries: RecordedAuditEntry[] = []

  return {
    auditEntry: {
      create: async ({ data }) => {
        entries.push(data)
        // Lets a caller that records call *order* (record-payment.test.ts does)
        // see the audit write in the same sequence as everything else, so
        // "inside the transaction, before the commit" stays assertable.
        onCreate?.(data.action)
        return data
      }
    },
    entries,
    of: (action: string) => entries.filter((entry) => entry.action === action)
  }
}
