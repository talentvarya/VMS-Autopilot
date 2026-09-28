import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// fileURLToPath gives backslashes on Windows; Vite aliases want forward slashes.
const toPosix = (p: string) => p.split('\\').join('/');
const nodeModules = toPosix(fileURLToPath(new URL('./node_modules', import.meta.url)));
const src = toPosix(fileURLToPath(new URL('./src', import.meta.url)));

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${src}/` },
      // Test-only: lets tests/dashboard/fidelity.test.tsx load the approved, untouched UI.
      { find: /^@approved-interface\//, replacement: `${toPosix(fileURLToPath(new URL('../interface/src', import.meta.url)))}/` },
      // The fidelity test renders the untouched interface/ source, which has no node_modules
      // of its own. Point its React and icon imports at this app's copies (same versions).
      { find: /^(react|react-dom|lucide-react)(\/.*)?$/, replacement: `${nodeModules}/$1$2` },
    ],
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
