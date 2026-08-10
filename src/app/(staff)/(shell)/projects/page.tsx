import { requireStaff } from '@/server/session'

export default async function ProjectsPage() {
  await requireStaff()
  return <p className="text-sm text-slate-600">Projects — coming soon.</p>
}
