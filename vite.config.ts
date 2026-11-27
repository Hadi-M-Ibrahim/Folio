import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { PageFrame } from './src/components/PageFrame';
import pdfPackage from 'pdfjs-dist/package.json' with { type: 'json' };
import deployment from './vercel.json';

export default defineConfig({
  plugins: [react(), {
    name: 'landing-html',
    transformIndexHtml: {
      order: 'pre',
      handler: html => html.replace('<!--folio-landing-->', () => renderToString(createElement(PageFrame, {}))),
    },
  }, {
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
  // An open review may request its first export after the next deployment.
  build: { rollupOptions: {
    input: { index: 'index.html', responsePdf: 'src/review/exportResponsePdf.ts' },
    preserveEntrySignatures: 'exports-only',
    output: {
      entryFileNames: chunk => chunk.name === 'responsePdf' ? 'downloads/responses-v1.js' : 'assets/[name]-[hash].js',
      manualChunks: id => id.includes('commonjsHelpers') || /\/src\/review\/(model|downloadFile)\.ts$/.test(id) ? 'shared' : undefined,
    },
  } },
  server: { proxy: { '/api/review': { target: 'http://127.0.0.1:8000', changeOrigin: false } } },
  preview: {
    headers: Object.fromEntries(deployment.headers
      .filter((rule) => rule.source === '/(.*)')
      .flatMap((rule) => rule.headers.map(({ key, value }) => [key, value]))),
  },
});
