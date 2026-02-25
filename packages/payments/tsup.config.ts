import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'types/index': 'src/types/index.ts',
    'providers/interfaces/index': 'src/providers/interfaces/index.ts',
    'repository/interfaces/index': 'src/repository/interfaces/index.ts',
    'services/index': 'src/services/index.ts',
    'config/index': 'src/config/index.ts',
    'utils/index': 'src/utils/index.ts',
    'factory': 'src/factory.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
});
