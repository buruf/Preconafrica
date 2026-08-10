import type { InstallmentStatus } from '@/domain/status'

const TONE: Record<InstallmentStatus, string> = {
  PAID: 'bg-emerald-100 text-emerald-800',
  PARTIAL: 'bg-amber-100 text-amber-800',
  OVERDUE: 'bg-rose-100 text-rose-800',
  PENDING: 'bg-slate-100 text-slate-700'
}

export function StatusBadge({ status }: { status: InstallmentStatus }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${TONE[status]}`}>
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  )
}
