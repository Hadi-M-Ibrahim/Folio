import { mergeConfig } from 'vite';
import folio from '../vite.config.ts';

export default mergeConfig(folio, {
  preview: { proxy: { '/api/review': { target: 'http://127.0.0.1:4178', changeOrigin: false } } },
});
