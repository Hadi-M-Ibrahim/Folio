import { useMemo } from 'react';
import { Upload } from 'lucide-react';
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
  questions?: string[];
};

type SourceFieldsProps = {
  isGuide: boolean;
  source: IntakeSource;
  questions: string[];
  onChange: (source: IntakeSource) => void;
  onFiles: (files: File[], kind: 'source' | 'bundle') => void;
};

export function SourceFields({ isGuide, source, questions, onChange, onFiles }: SourceFieldsProps) {
  const availableRange = useMemo(() => source.range ?? questionnaireRange(questions, source.document), [source, questions]);
  return (
    <>
      <IntakeFile
        label={isGuide ? 'Upload regulatory guide' : 'Upload questionnaire'}
        fileName={source.name}
        onFiles={(files) => onFiles(files, 'source')}
      />
      {availableRange && (
        <SourceRange
          key={availableRange.original?.id ?? 'pasted'}
          source={availableRange}
          oversized={isGuide ? source.text.length > MAX_GUIDE_CHARACTERS || availableRange.items.length > 10 : questions.length > MAX_QUESTIONS}
          onApply={(items, description) => {
            const lines = items.map((item) => item.text);
            const original = availableRange.original;
            onChange({
              name: source.name,
              text: lines.join(isGuide ? '\n\n' : '\n'),
              questions: isGuide ? undefined : lines,
              document: isGuide && original ? { ...original, pages: items } : original,
              range: availableRange,
              selection: description,
            });
          }}
        />
      )}
      <div className="intake-source">
        <div className="intake-field-heading">
          <label htmlFor="intake-source">{isGuide ? 'Guide text' : 'Questions'}</label>
          {!isGuide && questions.length > 0 && (
            <span>{questions.length} {questions.length === 1 ? 'question' : 'questions'}</span>
          )}
        </div>
        <textarea
          id="intake-source"
          rows={6}
          value={source.text}
          placeholder={isGuide ? 'Paste guide text here…' : 'Paste questions here…'}
          aria-describedby={!isGuide ? 'question-format' : undefined}
          onChange={(event) => onChange({ text: event.target.value, name: source.name })}
        />
        {!isGuide && <p className="intake-help" id="question-format">One question per line.</p>}
      </div>
      {isLoopback && (
        <label className="intake-bundle">
          <Upload size={14} aria-hidden="true" /> Import a prepared review (.json)
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
