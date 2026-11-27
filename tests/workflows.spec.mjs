import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// A colored registration square identifies each physical sheet even if Folio rasterizes a subset.
function sheetColor(pageNumber) {
  return [20 + (73 * pageNumber) % 221, 30 + (57 * pageNumber) % 211, 40 + (79 * pageNumber) % 199];
}

async function printPdf(context, lines, { scanned = false, fontSize = 16, portraitPages = [] } = {}) {
  const printer = await context.newPage();
  try {
    await printer.setContent(`<style>
      @page { size: 6in 4in; margin: 0; }
      @page portrait { size: 4in 6in; margin: 0; }
      section.portrait { page: portrait; }
      body { margin: 0; font: ${fontSize}px Arial, sans-serif; }
      section { padding: 32px; }
      section + section { break-before: page; }
      i { display: block; height: 48px; width: 48px; }
      p { margin: 12px 0 0; white-space: pre-line; }
    </style>`);
    await printer.evaluate(async ({ lines, sheetColors, scanned, portraitPages }) => {
      for (const [index, text] of lines.entries()) {
        const sheet = document.createElement('section');
        if (portraitPages.includes(index + 1)) sheet.className = 'portrait';
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
    }, { lines, sheetColors: lines.map((_, i) => sheetColor(i + 1)), scanned, portraitPages });
    return await printer.pdf({ preferCSSPageSize: true, printBackground: true });
  } finally {
    await printer.close();
  }
}

function uploadPdf(page, label, name, buffer) {
  return page.getByLabel(label, { exact: true }).setInputFiles({ name, mimeType: 'application/pdf', buffer });
}

async function expectCompactPdf(page, mode = 'questionnaire') {
  await expect(page.getByRole('button', { name: 'Preview PDF', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('region', { name: 'PDF preview', includeHidden: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: mode === 'guide' ? 'Review obligations' : 'Find evidence' })).toBeInViewport({ ratio: 1 });
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
    const pixel = ctx.getImageData(sheet.width / 8, sheet.height / 8, 1, 1).data;
    return rgb.every((channel, i) => Math.abs(channel - pixel[i]) < 12);
  }, expected)).toBe(true);
  return canvas;
}

async function watchPdfFrames(viewer) {
  return viewer.evaluate(region => {
    const measure = () => {
      const stage = region.querySelector('.pdf-scroll').getBoundingClientRect();
      const arrow = region.querySelector('[aria-label="Next PDF page"]').getBoundingClientRect();
      const modal = region.closest('dialog');
      return [scrollY, arrow.top, stage.height, modal?.scrollTop ?? 0].map(Math.round).join(', ');
    };
    const initial = measure();
    const frames = new Set([initial]);
    const sheets = [];
    function sample() {
      if (!region.isConnected) return;
      frames.add(measure());
      const sheet = region.querySelector('canvas')?.getAttribute('aria-label') ?? 'blank';
      if (sheets.at(-1) !== sheet) sheets.push(sheet);
      requestAnimationFrame(sample);
    }
    sample();
    window.previewFrames = () => ({ positions: [...frames], sheets });
    return initial;
  });
}

async function expectPdfFrames(page, position, title, numbers) {
  const sheets = numbers.map(number => `Page ${number} of ${title}`);
  await expect.poll(() => page.evaluate(() => window.previewFrames()), {
    message: 'Body scroll, arrow position, preview height, dialog scroll, and painted sheets in each frame',
  }).toEqual({ positions: [position], sheets });
}

async function expectAttachedSheets(attachment, numbers, portraitPages = []) {
  expect(attachment.pages).toEqual(numbers);
  const bytes = Buffer.from(attachment.data, 'base64');
  const task = getDocument({ data: Uint8Array.from(bytes) });
  try {
    const pdf = await task.promise;
    expect(pdf.numPages).toBe(numbers.length);
    for (const [index, originalPage] of numbers.entries()) {
      const sheet = await pdf.getPage(index + 1);
      const viewport = sheet.getViewport({ scale: 1 });
      expect([viewport.width, viewport.height]).toEqual(portraitPages.includes(originalPage) ? [288, 432] : [432, 288]);
      const target = pdf.canvasFactory.create(viewport.width, viewport.height);
      try {
        await sheet.render({ canvas: target.canvas, viewport }).promise;
        const { data } = target.context.getImageData(36, 36, 1, 1);
        for (const [channel, value] of sheetColor(originalPage).entries()) {
          expect(Math.abs(data[channel] - value)).toBeLessThan(12);
        }
        // The body under the square still contains the printed words.
        const body = target.context.getImageData(18, 62, viewport.width - 36, 110).data;
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

async function outputPdfText(page, tabName) {
  const header = page.locator('.workspace > header');
  await expect(header.getByRole('button', { name: /download/i })).toHaveCount(0);
  await page.getByRole('navigation', { name: 'This review' }).getByRole('button', { name: tabName, exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('region', { name: tabName, exact: true }).getByRole('button', { name: 'Download PDF' }).click();
  return (await pdfPageTexts(await download)).join(' ');
}

async function pdfPageTexts(download) {
  const bytes = await readFile(await download.path());
  const task = getDocument({ data: Uint8Array.from(bytes) });
  try {
    const document = await task.promise;
    const pages = [];
    for (let number = 1; number <= document.numPages; number++) {
      const sheet = await document.getPage(number);
      const content = await sheet.getTextContent();
      pages.push(content.items.map(item => item.str).join(' ').replace(/\s+/gu, ' ').trim());
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

async function continueToSource(page, mode) {
  await page.getByRole('button', { name: mode === 'guide' ? 'Continue to guide' : 'Continue to questions' }).click();
}

async function pasteSource(page, mode, text) {
  const guide = mode === 'guide';
  await page.getByRole('button', { name: guide ? 'Paste guide text' : 'Paste a question or list' }).click();
  const field = page.getByLabel(guide ? 'Guide text' : 'Questions', { exact: true });
  await field.fill(text);
  await field.blur();
}

async function addPolicy(page, name, text) {
  await page.getByLabel('Upload policy files').setInputFiles({
    name, mimeType: 'text/plain', buffer: Buffer.from(text),
  });
  await expect(page.getByRole('list', { name: 'Added policies' })).toContainText(name);
}

function captureReviewRequests(page) {
  const requests = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/review') requests.push(request);
  });
  return requests;
}

async function waitForBackgroundReview(page) {
  const response = await page.waitForResponse('**/api/review');
  expect(response.ok()).toBe(true);
  await response.finished();
}

async function expectQuietReview(page) {
  await expect(page.getByRole('progressbar', { name: 'Review progress' })).toHaveCount(0);
  await expect(page.getByText('Review ready', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel review' })).toHaveCount(0);
}

async function clickReview(page, mode) {
  const guide = mode === 'guide';
  const submit = page.getByRole('button', { name: guide ? 'Review obligations' : 'Find evidence' });
  await expect(submit).toHaveAccessibleDescription('');
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await submit.click();
}

async function submitReview(page, mode, response = page.waitForResponse('**/api/review')) {
  await clickReview(page, mode);
  const received = await response;
  expect(received.request().postDataJSON()).toMatchObject({ mode, allowModel: true, modelSharingConsent: true });
  return received;
}

async function holdNextReview(page, respond = route => route.continue()) {
  const gate = Promise.withResolvers();
  await page.route('**/api/review', async route => {
    await gate.promise;
    await respond(route);
  }, { times: 1 });
  return gate.resolve;
}

async function chooseReviewAction(page, title, action) {
  await page.getByRole('button', { name: 'Actions for ' + title, exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}

async function createNamedQuestionnaire(page, title) {
  await page.getByRole('link', { name: /Answer a questionnaire/ }).click();
  await addPolicy(page, 'Records.txt', 'The registrar signs the inspection log.');
  await continueToSource(page, 'questionnaire');
  const question = 'Who signs the inspection log for ' + title + '?';
  await page.getByLabel('Upload questionnaire').setInputFiles({
    name: title + '.txt', mimeType: 'text/plain', buffer: Buffer.from(question),
  });
  await clickReview(page, 'questionnaire');
  await expect(page.getByRole('heading', { name: question, exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'All reviews' }).click();
}

async function openWithEntryScriptHeld(page, path) {
  const entry = '**/assets/index-*.js';
  const requested = page.waitForRequest(entry);
  const gate = Promise.withResolvers();
  await page.route(entry, async (route) => {
    await gate.promise;
    await route.continue();
  });
  await page.goto(path, { waitUntil: 'commit' });
  await requested;
  return gate.resolve;
}

test('the cold landing page is painted before the application downloads and stays in place', async ({ page }, testInfo) => {
  const release = await openWithEntryScriptHeld(page, '/');
  const title = page.getByRole('heading', { name: 'Policy review', exact: true });
  let before;
  try {
    await expect(title).toBeInViewport();
    await expect(page.getByRole('link', { name: 'Start a review', exact: true })).toBeInViewport();
    const landscape = page.locator('.opening-landscape');
    await expect(landscape).toBeInViewport();
    await landscape.evaluate(image => image.decode());
    before = await page.screenshot();
  } finally {
    release();
  }
  await page.waitForLoadState('load');
  const after = await page.screenshot();
  if (!before.equals(after)) {
    await testInfo.attach('before-hydration', { body: before, contentType: 'image/png' });
    await testInfo.attach('after-hydration', { body: after, contentType: 'image/png' });
  }
  expect(after.equals(before), 'The visible landing page changed when React started').toBe(true);
});

test('a cold workflow deep link paints no landing hero', async ({ page }) => {
  await page.addInitScript(() => {
    window.homeWasPainted = false;
    function sample() {
      const hero = document.querySelector('.opening');
      if (hero?.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
        hero.getBoundingClientRect().top < innerHeight && hero.getBoundingClientRect().bottom > 0) {
        window.homeWasPainted = true;
      }
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
  const release = await openWithEntryScriptHeld(page, '/#/new/guide');
  try {
    await expect(page.getByText('Opening review…', { exact: true })).toBeInViewport();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.evaluate(() => window.homeWasPainted)).toBe(false);
  } finally {
    release();
  }
  await expect(page.getByRole('heading', { name: 'Add existing policies', exact: true })).toBeFocused();
  expect(await page.evaluate(() => window.homeWasPainted)).toBe(false);
});

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
  await expect(page.getByRole('heading', { name: 'Add existing policies', exact: true })).toBeFocused();
});

for (const mode of ['guide', 'questionnaire']) {
  test(`a rate-limited ${mode} keeps its inputs for retry`, async ({ page }) => {
    const guide = mode === 'guide';
    const source = guide ? 'Staff must keep a log.' : 'Who keeps the log?';
    await page.goto('/#/new/' + mode);
    await addPolicy(page, 'Log.txt', 'Office staff keep the log.');
    await continueToSource(page, mode);
    const release = await holdNextReview(page, route => route.fulfill({
      status: 429, contentType: 'text/html', body: 'Too many requests',
      headers: guide ? { 'Retry-After': '70' } : {},
    }));
    const response = page.waitForResponse('**/api/review');
    await pasteSource(page, mode, source);
    await clickReview(page, mode);
    release();
    const first = await response;
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
  await addPolicy(page, 'Outages.txt', 'The office manager keeps the outage log.');
  await continueToSource(page, 'questionnaire');
  const release = await holdNextReview(page);
  const response = page.waitForResponse('**/api/review');
  await pasteSource(page, 'questionnaire', question);
  await clickReview(page, 'questionnaire');
  release();
  const first = await response;
  expect(first.status()).toBe(503);
  await expect(page.getByRole('alert')).toContainText('Folio could not reach Anthropic. Try again shortly.');
  await expect(page.getByLabel('Questions', { exact: true })).toHaveValue(question);
  const retry = await submitReview(page, 'questionnaire');
  expect(retry.ok()).toBe(true);
  expect(retry.request().postDataJSON()).toEqual(first.request().postDataJSON());
  await expect(page.getByRole('heading', { name: question, exact: true })).toBeVisible();
});

for (const mode of ['questionnaire', 'guide']) {
  test(`a submitted ${mode} reopens from home while running and finishes at the same link`, async ({ page }) => {
    const source = mode === 'guide' ? 'Staff must retain the inspection log.' : 'Who retains the inspection log?';
    const requests = captureReviewRequests(page);
    await page.goto('/#/new/' + mode);
    await addPolicy(page, 'Inspection.txt', 'The registrar retains the inspection log.');
    await continueToSource(page, mode);
    const release = await holdNextReview(page);
    const started = page.waitForRequest('**/api/review');
    await pasteSource(page, mode, source);
    const request = await started;
    const home = page.getByRole('link', { name: 'Folio home' });
    const progress = page.getByRole('progressbar', { name: 'Review progress' });
    const row = page.getByRole('region', { name: 'Reviews', exact: true }).getByRole('link');
    let href;
    try {
      await clickReview(page, mode);
      await expect(progress).toBeVisible();
      await home.click();
      await expect(row).toHaveCount(1);
      await expect(row).toContainText('In progress');
      href = await row.getAttribute('href');
      await row.click();
      await expect(progress).toBeVisible();
      await home.click();
      await expect(row).toContainText('In progress');
    } finally {
      release();
    }
    const result = await request.response();
    expect(result?.ok()).toBe(true);
    await expect(row).not.toContainText('In progress');
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('href', href);
    await expect(page).toHaveURL(/#\/$/);
    await row.click();
    await expect(page.getByRole('heading', { name: source, exact: true })).toBeVisible();
    expect(requests).toHaveLength(1);
  });
}

test('cancelling a second review leaves the first available for retry from home', async ({ page }) => {
  const question = 'Who keeps the register?';
  const requests = captureReviewRequests(page);
  await page.goto('/#/new/questionnaire');
  await addPolicy(page, 'Register.txt', 'The registrar keeps the register.');
  await continueToSource(page, 'questionnaire');
  const failQuestionnaire = await holdNextReview(page, route => route.fulfill({
    status: 503, json: { error: 'Assessment interrupted.' },
  }));
  const started = page.waitForRequest('**/api/review');
  await pasteSource(page, 'questionnaire', question);
  await started;
  await clickReview(page, 'questionnaire');
  await page.getByRole('link', { name: 'All reviews' }).click();
  const list = page.getByRole('region', { name: 'Reviews', exact: true });
  const questionnaire = list.getByRole('link', { name: /State questionnaire/ });
  const href = await questionnaire.getAttribute('href');

  await page.getByRole('link', { name: /Review a new policy guide/ }).click();
  await addPolicy(page, 'Records.txt', 'Staff keep the signed register.');
  await continueToSource(page, 'guide');
  const releaseGuide = await holdNextReview(page);
  const guide = page.waitForRequest('**/api/review');
  try {
    await pasteSource(page, 'guide', 'Staff must retain the signed register.');
    const guideRequest = await guide;
    await clickReview(page, 'guide');
    await page.getByRole('link', { name: 'All reviews' }).click();
    await expect(list.getByRole('link', { name: /In progress/ })).toHaveCount(2);
    await list.getByRole('link', { name: /Regulatory guide/ }).click();
    const token = guideRequest.headers()['x-folio-review-token'];
    const revoked = page.waitForRequest(req => req.url().endsWith('/api/review-session') && req.postDataJSON().token === token);
    await page.getByRole('button', { name: 'Cancel review' }).click();
    await revoked;
    await expect(list.getByRole('link')).toHaveCount(1);
    await expect(questionnaire).toContainText('In progress');
  } finally {
    releaseGuide();
    failQuestionnaire();
  }

  await expect(questionnaire).toContainText('Needs attention');
  await questionnaire.click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Retry review' }).click();
  await expect(page.getByRole('heading', { name: question, exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'All reviews' }).click();
  await expect(list.getByRole('link')).toHaveCount(1);
  await expect(questionnaire).toHaveAttribute('href', href);
  await expect(questionnaire).toContainText('Ready');
  expect(requests.map(req => req.postDataJSON().mode)).toEqual(['questionnaire', 'guide', 'questionnaire']);
});

test('leaving an unsubmitted review keeps speculative work out of the saved library', async ({ page }) => {
  await page.goto('/#/new/questionnaire');
  await addPolicy(page, 'Registry.txt', 'The registrar keeps the inspection log.');
  await continueToSource(page, 'questionnaire');
  const release = await holdNextReview(page);
  const started = page.waitForRequest('**/api/review');
  await pasteSource(page, 'questionnaire', 'Who keeps the inspection log?');
  const request = await started;
  const list = page.getByRole('region', { name: 'Reviews', exact: true });
  try {
    await expectQuietReview(page);
    await page.getByRole('link', { name: 'Folio home' }).click();
    await expect(page.getByRole('heading', { name: 'Policy review', exact: true })).toBeVisible();
    await expect(list).toHaveCount(0);
  } finally {
    release();
  }
  const response = await request.response();
  await response?.finished();
  await expect(page).toHaveURL(/#\/$/);
  await expect(list).toHaveCount(0);
  await page.reload();
  await page.getByRole('link', { name: /Answer a questionnaire/ }).click();
  await expect(page.getByRole('heading', { name: 'Add existing policies' })).toBeVisible();
  await page.getByRole('link', { name: 'Folio home' }).click();
  await expect(list).toHaveCount(0);
});

test('reloading unfinished intake restores the source step, typed questions and original policy PDF', async ({ page, context }) => {
  const requests = captureReviewRequests(page);
  const pdf = await printPdf(context, ['Introductory remarks.', 'The registrar signs the inspection log.']);
  const question = 'Who signs the inspection log?';
  await page.goto('/#/new/questionnaire');
  await uploadPdf(page, 'Upload policy files', 'Records.pdf', pdf);
  await page.getByRole('button', { name: 'Preview Records.pdf' }).click();
  await chooseRange(page, 'Choose policy pages', /Policy pages/, '2');
  await continueToSource(page, 'questionnaire');
  await page.getByRole('button', { name: 'Paste a question or list' }).click();
  const field = page.getByLabel('Questions', { exact: true });
  await field.fill(question);
  await page.reload();
  await expect(field).toHaveValue(question);
  await expect(page).toHaveURL(/\/new\/questionnaire\/source$/);
  expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Preview Records.pdf' }).click();
  const viewer = page.getByRole('region', { name: 'PDF preview' });
  await expectPdfCanvas(viewer, 'Records.pdf', 2);
  await expect(viewer.getByRole('combobox', { name: 'PDF page' }).getByRole('option')).toHaveCount(1);
  await page.getByRole('link', { name: 'Folio home' }).click();
  await page.getByRole('link', { name: /Answer a questionnaire/ }).click();
  await expect(page.getByRole('button', { name: 'Continue to questions' })).toBeDisabled();
});

test('a new guide can explicitly reuse the full PDF and text policies from a questionnaire', async ({ page, context }) => {
  const sheets = ['Clerks maintain a visitor register.', 'Managers record closing exceptions.', 'The registrar signs the inspection log.'];
  const pdf = await printPdf(context, sheets);
  const pdfName = 'Register handbook.pdf';
  const textName = 'Closing procedure.txt';
  const text = ['Staff check the register at closing.', 'Supervisors file the signed copy.'];
  const pastedName = 'Supplemental memo';
  const questionFile = 'Closing questionnaire.txt';
  const guideFile = 'Closing guide.txt';
  const requests = captureReviewRequests(page);
  await page.goto('/#/new/questionnaire');
  await expect(page.getByRole('button', { name: 'Continue to questions' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Use last policies' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Paste a policy' }).click();
  await page.getByLabel(/Policy title/).fill(pastedName);
  await page.getByLabel('Policy text', { exact: true }).fill('The front desk holds the spare key.');
  await page.getByRole('button', { name: 'Add policy', exact: true }).click();
  await page.getByLabel('Upload policy files').setInputFiles([
    { name: pdfName, mimeType: 'application/pdf', buffer: pdf },
    { name: textName, mimeType: 'text/plain', buffer: Buffer.from(text.join('\f')) },
  ]);
  await page.getByRole('button', { name: 'Preview ' + pdfName }).click();
  await chooseRange(page, 'Choose policy pages', /Policy pages/, '1');
  await continueToSource(page, 'questionnaire');
  expect(requests).toHaveLength(0);
  const question = 'Who maintains the visitor register?';
  const first = page.waitForResponse('**/api/review');
  await page.getByLabel('Upload questionnaire').setInputFiles({
    name: questionFile, mimeType: 'text/plain', buffer: Buffer.from(question),
  });
  await submitReview(page, 'questionnaire', first);
  await expect(page.getByRole('heading', { name: question, exact: true })).toBeVisible();
  expect(requests[0].postDataJSON().pdfAttachments[0].pages).toEqual([1]);

  const guide = await context.newPage();
  const reusedRequests = captureReviewRequests(guide);
  await page.close();
  await guide.goto('/#/new/guide');
  const use = guide.getByRole('button', { name: 'Use last policies', exact: true });
  const added = guide.getByRole('list', { name: 'Added policies' });
  await expect(use).toBeVisible();
  const intake = guide.getByRole('region', { name: 'Add existing policies' });
  for (const filename of [pdfName, textName]) await expect(intake).toContainText(filename);
  for (const excluded of [pastedName, questionFile]) await expect(intake).not.toContainText(excluded);
  await expect(added).toHaveCount(0);
  await expect(guide.getByRole('button', { name: 'Continue to guide' })).toBeDisabled();
  await use.click();
  await expect(added.getByRole('listitem')).toHaveCount(2);
  await added.getByRole('button', { name: 'Preview ' + textName }).click();
  await guide.getByRole('combobox', { name: 'Page in ' + textName }).selectOption({ label: 'Page 2' });
  await expect(guide.getByRole('textbox', { name: 'Text of ' + textName + ', page 2' })).toHaveValue(text[1]);
  await added.getByRole('button', { name: 'Preview ' + pdfName }).click();
  const viewer = guide.getByRole('region', { name: 'PDF preview' });
  await expect(viewer.getByRole('combobox', { name: 'PDF page' }).getByRole('option')).toHaveCount(3);
  await chooseRange(guide, 'Choose policy pages', /Policy pages/, '3');
  await expectPdfCanvas(viewer, pdfName, 3);
  await chooseRange(guide, 'Choose policy pages', /Policy pages/, '1–3');
  await continueToSource(guide, 'guide');
  await expect(guide.getByRole('button', { name: 'Review obligations' })).toBeDisabled();
  expect(reusedRequests).toHaveLength(0);

  const duty = 'Staff must sign the inspection log.';
  const second = guide.waitForResponse('**/api/review');
  await guide.getByLabel('Upload regulatory guide').setInputFiles({
    name: guideFile, mimeType: 'text/plain', buffer: Buffer.from(duty),
  });
  const response = await submitReview(guide, 'guide', second);
  await expect(guide.getByRole('heading', { name: duty, exact: true })).toBeVisible();
  expect(reusedRequests).toHaveLength(1);
  const input = response.request().postDataJSON();
  expect(input.guide).toBe(duty);
  expect(input.documents.map(doc => doc.title)).toEqual([pdfName, textName]);
  expect(input.documents[0].pages).toEqual(sheets.map((text, index) => ({ number: index + 1, text })));
  expect(input.documents[1].pages).toEqual(text.map((text, index) => ({ number: index + 1, text })));
  expect(input.pdfAttachments).toHaveLength(1);
  expect(input.pdfAttachments[0]).toMatchObject({ title: pdfName, role: 'policy', pages: [1, 2, 3] });
  expect(Buffer.from(input.pdfAttachments[0].data, 'base64').equals(pdf)).toBe(true);
  await guide.getByRole('link', { name: 'All reviews' }).click();
  await guide.getByRole('link', { name: /Answer a questionnaire/ }).click();
  await expect(use).toBeVisible();
  await expect(intake).not.toContainText(guideFile);
  await use.click();
  await expect(added.getByRole('listitem')).toHaveCount(2);
  for (const filename of [pdfName, textName]) await expect(added).toContainText(filename);
});

test('a later valid upload replaces the reusable set before submission and forgetting it persists', async ({ page, context }) => {
  const original = 'Original register.txt';
  const latest = 'Revised register.txt';
  const requests = captureReviewRequests(page);
  await page.goto('/#/new/guide');
  await addPolicy(page, original, 'The registrar keeps the original register.');
  await page.getByRole('link', { name: 'Folio home' }).click();
  await page.getByRole('link', { name: /Answer a questionnaire/ }).click();
  const use = page.getByRole('button', { name: 'Use last policies', exact: true });
  const intake = page.getByRole('region', { name: 'Add existing policies' });
  await expect(use).toBeVisible();
  await expect(intake).toContainText(original);
  await expect(page.getByRole('button', { name: 'Continue to questions' })).toBeDisabled();
  await addPolicy(page, latest, 'The supervisor signs the revised register.');
  await page.getByLabel('Upload policy files').setInputFiles([
    { name: 'Unaccepted.txt', mimeType: 'text/plain', buffer: Buffer.from('A tentative replacement.') },
    { name: 'Unsupported.csv', mimeType: 'text/csv', buffer: Buffer.from('title,owner') },
  ]);
  await expect(page.getByRole('alert')).toContainText('Choose a PDF, TXT, or Markdown file.');
  const added = page.getByRole('list', { name: 'Added policies' });
  await expect(added.getByRole('listitem')).toHaveCount(1);
  await expect(added).toContainText(latest);
  expect(requests).toHaveLength(0);

  const fresh = await context.newPage();
  await page.close();
  const freshRequests = captureReviewRequests(fresh);
  await fresh.goto('/#/new/guide');
  const forget = fresh.getByRole('button', { name: 'Forget saved policies', exact: true });
  const freshIntake = fresh.getByRole('region', { name: 'Add existing policies' });
  await expect(forget).toBeVisible();
  await expect(freshIntake).toContainText(latest);
  for (const excluded of [original, 'Unaccepted.txt', 'Unsupported.csv']) await expect(freshIntake).not.toContainText(excluded);
  await expect(fresh.getByRole('button', { name: 'Continue to guide' })).toBeDisabled();
  await forget.click();
  await expect(fresh.getByRole('button', { name: 'Use last policies' })).toHaveCount(0);
  await expect(freshIntake).not.toContainText(latest);
  await fresh.getByRole('link', { name: 'Folio home' }).click();
  await fresh.getByRole('link', { name: /Answer a questionnaire/ }).click();
  await fresh.reload();
  await expect(fresh.getByRole('button', { name: 'Continue to questions' })).toBeDisabled();
  await expect(fresh.getByRole('button', { name: 'Use last policies' })).toHaveCount(0);
  await expect(freshIntake).not.toContainText(latest);
  expect(freshRequests).toHaveLength(0);
});

test('an older saved review can supply policy uploads when a newer review used only pasted text', async ({ page, context }) => {
  await page.goto('/');
  await createNamedQuestionnaire(page, 'Earlier review');
  await page.getByRole('link', { name: /Answer a questionnaire/ }).click();
  await page.getByRole('button', { name: 'Paste a policy' }).click();
  await page.getByLabel(/Policy title/).fill('Pasted.txt');
  await page.getByLabel('Policy text', { exact: true }).fill('The clerk signs the log.');
  await continueToSource(page, 'questionnaire');
  await pasteSource(page, 'questionnaire', 'Who signs the log?');
  await clickReview(page, 'questionnaire');
  await expect(page.getByRole('heading', { name: 'Who signs the log?', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'All reviews' }).click();

  // Recreate the catalog and draft-store shapes used before reusable uploads.
  await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('folio-local-reviews');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['catalog', 'drafts'], 'readwrite');
      tx.objectStore('drafts').delete(IDBKeyRange.bound('recent-policies:', 'recent-policies;'));
      const cursor = tx.objectStore('catalog').openCursor();
      cursor.onsuccess = () => {
        if (!cursor.result) return;
        const { key, mode, title, status, owner, position } = cursor.result.value;
        cursor.result.update({ key, mode, title, status, owner, position });
        cursor.result.continue();
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }));
  const fresh = await context.newPage();
  await fresh.goto('/#/new/guide');
  const use = fresh.getByRole('button', { name: 'Use policies from a saved review' });
  await expect(use).toHaveAccessibleDescription(/Earlier review.*Records\.txt/);
  await expect(fresh.getByRole('button', { name: 'Continue to guide' })).toBeDisabled();
  await use.click();
  const policies = fresh.getByRole('list', { name: 'Added policies' });
  await expect(policies.getByRole('listitem')).toHaveCount(1);
  await expect(policies).toContainText('Records.txt');
  await expect(fresh.getByRole('button', { name: 'Continue to guide' })).toBeEnabled();
});

test('a submitted review pauses across refresh and resumes once from its saved inputs', async ({ page }) => {
  const questions = Array.from({ length: 11 }, (_, index) => 'Who retains inspection log ' + (index + 1) + ' at closing?');
  const requests = captureReviewRequests(page);
  await page.goto('/#/new/questionnaire');
  await addPolicy(page, 'Retention.txt', 'The registrar retains the inspection log at closing.');
  await continueToSource(page, 'questionnaire');
  const gate = Promise.withResolvers();
  await page.route('**/api/review', async route => {
    if (route.request().postDataJSON().questions[0] === questions.at(-1)) {
      await gate.promise;
      await route.abort();
    } else {
      await route.continue();
    }
  }, { times: 2 });
  try {
    await pasteSource(page, 'questionnaire', questions.join('\n'));
    await clickReview(page, 'questionnaire');
    await expect.poll(() => requests.map(request => request.postDataJSON().questions)).toEqual([
      questions.slice(0, 10), questions.slice(10),
    ]);
    expect((await requests[0].response()).ok()).toBe(true);
    await expect(page.getByRole('progressbar', { name: 'Review progress' })).toHaveAttribute('aria-valuenow', '10');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Resume review' })).toBeVisible();
  } finally {
    gate.resolve();
  }
  const deepLink = page.url();
  await expect(page).toHaveURL(/#\/review\/.+/);
  await page.getByRole('link', { name: 'All reviews' }).click();
  const row = page.getByRole('region', { name: 'Reviews', exact: true }).getByRole('link');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Paused');
  await row.click();
  await expect(page).toHaveURL(deepLink);
  expect(requests).toHaveLength(2);
  const resumed = page.waitForResponse('**/api/review');
  await page.getByRole('button', { name: 'Resume review' }).click();
  expect((await resumed).request().postDataJSON()).toEqual(requests[1].postDataJSON());
  await expect(page.getByRole('heading', { name: questions[0], exact: true })).toBeVisible();
  await selectLastFinding(page, questions);
  await page.getByRole('button', { name: 'Responses', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Responses', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('navigation', { name: 'This review' }).getByRole('button', { name: 'Review questions', exact: true }).click();
  await expect(page.getByRole('heading', { name: questions.at(-1), exact: true })).toBeVisible();
  await expect(page).toHaveURL(deepLink);
  expect(requests).toHaveLength(3);
});

test('two tabs resuming the same paused review send one assessment and see the same result', async ({ page, context }) => {
  const question = 'Who verifies the inspection log?';
  const policy = 'The registrar verifies the inspection log.';
  await page.goto('/#/new/questionnaire');
  await addPolicy(page, 'Inspection.txt', policy);
  await continueToSource(page, 'questionnaire');
  const releaseInitial = await holdNextReview(page, route => route.abort());
  const started = page.waitForRequest('**/api/review');
  try {
    await pasteSource(page, 'questionnaire', question);
    await started;
    await clickReview(page, 'questionnaire');
    await expect(page.getByRole('progressbar', { name: 'Review progress' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Resume review' })).toBeVisible();
  } finally {
    releaseInitial();
  }

  const other = await context.newPage();
  const reviewUrl = page.url();
  await other.goto(reviewUrl);
  const tabs = [page, other];
  const resumeButtons = await Promise.all(tabs.map(async tab => {
    const button = tab.getByRole('button', { name: 'Resume review' });
    await expect(button).toBeVisible();
    return button.elementHandle();
  }));
  const gate = Promise.withResolvers();
  const attempts = [];
  await context.route('**/api/review', async route => {
    attempts.push(route.request());
    await gate.promise;
    await route.continue();
  });
  try {
    // Dispatch both prepared clicks together, before either page waits for the other's claim.
    await Promise.all(resumeButtons.map(button => button.evaluate(element => element.click())));
    await expect.poll(() => attempts.length).toBe(1);
    const owner = attempts[0].frame().page();
    const observer = owner === page ? other : page;
    await expect(owner.getByRole('progressbar', { name: 'Review progress' })).toBeVisible();
    await expect(observer.getByText('This review is running in another tab.')).toBeVisible();
  } finally {
    gate.resolve();
  }
  for (const tab of tabs) {
    await expect(tab).toHaveURL(reviewUrl);
    await expect(tab.getByRole('heading', { name: question, exact: true })).toBeVisible();
    await tab.getByRole('button', { name: /Inspection\.txt.*p\. 1/ }).first().click();
    await expect(tab.locator('dialog mark')).toHaveText(policy);
  }
  expect(attempts).toHaveLength(1);
});

test('a browser that denies IndexedDB warns the analyst and keeps the current review usable', async ({ page }) => {
  await page.addInitScript(() => {
    IDBFactory.prototype.open = () => { throw new DOMException('Access denied', 'SecurityError'); };
  });
  await page.goto('/');
  const warning = page.getByRole('alert').filter({ hasText: /Keep this page open/i });
  await expect(warning).toBeVisible();
  await createNamedQuestionnaire(page, 'Local inspection');
  const library = page.getByRole('region', { name: 'Reviews', exact: true });
  await library.getByRole('link', { name: /Local inspection/ }).click();
  const answer = 'The registrar signs it at closing.';
  await page.getByLabel('Response for submission').fill(answer);
  await page.getByRole('button', { name: 'Cite in response', exact: true }).first().click();
  await page.getByRole('button', { name: 'Confirm response', exact: true }).click();
  const output = await outputPdfText(page, 'Responses');
  expect(output).toContain(answer);
  expect(output).toContain('Question 1 · Confirmed');
  await expect(warning).toBeVisible();
});

test('a completed guide keeps its saved action and original cited PDFs when reopened', async ({ page, context }) => {
  const duty = 'Staff must sign the inspection log.';
  const passage = 'Office staff sign the inspection log.';
  const note = 'Add the signature check to the closing procedure.';
  const guide = await printPdf(context, ['Overview.', duty]);
  const policy = await printPdf(context, [passage]);
  await page.goto('/#/new/guide');
  await uploadPdf(page, 'Upload policy files', 'Closing policy.pdf', policy);
  await continueToSource(page, 'guide');
  await uploadPdf(page, 'Upload regulatory guide', 'Closing guide.pdf', guide);
  await clickReview(page, 'guide');
  await expect(page.getByRole('heading', { name: duty, exact: true })).toBeVisible();
  const resolve = page.getByRole('button', { name: 'Resolve obligation 1', exact: true });
  await resolve.click();
  await page.getByRole('button', { name: 'Reopen obligation 1', exact: true }).click();
  await expect(resolve).toBeVisible();
  await page.getByRole('button', { name: 'Cite in action', exact: true }).first().click();
  await page.getByRole('radio', { name: 'Write new policy', exact: true }).check();
  const actionText = 'Require staff to sign the closing log.';
  await page.getByLabel('Policy action draft', { exact: true }).fill(actionText);
  await page.getByLabel('Action note').fill(note);
  await page.getByRole('button', { name: 'Save action', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit action' })).toHaveAccessibleDescription('Policy action saved');
  const reviewUrl = page.url();
  const reopened = await context.newPage();
  await page.close();
  const requests = captureReviewRequests(reopened);
  await reopened.goto(reviewUrl);
  await expect(reopened.getByRole('button', { name: 'Reopen obligation 1', exact: true })).toBeVisible();
  await expect(reopened.getByLabel('Policy action draft')).toBeHidden();
  await reopened.getByRole('button', { name: 'Edit action', exact: true }).click();
  await expect(reopened.getByRole('radio', { name: 'Write new policy', exact: true })).toBeChecked();
  await expect(reopened.getByLabel('Policy action draft')).toHaveValue(actionText);
  await expect(reopened.getByLabel('Action note')).toHaveValue(note);
  const citations = reopened.getByRole('list').filter({ has: reopened.getByRole('button', { name: 'Remove action citation 1' }) });
  for (const [title, number, quote] of [['Closing guide.pdf', 2, duty], ['Closing policy.pdf', 1, passage]]) {
    const source = title === 'Closing policy.pdf' ? citations : reopened;
    await source.getByRole('button', { name: new RegExp(title + '.*p\\. ' + number) }).click();
    const dialog = reopened.getByRole('dialog');
    await expectPdfCanvas(dialog, title, number);
    await expect(dialog.getByRole('complementary', { name: 'Cited passage' })).toContainText(quote);
    await expect(dialog.locator('.pdf-text-layer mark').first()).toBeVisible();
    await reopened.keyboard.press('Escape');
  }
  const pdf = await outputPdfText(reopened, 'Action list');
  for (const value of ['Obligation 1 · Saved', note, actionText, 'Closing policy.pdf · p. 1', passage]) expect(pdf).toContain(value);
  expect(requests).toHaveLength(0);
});

test('guide actions saved by the original editor reopen with their disposition and note', async ({ page }) => {
  const duty = 'Staff must sign the inspection register.';
  const note = 'Add a signature line to the original register.';
  await page.goto('/#/new/guide');
  await addPolicy(page, 'Closing.txt', 'The coordinator keeps the inspection register.');
  await continueToSource(page, 'guide');
  const assessment = page.waitForResponse('**/api/review');
  await pasteSource(page, 'guide', duty);
  const response = await submitReview(page, 'guide', assessment);
  await expect(page.getByRole('heading', { name: duty, exact: true })).toBeVisible();
  const reviewKey = new URL(page.url()).hash.slice('#/review/'.length);
  const findingId = (await response.json()).findings[0].id;
  await page.evaluate(({ reviewKey, findingId, note }) => new Promise((resolve, reject) => {
    const open = indexedDB.open('folio-local-reviews');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction('findings', 'readwrite');
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
      transaction.objectStore('findings').put({
        reviewKey, findingKey: reviewKey + '/' + findingId,
        state: { decision: { action: 'update', note, at: '2025-08-01T00:00:00.000Z' } },
      });
    };
  }), { reviewKey, findingId, note });

  await page.reload();
  const edit = page.getByRole('button', { name: 'Edit action', exact: true });
  const resolve = page.getByRole('button', { name: 'Resolve obligation 1', exact: true });
  await expect(edit).toHaveAccessibleDescription('Policy action saved');
  await page.getByRole('button', { name: 'Reopen obligation 1', exact: true }).click();
  await page.reload();
  await expect(resolve).toBeVisible();
  await edit.click();
  await expect(page.getByRole('radio', { name: 'Update existing policy' })).toBeChecked();
  await expect(page.getByLabel('Action note')).toHaveValue(note);
  const replacement = 'Add the signature line before the next print run.';
  await page.getByLabel('Action note').fill(replacement);
  await page.reload();
  await expect(page.getByLabel('Action note')).toHaveValue(replacement);
  await expect(resolve).toBeVisible();
});

test('renaming, moving and deleting a saved review persist independently', async ({ page }) => {
  await page.goto('/');
  await createNamedQuestionnaire(page, 'Annual inspection');
  await createNamedQuestionnaire(page, 'Quarterly inspection');
  const library = page.getByRole('region', { name: 'Reviews', exact: true });
  const links = library.getByRole('link');
  await expect(links).toHaveText([/Quarterly inspection/, /Annual inspection/]);
  const originalHref = await links.last().getAttribute('href');
  await chooseReviewAction(page, 'Annual inspection', 'Rename');
  await page.getByRole('textbox', { name: 'Review name' }).fill('Year-end audit');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await chooseReviewAction(page, 'Year-end audit', 'Move up');
  await page.reload();
  await expect(links).toHaveText([/Year-end audit/, /Quarterly inspection/]);
  await expect(links.first()).toHaveAttribute('href', originalHref);
  await chooseReviewAction(page, 'Year-end audit', 'Move down');
  await chooseReviewAction(page, 'Year-end audit', 'Delete');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.reload();
  await expect(links).toHaveText([/Quarterly inspection/, /Year-end audit/]);
  await chooseReviewAction(page, 'Year-end audit', 'Delete');
  await page.getByRole('button', { name: 'Delete review', exact: true }).click();
  await expect(links).toHaveText([/Quarterly inspection/]);
  await page.reload();
  await expect(links).toHaveText([/Quarterly inspection/]);
  await links.click();
  await expect(page.getByRole('heading', { name: 'Who signs the inspection log for Quarterly inspection?' })).toBeVisible();
});

test('a pending rename survives closing the tab before its database write commits', async ({ page, context }) => {
  await page.goto('/');
  await createNamedQuestionnaire(page, 'Renewal checklist');
  await chooseReviewAction(page, 'Renewal checklist', 'Rename');
  await page.evaluate(() => {
    const transact = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function(stores, mode, options) {
      if (mode === 'readwrite') throw new DOMException('Storage unavailable', 'QuotaExceededError');
      return transact.call(this, stores, mode, options);
    };
  });
  await page.getByRole('textbox', { name: 'Review name' }).fill('Annual renewal');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Keep this page open');
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto('/#review-options');
  const links = reopened.getByRole('region', { name: 'Reviews', exact: true }).getByRole('link');
  await expect(links).toHaveText([/Annual renewal/]);
  await reopened.reload();
  await expect(links).toHaveText([/Annual renewal/]);
});

test('deleting an active review in another tab prevents its late result from restoring it', async ({ page, context }) => {
  await page.goto('/');
  await createNamedQuestionnaire(page, 'Existing record');
  await page.getByRole('link', { name: /Review a new policy guide/ }).click();
  await addPolicy(page, 'Records.txt', 'The registrar signs the inspection log.');
  await continueToSource(page, 'guide');
  const intercepted = Promise.withResolvers();
  await page.route('**/api/review', route => intercepted.resolve(route), { times: 1 });
  const obligation = 'Staff must sign the inspection log.';
  await page.getByLabel('Upload regulatory guide').setInputFiles({
    name: 'Closing procedure.txt', mimeType: 'text/plain', buffer: Buffer.from(obligation),
  });
  const route = await intercepted.promise;
  const token = route.request().headers()['x-folio-review-token'];
  expect(token).toBeTruthy();
  // The provider has finished, but the page is still waiting for delivery.
  const assessment = await route.fetch();
  expect(assessment.ok()).toBe(true);
  expect((await assessment.json()).findings[0].question).toBe(obligation);
  const manager = await context.newPage();
  const links = manager.getByRole('region', { name: 'Reviews', exact: true }).getByRole('link');
  try {
    await clickReview(page, 'guide');
    await expect(page.getByRole('progressbar', { name: 'Review progress' })).toBeVisible();
    await manager.goto('/#review-options');
    await chooseReviewAction(manager, 'Closing procedure', 'Delete');
    const [revocation] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/review-session') &&
        response.request().postDataJSON().token === token),
      manager.getByRole('button', { name: 'Delete review', exact: true }).click(),
    ]);
    expect(revocation.ok()).toBe(true);
    await expect(links).toHaveText([/Existing record/]);
  } finally {
    await route.fulfill({ response: assessment });
  }
  await page.getByRole('link', { name: 'Folio home' }).click();
  await expect(page.getByRole('region', { name: 'Reviews', exact: true }).getByRole('link')).toHaveText([/Existing record/]);
  await manager.reload();
  await expect(links).toHaveText([/Existing record/]);
});

test('a prepared review waits for submission and rejects a keyword-only result', async ({ page }) => {
  const question = 'Who keeps inspection records?';
  const input = { mode: 'questionnaire', questions: [question], allowModel: false, documents: [{
    id: 'registry', title: 'Registry', pages: [{ number: 8, text: 'The registrar keeps inspection records.' }],
  }] };
  const requests = captureReviewRequests(page);
  await page.goto('/#/new/questionnaire');
  await page.getByLabel('Import a prepared review (.json)').setInputFiles({
    name: 'inspection.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(input)),
  });
  await expect(page.getByRole('list', { name: 'Added policies' })).toContainText('Registry');
  await expect(page).toHaveURL(/\/new\/questionnaire$/);
  await continueToSource(page, 'questionnaire');
  await expect(page.getByLabel('Questions', { exact: true })).toHaveValue(question);
  expect(requests).toHaveLength(0);
  await page.route('**/api/review', route => route.fulfill({ json: { engine: 'local', findings: [] } }), { times: 1 });
  await submitReview(page, 'questionnaire');
  await expect(page.getByRole('alert')).toContainText('The AI review could not finish.');
  const retry = await submitReview(page, 'questionnaire');
  expect(retry.request().postDataJSON()).toMatchObject({ questions: [question], documents: input.documents });
  await expect(page.getByRole('heading', { name: question, exact: true })).toBeVisible();
});

test('a guide waits for its final source file and opens the completed review only on submission', async ({ page, context }) => {
  const duty = 'Staff must retain the signed archive register.';
  const pdf = await printPdf(context, [duty, 'Registry reference notes.']);
  const policy = await printPdf(context, ['Staff keep the signed archive register.']);
  const requests = captureReviewRequests(page);
  const release = await holdNextReview(page);
  await page.goto('/#/new/guide');
  const steps = page.getByRole('navigation', { name: 'Review steps' });
  const policies = steps.getByRole('button', { name: /Existing policies/ });
  const guide = steps.getByRole('button', { name: /Regulatory guide/ });
  await expect(steps.getByRole('button').first()).toHaveAccessibleName('Existing policies');
  await expect(policies).toHaveAttribute('aria-current', 'step');
  await expect(guide).toBeDisabled();
  await expect(steps.getByText('Required', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue to guide' })).toBeDisabled();
  await expect(page.getByLabel('Upload policy files')).toHaveAccessibleDescription(/polic/i);
  await uploadPdf(page, 'Upload policy files', 'Archive policy.pdf', policy);
  await continueToSource(page, 'guide');
  await expect(guide).toHaveAttribute('aria-current', 'step');
  const submit = page.getByRole('button', { name: 'Review obligations' });
  await expect(submit).toBeDisabled();
  await expect(submit).toHaveAccessibleDescription('');
  await expectQuietReview(page);
  expect(requests).toHaveLength(0);

  const started = page.waitForRequest('**/api/review');
  await uploadPdf(page, 'Upload regulatory guide', 'Archive guide.pdf', pdf);
  expect((await started).postDataJSON()).toMatchObject({
    mode: 'guide', documents: [{ title: 'Archive policy.pdf' }], allowModel: true, modelSharingConsent: true,
    pdfAttachments: [{ role: 'source', title: 'Archive guide.pdf' }, { role: 'policy', title: 'Archive policy.pdf' }],
  });
  await page.getByRole('button', { name: 'Preview PDF', exact: true }).click();
  await expectPdfCanvas(page.getByRole('region', { name: 'PDF preview' }), 'Archive guide.pdf', 1);
  await expectQuietReview(page);
  await clickReview(page, 'guide');
  await expect(page.getByRole('progressbar', { name: 'Review progress' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel review' })).toBeVisible();
  await policies.click();
  await page.getByRole('button', { name: 'Preview Archive policy.pdf' }).click();
  await expectQuietReview(page);
  const finished = waitForBackgroundReview(page);
  release();
  await finished;
  await expect(page).toHaveURL(/\/new\/guide$/);
  await expectQuietReview(page);
  await continueToSource(page, 'guide');
  await expectQuietReview(page);
  await clickReview(page, 'guide');
  await expect(page.getByRole('heading', { name: duty, exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
});

test('a committed pasted policy unlocks the questionnaire and the final PDF starts the review', async ({ page, context }) => {
  const question = 'Who keeps the inspection log?';
  const policy = 'The registrar keeps the inspection log.';
  const form = await printPdf(context, [question]);
  const requests = captureReviewRequests(page);
  await page.goto('/#/new/questionnaire');
  const steps = page.getByRole('navigation', { name: 'Review steps' });
  const questions = steps.getByRole('button', { name: 'State questions', exact: true });
  await expect(steps.getByRole('button').first()).toHaveAccessibleName('Existing policies');
  await expect(steps.getByText('Required', { exact: true })).toHaveCount(0);
  await expect(questions).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Continue to questions' })).toBeDisabled();
  await page.getByRole('button', { name: 'Paste a policy' }).click();
  await page.getByLabel(/Policy title/).fill('Registry');
  await page.getByLabel('Policy text', { exact: true }).fill(policy);
  await page.getByRole('button', { name: 'Add policy', exact: true }).click();
  await expect(questions).toBeEnabled();
  await questions.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Answer a questionnaire' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Find evidence' })).toBeDisabled();
  await page.goBack();
  await expect(page.getByRole('list', { name: 'Added policies' })).toContainText('Registry');
  await page.goForward();
  await expect(page).toHaveURL(/\/new\/questionnaire\/source$/);
  expect(requests).toHaveLength(0);

  const started = page.waitForRequest('**/api/review');
  const finished = waitForBackgroundReview(page);
  await uploadPdf(page, 'Upload questionnaire', 'Form.pdf', form);
  expect((await started).postDataJSON()).toMatchObject({
    questions: [question], documents: [{ title: 'Registry', pages: [{ number: 1, text: policy }] }],
  });
  await finished;
  await expectQuietReview(page);
  await expect(page).toHaveURL(/\/new\/questionnaire\/source$/);
  await clickReview(page, 'questionnaire');
  await expect(page.getByRole('heading', { name: question, exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
});

test('history navigation keeps a new pasted policy on the first step until it is added', async ({ page }) => {
  await page.goto('/#/new/questionnaire');
  await addPolicy(page, 'Records.txt', 'The clerk keeps the register.');
  await continueToSource(page, 'questionnaire');
  await page.goBack();
  await page.getByRole('button', { name: 'Paste a policy' }).click();
  await page.getByLabel(/Policy title/).fill('Inspections');
  const policy = page.getByLabel('Policy text', { exact: true });
  await policy.fill('The manager signs the inspection report.');
  await page.goForward();
  await expect(page).toHaveURL(/\/new\/questionnaire$/);
  await expect(policy).toHaveValue('The manager signs the inspection report.');
  await continueToSource(page, 'questionnaire');
  await expect(page.getByRole('button', { name: 'Find evidence' })).toBeDisabled();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Added policies' }).getByRole('listitem')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Preview Inspections' })).toBeVisible();
});

test('removing the last policy locks the source step until a new policy is added', async ({ page }) => {
  await page.goto('/#/new/questionnaire/source');
  await expect(page).toHaveURL(/\/new\/questionnaire$/);
  const questions = page.getByRole('navigation', { name: 'Review steps' }).getByRole('button', { name: /State questions/ });
  await addPolicy(page, 'Register.txt', 'The registrar signs the register.');
  await continueToSource(page, 'questionnaire');
  await page.goBack();
  await page.getByRole('button', { name: 'Remove Register.txt' }).click();
  await expect(questions).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Continue to questions' })).toBeDisabled();
  await page.goForward();
  await expect(page).toHaveURL(/\/new\/questionnaire$/);
  await expect(page.getByRole('heading', { name: 'Add existing policies' })).toBeVisible();
  await addPolicy(page, 'Signatures.txt', 'The manager signs the register.');
  await questions.click();
  await expect(page.getByRole('heading', { name: 'Answer a questionnaire' })).toBeFocused();
});

test('editing a running questionnaire aborts it and only explicit submission reviews the changes', async ({ page }) => {
  const oldQuestion = 'Who keeps the inspection log?';
  const newQuestion = 'Who signs the revised inspection log?';
  const requests = captureReviewRequests(page);
  await page.goto('/#/new/questionnaire');
  await addPolicy(page, 'Inspection.md', 'The clerk keeps the inspection log.');
  await continueToSource(page, 'questionnaire');
  const release = await holdNextReview(page);
  const started = page.waitForRequest('**/api/review');
  const questions = page.getByLabel('Questions', { exact: true });
  await page.getByRole('button', { name: 'Paste a question or list' }).click();
  await questions.fill(oldQuestion);
  await expect(questions).toBeFocused();
  expect(requests).toHaveLength(0);
  await questions.blur();
  const first = await started;
  const cancelled = page.waitForEvent('requestfailed', request => request === first);
  const token = first.headers()['x-folio-review-token'];
  expect(token).toBeTruthy();
  const stopped = page.waitForResponse(response => response.url().endsWith('/api/review-session') &&
    response.request().postDataJSON().token === token);
  await questions.fill(newQuestion);
  await questions.blur();
  release();
  expect((await cancelled).failure().errorText).toContain('ABORTED');
  expect((await stopped).status()).toBe(200);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await addPolicy(page, 'Signatures.txt', 'The registrar signs the revised inspection log.');
  await page.getByRole('button', { name: 'Remove Inspection.md' }).click();
  await page.getByRole('button', { name: 'Preview Signatures.txt' }).click();
  await continueToSource(page, 'questionnaire');
  await expect(questions).toHaveValue(newQuestion);
  await expectQuietReview(page);
  await expect(page.getByText(/Inputs changed/)).toHaveCount(0);
  expect(requests).toHaveLength(1);
  const revised = await submitReview(page, 'questionnaire');
  expect(revised.request().postDataJSON()).toMatchObject({
    questions: [newQuestion], documents: [{ title: 'Signatures.txt' }],
  });
  await expect(page.getByRole('heading', { name: newQuestion, exact: true })).toBeVisible();
  expect(requests).toHaveLength(2);

  await page.getByRole('link', { name: 'All reviews' }).click();
  await page.getByRole('link', { name: /Answer a questionnaire/ }).click();
  await addPolicy(page, 'Records.txt', 'The office manager keeps the inspection log.');
  await continueToSource(page, 'questionnaire');
  const fresh = page.waitForRequest('**/api/review');
  const finished = waitForBackgroundReview(page);
  await page.getByLabel('Upload questionnaire').setInputFiles({
    name: 'Inspection.txt', mimeType: 'text/plain', buffer: Buffer.from(oldQuestion),
  });
  expect((await fresh).postDataJSON()).toMatchObject({ questions: [oldQuestion], documents: [{ title: 'Records.txt' }] });
  await finished;
  await expectQuietReview(page);
  await expect(page).toHaveURL(/\/new\/questionnaire\/source$/);
  expect(requests).toHaveLength(3);
});

test('each selected PDF shows preparation, attachment, and a persistent policy entry', async ({ page, context }) => {
  await page.addInitScript(() => {
    const gate = Promise.withResolvers();
    window.releasePolicyReads = gate.resolve;
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function () {
      await gate.promise;
      return read.call(this);
    };
  });
  const first = await printPdf(context, ['The clerk keeps the inspection log.']);
  const second = await printPdf(context, ['The manager signs the inspection log.']);
  await page.goto('/#/new/questionnaire');
  const requests = captureReviewRequests(page);
  const upload = page.getByLabel('Upload policy files');
  await expect(upload).toHaveAccessibleDescription(/polic/i);
  await upload.setInputFiles([
    { name: 'Clerk.pdf', mimeType: 'application/pdf', buffer: first },
    { name: 'Manager.pdf', mimeType: 'application/pdf', buffer: second },
  ]);
  for (const name of ['Clerk.pdf', 'Manager.pdf']) {
    await expect(page.getByRole('progressbar', { name: 'Preparing ' + name })).toBeAttached();
    await expect(page.locator('.intake-file-feedback').filter({ hasText: name })).toContainText('Preparing PDF');
  }
  expect(requests).toHaveLength(0);
  await page.evaluate(() => window.releasePolicyReads());
  const policies = page.getByRole('list', { name: 'Added policies' });
  await expect(policies.getByRole('listitem')).toHaveCount(2);
  await expect(page.getByText('PDF attached', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Continue to questions' })).toBeEnabled();
  await expect(page.locator('.intake-file-feedback')).toHaveCount(0);
  await expect(policies).toContainText('Clerk.pdf');
  await expect(policies).toContainText('Manager.pdf');
  await continueToSource(page, 'questionnaire');
  await expect(page.getByRole('button', { name: 'Find evidence' })).toBeDisabled();
  expect(requests).toHaveLength(0);
  const finished = waitForBackgroundReview(page);
  await pasteSource(page, 'questionnaire', 'Who keeps the inspection log?');
  await finished;
  await expectQuietReview(page);
  await page.goBack();
  await expect(policies.getByRole('listitem')).toHaveCount(2);
  expect(requests).toHaveLength(1);
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
  await expect(page.getByRole('heading', { name: 'Reviews', exact: true })).toHaveCount(0);
  await expect(page.getByRole('banner').getByRole('button', { name: 'Document privacy' })).toHaveCount(0);
  await page.getByRole('link', { name: /Answer a questionnaire/ }).click();
  await expect(page.getByRole('heading', { name: 'Add existing policies' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to questions' })).toBeDisabled();
  await addPolicy(page, 'Facilities.txt', policy);
  await page.getByRole('button', { name: 'Preview Facilities.txt', exact: true }).click();
  const preview = page.getByRole('textbox', { name: 'Text of Facilities.txt, page 1' });
  await expect(preview).toHaveValue(policy);
  await expect(preview).not.toBeEditable();
  await continueToSource(page, 'questionnaire');
  await expect(page.getByRole('button', { name: 'Find evidence' })).toBeDisabled();
  const assessment = page.waitForResponse('**/api/review');
  await pasteSource(page, 'questionnaire', question);
  await (await assessment).finished();
  await page.goBack();
  await expect(page).toHaveURL(/#\/new\/questionnaire$/);
  await expect(page.getByRole('list', { name: 'Added policies' })).toContainText('Facilities.txt');
  await page.goForward();
  await expect(page).toHaveURL(/#\/new\/questionnaire\/source$/);
  await expect(page.getByLabel('Questions', { exact: true })).toHaveValue(question);
  const response = await submitReview(page, 'questionnaire', assessment);
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
  const editor = page.getByLabel('Response for submission');
  const tools = page.getByRole('group', { name: 'Response writing tools' });
  await expect(editor).toBeEmpty();
  await expect(tools.getByRole('button')).toHaveText(['Generate response']);
  const writing = page.waitForResponse('**/api/review?operation=draft');
  await tools.getByRole('button', { name: 'Generate response' }).click();
  const written = await writing;
  expect(written.request().postDataJSON()).toMatchObject({ action: 'draft', question, answer: '', citations: [{ quote: policy }] });
  expect(await providerCalls(written)).toEqual([{ tool: 'record_response_draft', documents: [] }]);
  await expect(editor).toHaveValue(policy);
  await expect(tools.getByRole('button')).toHaveText(['Shorten', 'Simplify', 'Add detail']);
  await tools.getByRole('button', { name: 'Shorten' }).click();
  await expect(editor).toHaveValue('The facilities coordinator.');
  await tools.getByRole('button', { name: 'Add detail' }).click();
  await expect(editor).toHaveValue('The facilities coordinator. ' + policy);
  await tools.getByRole('button', { name: 'Undo' }).click();
  await expect(editor).toHaveValue('The facilities coordinator.');
  await tools.getByRole('button', { name: 'Simplify' }).click();
  await expect(editor).toHaveValue('The coordinator records the date.');
  const draft = await outputPdfText(page, 'Responses');
  expect(draft).toContain('Question 1 · Draft');
  expect(draft).toContain('The coordinator records the date.');
  expect(draft).toContain('Facilities.txt · p. 1');
  await page.getByRole('navigation', { name: 'This review' }).getByRole('button', { name: 'Review questions' }).click();
  await page.getByRole('button', { name: 'Remove response citation 1' }).click();
  await page.getByLabel('Response for submission').fill('The facilities coordinator.');
  const confirm = page.getByRole('button', { name: 'Confirm response', exact: true });
  await expect(confirm).toBeDisabled();
  await expect(confirm).toHaveAccessibleDescription(/Select “Cite in response” on a policy passage.*“Flag for follow-up”/);
  await page.getByRole('button', { name: 'Cite in response', exact: true }).first().click();
  await expect(confirm).toHaveAccessibleDescription('');
  await confirm.click();
  const reopen = page.getByRole('button', { name: 'Edit response', exact: true });
  await expect(reopen).toBeFocused();
  await expect(reopen).toHaveAccessibleDescription('Response confirmed');
  await expect(page.getByRole('button', { name: 'Reopen question 1', exact: true })).toBeVisible();
  await expect(reopen).toHaveAttribute('aria-expanded', 'false');
  await expect(editor).toBeHidden();
  await expect(tools).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Response citations' })).toBeHidden();
  const output = await outputPdfText(page, 'Responses');
  expect(output).toContain('The facilities coordinator.');
  expect(output).toContain('Confirmed');
  expect(output).toContain('Facilities.txt · p. 1');
  expect(output).toContain(policy);
  await page.getByRole('link', { name: 'All reviews' }).click();
  await expect(options).toBeInViewport();
  await expect(page.getByRole('heading', { name: 'Reviews', exact: true })).toBeVisible();
  await page.locator('.session-review').click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Reopen question 1', exact: true })).toBeVisible();
  await expect(editor).toBeHidden();
  await reopen.click();
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue('The facilities coordinator.');
  await expect(page.getByRole('button', { name: 'Remove response citation 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Flag for follow-up', exact: true }).click();
  await expect(reopen).toHaveAccessibleDescription('Flagged for follow-up');
  await expect(editor).toBeHidden();
  expect(await outputPdfText(page, 'Responses')).toContain('Question 1 · Flagged for follow-up');
  await page.getByRole('navigation', { name: 'This review' }).getByRole('button', { name: 'Review questions' }).click();
  await reopen.click();
  await expect(editor).toHaveValue('The facilities coordinator.');
  await expect(page.getByRole('button', { name: 'Remove response citation 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove flag', exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(reopen).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Resolve question 1', exact: true })).toBeVisible();
});

test('The question queue resolves and reopens questions independently of saved responses', async ({ page }) => {
  const questions = ['Who checks the gate?', 'Who keeps the log?', 'Who signs the declaration?',
    'Who records exceptions?', 'Who checks permits?', 'Who reviews access?'];
  await page.goto('/#/new/questionnaire');
  await addPolicy(page, 'Records.txt', 'The coordinator keeps the log and reviews access each month.');
  await continueToSource(page, 'questionnaire');
  await pasteSource(page, 'questionnaire', questions.join('\n'));
  await clickReview(page, 'questionnaire');

  const queue = page.getByRole('complementary', { name: 'Review queue' });
  const showList = queue.getByRole('button', { name: /Show list/ });
  async function showQueue() {
    await expect(queue).toBeVisible();
    if (await showList.isVisible()) await showList.click();
  }
  const open = queue.getByRole('region', { name: 'Open questions' });
  const resolved = queue.getByRole('region', { name: 'Resolved questions' });
  const disclosure = queue.getByRole('button', { name: /^Resolved \d+$/ });
  const responses = page.getByRole('region', { name: 'Responses', exact: true });
  const heading = page.getByRole('heading', { name: questions[0], exact: true });
  await expect(heading).toBeVisible();
  await showQueue();
  await open.getByRole('button', { name: 'Resolve question 1', exact: true }).click();
  await expect(heading).toBeVisible();
  await expect(open.locator('.row-name')).toHaveText(questions.slice(1));
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Responses', exact: true }).click();
  await expect(responses.getByRole('button', { name: 'Download PDF' })).toBeDisabled();
  await page.getByRole('navigation', { name: 'This review' }).getByRole('button', { name: 'Review questions' }).click();
  await showQueue();
  await queue.getByRole('textbox', { name: 'Search questions' }).fill('gate');
  await expect(resolved.locator('.row-name')).toHaveText([questions[0]]);
  await queue.getByRole('button', { name: 'Clear search' }).click();

  await open.getByRole('button', { name: /Who keeps the log/ }).click();
  await page.getByLabel('Response for submission').fill('The coordinator keeps the log.');
  await showQueue();
  await expect(open.locator('.row-name')).toContainText([questions[1]]);
  await page.getByRole('button', { name: 'Cite in response', exact: true }).first().click();
  await page.getByRole('button', { name: 'Confirm response', exact: true }).click();
  await showQueue();
  await expect(open.locator('.row-name')).toHaveText(questions.slice(2));
  await page.getByRole('button', { name: 'Next question' }).click();
  await page.getByRole('button', { name: 'Flag for follow-up', exact: true }).click();
  await page.getByRole('link', { name: 'All reviews' }).click();
  await page.reload();
  await page.locator('.session-review').click();
  await showQueue();
  await expect(disclosure).toHaveText('Resolved 3');
  await disclosure.click();
  await expect(resolved.locator('.row-name')).toHaveText(questions.slice(0, 3));
  await resolved.getByRole('button', { name: 'Reopen question 2', exact: true }).click();
  await resolved.getByRole('button', { name: 'Reopen question 3', exact: true }).click();
  await expect(open.locator('.row-name')).toHaveText(questions.slice(1));
  await expect(open.getByRole('button', { name: /Who keeps the log/ })).toContainText('Confirmed');
  await expect(open.getByRole('button', { name: /Who signs the declaration/ })).toContainText('Flagged for follow-up');
  await resolved.getByRole('button', { name: 'Reopen question 1', exact: true }).click();
  await expect(disclosure).toHaveCount(0);
  await expect(open.locator('.row-name')).toHaveText(questions);
  await page.getByRole('button', { name: 'Responses', exact: true }).click();
  await expect(responses.locator('.decision-entry')).toHaveText([
    /Confirmed.*Who keeps the log.*The coordinator keeps the log/, /Flagged for follow-up.*Who signs the declaration/,
  ]);
});

test('Resolving a question slides the next question into its place and respects reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/#/new/questionnaire');
  await addPolicy(page, 'Records.txt', 'The coordinator keeps the inspection log.');
  await continueToSource(page, 'questionnaire');
  await pasteSource(page, 'questionnaire', 'Who records exceptions during an annual inspection of the facility?\nWho keeps the log?');
  await clickReview(page, 'questionnaire');
  const queue = page.getByRole('complementary', { name: 'Review queue' });
  await expect(queue).toBeVisible();
  const showList = queue.getByRole('button', { name: /Show list/ });
  if (await showList.isVisible()) await showList.click();

  const first = queue.getByRole('button', { name: 'Resolve question 1', exact: true });
  await expect(first.locator('svg')).toHaveClass(/lucide-check\b/);
  const measure = () => first.evaluate(async button => {
    const row = button.closest('.queue-item');
    const sibling = row.nextElementSibling;
    const group = row.parentElement;
    const top = () => sibling.getBoundingClientRect().top - group.getBoundingClientRect().top;
    const before = top();
    button.click();
    await new Promise(requestAnimationFrame);
    const [slide] = sibling.getAnimations();
    if (!slide) return { before, end: top() };
    slide.pause();
    slide.currentTime = 0;
    const start = top();
    slide.currentTime = slide.effect.getTiming().duration / 2;
    const middle = top();
    slide.finish();
    return { before, start, middle, end: top() };
  });

  const slide = await measure();
  expect(slide.start).toBeCloseTo(slide.before, 0);
  expect(slide.middle).toBeLessThan(slide.start);
  expect(slide.middle).toBeGreaterThan(slide.end);
  expect(slide.end).toBeCloseTo(0, 0);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await queue.getByRole('button', { name: 'Resolved 1', exact: true }).click();
  await queue.getByRole('button', { name: 'Reopen question 1', exact: true }).click();
  const instant = await measure();
  expect(instant.start).toBeUndefined();
  expect(instant.before).toBeGreaterThan(instant.end);
  expect(instant.end).toBeCloseTo(0, 0);
});

test('Responses downloads a paginated PDF of saved answers and selected citations', async ({ page }) => {
  const questions = [
    'Who controls the vehicle gate?', 'Who keeps the inspection log?',
    'Who signs the annual declaration?', 'How are retention exceptions recorded?',
  ];
  const suggestedQuote = 'The coordinator keeps the inspection log.';
  const selectedQuote = 'Renée signs the café’s inspection log after each visit.';
  const confirmedAnswer = 'Renée confirms each visit — including the café’s late shift.';
  const draftLines = Array.from({ length: 80 }, (_, i) => `Exception ${i + 1} awaits a countersignature.`);
  await page.goto('/#/new/questionnaire');
  await addPolicy(page, 'Records.txt', [suggestedQuote, 'Parking permits are issued at reception.', selectedQuote].join('\f'));
  await continueToSource(page, 'questionnaire');
  await pasteSource(page, 'questionnaire', questions.join('\n'));
  await clickReview(page, 'questionnaire');

  const responses = page.getByRole('region', { name: 'Responses', exact: true });
  const downloadPdf = responses.getByRole('button', { name: 'Download PDF', exact: true });
  await page.getByRole('button', { name: 'Responses', exact: true }).click();
  await expect(downloadPdf).toBeDisabled();
  await expect(responses.getByRole('button', { name: /Full review/ })).toHaveCount(0);
  await responses.getByRole('button', { name: 'Review questions' }).click();
  const next = page.getByRole('button', { name: 'Next question' });
  const answer = page.getByLabel('Response for submission');
  await next.click();
  await page.getByRole('button', { name: 'Search trail', exact: true }).click();
  const matches = page.getByRole('region', { name: 'Relevant passages' });
  const chosen = matches.getByRole('article').filter({ hasText: 'p. 3' });
  const cite = chosen.getByRole('button', { name: 'Cite in response' });
  if (!await cite.isVisible()) await chosen.locator('summary').click();
  await cite.click();
  await answer.fill(confirmedAnswer);
  await page.getByRole('button', { name: 'Confirm response', exact: true }).click();
  await next.click();
  await next.click();
  await answer.fill(draftLines.join('\n'));
  await page.getByRole('button', { name: 'Previous question' }).click();
  await page.getByRole('button', { name: 'Flag for follow-up', exact: true }).click();
  await page.getByRole('button', { name: 'Responses', exact: true }).click();
  await expect(downloadPdf).toBeEnabled();

  const pending = page.waitForEvent('download');
  await downloadPdf.click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('folio-questionnaire-responses.pdf');
  const pages = await pdfPageTexts(download);
  const text = pages.join(' ');
  expect(text).not.toContain(questions[0]);
  expect(text).not.toContain(suggestedQuote);
  const headings = [...text.matchAll(/\bQuestion (\d+)\b/gi)];
  expect(headings.map(match => Number(match[1]))).toEqual([2, 3, 4]);
  const entries = headings.map((heading, i) => text.slice(heading.index, headings[i + 1]?.index));
  expect(entries[0]).toContain(questions[1]);
  expect(entries[0]).toContain('Confirmed');
  expect(entries[0]).toContain(confirmedAnswer);
  expect(entries[0]).toMatch(/Records\.txt\s*·\s*p\.\s*3\b/);
  expect(entries[0]).toContain(selectedQuote);
  expect(entries[1]).toContain(questions[2]);
  expect(entries[1]).toContain('Flagged for follow-up');
  expect(entries[1]).toContain('No response entered.');
  expect(entries[2]).toContain(questions[3]);
  expect(entries[2]).toContain('Draft');
  for (const line of draftLines) expect(entries[2]).toContain(line);
  const firstDraftPage = pages.findIndex(text => text.includes(draftLines[0]));
  const lastDraftPage = pages.findIndex(text => text.includes(draftLines.at(-1)));
  expect(lastDraftPage).toBeGreaterThan(firstDraftPage);
});

test('an embedded Mac browser can retry a failed PDF download in the same review', async ({ page }) => {
  // FileSaver's embedded-WebKit path previously opened a blank popup here.
  await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', {
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
  }));
  const popups = [];
  page.on('popup', popup => popups.push(popup));
  await page.goto('/#/new/questionnaire');
  await addPolicy(page, 'Records.txt', 'The registrar signs the inspection log.');
  await continueToSource(page, 'questionnaire');
  await pasteSource(page, 'questionnaire', 'Who signs the log?');
  await clickReview(page, 'questionnaire');
  const answer = 'The registrar signs the inspection log.';
  await page.getByLabel('Response for submission').fill(answer);
  await page.getByRole('button', { name: 'Responses', exact: true }).click();
  const button = page.getByRole('button', { name: 'Download PDF', exact: true });
  await page.route('**/downloads/responses-v1.js', route => route.abort(), { times: 1 });
  await button.click();
  await expect(page.getByRole('alert')).toContainText('The PDF could not be downloaded');
  const pending = page.waitForEvent('download');
  await button.click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('folio-questionnaire-responses.pdf');
  expect((await pdfPageTexts(download)).join(' ')).toContain(answer);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const repeat = page.waitForEvent('download');
  await button.click();
  expect((await repeat).suggestedFilename()).toBe(download.suggestedFilename());
  expect(popups).toHaveLength(0);
});

test('a failed or superseded rewrite preserves the analyst’s text', async ({ page }) => {
  await page.goto('/#/new/questionnaire');
  await addPolicy(page, 'Registry.txt', 'The registrar keeps the inspection log and signs it.');
  await continueToSource(page, 'questionnaire');
  await pasteSource(page, 'questionnaire', 'Who keeps the inspection log?\nWho signs it?');
  await clickReview(page, 'questionnaire');
  const editor = page.getByLabel('Response for submission');
  await editor.fill('The registrar maintains the log.');
  const action = page.getByRole('button', { name: 'Shorten', exact: true });
  const endpoint = '**/api/review?operation=draft';
  await page.route(endpoint, route => route.fulfill({ status: 503, json: { error: 'Anthropic is temporarily unavailable.' } }), { times: 1 });
  await action.click();
  await expect(page.getByRole('alert')).toHaveText('Anthropic is temporarily unavailable.');
  await expect(editor).toHaveValue('The registrar maintains the log.');

  for (const navigate of [false, true]) {
    const release = Promise.withResolvers();
    await page.route(endpoint, async route => {
      await release.promise;
      await route.fulfill({ json: { answer: 'Obsolete wording.' } });
    }, { times: 1 });
    const sent = page.waitForRequest(endpoint);
    await action.click();
    const request = await sent;
    const aborted = page.waitForEvent('requestfailed', failed => failed === request);
    if (navigate) {
      await page.getByRole('button', { name: 'Next question' }).click();
    } else {
      await editor.fill('The records office maintains the log.');
    }
    release.resolve();
    await aborted;
    if (navigate) {
      await expect(editor).toBeEmpty();
      await page.getByRole('button', { name: 'Previous question' }).click();
    }
    await expect(editor).toHaveValue('The records office maintains the log.');
  }
});

test('the guide search trail opens ranked sources and filters page proof by literal term', async ({ page }) => {
  const pages = [
    'Archive the inspection log. Recheck the INSPECTION LOG before filing. The inspection logbook stays on site.',
    'Send a copy of the inspection log to the registrar.',
    'Archive the signature sheet.',
  ];
  await page.goto('/#/new/guide');
  await addPolicy(page, 'Records.txt', pages.join('\f'));
  await continueToSource(page, 'guide');
  await pasteSource(page, 'guide', 'Staff must archive each inspection log.');
  await clickReview(page, 'guide');

  const trail = page.getByRole('button', { name: 'Search trail', exact: true });
  const ranked = page.getByRole('button', { name: 'Relevant passages', exact: true });
  const rankedPassages = page.getByRole('region', { name: 'Relevant passages', exact: true });
  const terms = page.getByRole('button', { name: 'Search terms', exact: true });
  const filters = page.getByRole('group', { name: 'Filter by search term' });
  const allTerms = filters.getByRole('button', { name: 'All terms', exact: true });
  const inspectionLog = filters.getByRole('button', { name: 'inspection log', exact: true });
  await trail.click();
  await expect(trail).toHaveAttribute('aria-expanded', 'true');
  await expect(ranked).toHaveAttribute('aria-pressed', 'true');
  await expect(terms).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'Follow-up search', exact: true })).toHaveCount(0);
  await expect(filters).toBeHidden();

  const matches = rankedPassages.getByRole('article');
  await expect(matches).toHaveCount(pages.length);
  for (const [index, quote] of pages.entries()) {
    const match = matches.nth(index);
    const summary = match.locator('summary');
    await expect(summary).toHaveAccessibleName('Ranked match ' + (index + 1) + ', Records.txt, p. ' + (index + 1));
    if (index > 0) await summary.click();
    await expect(match.getByRole('blockquote')).toContainText(quote);
    await match.getByRole('button', { name: new RegExp('Open Records\\.txt.*p\\. ' + (index + 1)) }).click();
    await expect(page.locator('dialog mark')).toHaveText(quote);
    await page.keyboard.press('Escape');
  }

  await terms.click();
  await expect(terms).toHaveAttribute('aria-pressed', 'true');
  await expect(ranked).toHaveAttribute('aria-pressed', 'false');
  await expect(rankedPassages).toBeHidden();
  await expect(allTerms).toHaveAttribute('aria-pressed', 'true');
  const phrase = page.locator('summary').filter({ hasText: 'Model-planned term' });
  const archive = page.locator('summary').filter({ hasText: 'archive' });
  await expect(phrase).toContainText('inspection log');
  await expect(phrase).toContainText(/3 hits.*2 pages/);
  await expect(archive).toContainText('Requirement term');
  await phrase.click();
  const firstPage = page.getByRole('button', { name: /Records\.txt.*p\. 1\s*2 hits/ });
  await expect(firstPage).toBeVisible();
  await phrase.click();
  await expect(firstPage).toBeHidden();
  await inspectionLog.press('Enter');
  await expect(inspectionLog).toHaveAttribute('aria-pressed', 'true');
  await expect(allTerms).toHaveAttribute('aria-pressed', 'false');
  await expect(archive).toBeHidden();
  await expect(page.getByRole('button', { name: /Records\.txt.*p\. 2\s*1 hit/ })).toBeVisible();
  await firstPage.click();
  await expect(page.locator('dialog mark')).toHaveText(['inspection log', 'INSPECTION LOG']);
  await page.keyboard.press('Escape');
  await inspectionLog.click();
  await expect(allTerms).toHaveAttribute('aria-pressed', 'true');
  await expect(archive).toBeVisible();
  await filters.getByRole('button', { name: 'staff', exact: true }).click();
  await expect(firstPage).toBeHidden();
  await expect(page.getByText(/No exact matches/)).toBeVisible();
  await allTerms.click();
  await expect(archive).toBeVisible();
  await expect(phrase).toBeVisible();
  await ranked.click();
  await expect(filters).toBeHidden();
  await trail.click();
  await expect(trail).toHaveAttribute('aria-expanded', 'false');
  await expect(ranked).toBeHidden();
});

for (const hasAppendix of [true, false]) {
  test(`a follow-up search traces a cross-reference ${hasAppendix ? 'to a new passage' : 'with no new passages'}`, async ({ page }) => {
    const question = 'Who files the inspection log?';
    const term = 'Appendix B';
    const sourceQuote = 'For inspection log assignments, see Appendix B.';
    const appendixQuote = 'Appendix B assigns filing to the coordinator. Appendix B applies to all offices.';
    const pages = hasAppendix ? [sourceQuote, appendixQuote] : [sourceQuote];
    await page.goto('/#/new/questionnaire');
    await addPolicy(page, 'Filing.txt', pages.join('\f'));
    await continueToSource(page, 'questionnaire');
    await pasteSource(page, 'questionnaire', question);
    await clickReview(page, 'questionnaire');
    const toggle = page.getByRole('button', { name: 'Search trail' });
    const followup = page.getByRole('region', { name: 'Follow-up search' });
    const showFollowup = page.getByRole('button', { name: 'Follow-up search', exact: true });
    const ranked = page.getByRole('button', { name: 'Relevant passages', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(followup).toBeHidden();
    await toggle.click();
    await expect(ranked).toHaveAttribute('aria-pressed', 'true');
    await expect(showFollowup).toHaveAttribute('aria-pressed', 'false');
    await expect(followup).toBeHidden();
    const candidate = page.getByRole('region', { name: 'Relevant passages', exact: true }).getByRole('article');
    await expect(candidate).toHaveCount(1);
    await expect(candidate.getByRole('blockquote')).toContainText(sourceQuote);
    await candidate.getByRole('button', { name: 'Cite in response', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Remove response citation 1' })).toBeVisible();
    await page.getByRole('button', { name: 'Search terms', exact: true }).click();
    const filters = page.getByRole('group', { name: 'Filter by search term' });
    await filters.getByRole('button', { name: 'inspection log', exact: true }).click();
    await expect(page.getByRole('button', { name: /Filing\.txt.*p\. 1\s*1 hit/ })).toBeVisible();
    await showFollowup.click();
    await expect(showFollowup).toHaveAttribute('aria-pressed', 'true');
    await expect(ranked).toHaveAttribute('aria-pressed', 'false');
    await expect(candidate).toBeHidden();
    await expect(filters).toBeHidden();
    await expect(followup).toContainText('cross-reference');
    const origin = followup.getByRole('article').filter({ hasText: 'Originating passage' });
    await origin.getByRole('button', { name: 'Remove citation', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Remove response citation 1' })).toBeHidden();
    await origin.getByRole('button', { name: /Filing.txt.*p\. 1/ }).click();
    await expect(page.locator('dialog mark')).toHaveText(sourceQuote);
    await page.keyboard.press('Escape');
    await expect(followup.getByText(term, { exact: true })).toBeVisible();
    await followup.getByRole('button', { name: /p\. 1\s*1 hit/ }).click();
    await expect(page.locator('dialog mark')).toHaveText(term);
    await page.keyboard.press('Escape');
    if (hasAppendix) {
      await followup.getByRole('button', { name: /p\. 2\s*2 hits/ }).click();
      await expect(page.locator('dialog mark')).toHaveText([term, term]);
      await page.keyboard.press('Escape');
      const result = followup.getByRole('article').filter({ hasText: 'New passage from follow-up' });
      await result.getByRole('button', { name: /Filing.txt.*p\. 2/ }).click();
      await expect(page.locator('dialog mark')).toHaveText(appendixQuote);
      await page.keyboard.press('Escape');
      await result.getByRole('button', { name: 'Cite in response', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Remove response citation 1' })).toBeVisible();
    } else {
      await expect(followup).toContainText('This search found no new passages.');
      await page.getByRole('button', { name: 'Generate response' }).click();
      await expect(page.getByLabel('Response for submission')).toHaveValue('The available policy does not establish the answer.');
      await expect(page.getByRole('button', { name: 'Confirm response' })).toBeDisabled();
    }
  });
}

test('a guide action can be generated, revised, saved without citations, and edited', async ({ page }) => {
  const duty = 'Staff must sign the inspection log at closing.';
  const passage = 'The coordinator signs the inspection log at closing.';
  await page.goto('/#/new/guide');
  await addPolicy(page, 'Closing.txt', passage);
  await continueToSource(page, 'guide');
  await pasteSource(page, 'guide', duty);
  await clickReview(page, 'guide');

  const draft = page.getByLabel('Policy action draft');
  const tools = page.getByRole('group', { name: 'Policy action writing tools' });
  const save = page.getByRole('button', { name: 'Save action', exact: true });
  await expect(save).toBeDisabled();
  const endpoint = '**/api/review?operation=draft';
  const generation = page.waitForResponse(endpoint);
  await tools.getByRole('button', { name: 'Generate policy action' }).click();
  const generated = await generation;
  const evidence = { title: 'Closing.txt', page: 1, quote: passage };
  expect(generated.request().postDataJSON()).toMatchObject({
    mode: 'guide', action: 'draft', obligation: duty, guidePassage: duty, disposition: 'no_change', actionText: '',
    status: 'supported', assessment: passage, supporting: [evidence], candidates: [evidence], counter: [], citations: [],
  });
  expect(await providerCalls(generated)).toEqual([{ tool: 'record_policy_action_draft', documents: [] }]);
  await expect(draft).toHaveValue('Document who signs the inspection log at closing.');
  await expect(page.getByRole('radio', { name: 'No change', exact: true })).toBeChecked();
  await expect(page.getByRole('heading', { name: 'Action citations' })).toHaveCount(0);

  await page.getByRole('radio', { name: 'Update existing policy', exact: true }).check();
  await page.getByRole('button', { name: 'Cite in action', exact: true }).first().click();
  await tools.getByRole('button', { name: 'Shorten' }).click();
  await expect(draft).toHaveValue('Document the log signer.');
  const revision = page.waitForResponse(endpoint);
  await tools.getByRole('button', { name: 'Add detail' }).click();
  expect((await revision).request().postDataJSON()).toMatchObject({
    action: 'expand', disposition: 'update', actionText: 'Document the log signer.', citations: [evidence],
  });
  await expect(draft).toHaveValue('Document the log signer. Include the sign-off step in the closing instructions.');
  await tools.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(draft).toHaveValue('Document the log signer.');
  await tools.getByRole('button', { name: 'Simplify' }).click();
  await expect(draft).toHaveValue('Say who signs the log.');
  await page.getByRole('button', { name: 'Remove action citation 1' }).click();
  await expect(page.getByRole('button', { name: 'Cite in action', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Action citations' })).toHaveCount(0);
  const edited = 'Name the closing supervisor in the signature procedure.';
  await draft.fill(edited);
  await save.click();
  const edit = page.getByRole('button', { name: 'Edit action', exact: true });
  await expect(edit).toHaveAccessibleDescription('Policy action saved');
  await expect(page.getByRole('button', { name: 'Reopen obligation 1' })).toBeVisible();
  await expect(draft).toBeHidden();
  await edit.click();
  await expect(draft).toHaveValue(edited);
  await draft.fill('Assign the signature step to the on-duty supervisor.');
  await expect(page.getByRole('button', { name: 'Resolve obligation 1' })).toBeVisible();
  await expect(save).toBeEnabled();
});

test('a guide compared with an uploaded policy produces an action list with a traceable source page', async ({ page }) => {
  const obligation = 'Teams must log the inspection date before handover.';
  await page.goto('/');
  await page.getByRole('link', { name: /Review a new policy guide/ }).click();
  await expect(page.getByRole('heading', { name: 'Add existing policies' })).toBeVisible();
  await addPolicy(page, 'Handover policy.md', 'Teams log each inspection before handover.');
  await continueToSource(page, 'guide');
  const fullGuide = waitForBackgroundReview(page);
  await page.getByLabel('Upload regulatory guide').setInputFiles({
    name: 'Handover.txt', mimeType: 'text/plain', buffer: Buffer.from('Introduction\f' + obligation),
  });
  await fullGuide;
  await page.getByRole('button', { name: 'Choose guide pages' }).click();
  await page.getByLabel(/Guide pages/).fill('2');
  await page.getByRole('button', { name: 'Apply range' }).click();
  const response = await submitReview(page, 'guide');
  expect(response.request().postDataJSON()).toMatchObject({ guide: obligation, documents: [{ title: 'Handover policy.md' }] });
  expect((await response.json()).planningEngine).toBe('anthropic');
  await expect(page.getByRole('group', { name: 'Policy action', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Search trail' })).toBeVisible();
  await page.getByRole('button', { name: /Handover.txt.*p\. 2/ }).click();
  await expect(page.locator('dialog mark')).toHaveText(obligation);
  await page.keyboard.press('Escape');
  await page.getByRole('radio', { name: 'Write new policy', exact: true }).check();
  await page.getByLabel('Action note').fill('Add an inspection record to the handover procedure.');
  const output = await outputPdfText(page, 'Action list');
  expect(output).toContain('Write new policy');
  expect(output).toContain('Guide pages 2');
  expect(output).toContain('Handover.txt · p. 2');
  expect(output).toContain(obligation);
  expect(output).toContain('Add an inspection record to the handover procedure.');
  await expect(page.getByRole('button', { name: /Write new policy/ })).toContainText(obligation);
});

test('an unrelated obligation edit in another tab preserves an in-flight action rewrite', async ({ page, context }) => {
  await page.goto('/#/new/guide');
  await addPolicy(page, 'Closing.txt', 'The coordinator signs the inspection log at closing.');
  await continueToSource(page, 'guide');
  await pasteSource(page, 'guide', 'Staff must sign the inspection log.\nStaff must archive the inspection log.');
  await clickReview(page, 'guide');
  const draft = page.getByLabel('Policy action draft');
  await draft.fill('Add a sign-off to the log.');
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(other.getByLabel('Policy action draft')).toHaveValue('Add a sign-off to the log.');
  await other.getByRole('button', { name: 'Next obligation' }).click();

  const held = Promise.withResolvers();
  await page.route('**/api/review?operation=draft', route => held.resolve(route), { times: 1 });
  await page.getByRole('button', { name: 'Shorten', exact: true }).click();
  const route = await held.promise;
  try {
    await other.getByRole('button', { name: 'Flag for follow-up' }).click();
    await expect(page.getByText('1 of 2 resolved', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Shortening…' })).toBeDisabled();
  } finally {
    await route.fulfill({ json: { actionText: 'Add a sign-off.' } });
  }
  await expect(draft).toHaveValue('Add a sign-off.');
});

test('the guide queue tracks resolution independently and exports the action list with original page references', async ({ page, context }) => {
  const duties = ['Staff must review access permits.', 'Staff must verify entries in the inspection log.',
    'Managers must record maintenance exceptions.', 'Managers must keep a copy of each declaration.'];
  const guide = await printPdf(context, [duties[0], 'Overview.', duties[1], 'Index.', duties[2], duties[3]]);
  const suggested = 'The coordinator verifies entries in the inspection log.';
  const selected = 'Renée records each inspection log exception in the café register.';
  const policy = [suggested, 'Opening times are posted on the door.', selected];
  await page.goto('/#/new/guide');
  await addPolicy(page, 'Register.txt', policy.join('\f'));
  await continueToSource(page, 'guide');
  const initial = waitForBackgroundReview(page);
  await uploadPdf(page, 'Upload regulatory guide', 'Inspection.pdf', guide);
  await initial;
  await chooseRange(page, 'Choose guide pages', /Guide pages/, '1, 3, 5–6');
  await clickReview(page, 'guide');

  const queue = page.getByRole('complementary', { name: 'Review queue' });
  const showList = queue.getByRole('button', { name: /Show list/ });
  const open = queue.getByRole('region', { name: 'Open obligations' });
  const resolved = queue.getByRole('region', { name: 'Resolved obligations' });
  const tabs = page.getByRole('navigation', { name: 'This review' });
  const list = page.getByRole('region', { name: 'Action list', exact: true });
  const pdf = list.getByRole('button', { name: 'Download PDF', exact: true });
  await expect(queue).toBeVisible();
  if (await showList.isVisible()) await showList.click();
  await open.getByRole('button', { name: 'Resolve obligation 1' }).click();
  await expect(open.locator('.row-name')).toHaveText(duties.slice(1));
  await tabs.getByRole('button', { name: 'Action list' }).click();
  await expect(pdf).toBeDisabled();
  await tabs.getByRole('button', { name: 'Review obligations' }).click();

  const next = page.getByRole('button', { name: 'Next obligation' });
  await next.click();
  await expect(page.getByRole('heading', { name: duties[1], exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Search trail' }).click();
  const ranked = page.getByRole('region', { name: 'Relevant passages' });
  const passage = ranked.getByRole('article').filter({ hasText: selected });
  const cite = passage.getByRole('button', { name: 'Cite in action' });
  if (!await cite.isVisible()) await passage.locator('summary').click();
  await cite.click();
  await page.getByRole('radio', { name: 'Update existing policy' }).check();
  const action = 'Add a field for exceptions to the daily register.';
  const note = 'Review the wording with the café coordinator.';
  await page.getByLabel('Policy action draft').fill(action);
  await page.getByLabel('Action note').fill(note);
  await page.getByRole('button', { name: 'Save action', exact: true }).click();
  await next.click();
  await page.getByRole('button', { name: 'Flag for follow-up' }).click();
  await next.click();
  const unfinished = 'Check whether the archive needs another copy.';
  await page.getByLabel('Policy action draft').fill(unfinished);
  await page.reload();
  await expect(page.getByLabel('Policy action draft')).toHaveValue(unfinished);
  if (await showList.isVisible()) await showList.click();
  await expect(open.locator('.row-name')).toHaveText([duties[3]]);
  await queue.getByRole('button', { name: 'Resolved 3', exact: true }).click();
  await expect(resolved.locator('.row-name')).toHaveText(duties.slice(0, 3));
  await resolved.getByRole('button', { name: 'Reopen obligation 2' }).click();
  await expect(open.locator('.row-name')).toHaveText([duties[1], duties[3]]);
  await expect(open.getByRole('button', { name: /verify entries/ })).toContainText('Update existing policy');

  await tabs.getByRole('button', { name: 'Action list' }).click();
  const entries = list.locator('.decision-entry');
  await expect(entries).toHaveCount(3);
  await expect(entries.nth(0)).toContainText(action);
  await expect(entries.nth(1)).toContainText('Flagged for follow-up');
  await expect(entries.nth(2)).toContainText(unfinished);
  await expect(page.getByRole('button', { name: /download/i })).toHaveCount(1);
  await page.route('**/downloads/responses-v1.js', route => route.abort(), { times: 1 });
  await pdf.click();
  await expect(list.getByRole('alert')).toContainText('The PDF could not be downloaded');
  const pending = page.waitForEvent('download');
  await pdf.click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('folio-policy-action-list.pdf');
  const text = (await pdfPageTexts(download)).join(' ');
  await expect(list.getByRole('alert')).toHaveCount(0);
  expect(text).toContain('Policy action list');
  expect(text).not.toContain(duties[0]);
  expect(text).not.toContain(suggested);
  expect(text).not.toContain(policy[1]);
  const headings = [...text.matchAll(/\bObligation (\d+)\b/g)];
  expect(headings.map(match => Number(match[1]))).toEqual([2, 3, 4]);
  const [saved, flagged, draft] = headings.map((heading, i) => text.slice(heading.index, headings[i + 1]?.index));
  for (const value of [duties[1], 'Saved', 'Update existing policy', action, note, selected]) expect(saved).toContain(value);
  expect(saved).toMatch(/Inspection\.pdf\s*·\s*p\. 3\b/);
  expect(saved).toMatch(/Register\.txt\s*·\s*p\. 3\b/);
  for (const value of [duties[2], 'Flagged for follow-up', 'Action pending']) expect(flagged).toContain(value);
  expect(flagged).toMatch(/Inspection\.pdf\s*·\s*p\. 5\b/);
  for (const value of [duties[3], 'Draft', unfinished]) expect(draft).toContain(value);
  expect(draft).toMatch(/Inspection\.pdf\s*·\s*p\. 6\b/);
});

test('a pasted policy supplements the required upload when reviewing guide obligations', async ({ page }) => {
  const first = 'Staff must record the inspection date.';
  const second = 'Supervisors must notify the manager before repairs.';
  const policy = 'Facilities staff record the inspection date.';
  const requests = captureReviewRequests(page);
  await page.goto('/#/new/guide');
  const next = page.getByRole('button', { name: 'Continue to guide' });
  await expect(next).toBeDisabled();
  const file = 'Safety.txt';
  const text = 'Personnel wear protective gloves.';
  await addPolicy(page, file, text);
  await continueToSource(page, 'guide');
  const finished = waitForBackgroundReview(page);
  await pasteSource(page, 'guide', first + '\n\n' + second);
  await finished;
  await expectQuietReview(page);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Paste a policy' }).click();
  await page.getByLabel(/Policy title/).fill('Facilities policy');
  await page.getByLabel('Policy text', { exact: true }).fill(policy);
  await page.getByRole('button', { name: 'Add policy', exact: true }).click();
  await page.getByRole('button', { name: 'Remove Safety.txt' }).click();
  await expect(page.getByRole('list', { name: 'Added policies' })).toContainText('Facilities policy');
  await expect(next).toBeDisabled();
  await addPolicy(page, file, text);
  await continueToSource(page, 'guide');
  await expect(page.getByLabel('Guide text', { exact: true })).toHaveValue(first + '\n\n' + second);
  expect(requests).toHaveLength(1);
  const response = await submitReview(page, 'guide');
  expect(response.request().postDataJSON().documents.map(doc => doc.title)).toEqual(['Facilities policy', file]);
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
  const output = await outputPdfText(page, 'Action list');
  for (const value of [first, second, 'No change', 'Write new policy']) expect(output).toContain(value);
});

test('editing a selected question batch clears its previous source attribution', async ({ page }) => {
  await page.goto('/#/new/questionnaire');
  await addPolicy(page, 'Records.txt', 'The registrar reviews the records.');
  await continueToSource(page, 'questionnaire');
  const questions = page.getByLabel('Questions', { exact: true });
  await pasteSource(page, 'questionnaire', Array.from({ length: 31 }, (_, index) => `${index + 1}. Who reviews record ${index + 1}?`).join('\n'));
  await chooseRange(page, 'Choose questionnaire items', /Questionnaire items/, '29–30');
  await expect(questions).toHaveValue('29. Who reviews record 29?\n30. Who reviews record 30?');
  await expect(page.getByText(/Questionnaire items 29–30/)).toBeVisible();
  await questions.fill('Who reviews the replacement log?');
  await expect(page.getByText(/Questionnaire items 29–30/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Apply range' })).toHaveCount(0);
});

test('the action-list PDF keeps document markup and multiline notes literal', async ({ page }) => {
  const obligation = 'Teams must label each record with <unit> and [owner].';
  await page.goto('/#/new/guide');
  await addPolicy(page, 'Labelling.md', 'Records are labelled by unit and owner.');
  await continueToSource(page, 'guide');
  const pending = page.waitForResponse('**/api/review');
  await page.getByLabel('Upload regulatory guide').setInputFiles({
    name: 'Guide [draft].txt', mimeType: 'text/plain', buffer: Buffer.from(obligation),
  });
  await submitReview(page, 'guide', pending);
  await page.getByLabel('Action note').fill('Retain ![diagram](diagram.png).\n## Example heading');
  const output = await outputPdfText(page, 'Action list');
  expect(output).toContain('Guide [draft]');
  expect(output).toContain('<unit> and [owner]');
  expect(output).toContain('![diagram](diagram.png)');
  expect(output).toContain('## Example heading');
  expect(output).toContain('Action pending');
});

test('intake checks page limits and can read a PDF after rejecting a file', async ({ page, context }) => {
  await page.goto('/#/new/guide');
  const policies = page.getByLabel('Upload policy files');
  await policies.setInputFiles({
    name: 'Policy.txt', mimeType: 'text/plain', buffer: Buffer.from('record\f'.repeat(1199) + 'record'),
  });
  const added = page.getByRole('list', { name: 'Added policies' });
  await expect(added).toContainText('1200 pages');
  await policies.setInputFiles({ name: 'Extra.txt', mimeType: 'text/plain', buffer: Buffer.from('record') });
  await expect(page.getByRole('alert')).toContainText('1,200 pages');
  await expect(added.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Remove Policy.txt' }).click();
  await addPolicy(page, 'Inspection.txt', 'Staff record inspection dates.');
  await continueToSource(page, 'guide');

  const upload = page.getByLabel('Upload regulatory guide');
  await upload.setInputFiles({
    name: 'Too many pages.txt', mimeType: 'text/plain', buffer: Buffer.from('Page\f'.repeat(1200) + 'Page'),
  });
  await expect(page.getByRole('alert')).toContainText('1,200 pages');

  const pdf = await printPdf(context, ['Teams must record inspection dates.']);
  await uploadPdf(page, 'Upload regulatory guide', 'Guide.pdf', pdf);
  await expectCompactPdf(page, 'guide');
  const preview = page.getByRole('button', { name: 'Preview PDF', exact: true });
  await preview.focus();
  await preview.press('Enter');
  await expectPdfCanvas(page.getByRole('region', { name: 'PDF preview' }), 'Guide.pdf', 1);
  await preview.press('Space');
  await expectCompactPdf(page, 'guide');
  await preview.click();
  const replacement = await printPdf(context, ['New guide first page.', 'New guide second page.']);
  await uploadPdf(page, 'Upload regulatory guide', 'Guide.pdf', replacement);
  await expect(page.getByText('All 2 PDF pages included.')).toBeVisible();
  await expectCompactPdf(page, 'guide');
  await expect(page.getByRole('textbox', { name: 'Guide text' })).toHaveCount(0);
});

test('PDF arrows keep the current sheet and document position through slow page turns', async ({ page, context }) => {
  const title = 'Mixed sheets.pdf';
  const pdf = await printPdf(context, ['Landscape one', 'Portrait two', 'Landscape three'], { portraitPages: [2] });
  await page.goto('/#/new/guide');
  await addPolicy(page, 'Inspection.txt', 'Staff record inspection dates.');
  await continueToSource(page, 'guide');
  await uploadPdf(page, 'Upload regulatory guide', title, pdf);
  await page.getByRole('button', { name: 'Preview PDF', exact: true }).click();
  const viewer = page.getByRole('region', { name: 'PDF preview' });
  const canvas = await expectPdfCanvas(viewer, title, 1);
  const next = viewer.getByRole('button', { name: 'Next PDF page' });
  await next.evaluate(button => window.scrollTo(0, scrollY + button.getBoundingClientRect().top - 90));
  const position = await watchPdfFrames(viewer);
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
  const sheet = await canvas.boundingBox();
  const clip = { x: Math.floor(sheet.x + sheet.width / 8), y: Math.floor(sheet.y + sheet.height / 8), width: 8, height: 8 };
  const paintedSquare = await page.screenshot({ clip });

  // Hold actual worker requests after the first sheet has painted. The arrow and zoom controls stay interactive.
  await page.evaluate(() => {
    const send = Worker.prototype.postMessage;
    const queue = [];
    Worker.prototype.postMessage = function (...args) { queue.push([this, args]); };
    window.queuedPdfRequests = () => queue.length;
    window.resumePdfWorker = () => {
      Worker.prototype.postMessage = send;
      for (const [worker, args] of queue) send.apply(worker, args);
    };
  });
  try {
    await next.click();
    await expect(viewer.getByRole('combobox', { name: 'PDF page' })).toHaveValue('2');
    await page.waitForFunction(() => window.queuedPdfRequests() > 0);
    expect((await page.screenshot({ clip })).equals(paintedSquare), 'The previously visible sheet disappeared').toBe(true);
    await expectPdfCanvas(viewer, title, 1);
    await viewer.getByRole('button', { name: 'Zoom in' }).click();
    await next.click();
    await expect(viewer.getByRole('combobox', { name: 'PDF page' })).toHaveValue('3');
    await expectPdfCanvas(viewer, title, 1);
  } finally {
    await page.evaluate(() => window.resumePdfWorker());
  }
  const last = await expectPdfCanvas(viewer, title, 3);
  expect((await last.boundingBox()).width).toBeGreaterThan(sheet.width);
  await expectPdfFrames(page, position, title, [1, 3]);
  await viewer.getByRole('button', { name: 'Previous PDF page' }).click();
  const portrait = await expectPdfCanvas(viewer, title, 2);
  const portraitBox = await portrait.boundingBox();
  expect(portraitBox.height).toBeGreaterThan(portraitBox.width);
  await expectPdfFrames(page, position, title, [1, 3, 2]);
});

test('Find evidence stays in reach on a short screen with a long PDF filename', async ({ page, context }) => {
  await page.setViewportSize({ width: page.viewportSize().width, height: 568 });
  const name = 'Annual State Licensing Questionnaire for Residential Care Providers and Facilities, Revised September 2026.pdf';
  const form = await printPdf(context, ['1. Who records the inspection?', '2. Who approves the report?']);
  await page.goto('/#/new/questionnaire');
  await addPolicy(page, 'Inspection.txt', 'Staff record inspections. Supervisors approve reports.');
  await continueToSource(page, 'questionnaire');
  await uploadPdf(page, 'Upload questionnaire', name, form);
  await expectCompactPdf(page);
  const submit = page.getByRole('button', { name: 'Find evidence' });
  await page.getByRole('button', { name: 'Preview PDF', exact: true }).click();
  await expectPdfCanvas(page.getByRole('region', { name: 'PDF preview' }), name, 1);
  await expect(submit).toBeInViewport({ ratio: 1 });
  await submit.click();
  await expect(page.getByRole('heading', { name: '1. Who records the inspection?', exact: true })).toBeVisible();
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
  const submissions = captureReviewRequests(page);
  await page.goto('/#/new/questionnaire');
  await uploadPdf(page, 'Upload policy files', 'Facility.pdf', policy);
  await expect(page.getByRole('list', { name: 'Added policies' })).toContainText('Facility.pdf');
  await continueToSource(page, 'questionnaire');
  expect(submissions).toHaveLength(0);
  const original = page.waitForResponse('**/api/review');
  await uploadPdf(page, 'Upload questionnaire', 'Intake.pdf', questions);
  expect((await original).request().postDataJSON().documents[0].pages).toHaveLength(3);
  await page.getByRole('button', { name: 'Preview PDF', exact: true }).click();
  const viewer = page.getByRole('region', { name: 'PDF preview' });
  const firstCanvas = await expectPdfCanvas(viewer, 'Intake.pdf', 1);
  const width = (await firstCanvas.boundingBox()).width;
  await viewer.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(async () => (await firstCanvas.boundingBox())?.width ?? 0).toBeGreaterThan(width);
  await viewer.getByRole('button', { name: 'Fit to width', exact: true }).click();
  await viewer.getByRole('button', { name: 'Next PDF page' }).click();
  await expectPdfCanvas(viewer, 'Intake.pdf', 2);
  await chooseRange(page, 'Choose questionnaire items', /Questionnaire items/, '20, 30');
  await expect(viewer.getByRole('combobox', { name: 'PDF page' }).getByRole('option')).toHaveCount(3);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Preview Facility.pdf' }).click();
  await expectPdfCanvas(viewer, 'Facility.pdf', 1);
  await chooseRange(page, 'Choose policy pages', /Policy pages/, '2');
  await expectPdfCanvas(viewer, 'Facility.pdf', 2);
  await continueToSource(page, 'questionnaire');
  expect(submissions).toHaveLength(1);
  const response = await submitReview(page, 'questionnaire');
  expect(submissions).toHaveLength(2);
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
  const guide = await printPdf(context, [obligations[0], 'Unselected payroll instructions.', obligations[1]], { portraitPages: [1] });
  const submissions = captureReviewRequests(page);
  await page.goto('/#/new/guide');
  await addPolicy(page, 'Inspection.txt', 'Supervisors record and sign inspection reports.');
  await continueToSource(page, 'guide');
  expect(submissions).toHaveLength(0);
  const original = waitForBackgroundReview(page);
  await uploadPdf(page, 'Upload regulatory guide', 'Audit.pdf', guide);
  await original;
  await chooseRange(page, 'Choose guide pages', /Guide pages/, '1, 3');
  await expect(page.getByText('Review ready', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Preview PDF', exact: true }).click();
  const viewer = page.getByRole('region', { name: 'PDF preview' });
  await viewer.getByRole('button', { name: 'Next PDF page' }).click();
  await expectPdfCanvas(viewer, 'Audit.pdf', 3);
  expect(submissions).toHaveLength(1);
  const response = await submitReview(page, 'guide');
  expect(submissions).toHaveLength(2);
  const sent = response.request().postDataJSON();
  expect(sent.guide).toBe(obligations.join('\n\n'));
  expect(sent.documents).toMatchObject([{ title: 'Inspection.txt' }]);
  expect(sent.pdfAttachments).toHaveLength(1);
  const source = await expectAttachedSheets(sent.pdfAttachments[0], [1, 3], [1]);
  expect(source).toMatchObject({ role: 'source', title: 'Audit.pdf' });
  expect(await providerCalls(response)).toEqual([
    { tool: 'record_search_plan', documents: [source] }, { tool: 'record_review', documents: [source] },
  ]);
  await page.getByRole('button', { name: 'Next obligation' }).click();
  await page.getByRole('button', { name: /Audit\.pdf.*p\. 3/ }).click();
  const citedGuide = page.getByRole('dialog');
  await expectPdfCanvas(citedGuide, 'Audit.pdf', 3);
  await expect(citedGuide.locator('.pdf-text-layer mark').first()).toBeVisible();
  const previous = citedGuide.getByRole('button', { name: 'Previous PDF page' });
  await previous.scrollIntoViewIfNeeded();
  const position = await watchPdfFrames(citedGuide);
  await previous.click();
  await expectPdfCanvas(citedGuide, 'Audit.pdf', 1);
  await expectPdfFrames(page, position, 'Audit.pdf', [3, 1]);
  await citedGuide.getByRole('button', { name: 'Next PDF page' }).click();
  await expectPdfCanvas(citedGuide, 'Audit.pdf', 3);
  await expect(citedGuide.locator('.pdf-text-layer mark').first()).toBeVisible();
  await expectPdfFrames(page, position, 'Audit.pdf', [3, 1, 3]);
});

test('selecting one of two items on a shared page sends only visible page content and reviews one question', async ({ page, context }) => {
  const question = '2. Who keeps the inspection log?';
  const form = await printPdf(context, ['1. Who schedules training?\n' + question]);
  await page.goto('/#/new/questionnaire');
  await addPolicy(page, 'Inspection.txt', 'The registrar keeps the inspection log.');
  await continueToSource(page, 'questionnaire');
  const original = waitForBackgroundReview(page);
  await uploadPdf(page, 'Upload questionnaire', 'Shared page.pdf', form);
  await original;
  await chooseRange(page, 'Choose questionnaire items', /Questionnaire items/, '2');
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
    await uploadPdf(page, 'Upload policy files', 'Scanned policy.pdf', policy);
    await expect(page.getByRole('list', { name: 'Added policies' })).toContainText('Scanned policy.pdf');
    await continueToSource(page, 'questionnaire');
    const original = waitForBackgroundReview(page);
    await uploadPdf(page, 'Upload questionnaire', 'Scanned form.pdf', questions);
    await original;
    await chooseRange(page, 'Choose questionnaire pages', /Questionnaire pages/, '2');
    await page.getByRole('button', { name: 'Preview PDF', exact: true }).click();
    await expectPdfCanvas(page.getByRole('region', { name: 'PDF preview' }), 'Scanned form.pdf', 2);
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

async function finishDocumentReview(page, mode, requests = captureReviewRequests(page)) {
  await clickReview(page, mode);
  const navigation = page.getByRole('navigation', { name: 'This review' });
  const alert = page.getByRole('alert');
  await expect(navigation.or(alert).first()).toBeVisible({ timeout: 60_000 });
  await expect(alert).toHaveCount(0);
  await expect(navigation).toBeVisible();
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

test('one submission reviews all 65 questions against a full policy PDF and exports the final confirmed response', async ({ page, context }) => {
  test.setTimeout(120_000);
  const questions = Array.from({ length: 65 }, (_, i) => `${i + 1}. Who keeps inspection log ${i + 1}?`);
  questions[32] = '33. Who keeps the inspection log covering ' + 'archived inspection entries and '.repeat(73) + 'the final register?';
  expect(questions[32].length).toBeGreaterThan(2000);
  const sheets = Array.from({ length: 13 }, (_, i) => questions.slice(i * 5, i * 5 + 5).join('\n'));
  const form = await printPdf(context, sheets, { fontSize: 8 });
  const policyQuote = 'The registrar keeps the inspection log for every site.';
  const policyPages = Array.from({ length: 145 }, (_, i) => i + 1);
  const parking = [
    'Visitor parking is available in marked bays. Drivers obtain a temporary pass at reception and display it throughout the visit.',
    'Use the pedestrian walkway to reach the entrance. Accessible bays beside the entrance must remain clear of deliveries and bicycles.',
    'Reception provides an alternate location during maintenance. An attendant directs delivery vehicles to the loading bay on arrival.',
  ].join('\n\n');
  const policy = await printPdf(context, policyPages.map(number => number === 145 ? policyQuote : parking), { fontSize: 12 });
  await page.goto('/#/new/questionnaire');
  await uploadPdf(page, 'Upload policy files', 'Records.pdf', policy);
  await expect(page.getByRole('list', { name: 'Added policies' })).toContainText('Records.pdf');
  await continueToSource(page, 'questionnaire');
  const requests = captureReviewRequests(page);
  await uploadPdf(page, 'Upload questionnaire', 'Register.pdf', form);
  await expectCompactPdf(page);
  const parts = await finishDocumentReview(page, 'questionnaire', requests);

  expect(parts.length).toBeGreaterThan(1);
  expect(parts.flatMap(({ input }) => input.questions)).toEqual(questions);
  expect(parts.flatMap(({ result }) => result.findings.map(finding => finding.question))).toEqual(questions);
  expect(parts.flatMap(({ assessed }) => assessed).sort()).toEqual(
    questions.map(question => createHash('sha256').update(question).digest('hex')).sort(),
  );
  expect(parts.flatMap(part => part.calls.filter(call => call.omitted).map(call => [call.tool, call.omitted])))
    .toEqual([['record_search_plan', questions[56]], ['record_review', questions[63]]]);
  expect(parts[0].result.planningEngine).toBe('local');
  expect(parts[0].result.engine).toBe('anthropic');
  for (const { input, calls, result } of parts) {
    const originalPages = [...new Set(input.questions.map(question => Math.floor(questions.indexOf(question) / 5) + 1))];
    expect(input.pdfAttachments).toHaveLength(2);
    const source = await expectAttachedSheets(input.pdfAttachments.find(pdf => pdf.role === 'source'), originalPages);
    const attachedPolicy = input.pdfAttachments.find(pdf => pdf.role === 'policy');
    expect(input.documents[0].pages.map(page => page.number)).toEqual(policyPages);
    expect(input.documents[0].pages.at(-1).text).toBe(policyQuote);
    expect(attachedPolicy.pages).toEqual(policyPages);
    expect(Buffer.from(attachedPolicy.data, 'base64').equals(policy)).toBe(true);
    expect(source.title).toBe('Register.pdf');
    expect(calls.map(call => call.tool)).toContain('record_search_plan');
    expect(calls.map(call => call.tool)).toContain('record_review');
    for (const call of calls) {
      if (call.tool === 'record_search_plan') expect(call.documents).toEqual([source]);
      else {
        expect(call.documents).toHaveLength(2);
        expect(call.documents[0]).toEqual(source);
        expect(call.documents[1]).toMatchObject({ role: 'policy', title: 'Records.pdf',
          documentId: input.documents[0].id, pages: [145] });
      }
    }
    for (const finding of result.findings) {
      expect(finding).toMatchObject({ analysisEngine: 'anthropic', supporting: [{ page: 145, quote: policyQuote }] });
    }
  }

  await selectLastFinding(page, questions);
  await page.getByRole('button', { name: /Records\.pdf.*p\. 145/ }).first().click();
  await expectPdfCanvas(page.getByRole('dialog'), 'Records.pdf', 145);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Generate response' }).click();
  await page.getByRole('button', { name: 'Confirm response' }).click();
  const output = await outputPdfText(page, 'Responses');
  expect(output.match(/\bQuestion \d+\b/g)).toEqual(['Question 65']);
  expect(output).toContain('Question 65 · Confirmed');
  expect(output).toContain(questions.at(-1));
  expect(output).toContain('Records.pdf · p. 145');
  expect(output).toContain(policyQuote);
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
  await addPolicy(page, 'Archive policy.txt', 'Clerks sign the inspection log and retain each inspection register.');
  await continueToSource(page, 'guide');
  const requests = captureReviewRequests(page);
  await uploadPdf(page, 'Upload regulatory guide', 'Archive.pdf', guide);
  await expectCompactPdf(page, 'guide');
  const parts = await finishDocumentReview(page, 'guide', requests);

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
    expect(input.documents).toMatchObject([{ title: 'Archive policy.txt' }]);
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
    const tools = new Set(calls.map(call => call.tool));
    expect([...tools]).toEqual(result.findings.length ? ['record_search_plan', 'record_review'] : ['record_search_plan']);
    for (const call of calls) expect(call.documents).toEqual([block]);
    const codePoints = Array.from(input.guide);
    for (const { criterionStart, criterionEnd, criterionSource } of result.findings) {
      expect(codePoints.slice(criterionStart, criterionEnd).join('')).toBe(criterionSource);
    }
  }
  expect(cursor).toBe(expectedGuide.length);

  await expect(page.getByRole('heading', { name: repeated, exact: true })).toBeVisible();
  await page.getByLabel('Action note').fill('Check the opening register.');
  await selectLastFinding(page, questions);
  await page.getByRole('button', { name: /Archive\.pdf.*p\. 30/ }).click();
  const citation = page.getByRole('dialog');
  await expectPdfCanvas(citation, 'Archive.pdf', 30);
  await expect(citation.getByRole('complementary', { name: 'Cited passage' })).toContainText(repeated);
  await expect(citation.locator('.pdf-text-layer mark').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Cite in action' }).first().click();
  await page.getByRole('radio', { name: 'No change', exact: true }).check();
  await page.getByLabel('Action note').fill('Verify the final register.');
  await page.getByRole('button', { name: 'Save action', exact: true }).click();
  const output = await outputPdfText(page, 'Action list');
  expect(output.match(/\bObligation \d+\b/g)).toEqual(['Obligation 1', 'Obligation 38']);
  const [first, last] = output.split('Obligation 38 · Saved');
  for (const value of ['Obligation 1 · Draft', repeated, 'Archive.pdf · p. 1', 'Check the opening register.']) expect(first).toContain(value);
  for (const value of [repeated, 'Archive.pdf · p. 30', 'No change', 'Verify the final register.', 'Archive policy.txt · p. 1']) expect(last).toContain(value);
});

test('a guide planning timeout splits at complete duties and retry resumes at the failed page', async ({ page, context }) => {
  const duties = ['Staff must retain the original inspection register and its signed copy for seven years.', 'Managers must sign.'];
  const pdf = await printPdf(context, duties);
  await page.goto('/#/new/guide');
  await addPolicy(page, 'Retention.txt', 'Clerks retain the signed inspection register.');
  await continueToSource(page, 'guide');
  const sent = [];
  await page.route('**/api/review', route => {
    const { guide, pdfAttachments } = route.request().postDataJSON();
    sent.push({ text: guide.trim().replace(/\s+/gu, ' '), pages: pdfAttachments[0].pages });
    if (sent.length === 1) return route.fulfill({ status: 422, json: { code: 'review_part_too_large',
      error: 'The model could not finish planning this review part within its budget.' } });
    if (sent.length === 3) return route.fulfill({ status: 503, json: { error: 'Simulated planning outage.' } });
    return route.continue();
  });
  const failure = page.waitForResponse(response => response.url().endsWith('/api/review') && response.status() === 503);
  await uploadPdf(page, 'Upload regulatory guide', 'Register.pdf', pdf);
  await (await failure).finished();
  await expect(page).toHaveURL(/\/new\/guide\/source$/);
  const submit = page.getByRole('button', { name: 'Review obligations' });
  const parts = duties.map((text, i) => ({ text, pages: [i + 1] }));
  expect(sent).toEqual([{ text: duties.join(' '), pages: [1, 2] }, ...parts]);
  await submit.click();
  await expect(page.getByRole('heading', { name: duties[0], exact: true })).toBeVisible();
  expect(sent.slice(3)).toEqual([parts[1]]);
  await expect(page.getByRole('button', { name: 'Register.pdf · p. 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next obligation' }).click();
  await expect(page.getByRole('heading', { name: duties[1], exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Register.pdf · p. 2', exact: true })).toBeVisible();
});

test('a complete scanned form joins a question across transcription requests before assessment', async ({ page, context }) => {
  const printed = ['Who keeps inspection log 1?', 'Who keeps inspection log 2?', 'Who keeps the inspection log',
    'after the archive closes?', 'Who keeps inspection log 5?'];
  const questions = [printed[0], printed[1], printed[2] + ' ' + printed[3], printed[4]];
  const form = await printPdf(context, printed, { scanned: true });
  await page.goto('/#/new/questionnaire');
  await addPolicy(page, 'Records.txt', 'The registrar keeps the inspection log after the archive closes.');
  await continueToSource(page, 'questionnaire');
  const requests = captureReviewRequests(page);
  await uploadPdf(page, 'Upload questionnaire', 'Archive scan.pdf', form);
  await expectCompactPdf(page);
  const parts = await finishDocumentReview(page, 'questionnaire', requests);

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
  await page.getByRole('button', { name: 'Previous question' }).click();
  await expect(page.getByRole('heading', { name: questions[2], exact: true })).toBeVisible();
});

test('retrying a whole questionnaire resumes after the last successful part', async ({ page }, testInfo) => {
  const questions = Array.from({ length: 32 }, (_, i) => `Who keeps inspection log ${i + 1}?`);
  questions[16] = `Who keeps the outage log for case late-${testInfo.project.name}-${testInfo.repeatEachIndex}-${testInfo.retry}?`;
  await page.goto('/#/new/questionnaire');
  await addPolicy(page, 'Registry.txt', 'The registrar keeps the inspection log.');
  await continueToSource(page, 'questionnaire');
  const release = await holdNextReview(page, route => route.fulfill({
    status: 429, body: '', headers: { 'Retry-After': '1' },
  }));
  const firstAttempt = [];
  function capture(response) {
    if (new URL(response.url()).pathname === '/api/review') firstAttempt.push(response);
  }
  page.on('response', capture);
  await pasteSource(page, 'questionnaire', questions.join('\n'));
  await page.getByRole('button', { name: 'Find evidence' }).click();
  release();
  await expect(page.getByRole('alert')).toContainText('Folio could not reach Anthropic.');
  page.off('response', capture);
  expect(firstAttempt.length).toBeGreaterThan(2);
  expect(firstAttempt[0].status()).toBe(429);
  expect(firstAttempt[1].request().postDataJSON()).toEqual(firstAttempt[0].request().postDataJSON());
  expect(firstAttempt.at(-1).status()).toBe(503);
  await expect(page.getByRole('navigation', { name: 'This review' })).toHaveCount(0);
  const completedQuestions = firstAttempt.slice(1, -1).flatMap(response => {
    expect(response.status()).toBe(200);
    return response.request().postDataJSON().questions;
  });
  const retry = await finishDocumentReview(page, 'questionnaire');
  expect(retry[0].input).toEqual(firstAttempt.at(-1).request().postDataJSON());
  expect([...completedQuestions, ...retry.flatMap(({ input }) => input.questions)]).toEqual(questions);
  await selectLastFinding(page, questions);
});

test('cancelling a paused multipart review keeps completed work for the next submission', async ({ page }) => {
  const questions = Array.from({ length: 25 }, (_, i) => `Who keeps inspection log ${i + 1}?`);
  await page.goto('/#/new/questionnaire');
  await addPolicy(page, 'Registry.txt', 'The registrar keeps the inspection log.');
  await continueToSource(page, 'questionnaire');
  const requests = [];
  const nextPart = Promise.withResolvers();
  await page.route('**/api/review', route => {
    requests.push(route.request().postDataJSON());
    return requests.length === 2
      ? nextPart.promise.then(() => route.fulfill({ status: 429, body: '', headers: { 'Retry-After': '70' } }))
      : route.continue();
  });
  await pasteSource(page, 'questionnaire', questions.join('\n'));
  const progress = page.getByRole('progressbar', { name: 'Review progress' });
  await expect.poll(() => requests.length).toBe(2);
  await expectQuietReview(page);
  await page.getByRole('button', { name: 'Find evidence' }).click();
  await expect(progress).toHaveAttribute('aria-valuenow', '10');
  await expect(progress).toHaveAttribute('aria-valuemax', '25');
  nextPart.resolve();
  await expect(page.getByText(/Review paused at the submission limit/)).toBeVisible();
  await expect(progress).toHaveAttribute('aria-valuenow', '10');
  await page.getByRole('button', { name: 'Cancel review' }).click();
  await expect(page.getByRole('button', { name: 'Find evidence' })).toBeEnabled();
  await expect(page.getByRole('navigation', { name: 'This review' })).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Review steps' }).getByRole('button', { name: /Existing policies/ }).click();
  await expect(page.getByRole('list', { name: 'Added policies' })).toContainText('Registry.txt');
  await continueToSource(page, 'questionnaire');

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
  await uploadPdf(page, 'Upload policy files', 'Signature policy.pdf', policy);
  await expect(page.getByRole('list', { name: 'Added policies' })).toContainText('Signature policy.pdf');
  await continueToSource(page, 'questionnaire');
  const assessment = page.waitForResponse('**/api/review');
  await uploadPdf(page, 'Upload questionnaire', 'Complete form.pdf', form);
  await expectCompactPdf(page);
  const response = await submitReview(page, 'questionnaire', assessment);
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
