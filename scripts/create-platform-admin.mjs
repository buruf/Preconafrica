/**
 * Creates the first platform operator — the account that can then create every
 * developer from inside the app.
 *
 * This exists because of a genuine chicken-and-egg: the console creates
 * developers, but nothing inside the app can create the operator who uses the
 * console, and it must never be a public sign-up. Exactly the same gap that
 * `prisma/seed.ts` used to fill for organisations, which is what this whole
 * feature exists to close — so this script is deliberately the *only* thing
 * left that requires a terminal.
 *
 * Run it against whichever database is in DATABASE_URL:
 *
 *   PLATFORM_ADMIN_EMAIL=you@example.com \
 *   PLATFORM_ADMIN_NAME="Your Name" \
 *   PLATFORM_ADMIN_PASSWORD='...' \
 *   npm run platform:create-admin
 *
 * The password is read from the environment and never written anywhere but a
 * bcrypt hash. Set it in the shell for one command; do not put it in .env,
 * which is a file that gets committed by accident.
 *
 * Idempotent by email: running it again for an address that already exists
 * updates that operator's password and name rather than failing. That makes it
 * the recovery path too — a locked-out operator re-runs this — and the
 * `passwordChangedAt` stamp it sets revokes every session that predates the
 * change, which is what you want if the reason you are running it is that
 * someone else has the old one.
 */

import { randomBytes } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const RED = '[31m'
const GREEN = '[32m'
const BOLD = '[1m'
const DIM = '[2m'
const OFF = '[0m'

function fail(message) {
  console.error(`\n${RED}  ${message}${OFF}\n`)
  process.exit(1)
}

const email = (process.env.PLATFORM_ADMIN_EMAIL ?? '').trim().toLowerCase()
const fullName = (process.env.PLATFORM_ADMIN_NAME ?? '').trim()

if (!email || !email.includes('@')) fail('Set PLATFORM_ADMIN_EMAIL to a valid email address.')
if (!fullName) fail('Set PLATFORM_ADMIN_NAME.')

/**
 * The password is generated unless one is supplied, which is the same bargain
 * the console offers when it creates a developer's first admin: 144 bits of
 * randomness, hashed immediately, shown once and stored nowhere readable.
 *
 * Generating beats asking. A password someone invents at a terminal to get
 * started tends to be weak and tends to survive — and this account governs
 * every developer on the platform. The operator replaces it at
 * /platform/account, which stamps `passwordChangedAt` and kills every session
 * opened with the temporary one, including this one.
 *
 * PLATFORM_ADMIN_PASSWORD is still honoured for anyone who would rather choose,
 * and is held to a floor when they do.
 */
const supplied = process.env.PLATFORM_ADMIN_PASSWORD
if (supplied !== undefined && supplied.length < 12) {
  fail('PLATFORM_ADMIN_PASSWORD must be at least 12 characters. Omit it to have one generated.')
}
const password = supplied ?? randomBytes(18).toString('base64url')
const generated = supplied === undefined

const prisma = new PrismaClient()

try {
  const passwordHash = await bcrypt.hash(password, 10)

  const existing = await prisma.platformUser.findUnique({ where: { email }, select: { id: true } })

  const admin = await prisma.platformUser.upsert({
    where: { email },
    create: { email, fullName, passwordHash },
    // Stamping passwordChangedAt is what makes this a recovery path rather
    // than only a setup one: every session issued before now stops working on
    // its next request. See requirePlatformAdminOrNull.
    update: { fullName, passwordHash, passwordChangedAt: new Date(), disabledAt: null }
  })

  console.log(
    `\n${GREEN}  ${existing ? 'Updated' : 'Created'} platform operator ${admin.email}${OFF}\n` +
      // Printed once, and only when this script chose it. Nothing stores it in
      // readable form, so there is no second chance to look it up — the way
      // back is to re-run this, which mints a new one.
      (generated
        ? `\n${BOLD}  Temporary password: ${password}${OFF}\n` +
          `${DIM}  Shown once — only a bcrypt hash is stored, so it cannot be read back.${OFF}\n` +
          `${DIM}  Change it at /platform/account once you are in.${OFF}\n`
        : '') +
      `${DIM}  Sign in at /platform/login. Any session opened before now has been revoked.${OFF}\n`
  )
} catch (error) {
  fail(`Could not create the platform operator.\n  ${error?.message ?? error}`)
} finally {
  await prisma.$disconnect()
}
