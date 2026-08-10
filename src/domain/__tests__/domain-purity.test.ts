import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const DOMAIN_DIR = path.resolve(__dirname, '..')
const FORBIDDEN = [
  '@prisma/client',
  '@/server',
  'next/',
  'node:fs',
  'resend'
]

function domainSourceFiles(): string[] {
  return readdirSync(DOMAIN_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(DOMAIN_DIR, f))
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Matches the module specifier immediately after any of:
//   from '...'      from "..."
//   require('...')  require("...")
//   import('...')   import("...")
// regardless of quote style, so `forbidden` entries that are only prefixes
// (e.g. 'next/', '@/server') still match specifiers like '@/server/db'.
function forbiddenImportPattern(forbidden: string): RegExp {
  const escaped = escapeRegExp(forbidden)
  return new RegExp(`(?:from\\s+|require\\(\\s*|import\\(\\s*)['"]${escaped}`)
}

describe('domain purity', () => {
  it('has domain source files to check', () => {
    expect(domainSourceFiles().length).toBeGreaterThan(0)
  })

  it('imports no I/O or persistence modules', () => {
    for (const file of domainSourceFiles()) {
      const src = readFileSync(file, 'utf8')
      for (const forbidden of FORBIDDEN) {
        expect(
          forbiddenImportPattern(forbidden).test(src),
          `${path.basename(file)} must not import ${forbidden}`
        ).toBe(false)
      }
    }
  })

  it('never reads the clock', () => {
    for (const file of domainSourceFiles()) {
      const src = readFileSync(file, 'utf8')
      expect(src, `${path.basename(file)} must not call Date.now()`).not.toContain('Date.now(')
      expect(src, `${path.basename(file)} must not call new Date()`).not.toMatch(/new Date\(\s*\)/)
    }
  })
})
