import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  // Next compiles JSX with the automatic runtime (no `import React`); esbuild
  // defaults to classic and would throw "React is not defined" for any test
  // that transitively imports a .tsx module (e.g. the PDF components).
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') }
  }
})
