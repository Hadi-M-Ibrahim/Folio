import { useMemo } from 'react';
import { ChevronDown, ClipboardPaste, FilePenLine, FolderOpen } from 'lucide-react';
import { isLoopback } from '../review/client';
import { MAX_GUIDE_CHARACTERS, MAX_QUESTIONS, type Policy } from '../review/model';
import { IntakeFile } from './IntakeFile';
import { questionnaireRange, SourceRange, type RangeSource } from './SourceRange';

export type IntakeSource = {
  text: string;
  name: string;
  document?: Policy;
  range?: RangeSource;
  selection?: string;
  rangeValue?: string;
  questions?: string[];
  showText?: boolean;
};

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

export function SourceFields({ isGuide, source, questions, onChange, onFiles }: SourceFieldsProps) {
  const availableRange = useMemo(() => source.range ?? (isGuide ? undefined : questionnaireRange(questions, source.document)),
    [isGuide, questions, source.range, source.document]);
  const oversized = isGuide ? source.text.trim().length > MAX_GUIDE_CHARACTERS : questions.length > MAX_QUESTIONS;
  const originalPages = source.range?.original?.pages ?? source.document?.pages;
  const fileDetail = originalPages ? originalPages.length + (originalPages.length === 1 ? ' readable page' : ' readable pages') : 'Edited text';

  return (
    <>
      <IntakeFile
        label={isGuide ? 'Upload regulatory guide' : 'Upload questionnaire'}
        fileName={source.name}
        detail={source.name ? fileDetail : undefined}
        onFiles={(files) => onFiles(files, 'source')}
      />
      <div className="intake-source-options">
        <SourceText isGuide={isGuide} source={source} questions={questions} onChange={onChange} />
        {availableRange && (
          <SourceRange
            key={availableRange.original?.id ?? 'pasted'}
            source={availableRange}
            oversized={oversized}
            appliedValue={source.rangeValue}
            onApply={(items, description, rangeValue) => {
              const lines = items.map((item) => item.text);
              const original = availableRange.original;
              onChange({
                ...source,
                text: lines.join(isGuide ? '\n\n' : '\n'),
                questions: isGuide ? undefined : lines,
                document: isGuide && original ? { ...original, pages: items } : original,
                range: availableRange,
                rangeValue,
                selection: description,
              });
            }}
          />
        )}
      </div>
      {oversized && (
        <output className="intake-notice">
          {isGuide ? 'This guide exceeds 50,000 characters. ' + (availableRange ? 'Choose a page range or edit the text to continue.' : 'Edit the text to review a shorter section.')
            : 'This questionnaire exceeds 30 questions. Choose a range or edit the questions to continue.'}
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
