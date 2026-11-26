import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import deployment from './vercel.json';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api/review': { target: 'http://127.0.0.1:8000', changeOrigin: false } } },
  preview: {
    headers: Object.fromEntries(deployment.headers
      .filter((rule) => rule.source === '/(.*)')
      .flatMap((rule) => rule.headers.map(({ key, value }) => [key, value]))),
  },
});
