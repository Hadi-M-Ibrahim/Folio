import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// A colored registration square identifies each physical sheet even if Folio rasterizes a subset.
function sheetColor(pageNumber) {
  return [20 + (73 * pageNumber) % 221, 30 + (57 * pageNumber) % 211, 40 + (79 * pageNumber) % 199];
}

async function printPdf(context, lines, { scanned = false, fontSize = 16 } = {}) {
  const printer = await context.newPage();
  try {
    await printer.setContent(`<style>
      @page { size: 6in 4in; margin: 0; }
      body { margin: 0; font: ${fontSize}px Arial, sans-serif; }
      section { padding: 32px; }
      section + section { break-before: page; }
      i { display: block; height: 48px; width: 48px; }
      p { margin: 12px 0 0; white-space: pre-line; }
    </style>`);
    await printer.evaluate(async ({ lines, sheetColors, scanned }) => {
      for (const [index, text] of lines.entries()) {
        const sheet = document.createElement('section');
        const square = document.createElement('i');
        square.style.backgroundColor = 'rgb(' + sheetColors[index].join(',') + ')';
        const paragraph = document.createElement('p');
        if (scanned === true || (Array.isArray(scanned) && scanned.includes(index + 1))) {
          const canvas = document.createElement('canvas');
          canvas.width = 480;
          canvas.height = 40;
          const ctx = canvas.getContext('2d');
          ctx.font = '16px Arial';
          ctx.fillText(text, 0, 20);
          const image = document.createElement('img');
          image.src = canvas.toDataURL();
          await image.decode();
          paragraph.append(image);
        } else {
          paragraph.textContent = text;
        }
        sheet.append(square, paragraph);
        document.body.append(sheet);
      }
    }, { lines, sheetColors: lines.map((_, i) => sheetColor(i + 1)), scanned });
    return await printer.pdf({ preferCSSPageSize: true, printBackground: true });
  } finally {
    await printer.close();
  }
}

function uploadPdf(page, label, name, buffer) {
  return page.getByLabel(label, { exact: true }).setInputFiles({ name, mimeType: 'application/pdf', buffer });
}

async function chooseRange(page, action, label, value) {
  const toggle = page.getByRole('button', { name: action, exact: true });
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await page.getByRole('textbox', { name: label }).fill(value);
  await page.getByRole('button', { name: 'Apply range', exact: true }).click();
}

async function expectPdfCanvas(viewer, title, number) {
  const canvas = viewer.getByRole('img', { name: `Page ${number} of ${title}`, exact: true });
  await expect(canvas).toBeVisible();
  // Sample the registration square inside the rendered page, away from its edge.
  const expected = sheetColor(number);
  await expect.poll(() => canvas.evaluate((sheet, rgb) => {
    if (!sheet.width || !sheet.height) return false;
    const ctx = sheet.getContext('2d');
    const pixel = ctx.getImageData(sheet.width / 12, sheet.height / 8, 1, 1).data;
    return rgb.every((channel, i) => Math.abs(channel - pixel[i]) < 12);
  }, expected)).toBe(true);
  return canvas;
}

async function expectAttachedSheets(attachment, numbers) {
  expect(attachment.pages).toEqual(numbers);
  const bytes = Buffer.from(attachment.data, 'base64');
  const task = getDocument({ data: Uint8Array.from(bytes) });
  try {
    const pdf = await task.promise;
    expect(pdf.numPages).toBe(numbers.length);
    for (const [index, originalPage] of numbers.entries()) {
      const sheet = await pdf.getPage(index + 1);
      const viewport = sheet.getViewport({ scale: 1 });
      expect([viewport.width, viewport.height]).toEqual([432, 288]);
      const target = pdf.canvasFactory.create(viewport.width, viewport.height);
      try {
        await sheet.render({ canvas: target.canvas, viewport }).promise;
        const { data } = target.context.getImageData(36, 36, 1, 1);
        for (const [channel, value] of sheetColor(originalPage).entries()) {
          expect(Math.abs(data[channel] - value)).toBeLessThan(12);
        }
        // The body under the square still contains the printed words.
        const body = target.context.getImageData(18, 62, 395, 110).data;
        expect(body.some((value, offset) => offset % 4 === 0 && value < 80)).toBe(true);
      } finally {
        pdf.canvasFactory.destroy(target);
      }
    }
  } finally {
    await task.destroy();
  }
  return {
    role: attachment.role, documentId: attachment.documentId, title: attachment.title, pages: numbers,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function providerCalls(response) {
  expect(response.status()).toBe(200);
  return JSON.parse(await response.headerValue('x-test-provider-calls'));
}

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
  const submit = page.getByRole('button', { name: guide ? 'Review obligations' : 'Find evidence' });
  await expect(submit).toHaveAccessibleDescription(/Anthropic/i);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  const response = page.waitForResponse('**/api/review');
  await submit.click();
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
  expect(response.request().postDataJSON().pdfAttachments ?? []).toEqual([]);
  expect(await providerCalls(response)).toEqual([
    { tool: 'record_search_plan', documents: [] }, { tool: 'record_review', documents: [] },
  ]);
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
  await chooseRange(page, 'Choose questionnaire items', /Questionnaire items/, '29–30');
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

  const pdf = await printPdf(context, ['Teams must record inspection dates.']);
  await uploadPdf(page, 'Upload regulatory guide', 'Guide.pdf', pdf);
  await expectPdfCanvas(page.getByRole('region', { name: 'PDF preview' }), 'Guide.pdf', 1);
  await expect(page.getByRole('textbox', { name: 'Guide text' })).toHaveCount(0);
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

test('questionnaire items send the physical PDF pages they span and the selected policy page', async ({ page, context }) => {
  const first = '20. Who keeps the inspection log before the site closes?';
  const last = '30. Who receives the final inspection log?';
  const quote = 'The facilities coordinator keeps the inspection log before the site closes.';
  const questions = await printPdf(context, [
    '10. Who schedules training?', '20. Who keeps the inspection',
    'log before the site closes?\n21. Who approves invoices?', '22. Who handles travel?', last,
  ]);
  const policy = await printPdf(context, ['Out-of-scope travel rules.', quote, 'Out-of-scope invoice rules.']);
  const submissions = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/review') submissions.push(request);
  });
  await page.goto('/#/new/questionnaire');
  await uploadPdf(page, 'Upload questionnaire', 'Intake.pdf', questions);
  const viewer = page.getByRole('region', { name: 'PDF preview' });
  const firstCanvas = await expectPdfCanvas(viewer, 'Intake.pdf', 1);
  const width = (await firstCanvas.boundingBox()).width;
  await viewer.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(async () => (await firstCanvas.boundingBox()).width).toBeGreaterThan(width);
  await viewer.getByRole('button', { name: 'Fit to width', exact: true }).click();
  await viewer.getByRole('button', { name: 'Next PDF page' }).click();
  await expectPdfCanvas(viewer, 'Intake.pdf', 2);
  await chooseRange(page, 'Choose questionnaire items', /Questionnaire items/, '20, 30');
  await expect(viewer.getByRole('combobox', { name: 'PDF page' }).getByRole('option')).toHaveCount(3);
  await page.getByRole('button', { name: 'Continue to policies' }).click();
  await uploadPdf(page, 'Upload policy files', 'Facility.pdf', policy);
  await page.getByRole('button', { name: 'Preview Facility.pdf' }).click();
  await expectPdfCanvas(viewer, 'Facility.pdf', 1);
  await chooseRange(page, 'Choose policy pages', /Policy pages/, '2');
  await expectPdfCanvas(viewer, 'Facility.pdf', 2);
  expect(submissions).toHaveLength(0);
  const response = await submitReview(page, 'questionnaire');
  const sent = response.request().postDataJSON();
  expect(sent.questions).toEqual([first, last]);
  expect(sent.documents).toMatchObject([{ title: 'Facility.pdf', pages: [{ number: 2, text: quote }] }]);
  expect(sent.pdfAttachments).toHaveLength(2);
  const sourceBlock = await expectAttachedSheets(sent.pdfAttachments.find(pdf => pdf.role === 'source'), [2, 3, 5]);
  const policyBlock = await expectAttachedSheets(sent.pdfAttachments.find(pdf => pdf.role === 'policy'), [2]);
  expect(sourceBlock.title).toBe('Intake.pdf');
  expect(policyBlock).toMatchObject({ title: 'Facility.pdf', documentId: sent.documents[0].id });
  expect(await providerCalls(response)).toEqual([
    { tool: 'record_search_plan', documents: [sourceBlock] },
    { tool: 'record_review', documents: [sourceBlock, policyBlock] },
  ]);
  const result = await response.json();
  expect(result.findings.map(finding => finding.question)).toEqual([first, last]);
  expect(result.findings[0].supporting).toMatchObject([{ title: 'Facility.pdf', page: 2, quote }]);
  await page.getByRole('button', { name: /Facility\.pdf.*p\. 2/ }).first().click();
  const citedPolicy = page.getByRole('dialog');
  await expectPdfCanvas(citedPolicy, 'Facility.pdf', 2);
  await expect(citedPolicy.locator('.pdf-text-layer mark').first()).toBeVisible();
});

test('non-contiguous guide pages reach the planner and open at the original citation', async ({ page, context }) => {
  const obligations = ['Staff must record inspection dates.', 'Supervisors must sign inspection reports.'];
  const guide = await printPdf(context, [obligations[0], 'Unselected payroll instructions.', obligations[1]]);
  await page.goto('/#/new/guide');
  await uploadPdf(page, 'Upload regulatory guide', 'Audit.pdf', guide);
  await chooseRange(page, 'Choose guide pages', /Guide pages/, '1, 3');
  const viewer = page.getByRole('region', { name: 'PDF preview' });
  await viewer.getByRole('button', { name: 'Next PDF page' }).click();
  await expectPdfCanvas(viewer, 'Audit.pdf', 3);
  await page.getByRole('button', { name: 'Continue to policies' }).click();
  const response = await submitReview(page, 'guide');
  const sent = response.request().postDataJSON();
  expect(sent.guide).toBe(obligations.join('\n\n'));
  expect(sent.documents).toEqual([]);
  expect(sent.pdfAttachments).toHaveLength(1);
  const source = await expectAttachedSheets(sent.pdfAttachments[0], [1, 3]);
  expect(source).toMatchObject({ role: 'source', title: 'Audit.pdf' });
  expect(await providerCalls(response)).toEqual([{ tool: 'record_search_plan', documents: [source] }]);
  await page.getByRole('button', { name: 'Next obligation' }).click();
  await page.getByRole('button', { name: /Audit\.pdf.*p\. 3/ }).click();
  const citedGuide = page.getByRole('dialog');
  await expectPdfCanvas(citedGuide, 'Audit.pdf', 3);
  await expect(citedGuide.locator('.pdf-text-layer mark').first()).toBeVisible();
});

test('selecting one of two items on a shared page sends only visible page content and reviews one question', async ({ page, context }) => {
  const question = '2. Who keeps the inspection log?';
  const form = await printPdf(context, ['1. Who schedules training?\n' + question]);
  await page.goto('/#/new/questionnaire');
  await uploadPdf(page, 'Upload questionnaire', 'Shared page.pdf', form);
  await chooseRange(page, 'Choose questionnaire items', /Questionnaire items/, '2');
  await page.getByRole('button', { name: 'Continue to policies' }).click();
  await addPolicy(page, 'Inspection.txt', 'The registrar keeps the inspection log.');
  const response = await submitReview(page, 'questionnaire');
  const sent = response.request().postDataJSON();
  expect(sent.questions).toEqual([question]);
  const source = sent.pdfAttachments[0];
  expect(Buffer.from(source.data, 'base64').equals(form)).toBe(false);
  const block = await expectAttachedSheets(source, [1]);
  expect((await providerCalls(response))[0]).toEqual({ tool: 'record_search_plan', documents: [block] });
});

for (const [kind, scanned] of [['image-only', true], ['partially scanned', [2]]]) {
  test(`a ${kind} questionnaire can select and review a scanned page alongside a scanned policy`, async ({ page, context }) => {
    const questions = await printPdf(context, ['1. Who keeps inspection log 1?\n2. When is it signed?', 'Who keeps inspection log 2?'], { scanned });
    const policy = await printPdf(context, ['The registrar keeps inspection log 1.'], { scanned: true });
    await page.goto('/#/new/questionnaire');
    await uploadPdf(page, 'Upload questionnaire', 'Scanned form.pdf', questions);
    await chooseRange(page, 'Choose questionnaire pages', /Questionnaire pages/, '2');
    await expectPdfCanvas(page.getByRole('region', { name: 'PDF preview' }), 'Scanned form.pdf', 2);
    await page.getByRole('button', { name: 'Continue to policies' }).click();
    await uploadPdf(page, 'Upload policy files', 'Scanned policy.pdf', policy);
    await expect(page.getByRole('list', { name: 'Added policies' })).toContainText('Scanned policy.pdf');
    const response = await submitReview(page, 'questionnaire');
    const sent = response.request().postDataJSON();
    expect(sent.readSourcePdf).toBe(true);
    expect(sent.questions).toBeUndefined();
    expect(sent.pdfAttachments).toHaveLength(2);
    const source = await expectAttachedSheets(sent.pdfAttachments.find(pdf => pdf.role === 'source'), [2]);
    const attachedPolicy = sent.pdfAttachments.find(pdf => pdf.role === 'policy');
    expect(Buffer.from(attachedPolicy.data, 'base64').equals(policy)).toBe(true);
    const policyBlock = await expectAttachedSheets(attachedPolicy, [1]);
    const calls = await providerCalls(response);
    expect(calls.filter(call => call.tool === 'record_pdf_pages')).toEqual(expect.arrayContaining([
      { tool: 'record_pdf_pages', documents: [source] }, { tool: 'record_pdf_pages', documents: [policyBlock] },
    ]));
    expect(calls.at(-1)).toEqual({ tool: 'record_review', documents: [source, policyBlock] });
    const result = await response.json();
    expect(result.findings[0]).toMatchObject({
      question: 'Who keeps inspection log 2?',
      supporting: [{ title: 'Scanned policy.pdf', page: 1, quote: 'The registrar keeps inspection log 1.' }],
    });
    await page.getByRole('button', { name: /Scanned policy\.pdf.*p\. 1/ }).first().click();
    await expectPdfCanvas(page.getByRole('dialog'), 'Scanned policy.pdf', 1);
  });
}

async function finishDocumentReview(page, mode) {
  const requests = [];
  function capture(request) {
    if (new URL(request.url()).pathname === '/api/review') requests.push(request);
  }
  page.on('request', capture);
  try {
    const guide = mode === 'guide';
    await page.getByRole('button', { name: guide ? 'Review obligations' : 'Find evidence', exact: true }).click();
    const download = page.getByRole('button', { name: guide ? 'Download action list' : 'Download responses' });
    const alert = page.getByRole('alert');
    await expect(download.or(alert).first()).toBeVisible({ timeout: 60_000 });
    await expect(alert).toHaveCount(0);
    await expect(download).toBeVisible();
  } finally {
    page.off('request', capture);
  }
  const parts = [];
  for (const request of requests) {
    const response = await request.response();
    const input = request.postDataJSON();
    expect(input).toMatchObject({ mode, allowModel: true, modelSharingConsent: true });
    parts.push({ input, result: await response.json(), calls: await providerCalls(response),
      assessed: JSON.parse(await response.headerValue('x-test-assessed-criteria')) });
  }
  return parts;
}

async function selectLastFinding(page, questions) {
  const queue = page.getByRole('complementary', { name: 'Review queue' });
  const mobileToggle = queue.getByRole('button', { name: /Show list/ });
  if (await mobileToggle.isVisible()) await mobileToggle.click();
  await expect(queue.locator('.row-name')).toHaveText(questions);
  await queue.locator('.queue-row').last().click();
  await expect(page.getByRole('heading', { name: questions.at(-1), exact: true })).toBeVisible();
}

test('one submission reviews 65 native PDF questions in full and exports every response', async ({ page, context }) => {
  test.setTimeout(120_000);
  const questions = Array.from({ length: 65 }, (_, i) => `${i + 1}. Who keeps inspection log ${i + 1}?`);
  questions[32] = '33. Who keeps the inspection log covering ' + 'archived inspection entries and '.repeat(73) + 'the final register?';
  expect(questions[32].length).toBeGreaterThan(2000);
  const sheets = Array.from({ length: 13 }, (_, i) => questions.slice(i * 5, i * 5 + 5).join('\n'));
  const form = await printPdf(context, sheets, { fontSize: 8 });
  const policyQuote = 'The registrar keeps the inspection log for every site.';
  const policy = await printPdf(context, ['Car park hours vary.', policyQuote]);
  await page.goto('/#/new/questionnaire');
  await uploadPdf(page, 'Upload questionnaire', 'Register.pdf', form);
  await expectPdfCanvas(page.getByRole('region', { name: 'PDF preview' }), 'Register.pdf', 1);
  await page.getByRole('button', { name: 'Continue to policies' }).click();
  await uploadPdf(page, 'Upload policy files', 'Records.pdf', policy);
  await expect(page.getByRole('list', { name: 'Added policies' })).toContainText('Records.pdf');
  const parts = await finishDocumentReview(page, 'questionnaire');

  expect(parts.length).toBeGreaterThan(1);
  expect(parts.flatMap(({ input }) => input.questions)).toEqual(questions);
  expect(parts.flatMap(({ result }) => result.findings.map(finding => finding.question))).toEqual(questions);
  expect(parts.flatMap(({ assessed }) => assessed).sort()).toEqual(
    questions.map(question => createHash('sha256').update(question).digest('hex')).sort(),
  );
  for (const { input, calls, result } of parts) {
    const originalPages = [...new Set(input.questions.map(question => Math.floor(questions.indexOf(question) / 5) + 1))];
    expect(input.pdfAttachments).toHaveLength(2);
    const source = await expectAttachedSheets(input.pdfAttachments.find(pdf => pdf.role === 'source'), originalPages);
    const attachedPolicy = input.pdfAttachments.find(pdf => pdf.role === 'policy');
    const policyBlock = await expectAttachedSheets(attachedPolicy, [1, 2]);
    expect(Buffer.from(attachedPolicy.data, 'base64').equals(policy)).toBe(true);
    expect(source.title).toBe('Register.pdf');
    expect(policyBlock).toMatchObject({ title: 'Records.pdf', documentId: input.documents[0].id });
    expect(calls.map(call => call.tool)).toContain('record_search_plan');
    expect(calls.map(call => call.tool)).toContain('record_review');
    for (const call of calls) {
      expect(call.documents).toEqual(call.tool === 'record_search_plan' ? [source] : [source, policyBlock]);
    }
    for (const finding of result.findings) {
      expect(finding).toMatchObject({ analysisEngine: 'anthropic', supporting: [{ page: 2, quote: policyQuote }] });
    }
  }

  await selectLastFinding(page, questions);
  await page.getByRole('button', { name: /Records\.pdf.*p\. 2/ }).first().click();
  await expectPdfCanvas(page.getByRole('dialog'), 'Records.pdf', 2);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Use suggested answer' }).click();
  await page.getByRole('button', { name: 'Confirm response' }).click();
  const output = await report(page, 'Download responses');
  expect(output.match(/^## Question .+$/gm)).toEqual(questions.map((question, i) =>
    `## Question ${i + 1}. ${question.replace(/^([0-9]+)\./, '$1&#46;')}`));
  expect(output.match(/^Response status — Confirmed$/gm)).toHaveLength(1);
  expect(output.match(/^Response status — Pending$/gm)).toHaveLength(64);
  const finalResponse = output.slice(output.indexOf('## Question 65.'), output.indexOf('## Evidence and search record'));
  expect(finalResponse).toContain('Response status — Confirmed');
  expect(finalResponse).toContain('Records.pdf, p. 2');
  expect(finalResponse).toContain(policyQuote);
});

test('a full native guide preserves repeated Unicode-positioned duties across empty and populated parts', async ({ page, context }) => {
  test.setTimeout(120_000);
  const repeated = 'Clerks must sign the inspection log.';
  const duties = Array.from({ length: 36 }, (_, i) => `Staff must retain inspection register ${i + 1}.`);
  const sheets = Array.from({ length: 30 }, (_, i) =>
    `🧭 Archive catalog ${i + 1}.\n` + 'The archive opened in the spring. '.repeat(63).trim());
  sheets[0] = repeated + '\n' + sheets[0];
  sheets[14] = duties.slice(0, 18).join('\n');
  sheets[15] = duties.slice(18).join('\n');
  sheets[29] += '\n' + repeated;
  const guide = await printPdf(context, sheets, { fontSize: 8 });
  await page.goto('/#/new/guide');
  await uploadPdf(page, 'Upload regulatory guide', 'Archive.pdf', guide);
  await expectPdfCanvas(page.getByRole('region', { name: 'PDF preview' }), 'Archive.pdf', 1);
  await page.getByRole('button', { name: 'Continue to policies' }).click();
  const parts = await finishDocumentReview(page, 'guide');

  const guideParts = parts.map(({ input }) => input.guide);
  expect(guideParts.join('').length).toBeGreaterThan(50_000);
  const normalized = value => value.replace(/\s+/gu, ' ').trim();
  const expectedGuide = sheets.map(normalized).join(' ');
  expect(normalized(guideParts.join(''))).toBe(expectedGuide);
  expect(parts.some(({ result }) => result.findings.length === 0)).toBe(true);
  const questions = [repeated, ...duties, repeated];
  expect(parts.flatMap(({ result }) => result.findings.map(finding => finding.question))).toEqual(questions);
  let pageOffset = 0;
  const positions = sheets.map((sheet, i) => {
    const start = pageOffset;
    const end = start + normalized(sheet).length;
    pageOffset = end + 1;
    return { number: i + 1, start, end };
  });
  let cursor = 0;
  for (const { input, result, calls } of parts) {
    expect(input.documents).toEqual([]);
    expect(input.pdfAttachments).toHaveLength(1);
    const [attachment] = input.pdfAttachments;
    const text = normalized(input.guide);
    const start = expectedGuide.indexOf(text, cursor);
    expect(start).toBeGreaterThanOrEqual(cursor);
    expect(expectedGuide.slice(cursor, start).trim()).toBe('');
    cursor = start + text.length;
    const originalPages = positions.filter(page => page.end > start && page.start < cursor).map(page => page.number);
    const block = await expectAttachedSheets(attachment, originalPages);
    expect(block).toMatchObject({ title: 'Archive.pdf', role: 'source' });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toEqual({ tool: 'record_search_plan', documents: [block] });
    const codePoints = Array.from(input.guide);
    for (const { criterionStart, criterionEnd, criterionSource } of result.findings) {
      expect(codePoints.slice(criterionStart, criterionEnd).join('')).toBe(criterionSource);
    }
  }
  expect(cursor).toBe(expectedGuide.length);

  await selectLastFinding(page, questions);
  await page.getByRole('button', { name: /Archive\.pdf.*p\. 30/ }).click();
  const citation = page.getByRole('dialog');
  await expectPdfCanvas(citation, 'Archive.pdf', 30);
  await expect(citation.getByRole('complementary', { name: 'Cited passage' })).toContainText(repeated);
  await expect(citation.locator('.pdf-text-layer mark').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByLabel('Action note').fill('Verify the final register.');
  const output = await report(page, 'Download action list');
  expect(output.match(/^### Obligation \d+$/gm)).toEqual(questions.map((_, i) => `### Obligation ${i + 1}`));
  expect(output.match(/^> .+$/gm)).toEqual(questions.map(question => '> ' + question));
  expect(output.slice(output.indexOf('### Obligation 38'))).toContain('Archive.pdf · p. 30');
  expect(output).toContain('Verify the final register.');
});

test('a complete scanned form joins a question across transcription requests before assessment', async ({ page, context }) => {
  const printed = ['Who keeps inspection log 1?', 'Who keeps inspection log 2?', 'Who keeps the inspection log',
    'after the archive closes?', 'Who keeps inspection log 5?'];
  const questions = [printed[0], printed[1], printed[2] + ' ' + printed[3], printed[4]];
  const form = await printPdf(context, printed, { scanned: true });
  await page.goto('/#/new/questionnaire');
  await uploadPdf(page, 'Upload questionnaire', 'Archive scan.pdf', form);
  await expectPdfCanvas(page.getByRole('region', { name: 'PDF preview' }), 'Archive scan.pdf', 1);
  await page.getByRole('button', { name: 'Continue to policies' }).click();
  await addPolicy(page, 'Records.txt', 'The registrar keeps the inspection log after the archive closes.');
  const parts = await finishDocumentReview(page, 'questionnaire');

  const transcripts = parts.filter(({ input }) => input.transcribeSourceOnly);
  expect(transcripts.length).toBeGreaterThan(1);
  const physicalPages = transcripts.flatMap(({ input }) => input.pdfAttachments[0].pages);
  expect(physicalPages).toEqual([1, 2, 3, 4, 5]);
  expect(transcripts.some(({ input }) => input.pdfAttachments[0].pages.at(-1) === 3)).toBe(true);
  for (const { input, calls } of transcripts) {
    expect(input.documents).toEqual([]);
    expect(input.pdfAttachments).toHaveLength(1);
    const [attachment] = input.pdfAttachments;
    const source = await expectAttachedSheets(attachment, attachment.pages);
    expect(source).toMatchObject({ title: 'Archive scan.pdf', role: 'source' });
    for (const call of calls) expect(call).toEqual({ tool: 'record_pdf_pages', documents: [source] });
  }
  const reviews = parts.filter(({ input }) => !input.transcribeSourceOnly);
  expect(reviews.flatMap(({ input }) => input.questions)).toEqual(questions);
  expect(reviews.flatMap(({ result }) => result.findings.map(finding => finding.question))).toEqual(questions);
  await selectLastFinding(page, questions);
  const output = await report(page, 'Download responses');
  expect(output.match(/^## Question .+$/gm)).toEqual(questions.map((question, i) => `## Question ${i + 1}. ${question}`));
});

test('retrying a whole questionnaire resumes after the last successful part', async ({ page }, testInfo) => {
  const questions = Array.from({ length: 32 }, (_, i) => `Who keeps inspection log ${i + 1}?`);
  questions[16] = `Who keeps the outage log for case late-${testInfo.project.name}-${testInfo.repeatEachIndex}-${testInfo.retry}?`;
  await page.goto('/#/new/questionnaire');
  await pasteSource(page, 'questionnaire', questions.join('\n'));
  await page.getByRole('button', { name: 'Continue to policies' }).click();
  await addPolicy(page, 'Registry.txt', 'The registrar keeps the inspection log.');
  await page.route('**/api/review', route => route.fulfill({
    status: 429, body: '', headers: { 'Retry-After': '1' },
  }), { times: 1 });
  const firstAttempt = [];
  function capture(response) {
    if (new URL(response.url()).pathname === '/api/review') firstAttempt.push(response);
  }
  page.on('response', capture);
  await page.getByRole('button', { name: 'Find evidence' }).click();
  await expect(page.getByRole('alert')).toContainText('Anthropic could not complete the assessment.');
  page.off('response', capture);
  expect(firstAttempt.length).toBeGreaterThan(2);
  expect(firstAttempt[0].status()).toBe(429);
  expect(firstAttempt[1].request().postDataJSON()).toEqual(firstAttempt[0].request().postDataJSON());
  expect(firstAttempt.at(-1).status()).toBe(503);
  await expect(page.getByRole('button', { name: 'Download responses' })).toHaveCount(0);
  const completedQuestions = firstAttempt.slice(1, -1).flatMap(response => {
    expect(response.status()).toBe(200);
    return response.request().postDataJSON().questions;
  });
  const retry = await finishDocumentReview(page, 'questionnaire');
  expect(retry[0].input).toEqual(firstAttempt.at(-1).request().postDataJSON());
  expect([...completedQuestions, ...retry.flatMap(({ input }) => input.questions)]).toEqual(questions);
  await selectLastFinding(page, questions);
  const output = await report(page, 'Download responses');
  expect(output.match(/^## Question .+$/gm)).toHaveLength(questions.length);
});

test('cancelling a paused multipart review keeps completed work for the next submission', async ({ page }) => {
  const questions = Array.from({ length: 25 }, (_, i) => `Who keeps inspection log ${i + 1}?`);
  await page.goto('/#/new/questionnaire');
  await pasteSource(page, 'questionnaire', questions.join('\n'));
  await page.getByRole('button', { name: 'Continue to policies' }).click();
  await addPolicy(page, 'Registry.txt', 'The registrar keeps the inspection log.');
  const requests = [];
  await page.route('**/api/review', route => {
    requests.push(route.request().postDataJSON());
    return requests.length === 2
      ? route.fulfill({ status: 429, body: '', headers: { 'Retry-After': '70' } })
      : route.continue();
  });
  await page.getByRole('button', { name: 'Find evidence' }).click();
  await expect(page.getByText(/Review paused at the submission limit/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel review' }).click();
  await expect(page.getByRole('button', { name: 'Find evidence' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Download responses' })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Added policies' })).toContainText('Registry.txt');

  const resumed = await finishDocumentReview(page, 'questionnaire');
  expect(resumed[0].input).toEqual(requests[1]);
  expect([...requests[0].questions, ...resumed.flatMap(({ input }) => input.questions)]).toEqual(questions);
  await selectLastFinding(page, questions);
});

function oversizedPdf(original) {
  const trailer = original.lastIndexOf('startxref');
  expect(trailer).toBeGreaterThan(0);
  // One valid, unreferenced PDF comment makes the original larger than the encoded transfer budget.
  return Buffer.concat([original.subarray(0, trailer), Buffer.from('%'), Buffer.alloc(3_200_000, 65),
    Buffer.from('\n'), original.subarray(trailer)]);
}

test('large questionnaire and policy originals are automatically sent as visible PDF pages', async ({ page, context }) => {
  const question = 'Who signs the inspection log?';
  const form = oversizedPdf(await printPdf(context, [question]));
  const policy = oversizedPdf(await printPdf(context, ['The registrar signs the inspection log.']));
  await page.goto('/#/new/questionnaire');
  await uploadPdf(page, 'Upload questionnaire', 'Complete form.pdf', form);
  await expectPdfCanvas(page.getByRole('region', { name: 'PDF preview' }), 'Complete form.pdf', 1);
  await page.getByRole('button', { name: 'Continue to policies' }).click();
  await uploadPdf(page, 'Upload policy files', 'Signature policy.pdf', policy);
  await expect(page.getByRole('list', { name: 'Added policies' })).toContainText('Signature policy.pdf');
  const response = await submitReview(page, 'questionnaire');
  const sent = response.request().postDataJSON();
  expect(sent.questions).toEqual([question]);
  expect(sent.pdfAttachments).toHaveLength(2);
  const block = await expectAttachedSheets(sent.pdfAttachments[0], [1]);
  const policyBlock = await expectAttachedSheets(sent.pdfAttachments[1], [1]);
  const calls = await providerCalls(response);
  expect(calls[0].documents).toEqual([block]);
  expect(calls.at(-1).documents).toEqual([block, policyBlock]);
  await expect(page.getByRole('heading', { name: question, exact: true })).toBeVisible();
});
