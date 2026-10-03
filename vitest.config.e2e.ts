import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Specs share one Postgres and scan global insert-only event/job tables: run files one at a time.
    fileParallelism: false,
  },
});
