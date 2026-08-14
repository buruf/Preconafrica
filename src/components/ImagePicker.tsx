'use client'

import { useId, useRef, useState } from 'react'
import { MediaImage, type MediaKind } from '@/components/media'
import { CONTROL_CLASS } from '@/components/ui'
import { MAX_UPLOAD_BYTES, type UploadKind } from '@/domain/uploads'

/**
 * The upload control, in the two shapes this app needs: one image, and a list of
 * them.
 *
 * Imagery used to be a URL an admin pasted, which asked a developer standing in
 * front of the building they are selling to first host the photo somewhere else.
 * These controls put a file picker where that box was — but they *keep* the box,
 * folded away under "or paste a link", because every row in the database today
 * holds an external URL, a marketing team that already has a CDN should not be
 * made to re-upload into ours, and the pasted path is still fully validated by
 * `checkImageUrl` on the server. Upload is the default; paste is the escape
 * hatch.
 *
 * What crosses to the server is unchanged either way: one string per field, in
 * the same input, read by the same action, validated by the same schema. An
 * uploaded image is simply a URL we happen to own. That is what makes the PDFs,
 * the SSRF guard, `MediaImage` and every placeholder work untouched.
 *
 * Three design rules from docs/DESIGN.md are load-bearing here and are why this
 * is a component rather than a bare `<input type="file">` per form:
 *
 *   - every control clears 44px, including the file picker, which browsers
 *     render at about 24px if you let them;
 *   - the preview is `MediaImage`, so an empty slot is the same dashed
 *     placeholder the rest of the app draws and the layout does not move when an
 *     image appears;
 *   - nothing scrolls sideways at 375px — the buttons wrap, the preview is
 *     capped by its container rather than by a pixel width.
 */

/** Never in the path, but a browser's file dialog should still filter. */
const ACCEPT = 'image/png,image/jpeg,image/webp'

interface UploadTarget {
  uploadKind: UploadKind
  projectId?: string
  unitId?: string
}

/**
 * One file to the upload route, one URL back.
 *
 * The size check here is a courtesy, not the guard: the browser knows the size
 * without a round trip, so telling someone their 40MB TIFF is too big should not
 * cost them a 40MB upload first. The server checks the declared size *and* then
 * the real buffer, and sniffs the magic bytes, because none of this is
 * trustworthy.
 */
async function uploadOne(file: File, target: UploadTarget): Promise<string> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `"${file.name}" is ${Math.round((file.size / (1024 * 1024)) * 10) / 10}MB. ` +
        `Images must be under ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.`
    )
  }

  const body = new FormData()
  body.set('kind', target.uploadKind)
  if (target.projectId) body.set('projectId', target.projectId)
  if (target.unitId) body.set('unitId', target.unitId)
  body.set('file', file)

  let response: Response
  try {
    response = await fetch('/api/uploads/images', { method: 'POST', body })
  } catch {
    throw new Error('The upload could not reach the server. Check your connection and try again.')
  }

  const payload = (await response.json().catch(() => null)) as { url?: string; error?: string } | null
  if (!response.ok || !payload?.url) {
    // The server's own sentence wherever there is one — "that file is not a
    // PNG, JPEG or WebP image" is worth far more than "upload failed".
    throw new Error(payload?.error ?? 'That upload failed. Try again.')
  }
  return payload.url
}

/* ------------------------------------------------------------- primitives */

/**
 * The picker itself: a `<label>` drawn as a secondary button with the real input
 * visually hidden inside it.
 *
 * A `<label>` rather than a button calling `.click()` on a hidden input, because
 * the label *is* the native affordance — it works with the keyboard, it is
 * announced as the file input's name, and it needs no JavaScript to open the
 * dialog. `sr-only` and not `display:none`: a hidden input is not focusable, and
 * a keyboard user would have no way to reach it.
 */
function PickerButton({
  inputId,
  children,
  multiple,
  busy,
  onFiles
}: {
  inputId: string
  children: string
  multiple?: boolean
  busy: boolean
  onFiles: (files: File[]) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <label
      htmlFor={inputId}
      className={`inline-flex min-h-11 cursor-pointer items-center justify-center rounded-btn border border-line bg-surface px-4 text-sm font-semibold text-navy-900 transition-colors hover:bg-page active:bg-page ${
        busy ? 'pointer-events-none opacity-50' : ''
      }`}
    >
      {busy ? 'Uploading…' : children}
      <input
        id={inputId}
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple={multiple}
        disabled={busy}
        className="sr-only"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          // Cleared immediately so picking the *same* file again still fires a
          // change event — the ordinary case after an upload failed once.
          if (inputRef.current) inputRef.current.value = ''
          if (files.length) onFiles(files)
        }}
      />
    </label>
  )
}

/** A quiet text button at the tap-target floor. Used for Remove and the disclosure. */
function TextButton({
  onClick,
  children,
  expanded,
  tone = 'muted'
}: {
  onClick: () => void
  children: string
  expanded?: boolean
  tone?: 'muted' | 'danger'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      className={`inline-flex min-h-11 items-center px-1 text-sm font-semibold underline ${
        tone === 'danger' ? 'text-status-overdue-text' : 'text-muted'
      }`}
    >
      {children}
    </button>
  )
}

function PickerError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p role="alert" className="text-[13px] font-medium text-status-overdue-text">
      {message}
    </p>
  )
}

/* ----------------------------------------------------------- single image */

export function ImagePicker({
  name,
  label,
  hint,
  uploadKind,
  previewKind,
  previewClassName = '',
  previewAlt,
  previewLabel,
  initialUrl,
  projectId,
  unitId,
  pickLabel = 'Choose a photo',
  className = ''
}: {
  /** The form field the action reads — `heroImageUrl`, `layoutImageUrl`, `logoUrl`. */
  name: string
  label: string
  hint?: string
  uploadKind: UploadKind
  /** Which placeholder and aspect ratio the preview uses. */
  previewKind: MediaKind
  previewClassName?: string
  previewAlt: string
  /**
   * Overrides what the empty placeholder says. The logo borrows the layout
   * kind's 4:3 box, and without this it would announce itself as "Unit layout"
   * on the team page.
   */
  previewLabel?: string
  initialUrl: string | null
  projectId?: string
  unitId?: string
  pickLabel?: string
  className?: string
}) {
  const inputId = useId()
  const [value, setValue] = useState(initialUrl ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pasting, setPasting] = useState(false)

  async function handleFiles(files: File[]) {
    setError(null)
    setBusy(true)
    try {
      setValue(await uploadOne(files[0], { uploadKind, projectId, unitId }))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That upload failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={className}>
      <p className="mb-1 text-[13px] font-medium text-ink">{label}</p>

      {/* One column below `sm:`: a preview beside a button at 375px leaves
          neither enough room. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,12rem)_1fr] sm:items-start">
        <MediaImage
          kind={previewKind}
          src={value || null}
          alt={previewAlt}
          label={previewLabel}
          className={previewClassName}
        />

        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <PickerButton inputId={inputId} busy={busy} onFiles={handleFiles}>
              {value ? 'Replace' : pickLabel}
            </PickerButton>

            {value ? (
              // Clears the field only. The stored blob is deleted by the
              // *action*, after the save succeeds — removing it here would
              // destroy the image of an admin who then closed the form without
              // saving.
              <TextButton tone="danger" onClick={() => setValue('')}>
                Remove
              </TextButton>
            ) : null}
          </div>

          <PickerError message={error} />
          {hint ? <p className="text-xs text-muted">{hint}</p> : null}

          <div>
            <TextButton expanded={pasting} onClick={() => setPasting((open) => !open)}>
              {pasting ? 'Hide the link box' : 'or paste a link'}
            </TextButton>
            {pasting ? (
              <input
                type="url"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="https://…/photo.jpg"
                aria-label={`${label} — paste an https link`}
                className={`${CONTROL_CLASS} mt-1`}
              />
            ) : null}
          </div>
        </div>
      </div>

      {/* The only thing the form actually submits. Whether it was uploaded or
          pasted, the server sees one string in the field it has always read. */}
      <input type="hidden" name={name} value={value} />
    </div>
  )
}

/* -------------------------------------------------------- several images */

export function ImagePickerList({
  name,
  label,
  hint,
  max,
  initialUrls,
  projectId,
  unitId,
  altPrefix,
  className = ''
}: {
  /** `renderImageUrls` — submitted as one newline-separated string, unchanged. */
  name: string
  label: string
  hint?: string
  max: number
  initialUrls: string[]
  projectId: string
  unitId: string
  altPrefix: string
  className?: string
}) {
  const inputId = useId()
  const [urls, setUrls] = useState<string[]>(initialUrls)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pasting, setPasting] = useState(false)

  async function handleFiles(files: File[]) {
    setError(null)

    // The cap is enforced here as well as in `parseRenderUrls` on the server,
    // for a reason that is not belt-and-braces: uploading nine files and then
    // being told the ninth is one too many has already spent the bytes. The
    // server's copy is still the one that decides.
    const room = max - urls.length
    if (room <= 0) {
      setError(`A unit can carry at most ${max} renders. Remove one first.`)
      return
    }
    const accepted = files.slice(0, room)

    setBusy(true)
    // Sequential, and this is what "order preserved" means: the list ends up in
    // the order the files were picked, not the order the uploads happened to
    // finish in. It also keeps a phone on a weak connection from opening four
    // concurrent multi-megabyte uploads.
    for (const file of accepted) {
      try {
        const url = await uploadOne(file, { uploadKind: 'render', projectId, unitId })
        setUrls((current) => (current.includes(url) ? current : [...current, url]))
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'That upload failed.')
        // Stop at the first failure rather than pressing on: whatever went
        // wrong (offline, store down, over the size cap) is likely to apply to
        // the rest too, and the ones already uploaded are kept.
        break
      }
    }
    setBusy(false)

    if (files.length > accepted.length) {
      setError(`Only ${accepted.length} more would fit — a unit can carry at most ${max} renders.`)
    }
  }

  return (
    <div className={className}>
      <p className="mb-1 text-[13px] font-medium text-ink">{label}</p>

      {urls.length ? (
        <ul className="mb-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {urls.map((url, index) => (
            <li key={url}>
              <MediaImage
                kind="render"
                src={url}
                alt={`${altPrefix} (${index + 1} of ${urls.length})`}
              />
              {/* Per-image, so removing the second of three does not cost the
                  other two an upload. */}
              <TextButton
                tone="danger"
                onClick={() => setUrls((current) => current.filter((kept) => kept !== url))}
              >
                Remove
              </TextButton>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="space-y-2">
        <PickerButton inputId={inputId} multiple busy={busy} onFiles={handleFiles}>
          {urls.length ? 'Add more renders' : 'Choose renders'}
        </PickerButton>

        <PickerError message={error} />
        {hint ? <p className="text-xs text-muted">{hint}</p> : null}

        <div>
          <TextButton expanded={pasting} onClick={() => setPasting((open) => !open)}>
            {pasting ? 'Hide the link box' : 'or paste links'}
          </TextButton>
          {pasting ? (
            <textarea
              rows={3}
              value={urls.join('\n')}
              onChange={(event) =>
                setUrls(
                  event.target.value
                    .split(/\r?\n/)
                    .map((line) => line.trim())
                    .filter(Boolean)
                )
              }
              placeholder={'https://…/living.jpg\nhttps://…/kitchen.jpg'}
              aria-label={`${label} — one https link per line`}
              // text-base for the same reason `CONTROL_CLASS` uses it: under
              // 16px, iOS Safari zooms the whole page on focus.
              className="mt-1 w-full rounded-btn border border-line bg-surface p-3 font-mono text-base text-ink outline-none placeholder:text-muted focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
            />
          ) : null}
        </div>
      </div>

      {/* Newline-separated, which is exactly the shape `RenderUrlsField` has
          always parsed — so removing the textarea from the form changed nothing
          about the wire format or the server. */}
      <input type="hidden" name={name} value={urls.join('\n')} />
    </div>
  )
}
