import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  // Next compiles JSX with the automatic runtime (no `import React`); esbuild
  // defaults to classic and would throw "React is not defined" for any test
  // that transitively imports a .tsx module (e.g. the PDF components).
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // next-auth has to go through Vite's resolver rather than Node's, or the
    // `next/server` alias below never gets a chance to apply — Vitest leaves
    // externalised dependencies to Node's ESM resolution, which is exactly
    // what cannot resolve that extensionless specifier.
    server: { deps: { inline: ['next-auth'] } }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // `next` publishes no `exports` map, and next-auth (>= 5.0.0-beta.32)
      // imports `next/server` extensionless — see the @ts-expect-error on that
      // import in next-auth/lib/env.js. Next's own bundler resolves it by
      // trying `.js`; Node's ESM resolver, which is what Vitest uses for an
      // externalised dependency, does not, so every test that transitively
      // imports @/server/auth would fail to load. Pointing at the real file
      // keeps this a test-harness concern only — the app itself is built by
      // Next, where the bare specifier resolves.
      'next/server': path.resolve(__dirname, './node_modules/next/server.js')
    }
  }
})
