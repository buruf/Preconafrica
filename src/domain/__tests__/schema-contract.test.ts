import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const schema = readFileSync(
  path.resolve(__dirname, '../../../prisma/schema.prisma'),
  'utf8'
)

// Parsing assumption for every regex below: model bodies contain no nested `{ }`
// (so `model X { ... \n}` can find the closing brace non-greedily), and a
// `@relation(...)` attribute is written on a single line with no nested `(...)`
// of its own. A future multi-line or nested `@relation` would silently fall
// outside these scans rather than erroring, so keep relation attributes flat.

/** Returns every `model <Name> { ... }` block in the schema, as {name, body} pairs. */
function allModels(): { name: string; body: string }[] {
  const models: { name: string; body: string }[] = []
  const modelRegex = /model (\w+) \{([\s\S]*?)\n\}/g
  let match: RegExpExecArray | null
  while ((match = modelRegex.exec(schema)) !== null) {
    models.push({ name: match[1], body: match[2] })
  }
  return models
}

interface RelationInfo {
  /** The field name declaring the relation, e.g. `sale`. */
  field: string
  /** The relation's referenced (target) model type, e.g. `Sale`. */
  target: string
  /** The explicit `onDelete` action, or null if the relation doesn't declare one. */
  onDelete: string | null
}

/**
 * Returns every `@relation(...)` field declared directly in a model body — the
 * side of the relation that holds the foreign key (`fields: [...], references: [...]`).
 * List/back-reference sides (e.g. `sales Sale[]`) carry no `@relation(...)` call in
 * this schema and are correctly skipped.
 */
function relationsIn(body: string): RelationInfo[] {
  const lines =
    body.match(/^\s*\w+\s+\w+\??\s+@relation\([^)]*\)/gm) ?? []
  return lines.map((line) => {
    const declaration = line.match(/^\s*(\w+)\s+(\w+)\??\s+@relation/)
    const onDelete = line.match(/onDelete:\s*(\w+)/)
    return {
      field: declaration ? declaration[1] : '(unknown field)',
      target: declaration ? declaration[2] : '(unknown target)',
      onDelete: onDelete ? onDelete[1] : null,
    }
  })
}

describe('schema contract', () => {
  it('stores every monetary field as BigInt', () => {
    const moneyFields = schema.match(/^\s*\w*[Mm]inor\s+\S+/gm) ?? []
    expect(moneyFields.length).toBeGreaterThan(0)
    for (const field of moneyFields) {
      expect(field, `${field.trim()} must be BigInt`).toMatch(/BigInt/)
    }
  })

  it('stores every basis-point field as Int', () => {
    // The counterpart to the rule above, and the reason it does not catch these:
    // a markup in basis points is a count of hundredths of a percent, bounded at
    // 10000, not an amount of money. It must stay Int so it needs no BigInt
    // ceremony to reach `BigInt(markupBps)` in the schedule math — and so a
    // reviewer is never left wondering which fields are money and which are not.
    const bpsFields = schema.match(/^\s*\w*[Bb]ps\s+\S+/gm) ?? []
    expect(bpsFields.length).toBeGreaterThan(0)
    for (const field of bpsFields) {
      expect(field, `${field.trim()} must be Int`).toMatch(/\bInt\b/)
      expect(field, `${field.trim()} must not be BigInt`).not.toMatch(/BigInt/)
    }
  })

  it('never stores a derived installment status', () => {
    expect(schema).not.toMatch(/model ScheduleEntry[\s\S]*?status\s+InstallmentStatus/)
  })

  it('declares SMS as a reminder channel before it is implemented', () => {
    expect(schema).toMatch(/enum ReminderChannel[\s\S]*?SMS/)
  })

  it('guards reminder idempotency with a unique index', () => {
    expect(schema).toContain('@@unique([scheduleEntryId, templateKey, channel])')
  })

  it('keeps unit names unique within a project', () => {
    expect(schema).toContain('@@unique([projectId, name])')
  })

  it('hardcodes no default currency', () => {
    expect(schema).not.toMatch(/currency\s+String\s+@default/)
  })

  it('keeps every image URL optional, so a missing image is never a broken page', () => {
    // The imagery contract in one rule: a single image is `String?`, a list of
    // them is `String[]`, and neither carries a default. Both halves matter.
    //
    // Nullable/empty is what makes the placeholder the *normal* state rather
    // than an error state — every display site branches on it, and a
    // `String @default("")` would put a falsy non-null value in the column that
    // some of those branches would render as a broken image instead. A list with
    // no default is an empty array on every pre-existing row, which is why
    // `renderImageUrls` could be added to a live, seeded database with no
    // backfill step at all.
    const singles = schema.match(/^\s*\w*(?:[Ii]mageUrl|logoUrl)\s+\S+.*$/gm) ?? []
    expect(singles.length).toBeGreaterThan(0)
    for (const field of singles) {
      expect(field, `${field.trim()} must be an optional String`).toMatch(/\bString\?/)
      expect(field, `${field.trim()} must not carry a default`).not.toMatch(/@default/)
    }

    const lists = schema.match(/^\s*\w*[Ii]mageUrls\s+\S+.*$/gm) ?? []
    expect(lists.length).toBeGreaterThan(0)
    for (const field of lists) {
      expect(field, `${field.trim()} must be a String[]`).toMatch(/\bString\[\]/)
      expect(field, `${field.trim()} must not carry a default`).not.toMatch(/@default/)
    }
  })

  it('never lets a Cascade delete reach Sale, Payment, PaymentAllocation, Document, or ScheduleEntry', () => {
    // These five models hold money movements, the audit trail of money movements, or
    // (ScheduleEntry) the agreed payment schedule itself — amountDueMinor/amountPaidMinor.
    // A relation declared in ANY model that points AT one of these as its @relation
    // target must not be onDelete: Cascade, because that would let deleting the
    // referenced row cascade away — or let the referenced row itself be deleted while
    // still referenced, silently destroying — financially sensitive data.
    //
    // Scanning every model (not just the five themselves) matters: a Cascade relation
    // declared on some unrelated model (e.g. ScheduleEntry.sale, or NotificationLog's
    // relation into ScheduleEntry) is exactly as dangerous as one declared on Sale
    // itself, and only becomes visible when the *target* type is checked rather than
    // the *declaring* model.
    const financiallySensitiveModels = new Set([
      'Sale',
      'Payment',
      'PaymentAllocation',
      'Document',
      'ScheduleEntry',
      // The record of who moved the money is exactly as destroyable as the money
      // rows, and rather more tempting to destroy: an `actorUserId` relation onto
      // User with `onDelete: Cascade` would look like tidy housekeeping and would
      // erase the history of everything a departed agent ever did. AuditEntry
      // deliberately declares no relations at all — see the test below — and this
      // line is what makes adding a Cascade one fail loudly.
      'AuditEntry',
    ])

    const models = allModels()
    expect(models.length).toBeGreaterThan(0)

    const violations: string[] = []
    for (const model of models) {
      for (const relation of relationsIn(model.body)) {
        if (relation.onDelete === 'Cascade' && financiallySensitiveModels.has(relation.target)) {
          violations.push(
            `${model.name}.${relation.field} -> ${relation.target} is onDelete: Cascade. ` +
              `${relation.target} is financially sensitive — deleting a ${relation.target} row ` +
              `must not be able to cascade away data through ${model.name}.${relation.field}. ` +
              `Change this relation's onDelete to Restrict.`
          )
        }
      }
    }

    expect(violations.join('\n')).toBe('')
  })

  /**
   * The audit log's own contract.
   *
   * The rule above stops a Cascade from reaching audit rows. These stop the two
   * other ways history could be lost — a foreign key that lets some other
   * table's lifecycle decide this one's, and a schema push that silently drops
   * the triggers making the rows append-only.
   */
  it('gives AuditEntry no relations at all, so nothing else owns its lifetime', () => {
    const auditEntry = allModels().find((model) => model.name === 'AuditEntry')
    expect(auditEntry, 'the schema must declare an AuditEntry model').toBeDefined()

    // Not "no Cascade relations" — *no relations*. A `Restrict` foreign key onto
    // User would be the mirror-image failure: instead of the log losing history
    // when a user is deleted, the log would forbid ever deleting a user, and the
    // first person to hit that would be tempted to fix it by deleting audit rows.
    // Every reference this table holds is a plain string, exactly as
    // `Sale.createdByUserId` already is.
    expect(relationsIn(auditEntry!.body)).toEqual([])
  })

  it('indexes AuditEntry for the only way it is ever read', () => {
    // Tenant scope plus newest-first, which also serves the date range: Postgres
    // scans a btree backwards for DESC, so no second descending index is needed.
    const auditEntry = allModels().find((model) => model.name === 'AuditEntry')
    expect(auditEntry!.body).toContain('@@index([orgId, createdAt])')
  })

  it('keeps every audit column that a sentence is built from', () => {
    // An entry has to stay readable after the actor is deactivated and the unit
    // is renamed, which it can only do by snapshotting. Losing any one of these
    // columns would silently turn a rendered row into "somebody did something".
    const auditEntry = allModels().find((model) => model.name === 'AuditEntry')!.body
    for (const column of [
      'orgId',
      'actorUserId',
      'actorName',
      'actorRole',
      'action',
      'entityType',
      'entityId',
      'entityLabel',
      'changes',
      'context',
      'createdAt',
    ]) {
      expect(auditEntry, `AuditEntry must keep ${column}`).toMatch(
        new RegExp(`^\\s*${column}\\s`, 'm')
      )
    }
  })

  it('ships the SQL that makes audit rows append-only', () => {
    // `prisma db push` recreates tables and knows nothing about triggers, so the
    // file has to exist and has to be re-applied after every push. What it
    // actually contains is asserted in server/__tests__/audit-immutability.test.ts;
    // this is the schema-side half — the schema is not complete without it.
    const sql = readFileSync(
      path.resolve(__dirname, '../../../prisma/audit-immutability.sql'),
      'utf8'
    )
    expect(sql).toMatch(/BEFORE UPDATE ON "AuditEntry"/)
    expect(sql).toMatch(/BEFORE DELETE ON "AuditEntry"/)
  })
})
