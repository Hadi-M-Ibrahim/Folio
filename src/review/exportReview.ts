import { guideCitation } from './guideSource';
import {
  assessmentLabel,
  policyActionLabels,
  responseLabels,
  statusLabels,
  type Decision,
  type Evidence,
  type PolicyAction,
  type Review,
  type ReviewRow,
} from './model';

// Character references render as literal text after Markdown has recognized its
// block and inline syntax. Keep the report's own headings and quotes separate.
function markdownText(text: string): string {
  return text.replace(/\r\n?/g, '\n')
    .replace(/[&<>\\`*_[\]{}#!|~^$+=:@-]/g, (character) => `&#${character.charCodeAt(0)};`)
    .replace(/^([ \t]*\d{1,9})([.)])(?=[ \t]|$)/gm, (_, digits: string, delimiter: string) =>
      `${digits}&#${delimiter.charCodeAt(0)};`)
    .replace(/^[ \t]+/gm, (indent) => indent.replace(/./g, (space) => `&#${space.charCodeAt(0)};`));
}

function inlineText(text: string): string {
  return markdownText(text.replace(/\s+/g, ' '));
}

function quoted(text: string): string[] {
  return markdownText(text).split('\n').map((line) => '> ' + line);
}

function passages(label: string, entries: Evidence[]): string[] {
  if (!entries.length) return [`**${label}** — None cited.`, ''];
  return [
    `**${label}**`,
    '',
    ...entries.flatMap((e) => [`${inlineText(e.title)}, p. ${e.page}`, '', ...quoted(e.quote), '']),
  ];
}

function responseStatus(decision?: Decision): string {
  if (decision?.value) return responseLabels[decision.value];
  return decision?.answer?.trim() || decision?.citations?.length ? 'Draft' : 'Pending';
}

function appendPolicyActions(lines: string[], review: Review, rows: readonly ReviewRow[]) {
  const groups: (PolicyAction | undefined)[] = ['write', 'update', 'no_change', undefined];
  for (const action of groups) {
    const obligations = rows.filter((row) => row.decision?.action === action);
    if (!obligations.length) continue;
    lines.push('## ' + (action ? policyActionLabels[action] : 'Action pending'), '');
    for (const { finding, index, decision } of obligations) {
      lines.push(`### Obligation ${index + 1}`, '', inlineText(guideCitation(review, finding)), '');
      if (finding.criterionSource) lines.push(...quoted(finding.criterionSource), '');
      if (finding.criterionSource !== finding.question) {
        lines.push('Review criterion — ' + markdownText(finding.question), '');
      }
      lines.push('Action note — ' + markdownText(decision?.note?.trim() || 'None recorded.'), '');
      if (decision) lines.push('Last edited — ' + decision.at, '');
    }
  }
}

function appendQuestionnaireResponses(lines: string[], rows: readonly ReviewRow[]) {
  for (const { finding, index, decision } of rows) {
    lines.push(
      `## Question ${index + 1}. ${inlineText(finding.question)}`,
      '',
      'Response status — ' + responseStatus(decision),
      '',
      markdownText(decision?.answer?.trim() || 'No response entered.'),
      '',
      ...passages('Reviewer-selected citations', decision?.citations ?? []),
    );
    if (decision) lines.push('Last edited — ' + decision.at, '');
  }
}

function appendEvidenceRecord(lines: string[], review: Review, rows: readonly ReviewRow[]) {
  const { input, result } = review;
  const isGuide = input.mode === 'guide';
  lines.push(
    '## Evidence and search record',
    '',
    `Review method — ${result.engine === 'anthropic' ? 'Model-assisted assessment' : 'Keyword retrieval'}`,
    '',
    markdownText(result.notice),
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
  for (const { finding, index } of rows) {
    lines.push(
      `### ${isGuide ? 'Obligation' : 'Question'} ${index + 1}`,
      '',
      `${assessmentLabel(finding)} — ${statusLabels[finding.status]}`,
      '',
      markdownText(finding.answer),
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
      lines.push(`Search terms (${finding.searchTerms.length} of ${termCount}) — ${finding.searchTerms.map(inlineText).join(', ')}`, '');
    }
  }
}

export function exportReview(review: Review, rows: readonly ReviewRow[]): void {
  const { input, result } = review;
  const isGuide = input.mode === 'guide';
  const guideOnly = isGuide && input.documents.length === 0;
  const lines = [
    isGuide ? '# Policy action list' : '# Questionnaire responses',
    '',
    inlineText(review.title),
    '',
  ];

  if (review.sourceSelection) lines.push('Source selection — ' + inlineText(review.sourceSelection), '');
  if (guideOnly && result.planningEngine) {
    const method = result.planningEngine === 'anthropic' ? 'Model-assisted' : 'Local';
    lines.push(`Review method — ${method} obligation extraction`, '', markdownText(result.notice), '');
  }

  if (isGuide) appendPolicyActions(lines, review, rows);
  else appendQuestionnaireResponses(lines, rows);
  if (!guideOnly) appendEvidenceRecord(lines, review, rows);

  const url = URL.createObjectURL(
    new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }),
  );
  const download = document.createElement('a');
  download.href = url;
  download.download = isGuide ? 'folio-policy-action-list.md' : 'folio-questionnaire-responses.md';
  download.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
