const itemNumber = /^(?:Q(?:uestion)?\s*)?\(?\d+(?:\.\d+)*[.):]\s+/i;
const bullet = /^[•●*-]\s+/;
const questionStart = /^(?:please\s+)?(?:are|can|could|describe|do|does|explain|has|have|how|identify|indicate|is|list|provide|should|specify|what|when|where|which|who|why|will|would)\b/i;
const pageNumber = /^(?:page\s+)?\d+\s+(?:of|\/)\s+\d+$|^page\s+\d+$|^\d+$/i;
const formTitle = /^(?:[\w&-]+\s+){0,6}(?:questionnaire|form)$/i;
const answerField = /\(references?\s*:|^(?:[☐□]\s*)?yes\s+(?:[☐□]\s*)?no\b/i;

type PdfLine = { text: string; page: number };
export type PdfQuestion = { text: string; pageNumbers: number[] };

function questionnaireStart(lines: PdfLine[]): number {
  const index = lines.findIndex((line) => itemNumber.test(line.text));
  if (index < 1) return 0;
  const firstItem = lines[index].text;
  // A list of numbered answer choices can also occur in an unnumbered form.
  if (!/^(?:Q(?:uestion)?\s*)?\(?1[.):]\s+/i.test(firstItem)) return 0;
  if (!questionStart.test(firstItem.replace(itemNumber, '')) && !/^(?:Q\d|Question\s+1)|\?$/i.test(firstItem)) return 0;
  let prompt = -1;
  for (let i = 0; i < index; i++) {
    const line = lines[i].text;
    if (questionStart.test(line) && !formTitle.test(line)) prompt = i;
    if (prompt >= 0 && (line.endsWith('?') || (prompt === i && line.endsWith(':')))) return prompt;
    if (/[.!]$/.test(line)) prompt = -1;
  }
  return index;
}

function startsQuestion(previous: PdfQuestion, numbered: boolean, prompt: boolean, followsList: boolean) {
  return numbered || (prompt && (followsList || /[?!.]$/.test(previous.text)));
}

function canStartForm(line: string, prompt: boolean, numbered: boolean) {
  return !formTitle.test(line) && (prompt || numbered || line.endsWith('?'));
}

function appendLine(question: PdfQuestion, text: string, page: number) {
  question.text += ' ' + text;
  if (question.pageNumbers.at(-1) !== page) question.pageNumbers.push(page);
}

// Associate each line with its physical page before joining wrapped prompts and choices.
export function questionsFromPdfPages(pages: { number: number; text: string }[]): PdfQuestion[] {
  const lines = pages.flatMap(({ number, text }) => text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !pageNumber.test(line))
    .map((line) => ({ text: line, page: number })));
  const questions: PdfQuestion[] = [];
  let inOptions = false;
  let inAnswerField = false;
  for (let index = questionnaireStart(lines); index < lines.length; index++) {
    const { text: line, page } = lines[index];
    const numbered = itemNumber.test(line);
    const listed = bullet.test(line);
    const prompt = questionStart.test(line.replace(itemNumber, '').replace(bullet, ''));
    if (!questions.length && !canStartForm(line, prompt, numbered)) continue;
    if (inAnswerField && !numbered && !prompt) continue;

    const answer = line.search(answerField);
    inAnswerField = answer >= 0;
    const content = inAnswerField ? line.slice(0, answer).trimEnd() : line;
    if (!content) continue;

    const previous = questions.at(-1);
    const numberedChoice = numbered && !prompt && (inOptions || previous?.text.endsWith(':'));
    if (!previous || startsQuestion(previous, numbered && !numberedChoice, prompt, listed || inOptions)) {
      questions.push({ text: content, pageNumbers: [page] });
      inOptions = false;
    } else {
      appendLine(previous, content, page);
    }
    if ((listed || numberedChoice) && !prompt) inOptions = true;
  }
  return questions;
}

export function questionsFromPdf(text: string): string {
  return questionsFromPdfPages([{ number: 1, text }]).map((question) => question.text).join('\n');
}
