import { redirect } from 'next/navigation'
import { requireStaff } from '@/server/session'
import { DEFAULT_UNITS_PER_FLOOR, NewProjectForm } from './NewProjectForm'

/** Mirrors `CreateProjectSchema`'s bounds on `unitsPerFloor`. */
const MIN_UNITS_PER_FLOOR = 1
const MAX_UNITS_PER_FLOOR = 100

/**
 * How many unit-position rows to render on the server.
 *
 * Ordinarily the default: the rows follow "Units / floor" as soon as it is
 * touched, in the browser. The query parameter exists for the browser that
 * cannot do that — the <noscript> block on the form posts a GET back here so a
 * no-JavaScript admin can still get the right number of rows before filling
 * them in. Anything unparseable, out of range or absent falls back to the
 * default; a bad value here is a wrong-looking form, never a wrong project,
 * because the count is validated again on submit.
 */
function rowsFrom(raw: string | string[] | undefined): number {
  const value = Number(Array.isArray(raw) ? raw[0] : raw)
  if (!Number.isInteger(value)) return DEFAULT_UNITS_PER_FLOOR
  if (value < MIN_UNITS_PER_FLOOR || value > MAX_UNITS_PER_FLOOR) return DEFAULT_UNITS_PER_FLOOR
  return value
}

export default async function NewProjectPage({
  searchParams
}: {
  searchParams?: { unitsPerFloor?: string | string[] }
}) {
  const actor = await requireStaff()

  // Create is ADMIN-only. An AGENT landing here is ordinary navigation (e.g.
  // a stale link), not an attack, so send them back to the project list
  // instead of the "Access denied" error card.
  if (actor.role !== 'ADMIN') redirect('/projects')

  return <NewProjectForm initialUnitsPerFloor={rowsFrom(searchParams?.unitsPerFloor)} />
}
