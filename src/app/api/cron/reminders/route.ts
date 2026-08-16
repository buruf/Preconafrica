import { NextResponse } from 'next/server'
import { runReminderSweep } from '@/server/notifications/reminders'
import { purgeExpiredRateLimitHits } from '@/server/rate-limit'
import { purgeDeadResetTokens } from '@/server/services/passwords'

export const runtime = 'nodejs'

// This route is the app's daily housekeeping job, not only the reminder sweep.
// It also reaps spent and expired password-reset tokens, and expired
// rate-limit counters, neither of which anything else deletes. Both live here
// rather than behind their own routes and schedules because together they are
// two seconds of work once a day, they need exactly the same CRON_SECRET
// guard, and every extra cron entry is another thing to configure, forget, and
// discover unconfigured a year later. The name stays for the deploy config
// that already points at it; the tally reports all three.
//
// A sweep queries every ACTIVE sale's schedule entries and dispatches a
// notification per due job — more work than the single-document PDF render
// (which needed 15s), so this gets a larger allowance. 60s is Vercel's cron
// ceiling on the Hobby/Pro tiers this platform targets.
export const maxDuration = 60

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET

  // Fail closed. An unset secret is a misconfiguration, never an open door.
  if (!secret) {
    return new NextResponse('CRON_SECRET is not configured', { status: 401 })
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const now = new Date()

  // Reaped before the sweep, deliberately. `runReminderSweep` throws outright
  // when the mail provider is unconfigured, and housekeeping that only happens
  // when email happens to be working is housekeeping that quietly stops.
  const resetTokensPurged = await purgeDeadResetTokens(now)
  // Same placement, same reason: the rate limiter writes a row per throttled
  // identifier and per source, and it writes fastest while an attack is under
  // way. Reaping it only when the mail provider happens to be configured would
  // mean the table grows without bound in exactly the incident that fills it.
  const rateLimitHitsPurged = await purgeExpiredRateLimitHits(now)

  // ── Do not add a third purge here for AuditEntry. ────────────────────────
  //
  // The two above are throwaway state: a spent reset token grants nothing and a
  // closed rate-limit window counts nothing, so deleting them changes no answer
  // this system can give. Audit entries are the exact opposite — they are the
  // one table whose whole value is that it still holds what happened four years
  // ago, and "who voided that payment in 2026" is a question somebody will ask
  // in 2030. Growth is no argument either: a busy organisation writes on the
  // order of a thousand entries a month, which is megabytes a decade.
  //
  // The note is here rather than only in the schema because here is where the
  // mistake would be made — by someone adding housekeeping to the housekeeping
  // job, by analogy with the two lines above. The database refuses the DELETE
  // regardless (prisma/audit-immutability.sql), so the analogy fails loudly
  // rather than quietly; this is so nobody spends an afternoon finding out why.
  // ────────────────────────────────────────────────────────────────────────
  const tally = await runReminderSweep(now)

  return NextResponse.json({ ok: true, ...tally, resetTokensPurged, rateLimitHitsPurged })
}
