import { defineConfig } from 'vitest/config';

// Some tests synthesise whole stacks, bundling every function with esbuild; that takes several seconds on CI runners.
export default defineConfig({ test: { testTimeout: 60_000 } });
