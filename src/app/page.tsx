import { redirect } from 'next/navigation'
import { requireUser } from '@/server/session'

export default async function Home() {
  const actor = await requireUser()
  redirect(actor.role === 'BUYER' ? '/dashboard' : '/projects')
}
