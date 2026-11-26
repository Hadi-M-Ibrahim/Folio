const itemNumber = /^(?:Q(?:uestion)?\s*)?\(?\d+(?:\.\d+)*[.):]\s+/i;
const bullet = /^[•●*-]\s+/;
const questionStart = /^(?:are|can|describe|do|does|explain|has|have|how|identify|is|list|provide|should|what|when|where|which|who|will)\b/i;
const pageNumber = /^(?:page\s+)?\d+\s+(?:of|\/)\s+\d+$|^page\s+\d+$|^\d+$/i;
const formTitle = /^(?:[\w&-]+\s+){0,6}(?:questionnaire|form)$/i;

// A PDF's visual line breaks often fall in the middle of a question.
// Preserve item numbers and list options so reviewers can check the editable text.
export function questionsFromPdf(text: string): string {
  const questions: string[] = [];
  let current = '';
  let inOptions = false;
  let inAnswerField = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || pageNumber.test(line)) continue;
    const numbered = itemNumber.test(line);
    const listed = bullet.test(line);
    const prompt = questionStart.test(line.replace(itemNumber, '').replace(bullet, ''));
    if (!current && !prompt && formTitle.test(line)) continue;
    if (numbered || prompt) inAnswerField = false;
    if (inAnswerField) continue;

    const answer = line.search(/\(references?\s*:|^(?:[☐□]\s*)?yes\s+(?:[☐□]\s*)?no\b/i);
    const content = (answer < 0 ? line : line.slice(0, answer)).trim();
    if (content) {
      const startsQuestion = numbered || (prompt && (listed || inOptions || /[?!.]$/.test(current)));
      if (startsQuestion && current) {
        questions.push(current);
        current = '';
        inOptions = false;
      }
      if (listed && !prompt) inOptions = true;
      current = current ? current + ' ' + content : content;
    }
    if (answer >= 0) inAnswerField = true;
  }
  if (current) questions.push(current);
  return questions.join('\n');
}
