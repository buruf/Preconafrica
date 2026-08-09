import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const schema = readFileSync(
  path.resolve(__dirname, '../../../prisma/schema.prisma'),
  'utf8'
)

/** Returns the body of `model <name> { ... }`, throwing if the model is missing. */
function modelBody(name: string): string {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`))
  if (!match) throw new Error(`model ${name} not found in schema.prisma`)
  return match[1]
}

/** Returns the `onDelete` action of every `@relation(...)` declared in a model body. */
function relationOnDeleteActions(body: string): string[] {
  const relations = body.match(/@relation\([^)]*\)/g) ?? []
  return relations.map((relation) => {
    const onDelete = relation.match(/onDelete:\s*(\w+)/)
    return onDelete ? onDelete[1] : '(none — defaults apply)'
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

  it('never cascade-deletes Sale, Payment, PaymentAllocation, or Document', () => {
    // These four models hold money movements or the audit trail of money movements.
    // Deleting an ancestor row (Unit, Sale, Org, Project, ...) must never be able to
    // silently wipe one of these out — the delete has to fail instead (onDelete: Restrict).
    // Parsed from the schema text, not Prisma, so this fails the moment a new relation
    // on any of these models is added with onDelete: Cascade.
    const financiallySensitiveModels = ['Sale', 'Payment', 'PaymentAllocation', 'Document']

    for (const model of financiallySensitiveModels) {
      const actions = relationOnDeleteActions(modelBody(model))

      expect(
        actions.length,
        `expected model ${model} to declare at least one @relation with an explicit onDelete`
      ).toBeGreaterThan(0)

      for (const action of actions) {
        expect(
          action,
          `model ${model} has a relation with onDelete: ${action} — a parent delete could ` +
            `cascade into ${model} and destroy payment/audit history. Use Restrict instead.`
        ).not.toBe('Cascade')
      }
    }
  })
})
