import pdfMake from 'pdfmake/build/pdfmake';
import regularFont from 'pdfmake/fonts/Roboto/Roboto-Regular.ttf?inline';
import mediumFont from 'pdfmake/fonts/Roboto/Roboto-Medium.ttf?inline';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { downloadFile } from './downloadFile';
import { responseLabels, type SavedResponse } from './model';

pdfMake.addVirtualFileSystem({
  'Roboto-Regular.ttf': regularFont.split(',')[1],
  'Roboto-Medium.ttf': mediumFont.split(',')[1],
});

export async function exportResponsePdf(title: string, entries: readonly SavedResponse[]) {
  const content: Content[] = [
    { text: 'Questionnaire responses', fontSize: 25, bold: true, marginBottom: 6 },
    { text: title, color: '#645f58', marginBottom: 10 },
  ];
  for (const { finding, decision, index } of entries) {
    const status = decision.value ? responseLabels[decision.value] : 'Draft';
    content.push(
      { stack: [
        { text: `Question ${index + 1}   ·   ${status}`, fontSize: 9, color: '#645f58', marginBottom: 3 },
        { text: finding.question, fontSize: 13, bold: true },
      ], margin: [0, 16, 0, 5], headlineLevel: 1 },
      { text: decision.answer?.trim() || 'No response entered.' },
    );
    for (const citation of decision.citations ?? []) {
      content.push({
        text: [
          { text: `${citation.title} · p. ${citation.page}\n`, bold: true },
          citation.quote,
        ],
        fontSize: 9.5, color: '#514d48', margin: [12, 7, 0, 0],
      });
    }
  }
  const document: TDocumentDefinitions = {
    info: { title: 'Questionnaire responses — ' + title, creator: 'Folio' },
    pageSize: 'LETTER', pageMargins: [48, 46, 48, 52],
    defaultStyle: { font: 'Roboto', fontSize: 11, lineHeight: 1.22, color: '#191915' },
    content,
    pageBreakBefore: (node, page) => node.headlineLevel === 1 && node.pageNumbers.length === 1 &&
      page.getFollowingNodesOnPage().length === 0 && page.getPreviousNodesOnPage().length > 0,
    footer: (number, total) => ({
      columns: ['Folio', { text: `${number} / ${total}`, alignment: 'right' }],
      fontSize: 9, color: '#645f58', margin: [48, 14, 48, 0],
    }),
  };
  const pdf = await pdfMake.createPdf(document).getBlob();
  downloadFile(pdf, 'folio-questionnaire-responses.pdf');
}
