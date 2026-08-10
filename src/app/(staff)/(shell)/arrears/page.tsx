import { requireStaff } from '@/server/session'

export default async function ArrearsPage() {
  await requireStaff()
  return <p className="text-sm text-slate-600">Arrears — coming soon.</p>
}
