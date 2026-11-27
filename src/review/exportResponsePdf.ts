import pdfMake from 'pdfmake/build/pdfmake';
import serif from '@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff?inline';
import regular from 'pdfmake/fonts/Roboto/Roboto-Regular.ttf?inline';
import medium from 'pdfmake/fonts/Roboto/Roboto-Medium.ttf?inline';
import type { Content, CustomTableLayout, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import { downloadFile } from './downloadFile';
import { guideCitation } from './guideSource';
import { decisionStatusLabel, policyActionLabels, type Evidence, type Review, type SavedResponse } from './model';
import sheet from './templates/review-table.json';

pdfMake.addVirtualFileSystem({
  'InstrumentSerif.woff': serif.split(',')[1],
  'Roboto-Regular.ttf': regular.split(',')[1],
  'Roboto-Medium.ttf': medium.split(',')[1],
});
pdfMake.addFonts({ Instrument: { normal: 'InstrumentSerif.woff' } });

const ink = '#' + sheet.ink;
const muted = '#' + sheet.muted;
const rule = '#' + sheet.rule;

const booktabs: CustomTableLayout = {
  vLineWidth: () => 0,
  hLineWidth: (i, node) => i === 0 || i === node.table.body.length ? sheet.heavyRule : sheet.lightRule,
  hLineColor: (i, node) => i < 2 || i === node.table.body.length ? ink : rule,
  paddingLeft: () => 0,
  paddingRight: i => i < 2 ? sheet.gutter : 0,
  paddingTop: () => sheet.rowSpace,
  paddingBottom: () => sheet.rowSpace,
};

function citationsCell(citations: Evidence[] = []): TableCell {
  if (!citations.length) return { text: '—', color: muted };
  return { stack: citations.map((item, i) => ({
    stack: [
      { text: `${item.title} · p. ${item.page}`, bold: true, marginBottom: 2 },
      { text: item.quote, color: muted },
    ],
    fontSize: sheet.detail, marginTop: i ? sheet.rowSpace : 0,
  })) };
}

function reviewRow({ finding, decision, index }: SavedResponse, guide?: Review): TableCell[] {
  const status = decisionStatusLabel(decision, guide ? 'guide' : 'questionnaire');
  const subject: Content[] = [
    { text: `${guide ? 'Obligation' : 'Question'} ${index + 1}  ·  ${status}`, style: 'label', marginBottom: 3 },
    { text: finding.question },
  ];
  const answer: Content[] = [];
  if (guide) {
    subject.push({ text: guideCitation(guide, finding), style: 'label', marginTop: 5 });
    if (finding.criterionSource && finding.criterionSource !== finding.question) {
      subject.push({ text: finding.criterionSource, style: 'detail', marginTop: 2 });
    }
    if (decision.action || !decision.answer?.trim()) {
      answer.push({ text: decision.action ? policyActionLabels[decision.action] : 'Action pending', bold: true, marginBottom: 3 });
    }
  }
  answer.push({ text: decision.answer?.trim() || (guide ? 'No action text entered.' : 'No response entered.') });
  if (guide && decision.note?.trim()) {
    answer.push({ text: [{ text: 'Analyst note. ', bold: true }, decision.note.trim()], style: 'detail', marginTop: 5 });
  }
  return [{ stack: subject }, { stack: answer }, citationsCell(decision.citations)];
}

async function downloadTable(title: string, entries: readonly SavedResponse[], guide?: Review) {
  const heading = guide ? 'Policy action list' : 'Questionnaire responses';
  const columns = guide ? ['Obligation', 'Action', 'Citations'] : ['Question', 'Response', 'Citations'];
  const document: TDocumentDefinitions = {
    info: { title: heading + ' — ' + title, creator: 'Folio' },
    pageSize: { width: sheet.pageWidth, height: sheet.pageHeight },
    pageMargins: [sheet.inset, sheet.top, sheet.inset, sheet.bottom],
    defaultStyle: { font: 'Roboto', fontSize: sheet.body, lineHeight: 1.16, color: ink },
    styles: {
      detail: { fontSize: sheet.detail, color: muted },
      label: { fontSize: sheet.label, color: muted },
    },
    content: [
      { text: heading, font: 'Instrument', fontSize: sheet.heading, lineHeight: 1.02 },
      { text: title, color: muted, marginTop: 4 },
      ...(guide?.sourceSelection ? [{ text: guide.sourceSelection, style: 'detail', marginTop: 2 }] : []),
      { marginTop: 20, table: {
        headerRows: 1, widths: sheet.columns,
        body: [columns.map(text => ({ text, bold: true, fontSize: sheet.detail })), ...entries.map(entry => reviewRow(entry, guide))],
      }, layout: booktabs },
    ],
    footer: (page, total) => ({
      columns: ['Folio', { text: `${page} / ${total}`, alignment: 'right' }],
      style: 'label', margin: [sheet.inset, 16, sheet.inset, 0],
    }),
  };
  const pdf = await pdfMake.createPdf(document).getBlob();
  downloadFile(pdf, guide ? 'folio-policy-action-list.pdf' : 'folio-questionnaire-responses.pdf');
}

export function exportResponsePdf(title: string, entries: readonly SavedResponse[]) {
  return downloadTable(title, entries);
}

export function exportActionListPdf(review: Review, entries: readonly SavedResponse[]) {
  return downloadTable(review.title, entries, review);
}
