import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function report(page, name) {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name }).click();
  return readFile(await (await download).path(), 'utf8');
}

async function pasteSource(page, mode, text) {
  const guide = mode === 'guide';
  await page.getByRole('button', { name: guide ? 'Paste guide text' : 'Paste a question or list' }).click();
  await page.getByLabel(guide ? 'Guide text' : 'Questions', { exact: true }).fill(text);
}

async function addPolicy(page, name, text) {
  await page.getByLabel('Upload policy files').setInputFiles({
    name, mimeType: 'text/plain', buffer: Buffer.from(text),
  });
  await expect(page.getByRole('list', { name: 'Added policies' })).toContainText(name);
}

async function submitReview(page, mode) {
  const guide = mode === 'guide';
  await expect(page.getByText(guide ? /your guide.*Anthropic/i : /your questions.*Anthropic/i)).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  const response = page.waitForResponse('**/api/review');
  await page.getByRole('button', { name: guide ? 'Review obligations' : 'Find evidence' }).click();
  const received = await response;
  expect(received.request().postDataJSON()).toMatchObject({ mode, allowModel: true, modelSharingConsent: true });
  return received;
}

test('a late font keeps the headline at its first painted width', async ({ page }) => {
  const fonts = Promise.withResolvers();
  await page.route('**/*.woff2', async (route) => {
    await fonts.promise;
    await route.continue();
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const title = page.getByRole('heading', { name: 'Policy review', exact: true });
  const textWidth = () => title.evaluate((heading) => {
    const text = document.createRange();
    text.selectNodeContents(heading);
    return text.getBoundingClientRect().width;
  });
  let firstWidth;
  try {
    await expect(title).toBeVisible();
    await expect.poll(() => page.evaluate(() => performance.getEntriesByName('first-contentful-paint').length)).toBe(1);
    firstWidth = await textWidth();
  } finally {
    fonts.resolve();
  }
  await page.evaluate(() => document.fonts.ready);
  expect(await textWidth()).toBe(firstWidth);
  const fontRequests = await page.evaluate(() => performance.getEntriesByType('resource')
    .filter((entry) => entry.name.endsWith('.woff2')).map((entry) => entry.initiatorType));
  expect(fontRequests).toEqual(['link', 'link']);
});

test('review tools load on demand and recover after a download failure', async ({ page }) => {
  const bundle = '**/assets/reviewScreens-*.js';
  let requests = 0;
  await page.route(bundle, (route) => {
    requests++;
    return route.abort('failed');
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Policy review', exact: true })).toBeVisible();
  expect(requests).toBe(0);
  await page.getByRole('link', { name: /Answer a questionnaire/ }).click();
  await expect(page.getByRole('button', { name: 'Reload review' })).toBeVisible();
  expect(requests).toBeGreaterThan(0);
  await page.unroute(bundle);
  await page.getByRole('button', { name: 'Reload review' }).click();
  await expect(page.getByRole('heading', { name: 'Answer a questionnaire', exact: true })).toBeFocused();
});

for (const mode of ['guide', 'questionnaire']) {
  test(`a rate-limited ${mode} keeps its inputs for retry`, async ({ page }) => {
    const guide = mode === 'guide';
    const source = guide ? 'Staff must keep a log.' : 'Who keeps the log?';
    await page.goto('/#/new/' + mode);
    await pasteSource(page, mode, source);
    await page.getByRole('button', { name: 'Continue to policies' }).click();
    if (!guide) await addPolicy(page, 'Log.txt', 'Office staff keep the log.');
    await page.route('**/api/review', (route) => route.fulfill({
      status: 429, contentType: 'text/html', body: 'Too many requests',
      headers: guide ? { 'Retry-After': '70' } : {},
    }), { times: 1 });
    const first = await submitReview(page, mode);
    expect(first.status()).toBe(429);
    await expect(page.getByRole('alert')).toHaveText(
      `This network has reached its limit of 30 review submissions per 10 minutes. Try again in ${guide ? 2 : 10} minutes. Your inputs are still here.`,
    );
    const retry = await submitReview(page, mode);
    expect(retry.ok()).toBe(true);
    expect(retry.request().postDataJSON()).toEqual(first.request().postDataJSON());
    await expect(page.getByRole('heading', { name: source, exact: true })).toBeVisible();
  });
}

test('a provider outage preserves the question and uploaded policy for retry', async ({ page }, testInfo) => {
  const question = `Who keeps the outage log for case ${testInfo.project.name}-${testInfo.repeatEachIndex}-${testInfo.retry}?`;
  await page.goto('/#/new/questionnaire');
  await pasteSource(page, 'questionnaire', question);
  await page.getByRole('button', { name: 'Continue to policies' }).click();
  await addPolicy(page, 'Outages.txt', 'The office manager keeps the outage log.');
  const first = await submitReview(page, 'questionnaire');
  expect(first.status()).toBe(503);
  await expect(page.getByRole('alert')).toContainText('Anthropic could not complete the assessment. Try again.');
  await expect(page.getByRole('list', { name: 'Added policies' })).toContainText('Outages.txt');
  const retry = await submitReview(page, 'questionnaire');
  expect(retry.ok()).toBe(true);
  expect(retry.request().postDataJSON()).toEqual(first.request().postDataJSON());
  await expect(page.getByRole('heading', { name: question, exact: true })).toBeVisible();
});

test('a prepared review waits for submission and rejects a keyword-only result', async ({ page }) => {
  const question = 'Who keeps inspection records?';
  const input = { mode: 'questionnaire', questions: [question], allowModel: false, documents: [{
    id: 'registry', title: 'Registry', pages: [{ number: 8, text: 'The registrar keeps inspection records.' }],
  }] };
  const requests = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/review') requests.push(request);
  });
  await page.goto('/#/new/questionnaire');
  await page.getByLabel('Import a prepared review (.json)').setInputFiles({
    name: 'inspection.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(input)),
  });
  await page.getByRole('button', { name: 'Continue to policies' }).click();
  await expect(page.getByRole('list', { name: 'Added policies' })).toContainText('Registry');
  expect(requests).toHaveLength(0);
  await page.route('**/api/review', route => route.fulfill({ json: { engine: 'local', findings: [] } }), { times: 1 });
  await submitReview(page, 'questionnaire');
  await expect(page.getByRole('alert')).toContainText('The AI review could not finish.');
  const retry = await submitReview(page, 'questionnaire');
  expect(retry.request().postDataJSON()).toMatchObject({ questions: [question], documents: input.documents });
  await expect(page.getByRole('heading', { name: question, exact: true })).toBeVisible();
});

test('an analyst answers a question with an explicitly selected quotation', async ({ page }) => {
  const question = 'Who records the inspection date?';
  const policy = 'The facilities coordinator records the inspection date.';
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Policy review', exact: true })).toBeInViewport();
  await page.getByRole('link', { name: 'Start a review', exact: true }).click();
  const options = page.getByRole('heading', { name: 'Start a review', exact: true });
  await expect(options).toBeFocused();
  await expect(options).toBeInViewport();
  await expect(page.getByRole('heading', { name: 'Reviews in this tab' })).toHaveCount(0);
  await expect(page.getByRole('banner').getByRole('button', { name: 'Document privacy' })).toHaveCount(0);
  await page.getByRole('link', { name: /Answer a questionnaire/ }).click();
  await pasteSource(page, 'questionnaire', question);
  await page.getByRole('button', { name: 'Continue to policies' }).click();
  await expect(page).toHaveURL(/questionnaire\/policies$/);
  await page.goBack();
  await expect(page.getByLabel('Questions', { exact: true })).toHaveValue(question);
  await page.goForward();
  await page.getByRole('button', { name: 'Find evidence' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await addPolicy(page, 'Facilities.txt', policy);
  await page.getByRole('button', { name: 'Preview Facilities.txt', exact: true }).click();
  const preview = page.getByRole('textbox', { name: 'Text of Facilities.txt, page 1' });
  await expect(preview).toHaveValue(policy);
  await expect(preview).not.toBeEditable();
  const response = await submitReview(page, 'questionnaire');
  expect((await response.json()).findings[0]).toMatchObject({
    analysisEngine: 'anthropic', supporting: [{ title: 'Facilities.txt', page: 1, quote: policy }],
  });
  await expect(page.getByRole('heading', { name: question, exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Facilities.txt.*p\. 1/ }).first().click();
  await expect(page.locator('dialog mark')).toHaveText(policy);
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Response for submission')).toBeEmpty();
  await page.getByRole('button', { name: 'Use suggested answer' }).click();
  await expect(page.getByLabel('Response for submission')).toHaveValue(policy);
  const draft = await report(page, 'Download responses');
  expect(draft).toContain('Response status — Draft');
  expect(draft).toContain('Facilities.txt, p. 1');
  await page.getByRole('button', { name: 'Remove response citation 1' }).click();
  await page.getByLabel('Response for submission').fill('The facilities coordinator.');
  await expect(page.getByRole('button', { name: 'Confirm response', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Cite in response', exact: true }).first().click();
  await page.getByRole('button', { name: 'Confirm response', exact: true }).click();
  const output = await report(page, 'Download responses');
  expect(output).toContain('The facilities coordinator.');
  expect(output).toContain('Confirmed');
  expect(output).toContain('Facilities.txt, p. 1');
  expect(output).toContain(policy);
  await page.getByRole('link', { name: 'All reviews' }).click();
  await expect(options).toBeInViewport();
  await expect(page.getByRole('heading', { name: 'Reviews in this tab' })).toBeVisible();
  await page.locator('.session-review').click();
  await expect(page.getByLabel('Response for submission')).toHaveValue('The facilities coordinator.');
});

for (const hasAppendix of [true, false]) {
  test(`a follow-up search traces a cross-reference ${hasAppendix ? 'to a new passage' : 'with no new passages'}`, async ({ page }) => {
    const question = 'Who files the inspection log?';
    const term = 'Appendix B';
    const sourceQuote = 'For inspection log assignments, see Appendix B.';
    const appendixQuote = 'Appendix B assigns filing to the coordinator. Appendix B applies to all offices.';
    const pages = hasAppendix ? [sourceQuote, appendixQuote] : [sourceQuote];
    await page.goto('/#/new/questionnaire');
    await pasteSource(page, 'questionnaire', question);
    await page.getByRole('button', { name: 'Continue to policies' }).click();
    await addPolicy(page, 'Filing.txt', pages.join('\f'));
    await submitReview(page, 'questionnaire');
    const toggle = page.getByRole('button', { name: 'Search trail' });
    const followup = page.getByRole('region', { name: 'Follow-up search' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(followup).toBeHidden();
    await toggle.click();
    await expect(followup).toContainText('cross-reference');
    await expect(page.getByRole('article').filter({ hasText: /Ranked match/ })).toHaveCount(1);
    const origin = followup.getByRole('article').filter({ hasText: 'Originating passage' });
    await origin.getByRole('button', { name: /Filing.txt.*p\. 1/ }).click();
    await expect(page.locator('dialog mark')).toHaveText(sourceQuote);
    await page.keyboard.press('Escape');
    await expect(followup.getByText(term, { exact: true })).toBeVisible();
    await expect(followup.getByRole('button', { name: /p\. 1\s*1 hit/ })).toBeVisible();
    if (hasAppendix) {
      await followup.getByRole('button', { name: /p\. 2\s*2 hits/ }).click();
      await expect(page.locator('dialog mark')).toHaveText([term, term]);
      await page.keyboard.press('Escape');
      const result = followup.getByRole('article').filter({ hasText: 'New passage from follow-up' });
      await result.getByRole('button', { name: /Filing.txt.*p\. 2/ }).click();
      await expect(page.locator('dialog mark')).toHaveText(appendixQuote);
    } else {
      await expect(followup).toContainText('This search found no new passages.');
      await expect(page.getByRole('button', { name: 'Use suggested answer' })).toHaveCount(0);
    }
  });
}

test('a guide-only review produces an action list with a traceable source page', async ({ page }) => {
  const obligation = 'Teams must log the inspection date before handover.';
  await page.goto('/');
  await page.getByRole('link', { name: /Review a new policy guide/ }).click();
  await expect(page.getByRole('heading', { name: 'Review a new policy guide', exact: true })).toBeVisible();
  await page.getByLabel('Upload regulatory guide').setInputFiles({
    name: 'Handover.txt', mimeType: 'text/plain', buffer: Buffer.from('Introduction\f' + obligation),
  });
  await page.getByRole('button', { name: 'Choose guide pages' }).click();
  await page.getByLabel(/Guide pages/).fill('2');
  await page.getByRole('button', { name: 'Apply range' }).click();
  await page.getByRole('button', { name: 'Continue to policies' }).click();
  const response = await submitReview(page, 'guide');
  expect(response.request().postDataJSON()).toMatchObject({ guide: obligation, documents: [] });
  expect((await response.json()).planningEngine).toBe('anthropic');
  await expect(page.getByRole('group', { name: 'Policy action', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Search trail' })).toHaveCount(0);
  await page.getByRole('button', { name: /Handover.txt.*p\. 2/ }).click();
  await expect(page.locator('dialog mark')).toHaveText(obligation);
  await page.keyboard.press('Escape');
  await page.getByRole('radio', { name: 'Write new policy', exact: true }).check();
  await page.getByLabel('Action note').fill('Add an inspection record to the handover procedure.');
  const output = await report(page, 'Download action list');
  expect(output).toContain('Write new policy');
  expect(output).toContain('Guide pages 2');
  expect(output).toContain('Handover.txt · p. 2');
  expect(output).toContain(obligation);
  expect(output).toContain('Add an inspection record to the handover procedure.');
  await page.getByRole('button', { name: 'Action list', exact: true }).click();
  await expect(page.getByRole('button', { name: /Write new policy/ })).toContainText(obligation);
});

test('an analyst walks through two guide obligations and records actions against a pasted policy', async ({ page }) => {
  const first = 'Staff must record the inspection date.';
  const second = 'Supervisors must notify the manager before repairs.';
  const policy = 'Facilities staff record the inspection date.';
  await page.goto('/#/new/guide');
  await pasteSource(page, 'guide', first + '\n\n' + second);
  await page.getByRole('button', { name: 'Continue to policies' }).click();
  await page.getByRole('button', { name: 'Paste a policy' }).click();
  await page.getByLabel(/Policy title/).fill('Facilities policy');
  await page.getByLabel('Policy text', { exact: true }).fill(policy);
  await submitReview(page, 'guide');
  const evidence = page.getByRole('article').filter({ hasText: 'Supporting evidence' });
  await evidence.getByRole('button', { name: /Facilities policy.*p\. 1/ }).click();
  await expect(page.locator('dialog mark')).toHaveText(policy);
  await page.keyboard.press('Escape');
  const action = page.getByRole('radio', { name: 'No change', exact: true });
  await expect(action).not.toBeChecked();
  await action.check();
  await page.getByRole('button', { name: 'Next obligation' }).click();
  await expect(page.getByRole('heading', { name: second, exact: true })).toBeVisible();
  await expect(action).not.toBeChecked();
  await page.getByRole('radio', { name: 'Write new policy' }).check();
  await page.getByRole('button', { name: 'Previous obligation' }).click();
  await expect(action).toBeChecked();
  await page.getByRole('button', { name: 'Next obligation' }).click();
  await page.getByRole('button', { name: 'View action list' }).click();
  const list = page.getByRole('region', { name: 'Action list', exact: true });
  await expect(list.getByRole('button', { name: /No change/ })).toContainText(first);
  await expect(list.getByRole('button', { name: /Write new policy/ })).toContainText(second);
  const output = await report(page, 'Download action list');
  expect(output).toContain('## No change');
  expect(output).toContain('Facilities policy, p. 1');
});

test('editing a selected question batch clears its previous source attribution', async ({ page }) => {
  await page.goto('/#/new/questionnaire');
  const questions = page.getByLabel('Questions', { exact: true });
  await pasteSource(page, 'questionnaire', Array.from({ length: 31 }, (_, index) => `${index + 1}. Who reviews record ${index + 1}?`).join('\n'));
  await page.getByLabel(/Questionnaire items/).fill('29–30');
  await page.getByRole('button', { name: 'Apply range' }).click();
  await expect(questions).toHaveValue('29. Who reviews record 29?\n30. Who reviews record 30?');
  await expect(page.getByText(/Questionnaire items 29–30/)).toBeVisible();
  await questions.fill('Who reviews the replacement log?');
  await expect(page.getByText(/Questionnaire items 29–30/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Apply range' })).toHaveCount(0);
});

test('Markdown exports keep document markup and multiline notes literal', async ({ page }) => {
  const obligation = 'Teams must label each record with <unit> and [owner].';
  await page.goto('/#/new/guide');
  await page.getByLabel('Upload regulatory guide').setInputFiles({
    name: 'Guide [draft].txt', mimeType: 'text/plain', buffer: Buffer.from(obligation),
  });
  await page.getByRole('button', { name: 'Continue to policies' }).click();
  await submitReview(page, 'guide');
  await page.getByLabel('Action note').fill('Retain ![diagram](diagram.png).\n## Example heading');
  const output = await report(page, 'Download action list');
  expect(output).toContain('Guide &#91;draft&#93;');
  expect(output).toContain('&#60;unit&#62; and &#91;owner&#93;');
  expect(output).toContain('&#33;&#91;diagram&#93;(diagram.png)');
  expect(output).toContain('&#35;&#35; Example heading');
  expect(output).toContain('## Action pending');
});

test('intake checks page limits and can read a PDF after rejecting a file', async ({ page, context }) => {
  await page.goto('/#/new/guide');
  const upload = page.getByLabel('Upload regulatory guide');
  await upload.setInputFiles({
    name: 'Too many pages.txt', mimeType: 'text/plain', buffer: Buffer.from('Page\f'.repeat(1200) + 'Page'),
  });
  await expect(page.getByRole('alert')).toContainText('1,200 pages');

  const pdfPage = await context.newPage();
  await pdfPage.setContent('<p>Teams must record inspection dates.</p>');
  const pdf = await pdfPage.pdf();
  await pdfPage.close();
  await upload.setInputFiles({ name: 'Guide.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.getByRole('button', { name: 'Preview and edit text' }).click();
  await expect(page.getByLabel('Guide text')).toHaveValue('Teams must record inspection dates.');
  await page.getByRole('button', { name: 'Continue to policies' }).click();

  const policies = page.getByLabel('Upload policy files');
  await policies.setInputFiles({
    name: 'Policy.txt', mimeType: 'text/plain', buffer: Buffer.from('record\f'.repeat(1199) + 'record'),
  });
  const added = page.getByRole('list', { name: 'Added policies' });
  await expect(added).toContainText('1200 pages');
  await policies.setInputFiles({ name: 'Extra.txt', mimeType: 'text/plain', buffer: Buffer.from('record') });
  await expect(page.getByRole('alert')).toContainText('1,200 pages');
  await expect(added.getByRole('listitem')).toHaveCount(1);
});
