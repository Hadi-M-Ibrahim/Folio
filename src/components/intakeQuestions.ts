const itemNumber = /^(?:Q(?:uestion)?\s*)?\(?\d+(?:\.\d+)*[.):]\s+/i;
const bullet = /^[•●*-]\s+/;
const questionStart = /^(?:please\s+)?(?:are|can|could|describe|do|does|explain|has|have|how|identify|is|list|provide|should|specify|what|when|where|which|who|why|will|would)\b/i;
const pageNumber = /^(?:page\s+)?\d+\s+(?:of|\/)\s+\d+$|^page\s+\d+$|^\d+$/i;
const formTitle = /^(?:[\w&-]+\s+){0,6}(?:questionnaire|form)$/i;
const answerField = /\(references?\s*:|^(?:[☐□]\s*)?yes\s+(?:[☐□]\s*)?no\b/i;

function questionnaireStart(lines: string[]): number {
  const index = lines.findIndex((line) => itemNumber.test(line));
  if (index < 1) return 0;
  const firstItem = lines[index];
  // A list of numbered answer choices can also occur in an unnumbered form.
  if (!/^(?:Q(?:uestion)?\s*)?\(?1[.):]\s+/i.test(firstItem)) return 0;
  if (!questionStart.test(firstItem.replace(itemNumber, '')) && !/^(?:Q\d|Question\s+1)|\?$/i.test(firstItem)) return 0;
  let prompt = -1;
  for (let i = 0; i < index; i++) {
    if (questionStart.test(lines[i])) prompt = i;
    if (prompt >= 0 && (lines[i].endsWith('?') || (prompt === i && lines[i].endsWith(':')))) return prompt;
    if (/[.!]$/.test(lines[i])) prompt = -1;
  }
  return index;
}

function startsQuestion(previous: string | undefined, numbered: boolean, prompt: boolean, followsList: boolean) {
  return !previous || numbered || (prompt && (followsList || /[?!.]$/.test(previous)));
}

// A PDF's visual line breaks often fall in the middle of a question.
// Preserve item numbers and list options so reviewers can check the editable text.
export function questionsFromPdf(text: string): string {
  const questions: string[] = [];
  let inOptions = false;
  let inAnswerField = false;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !pageNumber.test(line));
  for (let index = questionnaireStart(lines); index < lines.length; index++) {
    const line = lines[index];
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
    const numberedChoice = numbered && !prompt && (inOptions || previous?.endsWith(':'));
    if (startsQuestion(previous, numbered && !numberedChoice, prompt, listed || inOptions)) {
      questions.push(content);
      inOptions = false;
    } else {
      questions[questions.length - 1] += ' ' + content;
    }
    if ((listed || numberedChoice) && !prompt) inOptions = true;
  }
  return questions.join('\n');
}
