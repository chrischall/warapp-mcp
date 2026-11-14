import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Refuses every outbound connection but loopback (see the file's header).
    setupFiles: ['./tests/setup/no-network.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**'],
      // #133: the level at the time (97.1 / 91.3 / 97.5 / 98.4) less a small margin, so coverage
      // cannot slide unnoticed. Raise these as coverage rises; never lower them to pass.
      thresholds: { statements: 96, branches: 90, functions: 96, lines: 97 },
    },
  },
});
