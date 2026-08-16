/**
 * Re-applies the append-only triggers on `AuditEntry`.
 *
 * This project has no migrations directory — the schema reaches a database
 * through `prisma db push`, and `db push` knows about tables, columns and
 * indexes and nothing whatsoever about triggers. So the one mechanism that
 * actually makes audit entries immutable would be missing from every database
 * the schema is pushed to, including a fresh production one, unless something
 * re-applies it.
 *
 * That something is this, wired as `postdb:push` in package.json so it travels
 * with the only command that ever creates the table. The SQL is idempotent
 * (DROP TRIGGER IF EXISTS / CREATE OR REPLACE FUNCTION), so running it twice,
 * or against a database that already has it, is a no-op.
 *
 * It is deliberately loud on failure and deliberately non-zero-exit: a push
 * that leaves the audit log mutable is a push somebody needs to know about.
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const RED = '[31m'
const GREEN = '[32m'
const DIM = '[2m'
const OFF = '[0m'

// The Prisma CLI's own entry point, run with this Node — not `npx`, and not a
// shell. `npx` is a platform-specific shim (`npx.cmd` on Windows) that
// `spawnSync` cannot find without `shell: true`, and passing arguments through
// a shell concatenates them unescaped. Resolving the installed CLI directly
// avoids both, and uses exactly the version in package.json.
const require = createRequire(import.meta.url)
const prismaCli = require.resolve('prisma/build/index.js')

const result = spawnSync(
  process.execPath,
  [
    prismaCli,
    'db',
    'execute',
    '--file',
    'prisma/audit-immutability.sql',
    '--schema',
    'prisma/schema.prisma'
  ],
  { stdio: 'inherit' }
)

if (result.status !== 0) {
  console.log(
    `\n${RED}  Could not apply the AuditEntry append-only triggers.${OFF}\n` +
      `${RED}  The audit log is mutable on this database until they are applied.${OFF}\n` +
      `${DIM}  Re-run: npx prisma db execute --file prisma/audit-immutability.sql --schema prisma/schema.prisma${OFF}\n`
  )
  process.exit(result.status ?? 1)
}

console.log(
  `${GREEN}  AuditEntry is append-only${OFF} ${DIM}(UPDATE, DELETE and TRUNCATE all refused by trigger)${OFF}\n`
)
