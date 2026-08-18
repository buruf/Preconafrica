import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The honest cost of recording the audit log with explicit calls rather than
 * automatic capture is that a call can be forgotten. This file is what makes
 * forgetting fail a build instead of quietly losing history.
 *
 * Two rules, both mechanised:
 *
 *   1. **Only the service layer records.** A page or a server action recording
 *      its own entry would be one that a second caller of the same service
 *      silently skips — and it would attribute whatever the *action* thinks
 *      happened rather than what the service actually wrote. So `recordAudit`
 *      is importable from `src/server/**` and nowhere else.
 *   2. **Every service that moves money, inventory or access records.** The
 *      list below is the promise made to the owner, written out. Deleting a
 *      call is a failing test rather than a gap somebody notices in 2029.
 *
 * Both are source scans, which is a blunt instrument — they prove the call
 * exists, not that it is correct. Correctness is what the flow tests next door
 * assert. What a scan catches that they cannot is the *absence* of a call in a
 * service nobody thought to write a test for.
 */

const SRC = path.resolve(__dirname, '../..')

function sourceFilesUnder(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...sourceFilesUnder(full))
    else if (/\.tsx?$/.test(entry.name)) files.push(full)
  }
  return files
}

const RECORDER = '@/server/audit/record'

describe('only the service layer records audit entries', () => {
  it('is imported by no page, layout or server action', () => {
    const offenders = sourceFilesUnder(path.join(SRC, 'app'))
      .filter((file) => readFileSync(file, 'utf8').includes(RECORDER))
      .map((file) => path.relative(SRC, file))

    expect(
      offenders.join('\n'),
      'Audit entries are recorded by the service that makes the change, never by ' +
        'the page or action that called it — otherwise a second caller of the same ' +
        'service records nothing, and the entry describes what the caller believed ' +
        'rather than what was written.'
    ).toBe('')
  })

  it('is imported only from src/server', () => {
    const offenders = sourceFilesUnder(SRC)
      .filter((file) => !file.startsWith(path.join(SRC, 'server')))
      .filter((file) => readFileSync(file, 'utf8').includes(RECORDER))
      .map((file) => path.relative(SRC, file))

    expect(offenders.join('\n')).toBe('')
  })
})

/**
 * Every service that changes money, inventory or access, and the actions it
 * must be recording. Adding a row here before writing the code is the intended
 * order — the test says what is missing.
 */
const MUST_RECORD: Array<{ file: string; actions: string[] }> = [
  { file: 'services/payments.ts', actions: ['payment.recorded', 'payment.voided', 'sale.status_changed'] },
  { file: 'services/sales.ts', actions: ['sale.created', 'unit.status_changed', 'user.buyer_registered'] },
  { file: 'services/units.ts', actions: ['unit.updated', 'unit.layout_assigned'] },
  { file: 'services/projects.ts', actions: ['project.created', 'project.updated'] },
  { file: 'services/team.ts', actions: ['user.agent_added', 'user.agent_deactivated', 'org.updated'] },
  { file: 'services/passwords.ts', actions: ['user.password_changed', 'user.password_reset'] },
  { file: 'documents/issue.ts', actions: ['document.issued'] }
]

describe('every service that changes money, inventory or access records it', () => {
  it.each(MUST_RECORD)('$file records $actions', ({ file, actions }) => {
    const source = readFileSync(path.join(SRC, 'server', file), 'utf8')

    expect(source, `${file} must import the audit recorder`).toContain(RECORDER)
    for (const action of actions) {
      expect(source, `${file} must record '${action}'`).toContain(`'${action}'`)
    }
  })

  it('records inside a transaction everywhere, never after one', () => {
    // Every `recordAudit` call takes a transaction client. If one is ever
    // passed the bare `prisma` client instead, the entry commits separately
    // from the change it describes — and a crash between the two leaves a
    // payment with no record of who took it, which is the failure this whole
    // feature exists to prevent.
    for (const { file } of MUST_RECORD) {
      const source = readFileSync(path.join(SRC, 'server', file), 'utf8')
      expect(
        source,
        `${file} must pass a transaction client to recordAudit, never the bare prisma client`
      ).not.toMatch(/recordAudit\(\s*prisma\b/)
    }
  })
})
