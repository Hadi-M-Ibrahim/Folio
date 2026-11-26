import { useEffect, useState } from 'react';
import { ArrowUpFromLine, Check, FileText } from 'lucide-react';
import './IntakeFile.css';

type IntakeFileProps = {
  label: string;
  fileName?: string;
  detail?: string;
  describedBy?: string;
  attachedFiles: readonly (File | undefined)[];
  multiple?: boolean;
  onFiles: (files: File[]) => Promise<boolean>;
};

type PdfFeedback = { id: string; file: File; expires: number; attached: boolean };

export function IntakeFile({ label, fileName, detail, describedBy, attachedFiles, multiple, onFiles }: IntakeFileProps) {
  const [dragging, setDragging] = useState(false);
  const [feedback, setFeedback] = useState<PdfFeedback[]>([]);
  const nextExpiry = Math.min(...feedback.filter(row => row.attached).map(row => row.expires));
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(() => {
      setFeedback(rows => rows.filter(row => !row.attached || row.expires > nextExpiry));
    }, Math.max(0, nextExpiry - performance.now()));
    return () => window.clearTimeout(timer);
  }, [nextExpiry]);

  async function selectFiles(files: File[]) {
    const started = performance.now();
    const added: PdfFeedback[] = files.filter(file => /\.pdf$/i.test(file.name)).map(file => ({
      id: crypto.randomUUID(), file, expires: started + 2000 + Math.random() * 1000, attached: false,
    }));
    setFeedback(rows => multiple ? [...rows, ...added] : added);
    const accepted = await onFiles(files);
    if (added.length) {
      setFeedback(rows => accepted
        ? rows.map(row => added.includes(row) ? { ...row, attached: true } : row)
        : rows.filter(row => !added.includes(row)));
    }
  }

  const visible = feedback.filter(row => !row.attached || attachedFiles.includes(row.file));
  return (
    <div>
      <label className="intake-file" data-loaded={Boolean(fileName)} data-dragging={dragging}>
        <span className="intake-file-icon" aria-hidden="true">
          <FileText size={29} strokeWidth={1.3} />
          {fileName && <Check size={15} className="intake-file-check" />}
        </span>
        <span className="intake-file-info">
          <strong title={fileName}>{fileName || label}</strong>
          <small>{detail || 'Drop a PDF, TXT or Markdown file here.'}</small>
        </span>
        <span className="intake-browse" aria-hidden="true">
          <ArrowUpFromLine size={15} /> {fileName ? 'Replace file' : multiple ? 'Choose files' : 'Choose file'}
        </span>
        <input
          type="file"
          multiple={multiple}
          aria-label={label}
          aria-describedby={describedBy}
          accept=".pdf,.txt,.md"
          onDragOver={(event) => {
            event.preventDefault();
            if (!event.currentTarget.matches(':disabled')) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const files = Array.from(event.dataTransfer.files);
            if (files.length && !event.currentTarget.matches(':disabled')) void selectFiles(files);
          }}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files || []);
            event.currentTarget.value = '';
            if (files.length) void selectFiles(files);
          }}
        />
      </label>
      <div aria-live="polite" aria-relevant="additions text">
        {visible.map(({ id, file, attached }) => (
          <div key={id} className="intake-file-feedback" data-attached={attached}>
            <span className="intake-feedback-name">{file.name}</span>
            <span className="intake-feedback-state">{attached ? 'PDF attached' : 'Preparing PDF'}</span>
            <span className="intake-feedback-track">
              <progress className="intake-sr-only" aria-label={(attached ? 'Attached ' : 'Preparing ') + file.name}
                max={1} value={attached ? 1 : undefined} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
