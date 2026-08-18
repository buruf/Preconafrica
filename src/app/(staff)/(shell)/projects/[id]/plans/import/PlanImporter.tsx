'use client'

import { useState } from 'react'
import { Button, Card, ErrorText } from '@/components/ui'
import { uploadOne } from '@/components/upload-client'
import { suggestUnitsForPage } from '@/domain/plan-import'
import { assignPlanAction } from './actions'

/**
 * The import, in the browser.
 *
 * The PDF never leaves this device. `pdf.js` renders each page to a canvas
 * here, and only the pages the admin ticks are uploaded — as PNGs, through the
 * same route the image picker uses. A 50MB brochure is therefore not a problem
 * to solve; it is a file that was never sent.
 *
 * **A page is used whole or not at all.** There is deliberately no crop
 * control, no region selector, and no way to lift part of a drawing out of
 * another: a unit plan must never be manufactured from a floor plate. If the
 * developer's PDF only contains plates, this yields nothing for those units,
 * and that is the correct outcome — they upload a per-unit drawing or the site
 * does without one.
 *
 * Nothing is written until Confirm. The page's own text may *suggest* which
 * units it covers, and the suggestion arrives pre-ticked, but it is a tick the
 * admin can clear like any other.
 */

/** The long edge to render at: `IMAGE_PROFILES.layout.maxEdge`. Anything larger
 * is work the server's downscale immediately discards. */
const TARGET_EDGE = 2400

/** Rendering every page of a very long brochure is worth confirming first. */
const PAGES_BEFORE_CONFIRM = 100

interface PickableUnit {
  id: string
  name: string
  bedrooms: number
  hasPlan: boolean
}

interface RenderedPage {
  pageNumber: number
  /** A small preview, for the grid. The full-size render happens at confirm. */
  thumbnail: string
  text: string
  /** Kept so confirm can re-render at full size without re-parsing the file. */
  width: number
  height: number
}

type PageOutcome = { pageNumber: number; ok: boolean; message: string }

export function PlanImporter({
  projectId,
  units
}: {
  projectId: string
  units: PickableUnit[]
}) {
  const [pages, setPages] = useState<RenderedPage[]>([])
  const [chosen, setChosen] = useState<Map<number, Set<string>>>(new Map())
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState<string | undefined>()
  const [outcomes, setOutcomes] = useState<PageOutcome[]>([])
  const [file, setFile] = useState<File | null>(null)

  const bedroomCounts = [...new Set(units.map((unit) => unit.bedrooms))].sort((a, b) => a - b)

  async function loadPdfjs() {
    const pdfjs = await import('pdfjs-dist')
    // Served from our own origin, never a CDN — and as a plain static file
    // rather than a bundled asset. `new URL('pdfjs-dist/build/…', import.meta.url)`
    // is the documented form and it does not build here: webpack emits the
    // worker as an asset and Terser then minifies it as a classic script,
    // failing on the `import`/`export` it contains. pdf.js v4 spawns the worker
    // with `{ type: 'module' }`, so it has to arrive untouched.
    // `scripts/copy-pdf-worker.mjs` puts it in public/ on every install.
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
    return pdfjs
  }

  async function handleFile(picked: File) {
    setError(undefined)
    setOutcomes([])
    setPages([])
    setChosen(new Map())
    setFile(picked)
    setBusy('Reading the PDF…')

    try {
      const pdfjs = await loadPdfjs()
      const data = await picked.arrayBuffer()
      const doc = await pdfjs.getDocument({ data }).promise

      if (doc.numPages > PAGES_BEFORE_CONFIRM) {
        const go = window.confirm(
          `That PDF has ${doc.numPages} pages. Rendering them all may take a while on this device. Continue?`
        )
        if (!go) {
          setBusy(undefined)
          return
        }
      }

      const rendered: RenderedPage[] = []
      for (let n = 1; n <= doc.numPages; n++) {
        setBusy(`Rendering page ${n} of ${doc.numPages}…`)
        const page = await doc.getPage(n)
        const base = page.getViewport({ scale: 1 })

        const content = await page.getTextContent()
        const text = content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')

        // Thumbnails only for now — a 2400px canvas per page would exhaust
        // memory on a phone long before the admin has ticked anything.
        const scale = 220 / Math.max(base.width, base.height)
        const thumbnail = await renderToDataUrl(page, scale)

        rendered.push({
          pageNumber: n,
          thumbnail,
          text,
          width: base.width,
          height: base.height
        })
      }

      setPages(rendered)
    } catch (cause) {
      // A password-protected PDF, a corrupt one, and a renamed non-PDF all
      // land here. pdf.js's own message names which.
      setError(
        cause instanceof Error
          ? `That PDF could not be read: ${cause.message}`
          : 'That PDF could not be read.'
      )
    } finally {
      setBusy(undefined)
    }
  }

  function togglePage(page: RenderedPage) {
    setChosen((current) => {
      const next = new Map(current)
      if (next.has(page.pageNumber)) {
        next.delete(page.pageNumber)
      } else {
        // The suggestion, pre-ticked. `suggestUnitsForPage` returns nothing when
        // the page names two bedroom counts or none, so an ambiguous page opens
        // with an empty selection rather than a guess.
        next.set(page.pageNumber, new Set(suggestUnitsForPage(page.text, units)))
      }
      return next
    })
  }

  function toggleUnit(pageNumber: number, unitId: string) {
    setChosen((current) => {
      const next = new Map(current)
      const set = new Set(next.get(pageNumber) ?? [])
      if (set.has(unitId)) set.delete(unitId)
      else set.add(unitId)
      next.set(pageNumber, set)
      return next
    })
  }

  function toggleBedroomGroup(pageNumber: number, bedrooms: number) {
    setChosen((current) => {
      const next = new Map(current)
      const set = new Set(next.get(pageNumber) ?? [])
      const group = units.filter((unit) => unit.bedrooms === bedrooms)
      const allOn = group.every((unit) => set.has(unit.id))
      for (const unit of group) {
        if (allOn) set.delete(unit.id)
        else set.add(unit.id)
      }
      next.set(pageNumber, set)
      return next
    })
  }

  async function confirm() {
    if (!file) return
    setError(undefined)
    setOutcomes([])

    const work = [...chosen.entries()].filter(([, ids]) => ids.size > 0)
    if (work.length === 0) {
      setError('Tick at least one page, and the units it covers.')
      return
    }

    const results: PageOutcome[] = []

    try {
      const pdfjs = await loadPdfjs()
      const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise

      for (const [pageNumber, unitIds] of work) {
        setBusy(`Uploading page ${pageNumber}…`)
        try {
          const page = await doc.getPage(pageNumber)
          const base = page.getViewport({ scale: 1 })
          // Never upscale: a page already larger than the target renders at 1.
          const scale = Math.min(1, TARGET_EDGE / Math.max(base.width, base.height))
          const blob = await renderToPngBlob(page, scale)

          const image = new File([blob], `page-${pageNumber}.png`, { type: 'image/png' })
          const url = await uploadOne(image, { uploadKind: 'layout', projectId })

          const failure = await assignPlanAction(projectId, url, [...unitIds])
          results.push(
            failure
              ? { pageNumber, ok: false, message: failure }
              : {
                  pageNumber,
                  ok: true,
                  message: `assigned to ${unitIds.size} ${unitIds.size === 1 ? 'unit' : 'units'}`
                }
          )
        } catch (cause) {
          // Each page is independent, so one failure must not cost the others.
          results.push({
            pageNumber,
            ok: false,
            message: cause instanceof Error ? cause.message : 'That page could not be uploaded.'
          })
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The PDF could not be re-read.')
    } finally {
      setBusy(undefined)
      setOutcomes(results)
    }
  }

  return (
    <div className="mt-4 space-y-4">
      <Card>
        <label className="block text-sm font-semibold text-ink" htmlFor="plan-pdf">
          Developer&rsquo;s PDF
        </label>
        <input
          id="plan-pdf"
          type="file"
          accept="application/pdf"
          className="mt-2 block w-full text-sm"
          onChange={(event) => {
            const picked = event.target.files?.[0]
            if (picked) void handleFile(picked)
          }}
        />
        {busy ? <p className="mt-2 text-sm text-muted">{busy}</p> : null}
        <ErrorText>{error}</ErrorText>
      </Card>

      {pages.length > 0 ? (
        <>
          <p className="text-sm text-muted">
            {pages.length} pages. Tick the ones that are unit floor plans.
          </p>

          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
            {pages.map((page) => {
              const on = chosen.has(page.pageNumber)
              return (
                <button
                  key={page.pageNumber}
                  type="button"
                  onClick={() => togglePage(page)}
                  aria-pressed={on}
                  className={`rounded-xl border p-1 text-left ${
                    on ? 'border-teal-500 ring-2 ring-teal-500' : 'border-line'
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={page.thumbnail}
                    alt={`Page ${page.pageNumber}`}
                    className="w-full rounded-lg"
                  />
                  <span className="mt-1 block text-center text-xs font-semibold text-ink">
                    {page.pageNumber}
                  </span>
                </button>
              )
            })}
          </div>

          {[...chosen.keys()]
            .sort((a, b) => a - b)
            .map((pageNumber) => {
              const selected = chosen.get(pageNumber) ?? new Set<string>()
              return (
                <Card key={pageNumber}>
                  <h2 className="text-base font-semibold text-ink">
                    Page {pageNumber} covers
                  </h2>

                  <div className="mt-2 flex flex-wrap gap-2">
                    {bedroomCounts.map((bedrooms) => {
                      const group = units.filter((unit) => unit.bedrooms === bedrooms)
                      return (
                        <button
                          key={bedrooms}
                          type="button"
                          onClick={() => toggleBedroomGroup(pageNumber, bedrooms)}
                          className="min-h-11 rounded-lg border border-line px-3 text-sm font-semibold text-ink"
                        >
                          All {bedrooms}-bedroom ({group.length})
                        </button>
                      )
                    })}
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {units.map((unit) => {
                      const on = selected.has(unit.id)
                      return (
                        <button
                          key={unit.id}
                          type="button"
                          onClick={() => toggleUnit(pageNumber, unit.id)}
                          aria-pressed={on}
                          className={`min-h-11 rounded-lg border px-3 text-sm ${
                            on
                              ? 'border-navy-900 bg-navy-100 font-semibold text-ink'
                              : 'border-line text-muted'
                          }`}
                        >
                          {unit.name}
                          {/* Says so before the overwrite, not after. */}
                          {unit.hasPlan ? ' ·' : ''}
                        </button>
                      )
                    })}
                  </div>

                  <p className="mt-2 text-xs text-muted">
                    {selected.size} selected. A dot marks a unit that already has a plan — it
                    will be replaced.
                  </p>
                </Card>
              )
            })}

          <Button type="button" onClick={() => void confirm()} disabled={busy !== undefined}>
            {busy ?? 'Confirm and upload'}
          </Button>
        </>
      ) : null}

      {outcomes.length > 0 ? (
        <Card>
          <h2 className="text-base font-semibold text-ink">Result</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {outcomes.map((outcome) => (
              <li
                key={outcome.pageNumber}
                className={outcome.ok ? 'text-ink' : 'text-[#B91C1C]'}
              >
                Page {outcome.pageNumber} — {outcome.message}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  )
}

/* --------------------------------------------------------------- rendering */

interface RenderablePage {
  getViewport(options: { scale: number }): { width: number; height: number }
  render(options: {
    canvasContext: CanvasRenderingContext2D
    viewport: { width: number; height: number }
  }): { promise: Promise<void> }
}

function canvasFor(page: RenderablePage, scale: number) {
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)

  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser could not provide a canvas to render into.')

  return { canvas, context, viewport }
}

async function renderToDataUrl(page: RenderablePage, scale: number): Promise<string> {
  const { canvas, context, viewport } = canvasFor(page, scale)
  await page.render({ canvasContext: context, viewport }).promise
  return canvas.toDataURL('image/png')
}

async function renderToPngBlob(page: RenderablePage, scale: number): Promise<Blob> {
  const { canvas, context, viewport } = canvasFor(page, scale)
  await page.render({ canvasContext: context, viewport }).promise

  return new Promise<Blob>((resolve, reject) => {
    // PNG, not JPEG: linework and room labels are what a floor plan is, and the
    // server's `layout` profile already falls back to JPEG when a dense drawing
    // will not fit the 300kB embed budget.
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('That page could not be converted to an image.'))
    }, 'image/png')
  })
}
