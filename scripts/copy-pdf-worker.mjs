import { copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Put pdf.js's worker where the browser can fetch it, without the bundler in
 * the middle.
 *
 * `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)` is the
 * documented way to reference it, and it does not work here: webpack emits the
 * file as an asset and then hands it to Terser, which minifies it as a classic
 * script and fails on the `import`/`export` it contains. pdf.js v4 spawns its
 * worker with `{ type: 'module' }`, so the file has to arrive as a real ES
 * module — untouched.
 *
 * Copying it into `public/` sidesteps the pipeline entirely: Next serves it
 * verbatim from `/pdf.worker.min.mjs`.
 *
 * The copy happens on every install and again before every build, always from
 * the installed package. That is the point: a worker and an API from different
 * pdf.js versions throw at runtime, so the file must never be a committed
 * artifact that drifts from `package.json`. It is gitignored for the same
 * reason.
 *
 * The alternative — rendering on the main thread by leaving `workerSrc` unset —
 * was rejected: it freezes the tab for the length of a 40-page brochure.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const source = path.join(root, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs')
const targetDir = path.join(root, 'public')
const target = path.join(targetDir, 'pdf.worker.min.mjs')

try {
  mkdirSync(targetDir, { recursive: true })
  copyFileSync(source, target)
  console.log('  pdf.js worker copied to public/pdf.worker.min.mjs')
} catch (error) {
  // Not fatal on its own — but the importer cannot render a page without it,
  // so say plainly what is missing rather than letting it fail in a browser.
  console.error(
    `  Could not copy the pdf.js worker from ${source}.\n` +
      '  The PDF floor-plan importer will not be able to render pages.\n' +
      `  ${error instanceof Error ? error.message : String(error)}`
  )
  process.exitCode = 1
}
