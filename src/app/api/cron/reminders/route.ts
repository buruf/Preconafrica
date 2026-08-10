import { NextResponse } from 'next/server'
import { runReminderSweep } from '@/server/notifications/reminders'

export const runtime = 'nodejs'

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

  const tally = await runReminderSweep(new Date())
  return NextResponse.json({ ok: true, ...tally })
}
