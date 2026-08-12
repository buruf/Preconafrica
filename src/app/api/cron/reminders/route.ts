import { NextResponse } from 'next/server'
import { runReminderSweep } from '@/server/notifications/reminders'
import { purgeDeadResetTokens } from '@/server/services/passwords'

export const runtime = 'nodejs'

// This route is the app's daily housekeeping job, not only the reminder sweep.
// It also reaps spent and expired password-reset tokens, which nothing else
// deletes. That lives here rather than behind its own route and schedule
// because it is two seconds of work once a day, it needs exactly the same
// CRON_SECRET guard, and a second cron entry is a second thing to configure,
// forget, and discover unconfigured a year later. The name stays for the
// deploy config that already points at it; the tally reports both.
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
  const tally = await runReminderSweep(now)
  const resetTokensPurged = await purgeDeadResetTokens(now)

  return NextResponse.json({ ok: true, ...tally, resetTokensPurged })
}
