import { requireBuyer } from '@/server/session'
import { AppShell } from '@/components/AppShell'

export default async function BuyerLayout({ children }: { children: React.ReactNode }) {
  // Unchanged and load-bearing: requireBuyer both authenticates and refuses
  // staff, and it is the only thing that does — the middleware grants nothing.
  const actor = await requireBuyer()

  return <AppShell role={actor.role}>{children}</AppShell>
}
