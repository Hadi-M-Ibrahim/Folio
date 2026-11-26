import {
  modeLabels,
  statusLabels,
  type Decision,
  type Evidence,
  type Review,
} from './review';

function passages(label: string, entries: Evidence[]): string[] {
  if (!entries.length) return [`**${label}** — No passage cited.`, ''];
  return [
    `**${label}**`,
    '',
    ...entries.flatMap((e) => [
      `${e.title}, p. ${e.page}`,
      '',
      ...e.quote.split('\n').map((line) => '> ' + line),
      '',
    ]),
  ];
}

export function exportReview(
  review: Review,
  decisions: Map<string, { decision: Decision }>
): void {
  const { input, result } = review;
  const lines = [
    '# ' + review.title,
    '',
    modeLabels[input.mode],
    '',
    `Review method — ${result.engine === 'example' ? 'Prepared fictional example' : result.engine === 'anthropic' ? 'Model-assisted assessment' : 'Keyword retrieval'}`,
    '',
    result.notice,
    '',
    `Scope — ${input.documents.length} policy documents, ${input.documents.reduce((n, d) => n + d.pages.length, 0)} reviewed pages.`,
    '',
  ];
  if (review.scope) {
    const { sourceDocuments, sourcePages, searchablePages } = review.scope;
    lines.push(
      `Original corpus — ${sourceDocuments} documents and ${sourcePages} pages (${searchablePages} searchable). Evidence review covers the selected pages above.`,
      ''
    );
  }
  for (const [index, finding] of result.findings.entries()) {
    const decision = decisions.get(review.key + '/' + finding.id)?.decision;
    lines.push(`## ${index + 1}. ${finding.question}`, '');
    if (input.mode === 'guide' && finding.criterionSource) {
      lines.push(
        '**Guide passage**',
        '',
        ...finding.criterionSource.split('\n').map((line) => '> ' + line),
        ''
      );
    }
    lines.push(
      `Assessment — ${statusLabels[finding.status]}`,
      '',
      finding.answer,
      '',
      `Reviewer decision — ${decision ? (decision.value === 'confirmed' ? 'Confirmed' : 'Flagged for follow-up') + ' (' + decision.at + ')' : 'Pending'}`,
      '',
      ...passages('Supporting evidence', finding.supporting),
      ...passages('Counterevidence', finding.counter)
    );
    if (
      !finding.supporting.length &&
      !finding.counter.length &&
      finding.candidates.length
    ) {
      lines.push(
        ...passages(
          'Ranked passages awaiting classification',
          finding.candidates
        )
      );
    }
    if (finding.searchTerms.length) {
      lines.push('Search terms used — ' + finding.searchTerms.join(', '), '');
    }
  }
  const url = URL.createObjectURL(
    new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
  );
  const download = document.createElement('a');
  download.href = url;
  download.download = 'folio-' + input.mode + '-review.md';
  download.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
