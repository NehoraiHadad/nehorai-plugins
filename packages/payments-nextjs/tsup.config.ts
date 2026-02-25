import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'handlers/index': 'src/handlers/index.ts',
    'actions/index': 'src/actions/index.ts',
    'auth/index': 'src/auth/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['next', 'next/server', '@nehorai/payments', 'react', 'react-dom', 'zod'],
})
