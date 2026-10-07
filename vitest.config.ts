import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against the TypeScript sources, so `npm test` works without a build.
    alias: {
      '@fluxgate/core': src('core'),
      '@fluxgate/redis': src('redis'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
