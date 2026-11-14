// The suite run that captures planTurn inputs for the golden corpus (see capture.setup.ts):
//   GOLDEN_CAPTURE_DIR=<dir> npx vitest run --config tests/analysis/golden/capture.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup/no-network.ts', './tests/analysis/golden/capture.setup.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/analysis/golden/**', 'tests/analysis/planner-golden.test.ts'],
  },
});
