import { useState } from 'react';
import { ArrowUpFromLine, Check, FileText } from 'lucide-react';

type IntakeFileProps = {
  label: string;
  fileName?: string;
  detail?: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
};

export function IntakeFile({ label, fileName, detail, multiple, onFiles }: IntakeFileProps) {
  const [dragging, setDragging] = useState(false);
  return (
    <label className="intake-file" data-loaded={Boolean(fileName)} data-dragging={dragging}>
      <span className="intake-file-icon" aria-hidden="true">
        <FileText size={29} strokeWidth={1.3} />
        {fileName && <Check size={15} className="intake-file-check" />}
      </span>
      <span className="intake-file-info">
        <strong>{fileName || label}</strong>
        <small>{detail || 'Drop a text-based PDF, TXT or Markdown file here.'}</small>
      </span>
      <span className="intake-browse" aria-hidden="true">
        <ArrowUpFromLine size={15} /> {fileName ? 'Replace file' : multiple ? 'Choose files' : 'Choose file'}
      </span>
      <input
        type="file"
        multiple={multiple}
        aria-label={label}
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
          if (files.length && !event.currentTarget.matches(':disabled')) onFiles(files);
        }}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files || []);
          event.currentTarget.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </label>
  );
}
