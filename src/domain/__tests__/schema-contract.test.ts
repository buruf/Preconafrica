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
})
