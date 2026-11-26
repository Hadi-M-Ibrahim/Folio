import { FileUp } from 'lucide-react';

type IntakeFileProps = {
  label: string;
  fileName?: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
};

export function IntakeFile({ label, fileName, multiple, onFiles }: IntakeFileProps) {
  return (
    <label className="intake-file">
      <span className="intake-file-icon"><FileUp size={23} strokeWidth={1.5} aria-hidden="true" /></span>
      <span className="intake-file-info">
        <strong>{fileName || label}</strong>
        <small>{fileName ? 'Choose another file' : 'Text-based PDF, TXT or Markdown'}</small>
      </span>
      <input
        type="file"
        multiple={multiple}
        aria-label={label}
        accept=".pdf,.txt,.md"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files || []);
          event.currentTarget.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </label>
  );
}
