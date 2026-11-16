// Single source of truth for the server version. release-please bumps the
// literal on the marked line (registered in release-please-config.json
// extra-files); every other module imports VERSION from here.
export const VERSION = '0.3.1'; // x-release-please-version
