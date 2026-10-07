import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packages = fileURLToPath(new URL('./packages/', import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against the TypeScript sources, so `npm test` works without a build.
    alias: [
      // Subpath entry points: @fluxgate/http/express → packages/http/src/express.ts
      { find: /^@fluxgate\/http\/(.+)$/, replacement: `${packages}http/src/$1.ts` },
      // Package roots: @fluxgate/core → packages/core/src/index.ts
      { find: /^@fluxgate\/(core|redis|http|client|server)$/, replacement: `${packages}$1/src/index.ts` },
    ],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
