import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function report(page, name) {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name }).click();
  return readFile(await (await download).path(), 'utf8');
}

for (const mode of ['guide', 'questionnaire']) {
  test(`a rate-limited ${mode} keeps its inputs for retry`, async ({ page }) => {
    const guide = mode === 'guide';
    const source = guide ? 'Staff must keep a log.' : 'Who keeps the log?';
    await page.goto('/#/new/' + mode);
    await page.getByLabel(guide ? 'Guide text' : 'Questions', { exact: true }).fill(source);
    await page.getByRole('button', { name: 'Continue' }).click();
    if (!guide) {
      await page.getByLabel('Upload policy files').setInputFiles({
        name: 'Log.txt', mimeType: 'text/plain', buffer: Buffer.from('Office staff keep the log.'),
      });
    }
    const button = page.getByRole('button', { name: guide ? 'Review obligations' : 'Find evidence' });
    await page.route('**/api/review', (route) => route.fulfill({
      status: 429, contentType: 'text/html', body: 'Too many requests',
      headers: guide ? { 'Retry-After': '70' } : {},
    }), { times: 1 });
    await button.click();
    await expect(page.getByRole('alert')).toHaveText(
      `This network has reached its limit of 30 review submissions per 10 minutes. Try again in ${guide ? 2 : 10} minutes. Your inputs are still here.`,
    );
    await button.click();
    await expect(page.getByRole('heading', { name: source, exact: true })).toBeVisible();
  });
}

test('an analyst answers a question with an explicitly selected quotation', async ({ page }) => {
  const question = 'Who records the inspection date?';
  const policy = 'The facilities coordinator records the inspection date.';
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Start a review' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Reviews in this tab' })).toHaveCount(0);
  await page.getByRole('link', { name: /Answer a questionnaire/ }).click();
  await page.getByLabel('Questions', { exact: true }).fill(question);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/questionnaire\/policies$/);
  await page.goBack();
  await expect(page.getByLabel('Questions', { exact: true })).toHaveValue(question);
  await page.goForward();
  await page.getByRole('button', { name: 'Find evidence' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Upload policy files').setInputFiles({
    name: 'Facilities.txt', mimeType: 'text/plain', buffer: Buffer.from(policy),
  });
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await page.getByRole('button', { name: 'Find evidence' }).click();
  await expect(page.getByRole('heading', { name: question, exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Facilities.txt.*p\. 1/ }).first().click();
  await expect(page.locator('dialog mark')).toHaveText(policy);
  await page.keyboard.press('Escape');
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
  await expect(page.getByRole('heading', { name: 'Reviews in this tab' })).toBeVisible();
  await page.locator('.session-review').click();
  await expect(page.getByLabel('Response for submission')).toHaveValue('The facilities coordinator.');
});

test('a guide-only review produces an action list with a traceable source page', async ({ page }) => {
  const obligation = 'Teams must log the inspection date before handover.';
  await page.goto('/');
  await page.getByRole('link', { name: /Review a policy guide/ }).click();
  await page.getByLabel('Upload regulatory guide').setInputFiles({
    name: 'Handover.txt', mimeType: 'text/plain', buffer: Buffer.from('Introduction\f' + obligation),
  });
  await page.getByRole('button', { name: 'Choose guide pages' }).click();
  await page.getByLabel(/Guide pages/).fill('2');
  await page.getByRole('button', { name: 'Apply range' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Review obligations' }).click();
  await expect(page.getByRole('combobox', { name: 'Policy action', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Search trail' })).toHaveCount(0);
  await page.getByRole('button', { name: /Handover.txt.*p\. 2/ }).click();
  await expect(page.locator('dialog mark')).toHaveText(obligation);
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: 'Policy action', exact: true }).selectOption('write');
  await page.getByLabel('Action note').fill('Add an inspection record to the handover procedure.');
  const output = await report(page, 'Download action list');
  expect(output).toContain('Write new policy');
  expect(output).toContain('Guide pages 2');
  expect(output).toContain('Handover.txt · p. 2');
  expect(output).toContain(obligation);
  expect(output).toContain('Add an inspection record to the handover procedure.');
  await page.getByRole('button', { name: 'Decisions', exact: true }).click();
  await expect(page.locator('.decision-entry')).toContainText('Write new policy');
});

test('editing a selected question batch clears its previous source attribution', async ({ page }) => {
  await page.goto('/#/new/questionnaire');
  const questions = page.getByLabel('Questions', { exact: true });
  await questions.fill(Array.from({ length: 31 }, (_, index) => `${index + 1}. Who reviews record ${index + 1}?`).join('\n'));
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
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Review obligations' }).click();
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
  await expect(page.getByLabel('Guide text')).toHaveValue('Teams must record inspection dates.');
  await page.getByRole('button', { name: 'Continue' }).click();

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
