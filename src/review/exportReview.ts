import { guideCitation } from './guideSource';
import {
  policyActionLabels,
  statusLabels,
  type Decision,
  type Evidence,
  type PolicyAction,
  type Review,
} from './model';

type Decisions = ReadonlyMap<string, { decision: Decision }>;

function quoted(text: string): string[] {
  return text.split(/\r?\n/).map((line) => '> ' + line);
}

function passages(label: string, entries: Evidence[]): string[] {
  if (!entries.length) return [`**${label}** — None cited.`, ''];
  return [
    `**${label}**`,
    '',
    ...entries.flatMap((e) => [`${e.title}, p. ${e.page}`, '', ...quoted(e.quote), '']),
  ];
}

function responseStatus(decision?: Decision): string {
  if (decision?.value === 'confirmed') return 'Confirmed';
  if (decision?.value === 'flagged') return 'Flagged for follow-up';
  return decision?.answer?.trim() || decision?.citations?.length ? 'Draft' : 'Pending';
}

export function exportReview(review: Review, decisions: Decisions): void {
  const { input, result } = review;
  const isGuide = input.mode === 'guide';
  const guideOnly = isGuide && input.documents.length === 0;
  const rows = result.findings.map((finding, index) => ({
    finding,
    number: index + 1,
    decision: decisions.get(review.key + '/' + finding.id)?.decision,
  }));
  const lines = [
    isGuide ? '# Policy action list' : '# Questionnaire responses',
    '',
    review.title,
    '',
  ];

  if (review.sourceSelection) lines.push('Source selection — ' + review.sourceSelection, '');
  if (guideOnly && result.planningEngine) {
    const method = result.planningEngine === 'anthropic' ? 'Model-assisted' : 'Local';
    lines.push(`Review method — ${method} obligation extraction`, '', result.notice, '');
  }

  if (isGuide) {
    const groups: (PolicyAction | undefined)[] = ['write', 'update', 'no_change', undefined];
    for (const action of groups) {
      const obligations = rows.filter((row) => row.decision?.action === action);
      if (!obligations.length) continue;
      lines.push('## ' + (action ? policyActionLabels[action] : 'Action pending'), '');
      for (const { finding, number, decision } of obligations) {
        lines.push(`### Obligation ${number}`, '', guideCitation(review, finding), '');
        if (finding.criterionSource) lines.push(...quoted(finding.criterionSource), '');
        if (finding.criterionSource !== finding.question) {
          lines.push('Review criterion — ' + finding.question, '');
        }
        lines.push('Action note — ' + (decision?.note?.trim() || 'None recorded.'), '');
        if (decision) lines.push('Last edited — ' + decision.at, '');
      }
    }
  } else {
    for (const { finding, number, decision } of rows) {
      lines.push(
        `## Question ${number}. ${finding.question}`,
        '',
        'Response status — ' + responseStatus(decision),
        '',
        decision?.answer?.trim() || 'No response entered.',
        '',
        ...passages('Reviewer-selected citations', decision?.citations ?? []),
      );
      if (decision) lines.push('Last edited — ' + decision.at, '');
    }
  }

  if (!guideOnly) {
    lines.push(
      '## Evidence and search record',
      '',
      `Review method — ${result.engine === 'anthropic' ? 'Model-assisted assessment' : 'Keyword retrieval'}`,
      '',
      result.notice,
      '',
      `Reviewed policy documents — ${input.documents.length} documents, ${input.documents.reduce((n, d) => n + d.pages.length, 0)} pages.`,
      '',
    );
    if (review.scope) {
      const { sourceDocuments, sourcePages, searchablePages } = review.scope;
      lines.push(
        `Original corpus — ${sourceDocuments} documents, ${sourcePages} pages (${searchablePages} searchable).`,
        '',
      );
    }
    for (const { finding, number } of rows) {
      const method = finding.analysisEngine === 'anthropic' ? 'Model assessment' : 'Keyword search';
      lines.push(
        `### ${isGuide ? 'Obligation' : 'Question'} ${number}`,
        '',
        `${method} — ${statusLabels[finding.status]}`,
        '',
        finding.answer,
        '',
        ...passages('Supporting policy evidence', finding.supporting),
        ...passages('Counterevidence', finding.counter),
      );
      const available = finding.candidates.length;
      const total = finding.totalCandidatePassages ?? available;
      if (available) {
        lines.push(...passages(`Ranked policy passages (${available} of ${total})`, finding.candidates));
      }
      if (finding.searchTerms.length) {
        const termCount = finding.totalSearchTerms ?? finding.searchTerms.length;
        lines.push(`Search terms (${finding.searchTerms.length} of ${termCount}) — ${finding.searchTerms.join(', ')}`, '');
      }
    }
  }
  const url = URL.createObjectURL(
    new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }),
  );
  const download = document.createElement('a');
  download.href = url;
  download.download = isGuide ? 'folio-policy-action-list.md' : 'folio-questionnaire-responses.md';
  download.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
