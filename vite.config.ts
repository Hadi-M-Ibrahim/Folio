import { build, defineConfig } from 'vite';
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
    name: 'standalone-pdf-export',
    apply: 'build',
    async buildStart() {
      // An old tab can request its first export after a deployment. Bundle all imports, including fonts.
      const result = await build({
        configFile: false, publicDir: false,
        build: { write: false, rollupOptions: {
          input: 'src/review/exportResponsePdf.ts', preserveEntrySignatures: 'strict',
          output: { inlineDynamicImports: true, entryFileNames: 'downloads/responses-v1.js' },
        } },
      });
      if (!('output' in result)) this.error('Expected a single PDF exporter build.');
      const [entry] = result.output;
      if (result.output.length !== 1 || entry.type !== 'chunk' || entry.imports.length || entry.dynamicImports.length) {
        this.error('The PDF exporter must be a standalone module.');
      }
      for (const id of entry.moduleIds) {
        if (!id.startsWith('\0')) this.addWatchFile(id.split('?')[0]);
      }
      this.emitFile({ type: 'asset', fileName: entry.fileName, source: entry.code });
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
  server: { proxy: { '/api/review': { target: 'http://127.0.0.1:8000', changeOrigin: false } } },
  preview: {
    headers: Object.fromEntries(deployment.headers
      .filter((rule) => rule.source === '/(.*)')
      .flatMap((rule) => rule.headers.map(({ key, value }) => [key, value]))),
  },
});
