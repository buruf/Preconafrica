import { redirect } from 'next/navigation'
import { requireStaff } from '@/server/session'
import { NewProjectForm } from './NewProjectForm'

export default async function NewProjectPage() {
  const actor = await requireStaff()

  // Create is ADMIN-only. An AGENT landing here is ordinary navigation (e.g.
  // a stale link), not an attack, so send them back to the project list
  // instead of the "Access denied" error card.
  if (actor.role !== 'ADMIN') redirect('/projects')

  return <NewProjectForm />
}
