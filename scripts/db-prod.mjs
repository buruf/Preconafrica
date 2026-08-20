/**
 * Schema changes against production, in one reviewable command.
 *
 * This exists because the manual version had too many steps to be safe: open
 * Neon, pick the right branch, copy the pooled string to one variable and the
 * unpooled to another, paste both into a file, remember which is which. Done by
 * hand it went wrong repeatedly — three times the file ended up holding the
 * *development* branch, and a push against it would have reported success
 * while leaving production without the table the new code needed.
 *
 * So nothing is copied by hand any more. Vercel already holds the production
 * credentials, the CLI is already authenticated, and `vercel env pull` fetches
 * them into `.env.prod` — a file `.gitignore` has always covered via `.env*`.
 *
 *   npm run db:diff:prod     show the SQL that would run, change nothing
 *   npm run db:push:prod     apply it (requires --confirm)
 *
 * The diff is not decoration. Both real pushes so far were previewed first, and
 * the preview is what proves a change is additive — `prisma db push` will drop
 * a column to make the database match the schema, and on a system of record
 * that is a data-loss event, not a migration.
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'

const RED = '[31m'
const GREEN = '[32m'
const YELLOW = '[33m'
const BOLD = '[1m'
const DIM = '[2m'
const OFF = '[0m'

const ENV_FILE = '.env.prod'
const apply = process.argv.includes('--apply')
const confirmed = process.argv.includes('--confirm')

const require = createRequire(import.meta.url)
const prismaCli = require.resolve('prisma/build/index.js')

function run(args, env) {
  return spawnSync(process.execPath, [prismaCli, ...args], { stdio: 'inherit', env })
}

/** Refresh the credentials from Vercel rather than trusting a stale file. */
function pullEnv() {
  console.log(`${DIM}  Pulling production environment from Vercel…${OFF}`)
  const result = spawnSync(
    process.platform === 'win32' ? 'vercel.cmd' : 'vercel',
    ['env', 'pull', ENV_FILE, '--environment=production', '--yes'],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  )

  if (result.status !== 0 && !existsSync(ENV_FILE)) {
    console.error(
      `\n${RED}  Could not pull the production environment, and ${ENV_FILE} does not exist.${OFF}\n` +
        `${DIM}  Check you are signed in: vercel whoami${OFF}\n`
    )
    process.exit(1)
  }
}

/** Read the pulled file without printing anything from it. */
function loadEnv() {
  const env = { ...process.env }
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)="?(.*?)"?\s*$/)
    if (match) env[match[1]] = match[2]
  }
  return env
}

/**
 * The host identifies the Neon branch, so this is the check that the target is
 * what the command name claims. A pooled endpoint is the direct one with
 * `-pooler` inserted, so that is normalised away before comparing.
 */
function branchOf(url) {
  try {
    return new URL(url).hostname.replace('-pooler', '')
  } catch {
    return ''
  }
}

pullEnv()
const env = loadEnv()

const target = branchOf(env.DATABASE_URL ?? '')
const direct = branchOf(env.DIRECT_URL ?? '')

if (!target) {
  console.error(`\n${RED}  ${ENV_FILE} has no usable DATABASE_URL. Refusing.${OFF}\n`)
  process.exit(1)
}

// Both must name the same branch. A mismatched pair is the failure mode that
// would push DDL to one database while the app reads another.
if (target !== direct) {
  console.error(
    `\n${RED}  DATABASE_URL and DIRECT_URL name different branches ` +
      `(${target} vs ${direct || 'unset'}). Refusing.${OFF}\n`
  )
  process.exit(1)
}

console.log(`\n${RED}${BOLD}  PRODUCTION DATABASE  (${target})${OFF}\n`)

if (!apply) {
  console.log(`${DIM}  Changes that would be applied:${OFF}\n`)
  const result = run(
    [
      'migrate',
      'diff',
      '--from-url',
      env.DIRECT_URL,
      '--to-schema-datamodel',
      'prisma/schema.prisma',
      '--script'
    ],
    env
  )
  console.log(
    `\n${YELLOW}  Nothing was changed.${OFF} ` +
      `${DIM}Read the SQL above — a DROP is data loss, not a migration.${OFF}\n` +
      `${DIM}  To apply: npm run db:push:prod -- --confirm${OFF}\n`
  )
  process.exit(result.status ?? 0)
}

if (!confirmed) {
  console.error(
    `${RED}  Refusing to change production without --confirm.${OFF}\n` +
      `${DIM}  Review first:  npm run db:diff:prod${OFF}\n` +
      `${DIM}  Then apply:    npm run db:push:prod -- --confirm${OFF}\n`
  )
  process.exit(1)
}

const push = run(['db', 'push', '--skip-generate'], env)
if (push.status !== 0) process.exit(push.status ?? 1)

// `prisma db push` knows nothing about triggers, so the append-only guarantee
// has to be re-applied every time — including on production, where it matters
// most. Same script the local postdb:push hook runs.
const triggers = spawnSync(process.execPath, ['scripts/ensure-audit-immutability.mjs'], {
  stdio: 'inherit',
  env
})
if (triggers.status !== 0) process.exit(triggers.status ?? 1)

console.log(`${GREEN}  Production schema is up to date.${OFF}\n`)
