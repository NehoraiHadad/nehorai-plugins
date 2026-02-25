import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'core/index': 'src/core/index.ts',
    'repository/index': 'src/repository/index.ts',
    'auth/index': 'src/auth/index.ts',
    'service/index': 'src/service/index.ts',
    'adapters/index': 'src/adapters/index.ts',
    'sdk/index': 'src/sdk/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  external: ['zod'],
});
