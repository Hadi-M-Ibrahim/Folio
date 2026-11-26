const itemNumber = /^(?:Q(?:uestion)?\s*)?\(?\d+(?:\.\d+)*[.):]\s+/i;
const bullet = /^[•●*-]\s+/;
const questionStart = /^(?:are|can|describe|do|does|explain|has|have|how|identify|is|list|provide|should|what|when|where|which|who|will)\b/i;
const pageNumber = /^(?:page\s+)?\d+\s+(?:of|\/)\s+\d+$|^page\s+\d+$|^\d+$/i;
const formTitle = /^(?:[\w&-]+\s+){0,6}(?:questionnaire|form)$/i;
const answerField = /\(references?\s*:|^(?:[☐□]\s*)?yes\s+(?:[☐□]\s*)?no\b/i;

// A PDF's visual line breaks often fall in the middle of a question.
// Preserve item numbers and list options so reviewers can check the editable text.
export function questionsFromPdf(text: string): string {
  const questions: string[] = [];
  let inOptions = false;
  let inAnswerField = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || pageNumber.test(line)) continue;
    const numbered = itemNumber.test(line);
    const listed = bullet.test(line);
    const prompt = questionStart.test(line.replace(itemNumber, '').replace(bullet, ''));
    if (!questions.length && !prompt && formTitle.test(line)) continue;
    if (inAnswerField && !numbered && !prompt) continue;

    const answer = line.search(answerField);
    inAnswerField = answer >= 0;
    const content = inAnswerField ? line.slice(0, answer).trimEnd() : line;
    if (!content) continue;

    const previous = questions.at(-1);
    if (!previous || numbered || (prompt && (listed || inOptions || /[?!.]$/.test(previous)))) {
      questions.push(content);
      inOptions = false;
    } else {
      questions[questions.length - 1] += ' ' + content;
    }
    if (listed && !prompt) inOptions = true;
  }
  return questions.join('\n');
}
