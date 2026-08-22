'use client'

import { useRef, useState, useTransition } from 'react'
import { Button, ErrorText } from '@/components/ui'
import { uploadOne } from '@/components/upload-client'
import {
  addProjectImageAction,
  captionProjectImageAction,
  removeProjectImageAction
} from '../actions'

/**
 * The shared-amenity gallery: the gym, the pool, the lobby, the landscaping.
 *
 * Edited one photograph at a time rather than as a form that saves everything
 * at once. That matches how it is actually used — an admin adds the pool photo
 * today and fixes a caption next week — and it means a failed upload costs one
 * photo rather than the whole set.
 *
 * The caption saves on blur, which is the one interaction worth explaining:
 * a Save button per photo would be a wall of buttons, and saving on every
 * keystroke would be a write per character. Blur is when someone has finished
 * with a field.
 */

interface GalleryImage {
  id: string
  url: string
  caption: string | null
}

const ACCEPT = 'image/png,image/jpeg,image/webp'

export function GalleryForm({
  projectId,
  images
}: {
  projectId: string
  images: GalleryImage[]
}) {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  async function add(files: FileList) {
    setError(undefined)
    setBusy(true)

    try {
      // Sequential, not concurrent. Someone picking eight photos on a phone
      // would otherwise open eight uploads at once on a connection that cannot
      // carry them, and the failure mode is all of them timing out rather than
      // the first few succeeding.
      for (const file of Array.from(files)) {
        const url = await uploadOne(file, { uploadKind: 'gallery', projectId })
        // The filename as a first caption: "rooftop-pool.jpg" becomes "rooftop
        // pool", which is right often enough to save typing and is editable
        // when it is not.
        const suggested = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim()
        const failure = await addProjectImageAction(projectId, url, suggested)
        if (failure) {
          setError(failure)
          break
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That photo could not be uploaded.')
    } finally {
      setBusy(false)
      // Cleared so picking the same file again still fires a change event.
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  return (
    <div className="mt-3">
      <h3 className="text-sm font-semibold text-ink">Shared spaces</h3>
      <p className="text-xs text-muted">
        The gym, the pool, the lobby — anything the whole development shares. Buyers see these on
        every unit.
      </p>

      {images.length > 0 ? (
        <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {images.map((image) => (
            <li key={image.id} className="rounded-xl border border-line p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image.url}
                alt={image.caption ?? 'Shared space'}
                className="aspect-[4/3] w-full rounded-lg object-cover"
              />
              <input
                defaultValue={image.caption ?? ''}
                placeholder="Caption"
                maxLength={120}
                aria-label="Caption"
                className="mt-2 min-h-11 w-full rounded-lg border border-line px-2 text-sm text-ink"
                onBlur={(event) => {
                  const next = event.target.value
                  if (next === (image.caption ?? '')) return
                  start(async () => {
                    setError(await captionProjectImageAction(projectId, image.id, next))
                  })
                }}
              />
              <button
                type="button"
                disabled={pending}
                className="mt-1 min-h-11 text-xs font-semibold text-[#B91C1C] underline"
                onClick={() => {
                  const ok = window.confirm(
                    `Remove ${image.caption ? `“${image.caption}”` : 'this photo'}? The file is deleted and cannot be recovered.`
                  )
                  if (!ok) return
                  start(async () => {
                    setError(await removeProjectImageAction(projectId, image.id))
                  })
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <input
        ref={fileInput}
        type="file"
        accept={ACCEPT}
        multiple
        className="sr-only"
        onChange={(event) => {
          const picked = event.target.files
          if (picked && picked.length > 0) void add(picked)
        }}
      />
      <Button
        type="button"
        variant="secondary"
        className="mt-3"
        disabled={busy || pending}
        onClick={() => fileInput.current?.click()}
      >
        {busy ? 'Uploading…' : images.length > 0 ? 'Add more photos' : 'Add photos'}
      </Button>

      <ErrorText>{error}</ErrorText>
    </div>
  )
}
