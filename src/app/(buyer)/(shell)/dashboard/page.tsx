import { requireBuyer } from '@/server/session'

export default async function DashboardPage() {
  await requireBuyer()
  return <p className="text-sm text-slate-600">Dashboard — coming soon.</p>
}
