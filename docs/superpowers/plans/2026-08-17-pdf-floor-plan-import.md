# PDF floor-plan import — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin import unit floor plans out of a developer's brochure PDF by rendering its pages in the browser, ticking the plan pages, and assigning each to the units it covers.

**Architecture:** `pdf.js` rasterizes pages client-side, so the PDF never crosses the wire and Vercel's ~4.5MB body cap never applies. Chosen pages upload as PNGs through the existing `/api/uploads/images` route. A service writes one URL onto many units in a transaction with a single audit entry.

**Tech Stack:** Next 14 App Router, React 18, Prisma 5, Vitest, `pdfjs-dist` (new), Vercel Blob, `sharp` (server-side, already present).

**Spec:** `docs/superpowers/specs/2026-08-17-pdf-floor-plan-import-design.md`

## Global Constraints

- **Vitest collects `src/**/*.test.ts` only** — never `.tsx`. A test that must build a component uses `createElement`, not JSX.
- **`recordAudit` may be imported only from `src/server/**`.** A page, layout or server action that imports it fails `src/server/__tests__/audit-call-sites.test.ts`. Writes go in a service; the action calls the service.
- **`recordAudit` always receives a transaction client, never bare `prisma`.** Enforced by regex in the same test.
- **Any service that changes money, inventory or access needs a row in that test's `MUST_RECORD` table**, listing its action strings.
- **`src/domain/**` imports nothing from Prisma, `@/server` or `next`, and calls no clock** (`Date.now()`, `new Date()`). Enforced by `src/domain/__tests__/domain-purity.test.ts`.
- **Every query is scoped by `orgId` taken from the session**, never from a parameter.
- **Service tests mock `@/server/db`** with `vi.mock`; no test touches Postgres.
- **Services guard with `assertRole(actor, ['ADMIN'])`** from `@/server/session`.
- Existing upload contract: `POST /api/uploads/images`, `FormData` with `kind` (`'building' | 'layout' | 'render' | 'logo'`), optional `projectId`/`unitId`, and `file`. Returns `{ url }` on success, `{ error }` otherwise. Already `ADMIN`-guarded.
- `IMAGE_PROFILES.layout` caps the long edge at **2400px** with a **300kB** budget.

---

## File structure

| File | Responsibility |
|---|---|
| `src/domain/plan-import.ts` | **New.** Pure: page text + units → suggested unit ids. |
| `src/domain/__tests__/plan-import.test.ts` | **New.** Its tests. |
| `src/domain/audit.ts` | **Modify.** One sentence case for the new verb; widen `unitCount`. |
| `src/domain/__tests__/audit-narrative.test.ts` | **Modify.** Sentence tests. |
| `src/server/services/units.ts` | **Modify.** `assignLayoutToUnits` — the only writer. |
| `src/server/__tests__/assign-layout.test.ts` | **New.** Scoping and audit tests. |
| `src/server/__tests__/audit-call-sites.test.ts` | **Modify.** New action in `MUST_RECORD`. |
| `src/components/upload-client.ts` | **New.** `uploadOne`, extracted so two callers share it. |
| `src/components/ImagePicker.tsx` | **Modify.** Import the extracted helper. |
| `src/app/(staff)/(shell)/projects/[id]/plans/import/page.tsx` | **New.** Server guard + data. |
| `src/app/(staff)/(shell)/projects/[id]/plans/import/PlanImporter.tsx` | **New.** Client: render, tick, pick. |
| `src/app/(staff)/(shell)/projects/[id]/plans/import/actions.ts` | **New.** Server action → service. |
| `src/app/(staff)/(shell)/projects/[id]/page.tsx` | **Modify.** Link to the importer. |

### One decision the spec did not settle: no blob sweep

`updateUnit` calls `deleteReplacedBlobs` so a replaced drawing does not linger. **`assignLayoutToUnits` deliberately does not.**

Under the group-assignment model many units share one URL. Sweeping per-unit would delete a blob that other units still point at — reassign the 3-bed plan for half the units and the other half's drawing disappears. Orphaned blobs cost storage; a deleted blob that is still referenced breaks the buyer's floor-plan PDF. Take the storage.

---

## Task 1: The suggestion, as a pure function

**Files:**
- Create: `src/domain/plan-import.ts`
- Test: `src/domain/__tests__/plan-import.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface SuggestableUnit { id: string; bedrooms: number }`
  - `bedroomCountsInText(text: string): number[]` — ascending, distinct.
  - `suggestUnitsForPage(text: string, units: SuggestableUnit[]): string[]`

- [ ] **Step 1: Write the failing test**

Create `src/domain/__tests__/plan-import.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { bedroomCountsInText, suggestUnitsForPage, type SuggestableUnit } from '@/domain/plan-import'

/**
 * What a page of a developer's PDF appears to be a plan *for*.
 *
 * The rule worth pinning is the refusal: a page that names two bedroom counts,
 * or none, suggests nothing. A floor plate listing six units is exactly that
 * case, and quietly guessing at it would put one unit's drawing on six units.
 */

const UNITS: SuggestableUnit[] = [
  { id: 'u1', bedrooms: 3 },
  { id: 'u2', bedrooms: 3 },
  { id: 'u3', bedrooms: 4 }
]

describe('bedroomCountsInText', () => {
  it('reads a digit', () => {
    expect(bedroomCountsInText('TYPE A — 3 BEDROOM')).toEqual([3])
  })

  it('reads a plural', () => {
    expect(bedroomCountsInText('3 BEDROOMS')).toEqual([3])
  })

  it('reads a hyphenated form', () => {
    expect(bedroomCountsInText('3-BEDROOM APARTMENT')).toEqual([3])
  })

  it('reads the short form', () => {
    expect(bedroomCountsInText('4 BED')).toEqual([4])
  })

  it('reads a spelled-out number', () => {
    expect(bedroomCountsInText('THREE BEDROOM APARTMENT')).toEqual([3])
  })

  it('collapses repeats of the same count', () => {
    expect(bedroomCountsInText('3 BEDROOM — 3 bedroom unit plan')).toEqual([3])
  })

  it('reports both when a page names two', () => {
    expect(bedroomCountsInText('3 BEDROOM and 4 BEDROOM')).toEqual([3, 4])
  })

  it('finds nothing in a floor plate', () => {
    expect(bedroomCountsInText('LEVEL 3 — UNIT 301 302 303 304')).toEqual([])
  })

  it('ignores an implausible count', () => {
    expect(bedroomCountsInText('99 BEDROOM')).toEqual([])
  })
})

describe('suggestUnitsForPage', () => {
  it('suggests every unit with the count the page names', () => {
    expect(suggestUnitsForPage('3 BEDROOM', UNITS)).toEqual(['u1', 'u2'])
  })

  it('suggests nothing when the page names two counts', () => {
    expect(suggestUnitsForPage('3 BEDROOM and 4 BEDROOM', UNITS)).toEqual([])
  })

  it('suggests nothing when the page names none', () => {
    expect(suggestUnitsForPage('LEVEL 3 — UNIT 301 302', UNITS)).toEqual([])
  })

  it('suggests nothing when no unit has that count', () => {
    expect(suggestUnitsForPage('6 BEDROOM', UNITS)).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/domain/__tests__/plan-import.test.ts`
Expected: FAIL — `Failed to resolve import "@/domain/plan-import"`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/domain/plan-import.ts`:

```ts
/**
 * Which units a page of a developer's PDF appears to be the floor plan for.
 *
 * Pure: text in, unit ids out. No pdf.js, no DOM, no clock — the suggestion is
 * a decision about words, and it is the only part of the import worth testing,
 * so it lives apart from the canvas that produced the words.
 *
 * A suggestion is never applied on its own: the importer pre-ticks what this
 * returns and the admin confirms it. That is why ambiguity returns nothing
 * rather than a best guess — a wrong pre-tick that someone accepts is worse
 * than an empty one they have to fill in, because only one of the two is
 * visible as a decision.
 */

export interface SuggestableUnit {
  id: string
  bedrooms: number
}

/** Developers write the count either way, so both are read. */
const SPELLED: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6
}

/**
 * `3 BEDROOM`, `3-bedroom`, `3 BEDROOMS`, `4 BED`, `THREE BEDROOM`.
 *
 * The separator class includes an en dash because typeset plans use one, and
 * the trailing `\b` keeps `BEDSIT` from reading as a bed count.
 */
const BEDROOM = /(\d{1,2}|one|two|three|four|five|six)[\s\-–]*bed(?:room)?s?\b/gi

/** Above this, the "count" is a room number or a dimension, not a bedroom count. */
const MAX_PLAUSIBLE_BEDROOMS = 12

/** Distinct bedroom counts the text names, ascending. */
export function bedroomCountsInText(text: string): number[] {
  const counts = new Set<number>()

  for (const match of text.matchAll(BEDROOM)) {
    const token = match[1].toLowerCase()
    const value = /^\d+$/.test(token) ? Number(token) : SPELLED[token]
    if (value !== undefined && value > 0 && value <= MAX_PLAUSIBLE_BEDROOMS) {
      counts.add(value)
    }
  }

  return [...counts].sort((a, b) => a - b)
}

/**
 * The units a page is suggested for: every unit whose bedroom count matches,
 * but only when the page names exactly one count. Two counts means the page is
 * a comparison or a schedule, and none means it is a plate, a cover or an
 * amenity page — neither is a floor plan for a particular unit.
 */
export function suggestUnitsForPage(text: string, units: SuggestableUnit[]): string[] {
  const counts = bedroomCountsInText(text)
  if (counts.length !== 1) return []

  const bedrooms = counts[0]
  return units.filter((unit) => unit.bedrooms === bedrooms).map((unit) => unit.id)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/__tests__/plan-import.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Confirm the purity guard still passes**

Run: `npx vitest run src/domain/__tests__/domain-purity.test.ts`
Expected: PASS. The new module imports nothing and reads no clock.

- [ ] **Step 6: Commit**

```bash
git add src/domain/plan-import.ts src/domain/__tests__/plan-import.test.ts
git commit -m "feat(plan-import): read a bedroom count off a page, or refuse to guess"
```

---

## Task 2: A sentence for the new verb

The log renders `unit.layout_assigned`. Without a case it falls through to the default — *"performed unit.layout_assigned on project Khaleel Suites"* — which is readable but not a sentence a developer should have to parse.

**Files:**
- Modify: `src/domain/audit.ts`
- Test: `src/domain/__tests__/audit-narrative.test.ts`

**Interfaces:**
- Consumes: `AuditEntryView`, `describeAuditEntry` (existing).
- Produces: the action string `'unit.layout_assigned'`, rendered with `entityType: 'Project'`, `entityLabel` = project name, `context.unitCount` = how many units were assigned.

- [ ] **Step 1: Write the failing test**

Append to `src/domain/__tests__/audit-narrative.test.ts`, using the `entry(overrides)` helper already defined at the top of that file (it fills `id`, `actorName`, `createdAt` and the rest, so only what matters to the case is written out):

```ts
describe('a floor plan assigned to many units', () => {
  const assigned = entry({
    actorName: 'Adaeze Okonkwo',
    action: 'unit.layout_assigned',
    entityType: 'Project',
    entityId: 'p1',
    entityLabel: 'Khaleel Suites',
    context: { projectId: 'p1', projectName: 'Khaleel Suites', unitCount: 24 }
  })

  it('says how many units it covered, and where', () => {
    expect(describeAuditEntry(assigned).sentence).toBe(
      'Adaeze Okonkwo assigned a floor plan to 24 units in Khaleel Suites'
    )
  })

  it('does not say "1 units"', () => {
    const one = entry({ ...assigned, context: { ...assigned.context, unitCount: 1 } })
    expect(describeAuditEntry(one).sentence).toBe(
      'Adaeze Okonkwo assigned a floor plan to 1 unit in Khaleel Suites'
    )
  })

  it('links to the project', () => {
    expect(describeAuditEntry(assigned).href).toBe('/projects/p1')
  })
})
```

No `plain()` wrapper here: these sentences carry no money, so no non-breaking space appears in them.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/domain/__tests__/audit-narrative.test.ts`
Expected: FAIL — the sentence comes back as `Adaeze Okonkwo performed unit.layout_assigned on project Khaleel Suites`.

- [ ] **Step 3: Add the case**

In `src/domain/audit.ts`, inside the `switch (entry.action)` in `describeAuditEntry`, directly after the `case 'unit.status_changed'` block:

```ts
      case 'unit.layout_assigned': {
        // One entry stands for many units, so the count carries the weight the
        // unit name usually would. Singular matters: an entry that reads
        // "1 units" is the kind of thing that makes a reader distrust the rest
        // of the log.
        const count = context.unitCount
        const units = count === undefined ? 'units' : count === 1 ? '1 unit' : `${count} units`
        const project = entry.entityLabel ?? context.projectName ?? '—'
        return `${who} assigned a floor plan to ${units} in ${project}`
      }
```

- [ ] **Step 4: Widen the `unitCount` comment**

In `src/domain/audit.ts`, in `interface AuditContext`, replace:

```ts
  /** How many units a newly created project generated. */
  unitCount?: number
```

with:

```ts
  /**
   * How many units an event covered — the units a new project generated, or
   * the units a floor plan was assigned to in one action.
   */
  unitCount?: number
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/domain/__tests__/audit-narrative.test.ts`
Expected: PASS, including the three new cases.

- [ ] **Step 6: Commit**

```bash
git add src/domain/audit.ts src/domain/__tests__/audit-narrative.test.ts
git commit -m "feat(audit): a sentence for a floor plan assigned across units"
```

---

## Task 3: The service that writes

**Files:**
- Modify: `src/server/services/units.ts`
- Modify: `src/server/__tests__/audit-call-sites.test.ts`
- Test: `src/server/__tests__/assign-layout.test.ts`

**Interfaces:**
- Consumes: `assertRole` (`@/server/session`), `ServiceError` (`@/server/services/errors`), `recordAudit` (`@/server/audit/record`), `ownedBlobPathname` (`@/domain/uploads`), `prisma` (`@/server/db`).
- Produces: `assignLayoutToUnits(actor: SessionActor, input: { projectId: string; imageUrl: string; unitIds: string[] }): Promise<{ assigned: number }>`

- [ ] **Step 1: Write the failing test**

Create `src/server/__tests__/assign-layout.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Assigning one drawing to many units. Everything worth asserting here is a
 * refusal or an attribution — the update itself is one `updateMany`.
 *
 * `@/server/db` is mocked, as in every other service test: these are questions
 * about which branch was taken, not about Postgres.
 */

const auditCalls: Array<{ action: string; entityType: string; context: unknown }> = []

vi.mock('@/server/audit/record', () => ({
  recordAudit: vi.fn(async (_tx: unknown, _actor: unknown, input: never) => {
    auditCalls.push(input)
  })
}))

const updateMany = vi.fn(async () => ({ count: 2 }))

vi.mock('@/server/db', () => ({
  prisma: {
    project: { findFirst: vi.fn() },
    unit: { findMany: vi.fn(), updateMany },
    // The interactive transaction hands the callback a client that records the
    // same way the real one writes, so "the audit ran inside the transaction"
    // is observable.
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ unit: { updateMany } })
    )
  }
}))

const { prisma } = await import('@/server/db')
const { assignLayoutToUnits } = await import('@/server/services/units')

const ADMIN = { userId: 'u1', orgId: 'org_sunrise', role: 'ADMIN', fullName: 'Adaeze Okonkwo' } as never
const AGENT = { userId: 'u2', orgId: 'org_sunrise', role: 'AGENT', fullName: 'Tunde Bakare' } as never

const OURS = 'https://x.public.blob.vercel-storage.com/org/org_sunrise/unit/u1/layout-abc.png'

beforeEach(() => {
  auditCalls.length = 0
  vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'p1', name: 'Khaleel Suites' } as never)
  vi.mocked(prisma.unit.findMany).mockResolvedValue([{ id: 'a' }, { id: 'b' }] as never)
  updateMany.mockClear()
})

describe('assignLayoutToUnits', () => {
  it('writes the same drawing to every chosen unit', async () => {
    const result = await assignLayoutToUnits(ADMIN, {
      projectId: 'p1',
      imageUrl: OURS,
      unitIds: ['a', 'b']
    })

    expect(result).toEqual({ assigned: 2 })
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a', 'b'] } },
      data: { layoutImageUrl: OURS }
    })
  })

  it('refuses an agent', async () => {
    await expect(
      assignLayoutToUnits(AGENT, { projectId: 'p1', imageUrl: OURS, unitIds: ['a'] })
    ).rejects.toThrow()
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('refuses a project in another organisation', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null as never)
    await expect(
      assignLayoutToUnits(ADMIN, { projectId: 'p1', imageUrl: OURS, unitIds: ['a'] })
    ).rejects.toThrow('Project not found')
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('refuses a unit that is not in this project', async () => {
    // Two ids asked for, one came back scoped — the missing one belongs
    // somewhere else, and a partial write would be worse than none.
    vi.mocked(prisma.unit.findMany).mockResolvedValue([{ id: 'a' }] as never)
    await expect(
      assignLayoutToUnits(ADMIN, { projectId: 'p1', imageUrl: OURS, unitIds: ['a', 'b'] })
    ).rejects.toThrow('not in this project')
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('refuses an image this organisation did not upload', async () => {
    await expect(
      assignLayoutToUnits(ADMIN, {
        projectId: 'p1',
        imageUrl: 'https://partner.example/tower.png',
        unitIds: ['a']
      })
    ).rejects.toThrow('not one this organisation uploaded')
    expect(updateMany).not.toHaveBeenCalled()
  })

  it("refuses another tenant's blob", async () => {
    await expect(
      assignLayoutToUnits(ADMIN, {
        projectId: 'p1',
        imageUrl: 'https://x.public.blob.vercel-storage.com/org/org_other/unit/z/layout-abc.png',
        unitIds: ['a']
      })
    ).rejects.toThrow('not one this organisation uploaded')
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('records one entry for the batch, not one per unit', async () => {
    await assignLayoutToUnits(ADMIN, { projectId: 'p1', imageUrl: OURS, unitIds: ['a', 'b'] })

    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0]).toMatchObject({
      action: 'unit.layout_assigned',
      entityType: 'Project',
      entityLabel: 'Khaleel Suites',
      context: { projectId: 'p1', projectName: 'Khaleel Suites', unitCount: 2 }
    })
  })

  it('refuses an empty selection', async () => {
    await expect(
      assignLayoutToUnits(ADMIN, { projectId: 'p1', imageUrl: OURS, unitIds: [] })
    ).rejects.toThrow()
    expect(updateMany).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/server/__tests__/assign-layout.test.ts`
Expected: FAIL — `assignLayoutToUnits is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/server/services/units.ts`. The file already imports `prisma`, `z`, `assertRole`, `ServiceError`, `recordAudit` and `SessionActor`; add only `ownedBlobPathname`:

```ts
import { ownedBlobPathname } from '@/domain/uploads'
```

Then:

```ts
export const AssignLayoutSchema = z.object({
  projectId: z.string().min(1),
  imageUrl: z.string().url(),
  // A ceiling rather than an unbounded list: one project's units, not a
  // request that asks the database to update every row it can name.
  unitIds: z.array(z.string().min(1)).min(1).max(500)
})

/**
 * One drawing onto many units, in a single transaction with a single audit
 * entry.
 *
 * This is what makes the PDF import worth having: page 23 of a developer's
 * brochure is *the* 3-bedroom plan, and there are twenty-four 3-bedroom units.
 * Assigning it unit by unit would be twenty-four writes, twenty-four audit rows
 * and twenty-four chances to stop halfway.
 *
 * Three things are checked before anything is written, and each is checked
 * against the database rather than against what the browser claimed:
 *
 *   1. the project belongs to the actor's organisation;
 *   2. every unit id belongs to *that* project — a partial match is refused
 *      outright rather than silently assigning the subset that resolved;
 *   3. the image is a blob this organisation uploaded. `ownedBlobPathname`
 *      returns null for a pasted external URL and for another tenant's blob
 *      alike, so a crafted request cannot point a unit's drawing at a host we
 *      do not control.
 *
 * **No blob sweep.** `updateUnit` calls `deleteReplacedBlobs` so a replaced
 * drawing does not linger; this deliberately does not. Under group assignment
 * many units share one URL, so deleting "the old one" per unit would delete a
 * blob the units *not* in this batch still point at — and a buyer's floor-plan
 * PDF would then say no plan exists for a unit that has one. An orphaned blob
 * costs storage. A deleted one that is still referenced costs the document.
 */
export async function assignLayoutToUnits(
  actor: SessionActor,
  input: z.infer<typeof AssignLayoutSchema>
): Promise<{ assigned: number }> {
  assertRole(actor, ['ADMIN'])

  const parsed = AssignLayoutSchema.safeParse(input)
  if (!parsed.success) {
    throw new ServiceError(
      parsed.error.issues[0]?.message ?? 'Choose at least one unit.',
      'VALIDATION'
    )
  }

  const project = await prisma.project.findFirst({
    where: { id: parsed.data.projectId, orgId: actor.orgId },
    select: { id: true, name: true }
  })
  if (!project) throw new ServiceError('Project not found', 'NOT_FOUND')

  if (ownedBlobPathname(parsed.data.imageUrl, actor.orgId) === null) {
    throw new ServiceError(
      'That image is not one this organisation uploaded.',
      'VALIDATION'
    )
  }

  const units = await prisma.unit.findMany({
    where: { id: { in: parsed.data.unitIds }, projectId: project.id },
    select: { id: true }
  })
  if (units.length !== parsed.data.unitIds.length) {
    throw new ServiceError('Some of those units are not in this project.', 'VALIDATION')
  }

  const ids = units.map((unit) => unit.id)

  await prisma.$transaction(async (tx) => {
    await tx.unit.updateMany({
      where: { id: { in: ids } },
      data: { layoutImageUrl: parsed.data.imageUrl }
    })

    // No `changes` array. Across twenty-four units the previous value differs
    // per unit — some had no plan, some had an older one — so a single
    // before/after pair would be true of some and a lie about the rest. The
    // sentence and the count are honest; a fabricated diff would not be.
    await recordAudit(tx, actor, {
      action: 'unit.layout_assigned',
      entityType: 'Project',
      entityId: project.id,
      entityLabel: project.name,
      context: {
        projectId: project.id,
        projectName: project.name,
        unitCount: ids.length
      }
    })
  })

  return { assigned: ids.length }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/server/__tests__/assign-layout.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Register the action in the call-sites table**

In `src/server/__tests__/audit-call-sites.test.ts`, change the `services/units.ts` row of `MUST_RECORD`:

```ts
  { file: 'services/units.ts', actions: ['unit.updated', 'unit.layout_assigned'] },
```

- [ ] **Step 6: Run the call-sites test**

Run: `npx vitest run src/server/__tests__/audit-call-sites.test.ts`
Expected: PASS. The regex check also confirms `recordAudit` is not handed the bare `prisma` client.

- [ ] **Step 7: Commit**

```bash
git add src/server/services/units.ts src/server/__tests__/assign-layout.test.ts src/server/__tests__/audit-call-sites.test.ts
git commit -m "feat(units): assign one floor plan across many units in one transaction"
```

---

## Task 4: Share the upload helper

`uploadOne` is module-private in `ImagePicker.tsx`. The importer needs the same behaviour — the same size pre-check, the same server-sentence error handling — and a second copy would drift.

Pure refactor: no behaviour changes, and the existing suite is the proof.

**Files:**
- Create: `src/components/upload-client.ts`
- Modify: `src/components/ImagePicker.tsx`

**Interfaces:**
- Consumes: `MAX_UPLOAD_BYTES`, `UploadKind` (`@/domain/uploads`).
- Produces: `uploadOne(file: File, target: UploadTarget): Promise<string>` and `interface UploadTarget { uploadKind: UploadKind; projectId?: string; unitId?: string }`.

- [ ] **Step 1: Create the shared module**

Create `src/components/upload-client.ts` and move `UploadTarget` and `uploadOne` into it verbatim from `ImagePicker.tsx` — comments included — adding `export` to both and importing what they use:

```ts
import { MAX_UPLOAD_BYTES, type UploadKind } from '@/domain/uploads'

/**
 * The browser half of an upload, shared by every control that performs one:
 * the image picker on a project or unit, and the PDF importer that uploads a
 * rendered page. One copy, so the size pre-check and — more importantly — the
 * habit of surfacing the *server's* sentence rather than a generic failure
 * cannot drift between them.
 */

export interface UploadTarget {
  uploadKind: UploadKind
  projectId?: string
  unitId?: string
}

// ... uploadOne, moved verbatim and exported ...
```

- [ ] **Step 2: Point ImagePicker at it**

In `src/components/ImagePicker.tsx`, delete the local `UploadTarget` interface and the `uploadOne` function, and add:

```ts
import { uploadOne } from '@/components/upload-client'
```

`MAX_UPLOAD_BYTES` is used at lines 57 and 60 only — both inside `uploadOne` — while `UploadKind` is still needed at lines 42 and 197. So line 6 of `ImagePicker.tsx` changes from:

```ts
import { MAX_UPLOAD_BYTES, type UploadKind } from '@/domain/uploads'
```

to:

```ts
import { type UploadKind } from '@/domain/uploads'
```

Leaving the unused binding in place fails `npm run typecheck`.

- [ ] **Step 3: Verify nothing changed**

Run: `npm run typecheck`
Expected: no output.

Run: `npx vitest run`
Expected: PASS, same count as before this task.

- [ ] **Step 4: Commit**

```bash
git add src/components/upload-client.ts src/components/ImagePicker.tsx
git commit -m "refactor(uploads): one browser-side upload helper, two callers"
```

---

## Task 5: The importer

**Files:**
- Modify: `package.json` (add `pdfjs-dist`)
- Create: `src/app/(staff)/(shell)/projects/[id]/plans/import/page.tsx`
- Create: `src/app/(staff)/(shell)/projects/[id]/plans/import/PlanImporter.tsx`
- Create: `src/app/(staff)/(shell)/projects/[id]/plans/import/actions.ts`
- Modify: `src/app/(staff)/(shell)/projects/[id]/page.tsx`

**Interfaces:**
- Consumes: `assignLayoutToUnits` (Task 3), `suggestUnitsForPage` / `SuggestableUnit` (Task 1), `uploadOne` (Task 4), `requireAdmin` (`@/server/session`).
- Produces: `assignPlanAction(projectId: string, imageUrl: string, unitIds: string[]): Promise<string | undefined>` — resolves to an error message, or `undefined` on success.

- [ ] **Step 1: Add the dependency**

```bash
npm install pdfjs-dist@^4
```

- [ ] **Step 2: Write the server action**

Create `src/app/(staff)/(shell)/projects/[id]/plans/import/actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { assignLayoutToUnits } from '@/server/services/units'

/**
 * The only write the importer performs.
 *
 * Thin on purpose: it guards, delegates, and turns a ServiceError into a
 * sentence. The audit entry is the service's to record — a server action that
 * imported the recorder would fail `audit-call-sites.test.ts`, and rightly so:
 * an entry written here would describe what this action believed rather than
 * what the service wrote.
 *
 * Not a `useFormState` action: the importer calls it once per chosen page with
 * a list the client assembled, which is not a form submission.
 */
export async function assignPlanAction(
  projectId: string,
  imageUrl: string,
  unitIds: string[]
): Promise<string | undefined> {
  const actor = await requireAdmin()

  try {
    await assignLayoutToUnits(actor, { projectId, imageUrl, unitIds })
  } catch (error) {
    return error instanceof ServiceError ? error.message : 'Those plans could not be saved.'
  }

  // The unit tiles show the drawing, so the project page is stale now.
  revalidatePath(`/projects/${projectId}`)
  return undefined
}
```

- [ ] **Step 3: Write the server page**

Create `src/app/(staff)/(shell)/projects/[id]/plans/import/page.tsx`:

```tsx
import { notFound } from 'next/navigation'
import { prisma } from '@/server/db'
import { requireAdmin } from '@/server/session'
import { PlanImporter } from './PlanImporter'

/**
 * The guard lives here, in a server component, and the importer below is a
 * client one. That split is not stylistic: `/projects/new` shipped as a client
 * component top to bottom and was therefore reachable by anyone who knew the
 * URL. A client component cannot guard itself.
 */
export default async function ImportPlansPage({ params }: { params: { id: string } }) {
  const actor = await requireAdmin()

  const project = await prisma.project.findFirst({
    where: { id: params.id, orgId: actor.orgId },
    select: {
      id: true,
      name: true,
      units: {
        select: { id: true, name: true, bedrooms: true, layoutImageUrl: true },
        orderBy: [{ floor: 'asc' }, { name: 'asc' }]
      }
    }
  })
  if (!project) notFound()

  return (
    <main className="p-4 sm:p-6">
      <h1 className="text-xl font-semibold text-ink">Import floor plans</h1>
      <p className="mt-1 text-sm text-muted">
        Choose the developer&rsquo;s PDF. It stays on this device — only the pages you pick are
        uploaded.
      </p>

      <PlanImporter
        projectId={project.id}
        projectName={project.name}
        units={project.units.map((unit) => ({
          id: unit.id,
          name: unit.name,
          bedrooms: unit.bedrooms,
          hasPlan: unit.layoutImageUrl !== null
        }))}
      />
    </main>
  )
}
```

- [ ] **Step 4: Write the client importer**

Create `src/app/(staff)/(shell)/projects/[id]/plans/import/PlanImporter.tsx`. It must:

1. Take `{ projectId, projectName, units }` where `units: Array<{ id: string; name: string; bedrooms: number; hasPlan: boolean }>`.
2. Render an `<input type="file" accept="application/pdf">`.
3. On choose, `const pdfjs = await import('pdfjs-dist')` and set
   `pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()`.
4. `getDocument({ data })` from an `ArrayBuffer`; if `numPages > 100`, ask before rendering.
5. Per page: `getTextContent()` for the text, and render to a canvas at a scale that puts the **long edge at 2400px** — compute from `page.getViewport({ scale: 1 })` as `2400 / Math.max(width, height)`, never upscaling past `scale = 1` if the page is already larger.
6. Show a thumbnail grid with page numbers and a checkbox each.
7. For each ticked page, a unit picker with a *Suggested* group pre-ticked from `suggestUnitsForPage(pageText, units)`, quick chips for each distinct bedroom count (`All 3-bedroom (24)`), and individual unit toggles. Units where `hasPlan` is true are marked so the admin knows they are overwriting one.
8. On confirm, per ticked page **in sequence**: `canvas.toBlob(..., 'image/png')` → `new File([blob], \`page-${n}.png\`, { type: 'image/png' })` → `uploadOne(file, { uploadKind: 'layout', projectId })` → `assignPlanAction(projectId, url, unitIds)`.
9. Report per-page outcome; a failed page must not stop the others.
10. Render nothing wider than its container at 375px — the tile grid is 3 across on mobile, per `docs/DESIGN.md`.

There is deliberately **no crop control**. A page is used whole or not at all, so a unit plan can never be manufactured from a floor plate.

Use `Button` and `ErrorText` from `@/components/ui` so the controls match the rest of the app.

- [ ] **Step 5: Link it from the project page**

In `src/app/(staff)/(shell)/projects/[id]/page.tsx`, inside the existing `{actor.role === 'ADMIN' ? (...) : null}` block that already renders `<HeroImageForm .../>`, add below it:

```tsx
<a
  href={`/projects/${project.id}/plans/import`}
  className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-muted underline"
>
  Import floor plans from a PDF
</a>
```

- [ ] **Step 6: Typecheck and run the suite**

Run: `npm run typecheck`
Expected: no output.

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 7: Build, to prove the worker resolves**

Run: `npm run build`
Expected: build succeeds. **This is the step that catches the known `pdf.js` worker risk** — a `workerSrc` the bundler cannot resolve fails here, not at runtime. If it fails, stop and report rather than falling back to main-thread rendering, which freezes the tab on a large PDF.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json "src/app/(staff)/(shell)/projects/[id]"
git commit -m "feat(plans): import floor plans from a developer's PDF"
```

---

## Task 6: Verify against the Dev branch

Automated tests cover the pure logic and every refusal in the service. They cannot cover canvas rendering, so this is done by hand, once.

- [ ] **Step 1: Confirm the target database**

Run: `npm run db:which`
Expected: the **green Dev** banner. If it prints the red PRODUCTION banner, stop — `.env` has drifted again.

- [ ] **Step 2: Start the app**

Run: `npm run dev`

- [ ] **Step 3: Walk it through**

Sign in as `admin@sunrise.test` / `password123`, open a project, follow *Import floor plans from a PDF*, and check:

1. Every page appears as a thumbnail; the PDF itself never appears in the network tab.
2. A page reading "3 BEDROOM" pre-ticks the 3-bed group — and can be un-ticked.
3. Confirming uploads only the ticked pages.
4. Each chosen unit's page shows the drawing, and its floor-plan PDF downloads with the drawing embedded.
5. `/audit` shows **one** entry per page assigned, reading *"… assigned a floor plan to N units in …"*, linking to the project.

- [ ] **Step 4: Confirm an agent cannot reach it**

Sign in as `agent@sunrise.test` / `password123` and open `/projects/<id>/plans/import` directly.
Expected: refused by `requireAdmin`, not rendered.

- [ ] **Step 5: Commit anything the walk-through corrected**

```bash
git add -A
git commit -m "fix(plans): corrections from the import walk-through"
```

---

## Self-review

**Spec coverage:** browser-side rendering → Task 5; whole pages only, no crop → Tasks 5, 6; confirm before writing → Task 5; suggestion never auto-applied → Tasks 1, 5; group assignment with no schema change → Task 3; reuse of the existing upload path → Task 4; one audit entry per batch → Tasks 2, 3; org and project scoping → Task 3; blob-URL validation → Task 3; 2400px render target → Task 5; failure handling → Task 5 steps 4 and 9; tests → Tasks 1, 2, 3; worker risk surfaced at build → Task 5 step 7.

**Not covered by a task, by design:** amenity pages, project banner and unit renders are out of scope per the spec. The platform console is separate work.

**Added beyond the spec:** Task 4 (shared upload helper — the second caller made a copy the alternative) and the no-blob-sweep decision, which the spec did not reach and which the group-assignment model forces.

**Type consistency:** `suggestUnitsForPage(text, units)` and `SuggestableUnit { id, bedrooms }` are used as defined in Tasks 1 and 5. `assignLayoutToUnits(actor, { projectId, imageUrl, unitIds })` returning `{ assigned }` matches Tasks 3 and 5. `uploadOne(file, target)` matches Tasks 4 and 5. The action string `'unit.layout_assigned'` is identical in Tasks 2, 3 and the `MUST_RECORD` row. `entityType: 'Project'` is a member of the existing `AuditEntityType` union.
