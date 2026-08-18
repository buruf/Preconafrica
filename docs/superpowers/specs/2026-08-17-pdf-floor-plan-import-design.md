# PDF floor-plan import — design

**Date:** 2026-08-17
**Status:** approved, not yet implemented

## The problem

A developer hands over a brochure PDF. Somewhere inside it — page 22 and page 23
in the Khaleel Homes pack — are the unit floor plans. Today the only way to get
those onto the site is to open the PDF in a reader, export those pages as images
by hand, and upload them one unit at a time. Khaleel has 64 units.

The upload pipeline accepts PNG, JPEG and WebP only (`UploadedImageFormat` in
`src/domain/uploads.ts`), and correctly refuses anything else by magic bytes. So
"upload the PDF" is not a small change to an existing control; it is a feature
that does not exist.

### What this is not

It is not a platform console. Khaleel Homes is a separate developer from Sunrise
Developments and will eventually need its own organisation, but a platform admin
would have exactly the same three image formats available as an org admin does.
The console is a different piece of work, tracked separately.

## Constraints that shape the design

**A page is used whole or not at all.** No crop tool, no region selector. The
standing instruction is that a unit plan is never manufactured out of a floor
plate — if the developer's PDF has only plates, the import yields nothing for
those units, and that is the correct outcome. The developer uploads a per-unit
drawing or the site does without one.

**Nothing is written until the admin confirms.** Page text may *suggest* a
mapping; a suggestion is never an action already taken.

**Vercel's serverless request body limit is about 4.5MB.** Developer brochures
are routinely 20–50MB. Any design that posts the PDF to the server has to solve
this before it can do anything else.

**No PDF reader exists in the project.** `@react-pdf/renderer` writes PDFs and
cannot read them. `sharp` is server-side and does not handle PDFs.

## Approach: render in the browser

The PDF never leaves the admin's machine. `pdf.js` renders each page to a canvas
locally; only the chosen pages upload, as ordinary PNGs, through the upload
endpoint that already exists.

Considered and rejected:

- **Server-side rasterization.** Needs a direct-to-blob upload to dodge the body
  cap, then either a native module Vercel will not have or `pdf.js` plus a canvas
  shim inside a function with a memory ceiling and a timeout. More failure modes,
  and they surface after the upload rather than in front of the user.
- **No import at all.** Viable for two drawings; the tedium bites across many
  units, many projects, or many developers.

Cost of the chosen approach: a ~350kB library on one admin page, dynamically
imported so no other route carries it, and page rendering that is quick on a
laptop and slower on a phone.

## Where it lives

`/projects/[id]/plans/import`, linked from the project page beside the existing
building-photo control.

A server component calls `requireAdmin()` and then renders the client importer.
The guard lives in the server wrapper, never inside the client component — the
same split `/projects/new` needed after it shipped without one.

## The flow

1. Choose the PDF. It stays local. Nothing uploads.
2. `pdf.js` renders every page to a thumbnail grid, numbered.
3. The admin ticks the pages that are unit plans.
4. For each ticked page, a unit picker grouped by bedroom count — *All
   3-bedroom (24)*, *All 4-bedroom (16)* — plus individual units for one-offs.
   A page whose text reads "3 BEDROOM" pre-ticks that group as a suggestion.
5. On confirm: each chosen page uploads **once** as a PNG, and the resulting URL
   is written to every unit in its group.

Pages render with their long edge at `IMAGE_PROFILES.layout.maxEdge` (2400px),
so the browser does not spend time on pixels `downscale.ts` will immediately
discard. That profile also carries a 300kB budget — the PDF embed limit — and
its ladder tries PNG first and falls back to JPEG for dense drawings, so an
imported page compresses exactly as a hand-uploaded one does.

## Mapping model

One drawing serves many units. Rather than introduce a `UnitType` record, the
import writes the same `layoutImageUrl` onto each unit in the chosen group.

- **No schema change**, and nothing downstream — the unit page, the per-unit
  floor-plan PDF — has to learn a new shape.
- **Accepted cost:** replacing the 3-bed drawing later means re-running the
  assign to push it out again. A `UnitType` would make that a single edit, at the
  price of a schema change plus reworking every reader of `layoutImageUrl`.

Revisit if type-level pricing or marketing copy ever lands, which would justify
the entity on its own.

## New code

| Unit | Purpose | Depends on |
|---|---|---|
| `src/domain/plan-import.ts` | Pure. Page text + units → suggested unit ids. | nothing |
| `PlanImporter.tsx` | Client: render, thumbnails, ticking, unit picker. | `pdfjs-dist` |
| `assignPlanToUnits` action | The only writer. | prisma, audit |
| `pdfjs-dist` | New dependency, dynamically imported. | — |

`plan-import.ts` performs no I/O and reads no clock, so it satisfies the existing
`domain-purity.test.ts`.

## Reused unchanged

`/api/uploads/images` (already `ADMIN`-guarded, takes `kind: 'layout'`, returns
`{ url }`), magic-byte sniffing, `sharp` downscaling, blob storage,
`Unit.layoutImageUrl`, the per-unit floor-plan PDF, and the unit page that
renders the drawing. Nothing downstream knows a plan arrived by import.

## The write

`assignPlanToUnits(projectId, imageUrl, unitIds)`:

- `requireAdmin()`.
- Every unit id re-checked as belonging to this project, in this org. The
  browser's list is never trusted.
- The image URL must be one the blob store issued, so a crafted request cannot
  point a unit's drawing at an arbitrary host.
- A single `updateMany` inside a transaction.
- **One** audit entry for the batch, not one per unit: *"assigned a floor plan to
  24 units in Khaleel Suites"*, with the unit names in `context`. Twenty-four
  near-identical rows would bury the log rather than inform it.

## Failure handling

| Situation | Behaviour |
|---|---|
| Password-protected, corrupt, or renamed non-PDF | `pdf.js` throws; plain message; nothing uploaded |
| More than ~100 pages | Confirm before rendering them all |
| Upload fails mid-batch | That page is not assigned; other pages unaffected |
| Page suggests two bedroom counts | No suggestion — never guess |

Each page is independent, so a failure never leaves half a group pointing at a
drawing the rest of the group lacks.

## Tests

- `plan-import.ts`: "3 BEDROOM" matches; "3 BEDROOMS" matches; a page naming two
  bedroom counts suggests nothing; a floor-plate page listing six unit numbers
  suggests nothing.
- `assignPlanToUnits`: another org's unit id refused; another project's unit id
  refused; a foreign image URL refused; the audit entry lands in the same
  transaction as the update.

Canvas rendering itself is kept thin and is not unit-tested — the logic worth
testing is deliberately pulled out into the pure module.

## Out of scope

Amenity pages, the project banner, and unit renders. The plumbing makes each easy
to add later; each needs its own answer about where a page lands, and none is
what blocks Khaleel today.

## Known risk

`pdf.js` needs a web worker, and wiring `workerSrc` through the Next bundler has
a history of being fiddly. If it resists, that gets reported rather than silently
worked around by rendering on the main thread, which would freeze the tab.

## Deferred consequence

Uploads are stored under `org/{orgId}/…`. Importing Khaleel's plans while the
project still sits inside Sunrise's organisation means those files keep a Sunrise
path even after the platform console moves the project out. The images keep
working; the paths are untidy. Accepted knowingly.
