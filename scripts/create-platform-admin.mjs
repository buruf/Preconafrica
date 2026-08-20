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

import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const RED = '[31m'
const GREEN = '[32m'
const DIM = '[2m'
const OFF = '[0m'

function fail(message) {
  console.error(`\n${RED}  ${message}${OFF}\n`)
  process.exit(1)
}

const email = (process.env.PLATFORM_ADMIN_EMAIL ?? '').trim().toLowerCase()
const fullName = (process.env.PLATFORM_ADMIN_NAME ?? '').trim()
const password = process.env.PLATFORM_ADMIN_PASSWORD ?? ''

if (!email || !email.includes('@')) fail('Set PLATFORM_ADMIN_EMAIL to a valid email address.')
if (!fullName) fail('Set PLATFORM_ADMIN_NAME.')

// Twelve is not a strong password on its own, but this is the account that can
// create and suspend every developer on the platform, so the floor is not zero.
if (password.length < 12) fail('Set PLATFORM_ADMIN_PASSWORD to at least 12 characters.')

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
      `${DIM}  Sign in at /platform/login. Any session opened before now has been revoked.${OFF}\n`
  )
} catch (error) {
  fail(`Could not create the platform operator.\n  ${error?.message ?? error}`)
} finally {
  await prisma.$disconnect()
}
