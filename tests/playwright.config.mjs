import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));

export default defineConfig({
  testDir: '.',
  testMatch: 'workflows.spec.mjs',
  outputDir: '../test-results',
  workers: 2,
  use: { baseURL: 'http://127.0.0.1:4177' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 850 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: [
    { command: 'python3 tests/browser_review_api.py', port: 4178, cwd },
    {
      command: 'npm run preview -- --config tests/vite.preview.config.mjs --port 4177 --strictPort',
      url: 'http://127.0.0.1:4177', cwd,
    },
  ],
});
