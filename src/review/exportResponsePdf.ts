import pdfMake from 'pdfmake/build/pdfmake';
import regularFont from 'pdfmake/fonts/Roboto/Roboto-Regular.ttf?inline';
import mediumFont from 'pdfmake/fonts/Roboto/Roboto-Medium.ttf?inline';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { downloadFile } from './downloadFile';
import { guideCitation } from './guideSource';
import { decisionStatusLabel, policyActionLabels, type Evidence, type Mode, type Review, type SavedResponse } from './model';

pdfMake.addVirtualFileSystem({
  'Roboto-Regular.ttf': regularFont.split(',')[1],
  'Roboto-Medium.ttf': mediumFont.split(',')[1],
});

function entryHeading(mode: Mode, { finding, decision, index }: SavedResponse, source?: string): Content {
  const item = mode === 'guide' ? 'Obligation' : 'Question';
  const status = decisionStatusLabel(decision, mode);
  const stack: Content[] = [
    { text: `${item} ${index + 1}   ·   ${status}`, fontSize: 9, color: '#645f58', marginBottom: 3 },
    { text: finding.question, fontSize: 13, bold: true },
  ];
  if (source) stack.push({ text: source, fontSize: 9.5, color: '#645f58', marginTop: 3 });
  return { stack, margin: [0, 16, 0, 5], unbreakable: true };
}

function citationBlock(citation: Evidence): Content {
  return {
    text: [{ text: `${citation.title} · p. ${citation.page}\n`, bold: true }, citation.quote],
    fontSize: 9.5, color: '#514d48', margin: [12, 7, 0, 0],
  };
}

async function downloadPdf(heading: string, title: string, content: Content[], filename: string) {
  const document: TDocumentDefinitions = {
    info: { title: heading + ' — ' + title, creator: 'Folio' },
    pageSize: 'LETTER', pageMargins: [48, 46, 48, 52],
    defaultStyle: { font: 'Roboto', fontSize: 11, lineHeight: 1.22, color: '#191915' },
    content: [
      { text: heading, fontSize: 25, bold: true, marginBottom: 6 },
      { text: title, color: '#645f58', marginBottom: 10 },
      ...content,
    ],
    footer: (number, total) => ({
      columns: ['Folio', { text: `${number} / ${total}`, alignment: 'right' }],
      fontSize: 9, color: '#645f58', margin: [48, 14, 48, 0],
    }),
  };
  const pdf = await pdfMake.createPdf(document).getBlob();
  downloadFile(pdf, filename);
}

export function exportResponsePdf(title: string, entries: readonly SavedResponse[]) {
  const content = entries.flatMap(entry => [
    entryHeading('questionnaire', entry),
    { text: entry.decision.answer?.trim() || 'No response entered.' },
    ...(entry.decision.citations ?? []).map(citationBlock),
  ]);
  return downloadPdf('Questionnaire responses', title, content, 'folio-questionnaire-responses.pdf');
}

export function exportActionListPdf(review: Review, entries: readonly SavedResponse[]) {
  const content: Content[] = [];
  if (review.sourceSelection) content.push({ text: review.sourceSelection, fontSize: 9.5, color: '#645f58' });
  for (const entry of entries) {
    const { finding, decision } = entry;
    content.push(entryHeading('guide', entry, guideCitation(review, finding)));
    if (finding.criterionSource && finding.criterionSource !== finding.question) {
      content.push({ text: finding.criterionSource, fontSize: 9.5, color: '#514d48', marginBottom: 5 });
    }
    const action = decision.action ? policyActionLabels[decision.action] : 'Action pending';
    const answer = decision.answer?.trim();
    content.push({ text: !decision.action && answer ? answer : [
      { text: action + '\n', bold: true }, answer || 'No action text entered.',
    ] });
    if (decision.note?.trim()) {
      content.push({ text: [{ text: 'Analyst note   ', bold: true }, decision.note.trim()], marginTop: 5 });
    }
    content.push(...(decision.citations ?? []).map(citationBlock));
  }
  return downloadPdf('Policy action list', review.title, content, 'folio-policy-action-list.pdf');
}
