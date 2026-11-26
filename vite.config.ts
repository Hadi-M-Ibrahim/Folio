import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pdfPackage from 'pdfjs-dist/package.json' with { type: 'json' };
import deployment from './vercel.json';

export default defineConfig({
  plugins: [react(), {
    name: 'pdf-reader-assets',
    apply: 'build',
    async generateBundle() {
      // PDF.js looks these up by their original names when decoding a page.
      for (const folder of ['build', 'cmaps', 'standard_fonts', 'wasm']) {
        const directory = 'node_modules/pdfjs-dist/' + folder;
        const files = (await this.fs.readdir(directory)).filter((name) =>
          /^[\w.-]+$/.test(name) && /(?:^LICENSE|^pdf\.worker\.min\.mjs$|\.bcmap$|\.pfb$|\.ttf$|_nowasm_fallback\.js$)/.test(name));
        await Promise.all(files.map(async (name) => {
          this.emitFile({ type: 'asset', fileName: `assets/pdfjs-${pdfPackage.version}/${folder}/${name}`,
            source: await this.fs.readFile(directory + '/' + name) });
        }));
      }
    },
  }],
  server: { proxy: { '/api/review': { target: 'http://127.0.0.1:8000', changeOrigin: false } } },
  preview: {
    headers: Object.fromEntries(deployment.headers
      .filter((rule) => rule.source === '/(.*)')
      .flatMap((rule) => rule.headers.map(({ key, value }) => [key, value]))),
  },
});
