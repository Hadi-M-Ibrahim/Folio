import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

test('only one tab can take over an interrupted review and save its next checkpoint', async ({ page, context }) => {
  // Load the real storage module in two independent browser realms with the same IndexedDB.
  const entry = fileURLToPath(new URL('../src/review/localReviews.ts', import.meta.url));
  const bundle = await build({
    configFile: false, logLevel: 'silent',
    build: { write: false, lib: { entry, formats: ['es'] } },
  });
  const module = bundle[0].output.find(file => file.type === 'chunk' && file.isEntry);
  await context.route('**/review-store.js', route => route.fulfill({ contentType: 'text/javascript', body: module.code }));
  await context.route('**/storage-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
  const tabs = [page, await context.newPage()];
  const owners = ['first tab', 'second tab'];
  await Promise.all(tabs.map(async tab => {
    await tab.goto('/storage-test');
    await tab.evaluate(async () => { window.store = await import('/review-store.js'); });
  }));

  const record = {
    key: 'inspection', title: 'Inspection', mode: 'questionnaire', status: 'running',
    recipe: { input: { mode: 'questionnaire', questions: ['Who signs?'], documents: [] }, renderItemSubset: false },
  };
  await page.evaluate(record => window.store.createSavedReview(record, 'original'), record);
  // A hard close leaves the catalog marked running. Both contenders saw the same owner and status.
  const claims = await Promise.all(tabs.map((tab, i) => tab.evaluate(owner =>
    window.store.claimSavedReview('inspection', 'original', owner, 'running'), owners[i])));
  expect(claims.filter(Boolean)).toHaveLength(1);
  const winner = claims.indexOf(true);
  const owner = owners[winner];
  const checkpoint = { completed: [], subdivided: ['first part'] };
  expect(await tabs[winner].evaluate(({ record, owner, checkpoint }) =>
    window.store.saveJobState({ ...record, status: 'paused', checkpoint }, owner), { record, owner, checkpoint })).toBe(true);
  const other = tabs[1 - winner];
  expect(await other.evaluate(record => window.store.saveJobState(record, 'original'), record)).toBe(false);
  expect(await other.evaluate(owner => window.store.claimSavedReview('inspection', owner, 'late', 'running'), owner)).toBe(false);
  const saved = await page.evaluate(() => window.store.readSavedReview('inspection'));
  expect(saved.record).toMatchObject({ status: 'paused', checkpoint });
});
