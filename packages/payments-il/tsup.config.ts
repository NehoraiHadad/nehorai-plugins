import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'hyp/index': 'src/providers/hyp/index.ts',
    'cardcom/index': 'src/providers/cardcom/index.ts',
    'routing/index': 'src/routing/index.ts',
    'factory': 'src/factory.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  external: ['@nehorai/payments', 'crypto'],
});
