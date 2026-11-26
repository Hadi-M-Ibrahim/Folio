import { useMemo } from 'react';
import { ChevronDown, ClipboardPaste, FilePenLine, FolderOpen, X } from 'lucide-react';
import { isLoopback } from '../review/client';
import { MAX_GUIDE_CHARACTERS, MAX_PDF_ATTACHMENT_PAGES, MAX_QUESTIONS, type Policy } from '../review/model';
import { IntakeFile } from './IntakeFile';
import { PdfViewer } from './PdfViewer';
import { pdfScopeLabel, questionnaireRange, SourceRange, type RangeItem, type RangeSource } from './SourceRange';
import { questionsFromPdfPages } from './intakeQuestions';

export type IntakeSource = {
  text: string;
  name: string;
  document?: Policy;
  range?: RangeSource;
  selection?: string;
  rangeValue?: string;
  questions?: string[];
  readSourcePdf?: boolean;
  showText?: boolean;
};

export function sourceFromDocument(doc: Policy, isGuide: boolean): IntakeSource {
  const hasUnindexedPages = doc.pages.some((page) => !page.text.trim());
  const indexed = doc.pdfFile && !isGuide && !hasUnindexedPages ? questionsFromPdfPages(doc.pages) : [];
  const questions = indexed.length ? indexed.map((item) => item.text) : undefined;
  const pageRange = (isGuide || (doc.pdfFile && indexed.length < 2)) && doc.pages.length > 1;
  return {
    text: questions?.join('\n') ?? doc.pages.map((page) => page.text).join('\n\n'),
    name: doc.title,
    document: doc,
    range: pageRange ? { unit: 'page', items: doc.pages, original: doc } : questionnaireRange(indexed, doc),
    questions,
    readSourcePdf: Boolean(doc.pdfFile && (hasUnindexedPages || (!isGuide && !questions))),
  };
}

function applyRange(source: IntakeSource, range: RangeSource, items: RangeItem[], isGuide: boolean,
  selection: string | undefined, rangeValue: string): IntakeSource {
  const original = range.original;
  const subset = items.length < range.items.length;
  if (original?.pdfFile && !subset) return { ...sourceFromDocument(original, isGuide), rangeValue };
  let document = original;
  if (original && range.unit === 'page') {
    document = { ...original, pages: items };
  } else if (original?.pdfFile && subset) {
    const numbers = new Set(items.flatMap((item) => item.pageNumbers ?? []));
    document = { ...original, pages: original.pages.filter((page) => numbers.has(page.number)) };
  }
  const lines = items.map((item) => item.text);
  const readSourcePdf = Boolean(document?.pdfFile && range.unit === 'page' && (!isGuide || items.some((page) => !page.text.trim())));
  return {
    ...source, document, selection, range, rangeValue, readSourcePdf,
    text: lines.join(range.unit === 'page' ? '\n\n' : '\n'),
    questions: range.unit === 'question' ? lines : undefined,
  };
}

type SourceFieldsProps = {
  isGuide: boolean;
  source: IntakeSource;
  questions: string[];
  onChange: (source: IntakeSource) => void;
  onFiles: (files: File[], kind: 'source' | 'bundle') => void;
};

function SourceText({ isGuide, source, questions, onChange }: Omit<SourceFieldsProps, 'onFiles'>) {
  const open = source.showText ?? (!source.name && Boolean(source.text));
  const pasteLabel = isGuide ? 'Paste guide text' : 'Paste a question or list';
  const textAction = source.name ? 'Preview and edit text' : pasteLabel;
  const counted = isGuide ? source.text.trim().length : questions.length;
  const countLabel = isGuide ? 'characters' : counted === 1 ? 'question' : 'questions';

  return (
    <div className="intake-source">
      <button type="button" className="intake-text-button" aria-expanded={open} aria-controls="source-text-fields"
        onClick={() => onChange({ ...source, showText: !open })}>
        {source.name ? <FilePenLine size={16} aria-hidden="true" /> : <ClipboardPaste size={16} aria-hidden="true" />}
        {source.text && !source.name ? 'Edit pasted text' : textAction}
        <ChevronDown className="intake-chevron" size={14} aria-hidden="true" />
      </button>
      <div id="source-text-fields" hidden={!open}>
        <div className="intake-field-heading">
          <label htmlFor="intake-source">{isGuide ? 'Guide text' : 'Questions'}</label>
          {counted > 0 && <span>{counted.toLocaleString()} {countLabel}</span>}
        </div>
        {open && <textarea
          id="intake-source"
          rows={5}
          value={source.text}
          placeholder={isGuide ? 'Paste the section you want to review…' : 'Enter one question per line…'}
          aria-describedby="source-format"
          onChange={(event) => onChange({ text: event.target.value, name: source.name, showText: true })}
        />}
        <p className="intake-help" id="source-format">
          {isGuide ? 'Review up to 50,000 characters at a time.' : 'One question per line, up to 30 per review.'}
        </p>
      </div>
    </div>
  );
}

function SourcePdf({ doc, file, source }: { doc: Policy; file: File; source: IntakeSource }) {
  const pageNumbers = useMemo(() => doc.pages.map((page) => page.number), [doc.pages]);
  return <>
    <p className="intake-help">
      {pdfScopeLabel(pageNumbers, Boolean(source.selection))}
      {source.selection && source.range?.unit === 'question' && ' Other questions printed on ' +
        (pageNumbers.length === 1 ? 'this page are' : 'these pages are') + ' visible to Anthropic.'}
    </p>
    <PdfViewer file={file} pages={pageNumbers} />
  </>;
}

function uploadDetail(source: IntakeSource) {
  if (!source.name) return 'Drop a PDF, TXT or Markdown file here.';
  const original = source.range?.original ?? source.document;
  return original ? original.pages.length + (original.pages.length === 1 ? ' page' : ' pages') : 'Edited text';
}

export function SourceFields({ isGuide, source, questions, onChange, onFiles }: SourceFieldsProps) {
  const availableRange = useMemo(() => source.range ?? (isGuide || source.document?.pdfFile ? undefined : questionnaireRange(questions, source.document)),
    [isGuide, questions, source.range, source.document]);
  const doc = source.document;
  const tooManyPages = doc?.pdfFile && doc.pages.length > MAX_PDF_ATTACHMENT_PAGES;
  const tooMuchText = !source.readSourcePdf && (isGuide ? source.text.trim().length > MAX_GUIDE_CHARACTERS : questions.length > MAX_QUESTIONS);
  const oversized = Boolean(tooManyPages || tooMuchText);

  return (
    <>
      <IntakeFile
        label={isGuide ? 'Upload regulatory guide' : 'Upload questionnaire'}
        fileName={source.name}
        detail={uploadDetail(source)}
        onFiles={(files) => onFiles(files, 'source')}
      />
      <div className="intake-source-options">
        {!doc?.pdfFile && <SourceText isGuide={isGuide} source={source} questions={questions} onChange={onChange} />}
        {availableRange && (
          <SourceRange
            key={availableRange.original?.id ?? 'pasted'}
            source={availableRange}
            oversized={oversized}
            pageKind={isGuide ? 'guide' : 'questionnaire'}
            appliedValue={source.rangeValue}
            onApply={(items, description, rangeValue) => onChange(applyRange(source, availableRange, items, isGuide, description, rangeValue))}
          />
        )}
        {source.name && <button type="button" className="intake-text-button" onClick={() => {
          onChange({ text: '', name: '', showText: true });
          requestAnimationFrame(() => document.getElementById('intake-source')?.focus());
        }}><X size={16} aria-hidden="true" /> Remove file</button>}
      </div>
      {doc?.pdfFile && <SourcePdf doc={doc} file={doc.pdfFile} source={source} />}
      {tooManyPages && <output className="intake-notice">Choose a smaller range. A review can include up to {MAX_PDF_ATTACHMENT_PAGES} PDF pages across all files.</output>}
      {tooMuchText && (
        <output className="intake-notice">
          {isGuide ? 'This guide exceeds 50,000 characters. Select a shorter section.'
            : 'This questionnaire exceeds 30 questions. Choose a smaller item range.'}
        </output>
      )}
      {isLoopback && (
        <label className="intake-bundle">
          <FolderOpen size={15} aria-hidden="true" /> Import a prepared review (.json)
          <input
            type="file"
            accept=".json"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) onFiles([file], 'bundle');
            }}
          />
        </label>
      )}
    </>
  );
}
