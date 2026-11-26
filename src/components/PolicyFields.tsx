import { useRef, useState } from 'react';
import { ChevronDown, ClipboardPaste, FileText, X } from 'lucide-react';
import { documentErrorMessage, textPages } from '../review/files';
import { MAX_POLICY_PAGE_CHARACTERS, type Policy } from '../review/model';
import { IntakeFile } from './IntakeFile';

type PolicyDraft = { title: string; text: string; open: boolean };
export const emptyPolicyDraft: PolicyDraft = { title: '', text: '', open: false };

export function pastedPolicy(draft: PolicyDraft, number: number): Policy {
  if (!draft.text.trim()) throw Error('Enter the policy text.');
  const pages = Array.from(textPages(draft.text));
  if (pages.some((page) => page.text.length > MAX_POLICY_PAGE_CHARACTERS)) {
    throw Error('Each policy page can contain up to 35,000 characters. Upload a paginated file or paste a shorter section.');
  }
  return { id: crypto.randomUUID(), title: draft.title.trim() || 'Policy ' + number, pages };
}

type PolicyFieldsProps = {
  documents: Policy[];
  draft: PolicyDraft;
  onDraft: (value: PolicyDraft) => void;
  onFiles: (files: File[]) => void;
  onAdd: (policy: Policy) => void;
  onRemove: (id: string) => void;
  onError: (message: string) => void;
};

function PolicyItem({ doc, onRemove }: {
  doc: Policy;
  onRemove: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const page = doc.pages[pageIndex];
  const panel = 'policy-preview-' + doc.id;
  return (
    <li>
      <div className="intake-document-row">
        <button type="button" className="intake-document-toggle" aria-expanded={open} aria-controls={panel}
          aria-label={'Preview ' + doc.title} onClick={() => setOpen(!open)}>
          <FileText size={17} aria-hidden="true" />
          <span>{doc.title}</span>
          <small>{doc.pages.length} {doc.pages.length === 1 ? 'page' : 'pages'}</small>
          <ChevronDown className="intake-chevron" size={14} aria-hidden="true" />
        </button>
        <button type="button" className="intake-remove" aria-label={'Remove ' + doc.title}
          onClick={() => onRemove(doc.id)}><X size={16} aria-hidden="true" /></button>
      </div>
      <div id={panel} hidden={!open} className="intake-policy-preview">
        {open && <>
          <div className="intake-field-heading">
            <label htmlFor={panel + '-text'}>Policy text</label>
            {doc.pages.length > 1 &&
              <select value={pageIndex} aria-label={'Page in ' + doc.title} onChange={(event) => setPageIndex(Number(event.target.value))}>
                {doc.pages.map((item, index) => <option key={item.number} value={index}>Page {item.number}</option>)}
              </select>}
          </div>
          <textarea id={panel + '-text'} rows={4} value={page.text} readOnly aria-label={'Text of ' + doc.title + ', page ' + page.number} />
        </>}
      </div>
    </li>
  );
}

export function PolicyFields({ documents, draft, onDraft, onFiles, onAdd, onRemove, onError }: PolicyFieldsProps) {
  const pasteButton = useRef<HTMLButtonElement>(null);

  function add() {
    try {
      onAdd(pastedPolicy(draft, documents.length + 1));
      onDraft(emptyPolicyDraft);
      onError('');
      pasteButton.current?.focus();
    } catch (cause) {
      onError(documentErrorMessage(cause));
    }
  }

  function remove(id: string) {
    onRemove(id);
    onError('');
    pasteButton.current?.focus();
  }

  return (
    <>
      <IntakeFile label="Upload policy files" detail="Drop one or more text-based PDF, TXT or Markdown files here." multiple onFiles={onFiles} />
      {documents.length > 0 && (
        <ul className="intake-documents" aria-label="Added policies">
          {documents.map((doc) => <PolicyItem key={doc.id} doc={doc} onRemove={remove} />)}
        </ul>
      )}
      <div>
        <button
          ref={pasteButton}
          type="button"
          className="intake-text-button"
          aria-expanded={draft.open}
          aria-controls="intake-paste-fields"
          onClick={() => onDraft({ ...draft, open: !draft.open })}
        >
          <ClipboardPaste size={16} aria-hidden="true" />
          {draft.text || draft.title ? 'Edit pasted policy' : 'Paste a policy'}
          <ChevronDown className="intake-chevron" size={14} aria-hidden="true" />
        </button>
        <div className="intake-paste-fields" id="intake-paste-fields" hidden={!draft.open}>
          <label htmlFor="intake-policy-name">Policy title <span>(optional)</span></label>
          <input id="intake-policy-name" maxLength={240} value={draft.title} onChange={(event) => onDraft({ ...draft, title: event.target.value })} />
          <label htmlFor="intake-policy-text">Policy text</label>
          <textarea id="intake-policy-text" rows={4} value={draft.text} onChange={(event) => { onDraft({ ...draft, text: event.target.value }); onError(''); }} />
          <button type="button" className="intake-secondary" onClick={add}>Add policy</button>
        </div>
      </div>
    </>
  );
}
