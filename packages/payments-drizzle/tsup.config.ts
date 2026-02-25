import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'schema/index': 'src/schema/index.ts',
    'repositories/index': 'src/repositories/index.ts',
    'storage/index': 'src/storage/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  external: ['drizzle-orm', '@nehorai/payments'],
})
