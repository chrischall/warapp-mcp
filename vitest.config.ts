import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Refuses every outbound connection but loopback (see the file's header).
    setupFiles: ['./tests/setup/no-network.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
