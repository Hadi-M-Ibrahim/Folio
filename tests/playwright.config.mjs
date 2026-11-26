import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));

export default defineConfig({
  testDir: '.',
  testMatch: 'workflows.spec.mjs',
  outputDir: '../test-results',
  use: { baseURL: 'http://127.0.0.1:4177' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 850 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: [
    { command: 'python3 api/review.py', port: 8000, cwd, reuseExistingServer: !process.env.CI },
    {
      command: 'npm run preview -- --port 4177 --strictPort',
      url: 'http://127.0.0.1:4177', cwd, reuseExistingServer: !process.env.CI,
    },
  ],
});
