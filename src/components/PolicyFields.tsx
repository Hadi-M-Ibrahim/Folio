import { useRef } from 'react';
import { FileText, Plus, X } from 'lucide-react';
import { isLoopback } from '../review/client';
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
  allowModel: boolean;
  onDraft: (value: PolicyDraft) => void;
  onAllowModelChange: (value: boolean) => void;
  onFiles: (files: File[]) => void;
  onAdd: (policy: Policy) => void;
  onRemove: (id: string) => void;
  onError: (message: string) => void;
};

export function PolicyFields({
  documents, draft, allowModel, onDraft, onAllowModelChange, onFiles, onAdd, onRemove, onError,
}: PolicyFieldsProps) {
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
      <IntakeFile label="Upload policy files" multiple onFiles={onFiles} />
      {documents.length > 0 && (
        <ul className="intake-documents" aria-label="Added policies">
          {documents.map((doc) => (
            <li key={doc.id}>
              <FileText size={16} aria-hidden="true" />
              <span>{doc.title}</span>
              <small>{doc.pages.length} {doc.pages.length === 1 ? 'page' : 'pages'}</small>
              <button type="button" aria-label={'Remove ' + doc.title} onClick={() => remove(doc.id)}><X size={16} /></button>
            </li>
          ))}
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
          {draft.open ? <X size={15} aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}
          {draft.open ? 'Hide text entry' : 'Paste a policy'}
        </button>
        <div className="intake-paste-fields" id="intake-paste-fields" hidden={!draft.open}>
          <label htmlFor="intake-policy-name">Policy title <span>(optional)</span></label>
          <input id="intake-policy-name" maxLength={240} value={draft.title} onChange={(e) => onDraft({ ...draft, title: e.target.value })} />
          <label htmlFor="intake-policy-text">Policy text</label>
          <textarea id="intake-policy-text" rows={4} value={draft.text} onChange={(e) => { onDraft({ ...draft, text: e.target.value }); onError(''); }} />
          <button type="button" className="intake-secondary" onClick={add}>Add policy</button>
        </div>
      </div>
      <label className="intake-consent">
        <input type="checkbox" checked={allowModel} onChange={(e) => onAllowModelChange(e.target.checked)}
          aria-labelledby="intake-model-label" aria-describedby="intake-model-description" />
        <span>
          <strong id="intake-model-label">Use Anthropic for this review</strong>
          <small id="intake-model-description">
            {isLoopback ? 'Allow the local server to send selected text to Anthropic if the operator has enabled it.' : 'Send the questions or guide and relevant policy passages to Anthropic.'}
          </small>
        </span>
      </label>
    </>
  );
}
